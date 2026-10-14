# whale-girl PR #29 预览图（离屏渲染产物）

位于 `pr-evidence/pr-29/`（沿用本 fork 既有 `pr-evidence/` 资产目录惯例）。

本目录是 `feat: 会话记忆（本机 sessions.json + 血缘回读 + 设置开关，默认关）` 的 before/after
渲染图，供 PR 正文引用。**不是截屏**（本机无屏幕录制权限），而是无头 Chromium 里跑真实代码的离屏渲染。

## 图

| 文件 | 内容 |
| --- | --- |
| `settings-card-before-dark.png` / `settings-card-after-dark.png` | 设置卡字段区，深色主题；after 多出「会话记忆」行（含两段说明） |
| `settings-card-before-light.png` / `settings-card-after-light.png` | 同上，浅色主题 |
| `bubble-before.png` | 记忆关闭（默认）：重逢时不出现回读气泡 |
| `bubble-after-resume.png` | 记忆开启 + 会话恢复（`distance = 0`）：`上次你们完成了「…」、「…」` |
| `bubble-after-fork.png` | 记忆开启 + fork（`distance = 1`）：`上次在分支前的会话里完成了「…」、「…」` |

设置卡四张同尺寸（2160×1362，DPR 2）；气泡三张同尺寸（1160×360，DPR 2）。

## 渲染的是什么

真实代码，非复刻：

- **设置卡**：`lib/client/settings-card.mjs` 原文（React 组件），控件是官方
  `@deepseek-ai/dsh-client-ui-primitives` 的 `Switch` / `Input` / `Button` 源码 + 官方 CSS Module，
  主题是官方 `ui-theme` 的 `design-platform.css` / `base.css` / `corner-shape.css` / `focus.css` /
  `scrollbar.css`。before = `main`，after = `feat/session-memory`。
- **气泡**：`lib/client/index.mjs` 的 `apply()` 原文在无头浏览器里真跑（传空 ctx，跳过设置卡注册），
  素材取仓库真实 `lib/assets`；气泡文案由 `lib/client/logic.mjs` 的 `memoryLine` 真实输出
  （脚本里再用 node import 独立复算一遍做断言）。before = `main`，after = `feat/session-memory`。

## 桩数据（自拟，仅宿主侧输入）

- `/state`：`pet = { level: 3, xp: 150, titles: ['初次协作','勤劳伙伴'], stats: { tasksDone: 24, failures: 0, sessions: 3, … }, memory: ['[10-14 23:01] 完成任务：补充会话记忆单测'] }`，
  `activity = { name: 'idle', until: 0 }`。
- `/state.memory`（after）：`{ at: 1760471789000, distance: 0 | 1, title: '会话记忆回读', tasks: [
  { label: '实现会话记忆回读', ok: true }, { label: '补充单元测试与门禁', ok: true },
  { label: '跑 gates 全量（失败，不进气泡）', ok: false } ] }`。
  第三条 `ok: false` 是刻意放的：`memoryLine` 只取已完成任务，气泡里应只出现前两条。
- `/config`：`DEFAULTS` 的取值，另外 `bubbleMs` 由真实默认 2500ms 调大到 600000ms
  ——**只为让截图窗口稳定**（气泡不会在截图前消失），不改视觉。
- 设置卡的更新行 GET `/whale-girl/update` 桩成 `{ state: 'up-to-date', current: { version: '0.2.0' } }`
  （该行不属于本 PR 改动，桩掉只为不显示红色的「检查失败」）。

## 保真度

- 设置卡字段区、气泡、宠物、素材、文案：真实代码 + 真实样式。
- 设置卡外的**页壳**（`.page` / `.detailSections` / `.detailSection` 的宽度与留白）：按
  `ui-plugin-manager` 的 `PluginManagerPage.module.css` 实测值复刻，`plugins.bundle.config` 槽本身
  没有自有底色/描边，页底色来自主题 `body` 的 `--dsw-alias-bg-base`。
  包页的图标/标题/描述/版本标签不在图内（本组件只画字段区）。
- 宿主注入的 props（`useWhaleSettings` 快照、`write`、`t` 文案表）是脚本提供的桩：文案表直接取
  组件自己的 `zh` 字典，快照取 `src/config.mjs` 的 `DEFAULTS`。
- 气泡图为让文案可读，视口取 580×180、宠物保持默认锚定（右下角 16px）；气泡落在角色上方是
  `overlay-placement.mjs` 的真实收敛结果（贴视口底部翻面），不是摆拍。

## 复现

`render/` 里是当时的脚本（绝对路径与 DSH 源码 checkout 位置绑定，需按机器改）。
`node render-cards.mjs` / `node render-pet.mjs` 即可重出图；依赖：`react@18.3.1`、
`react-dom@18.3.1`、`clsx`、`esbuild@0.28.1`、`playwright-core`（chromium）。
