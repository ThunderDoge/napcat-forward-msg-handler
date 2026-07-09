import type { OB11Message, OB11MessageData } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { extractForwards, extractAllMedia } from '../utils/message-utils';
import { sendReply } from '../utils/reply-utils';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { URL } from 'node:url';

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 所有可保存的媒体 segment 类型 */
const MEDIA_TYPES = ['image', 'video', 'record', 'file'] as const;

/** 媒体类型中文标签 */
function mediaLabel(type: string): string {
  const map: Record<string, string> = {
    image: '图片',
    video: '视频',
    record: '语音',
    file: '文件',
  };
  return map[type] || type;
}

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

/** 下载一组媒体段到目标目录，返回 { ok, fail }。
 *  对无 URL 但有 file_id 的段，先通过 get_file action 解析 URL。 */
async function downloadMedia(
  segments: OB11MessageData[],
  targetDir: string,
  ctx: NapCatPluginContext,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  const usedNames = new Set<string>();
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

    // 文件名处理：优先用 name（原始文件名），其次 file
    let filename = segments[i].data?.name || rawFile;
    if (usedNames.has(filename)) {
      const dot = filename.lastIndexOf('.');
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : '';
      let n = 1;
      while (usedNames.has(`${base}_${n}${ext}`)) n++;
      filename = `${base}_${n}${ext}`;
    }
    usedNames.add(filename);

    const dest = join(targetDir, filename);
    const dl = await downloadFile(url, dest);
    if (dl) ok++; else fail++;
    if (i < segments.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  return { ok, fail };
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

/** 从转发节点中提取所有可下载媒体段的元数据（含嵌套转发） */
function extractAllMediaFromNodes(nodes: OB11MessageData[]): Array<{
  index: number; sender: string; url: string; fileSize?: string; type: string;
}> {
  const media: Array<{ index: number; sender: string; url: string; fileSize?: string; type: string }> = [];
  for (const msg of nodes) {
    const nick = (msg as any).sender?.nickname || '未知';
    const segments: OB11MessageData[] = (msg as any).message || [];
    walkSegments(segments, nick);
  }

  function walkSegments(segments: OB11MessageData[], sender: string): void {
    for (const seg of segments) {
      if (MEDIA_TYPES.includes(seg.type as typeof MEDIA_TYPES[number])) {
        media.push({
          index: media.length,
          sender,
          url: seg.data?.url || '',
          fileSize: seg.data?.file_size,
          type: seg.type,
        });
      } else if (seg.type === 'forward') {
        const nestedMsgs = (seg.data?.content as OB11MessageData[]) || [];
        for (const nestedMsg of nestedMsgs) {
          const nestedSegs: OB11MessageData[] = (nestedMsg as any).message || [];
          const nestedNick = (nestedMsg as any).sender?.nickname || sender;
          walkSegments(nestedSegs, nestedNick);
        }
      }
    }
  }
  return media;
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

/** 构建媒体统计摘要行 */
export function mediaSummary(counts: MediaCount, total: number, downloaded: { ok: number; fail: number }): string {
  const parts: string[] = [];
  if (counts.images > 0) parts.push(`图片 ${counts.images}`);
  if (counts.videos > 0) parts.push(`视频 ${counts.videos}`);
  if (counts.voices > 0) parts.push(`语音 ${counts.voices}`);
  if (counts.files > 0) parts.push(`文件 ${counts.files}`);
  const types = parts.join(' + ');
  const dlStr = downloaded.fail > 0
    ? `下载 ${downloaded.ok}/${downloaded.ok + downloaded.fail}`
    : `已下载 ${downloaded.ok}`;
  return `${types} 共 ${total} 件 (${dlStr})`;
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
    const result = await ctx.actions.call(
      'get_forward_msg',
      { message_id: forwards[0].data.id },
      ctx.adapterName,
      ctx.pluginManager.config,
    ) as { messages?: OB11MessageData[] };
    const nodes = result?.messages || [];
    if (nodes.length === 0) { await sendReply(ctx, event, '转发内容为空'); return; }

    const allMedia = extractAllMediaFromNodes(nodes);

    writeFileSync(join(savePath, 'messages.json'), JSON.stringify({
      savedAt: new Date().toISOString(),
      type: 'forward',
      totalMessages: nodes.length,
      totalMedia: allMedia.length,
      media: allMedia,
      messages: nodes.map((node, i) => ({
        index: i,
        sender: { userId: (node as any).user_id, nickname: (node as any).sender?.nickname },
        segments: (node as any).message || [],
      })),
    }, null, 2), 'utf-8');

    // 下载转发中的所有媒体
    const mediaSegments: OB11MessageData[] = [];
    for (const node of nodes) {
      const segs: OB11MessageData[] = (node as any).message || [];
      for (const s of segs) {
        if (MEDIA_TYPES.includes(s.type as typeof MEDIA_TYPES[number])) {
          mediaSegments.push(s);
        }
      }
    }
    let downloaded = { ok: 0, fail: 0 };
    if (mediaSegments.length > 0) {
      downloaded = await downloadMedia(mediaSegments, savePath, ctx);
    }

    const counts = countMedia(mediaSegments);
    await sendReply(ctx, event, [
      `✅ 已保存转发 (${dirName})`,
      `━━━━━━━━━━━━━━━━━━`,
      `消息: ${nodes.length} 条`,
      mediaSummary(counts, allMedia.length, downloaded),
    ].join('\n'));
    pluginState.log(`已保存转发: ${dirName} (${nodes.length} 条, ${allMedia.length} 媒体, ${downloaded.ok}/${downloaded.ok + downloaded.fail})`);

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

  const header = allFailed
    ? `⚠️ 未下载${useSubdir ? ` (${args[0]})` : ''}`
    : `✅ 已保存${useSubdir ? ` (${args[0]})` : ''}`;

  await sendReply(ctx, event, [
    header,
    `━━━━━━━━━━━━━━━━━━`,
    mediaSummary(counts, total, downloaded),
    ...(allFailed ? ['文件链接不可用或已过期'] : []),
  ].join('\n'));
  pluginState.log(`已保存媒体: ${total} 件, ${downloaded.ok}/${downloaded.ok + downloaded.fail}`);
}

// ─────────────────────────────────────────────
// Collector mode 自动保存
// ─────────────────────────────────────────────

export type SaveResult = {
  ok: boolean;
  dirName: string;
  type: 'image' | 'forward' | 'mixed';
  count: number;
  downloaded: { ok: number; fail: number };
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
    catch { return { ok: false, dirName, type: 'forward', count: 0, downloaded: { ok: 0, fail: 0 }, summaryLine: '无法创建目录' }; }

    try {
      const result = await ctx.actions.call(
        'get_forward_msg',
        { message_id: forwards[0].data.id },
        ctx.adapterName,
        ctx.pluginManager.config,
      ) as { messages?: OB11MessageData[] };
      const nodes = result?.messages || [];

      const allMedia = extractAllMediaFromNodes(nodes);
      writeFileSync(join(savePath, 'messages.json'), JSON.stringify({
        savedAt: new Date().toISOString(), type: 'forward',
        totalMessages: nodes.length, totalMedia: allMedia.length, media: allMedia,
      }, null, 2), 'utf-8');

      // 下载转发中的所有媒体
      const forwardMediaSegments: OB11MessageData[] = [];
      for (const node of nodes) {
        const segs: OB11MessageData[] = (node as any).message || [];
        for (const s of segs) {
          if (MEDIA_TYPES.includes(s.type as typeof MEDIA_TYPES[number])) {
            forwardMediaSegments.push(s);
          }
        }
      }
      const downloaded = await downloadMedia(forwardMediaSegments, savePath, ctx);
      const counts = countMedia(forwardMediaSegments);

      return {
        ok: true, dirName, type: 'forward', count: nodes.length, downloaded,
        summaryLine: `✅ 已保存转发 (${dirName})\n━━━━━━━━━━━━━━━━━━\n消息: ${nodes.length} 条\n${mediaSummary(counts, allMedia.length, downloaded)}`,
      };
    } catch {
      return { ok: false, dirName, type: 'forward', count: 0, downloaded: { ok: 0, fail: 0 }, summaryLine: '获取转发内容失败' };
    }
  } else {
    // 媒体 → 直接存表面
    const dl = await downloadMedia(mediaSegments, pluginState.savedDir, ctx);
    const counts = countMedia(mediaSegments);
    const allFailed = dl.ok === 0 && dl.fail > 0;
    const header = allFailed ? '⚠️ 未下载' : '✅ 已保存';
    const footer = allFailed ? '\n文件链接不可用或已过期' : '';
    return {
      ok: true, dirName: '', type: 'mixed', count: mediaSegments.length, downloaded: dl,
      summaryLine: `${header}\n━━━━━━━━━━━━━━━━━━\n${mediaSummary(counts, mediaSegments.length, dl)}${footer}`,
    };
  }
}
