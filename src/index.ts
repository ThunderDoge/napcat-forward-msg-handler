/**
 * NapCat 转发处理插件
 *
 * 命令：
 *   /help               — 帮助信息
 *   /info               — 分析原消息内容
 *   /save [dir]         — 保存合并转发内容到本地
 *   /extract            — 将合并转发释放到消息频道
 */

import type {
  PluginModule,
  PluginConfigSchema,
  NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import type { OB11Message } from 'napcat-types/napcat-onebot';
// EventType.MESSAGE = 'message' — 运行时值，避免 napcat-types 外部导入
const MESSAGE_EVENT = 'message';

import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { registerCommand } from './handlers/command-registry';
import { handleSave } from './handlers/save-handler';
import { handleExtract } from './handlers/extract-handler';
import { handleDisk } from './handlers/disk-handler';
import { collectorBatch } from './core/collector-batch';
import { registerApiRoutes } from './services/api-service';
import { sendReply, sendPlainText } from './utils/reply-utils';
import { extractForwards, extractAllMedia } from './utils/message-utils';
import type { PluginConfig } from './types';

// ==================== 配置 Schema ====================

export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
  try {
    pluginState.init(ctx);
    ctx.logger.info('[Forward] 转发处理插件初始化中...');

    // 生成配置 Schema
    plugin_config_ui = buildConfigSchema(ctx);

    // 注册命令
    registerCommands(ctx);

    // 注册 WebUI API 路由
    registerApiRoutes(ctx);

    ctx.logger.info('[Forward] 转发处理插件初始化完成');
  } catch (error) {
    ctx.logger.error('[Forward] 插件初始化失败:', error);
  }
};

export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
  if (event.post_type !== MESSAGE_EVENT) return;
  if (!pluginState.config.enabled) return;
  await handleMessage(ctx, event);
};

export const plugin_onevent: PluginModule['plugin_onevent'] = async (_ctx, _event) => {
  // 不使用其他事件
};

export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
  try {
    collectorBatch.cleanup();
    pluginState.cleanup();
    ctx.logger.info('[Forward] 插件已卸载');
  } catch (e) {
    ctx.logger.warn('[Forward] 插件卸载时出错:', e);
  }
};

// ==================== 配置管理钩子 ====================

export const plugin_get_config: PluginModule['plugin_get_config'] = async (_ctx) => {
  return pluginState.config;
};

export const plugin_set_config: PluginModule['plugin_set_config'] = async (_ctx, config) => {
  pluginState.replaceConfig(config as PluginConfig);
};

export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
  _ctx, _ui, key, value, _currentConfig
) => {
  pluginState.updateConfig({ [key]: value });
};

// ==================== 命令注册 ====================

/** 注册所有内置命令 */
function registerCommands(ctx: NapCatPluginContext): void {
  registerCommand('help', async (_ctx, event, _replied, _args) => {
    const helpText = [
      '📋 转发处理插件 命令列表',
      '━━━━━━━━',
      '/help         — 显示此帮助',
      '/info         — 分析被回复消息的内容',
      '/save [dir]   — 保存转发内容到本地（可选子目录）',
      '/extract      — 将转发释放到当前频道',
      '/disk         — 查看系统磁盘与内存余量',
      '',
      '用法：回复一条合并转发消息，然后输入命令',
      '示例：回复转发消息 → 输入 /extract',
    ].join('\n');
    await sendPlainText(ctx, event, helpText);
  });

  registerCommand('info', async (ctx, event, repliedMsg, _args) => {
    const msgType = repliedMsg.message_type === 'group' ? '群聊' : '私聊';
    const media = extractAllMedia(repliedMsg);
    const forwards = extractForwards(repliedMsg);

    const allMediaCount = media.images.length + media.videos.length + media.voices.length + media.files.length;

    const lines: string[] = [
      '📋 消息分析',
      '━━━━━━━━━━━━━━━━━━',
      `来源: ${msgType}`,
      `发送者: ${repliedMsg.sender?.nickname || repliedMsg.user_id}`,
      `消息类型: ${repliedMsg.message.map(s => (typeof s === 'string' ? 'text' : s.type)).join(', ')}`,
    ];

    if (media.images.length > 0) lines.push(`图片: ${media.images.length} 张`);
    if (media.videos.length > 0) lines.push(`视频: ${media.videos.length} 个`);
    if (media.voices.length > 0) lines.push(`语音: ${media.voices.length} 条`);
    if (media.files.length > 0) lines.push(`文件: ${media.files.length} 个`);
    if (forwards.length > 0) {
      lines.push(`合并转发: ${forwards.length} 条`);
      // 尝试获取转发摘要（但不阻塞）
      try {
        const result = await ctx.actions.call(
          'get_forward_msg',
          { message_id: forwards[0].data.id },
          ctx.adapterName,
          ctx.pluginManager.config,
        ) as { messages?: unknown[] };
        if (result?.messages) {
          const senders = new Set<string>();
          let imgCount = 0;
          let vidCount = 0;
          let fileCount = 0;
          for (const m of result.messages) {
            const node = m as { data?: { nickname?: string; content?: unknown[] } };
            if (node.data?.nickname) senders.add(node.data.nickname);
            if (node.data?.content) {
              for (const seg of node.data.content) {
                const s = seg as { type?: string };
                if (s.type === 'image') imgCount++;
                else if (s.type === 'video') vidCount++;
                else if (s.type === 'file') fileCount++;
              }
            }
          }
          lines.push(`  ├ 内部 ${result.messages.length} 条消息`);
          if (senders.size > 0) lines.push(`  ├ 发送者: ${Array.from(senders).slice(0, 5).join('、')}${senders.size > 5 ? `等${senders.size}人` : ''}`);
          const subParts: string[] = [];
          if (imgCount > 0) subParts.push(`${imgCount} 图片`);
          if (vidCount > 0) subParts.push(`${vidCount} 视频`);
          if (fileCount > 0) subParts.push(`${fileCount} 文件`);
          if (subParts.length > 0) lines.push(`  └ 含 ${subParts.join('、')}`);
        }
      } catch { /* 取不到就算了 */ }
    }

    if (allMediaCount === 0 && forwards.length === 0) {
      lines.push('⚠️ 此消息不含可保存的内容');
    }

    await sendReply(ctx, event, lines.join('\n'));
  });

  registerCommand('save', handleSave);
  registerCommand('extract', handleExtract);
  registerCommand('disk', handleDisk);

  // /colle on|off — Collector mode
  registerCommand('colle', async (ctx, event, _replied, args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === 'on') {
      pluginState.config.collectorMode = true;
      pluginState.saveConfig();
      await sendPlainText(ctx, event, '📥 Collector mode 已开启\n所有包含图片或转发的消息将自动保存');
      ctx.logger.info('[Forward] Collector mode ON');
    } else if (sub === 'off') {
      pluginState.config.collectorMode = false;
      pluginState.saveConfig();
      await sendPlainText(ctx, event, '📤 Collector mode 已关闭');
      ctx.logger.info('[Forward] Collector mode OFF');
    } else {
      const status = pluginState.config.collectorMode ? '🟢 开启' : '🔴 关闭';
      await sendPlainText(ctx, event, `Collector mode: ${status}\n/colle on — 开启\n/colle off — 关闭`);
    }
  });

  ctx.logger.info('[Forward] 已注册命令: help, info, save, extract, colle, disk');
}
