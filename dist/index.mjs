var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir, totalmem, freemem } from "node:os";
import { get } from "node:http";
import { get as get$1 } from "node:https";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { statfs } from "node:fs/promises";
const DEFAULT_CONFIG = {
  enabled: true,
  debug: false,
  commandPrefix: "/",
  collectorMode: false,
  groupConfigs: {}
};
function buildConfigSchema(ctx) {
  return ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html(`
      <div style="padding:16px;background:#5865F2;border-radius:12px;margin-bottom:20px;color:white;">
        <h3 style="margin:0 0 6px 0;font-size:18px;font-weight:600;">转发处理</h3>
        <p style="margin:0;font-size:13px;opacity:0.85;">
          合并转发命令处理插件 — /info /save /extract
        </p>
      </div>
    `),
    ctx.NapCatConfig.boolean("enabled", "启用插件", true, "插件总开关"),
    ctx.NapCatConfig.boolean("debug", "调试模式", false, "输出详细日志"),
    ctx.NapCatConfig.text("commandPrefix", "命令前缀", "/", "触发命令的前缀")
  );
}
class PluginState {
  constructor() {
    __publicField(this, "config", { ...DEFAULT_CONFIG });
    __publicField(this, "ctx", null);
    __publicField(this, "dataPath", "");
  }
  init(ctx) {
    this.ctx = ctx;
    this.dataPath = ctx.dataPath;
    const savedDir = join(this.dataPath, "saved");
    if (!existsSync(savedDir)) {
      mkdirSync(savedDir, { recursive: true });
    }
    this.loadConfig();
  }
  loadConfig() {
    if (!this.ctx) return;
    try {
      const configPath = this.ctx.configPath;
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        this.log(`配置已加载: prefix=${this.config.commandPrefix}`);
      }
    } catch (e) {
      this.warn("配置加载失败，使用默认值", e);
    }
  }
  saveConfig() {
    if (!this.ctx) return;
    try {
      const configPath = this.ctx.configPath;
      writeFileSync(configPath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (e) {
      this.error("保存配置失败", e);
    }
  }
  replaceConfig(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.saveConfig();
  }
  updateConfig(partial) {
    this.config = { ...this.config, ...partial };
    this.saveConfig();
  }
  isGroupEnabled(groupId) {
    const gc = this.config.groupConfigs[groupId];
    if (gc && gc.enabled !== void 0) return gc.enabled;
    return this.config.enabled;
  }
  get savedDir() {
    return join(homedir(), "download", "qq-msg");
  }
  // Logger helpers
  log(...args) {
    var _a;
    (_a = this.ctx) == null ? void 0 : _a.logger.log("[Forward]", ...args);
  }
  debug(...args) {
    var _a;
    if (this.config.debug) {
      (_a = this.ctx) == null ? void 0 : _a.logger.debug("[Forward]", ...args);
    }
  }
  warn(...args) {
    var _a;
    (_a = this.ctx) == null ? void 0 : _a.logger.warn("[Forward]", ...args);
  }
  error(...args) {
    var _a;
    (_a = this.ctx) == null ? void 0 : _a.logger.error("[Forward]", ...args);
  }
  cleanup() {
    this.ctx = null;
  }
}
const pluginState = new PluginState();
function hasSegment(msg, type) {
  return msg.message.some((s) => typeof s !== "string" && s.type === type);
}
function findSegment(msg, type) {
  return msg.message.find((s) => typeof s !== "string" && s.type === type);
}
function findAllSegments(msg, type) {
  return msg.message.filter(
    (s) => typeof s !== "string" && s.type === type
  );
}
function isReply(msg) {
  return hasSegment(msg, "reply");
}
function extractReplyId(msg) {
  var _a;
  const reply = findSegment(msg, "reply");
  return (_a = reply == null ? void 0 : reply.data) == null ? void 0 : _a.id;
}
function extractTextFromSegments(msg) {
  return msg.message.filter((s) => typeof s !== "string" && s.type === "text").map((s) => {
    var _a;
    return ((_a = s.data) == null ? void 0 : _a.text) || "";
  }).join(" ").trim();
}
function parseCommand(raw, prefix) {
  var _a;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length).trim();
  const parts = rest.split(/\s+/);
  const command = ((_a = parts[0]) == null ? void 0 : _a.toLowerCase()) || "";
  if (!command) return null;
  return { command, args: parts.slice(1) };
}
function extractForwards(event) {
  return findAllSegments(event, "forward");
}
function extractAllMedia(event) {
  const all = /* @__PURE__ */ new Map();
  for (const s of event.message) {
    if (typeof s === "string") continue;
    const t = s.type;
    if (t === "image" || t === "video" || t === "record" || t === "file") {
      if (!all.has(t)) all.set(t, []);
      all.get(t).push(s);
    }
  }
  return {
    images: all.get("image") || [],
    videos: all.get("video") || [],
    voices: all.get("record") || [],
    files: all.get("file") || []
  };
}
function hasSaveableContent(event) {
  return extractForwards(event).length > 0 || event.message.some((s) => typeof s !== "string" && (s.type === "image" || s.type === "video" || s.type === "record" || s.type === "file"));
}
function buildReplySegment(messageId) {
  return {
    type: "reply",
    data: { id: String(messageId) }
  };
}
async function sendReply(ctx, event, text) {
  try {
    const params = {
      message: [
        buildReplySegment(event.message_id),
        { type: "text", data: { text } }
      ],
      message_type: event.message_type,
      ...event.message_type === "group" && event.group_id ? { group_id: String(event.group_id) } : {},
      ...event.message_type === "private" && event.user_id ? { user_id: String(event.user_id) } : {}
    };
    await ctx.actions.call("send_msg", params, ctx.adapterName, ctx.pluginManager.config);
    return true;
  } catch (error) {
    pluginState.error("发送回复失败:", error);
    return false;
  }
}
async function sendPlainText(ctx, event, text) {
  try {
    const params = {
      message: [{ type: "text", data: { text } }],
      message_type: event.message_type,
      ...event.message_type === "group" && event.group_id ? { group_id: String(event.group_id) } : {},
      ...event.message_type === "private" && event.user_id ? { user_id: String(event.user_id) } : {}
    };
    await ctx.actions.call("send_msg", params, ctx.adapterName, ctx.pluginManager.config);
    return true;
  } catch (error) {
    pluginState.error("发送消息失败:", error);
    return false;
  }
}
async function sendForwardToChat(ctx, event, nodes) {
  try {
    const actionName = event.message_type === "group" ? "send_group_forward_msg" : "send_private_forward_msg";
    const params = {
      messages: nodes
    };
    if (event.message_type === "group" && event.group_id) {
      params.group_id = String(event.group_id);
    } else if (event.user_id) {
      params.user_id = String(event.user_id);
    }
    await ctx.actions.call(
      actionName,
      params,
      ctx.adapterName,
      ctx.pluginManager.config
    );
    return true;
  } catch (error) {
    pluginState.error("发送合并转发失败:", error);
    return false;
  }
}
const registry = /* @__PURE__ */ new Map();
function registerCommand(name, handler) {
  registry.set(name, handler);
}
function getCommandHandler(name) {
  return registry.get(name);
}
function triggerJianguoyunSync() {
  const script = "/home/doge/scripts/sync-qqmsg-jianguoyun.sh";
  if (!existsSync(script)) {
    pluginState.log("[sync] 同步脚本不存在，跳过: " + script);
    return;
  }
  try {
    const child = spawn("bash", [script], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    pluginState.log("[sync] 已触发坚果云增量同步 (后台)");
  } catch (e) {
    pluginState.error("[sync] 触发同步失败:", e);
  }
}
const MEDIA_TYPES = ["image", "video", "record", "file"];
function sanitizeDirName(name) {
  return name.replace(/[^\p{L}\p{N}_\- ]/gu, "_").replace(/\s+/g, " ").trim().slice(0, 64) || "unnamed";
}
function timestampDir() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
function downloadFile(url, destPath) {
  return new Promise((resolve2) => {
    try {
      const parsed = new URL(url);
      const getter = parsed.protocol === "http:" ? get : get$1;
      const req = getter(parsed, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, destPath).then(resolve2);
          return;
        }
        if (res.statusCode !== 200) {
          pluginState.log(`[downloadFile] HTTP ${res.statusCode} → ${url.slice(0, 60)}`);
          resolve2(false);
          return;
        }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve2(true);
        });
        file.on("error", (e) => {
          pluginState.log(`[downloadFile] write error: ${e.message}`);
          resolve2(false);
        });
      });
      req.on("error", (e) => {
        pluginState.log(`[downloadFile] req error: ${e.message}`);
        resolve2(false);
      });
    } catch (e) {
      pluginState.log(`[downloadFile] exception: ${e == null ? void 0 : e.message}`);
      resolve2(false);
    }
  });
}
async function downloadMedia(segments, targetDir, ctx) {
  var _a, _b, _c, _d, _e;
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (let i = 0; i < segments.length; i++) {
    let url = (_a = segments[i].data) == null ? void 0 : _a.url;
    const rawFile = ((_b = segments[i].data) == null ? void 0 : _b.file) || `${Date.now()}_${i}`;
    const segType = segments[i].type;
    const fileId = (_c = segments[i].data) == null ? void 0 : _c.file_id;
    if (!url && fileId) {
      try {
        const actionName = segType === "file" ? "get_private_file_url" : "get_file";
        const result = await ctx.actions.call(
          actionName,
          { file_id: fileId },
          ctx.adapterName,
          ctx.pluginManager.config
        );
        pluginState.log(`[downloadMedia] ${actionName} 返回: url=${((_d = result == null ? void 0 : result.url) == null ? void 0 : _d.slice(0, 60)) || "无"} path=${(result == null ? void 0 : result.path) || "无"}`);
        if (result == null ? void 0 : result.url) {
          url = result.url;
          pluginState.log(`[downloadMedia] ${actionName} 成功 → ${segType}`);
        }
      } catch (e) {
        pluginState.log(`[downloadMedia] get_xxx_file 异常: ${e}`);
      }
    }
    if (!url) {
      pluginState.log(`[downloadMedia] 跳过 ${segType} — 无 URL (file=${rawFile}, file_id=${fileId || "无"})`);
      fail++;
      continue;
    }
    const filename = ((_e = segments[i].data) == null ? void 0 : _e.file) || rawFile;
    const dest = join(targetDir, filename);
    if (existsSync(dest)) {
      pluginState.log(`[downloadMedia] 跳过 ${segType} — 已存在(同指纹) ${filename}`);
      skip++;
      continue;
    }
    const dl = await downloadFile(url, dest);
    if (dl) ok++;
    else fail++;
    if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 200));
  }
  return { ok, skip, fail };
}
function collectAllMediaFromSegments(segments) {
  var _a;
  const result = [];
  for (const seg of segments) {
    if (MEDIA_TYPES.includes(seg.type)) {
      result.push(seg);
    } else if (seg.type === "forward") {
      const nestedMsgs = ((_a = seg.data) == null ? void 0 : _a.content) || [];
      for (const nestedMsg of nestedMsgs) {
        const nestedSegs = nestedMsg.message || [];
        result.push(...collectAllMediaFromSegments(nestedSegs));
      }
    }
  }
  return result;
}
function collectAllMediaFromNodes(nodes) {
  const result = [];
  for (const msg of nodes) {
    const segments = msg.message || [];
    result.push(...collectAllMediaFromSegments(segments));
  }
  return result;
}
async function resolveReplyChainMedia(nodes, ctx) {
  var _a;
  const localIndex = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const msg = node;
    if (msg.message_id) {
      localIndex.set(String(msg.message_id), msg.message || []);
    }
  }
  const replyIds = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    const segments = node.message || [];
    for (const seg of segments) {
      if (seg.type === "reply" && ((_a = seg.data) == null ? void 0 : _a.id)) {
        replyIds.add(String(seg.data.id));
      }
    }
  }
  if (replyIds.size === 0) return [];
  pluginState.log(`[replyChain] 需要解析 ${replyIds.size} 个唯一 reply ID`);
  const result = [];
  for (const replyId of replyIds) {
    let segments = localIndex.get(replyId);
    if (segments) {
      pluginState.log(`[replyChain] ${replyId} → 本地命中`);
    } else {
      try {
        const replied = await ctx.actions.call(
          "get_msg",
          { message_id: replyId },
          ctx.adapterName,
          ctx.pluginManager.config
        );
        segments = (replied == null ? void 0 : replied.message) || [];
        pluginState.log(`[replyChain] ${replyId} → get_msg 成功, segments=${(segments || []).map((s) => s == null ? void 0 : s.type).join(",")}`);
      } catch {
        pluginState.log(`[replyChain] ${replyId} → get_msg 失败`);
        continue;
      }
    }
    result.push(...collectAllMediaFromSegments(segments));
  }
  pluginState.log(`[replyChain] 共解析到 ${result.length} 个媒体段`);
  return result;
}
function countMedia(segments) {
  const counts = { images: 0, videos: 0, voices: 0, files: 0 };
  for (const s of segments) {
    if (s.type === "image") counts.images++;
    else if (s.type === "video") counts.videos++;
    else if (s.type === "record") counts.voices++;
    else if (s.type === "file") counts.files++;
  }
  return counts;
}
function mediaSummary(counts, total, downloaded) {
  const parts = [];
  if (counts.images > 0) parts.push(`图片 ${counts.images}`);
  if (counts.videos > 0) parts.push(`视频 ${counts.videos}`);
  if (counts.voices > 0) parts.push(`语音 ${counts.voices}`);
  if (counts.files > 0) parts.push(`文件 ${counts.files}`);
  const types = parts.join(" + ");
  if (total === 0) return "无媒体内容";
  const dlParts = [];
  if (downloaded.ok > 0) dlParts.push(`新下载 ${downloaded.ok}`);
  if (downloaded.skip > 0) dlParts.push(`重复跳过 ${downloaded.skip}`);
  if (downloaded.fail > 0) dlParts.push(`失败 ${downloaded.fail}`);
  const dlStr = dlParts.length > 0 ? dlParts.join(", ") : "无内容";
  return `${types} 共 ${total} 件 (${dlStr})`;
}
function formatTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t * 1e3);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function simplifySegments(segments) {
  var _a, _b, _c;
  const out = [];
  for (const s of segments) {
    if (s.type === "text") {
      out.push({ type: "text", text: ((_a = s.data) == null ? void 0 : _a.text) ?? "" });
    } else if (s.type === "image" || s.type === "video" || s.type === "record" || s.type === "file") {
      out.push({ type: s.type, file: ((_b = s.data) == null ? void 0 : _b.file) ?? "" });
    } else if (s.type === "forward") {
      const inner = ((_c = s.data) == null ? void 0 : _c.content) || [];
      out.push({
        type: "forward",
        messages: inner.map((m) => {
          var _a2, _b2;
          const node = m;
          return {
            time: formatTime(node.time),
            sender: ((_a2 = node.sender) == null ? void 0 : _a2.nickname) || ((_b2 = node.sender) == null ? void 0 : _b2.user_id) || "",
            content: simplifySegments(node.message || [])
          };
        })
      });
    }
  }
  return out;
}
function writeForwardMessagesJson(savePath, nodes) {
  writeFileSync(join(savePath, "messages.json"), JSON.stringify({
    savedAt: (/* @__PURE__ */ new Date()).toISOString(),
    messages: nodes.map((node, i) => {
      var _a, _b;
      const n = node;
      return {
        index: i,
        time: formatTime(n.time),
        sender: ((_a = n.sender) == null ? void 0 : _a.nickname) || ((_b = n.sender) == null ? void 0 : _b.user_id) || n.user_id || "",
        content: simplifySegments(n.message || [])
      };
    })
  }, null, 2), "utf-8");
}
async function saveForwardCore(forwardId, savePath, ctx) {
  const result = await ctx.actions.call(
    "get_forward_msg",
    { message_id: forwardId },
    ctx.adapterName,
    ctx.pluginManager.config
  );
  const nodes = (result == null ? void 0 : result.messages) || [];
  writeForwardMessagesJson(savePath, nodes);
  const forwardMediaSegments = collectAllMediaFromNodes(nodes);
  const replyMedia = await resolveReplyChainMedia(nodes, ctx);
  const allMedia = [...forwardMediaSegments, ...replyMedia];
  const downloaded = allMedia.length > 0 ? await downloadMedia(allMedia, savePath, ctx) : { ok: 0, skip: 0, fail: 0 };
  return { nodes, allMedia, downloaded };
}
async function handleSave(ctx, event, repliedMsg, args) {
  const forwards = extractForwards(repliedMsg);
  if (forwards.length > 0) {
    await handleSaveForward(ctx, event, repliedMsg, args);
    return;
  }
  const allSegments = [];
  for (const s of repliedMsg.message) {
    if (typeof s !== "string" && MEDIA_TYPES.includes(s.type)) {
      allSegments.push(s);
    }
  }
  if (allSegments.length > 0) {
    await handleSaveMedia(ctx, event, allSegments, args);
  } else {
    await sendReply(ctx, event, "原消息中没有可保存的内容（转发/图片/视频/语音/文件）");
  }
}
async function handleSaveForward(ctx, event, repliedMsg, args) {
  var _a, _b;
  const forwards = extractForwards(repliedMsg);
  const dirName = args.length > 0 ? sanitizeDirName(args[0]) : sanitizeDirName(((_b = (_a = forwards[0]) == null ? void 0 : _a.data) == null ? void 0 : _b.id) || timestampDir());
  const savePath = join(pluginState.savedDir, dirName);
  try {
    if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true });
  } catch {
    await sendReply(ctx, event, "保存失败：无法创建目录");
    return;
  }
  try {
    const { nodes, allMedia, downloaded } = await saveForwardCore(
      forwards[0].data.id,
      savePath,
      ctx
    );
    if (nodes.length === 0) {
      await sendReply(ctx, event, "转发内容为空");
      return;
    }
    const counts = countMedia(allMedia);
    await sendReply(ctx, event, [
      `✅ 已保存转发 (${dirName})`,
      `━━━━━━━━`,
      `消息: ${nodes.length} 条`,
      mediaSummary(counts, allMedia.length, downloaded)
    ].join("\n"));
    pluginState.log(`已保存转发: ${dirName} (${nodes.length} 条, ${allMedia.length} 媒体, 新下载 ${downloaded.ok}, 重复跳过 ${downloaded.skip}, 失败 ${downloaded.fail})`);
    triggerJianguoyunSync();
  } catch (e) {
    pluginState.error("保存转发失败:", e);
    await sendReply(ctx, event, "无法获取转发内容，可能已过期");
  }
}
async function handleSaveMedia(ctx, event, segments, args) {
  const useSubdir = args.length > 0;
  const savePath = useSubdir ? join(pluginState.savedDir, sanitizeDirName(args[0])) : pluginState.savedDir;
  if (useSubdir) {
    try {
      if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true });
    } catch {
      await sendReply(ctx, event, "保存失败：无法创建目录");
      return;
    }
  }
  const downloaded = await downloadMedia(segments, savePath, ctx);
  const counts = countMedia(segments);
  const total = segments.length;
  const allFailed = downloaded.ok === 0 && downloaded.fail > 0;
  const allSkipped = downloaded.ok === 0 && downloaded.skip > 0 && downloaded.fail === 0;
  const suffix = useSubdir ? ` (${args[0]})` : "";
  const header = allFailed ? `⚠️ 未下载${suffix}` : allSkipped ? `⚠️ 已存在，未重复下载${suffix}` : `✅ 已保存${suffix}`;
  await sendReply(ctx, event, [
    header,
    `━━━━━━━━`,
    mediaSummary(counts, total, downloaded),
    ...allFailed ? ["文件链接不可用或已过期"] : []
  ].join("\n"));
  pluginState.log(`已保存媒体: ${total} 件, 新下载 ${downloaded.ok}, 重复跳过 ${downloaded.skip}, 失败 ${downloaded.fail}`);
  triggerJianguoyunSync();
}
async function saveMessageToDisk(ctx, event) {
  var _a, _b;
  const forwards = extractForwards(event);
  const mediaSegments = [];
  for (const s of event.message) {
    if (typeof s !== "string" && MEDIA_TYPES.includes(s.type)) {
      mediaSegments.push(s);
    }
  }
  if (forwards.length === 0 && mediaSegments.length === 0) return null;
  if (forwards.length > 0) {
    const dirName = sanitizeDirName(((_b = (_a = forwards[0]) == null ? void 0 : _a.data) == null ? void 0 : _b.id) || timestampDir());
    const savePath = join(pluginState.savedDir, dirName);
    try {
      if (!existsSync(savePath)) mkdirSync(savePath, { recursive: true });
    } catch {
      return { ok: false, dirName, type: "forward", count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: "无法创建目录" };
    }
    try {
      const { nodes, allMedia, downloaded } = await saveForwardCore(
        forwards[0].data.id,
        savePath,
        ctx
      );
      if (nodes.length === 0) {
        return { ok: false, dirName, type: "forward", count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: "转发内容为空" };
      }
      const counts = countMedia(allMedia);
      const summaryLine = `已保存转发 (${dirName})
━━━━━━━━
消息: ${nodes.length} 条
${mediaSummary(counts, allMedia.length, downloaded)}`;
      triggerJianguoyunSync();
      return {
        ok: true,
        dirName,
        type: "forward",
        count: nodes.length,
        counts,
        downloaded,
        summaryLine
      };
    } catch {
      return { ok: false, dirName, type: "forward", count: 0, downloaded: { ok: 0, skip: 0, fail: 0 }, summaryLine: "获取转发内容失败" };
    }
  } else {
    const dl = await downloadMedia(mediaSegments, pluginState.savedDir, ctx);
    const counts = countMedia(mediaSegments);
    const allFailed = dl.ok === 0 && dl.fail > 0;
    const allSkipped = dl.ok === 0 && dl.skip > 0 && dl.fail === 0;
    const header = allFailed ? "未下载" : allSkipped ? "已存在，未重复下载" : "已保存";
    const footer = allFailed ? "\n文件链接不可用或已过期" : "";
    triggerJianguoyunSync();
    return {
      ok: true,
      dirName: "",
      type: "mixed",
      count: mediaSegments.length,
      counts,
      downloaded: dl,
      summaryLine: `${header}
━━━━━━━━
${mediaSummary(counts, mediaSegments.length, dl)}${footer}`
    };
  }
}
const BATCH_WINDOW_MS = 4e3;
const MIN_REPLY_DELAY_MS = 1200;
const MAX_REPLY_DELAY_MS = 3500;
class CollectorBatch {
  constructor() {
    __publicField(this, "pending", []);
    __publicField(this, "timer", null);
  }
  /** 加入一条保存结果并重置窗口计时 */
  push(ctx, event, result) {
    this.pending.push({ ctx, event, result });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, BATCH_WINDOW_MS);
  }
  /** 窗口到期：合并发送报告 */
  async flush() {
    this.timer = null;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    const delay = MIN_REPLY_DELAY_MS + Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS);
    await new Promise((r) => setTimeout(r, delay));
    const { ctx, event } = batch[batch.length - 1];
    let text;
    if (batch.length === 1) {
      text = batch[0].result.summaryLine;
    } else {
      text = buildBatchSummary(batch);
    }
    await sendPlainText(ctx, event, text);
  }
  /** 插件卸载时清理，丢弃未发送的批量（避免卸载后发送失败） */
  cleanup() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
