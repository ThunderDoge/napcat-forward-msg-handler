import type { OB11Message, OB11MessageData } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
// EventType.MESSAGE = 'message' — 运行时值，避免 napcat-types 外部导入
const MESSAGE_EVENT = 'message';
import { pluginState } from '../core/state';
import { isReply, extractReplyId, parseCommand, extractTextFromSegments, hasSaveableContent } from '../utils/message-utils';
import { sendReply, sendPlainText } from '../utils/reply-utils';
import { getCommandHandler } from './command-registry';
import { saveMessageToDisk } from './save-handler';
import { collectorBatch } from '../core/collector-batch';

/** 消息处理主入口 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
  if (event.post_type !== MESSAGE_EVENT) return;
  if (!pluginState.config.enabled) return;

  try {
    // 日志
    pluginState.log(
      `收到消息 type=${event.message_type} raw="${event.raw_message?.slice(0, 80)}" ` +
      `segments=[${event.message.map(s => typeof s === 'string' ? s : s.type).join(',')}] ` +
      `from=${event.user_id} ${event.group_id ? `group=${event.group_id}` : ''}`
    );

    // 解析命令
    const textContent = extractTextFromSegments(event);
    const prefix = pluginState.config.commandPrefix;
    const parsed = parseCommand(textContent, prefix);

    if (parsed) {
      // ── 有命令 ──
      pluginState.log(`解析到命令: /${parsed.command} args=[${parsed.args.join(', ')}]`);

      // /help 无需回复
      if (parsed.command === 'help') {
        const helpText = [
          '📋 转发处理插件 命令列表',
          '━━━━━━━━',
          '/help         — 显示此帮助',
          '/info         — 分析被回复消息的内容',
          '/save [dir]   — 保存转发/图片到本地（可选子目录）',
          '/extract      — 将转发释放到当前频道',
          '/colle on/off — Collector mode 自动保存',
          '/disk         — 查看系统磁盘与内存余量',
          '',
          '用法：回复一条消息，然后输入命令',
        ].join('\n');
        await sendPlainText(ctx, event, helpText);
        pluginState.log('/help 已回复');
        return;
      }

      // /colle 无需回复
      if (parsed.command === 'colle') {
        // 由 command-registry 的 handler 处理
        const handler = getCommandHandler('colle');
        if (handler) {
          const dummyReplied = { message: [], message_id: 0, user_id: 0, time: 0, message_type: 'private', sender: { user_id: 0, nickname: '' } } as OB11Message;
          await handler(ctx, event, dummyReplied, parsed.args);
        }
        return;
      }

      // /disk 无需回复
      if (parsed.command === 'disk') {
        const handler = getCommandHandler('disk');
        if (handler) {
          const dummyReplied = { message: [], message_id: 0, user_id: 0, time: 0, message_type: 'private', sender: { user_id: 0, nickname: '' } } as OB11Message;
          await handler(ctx, event, dummyReplied, parsed.args);
        }
        return;
      }

      // 其余命令需要回复
      if (!isReply(event)) {
        pluginState.log(`命令 /${parsed.command} 需要回复消息，当前消息不是回复，忽略`);
        return;
      }

      const replyId = extractReplyId(event);
      if (!replyId) {
        pluginState.log('检测到回复但无法提取 replyId');
        return;
      }

      pluginState.log(`回复目标消息 ID: ${replyId}`);

      let repliedMsg: OB11Message;
      try {
        repliedMsg = await ctx.actions.call(
          'get_msg',
          { message_id: replyId },
          ctx.adapterName,
          ctx.pluginManager.config,
        ) as unknown as OB11Message;
        pluginState.log(`get_msg 成功: segments=[${repliedMsg.message.map(s => typeof s === 'string' ? s : s.type).join(',')}]`);
      } catch (e) {
        pluginState.warn('get_msg 失败:', e);
        await sendReply(ctx, event, '原消息不存在或已过期');
        return;
      }

      const handler = getCommandHandler(parsed.command);
      if (!handler) {
        pluginState.log(`未知命令: ${parsed.command}，静默忽略`);
        return;
      }

      pluginState.log(`执行命令处理器: /${parsed.command}`);
      await handler(ctx, event, repliedMsg, parsed.args);
      pluginState.log(`命令 /${parsed.command} 执行完毕`);
      return;
    }

    // ── 无命令 — 检查 Collector mode ──
    if (!pluginState.config.collectorMode) return;

    if (!hasSaveableContent(event)) return;

    pluginState.log('Collector mode: 自动保存当前消息');
    await autoSaveCurrent(ctx, event);

  } catch (error) {
    pluginState.error('处理消息时出错:', error);
  }
}

/** Collector mode: 自动保存当前消息（进批量队列，窗口结束后合并报告） */
async function autoSaveCurrent(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
  const result = await saveMessageToDisk(ctx, event);
  if (!result) return;
  if (!result.ok) {
    pluginState.log('Collector mode: 保存失败，计入批量报告');
  } else {
    pluginState.log(`Collector mode: 已自动保存 (${result.type}, ${result.count})`);
  }
  collectorBatch.push(ctx, event, result);
}
