# Decision: enabled=false 只停宠物，不拆配置卡片

Status: implemented

## Problem

「网页端显示」开关（`enabled`）的语义是停掉网页端的宠物渲染（桌面伴侣并存时用）。实现上
`enabled === false` 走的是整插件 teardown：`applyClientConfig` 与 `boot()` 都调 `dispose()`，
而 `dispose()` 里连同 `offSettings()` 一起执行——设置卡片注册与 locale 命名空间随之注销。

后果（真机实测）：在卡片的保存动作里把 `enabled` 写成 false 之后，承载该开关的卡片立即从
Plugins 页消失（官方组 9→8），刷新页面也回不来（`boot()` 每次加载都按持久化的 false 走同一条
teardown），使用者再也没有 UI 入口把它打开。设置命名空间本身一直被宿主正常服务
（`settings.describe()` 的四个门槛条件——schema / `fiber.runtime` / `fiber.state` / volatileForm
——写后 15 秒内全部成立），所以这不是设置面、槽位或宿主的问题。

## Decision

- 拆出 `disposePet()`：只停宠物本体（轮询/动画计时器、SSE、DOM 节点、指针与窗口监听器），
  **不碰设置卡片注册与 locale 命名空间**。
- `dispose()` = `disposePet()` + `offSettings()`，只用于插件整体卸载（client 条目卸载 / HMR 重建）。
- `enabled === false` 的两条路径（`applyClientConfig` 热切换、`boot()` 挂载时读 `/config`）
  改调 `disposePet()`。
- 保留的契约：重新启用仍需刷新页面（`disposePet()` 停掉 `/state` 轮询，客户端没有重建路径）；
  但卡片与本地化文案始终在，开关可反复改。

## 取代检查

无重叠——本记录只覆盖「`enabled=false` 的 teardown 边界」。卡片渲染在哪一页归
[bug-fix/2026-10-04-settings-card-bundle-slot.md](./2026-10-04-settings-card-bundle-slot.md)；
配置命名空间注册/读值与写面信任边界归
[feature/2026-08-09-config-system.md](../feature/2026-08-09-config-system.md)。

## Alternatives considered

**A：保留整插件 teardown，只把卡片注册挪到别处。** 卡片与 `dispose()` 同属一个 client 条目，
teardown 一样会拆它；换槽位不解决「控制自己删掉自己」，弃。

**B：`enabled=false` 只隐藏宠物 DOM，保留全部运行时（轮询/SSE/事件订阅）。** 省掉「重新启用需
刷新」的限制，但违背该开关「桌面伴侣并存时不跑网页端」的初衷（后台轮询与事件订阅仍在跑），弃。

## Consequences

- `enabled=false` 可逆：宠物按设计停，配置卡片与本地化文案仍在包页；改回 `enabled=true` +
  刷新即恢复（真机验证：写 false → 卡片在、宠物停；reload 卡片仍在；写回 true + reload 宠物回来）。
- 新增一条纪律：凡「停用本插件某个表面」的 teardown，不得连带注销本插件的配置入口，否则停用
  不可逆、使用者失去恢复手段。