function buildBatchSummary(batch) {
  const okItems = batch.filter((item) => item.result.ok);
  const failItems = batch.filter((item) => !item.result.ok);
  let images = 0;
  let videos = 0;
  let voices = 0;
  let files = 0;
  let forwards = 0;
  let messages = 0;
  let dlOk = 0;
  let dlSkip = 0;
  let dlFail = 0;
  for (const item of okItems) {
    const r = item.result;
    const c = r.counts;
    if (c) {
      images += c.images;
      videos += c.videos;
      voices += c.voices;
      files += c.files;
    } else {
      if (r.type === "mixed") images += r.count;
    }
    if (r.type === "forward") {
      forwards += 1;
      messages += r.count;
    }
    dlOk += r.downloaded.ok;
    dlSkip += r.downloaded.skip;
    dlFail += r.downloaded.fail;
  }
  const parts = [];
  if (images > 0) parts.push(`图片共 ${images} 件已保存`);
  if (videos > 0) parts.push(`视频共 ${videos} 件已保存`);
  if (voices > 0) parts.push(`语音共 ${voices} 件已保存`);
  if (files > 0) parts.push(`文件共 ${files} 件已保存`);
  if (forwards > 0) parts.push(`转发 ${forwards} 条已保存 (${messages} 条消息)`);
  if (dlSkip > 0) parts.push(`${dlSkip} 件重复跳过`);
  if (dlFail > 0) parts.push(`${dlFail} 件下载失败`);
  if (failItems.length > 0) parts.push(`${failItems.length} 条保存失败`);
  if (parts.length === 0) {
    return `批量保存 ${batch.length} 条，均无内容`;
  }
  return [
    `批量保存 ${batch.length} 条`,
    "━━━━━━━━",
    ...parts
  ].join("\n");
}
const collectorBatch = new CollectorBatch();
const MESSAGE_EVENT$1 = "message";
async function handleMessage(ctx, event) {
  var _a;
  if (event.post_type !== MESSAGE_EVENT$1) return;
  if (!pluginState.config.enabled) return;
  try {
    pluginState.log(
      `收到消息 type=${event.message_type} raw="${(_a = event.raw_message) == null ? void 0 : _a.slice(0, 80)}" segments=[${event.message.map((s) => typeof s === "string" ? s : s.type).join(",")}] from=${event.user_id} ${event.group_id ? `group=${event.group_id}` : ""}`
    );
    const textContent = extractTextFromSegments(event);
    const prefix = pluginState.config.commandPrefix;
    const parsed = parseCommand(textContent, prefix);
    if (parsed) {
      pluginState.log(`解析到命令: /${parsed.command} args=[${parsed.args.join(", ")}]`);
      if (parsed.command === "help") {
        const helpText = [
          "📋 转发处理插件 命令列表",
          "━━━━━━━━",
          "/help         — 显示此帮助",
          "/info         — 分析被回复消息的内容",
          "/save [dir]   — 保存转发/图片到本地（可选子目录）",
          "/extract      — 将转发释放到当前频道",
          "/colle on/off — Collector mode 自动保存",
          "/disk         — 查看系统磁盘与内存余量",
          "",
          "用法：回复一条消息，然后输入命令"
        ].join("\n");
        await sendPlainText(ctx, event, helpText);
        pluginState.log("/help 已回复");
        return;
      }
      if (parsed.command === "colle") {
        const handler2 = getCommandHandler("colle");
        if (handler2) {
          const dummyReplied = { message: [], message_id: 0, user_id: 0, time: 0, message_type: "private", sender: { user_id: 0, nickname: "" } };
          await handler2(ctx, event, dummyReplied, parsed.args);
        }
        return;
      }
      if (parsed.command === "disk") {
        const handler2 = getCommandHandler("disk");
        if (handler2) {
          const dummyReplied = { message: [], message_id: 0, user_id: 0, time: 0, message_type: "private", sender: { user_id: 0, nickname: "" } };
          await handler2(ctx, event, dummyReplied, parsed.args);
        }
        return;
      }
      if (!isReply(event)) {
        pluginState.log(`命令 /${parsed.command} 需要回复消息，当前消息不是回复，忽略`);
        return;
      }
      const replyId = extractReplyId(event);
      if (!replyId) {
        pluginState.log("检测到回复但无法提取 replyId");
        return;
      }
      pluginState.log(`回复目标消息 ID: ${replyId}`);
      let repliedMsg;
      try {
        repliedMsg = await ctx.actions.call(
          "get_msg",
          { message_id: replyId },
          ctx.adapterName,
          ctx.pluginManager.config
        );
        pluginState.log(`get_msg 成功: segments=[${repliedMsg.message.map((s) => typeof s === "string" ? s : s.type).join(",")}]`);
      } catch (e) {
        pluginState.warn("get_msg 失败:", e);
        await sendReply(ctx, event, "原消息不存在或已过期");
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
    if (!pluginState.config.collectorMode) return;
    if (!hasSaveableContent(event)) return;
    pluginState.log("Collector mode: 自动保存当前消息");
    await autoSaveCurrent(ctx, event);
  } catch (error) {
    pluginState.error("处理消息时出错:", error);
  }
}
async function autoSaveCurrent(ctx, event) {
  const result = await saveMessageToDisk(ctx, event);
  if (!result) return;
  if (!result.ok) {
    pluginState.log("Collector mode: 保存失败，计入批量报告");
  } else {
    pluginState.log(`Collector mode: 已自动保存 (${result.type}, ${result.count})`);
  }
  collectorBatch.push(ctx, event, result);
}
async function handleExtract(ctx, event, repliedMsg, _args) {
  var _a;
  const forwards = extractForwards(repliedMsg);
  if (forwards.length === 0) {
    await sendReply(ctx, event, "请回复一条包含合并转发的消息");
    return;
  }
  const forwardSegment = forwards[0];
  const forwardId = (_a = forwardSegment.data) == null ? void 0 : _a.id;
  if (!forwardId) {
    await sendReply(ctx, event, "转发消息 ID 为空");
    return;
  }
  let nodes = [];
  try {
    const result = await ctx.actions.call(
      "get_forward_msg",
      { message_id: forwardId },
      ctx.adapterName,
      ctx.pluginManager.config
    );
    const msgResult = result;
    nodes = (msgResult == null ? void 0 : msgResult.messages) || [];
  } catch (e) {
    pluginState.error("get_forward_msg 失败:", e);
    await sendReply(ctx, event, "无法获取转发内容，可能已过期");
    return;
  }
  if (nodes.length === 0) {
    await sendReply(ctx, event, "转发内容为空");
    return;
  }
  pluginState.debug(`get_forward_msg 返回 ${nodes.length} 个节点`);
  const success = await sendForwardToChat(ctx, event, nodes);
  if (success) {
    pluginState.log(`已释放转发 (${nodes.length} 条消息)`);
  } else {
    await sendReply(ctx, event, "发送合并转发失败");
  }
}
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
async function diskInfo(path) {
  try {
    const s = await statfs(path);
    const bsize = s.bsize;
    const total = s.blocks * bsize;
    const avail = s.bavail * bsize;
    const used = total - s.bfree * bsize;
    const pct = total > 0 ? Math.round(used / total * 100) : 0;
    return { total, used, avail, pct };
  } catch {
    return null;
  }
}
async function handleDisk(ctx, event, _replied, _args) {
  const lines = ["💾 系统资源", "━━━━━━━━"];
  const root = await diskInfo("/");
  if (root) {
    lines.push(`📀 根分区 /`);
    lines.push(`  总容量: ${fmtBytes(root.total)}`);
    lines.push(`  已用:   ${fmtBytes(root.used)} (${root.pct}%)`);
    lines.push(`  可用:   ${fmtBytes(root.avail)}`);
  } else {
    lines.push("📀 根分区: 读取失败");
  }
  const savedDir = pluginState.savedDir;
  const home = await diskInfo(savedDir);
  if (home && home.total !== (root == null ? void 0 : root.total)) {
    lines.push(`📁 保存目录分区 ${savedDir}`);
    lines.push(`  总容量: ${fmtBytes(home.total)}`);
    lines.push(`  可用:   ${fmtBytes(home.avail)}`);
  }
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const memPct = total > 0 ? Math.round(used / total * 100) : 0;
  lines.push("🧠 内存");
  lines.push(`  总容量: ${fmtBytes(total)}`);
  lines.push(`  已用:   ${fmtBytes(used)} (${memPct}%)`);
  lines.push(`  可用:   ${fmtBytes(free)}`);
  const avail = (root == null ? void 0 : root.avail) ?? 0;
  if (avail > 0 && avail < 2 * 1024 ** 3) {
    lines.push("⚠️ 磁盘可用空间不足 2GB！");
  }
  await sendPlainText(ctx, event, lines.join("\n"));
}
function joinSafe(base, ...parts) {
  const joined = resolve(base, ...parts);
  if (!joined.startsWith(resolve(base) + sep)) {
    return null;
  }
  return joined;
}
function getSummaryPreview(savedDir, dirName) {
  try {
    const summaryPath = joinSafe(savedDir, dirName, "summary.txt");
    if (summaryPath && existsSync(summaryPath)) {
      const lines = readFileSync(summaryPath, "utf-8").split("\n").slice(0, 3);
      return lines.join(" | ");
    }
  } catch {
  }
  return "";
}
function registerApiRoutes(ctx) {
  const router = ctx.router;
  router.getNoAuth("/saved/list", (_req, res) => {
    try {
      const savedDir = pluginState.savedDir;
      if (!existsSync(savedDir)) {
        res.json({ code: 0, data: { dirs: [] } });
        return;
      }
      const dirs = readdirSync(savedDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({
        name: d.name,
        summary: getSummaryPreview(savedDir, d.name)
      }));
      res.json({ code: 0, data: { dirs } });
    } catch (e) {
      res.json({ code: -1, message: String(e) });
    }
  });
  router.getNoAuth("/saved/:name/summary", (req, res) => {
    try {
      const dirName = req.params.name;
      const summaryPath = joinSafe(pluginState.savedDir, dirName, "summary.txt");
      if (!summaryPath || !existsSync(summaryPath)) {
        res.json({ code: -1, message: "not found" });
        return;
      }
      const content = readFileSync(summaryPath, "utf-8");
      res.json({ code: 0, data: { content } });
    } catch (e) {
      res.json({ code: -1, message: String(e) });
    }
  });
}
const MESSAGE_EVENT = "message";
let plugin_config_ui = [];
const plugin_init = async (ctx) => {
  try {
    pluginState.init(ctx);
    ctx.logger.info("[Forward] 转发处理插件初始化中...");
    plugin_config_ui = buildConfigSchema(ctx);
    registerCommands(ctx);
    registerApiRoutes(ctx);
    ctx.logger.info("[Forward] 转发处理插件初始化完成");
  } catch (error) {
    ctx.logger.error("[Forward] 插件初始化失败:", error);
  }
};
const plugin_onmessage = async (ctx, event) => {
  if (event.post_type !== MESSAGE_EVENT) return;
  if (!pluginState.config.enabled) return;
  await handleMessage(ctx, event);
};
const plugin_onevent = async (_ctx, _event) => {
};
const plugin_cleanup = async (ctx) => {
  try {
    collectorBatch.cleanup();
    pluginState.cleanup();
    ctx.logger.info("[Forward] 插件已卸载");
  } catch (e) {
    ctx.logger.warn("[Forward] 插件卸载时出错:", e);
  }
};
const plugin_get_config = async (_ctx) => {
  return pluginState.config;
};
const plugin_set_config = async (_ctx, config) => {
  pluginState.replaceConfig(config);
};
const plugin_on_config_change = async (_ctx, _ui, key, value, _currentConfig) => {
  pluginState.updateConfig({ [key]: value });
};
function registerCommands(ctx) {
  registerCommand("help", async (_ctx, event, _replied, _args) => {
    const helpText = [
      "📋 转发处理插件 命令列表",
      "━━━━━━━━",
      "/help         — 显示此帮助",
      "/info         — 分析被回复消息的内容",
      "/save [dir]   — 保存转发内容到本地（可选子目录）",
      "/extract      — 将转发释放到当前频道",
      "/disk         — 查看系统磁盘与内存余量",
      "",
      "用法：回复一条合并转发消息，然后输入命令",
      "示例：回复转发消息 → 输入 /extract"
    ].join("\n");
    await sendPlainText(ctx, event, helpText);
  });
  registerCommand("info", async (ctx2, event, repliedMsg, _args) => {
    var _a, _b, _c;
    const msgType = repliedMsg.message_type === "group" ? "群聊" : "私聊";
    const media = extractAllMedia(repliedMsg);
    const forwards = extractForwards(repliedMsg);
    const allMediaCount = media.images.length + media.videos.length + media.voices.length + media.files.length;
    const lines = [
      "📋 消息分析",
      "━━━━━━━━━━━━━━━━━━",
      `来源: ${msgType}`,
      `发送者: ${((_a = repliedMsg.sender) == null ? void 0 : _a.nickname) || repliedMsg.user_id}`,
      `消息类型: ${repliedMsg.message.map((s) => typeof s === "string" ? "text" : s.type).join(", ")}`
    ];
    if (media.images.length > 0) lines.push(`图片: ${media.images.length} 张`);
    if (media.videos.length > 0) lines.push(`视频: ${media.videos.length} 个`);
    if (media.voices.length > 0) lines.push(`语音: ${media.voices.length} 条`);
    if (media.files.length > 0) lines.push(`文件: ${media.files.length} 个`);
    if (forwards.length > 0) {
      lines.push(`合并转发: ${forwards.length} 条`);
      try {
        const result = await ctx2.actions.call(
          "get_forward_msg",
          { message_id: forwards[0].data.id },
          ctx2.adapterName,
          ctx2.pluginManager.config
        );
        if (result == null ? void 0 : result.messages) {
          const senders = /* @__PURE__ */ new Set();
          let imgCount = 0;
          let vidCount = 0;
          let fileCount = 0;
          for (const m of result.messages) {
            const node = m;
            if ((_b = node.data) == null ? void 0 : _b.nickname) senders.add(node.data.nickname);
            if ((_c = node.data) == null ? void 0 : _c.content) {
              for (const seg of node.data.content) {
                const s = seg;
                if (s.type === "image") imgCount++;
                else if (s.type === "video") vidCount++;
                else if (s.type === "file") fileCount++;
              }
            }
          }
          lines.push(`  ├ 内部 ${result.messages.length} 条消息`);
          if (senders.size > 0) lines.push(`  ├ 发送者: ${Array.from(senders).slice(0, 5).join("、")}${senders.size > 5 ? `等${senders.size}人` : ""}`);
          const subParts = [];
          if (imgCount > 0) subParts.push(`${imgCount} 图片`);
          if (vidCount > 0) subParts.push(`${vidCount} 视频`);
          if (fileCount > 0) subParts.push(`${fileCount} 文件`);
          if (subParts.length > 0) lines.push(`  └ 含 ${subParts.join("、")}`);
        }
      } catch {
      }
    }
    if (allMediaCount === 0 && forwards.length === 0) {
      lines.push("⚠️ 此消息不含可保存的内容");
    }
    await sendReply(ctx2, event, lines.join("\n"));
  });
  registerCommand("save", handleSave);
  registerCommand("extract", handleExtract);
  registerCommand("disk", handleDisk);
  registerCommand("colle", async (ctx2, event, _replied, args) => {
    var _a;
    const sub = (_a = args[0]) == null ? void 0 : _a.toLowerCase();
    if (sub === "on") {
      pluginState.config.collectorMode = true;
      pluginState.saveConfig();
      await sendPlainText(ctx2, event, "📥 Collector mode 已开启\n所有包含图片或转发的消息将自动保存");
      ctx2.logger.info("[Forward] Collector mode ON");
    } else if (sub === "off") {
      pluginState.config.collectorMode = false;
      pluginState.saveConfig();
      await sendPlainText(ctx2, event, "📤 Collector mode 已关闭");
      ctx2.logger.info("[Forward] Collector mode OFF");
    } else {
      const status = pluginState.config.collectorMode ? "🟢 开启" : "🔴 关闭";
      await sendPlainText(ctx2, event, `Collector mode: ${status}
/colle on — 开启
/colle off — 关闭`);
    }
  });
  ctx.logger.info("[Forward] 已注册命令: help, info, save, extract, colle, disk");
}
export {
  plugin_cleanup,
  plugin_config_ui,
  plugin_get_config,
  plugin_init,
  plugin_on_config_change,
  plugin_onevent,
  plugin_onmessage,
  plugin_set_config
};
