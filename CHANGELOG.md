# Changelog

## 0.8.12 — 2026-10-28

安全修复：

- 抖音链接只接受抖音自有域名（`douyin.com` / `iesdouyin.com` / `douyinvod.com` / `douyinpic.com` / `douyincdn.com` / `snssdk.com` / `bytecdn.cn` / `bytedance.com`），其他 URL 拒绝；
- 页面请求逐跳校验重定向目标，Cookie 不再可能被发往任意主机；
- 页面请求与媒体下载分离：媒体下载不携带 Cookie；
- 浏览器/yt-dlp 兜底只使用校验过的抖音 URL；
- `options.json` 改为临时文件 + rename 原子写；读到损坏文件时备份为 `options.json.corrupt-<时间戳>` 并告警，不再静默重置。

其他：

- 新增 `test/security.test.mjs`（域白名单 + 原子写/损坏恢复）；
- 发布版默认值不再包含本机绝对路径，Ollama/yt-dlp 改为运行时探测。

## 0.8.11 — 2026-10-28

- 设置页精简：「当前状态 / 成长档案 / 刷视频心得」收进可折叠的 **pass by** 文件夹，支持导出三份 Markdown；
- 「看B站视频」升级为「刷视频」，支持 B站 + 抖音（游客模式、Cookie 可选、抖音链接队列）；
- 新增「分析视频的模型 API」（OpenAI 兼容多模态接口，需要同时支持多模态与 ASR）；
- 抖音解析：分享页 → 公开接口 → 无头 Edge/Chrome 渲染 → yt-dlp 四级兜底。

## 0.8.0 — 2026-10-28

- 新增本地视觉（Ollama + qwen2.5vl:3b，按需拉起）；
- 本地 ASR（SenseVoice INT8，3 MiB 分片）；
- 读取链硬预算与阶段诊断（单帧/整段/单次读取超时）。

## 0.7.x

- 反谄媚规则 + 确定性过滤 + 模型审稿（fail-open）；
- 反省调度加 4 小时最小间隔；
- 设置页统一 Cookie 输入，B站总开关。

## 0.6.x

- B站视频读取（字幕/ASR/简介/评论），笔记进入反省素材；
- 7:3 素材权重按实际使用字符计算。

## 0.5.x

- 「鱼的反思」重命名、状态域迁移（humanloops → fish_reflection）。

## 0.4.x 及更早

- 内循环三观、精神/健康、财务外循环、成长档案、设置页、append-only 注入。
