import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';

/** 命令处理器签名 */
export type CommandHandler = (
  ctx: NapCatPluginContext,
  event: OB11Message,
  repliedMsg: OB11Message,
  args: string[]
) => Promise<void>;

const registry = new Map<string, CommandHandler>();

/** 注册一个命令 */
export function registerCommand(name: string, handler: CommandHandler): void {
  registry.set(name, handler);
}

/** 获取某条命令的处理器 */
export function getCommandHandler(name: string): CommandHandler | undefined {
  return registry.get(name);
}

/** 获取所有已注册的命令名 */
export function getRegisteredCommands(): string[] {
  return Array.from(registry.keys()).sort();
}
