import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  debug: false,
  commandPrefix: '/',
  collectorMode: false,
  groupConfigs: {},
};

export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
  return ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html(`
      <div style="padding:16px;background:#5865F2;border-radius:12px;margin-bottom:20px;color:white;">
        <h3 style="margin:0 0 6px 0;font-size:18px;font-weight:600;">转发处理</h3>
        <p style="margin:0;font-size:13px;opacity:0.85;">
          合并转发命令处理插件 — /info /save /extract
        </p>
      </div>
    `),
    ctx.NapCatConfig.boolean('enabled', '启用插件', true, '插件总开关'),
    ctx.NapCatConfig.boolean('debug', '调试模式', false, '输出详细日志'),
    ctx.NapCatConfig.text('commandPrefix', '命令前缀', '/', '触发命令的前缀'),
  );
}
