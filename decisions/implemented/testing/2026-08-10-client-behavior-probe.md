# Decision: client 行为回归探针入库（verify-client-behavior）

Status: implemented

## Problem

client DOM 行为（拖拽/交互/状态序列）的回归验证此前全靠一次性 `/tmp/cdp-*.mjs` 探针——不入库、不可重跑，行为改动后无法持久化回归；`verify-client-smoke` 只断言 apply 成功 + 渲染，不覆盖行为。「行为改动 → 最窄测试」在 client DOM 层没有归属执行点。

## Decision

- 新增 `scripts/verify-client-behavior.mjs`（人工验证步骤，非门禁——依赖 Chrome 与运行中的 web，同 verify-client-smoke）：headless Chrome + CDP（Runtime/Input），场景化执行 + 断言。
- headless Chrome 的启动参数必须含 `--remote-allow-origins=*` 与每次独立的 `--user-data-dir`（`mkdtempSync`）：前者是 CDP WebSocket 的 Origin 校验（新版 Chrome 不带该参数会**永久挂起**在 `new WebSocket(...)`，不报错），后者防探针挂到默认 profile——那会复用已有浏览器实例，`/json` 里的第一个 page 可能是别的标签页，断言在错误的页面上失败（smoke 与 behavior 同款，两个脚本一致）。
- 首个固化场景 `sleep-drag-wake`（v6 交互醒觉回归防线）：真实时间等宠物入睡 → 真实鼠标拖拽 → 断言序列契约 `sleep → drag → idle 缓冲 → wake → 保持清醒不回 sleep（10s）`，任一断言失败非零退出。
- 场景表可扩展（SCENARIOS 对象）；入口 `node scripts/verify-client-behavior.mjs <web-url> [scenario]`，入 AGENTS.md 按改动面选检查表（client 行为改动行）。

## Alternatives considered

**A：把行为断言并入 verify-client-smoke。** smoke 面向「apply + 渲染」快速冒烟，行为场景要等 65s 真实时间，合并会让 smoke 变慢且职责混杂——分离。

**B：门禁化（入 run.mjs）。** 依赖外部 web 与 Chrome，无 web 时无法确定性执行——保持人工验证步骤（同 smoke），不做门禁。

## Consequences

- client 行为改动后可重跑 `verify-client-behavior.mjs <web-url> sleep-drag-wake` 做回归；场景随行为演进扩展。
- 依赖 Node ≥22（全局 WebSocket）与 Chrome（CHROME_BIN 覆盖）；非门禁，CI 不执行。
