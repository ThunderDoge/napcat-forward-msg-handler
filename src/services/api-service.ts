import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** 安全拼接路径（防止目录穿越） */
function joinSafe(base: string, ...parts: string[]): string | null {
  const joined = resolve(base, ...parts);
  if (!joined.startsWith(resolve(base) + sep)) {
    return null;
  }
  return joined;
}

function getSummaryPreview(savedDir: string, dirName: string): string {
  try {
    const summaryPath = joinSafe(savedDir, dirName, 'summary.txt');
    if (summaryPath && existsSync(summaryPath)) {
      const lines = readFileSync(summaryPath, 'utf-8').split('\n').slice(0, 3);
      return lines.join(' | ');
    }
  } catch { /* ignore */ }
  return '';
}

export function registerApiRoutes(ctx: NapCatPluginContext): void {
  const router = ctx.router;

  // 列出已保存的转发目录
  router.getNoAuth('/saved/list', (_req, res) => {
    try {
      const savedDir = pluginState.savedDir;
      if (!existsSync(savedDir)) {
        res.json({ code: 0, data: { dirs: [] } });
        return;
      }
      const dirs = readdirSync(savedDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({
          name: d.name,
          summary: getSummaryPreview(savedDir, d.name),
        }));
      res.json({ code: 0, data: { dirs } });
    } catch (e) {
      res.json({ code: -1, message: String(e) });
    }
  });

  // 查看某次保存的 summary
  router.getNoAuth('/saved/:name/summary', (req, res) => {
    try {
      const dirName = req.params.name as string;
      const summaryPath = joinSafe(pluginState.savedDir, dirName, 'summary.txt');
      if (!summaryPath || !existsSync(summaryPath)) {
        res.json({ code: -1, message: 'not found' });
        return;
      }
      const content = readFileSync(summaryPath, 'utf-8');
      res.json({ code: 0, data: { content } });
    } catch (e) {
      res.json({ code: -1, message: String(e) });
    }
  });
}
