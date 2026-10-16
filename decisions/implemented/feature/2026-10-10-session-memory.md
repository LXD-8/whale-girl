# Decision: 会话记忆（本机 sessions.json + 血缘回读）

Status: implemented

## Problem

宠物对会话毫无记忆：fork 出分支或重启续接后，宠物与用户"首次见面"一样，无法说一句「上次你们完成了什么」。DSH 0.2.1-alpha.2 新增了实验性的 Session 插件记录接口（`appendPluginRecord`/`pluginRecordOf`），官方语义（随日志 fork/resume 携带、永不进模型面）看似正是为此准备；但该接口对 profile 安装的第三方插件实际不可用——`appendPluginRecord` 经 Session 类的私有方法提交记录，模块实例不同即抛 TypeError（跨模块私有品牌检查），而插件从 profile 目录 import `@deepseek-ai/dsh-session` 解析不到宿主实例。同时该能力还须满足：默认关闭（opt-in）、关闭即零副作用、隐私边界可一句话说清。

## Decision

**自建本机会话记忆，不依赖宿主记录接口**。新增 `lib/src/session-memory.mjs`（纯逻辑，零宿主依赖）与独立文件 `<dshHome>/data/whale-girl/sessions.json`（与账本 `state.json` 分离——开关只停记忆，不动账本）：

- **存储形状**：`{ sessions: { [sessionId]: { parent?, title?, subagent?, at, tasks[] } } }`。任务条目 `{ label, ok, at }`，标签 160 字、每会话 8 条，全部越界裁剪；会话数分两套预算——最近 64 个**用户**会话 + 16 个 subagent 子会话，各自按 `at` 淘汰（子会话永不播报回读，一次密集委派 spawn 出的几十个子会话不得把用户自己的会话挤出账本）；`normalizeSessionMemory` 逐字段容错，损坏即回空账本（记忆可丢，只影响气泡文案）。
- **血缘回读**：fork 的子会话在宿主会话头里带 `parentSession`（DSH 会话头字段，观测时登记进 `parent` 链），`memoryFor` 沿链找最近一条有任务记录的会话（最大 8 跳、防环、链断即 null 不猜）——「分支也记得上次做了什么」由此而来，无需宿主记录接口。子会话的任务与血缘同样入账，所以 fork 一个子会话仍能读到它做过什么。
- **写入点**（全部 `sessionMemory` 开关门控）：任务 `settled` 事件按 `JobView.owner`（SessionId）精确归属，无属主退回最近活跃的**用户**会话（`lastSessionId` 只由非 subagent 的 `session/event` 更新——落在子会话上等于丢掉，它的回读永不播报）、两者皆无则跳过且**不加载账本**（不猜归属，也不留一个空文件）；`session/event` 首见会话时登记血缘与标题；`agent/created` 回读生成快照。
- **下发与播报**：`agent/created`（resume/fork/startup 边沿）的回读快照以 `memory: { at, distance, title, tasks }` 随 `/state` 下发，双窗口收口——Node 侧 `MEMORY_WINDOW_MS`（60s）过期即撤，客户端按 `at` 去重只播一次；文案纯函数 `memoryLine`（logic.mjs，失败任务不进气泡、标签截 14 字、`distance>0` 点明分支前）。
- **开关语义**：默认 false（opt-in）；关 = 零读零写零副作用，但**关闭边沿先末次落盘再丢内存副本**——1s 防抖窗口内已记的任务不因拨开关而消失，此后 `memory` 恒为 null，事件分支全部跳过（未播报的回读同时撤下，磁盘文件保留）；开 = 懒加载。落盘与账本同节拍（1s 防抖 + `.tmp`/rename 原子写 + disable/卸载末次落盘）。设置卡的说明按 `\n` 换行分两行（宿主 locale 的换行约定，卡片 `white-space: pre-line` 渲染）：第一行讲实现原理（本机文件、几字节/条、血缘回读），第二行讲隐私性（不进模型上下文、不上传网络、关闭停止读写、文件留本机可自删）。

## 取代检查

