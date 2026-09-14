import type { OB11Message, OB11MessageData } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { extractForwards } from '../utils/message-utils';
import { sendReply } from '../utils/reply-utils';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 保存完成后触发坚果云增量同步（后台执行，不阻塞回复）。 */
export function triggerJianguoyunSync(): void {
  const script = '/home/doge/scripts/sync-qqmsg-jianguoyun.sh';
  if (!existsSync(script)) {
    pluginState.log('[sync] 同步脚本不存在，跳过: ' + script);
    return;
  }
  try {
    const child = spawn('bash', [script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    pluginState.log('[sync] 已触发坚果云增量同步 (后台)');
  } catch (e) {
    pluginState.error('[sync] 触发同步失败:', e);
  }
}

/** 所有可保存的媒体 segment 类型 */
const MEDIA_TYPES = ['image', 'video', 'record', 'file'] as const;

export function sanitizeDirName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_\- ]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 64) || 'unnamed';
}

export function timestampDir(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 从 URL 下载文件到本地（自动适配 HTTP/HTTPS） */
function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const getter = parsed.protocol === 'http:' ? httpGet : httpsGet;
      const req = getter(parsed, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, destPath).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          pluginState.log(`[downloadFile] HTTP ${res.statusCode} → ${url.slice(0,60)}`);
          resolve(false); return;
        }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
        file.on('error', (e) => { pluginState.log(`[downloadFile] write error: ${e.message}`); resolve(false); });
      });
      req.on('error', (e) => { pluginState.log(`[downloadFile] req error: ${e.message}`); resolve(false); });
    } catch (e: any) { pluginState.log(`[downloadFile] exception: ${e?.message}`); resolve(false); }
  });
}

/** 下载结果统计：ok = 新写入磁盘，skip = 重复跳过（同指纹只留一份），fail = 下载失败 */
export interface DownloadStats {
  ok: number;
  skip: number;
  fail: number;
}

/** 下载一组媒体段到目标目录，返回 { ok, skip, fail }。
 *  对无 URL 但有 file_id 的段，先通过 get_file action 解析 URL。 */
