import type { OB11Message, OB11MessageData, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';

/** 构造一条回复段 */
export function buildReplySegment(messageId: string | number): OB11MessageData {
  return {
    type: 'reply',
    data: { id: String(messageId) },
  };
}

/** 发送带引用回复的文本消息 */
export async function sendReply(
  ctx: NapCatPluginContext,
  event: OB11Message,
  text: string,
): Promise<boolean> {
  try {
    const params: OB11PostSendMsg = {
      message: [
        buildReplySegment(event.message_id),
        { type: 'text', data: { text } },
      ],
      message_type: event.message_type,
      ...(event.message_type === 'group' && event.group_id
        ? { group_id: String(event.group_id) }
        : {}),
      ...(event.message_type === 'private' && event.user_id
        ? { user_id: String(event.user_id) }
        : {}),
    };
    await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    return true;
  } catch (error) {
    pluginState.error('发送回复失败:', error);
    return false;
  }
}

/** 发送没有引用的普通文本 */
export async function sendPlainText(
  ctx: NapCatPluginContext,
  event: OB11Message,
  text: string,
): Promise<boolean> {
  try {
    const params: OB11PostSendMsg = {
      message: [{ type: 'text', data: { text } }],
      message_type: event.message_type,
      ...(event.message_type === 'group' && event.group_id
        ? { group_id: String(event.group_id) }
        : {}),
      ...(event.message_type === 'private' && event.user_id
        ? { user_id: String(event.user_id) }
        : {}),
    };
    await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    return true;
  } catch (error) {
    pluginState.error('发送消息失败:', error);
    return false;
  }
}

/** 发送合并转发到当前群聊 */
export async function sendForwardToChat(
  ctx: NapCatPluginContext,
  event: OB11Message,
  nodes: OB11MessageData[],
): Promise<boolean> {
  try {
    const actionName = event.message_type === 'group'
      ? 'send_group_forward_msg'
      : 'send_private_forward_msg';

    const params: Record<string, unknown> = {
      messages: nodes,
    };
    if (event.message_type === 'group' && event.group_id) {
      params.group_id = String(event.group_id);
    } else if (event.user_id) {
      params.user_id = String(event.user_id);
    }

    await ctx.actions.call(
      actionName as 'send_group_forward_msg',
      params as never,
      ctx.adapterName,
      ctx.pluginManager.config,
    );
    return true;
  } catch (error) {
    pluginState.error('发送合并转发失败:', error);
    return false;
  }
}
