# Decision: 适配 DSH 0.2.x（jobs 事件 API、volatile Config、设置卡迁到 settings.plugins.tab）

Status: implemented

## Problem

插件在 DSH `0.2.1-alpha.1`（桌面版）上**双半区皆不可用**，且失败方式相互掩盖，现场只剩一条
`web boot: 1 entry did not activate` 的笼统报告。逐条定位后是五处宿主契约变更：

1. **client half 的 `settingsScope` 已整个移除。** `inject` 是 Cordis 的硬生命周期门禁：服务不齐，
   条目永久 `pending`，`apply()` 不会被调用——`lib/client/index.mjs` 里那段 try/catch 守卫
   （注释写明"任一缺失或注册失败仅「无卡片」，宠物照常跑"）因此**永远执行不到**，整只宠物不挂载。
   证据：宿主 `app.asar` 与前端 bundle 中 `settingsScope` 均 0 命中；声明支持到 `0.2.1-alpha.1` 的
   第三方插件 `lhh010/dsh-ui-whale` 客户端声明为 `inject = ['slots','locale']`。
2. **Node half 的 `ctx.jobs.onJobDone` 已移除。** 调用点在 `ctx.effect(...)` 内、激活时同步执行，
   于是 `TypeError: ctx.jobs.onJobDone is not a function`。0.2.x 的对应 API 是 `jobs.events`
   （getter，内部已绑定注册上下文），settled 事件形如 `{ type: 'settled', job: <view>, cause, awaited }`。
3. **`jobs.list` 的实参类型变了。** 宿主实现按 `job.owner.id === caller` 过滤，`caller` 期望 owner id
   字符串；传 agent 对象时比较恒为假，只返回无主任务。而 `deriveActivity` 的 `working` 完全由
   `tasks` 决定（`running.length > 0`），所以"工作中"姿势永不触发——静默失效，不报错。
4. **`settings.register` 命名空间模型已不存在。** `@deepseek-ai/dsh-settings` 只有
   `configure`/`for`/`describe`/`update`/`replace`/`mutate`。原调用抛错后被自身的 try/catch 吞掉，
   命名空间从未注册，`/config` 端点于是恒返回 DEFAULTS。0.2.x 的模型是「插件自身的 Cordis
   Config」，字段以 `.volatile()` 声明，表单以 **profile 条目 id** 为键。
5. **设置卡槽位与读写 API 都已更换。** `settings.plugin.item` 不存在；浏览器侧读改写
   `ctx.configForms.get(条目 id)`（`@deepseek-ai/dsh-client-ui-settings` 提供）。
   另需注意：0.2.1 中**没有任何内置 UI 会渲染插件配置表单**——`plugins.row.config` 槽存在、
   插件管理器也把 `form` 传了进去，但宿主中无任何包占用它（唯一提及者 `dsh-cordis-client-runner`
   是槽位文档目录而非实现），与 `dsh-settings` README「`autoGenerate` 默认开启，但目前没有已发布
   的客户端这样做」一致。故页面必须由插件自带。

## Decision

- **Node half 改用 `jobs.events.subscribe({ owners: 'scope' }, …)` 处理 `settled`**，取代
  `ctx.jobs.onJobDone`；任务终态记账、取消中性、庆祝窗口等既有语义不变。
- **`collectTasks` 改传 `agent.id`**，恢复会话任务的收集面（`working` 与完成/失败翻转的依据）。
- **配置迁移到导出的 volatile Config**：`export const Config = buildSchema().volatile()`、
  `apply(ctx, config)`，并以 `readConfig()`/`revision()` 统一读取面（取代模块级 `configRef`/
  `configRevision`）；`inject` 去掉 `settings`。依赖 `schemastery` 换成
  `@deepseek-ai/schemastery`（`.volatile()` 是 DSH 扩展）。
- **设置卡迁移而非移除**：读写改为 `ctx.configForms.get('whale-girl')`，槽位从
  `settings.plugin.item` 改为 `settings.plugins.tab`（「设置 → 内置插件」的列表槽，由官方
  `dsh-client-ui-settings-plugins` 声明）。`settings-form.mjs` 无需改动——
  `ConfigFormController` 的快照形状 `{ status, value, writable, … }` 与 `set(field, value)`
  正好匹配其既有接口（`snap.status`/`snap.writable`/`snap.value` + `subscribe` + `set`）。
- **client half 的 `inject` 改为 `['slots','locale','configForms']`**，并按 0.2.x 约定重新生成
  `lib/client.js` 产物。

## Alternatives considered

**直接删除设置卡。** 配置迁到 volatile Config 之后，也可以只留配置文件、不要卡片。取舍点在于：
`ConfigFormController` 的接口与既有表单**逐字段吻合**，迁移成本仅为一行取数来源加一处槽位注册，而卡片
承载了 7 个高频字段的本地化文案与暂存/保存语义；删掉它等于把可用功能换成文档说明。

**把卡片挂到 `plugins.row.config`（插件页里该插件的详情行）。** 那是「已安装插件的配置」更贴切的
语义位置，且槽主已把 `form` 适配器直接作为 prop 传入，连 `configForms` 都不必注入。未采用的原因是该槽
按内部 `entryKey`（`rowConfigKey(pkg.name, row.rowId)`）过滤，匹配规则无法离线验证——选错 key 的表现
是组件被静默滤掉，与"从未注册"难以区分。`settings.plugins.tab` 已核对在 `dsh-web-app` 组合中加载且
未禁用。

**让 Node half 自建配置读写路由（自管配置文件）。** 不依赖宿主的设置服务，但要把持久化、校验、
并发写全部自己实现一遍，且与宿主「配置统一由 profile patch 持久化」的模型背道而驰。

**只修硬失败的前两处（`settingsScope` 与 `onJobDone`）而不动 `jobs.list`。** 激活能成功、宠物能出现，
但"工作中"姿势永不触发——这是静默的功能缺失，比激活失败更难被发现，不适合留在修复里。

## Consequences

- 在 DSH `0.2.1-alpha.1` 上：boot 无 `did not activate`；`/whale-girl/state`、`/config` 正常；
  经 profile patch 注入 `config: { size: 130, opacity: 0.8 }` 后 `/config` 如实回读
  （`revision` 递增），volatile Config 通路打通。
- 设置入口变为「设置 → 内置插件 → 鲸鱼娘」；配置写入经宿主 settings 服务持久化到当前 profile 的
  Cordis patch，`<dshHome>/settings.yaml` 不再是权威来源（该文件由宿主在启动时一次性导入）。
- 卡片改为复用宿主配置控制器后，字段级校验与 revision 冲突处理由宿主负责，插件不再自建写面。
- 已知限制 1：设置卡的**浏览器内视觉呈现未经真机验证**。本地隔离单元测试（mock ctx 走
  `registerWhaleSettingsCard`，20 项断言）覆盖注册接线、props 契约、"编辑 → 保存"数据通路与只读/不可用
  降级；未覆盖样式与交互外观。注册位于 try/catch 内，最坏表现是无卡片。
- 已知限制 2：`lib/src/config.mjs` 的 `NAMESPACE` 常量在 Node half 不再被消费（表单键改为 profile
  条目 id），暂时保留以维持 client 侧命名空间标识。
- 已知限制 3：本改动以 `0.2.1-alpha.1` 实测为准；未在 0.1.x 宿主上复验，`.volatile()` 要求
  `@deepseek-ai/schemastery` 提供该扩展。