async function downloadMedia(
  segments: OB11MessageData[],
  targetDir: string,
  ctx: NapCatPluginContext,
): Promise<DownloadStats> {
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (let i = 0; i < segments.length; i++) {
    let url = segments[i].data?.url as string | undefined;
    const rawFile = segments[i].data?.file || `${Date.now()}_${i}`;
    const segType = segments[i].type;
    const fileId = segments[i].data?.file_id as string | undefined;

    // 无 URL 但有 file_id → 通过 get_file / get_private_file_url 解析
    if (!url && fileId) {
      try {
        // file 类型用 get_private_file_url 获取直链
        // image/video/voice 用 get_file（返回 URL 或 base64）
        const actionName = segType === 'file' ? 'get_private_file_url' : 'get_file';
        const result = await ctx.actions.call(
          actionName,
          { file_id: fileId },
          ctx.adapterName,
          ctx.pluginManager.config,
        ) as { url?: string; file?: string; file_name?: string; path?: string };
        pluginState.log(`[downloadMedia] ${actionName} 返回: url=${result?.url?.slice(0,60) || '无'} path=${result?.path || '无'}`);
        if (result?.url) {
          url = result.url;
          pluginState.log(`[downloadMedia] ${actionName} 成功 → ${segType}`);
        }
      } catch (e) { pluginState.log(`[downloadMedia] get_xxx_file 异常: ${e}`); }
    }

    if (!url) {
      pluginState.log(`[downloadMedia] 跳过 ${segType} — 无 URL (file=${rawFile}, file_id=${fileId || '无'})`);
      fail++; continue;
    }

    // 文件名：QQ 内部指纹名 (data.file)，同名即同内容 → 只留一份
    // 下载为串行 await，故同批次内的重复也能被下一次 existsSync 命中
    const filename = (segments[i].data?.file as string | undefined) || rawFile;
    const dest = join(targetDir, filename);

    // 已存在 → 去重跳过。本次没有写入任何新文件，故计入 skip 而非 ok
    if (existsSync(dest)) {
      pluginState.log(`[downloadMedia] 跳过 ${segType} — 已存在(同指纹) ${filename}`);
      skip++; continue;
    }

    const dl = await downloadFile(url, dest);
    if (dl) ok++; else fail++;
    if (i < segments.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  return { ok, skip, fail };
}

/** 递归从消息段中收集所有媒体段（含嵌套转发内部） */
function collectAllMediaFromSegments(segments: OB11MessageData[]): OB11MessageData[] {
  const result: OB11MessageData[] = [];
  for (const seg of segments) {
    if (MEDIA_TYPES.includes(seg.type as typeof MEDIA_TYPES[number])) {
      result.push(seg);
    } else if (seg.type === 'forward') {
      const nestedMsgs = (seg.data?.content as OB11MessageData[]) || [];
      for (const nestedMsg of nestedMsgs) {
        const nestedSegs: OB11MessageData[] = (nestedMsg as any).message || [];
        result.push(...collectAllMediaFromSegments(nestedSegs));
      }
    }
  }
  return result;
}

/** 递归从 OB11Message 节点数组中收集所有媒体段 */
function collectAllMediaFromNodes(nodes: OB11MessageData[]): OB11MessageData[] {
  const result: OB11MessageData[] = [];
  for (const msg of nodes) {
    const segments: OB11MessageData[] = (msg as any).message || [];
    result.push(...collectAllMediaFromSegments(segments));
  }
  return result;
}

/** 从转发节点的回复链中解析被引用消息的媒体。
 *  当转发内全是 reply+text 时，媒体实际在回复引用的原消息中。 */
async function resolveReplyChainMedia(
  nodes: OB11MessageData[],
  ctx: NapCatPluginContext,
): Promise<OB11MessageData[]> {
  // 1. 建立节点自身的 message_id 索引（优先本地命中）
  const localIndex = new Map<string, OB11MessageData[]>();
  for (const node of nodes) {
    const msg = node as any;
    if (msg.message_id) {
      localIndex.set(String(msg.message_id), msg.message || []);
    }
  }

  // 2. 收集所有唯一的 reply ID（去重）
  const replyIds = new Set<string>();
  for (const node of nodes) {
    const segments: OB11MessageData[] = (node as any).message || [];
    for (const seg of segments) {
      if (seg.type === 'reply' && seg.data?.id) {
        replyIds.add(String(seg.data.id));
      }
    }
  }
  if (replyIds.size === 0) return [];

  pluginState.log(`[replyChain] 需要解析 ${replyIds.size} 个唯一 reply ID`);

  // 3. 对每个 reply ID，优先本地查找，否则 get_msg
  const result: OB11MessageData[] = [];
  for (const replyId of replyIds) {
    let segments: OB11MessageData[] | undefined = localIndex.get(replyId);
    if (segments) {
      pluginState.log(`[replyChain] ${replyId} → 本地命中`);
    } else {
      try {
        const replied = await ctx.actions.call(
          'get_msg', { message_id: replyId },
          ctx.adapterName, ctx.pluginManager.config,
        ) as any;
        segments = replied?.message || [];
        pluginState.log(`[replyChain] ${replyId} → get_msg 成功, segments=${(segments || []).map((s: any) => s?.type).join(',')}`);
      } catch {
        pluginState.log(`[replyChain] ${replyId} → get_msg 失败`);
        continue;
      }
    }
    result.push(...collectAllMediaFromSegments(segments));
  }
  pluginState.log(`[replyChain] 共解析到 ${result.length} 个媒体段`);
  return result;
}

// ─────────────────────────────────────────────
// 媒体统计与消息构建
// ─────────────────────────────────────────────

interface MediaCount {
  images: number;
  videos: number;
  voices: number;
  files: number;
}

export function countMedia(segments: OB11MessageData[]): MediaCount {
  const counts: MediaCount = { images: 0, videos: 0, voices: 0, files: 0 };
  for (const s of segments) {
    if (s.type === 'image') counts.images++;
    else if (s.type === 'video') counts.videos++;
    else if (s.type === 'record') counts.voices++;
    else if (s.type === 'file') counts.files++;
  }
  return counts;
}

/** 构建媒体统计摘要行（区分新下载 / 重复跳过 / 失败） */
export function mediaSummary(counts: MediaCount, total: number, downloaded: DownloadStats): string {
  const parts: string[] = [];
  if (counts.images > 0) parts.push(`图片 ${counts.images}`);
  if (counts.videos > 0) parts.push(`视频 ${counts.videos}`);
  if (counts.voices > 0) parts.push(`语音 ${counts.voices}`);
  if (counts.files > 0) parts.push(`文件 ${counts.files}`);
  const types = parts.join(' + ');
  if (total === 0) return '无媒体内容';
  const dlParts: string[] = [];
  if (downloaded.ok > 0) dlParts.push(`新下载 ${downloaded.ok}`);
  if (downloaded.skip > 0) dlParts.push(`重复跳过 ${downloaded.skip}`);
  if (downloaded.fail > 0) dlParts.push(`失败 ${downloaded.fail}`);
  const dlStr = dlParts.length > 0 ? dlParts.join(', ') : '无内容';
  return `${types} 共 ${total} 件 (${dlStr})`;
}

// ─────────────────────────────────────────────
// 公用：写入转发 messages.json（精简格式）
// ─────────────────────────────────────────────

/** Unix 时间戳 → 'YYYY-MM-DD HH:MM:SS'（本地时区） */
function formatTime(ts: unknown): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 递归精简消息段：text 原样；媒体只留 file（本地文件名）；forward 递归展开 */
function simplifySegments(segments: OB11MessageData[]): unknown[] {
  const out: unknown[] = [];
  for (const s of segments) {
    if (s.type === 'text') {
      out.push({ type: 'text', text: (s.data as { text?: string })?.text ?? '' });
    } else if (s.type === 'image' || s.type === 'video' || s.type === 'record' || s.type === 'file') {
      out.push({ type: s.type, file: (s.data as { file?: string })?.file ?? '' });
    } else if (s.type === 'forward') {
      const inner = (s.data as { content?: OB11MessageData[] })?.content || [];
      out.push({
        type: 'forward',
        messages: inner.map((m) => {
          const node = m as { time?: number; sender?: { nickname?: string; user_id?: string }; message?: OB11MessageData[] };
          return {
            time: formatTime(node.time),
            sender: node.sender?.nickname || node.sender?.user_id || '',
            content: simplifySegments(node.message || []),
          };
        }),
      });
    }
    // 其他段类型（reply/face 等）忽略
  }
  return out;
}

/** 将转发节点写入精简 messages.json（只含时间/发送者/内容） */
function writeForwardMessagesJson(
  savePath: string,
  nodes: OB11MessageData[],
): void {
  writeFileSync(join(savePath, 'messages.json'), JSON.stringify({
    savedAt: new Date().toISOString(),
    messages: nodes.map((node, i) => {
      const n = node as { time?: number; user_id?: string; sender?: { nickname?: string; user_id?: string }; message?: OB11MessageData[] };
      return {
        index: i,
        time: formatTime(n.time),
        sender: n.sender?.nickname || n.sender?.user_id || n.user_id || '',
        content: simplifySegments(n.message || []),
      };
    }),
  }, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────
// 公用：保存转发的核心逻辑（/save 和 collector mode 共用）
// ─────────────────────────────────────────────

interface ForwardSaveResult {
  nodes: OB11MessageData[];
  allMedia: OB11MessageData[];
  downloaded: DownloadStats;
}

async function saveForwardCore(
  forwardId: string,
  savePath: string,
  ctx: NapCatPluginContext,
): Promise<ForwardSaveResult> {
  const result = await ctx.actions.call(
    'get_forward_msg',
    { message_id: forwardId },
    ctx.adapterName,
    ctx.pluginManager.config,
  ) as { messages?: OB11MessageData[] };
  const nodes = result?.messages || [];

  writeForwardMessagesJson(savePath, nodes);

  // 下载转发中的所有媒体（含嵌套转发 + 回复链引用的媒体）
  const forwardMediaSegments = collectAllMediaFromNodes(nodes);
  const replyMedia = await resolveReplyChainMedia(nodes, ctx);
  const allMedia = [...forwardMediaSegments, ...replyMedia];
  const downloaded = allMedia.length > 0
    ? await downloadMedia(allMedia, savePath, ctx)
    : { ok: 0, skip: 0, fail: 0 };

  return { nodes, allMedia, downloaded };
}

// ─────────────────────────────────────────────
// /save 命令处理器
// ─────────────────────────────────────────────

export async function handleSave(
  ctx: NapCatPluginContext,
  event: OB11Message,
  repliedMsg: OB11Message,
  args: string[],
): Promise<void> {
  const forwards = extractForwards(repliedMsg);

  if (forwards.length > 0) {
    await handleSaveForward(ctx, event, repliedMsg, args);
    return;
  }

  // 收集所有媒体类型
  const allSegments: OB11MessageData[] = [];
  for (const s of repliedMsg.message) {
    if (typeof s !== 'string' && MEDIA_TYPES.includes(s.type as typeof MEDIA_TYPES[number])) {
      allSegments.push(s);
    }
  }

  if (allSegments.length > 0) {
    await handleSaveMedia(ctx, event, allSegments, args);
  } else {
    await sendReply(ctx, event, '原消息中没有可保存的内容（转发/图片/视频/语音/文件）');
  }
}

/** /save 处理合并转发：子文件夹 */
async function handleSaveForward(
  ctx: NapCatPluginContext,
  event: OB11Message,
  repliedMsg: OB11Message,
  args: string[],
): Promise<void> {
  const forwards = extractForwards(repliedMsg);
  const dirName = args.length > 0
    ? sanitizeDirName(args[0])
    : sanitizeDirName(forwards[0]?.data?.id || timestampDir());
  const savePath = join(pluginState.savedDir, dirName);

  try {
    if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true });
  } catch {
    await sendReply(ctx, event, '保存失败：无法创建目录');
    return;
  }

  try {
    const { nodes, allMedia, downloaded } = await saveForwardCore(
      forwards[0].data.id, savePath, ctx,
    );
    if (nodes.length === 0) { await sendReply(ctx, event, '转发内容为空'); return; }

    const counts = countMedia(allMedia);
    await sendReply(ctx, event, [
      `✅ 已保存转发 (${dirName})`,
      `━━━━━━━━`,
      `消息: ${nodes.length} 条`,
      mediaSummary(counts, allMedia.length, downloaded),
    ].join('\n'));
    pluginState.log(`已保存转发: ${dirName} (${nodes.length} 条, ${allMedia.length} 媒体, 新下载 ${downloaded.ok}, 重复跳过 ${downloaded.skip}, 失败 ${downloaded.fail})`);
    triggerJianguoyunSync();
  } catch (e) {
    pluginState.error('保存转发失败:', e);
    await sendReply(ctx, event, '无法获取转发内容，可能已过期');
  }
}

/** /save 处理媒体消息（图片/视频/语音/文件） */
async function handleSaveMedia(
  ctx: NapCatPluginContext,
  event: OB11Message,
  segments: OB11MessageData[],
  args: string[],
): Promise<void> {
  const useSubdir = args.length > 0;
  const savePath = useSubdir
    ? join(pluginState.savedDir, sanitizeDirName(args[0]))
    : pluginState.savedDir;

  if (useSubdir) {
    try { if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true }); }
    catch { await sendReply(ctx, event, '保存失败：无法创建目录'); return; }
  }

  const downloaded = await downloadMedia(segments, savePath, ctx);
  const counts = countMedia(segments);
  const total = segments.length;
  const allFailed = downloaded.ok === 0 && downloaded.fail > 0;
  const allSkipped = downloaded.ok === 0 && downloaded.skip > 0 && downloaded.fail === 0;
  const suffix = useSubdir ? ` (${args[0]})` : '';

  // 全重复时不谎报"已保存"：本次没有写入任何新文件
  const header = allFailed
    ? `⚠️ 未下载${suffix}`
    : allSkipped
      ? `⚠️ 已存在，未重复下载${suffix}`
      : `✅ 已保存${suffix}`;

  await sendReply(ctx, event, [
    header,
    `━━━━━━━━`,
    mediaSummary(counts, total, downloaded),
    ...(allFailed ? ['文件链接不可用或已过期'] : []),
  ].join('\n'));
  pluginState.log(`已保存媒体: ${total} 件, 新下载 ${downloaded.ok}, 重复跳过 ${downloaded.skip}, 失败 ${downloaded.fail}`);
  triggerJianguoyunSync();
}

// ─────────────────────────────────────────────
// Collector mode 自动保存
// ─────────────────────────────────────────────

export type SaveResult = {
  ok: boolean;
  dirName: string;
  type: 'image' | 'forward' | 'mixed';
  count: number;
  counts?: MediaCount;
  downloaded: DownloadStats;
  summaryLine: string;
};

export async function saveMessageToDisk(
  ctx: NapCatPluginContext,
  event: OB11Message,
): Promise<SaveResult | null> {
  const forwards = extractForwards(event);

  // 收集所有媒体
  const mediaSegments: OB11MessageData[] = [];
  for (const s of event.message) {
    if (typeof s !== 'string' && MEDIA_TYPES.includes(s.type as typeof MEDIA_TYPES[number])) {
      mediaSegments.push(s);
    }
  }

  if (forwards.length === 0 && mediaSegments.length === 0) return null;

  if (forwards.length > 0) {
    // 转发 → 子文件夹
    const dirName = sanitizeDirName(forwards[0]?.data?.id || timestampDir());
    const savePath = join(pluginState.savedDir, dirName);
    try { if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true }); }
    catch { return { ok: false, dirName, type: 'forward', count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: '无法创建目录' }; }

    try {
      const { nodes, allMedia, downloaded } = await saveForwardCore(
        forwards[0].data.id, savePath, ctx,
      );
      if (nodes.length === 0) {
        return { ok: false, dirName, type: 'forward', count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: '转发内容为空' };
      }

      const counts = countMedia(allMedia);
      const summaryLine = `已保存转发 (${dirName})\n━━━━━━━━\n消息: ${nodes.length} 条\n${mediaSummary(counts, allMedia.length, downloaded)}`;
      triggerJianguoyunSync();
      return {
        ok: true, dirName, type: 'forward', count: nodes.length, counts,
        downloaded,
        summaryLine,
      };
    } catch {
      return { ok: false, dirName, type: 'forward', count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: '获取转发内容失败' };
    }
  } else {
    // 媒体 → 直接存表面
    const dl = await downloadMedia(mediaSegments, pluginState.savedDir, ctx);
    const counts = countMedia(mediaSegments);
    const allFailed = dl.ok === 0 && dl.fail > 0;
    const allSkipped = dl.ok === 0 && dl.skip > 0 && dl.fail === 0;
    const header = allFailed ? '未下载' : allSkipped ? '已存在，未重复下载' : '已保存';
    const footer = allFailed ? '\n文件链接不可用或已过期' : '';
    triggerJianguoyunSync();
    return {
      ok: true, dirName: '', type: 'mixed', count: mediaSegments.length, counts,
      downloaded: dl,
      summaryLine: `${header}\n━━━━━━━━\n${mediaSummary(counts, mediaSegments.length, dl)}${footer}`,
    };
  }
}
