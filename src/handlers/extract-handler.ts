import type { OB11Message, OB11MessageData } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { extractForwards } from '../utils/message-utils';
import { sendReply, sendForwardToChat } from '../utils/reply-utils';

/** /extract 命令处理器：将合并转发释放到消息频道 */
export async function handleExtract(
  ctx: NapCatPluginContext,
  event: OB11Message,
  repliedMsg: OB11Message,
  _args: string[],
): Promise<void> {
  // 1. 检查原消息是否有合并转发
  const forwards = extractForwards(repliedMsg);
  if (forwards.length === 0) {
    await sendReply(ctx, event, '请回复一条包含合并转发的消息');
    return;
  }

  // 2. 取第一个转发
  const forwardSegment = forwards[0];
  const forwardId = forwardSegment.data?.id;
  if (!forwardId) {
    await sendReply(ctx, event, '转发消息 ID 为空');
    return;
  }

  // 3. 获取转发内容（递归展开所有嵌套）
  let nodes: OB11MessageData[] = [];
  try {
    const result = await ctx.actions.call(
      'get_forward_msg',
      { message_id: forwardId },
      ctx.adapterName,
      ctx.pluginManager.config,
    );
    const msgResult = result as { messages?: OB11MessageData[] };
    nodes = msgResult?.messages || [];
  } catch (e) {
    pluginState.error('get_forward_msg 失败:', e);
    await sendReply(ctx, event, '无法获取转发内容，可能已过期');
    return;
  }

  if (nodes.length === 0) {
    await sendReply(ctx, event, '转发内容为空');
    return;
  }

  pluginState.debug(`get_forward_msg 返回 ${nodes.length} 个节点`);

  // 4. 将节点构造成合并转发所需格式，直接发送到群聊
  //    get_forward_msg 返回的 nodes 已经是 node 段格式，可直接复用
  const success = await sendForwardToChat(ctx, event, nodes);

  if (success) {
    pluginState.log(`已释放转发 (${nodes.length} 条消息)`);
  } else {
    await sendReply(ctx, event, '发送合并转发失败');
  }
}