无重叠——本记录只覆盖「会话记忆」的存储、回读与开关。会话活动聚合归 [bug-fix/2026-08-10-session-state-node-aggregation.md](../bug-fix/2026-08-10-session-state-node-aggregation.md)，快照 wire 契约归 [architecture/2026-08-14-external-snapshot-contract.md](../architecture/2026-08-14-external-snapshot-contract.md)，账本持久化归 [feature/2026-08-08-state-persistence.md](2026-08-08-state-persistence.md)。

## Alternatives considered

**DSH 0.2.1-alpha.2 的 `appendPluginRecord`/`pluginRecordOf`（官方记录接口）。** 语义最贴合（随日志 fork 携带、`ignorable` 标记、不进模型面），但对本插件不可用：`appendPluginRecord` 通过 Session 类 static 块闭合的 `session.#appendRecord` 私有方法提交，跨模块实例的品牌检查必抛 TypeError（已用最小实验实证）；插件装在 profile，从自身文件 URL 解析 `@deepseek-ai/dsh-session` 得到 `ERR_MODULE_NOT_FOUND`，声明为依赖又只会装出第二份副本（正是抛错的那种情况）。此外该接口仍标 experimental，即便接通也要随宿主变动承担迁移风险。

**把记忆写进会话日志（普通 `session.append`）。** 未知事件类型会被持久化读路径按「新版本写入」处理（`ignorable` 缺失直接拒绝加载），等于给用户会话日志埋雷；且污染会话日志与宠物装饰性状态的边界。

**复用账本 `state.json` 存会话记忆。** 会话数与任务数是另一套有界裁剪策略，混进账本会把「记忆可丢」的容错语义传染给 XP/称号数据；分离文件让开关语义（关=停写）与账本（永远记）互不干扰。

**把回读结果常驻 `/state`。** 客户端仅凭 `at` 去重即可，但页面重开会重播旧问候；过期撤下把「重逢问候」约束在边沿附近，也让关闭开关时的撤下语义简单（清 `memoryRecall` 即可）。

## Consequences

- 宠物在 resume/fork 边沿会说一句上次完成的任务；fork 沿 `parentSession` 链回读（父会话须在开启期间被观测过，链断则不播——不猜）。
- **回读播报排除 subagent**：subagent 子会话（会话头 `origin: 'subagent'`）同样经 `agent/created` 发布且带 `parentSession`，不区分的话每次 subagent spawn 都会误播「上次你们完成了…」——纯函数 `recallable(header)` 只让用户会话（无 origin）生成回读快照；子会话仍照常登记进账本（任务归属与血缘不丢），登记时打 `subagent: true`（一旦打上即粘住：origin 是创建时定死的，后续观测不得把它洗回用户会话），据此走独立淘汰预算，且不作为无属主任务的归属兜底。
- 接线分两层归属测试：账本纯逻辑在 `tests/session-memory.test.mjs`（血缘/裁剪/容错/分预算淘汰），宿主接线在 `tests/session-memory-wiring.test.mjs`（假宿主驱动 `agent/created`·`session/event`·jobs `settled` 并调 `/state`：归属兜底、60s 回读窗口、开关语义与关闭边沿落盘、子会话不播报）；浏览器侧的回读气泡由 `scripts/verify-client-behavior.mjs` 的 `memory-bubble` 场景覆盖（CDP 拦 `/state` 响应注入 `memory`，断言「气泡出现 → 同一 `at` 不重播 → `at` 变化再播」，不依赖真实任务/会话边沿，可重复跑）。
- 新增 `data/whale-girl/sessions.json` 文件；卸载插件不删它（与 `state.json` 同理），隐私说明里写明可自行删除。
- 开关默认关：升级后无任何行为变化，用户主动开启才开始记录。
- `/state` 新增可选字段 `memory`（additive，`SNAPSHOT_API_VERSION` 不变）；旧客户端忽略该字段不受影响。
- 宿主 `jobs`/`sessions`/`agent` 事件缺席（headless 降级）时记忆功能静默停摆，宠物本体不受影响（与既有会话感知同一降级路径）。
- 会话头 `parentSession` 若宿主未来改名，fork 回读退化为「只记得本会话」——气泡仍可用，不崩。
