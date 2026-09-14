# NapCat 文件下载机制

## 关键文档

NapCat 文件处理完整文档：https://napneko.github.io/develop/file

## 消息段类型与下载方式

| 段类型 | JSON `type` | 直链来源 | 获取 action |
|--------|-------------|----------|------------|
| image  | `"image"`  | `data.url` (CDN, ~2h 过期) | 过期后用 `get_image` / `get_file` 刷新 |
| video  | `"video"`  | `data.url` (CDN) | 无 URL 时用 `get_file` |
| voice  | `"record"` | `data.url` (raw silk) | 无 URL 时用 `get_record` (支持转码 out_format) |
| file   | `"file"`   | 无 CDN URL | **私聊**: `get_private_file_url`; **群聊**: `get_group_file_url` |
| onlinefile | `"onlinefile"` | 无 URL | 不可下载 |
| flashtransfer | `"flashtransfer"` | 仅 `fileSetId` | 不可直接下载 |

## 核心原则

1. **image/video/voice 有 `url` 时直接下载**，无 `url` 时用 `get_file` (或 `get_record` for voice) 补充获取
2. **file 类型没有 CDN URL**，必须通过 `get_private_file_url` (私聊) 或 `get_group_file_url` (群聊) 获取直链
3. `get_file` 对 file 类型返回的是 base64 或本地路径，不是可下载的 HTTP URL
4. 图片 URL 约 2 小时过期，过期后可通过 `nc_get_rkey` 或 `get_image` / `get_file` 刷新

## 当前实现 (save-handler.ts: downloadMedia)

```
for each segment:
  if data.url 存在 → 直接 HTTP 下载
  else if data.file_id 存在:
    file 类型 → get_private_file_url 获取直链
    其他类型 → get_file 获取 URL/base64
  else → 跳过 (记录日志)
```

## 教训

1. **先查文档再写代码。** 本插件开发过程中，file 类型下载失败的根本原因是未先阅读 NapCat 文件处理文档，盲目假设所有类型都可用 `get_file` 获取 HTTP URL。应遵循 SOUL.md 原则："遇到不确定性时，避免猜测"。

2. **`node:https` 不支持 `http://` URL。** QQ CDN 返回的直链可能是 HTTP（如 `http://222.94.109.91:80/qqdownloadftnv5?...`）。修复方式：根据 `parsed.protocol` 动态选择 `node:http.get` 或 `node:https.get`，而非固定使用 `node:https`。
   ```typescript
   import { get as httpGet } from 'node:http';
   import { get as httpsGet } from 'node:https';
   // ...
   const getter = parsed.protocol === 'http:' ? httpGet : httpsGet;
   ```

## 去重与计数规则（2026-09-14）

`downloadMedia()` 命中 `existsSync(dest)` → `skip++`，**不是 `ok++`**。跳过必须与
"新写入"分开计数，否则报告会把重复图片谎报成"已保存/已下载 N"（用户实测发现：
同一张图重发多次，回复永远是「已保存」，磁盘却没新增文件）。

- 同指纹 = 同名 = 只留一份；**不为同名冲突生成 `_1/_2` 副本**（用户明确要求）
- `ok` = 新下载，`skip` = 重复跳过，`fail` = 下载失败
- 报告：`图片 2 共 3 件 (新下载 1, 重复跳过 2)`；全为重复 → `⚠️ 已存在，未重复下载`
- 注意：`data.file` 只有 image/video 是 32 位指纹名，`file`/`record` 段给的是原始
  文件名（同名 ≠ 同内容，此边界用户已知悉并接受）
