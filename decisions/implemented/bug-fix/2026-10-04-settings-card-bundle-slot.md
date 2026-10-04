# Decision: 配置卡片回到 plugins.bundle.config——不占官方插件语义位

Status: implemented

## Problem

卡片自 2026-10-03 起注册进 `plugins.item`（Plugins 页「官方」组）。该槽在官方契约里是
**安装自带官方设置页**的语义位：`dsh-client-ui-plugin-manager` 的 slot-contract 写明该槽被官方
设置页占用、自有 bundle 的配置应放 `plugins.bundle.config` 或 `plugins.row.config`。于是第三方
插件 whale-girl 的卡片被列进「官方」组、按官方插件展示（该页文案也是「配置官方插件」），
用户与维护者都会读错归属。

## Decision

- **注册槽改为 `plugins.bundle.config`**（keyed 槽，`key` = bundle 包名 = 设置命名空间
  `whale-girl`）：卡片渲染在 Plugins 页 whale-girl 包页的描述与行清单之间；页面只请求 `page`
  视图，chrome（图标/标题/描述）由包页画。
- **不再注册 `plugins.item`**：该槽留给安装自带的官方设置页；本地化词条随之删掉只作列表卡片
  标题用的 `title`。
- 其余契约不变：`configForms.get(namespace)` 传输面、`whileServed([namespace])` 注册门禁、
  locale 命名空间 `settings.whale-girl`、React 卡片与种子表 external。保存语义在本次整合时已改为
  即时写入，归
  [simplification/2026-10-04-settings-card-direct-write.md](../simplification/2026-10-04-settings-card-direct-write.md)。

## 取代检查

部分取代 [feature/2026-08-31-settings-panel-card.md](../feature/2026-08-31-settings-panel-card.md)
与其换代记录 [bug-fix/2026-10-03-dsh-0-2-alignment.md](../bug-fix/2026-10-03-dsh-0-2-alignment.md)
的**槽选择**：两记录主张的 `plugins.item`（「官方」组列表卡片）由本记录改回
`plugins.bundle.config`（包页配置区）。卡片范围（高频 7 字段）、locale 契约、`whileServed` 门禁、
`configForms` 传输面与写面信任边界不受影响；两记录已加回链。暂存/保存语义已由
[simplification/2026-10-04-settings-card-direct-write.md](../simplification/2026-10-04-settings-card-direct-write.md)
取代。

无重叠——settings 命名空间的注册/校验/热更新归
[feature/2026-08-09-config-system.md](../feature/2026-08-09-config-system.md)，不受本记录影响。

## Alternatives considered

**A：留在 `plugins.item`，只改图标/文案规避误读。** 槽的语义位仍被第三方占用——「官方」分组
标题、该页「配置官方插件」的文案、以及官方同族卡片的排序都不属于本插件，官方侧也可能随时收窄
该槽准入；发现性收益不抵语义错位，弃。

**B：`plugins.row.config`（按行配置）。** 该槽给 bundle 的单个行（`<包名>#<行 id>`）配置，会为行
加一个「配置」控件并把配置分片到行页；本插件只有一个条目级命名空间（settings 面按条目 id 服务），
没有多行配置的语义，弃。

## Consequences

- 归属正确：配置卡片出现在 whale-girl 包页；Plugins 页「官方」组只列安装自带的官方设置页。
- 代价：配置入口多一次点击（Plugins → Installed → whale-girl），README 双语与卡片注释同步说明。
- 已知边界：卡片仍只在宿主服务该设置命名空间时出现（`whileServed` 未触发 → 无配置区）。
  `enabled=false` 一度会连带注销卡片（控制自删、刷新也回不来），已由
  [bug-fix/2026-10-04-enabled-false-keeps-config-card.md](./2026-10-04-enabled-false-keeps-config-card.md) 修掉。