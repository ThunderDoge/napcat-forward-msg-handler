import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from '../types';
import { DEFAULT_CONFIG } from '../config';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

class PluginState {
  config: PluginConfig = { ...DEFAULT_CONFIG };
  ctx: NapCatPluginContext | null = null;
  private dataPath = '';

  init(ctx: NapCatPluginContext): void {
    this.ctx = ctx;
    this.dataPath = ctx.dataPath;

    // 确保 saved 目录存在
    const savedDir = join(this.dataPath, 'saved');
    if (!existsSync(savedDir)) {
      mkdirSync(savedDir, { recursive: true });
    }

    // 加载配置
    this.loadConfig();
  }

  private loadConfig(): void {
    if (!this.ctx) return;
    try {
      const configPath = this.ctx.configPath;
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        this.log(`配置已加载: prefix=${this.config.commandPrefix}`);
      }
    } catch (e) {
      this.warn('配置加载失败，使用默认值', e);
    }
  }

  saveConfig(): void {
    if (!this.ctx) return;
    try {
      const configPath = this.ctx.configPath;
      writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (e) {
      this.error('保存配置失败', e);
    }
  }

  replaceConfig(config: PluginConfig): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.saveConfig();
  }

  updateConfig(partial: Partial<PluginConfig>): void {
    this.config = { ...this.config, ...partial };
    this.saveConfig();
  }

  isGroupEnabled(groupId: string): boolean {
    const gc = this.config.groupConfigs[groupId];
    if (gc && gc.enabled !== undefined) return gc.enabled;
    return this.config.enabled;
  }

  get savedDir(): string {
    return join(homedir(), 'download', 'qq-msg');
  }

  // Logger helpers
  log(...args: unknown[]): void {
    this.ctx?.logger.log('[Forward]', ...args);
  }

  debug(...args: unknown[]): void {
    if (this.config.debug) {
      this.ctx?.logger.debug('[Forward]', ...args);
    }
  }

  warn(...args: unknown[]): void {
    this.ctx?.logger.warn('[Forward]', ...args);
  }

  error(...args: unknown[]): void {
    this.ctx?.logger.error('[Forward]', ...args);
  }

  cleanup(): void {
    this.ctx = null;
  }
}

export const pluginState = new PluginState();
