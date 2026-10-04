# Decision: 对齐 dsh 0.2.0——客户端缝迁移 + 设置面改条目 Config

Status: implemented

## Problem

dsh 从 0.1.6-alpha.2 起换代了设置面与客户端缝，0.2.0 又换掉了宿主设置注册：

- keyed 槽 `settings.plugin.item` 与传输服务 `ctx.settingsScope` 被
  `plugins.item` / `plugins.bundle.config` / `plugins.row.config`（`dsh-client-ui-plugin-manager`
  声明）与 `configForms` / `settingsSchema`（`dsh-client-ui-settings` 提供）取代；
- 宿主 `ctx.jobs.onJobDone` 被 `ctx.jobs.events.subscribe`（`settled` 事件）取代，
  `agent/session-start` 被 `agent/created` 取代，`jobs.list(caller)` 的 caller 从 Agent 对象
  收窄为 SessionId 字符串；
- `ctx.settings.register(ns, schema, opts)` 与其 `scope.get()/watch()` 被 `SettingsForms`
  （`describe/update/replace/mutate/configure`）取代：**设置命名空间不再是插件自行注册的名字，
  而是声明了 `Config` schema 的条目 id**；标了 `.volatile()` 的字段由宿主换成实时引用
  （`{ get() }`）原地提交、不重挂载，并发 `loader/volatile-update`。

whale-girl 按 0.1.0-rc.8 契约定型，在 dsh 0.2.0-rc.2 上的实际后果：

- **client half 不挂载**：cordis 严格注入缺一个服务即整个条目永久 pending
  （web 启动面板：`whale-girl: pending (waiting for service: settingsScope)`），宠物与卡片一起消失。
- **Node half 不激活**：`ctx.jobs.onJobDone is not a function` 抛在 apply 内，
  启动日志 `1 entry did not activate`。
- **配置面静默失效**：`typeof settings.register === 'function'` 为假 → 命名空间未注册 →
  `settings.yaml` 的 `whale-girl:` section 不被读取、卡片永不出现、配置停在 DEFAULTS。
- **静默漂移**（不抛错、只在行为上消失）：`agent/session-start` 不再触发 → 新会话 welcome
  与 +XP 记账缺席；`jobs.list(agent)` 传对象与 `list(SessionId)` 比较恒不等 → 只收集到
  unowned 任务，owned 任务的 working/celebrate 推导缺席。

## Decision

**client half**

- 注入面改为 `['slots', 'locale', 'configForms']`；scope 取 `ctx.configForms.get('whale-girl')`
  （官方 `ConfigFormController`，getSnapshot/subscribe/set/unset/mutate 与旧 scope 同形）。
- 卡片槽选 `plugins.item`（list 槽 = Plugins 页「官方」组里的卡片；`id` 取包名字面量，`order` 50
  排在官方同族卡片 10–40 之后），注册经 `configForms.whileServed(['whale-girl'], …)`：宿主不服务
  该命名空间时不注册、不留空卡片。卡片按该槽的两段视图实现（`summary` 回一句话——既作列表一行
  又作详情描述；`page` 画字段区 + 保存/放弃脚注，标题/描述 chrome 由页面提供），hooks 先于视图分支。
- 槽位置在评估后由 `plugins.bundle.config`（包页内嵌，官方契约给自有 bundle 的默认位）改为
  `plugins.item`（列表卡片）：两者都合法，取「Plugins 页列表里一眼可见」；代价是占用官方插件
  语义位（Alternatives 记了取舍）。
- 暂存表单写路径改用官方 `mutate` 的**深路径 ops**（单次提交、单次 revision 栅栏）：
  `set` 只达单段，嵌套字段（`walk.enabled` / `replies.feed`）不再需要整组合并写；
  CAS 基线 revision 在首次暂存时取（暂存期间他人写入 → 保存被拒 → `failed`）。
- 保存后的接受值确认按**结构等价**比较（`sameLeaf`）：宿主往返后数组/对象引用必然不同，
  引用比较会把成功保存误判为失败。

**Node half**

- 导出 `Config = buildSchema()`（条目 id `whale-girl` 即设置命名空间）；schema 的每个可 live
  调的叶子标 `.volatile()`（含嵌套叶与数组叶），容器保持普通对象。
- `inject` 去掉 `settings`；`apply(ctx, config)` 以 `readConfig(config)` 读值——解引用 volatile
  叶子、与 DEFAULTS 合并补缺、成对区间归一（min > max 时交换）。
- `ctx.on('loader/volatile-update', …)` 重读快照并递增 `configRevision`（客户端以 /state 的
  configRevision 门控「变化才重新应用」），并广播 SSE 让浏览器立即重拉。
- `validateConfig` 退役：写面的宿主校验钩子（`settings.register` 的 `validate`）已不存在，
  成对区间约束由 `readConfig` 归一化承接（值仍可解释），schema 承担单字段 clamp。
- 依赖从 `schemastery` 换成 `@deepseek-ai/schemastery`——`.volatile()` 与其 `~standard` 校验
  产生引用的行为只在 dsh 这份 fork 里。
- 任务终态订阅改 `ctx.jobs.events.subscribe({ owners: 'all' }, …)`，只看 `settled` 事件的
  `job` 投影（killed 中性语义不变：按 status 分支，不看 cause）；`collectTasks` 按 `agent.id`
  取该会话任务；会话启动订阅改 `agent/created`（`payload.source` 取值域与旧事件同构）。

**门禁**

