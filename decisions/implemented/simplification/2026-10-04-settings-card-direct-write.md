# Decision: 设置卡改为即时写入（去掉保存/放弃按钮与暂存模型）

Status: implemented

## Problem

设置卡带一份多余的状态机与三个偏离 DSH 官方通用设置页的做法：

1. **保存 / 放弃修改两颗按钮。** 官方通用设置页（开关、数字、选项）**改动即时落库、没有保存按钮**
   ——其 README 写开关 "follows accepted changes immediately, and disables duplicate input while a
   write settles"。官方 `SettingsForm` 那套页脚保存只属于部分页面（其注释：controls a page shows
   under a plugin's title, and the save that writes them），而**通用设置页不是**；它的页脚里也**只有
   `.save`，没有放弃/取消**（官方语义是「只在按钮上保存，卸载时丢弃草稿」）。
2. **开关也要按保存才生效。** 卡片把全部字段（含两个开关）交给同一套暂存，开关因此不再即时——
   这正是官方开关语义的反面。
3. **暂存模型是这份交互的实现载体**：`settings-form.mjs` 的 `WhaleSettingsForm`（171 行 + 12 项单测）
   存在的唯一意义就是暂存/批量提交/失败重读。没有保存按钮之后，它整体变成死重量。

## Decision

- **删除保存 / 放弃修改两颗按钮**，改为**即时写入**：开关点击即写；数字与文案池在**失焦或回车**时
  提交（不做逐键写入，避免每敲一个字提交一次）。
- **删除暂存模型**：`lib/client/settings-form.mjs` 与其单测一并移除，保留其中仍然需要、且与界面无关
  的部分，收进新的纯模块 `lib/client/settings-fields.mjs`：字段规格 `CARD_FIELDS`、叶取值 `leafOf`、
  叶值等价 `sameLeaf`、快照派生 `deriveState`、文案池解析，以及即时写入 `writeField`。
- **写路径走官方 `mutate` 的深路径，且不自己传 revision**：`writeField` 提交
  `[{ op: 'set', path: path.split('.'), value }]`，把排队与栅栏留给 `ConfigFormController` 自己
  ——控制器按 `pendingRevision` 给后继写定栅栏；自己传提交时刻的快照 revision 会绕过那道栅栏，
  同一 RTT 内的连续改动会被宿主按 CAS 拒绝（第一次其实已落库），结果是误报「未被接受」并丢掉
  后一次编辑。提交后按宿主回读值逐字段确认（数组/对象按形状比——往返后引用必然不同），
  未获接受时抛错。嵌套字段（`walk.enabled` / `replies.feed`）因此不必再整组合并写
  （`set` 只达单段，`'walk.enabled'` 会字面落键）。
- **失败提示与回读留在卡片内**：写入被拒时在字段区下方显示一条提示，并递增一次 `resetToken` 让
  数字/文案输入把缓冲回读成宿主值（开关由快照派生，自动回位）——输入不会停在未落库的内容上。
- **快照引用稳定由注册函数缓存**：hooks 走 `useSyncExternalStore`，内容未变时必须返回同一对象，
  否则无限重渲（React #185）。宿主每次变更替换快照对象，故按对象身份缓存。
- **注册缝归 bundle 包页**：卡片注册在 `plugins.bundle.config`（keyed，key = 包名），
  `configForms.whileServed` + `slots.inject` 不变；槽位取舍见
  [bug-fix/2026-10-04-settings-card-bundle-slot.md](../bug-fix/2026-10-04-settings-card-bundle-slot.md)，
  控件选型见 [simplification/2026-10-04-settings-card-official-controls.md](./2026-10-04-settings-card-official-controls.md)。
- **归属测试**：`tests/settings-fields.test.mjs`（13 项：叶取值、叶值等价、快照派生、即时写入的
  深路径提交 / 不带自带栅栏 / 同 RTT 连续写入都落库 / 拒绝与回读不一致、字段表完整性）。

## 取代检查

部分取代 [feature/2026-08-31-settings-panel-card.md](../feature/2026-08-31-settings-panel-card.md)
的暂存/保存语义与写路径（该记录已就地标注）。本记录只覆盖「设置卡的保存语义与写路径」；控件选型归
[simplification/2026-10-04-settings-card-official-controls.md](./2026-10-04-settings-card-official-controls.md)，
卡片槽位归 [bug-fix/2026-10-04-settings-card-bundle-slot.md](../bug-fix/2026-10-04-settings-card-bundle-slot.md)，
`enabled=false` 的 teardown 边界归
[bug-fix/2026-10-04-enabled-false-keeps-config-card.md](../bug-fix/2026-10-04-enabled-false-keeps-config-card.md)。

## Alternatives considered

**保留官方 `SettingsForm` 式的页脚保存（只去掉「放弃修改」）。** 这是改动最小的一版，也符合官方
部分页面；但以**通用设置页**为准时那一页没有保存按钮。且保留页脚保存就要继续养着整套暂存
模型与「未保存」徽章，与「改即生效」的诉求相反。

**只把开关改成即时、数字文案仍按保存。** 官方确有这种混用先例（官方 subagent 页 = 官方开关即时 +
官方表单暂存数字）。未采用：同一张卡片上两种语义并存，用户无法从界面判断哪些改动已经生效。

**保留暂存模型、仅不渲染按钮。** 会留下一个永不提交的草稿层：用户改完数字后离开页面，草稿或静默
丢弃、或在他处生效——两种都不可解释。整体删除更干净。

**把组字段继续按整组合并写。** 那是 `set` 时代的绕法；官方 `mutate` 接受深路径后，整组合并既多一次
读、也多一份可能与并发写入打架的合并逻辑。

**自己传 `expectedRevision` 做 CAS。** 见 Decision：它与控制器的 `pendingRevision` 排队语义冲突，
在同一 RTT 内连续改动时误报失败并丢编辑；交给控制器是唯一正确用法（官方 `ui-theme` 的即时写入即
如此：快速改动按手势顺序串行，被拒时重读）。

## Consequences

- 卡片与官方通用设置页一致：字段直接可见、改动即时落库、无保存/放弃按钮。
- 少一个模块（`settings-form.mjs`，171 行）与 12 项与其绑定的单测；新增 `settings-fields.mjs`
  （纯函数）与 13 项单测。当前仓库共 155 项测试、15 门禁（CI 组）通过。
- 误改无法在页面内撤销（没有草稿层，也就没有「放弃」的对象）；这与官方通用设置页一致。
- 数字与文案池仍是失焦提交：输入过程中不落库，点开别的控件或离开页面即提交。
- 并发语义：连续写入由控制器按手势顺序串行提交，不再出现「第二次被自己的过期栅栏拒掉」；
  宿主真正拒绝（或回读值不一致）时卡片提示并把输入回读成宿主值。
- `lib/client.js` 重新生成（`build-client --check` 全绿）。
- 真机验证（dsh 0.2.0-rc.2 + 隔离实例 + headless Chrome）：卡片渲染 7 字段、点击开关即写、
  写入后卡片仍在、可反复修改。