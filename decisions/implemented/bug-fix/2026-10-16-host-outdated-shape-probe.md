# Decision: host-outdated 的宿主年代判据只认 0.2.1-alpha.2 独有字段

Status: implemented

## Problem

更新行在「宿主太旧、给不出安装来源」时必须说「宿主版本过旧，无法检查更新（请升级 DSH）」，而不是笼统的「查不到上游」：前者可行动（升级宿主即可用），后者会让用户以为这个包本来就没有上游可跟。

区分两者需要一个**宿主年代判据**。第一版用「`BundleInfo` 既没有 `source` 也没有 `version`」当旧宿主特征，前提是「0.2.0-rc.2 时代的 `BundleInfo` 两个字段都没有」。**该前提与真实宿主不符（环境事实）**：`latest` 通道的 0.2.0-rc.2 里，`dsh-plugin-manager` 的 `listBundles()` 已经填 `version`（实现是 `...info.version === void 0 ? {} : { version: info.version }`，类型声明里也早有 `version?: string`），只是没有 `source`。于是 rc.2 上这一行从「请升级 DSH」退化成「查不到上游」——判据把旧宿主认成了新宿主，正好丢掉它要保住的那条可行动信息。

单测没拦住它，因为夹具按同一个错前提造：「旧宿主」被造成 `source`/`version` 全缺，而真实 rc.2 是「有 `version`、缺 `source`」。缺陷与用例共享一个错误假设时，用例只会把假设钉死。

## Decision

**年代判据改用 0.2.1-alpha.2 起 `BundleInfo` 恒有的字段**：`official`（boolean，非官方包也恒给 `false`）与 `availability`（`'installation' | 'profile' | 'missing'`）。任一存在即视为新形状（`modernBundle`），据此三分：

- `source` 缺失 + **旧形状** + 宿主可安装 + 包被列出 → `host-outdated`（引导升级宿主）；
- `source` 缺失 + **新形状** → `no-source`（宿主并不旧，是真·没有可跟的来源：安装自带条目，或包清单读不到而带 `error`）；
- `version` 只作**已装版本的显示来源**（优先于锁文件解析与自身清单），不参与年代判定。

夹具按**年代形状整套给字段**（`tests/update-host.test.mjs` 的 `BUNDLE_SHAPES`：`legacy` = 有 `version`、无 `source`/`official`/`availability`；`modern` = `official`/`availability`/`version` 齐全，`source` 只在 profile 自有依赖时才有），`legacy` 形状断言 `host-outdated`——这条用例即本缺陷的回归防线。字段传 `null` 表示显式删除，用来造「新宿主但包清单读不到、连 `version` 都没有」这类真实组合。

## 取代检查

部分取代 [feature/2026-10-05-plugin-update-row.md](../feature/2026-10-05-plugin-update-row.md)：该记录「宿主版本要求」一节里 host-outdated 的字段判据由本记录接管；更新行其余语义（来源只认 profile spec、两步重装、限流与失败文案、本地安装跟默认分支）仍归它。两条保持活跃并互链。

## Alternatives considered

**继续用 `version` 的有无判年代（可再叠加别的条件）。** 就是出缺陷的那条路：`version` 不是 alpha.2 的新增字段，rc.2 已经在填，任何以它年代信号的组合都会在 `latest` 通道上误判。

**读宿主自身的运行时版本号来判年代。** 语义最直接，但 profile 安装的第三方插件没有稳定的宿主版本查询缝，且要额外引入一套版本比较契约；形状探测不需要任何新缝。

**去掉 host-outdated，统一报 no-source。** 少一个分支，但把「升级宿主就能用」这条可行动信息丢了——那正是本记录要保住的东西。

## Consequences

- rc.2（`latest` 通道）上这一行重新显示「宿主版本过旧，无法检查更新（请升级 DSH）」；alpha.2 上的安装自带条目与包清单读不到的情形显示「查不到上游」，不再误导用户升级宿主。
- 判据依赖「`official`/`availability` 在新宿主恒有」这一形状事实（本机实测 0.2.1-alpha.2 的 `listBundles()` 每条都带这两个字段）。若上游把它们改成可选，新旧宿主重新不可区分，届时需要新的年代信号。
- 双宿主实测载荷（同一个 `link:` 安装的合并检出，`GET /whale-girl/update`）：0.2.0-rc.2 → `{"current":{"version":"0.2.0"},"state":"unknown","canUpdate":false,"reason":"host-outdated"}`；0.2.1-alpha.2 → 带 `source`/`commit`、`state:"update-available"`。
- 方法论（本记录即沉淀点）：**判断某字段是否为宿主「新增」，必须以真实宿主的载荷为准，不能靠类型声明或版本直觉**；夹具要按年代整套建模——「缺哪些字段」本身就是被测行为的一部分。
