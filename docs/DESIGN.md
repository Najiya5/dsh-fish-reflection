# 设计说明

这份文档解释「鱼的反思」为什么长成现在的样子，以及在哪些地方做了取舍。

## 1. 目标与非目标

**目标**

- 给一个 DSH 主会话一份**可持久、可审计、变化受控**的人格状态；
- 让“经历”能影响人格：对话 + 主动摄入的内容（视频）；
- 让状态能影响表达：每轮注入一份紧凑的状态块；
- 所有变化留档，人可以回看它为什么变成现在这样。

**非目标**

- 不做事实记忆/检索（交给记忆插件）；
- 不做角色扮演/世界模拟（交给 RP 类插件）；
- 不追求“更像人”的语音/形象（表现层）；
- 不承诺“反省让它变好”，只维护连续性（见 README）。

## 2. 状态模型

存储用 DSH 的 `storageDomain`（`~/.dsh/storages/fish_reflection.json`，单 domain、四张表）：

| 表 | 键 | 内容 |
|---|---|---|
| `self` | `state` | `revision`、`worldview[3–7]`（id/text/weight/kind）、`spirit{mood,energy,stress}`、`health{score,trend}` |
| `balance` | 日期 | 当日余额样本（currency/balance/wallets/late） |
| `journal` | `日期:时间戳` | 对话/视频摘要（role=`user`/`assistant`/`external`，每条 ≤400 字，每天 ≤400 条） |
| `meta` | `settlement` | `lastBalanceDate` / `lastReflectionDate` / `lastReflectionAt` |

成长档案不在状态域里：`~/.dsh/fish-reflection/history.jsonl` 是 append-only 时间序列，便于按天回看。

## 3. 一次对话轮次的路径

```
session/event(user|assistant message)
  → digestEvent()：只留文本，跳过工具/注入消息
  → appendJournal()：按天裁剪后写入 journal
agent/pre-step(step===1, 主会话, 已启用)
  → lastUserText()：取本轮最后一条用户文本
  → judgeEmotion()：同步判情绪（effort=off，3s 兜底）
  → applyEmotion()：精神立即变，健康 0.88/0.12 慢均线
  → renderStateBlock()：按层配额取 3–7 条里的一部分，截 60 字
  → 追加一条 user 消息（source.kind=fish-reflection）
```

**为什么追加在末尾**：不改 system prompt 前缀，不破坏可复用前缀的 KV Cache；注入是 append-only，历史请求不受影响。

## 4. 反省

触发：

- 每日 `settlementTime` 之后一次；
- 启动/新建会话时补做；
- 设置页手动触发；
- 自动反省之间至少 4 小时（防止重启/新会话导致一天多次；文档中的“每晚一次”是目标而非硬保证）。

输入：

- `journalSince(lastReflectionAt)` 的全部主会话摘要（不受作用域限制）；
- 视频笔记（`external`）最多占**实际使用字符数**的 30%；
- 旧人格作为对照。

输出与约束：

1. 模型输出 JSON（`principles[]` + `note`）；
2. `normalizePrinciples`：旧条目按原文匹配、权重步长 ≤0.15；新条目 ≤2 条、权重 ≤0.6；总数 ≤7；
3. 确定性过滤：过短、重复、迎合套话、自我夸大直接丢弃；
4. 审稿：只审**新增/改写**条目，四类标准判 keep/drop；失败 fail-open；退回后不足 3 条则整体保留；
5. 写入：`revision+1`，写 `lastReflectionAt`，追加成长档案。

**为什么这么保守**：人格是长期产物，单次反省的期望收益远小于一次错误改写的破坏；失败模式必须偏“不动”。

## 5. 刷视频

```
B站热门/生活区 ──┐
抖音链接队列 ────┤→ 标题/简介/字幕
                 ├→ 本地 ASR（字幕缺失时）
                 ├→ 画面：本地视觉 / 外部多模态 API
                 └→ 总结为 10–15 行笔记 → journal(external)
```

- 有硬预算：单帧 90s、整段画面 90s、ASR 整段 4min、整次读取 10min；
- 抖音解析四级兜底：分享页 → 公开接口 → 无头 Edge/Chrome → yt-dlp；
- 抖音只接受自有域名链接，Cookie 不随媒体下载；B站 Cookie 只用于 API/CDN 请求（本地视觉时 ffmpeg argv 中会带 Cookie，见 SECURITY）。

## 6. 宿主集成

- 本插件是 link 安装的 bundle，静态 `import '@deepseek-ai/...'` 会解析失败；
- `lib/hostdeps.js` 在宿主树里按文件 URL 动态导入 `schemastery`、`zod`、`createUserMessage`；
- 依赖的宿主服务：`storageDomain`、`llm`、`agentDefaultModel`、`webServer`、`sessionQuery`、`deepseekAccount`、`speechToText`（可选）；
- 这些是 DSH 的内部/实验接口，升级可能破坏兼容。

## 7. 已知设计缺口

- 没有“至少 3 条”的硬下限：模型未回显的旧条目会消失，只剩模型回显的 + ≤2 条新增；
- 反省周期用“今天 23:30”做 due 判断，早于 23:30 的补做语义不完全符合“最近一个结算点”；
- 手动反省与自动反省没有共享锁（`revision` 读改写）；
- 本地 API 只有同源检查，没有 token；
- 没有事实记忆，视频素材是“补充”而非检索来源。

这些在 `docs/` 之外的审计记录里有展开；本项目按“本地娱乐”定位，未全部修复。
