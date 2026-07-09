import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { OB11MessageData } from 'napcat-types/napcat-onebot';

/** 检查消息是否包含指定类型的段 */
export function hasSegment(msg: OB11Message, type: string): boolean {
  return msg.message.some(s => typeof s !== 'string' && s.type === type);
}

/** 在消息段数组中找第一个匹配的段 */
export function findSegment(msg: OB11Message, type: string): OB11MessageData | undefined {
  return msg.message.find(s => typeof s !== 'string' && s.type === type);
}

/** 找所有匹配的段（自动推断返回类型时使用 as 转换） */
export function findAllSegments(msg: OB11Message, type: string): OB11MessageData[] {
  return msg.message.filter(
    (s): s is OB11MessageData => typeof s !== 'string' && s.type === type
  );
}

/** 检查是否为回复消息（包含 reply 段） */
export function isReply(msg: OB11Message): boolean {
  return hasSegment(msg, 'reply');
}

/** 提取被回复的消息 ID */
export function extractReplyId(msg: OB11Message): string | undefined {
  const reply = findSegment(msg, 'reply');
  return reply?.data?.id;
}

/** 从消息段数组中提取纯文本内容（拼接所有 text 段） */
export function extractTextFromSegments(msg: OB11Message): string {
  return msg.message
    .filter(s => typeof s !== 'string' && s.type === 'text')
    .map(s => (s as { data: { text: string } }).data?.text || '')
    .join(' ')
    .trim();
}

/** 从原始文本中解析命令和参数 */
export function parseCommand(raw: string, prefix: string): { command: string; args: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(prefix)) return null;

  // 去掉前缀后按空白分割
  const rest = trimmed.slice(prefix.length).trim();
  const parts = rest.split(/\s+/);
  const command = parts[0]?.toLowerCase() || '';
  if (!command) return null;

  return { command, args: parts.slice(1) };
}

/** 提取消息中的图片段数组 */
export function extractImages(event: OB11Message): OB11MessageData[] {
  return findAllSegments(event, 'image');
}

/** 提取消息中的视频段数组 */
export function extractVideos(event: OB11Message): OB11MessageData[] {
  return findAllSegments(event, 'video');
}

/** 提取消息中的语音段数组 */
export function extractVoices(event: OB11Message): OB11MessageData[] {
  return findAllSegments(event, 'record');
}

/** 提取消息中的文件段数组 */
export function extractFiles(event: OB11Message): OB11MessageData[] {
  return findAllSegments(event, 'file');
}

/** 提取消息中的转发段数组 */
export function extractForwards(event: OB11Message): OB11MessageData[] {
  return findAllSegments(event, 'forward');
}

/** 一次性提取所有可保存的媒体段 */
export function extractAllMedia(event: OB11Message): {
  images: OB11MessageData[];
  videos: OB11MessageData[];
  voices: OB11MessageData[];
  files: OB11MessageData[];
} {
  const all = new Map<string, OB11MessageData[]>();
  for (const s of event.message) {
    if (typeof s === 'string') continue;
    const t = s.type;
    if (t === 'image' || t === 'video' || t === 'record' || t === 'file') {
      if (!all.has(t)) all.set(t, []);
      all.get(t)!.push(s);
    }
  }
  return {
    images: all.get('image') || [],
    videos: all.get('video') || [],
    voices: all.get('record') || [],
    files: all.get('file') || [],
  };
}

/** 是否有任何可保存的内容（转发/图片/视频/语音/文件） */
export function hasSaveableContent(event: OB11Message): boolean {
  return extractForwards(event).length > 0
    || event.message.some(s => typeof s !== 'string' && (
      s.type === 'image' || s.type === 'video' || s.type === 'record' || s.type === 'file'
    ));
}