- 新增 `verify-client-seams`：拒绝 client half（源码与生成物）引用已退役缝名
  `settingsScope` / `settings.plugin.item`，带自证测试。
- `verify-config-sync` 扩为「默认值 + 命名空间同一性」：`cordis.patch.yml` 条目 id、
  `package.json` 包名、`src/config.mjs` `NAMESPACE`、client `SETTINGS_NAMESPACE` 字面量四处
  必须同名（宿主的设置命名空间 = 条目 id；包名与卡片 id 取同一份身份字面量——任一处漂移
  即卡片静默消失或设置面不再被读取）。

## 取代检查

部分取代 [feature/2026-08-31-settings-panel-card.md](../feature/2026-08-31-settings-panel-card.md)
的缝选择与传输面：该记录的 `settings.plugin.item` keyed 槽 + `ctx.settingsScope.bind()` 由本记录
取代为 `plugins.item` + `configForms.get()`，卡片 chrome（折叠头 + 未保存徽章）改由官方
页面提供。其动机（GUI 内配置入口）、卡片范围（高频 7 字段）、暂存/保存/放弃语义、locale 独立
命名空间契约不受影响；该记录已加回链。

部分取代 [feature/2026-08-09-config-system.md](../feature/2026-08-09-config-system.md) 的注册与
读值机制：其 `settings.register(ns, buildSchema(), {applies:'live', validate})` +
`scope.get()/watch()` 由本记录取代为「条目导出 `Config` + volatile 引用 + `readConfig` +
`loader/volatile-update`」。其配置分层（L1 可配 / L2 语义层封闭 / L3 安全层）、DEFAULTS 单一来源、
`/config` 只读路由、`/state` configRevision 门控与客户端 `applyClientConfig` 契约不受影响；
该记录已加回链。

## Alternatives considered

**A：只从 inject 摘掉 `settingsScope`。** 宠物恢复挂载，但卡片永久不出现、Node half 仍不激活，
配置面继续静默失效；且留下「注入了宿主不存在的服务名」的契约漂移，弃。

**B：卡片放 `plugins.bundle.config`**（包页「描述与行清单之间」的内嵌配置区——官方契约给自有 bundle
的默认位，`key` = 包名）。功能等价且不与官方插件抢位置，但要进包页才见配置（多一次点击），
且 key 把包名与卡片位置绑在一起；发现性优先，弃。

**B2：改用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm`/`SettingsValueField` 画卡片。**
平台种子表里有这些控件（0.2.0），能少写一套自绘；但官方表单模型只支持单段字段路径（嵌套的
`walk.enabled` / `replies.feed` 仍要绕），文案池多行控件也要自绘，且把卡片外观交给平台内部组件；
手写表单已单测覆盖，弃。

**C：卡片迁 `plugins.row.config`**（包页上该行的「配置」按钮，开独立页）。功能等价且 form 由页面
直接下发，但比包页内嵌多一次点击才见配置，且键（`whale-girl#whale-girl`）把包名与行 id 的耦合
写进字面量，弃。

**D：卡片改成宠物菜单内的自绘配置面（POST `/config` 写面）。** 违反 config-system 的
「插件不自建写面」信任边界（写路径只有用户设置服务/文件），弃。

**E（Node half）：保留 `settings.register` 兼容分支，缺失时只用 DEFAULTS。** 命名空间不会存在，
卡片与 `settings.yaml` 全失效——正是本记录要修的故障，弃。

**F（Node half）：只在容器（`walk` / `replies`）上标 volatile。** 卡片写深路径时
`isVolatilePath` 不认；反之若只写容器路径则要复活整组合并写。叶级 volatile + 深路径写是两半
唯一自洽的组合，弃容器方案。

**G（Node half）：把 `validateConfig` 挂进 schema。** 该 fork 的 schema 实例没有
`custom()`/`validate()` 钩子（`.set` 只写 meta，校验管线不消费自定义键），做不到写时拒绝；
归一化由 `readConfig` 承接，弃。

**H（client）：改用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsFormModel` 与控件。**
能删掉手写表单，但官方模型同样只支持单段 `field` 路径（嵌套字段仍要绕）、文案池需要自绘多行控件、
且把卡片外观交给平台内部组件；手写表单已单测覆盖，弃。

## Consequences

- dsh 0.2.0-rc.2 冷启动下两个 half 都激活：启动日志无 `entry did not activate`，浏览器无
  `Failed to load plugins`，宠物以 sprite 渲染（`verify-client-smoke` / `verify-client-behavior`
  探针实测通过）。
- 配置面恢复且可用：Plugins 页「官方」组出现 whale-girl 卡片（实测渲染出 7 个字段行）；卡片改
  size 110↔140 保存后，`/whale-girl/config` 立即反映新值与递增 revision，页面内宠物
  `--pet-size` 跟着变（volatile 原地提交，无重挂载、无刷新），写入落进 profile patch 的条目
  `config:` 块（实测：`- id: whale-girl` + `config: {size: 140}`）。
- 新会话 welcome/+XP 与会话续接 +2 记账恢复（`agent/created`）；owned 任务的
  working/celebrate 推导恢复（`jobs.list(agent.id)`）。
- `settings.yaml` 的 `whale-girl:` section 由宿主的 legacy 导入搬进条目 config（一次性），
  此后的全量配置面是条目 `config:`（settings.yaml 不再是活文档）。
- 门禁从 11 条增至 13 条（verify-client-seams、verify-config-sync 扩面），单测 12 + 6 例；
  `schemastery` 依赖换成 `@deepseek-ai/schemastery@^3.18.4`（与运行时的 fork 同源）。
