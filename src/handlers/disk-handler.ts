import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { statfs } from 'node:fs/promises';
import { totalmem, freemem } from 'node:os';
import { sendPlainText } from '../utils/reply-utils';
import { pluginState } from '../core/state';

/** 字节数格式化为人类可读 */
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 读取一个路径所在文件系统的磁盘信息 */
async function diskInfo(path: string): Promise<{ total: number; used: number; avail: number; pct: number } | null> {
  try {
    const s = await statfs(path);
    const bsize = s.bsize;
    const total = s.blocks * bsize;
    const avail = s.bavail * bsize; // 非 root 可用
    const used = total - s.bfree * bsize; // 已用（含 root 保留区）
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    return { total, used, avail, pct };
  } catch {
    return null;
  }
}

/** /disk — 查看本地存储与内存余量 */
export async function handleDisk(
  ctx: NapCatPluginContext,
  event: OB11Message,
  _replied: OB11Message,
  _args: string[],
): Promise<void> {
  const lines: string[] = ['💾 系统资源', '━━━━━━━━'];

  // 根分区
  const root = await diskInfo('/');
  if (root) {
    lines.push(`📀 根分区 /`);
    lines.push(`  总容量: ${fmtBytes(root.total)}`);
    lines.push(`  已用:   ${fmtBytes(root.used)} (${root.pct}%)`);
    lines.push(`  可用:   ${fmtBytes(root.avail)}`);
  } else {
    lines.push('📀 根分区: 读取失败');
  }

  // 保存目录所在分区（通常与根分区相同，额外显示目录占用可留作后续）
  const savedDir = pluginState.savedDir;
  const home = await diskInfo(savedDir);
  if (home && home.total !== root?.total) {
    lines.push(`📁 保存目录分区 ${savedDir}`);
    lines.push(`  总容量: ${fmtBytes(home.total)}`);
    lines.push(`  可用:   ${fmtBytes(home.avail)}`);
  }

  // 内存
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const memPct = total > 0 ? Math.round((used / total) * 100) : 0;
  lines.push('🧠 内存');
  lines.push(`  总容量: ${fmtBytes(total)}`);
  lines.push(`  已用:   ${fmtBytes(used)} (${memPct}%)`);
  lines.push(`  可用:   ${fmtBytes(free)}`);

  // 余量预警
  const avail = root?.avail ?? 0;
  if (avail > 0 && avail < 2 * 1024 ** 3) {
    lines.push('⚠️ 磁盘可用空间不足 2GB！');
  }

  await sendPlainText(ctx, event, lines.join('\n'));
}
