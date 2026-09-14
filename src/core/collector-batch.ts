import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { SaveResult } from '../handlers/save-handler';
import { sendPlainText } from '../utils/reply-utils';

// ─────────────────────────────────────────────
// Collector 批量报告
//
// 连续发送的消息（间隔 < BATCH_WINDOW_MS）不再逐条发报告，
// 而是在窗口结束后合并成一条报告发送，降低机器人特征。
// 发送前随机延时，进一步模拟人类行为。
// ─────────────────────────────────────────────

/** 两条可保存消息间隔小于此值视为同一批（滑动窗口） */
const BATCH_WINDOW_MS = 4000;

/** 报告发送前的随机延时范围（毫秒） */
const MIN_REPLY_DELAY_MS = 1200;
const MAX_REPLY_DELAY_MS = 3500;

interface PendingItem {
  ctx: NapCatPluginContext;
  event: OB11Message;
  result: SaveResult;
}

class CollectorBatch {
  private pending: PendingItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 加入一条保存结果并重置窗口计时 */
  push(ctx: NapCatPluginContext, event: OB11Message, result: SaveResult): void {
    this.pending.push({ ctx, event, result });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, BATCH_WINDOW_MS);
  }

  /** 窗口到期：合并发送报告 */
  private async flush(): Promise<void> {
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;

    // 随机回复延时（模拟人类打字/阅读）
    const delay = MIN_REPLY_DELAY_MS + Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS);
    await new Promise((r) => setTimeout(r, delay));

    const { ctx, event } = batch[batch.length - 1];

    let text: string;
    if (batch.length === 1) {
      text = batch[0].result.summaryLine;
    } else {
      text = buildBatchSummary(batch);
    }

    await sendPlainText(ctx, event, text);
  }

  /** 插件卸载时清理，丢弃未发送的批量（避免卸载后发送失败） */
  cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

/** 汇总多条保存结果为一条报告（不逐条重复，不用 emoji） */
function buildBatchSummary(batch: PendingItem[]): string {
  const okItems = batch.filter((item) => item.result.ok);
  const failItems = batch.filter((item) => !item.result.ok);

  // 聚合媒体数量（forward 的 counts 是转发内部媒体；mixed/image 是表面媒体）
  let images = 0;
  let videos = 0;
  let voices = 0;
  let files = 0;
  let forwards = 0;
  let messages = 0;
  let dlOk = 0;
  let dlSkip = 0;
  let dlFail = 0;

  for (const item of okItems) {
    const r = item.result;
    const c = r.counts;
    if (c) {
      images += c.images;
      videos += c.videos;
      voices += c.voices;
      files += c.files;
    } else {
      // 无细分时按类型粗略计数
      if (r.type === 'mixed') images += r.count;
    }
    if (r.type === 'forward') {
      forwards += 1;
      messages += r.count;
    }
    dlOk += r.downloaded.ok;
    dlSkip += r.downloaded.skip;
    dlFail += r.downloaded.fail;
  }

  const parts: string[] = [];
  if (images > 0) parts.push(`图片共 ${images} 件已保存`);
  if (videos > 0) parts.push(`视频共 ${videos} 件已保存`);
  if (voices > 0) parts.push(`语音共 ${voices} 件已保存`);
  if (files > 0) parts.push(`文件共 ${files} 件已保存`);
  if (forwards > 0) parts.push(`转发 ${forwards} 条已保存 (${messages} 条消息)`);
  if (dlSkip > 0) parts.push(`${dlSkip} 件重复跳过`);
  if (dlFail > 0) parts.push(`${dlFail} 件下载失败`);
  if (failItems.length > 0) parts.push(`${failItems.length} 条保存失败`);

  if (parts.length === 0) {
    return `批量保存 ${batch.length} 条，均无内容`;
  }

  return [
    `批量保存 ${batch.length} 条`,
    '━━━━━━━━',
    ...parts,
  ].join('\n');
}

export const collectorBatch = new CollectorBatch();
