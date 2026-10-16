# 版本与更新行（唯一权威）

本文是配置卡片首行**版本与更新行**的权威现状文档：端点与载荷、更新目标怎么定、点更新会发生什么、安全边界、宿主版本要求。README 与决策记录只链接本文件，不重复事实。实现见 [lib/src/update-host.mjs](../lib/src/update-host.mjs)（宿主侧：来源 / 锁文件 / 上游 / 重装）、[lib/src/update.mjs](../lib/src/update.mjs)（spec 归一、锁文件读值、版本比较、三态判断）、[lib/client/update-state.mjs](../lib/client/update-state.mjs)（呈现状态机，纯函数）；决策与备选方案见 [feature/2026-10-05-plugin-update-row.md](../decisions/implemented/feature/2026-10-05-plugin-update-row.md)、[bug-fix/2026-10-16-host-outdated-shape-probe.md](../decisions/implemented/bug-fix/2026-10-16-host-outdated-shape-probe.md)。

## 端点

| 端点 | 语义 |
|---|---|
| `GET /whale-girl/update` | 查一次上游：当前身份 + 上游最新 + 结论。卡片挂载时自动查一次并缓存在组件状态，「检查更新…」再查一次。 |
| `POST /whale-girl/update` | 执行更新（两步重装，见下）。无请求体。 |

两个端点都挡跨源：`sec-fetch-site` / `origin` 与 host 不匹配即 403。GET 同样要出网（GitHub / npm），别的页面不该借这台宿主刷上游配额；POST 靠同一条校验挡住 CSRF 写动作。

## GET 载荷

```json
{
  "current": { "version": "0.2.0", "source": "github:vlln/whale-girl#main", "commit": "deba316" },
  "latest": { "sha": "9c32d7a39a…", "commit": "9c32d7a", "ref": "main", "repo": { "owner": "vlln", "repo": "whale-girl" } },
  "state": "update-available",
  "canUpdate": true,
  "reason": "rate-limited",
  "detail": "HTTP 403"
}
```

客户端只读这些字段；其余（若有）不作为契约。

- `current.version`：优先宿主 `listBundles()` 的 `BundleInfo.version`，回退 profile 锁文件解析（registry 安装记的版本），再回退包清单版本。
- `current.commit`：已安装短提交，**只有 profile 锁文件知道**——git 安装下包的 `package.json` 版本号不随提交变化，宿主也不提供提交；宿主包页的「来源信息」只显示版本号，所以这一行是「我装的是哪个提交」的唯一出处。
- `current.source`：profile 记录的安装来源 spec；宿主不给该字段时缺席。
- `latest`：git 安装给 `{ sha, commit }`，registry 安装给 `{ version }`，本地路径安装另给 `ref`（跟的默认分支）与 `repo`；查不到上游时缺席。
- `state`：`up-to-date` / `update-available` / `unknown`。三态判断（`decideUpdate`）：git 按提交互含前缀，registry 按最小 semver 形状比较（数字段 + 预发布段），任一侧身份缺失即 `unknown`（不猜）。
- `canUpdate`：`state === 'update-available'` **且**宿主提供 `installBundle`。有新版但宿主不能更新时，按钮停在禁用的更新动作上，原因由状态行说清。
- `reason`：仅 `state: 'unknown'` 时给出——`no-source`（宿主没记录来源，或 spec 认不出）/ `host-outdated`（宿主太旧，见下）/ `local-source`（本地安装但读不到检出提交、包没声明仓库、或拿不到默认分支名）/ `rate-limited`（上游 403/429）/ `check-failed`（其它查询失败）。
- `detail`：查询抛错时的原始错误串（限流与失败都带）。

## 更新目标只认 profile 记录的那条 spec

`listBundles().source` 是安装事实；包清单里的 `repository` 只是发布元信息。不用它兜底，否则会把用户记的分支/标签换成另一条 spec，甚至把「安装自带的组合包」（它没有 profile 依赖）变成一条 profile 依赖。

唯一例外是**本地路径安装**（`dsh plugin add <目录>`）：profile 里没有上游可跟，所以退回包清单声明的 `repository`，查它的默认分支（通常是 `main`），拿本地检出的提交与上游比。检出不是 git 仓库、包没声明仓库、或拿不到默认分支名时报 `local-source`——**不猜分支名**，猜错会把用户的依赖指到别的线上。

`.git` 布局解析认 worktree：`.git` 是文件时顺着 `gitdir:` 找到真实 git 目录，再按 `commondir` 到公共目录里找分支引用与 `packed-refs`（worktree 的引用不在自己的目录里）。

profile 目录按三级解析：`profileContext.dir`（宿主服务）→ `DSH_PROFILE_DIR` → `<dshHome>/profiles/<DSH_PROFILE>`；三级都拿不到时不猜，按「未知」呈现。锁文件读不到就等于读不到已安装提交，不会挂着一个错误的判断。

## POST：两步重装

宿主用「`package.json` 里的依赖串变了没有」定位这次装的是哪个包，所以原样重装 profile 记的那条 spec 会被判 `ambiguous-install`（真实 `dsh web` 宿主实测）。因此：

1. 先装刚检查到的**确切提交/版本**（依赖串一定变，宿主认得出目标）；
2. 再把依赖串换回 profile 记录的那条**会前进的线**（分支/标签/默认分支），更新一次仍然继续跟踪。

registry 安装记的是版本范围（pnpm 默认存 `^` 前缀），本来就会前进，不需要第二步。把 spec 钉死在检查到的提交上会让这一行从此永远报「已是最新」，所以第二步是契约的一部分，不是优化。

**载荷契约**（客户端只读这些）：`state`、`errorCode`、`errorDetail`、`commit`、`pinnedSpec`；`application`/`spec`/`version` 留给宿主侧排查。

- `state`：`restart-required`（覆盖已装包，重启 DSH 生效）/ `installed`（宿主有 HMR，热发布）/ `overridden`（被更高优先级配置覆盖，重启也解决不了）/ `unsupported`（宿主不提供包管理服务）/ `up-to-date`（复查发现已最新）/ `check-failed`（复查没结论：限流或网络——说成「检查失败」，不是「更新失败」）/ `failed`。
- 宿主的 `ChangeResult.application` 五值如实转述：`applied` → `installed`，`restart-required`/`overridden` 原样，`failed`/`cancelled` 与任何未知取值 → `failed`。**不认识的结果不得当成功报给用户。**
- `errorCode: 'tracking-not-restored'`：第二步失败，profile 此时停在第一步钉死的那条 spec 上——不是「什么都没发生」。载荷带 `pinnedSpec`，界面把它说出来（宿主第一步的错误码并进 `errorDetail`）。宿主在两步之间真抛（锁超时 / dispose）是同一种后果。
- `errorCode: 'unknown-enabled-state'`：读不到组合包当前启停状态就**不动手**——宿主对没传 `enabled` 的安装默认启用，动手会把用户关掉的宠物打开；此时一次 pnpm 都不跑。
- `errorCode: 'unsupported-source'`：`state` 说有新版但目标里没有可装标识（防御性分支）。
- 宿主自己的错误码（如 `ambiguous-install`）不逐条翻译，原样带进文案。

**更新不碰用户设置**：一次更新只写 profile 的 `package.json` 依赖与 `pnpm-lock.yaml`（宿主 `plugin-manager` 的 `RESTORED_FILES` 就这两个，失败时也只回滚这两个）；条目的 `config:`（尺寸、透明度、回话文案、窗口时长……）与 patch 里其它条目一概不碰；传给 `installBundle` 的选项只有 `enabled`（原样保留启停）与 `requestId`，不带 `approvedBuilds`/`registry` 之类会改写 profile 的东西。插件自己不碰 profile 文件——写锁、manifest 缓存、HMR 队列与失败回滚都归宿主的包管理服务。

## 本地路径安装点更新的后果

一步把 profile 依赖从 `link:<目录>` 换成 `github:<owner>/<repo>#<默认分支>`：**本地改动不再生效**，换成了跟上游那条线（「本地安装也跟 main」）。状态行与按钮都要在点之前写出来（「更新会改成跟 <ref>」/「改跟 <ref>…」），不能等点完才说。

## 宿主版本要求

检查/更新要读宿主的 `BundleInfo.source`（profile 记录的安装来源），该字段是 `dsh-plugin-manager` 后来才加的（0.2.0-rc.2 还没有）。没有 `source` 时报 `host-outdated`（「宿主版本过旧，无法检查更新（请升级 DSH）」）还是 `no-source`（「查不到上游」），取决于 `BundleInfo` 的**年代形状**：判据只认 0.2.1-alpha.2 起恒有的 `official` / `availability`，**不得用 `version`**——0.2.0-rc.2 已经填 `version`，用它判年代会把旧宿主误读成真·无上游，丢掉「升级宿主就能用」这条可行动信息。环境事实与判据见 [bug-fix/2026-10-16-host-outdated-shape-probe.md](../decisions/implemented/bug-fix/2026-10-16-host-outdated-shape-probe.md)。

配置只读（卡片显示「当前部署只读，无法修改。」）不影响这一行：那说的是条目配置的写面，而更新走宿主的 profile 包管理服务，宿主的插件页在同一个部署里同样提供安装/卸载。两者权限不同，所以这一行不跟着卡片的 `disabled` 走。

## 呈现契约

- **按钮只摆动作、不摆结论**：没有「已是最新」「重启后生效」这类禁用标签——结论由状态行说。已是最新、刚更新完、检查失败都留一个可点的「检查更新…」（macOS 约定：动词 + 省略号表示有一段进行中的操作）；检查中「检查中…」并禁用，更新中「更新中…」并禁用。
- **按钮文案里的目标原样显示**：git 安装是短提交、registry 安装是版本号，不额外加 `v`；本地安装用「改跟 `<ref>`…」。
- 呈现由纯函数挑处理函数（`action.run` 指向检查或更新），组件只调 `action.run()`，不在组件里再判一次状态；交互阶段由 `reduceRow` 状态机推进（`check-started` / `checked` / `check-failed` / `update-started` / `settled`），组件只派发事件。
- 提示色跟结果走：成功不用报错红；检查没结论（限流/网络）也不用报错红。失败文案用 `--dsw-alias-state-error-primary`（`--dsw-alias-label-error` 在主题里并不存在）；行本身用 `role="group"` + `aria-labelledby`/`aria-describedby` 把标签与状态关联起来。
- 文案键归 [lib/client/settings-card.mjs](../lib/client/settings-card.mjs)（宿主 locale 的两套字面量），分隔符也走文案表，免得英文界面里冒出全角标点。

## 验证归属

| 面 | 跑什么 |
|---|---|
| 状态机、`.git` 布局解析、各失败分支（worktree / packed-refs / 游离 HEAD / 限流 / 第二步失败） | `node --test tests/update-host.test.mjs`（真实临时目录 + 注入的假依赖） |
| 纯逻辑（spec 归一、锁文件读值、版本比较、三态判断） | `node --test tests/update.test.mjs` |
| 呈现状态机与文案接线 | `node --test tests/update-state.test.mjs` |
| HTTP 层与端到端接线（跨源、方法/缓存头、载荷形状、两步重装、启停保留） | `node --test tests/update-route.test.mjs` |
| 真点一下（按钮接线错位只有真点才暴露） | `node scripts/verify-client-behavior.mjs <web-url> update-row`（需要部署里确实有新版可更新） |
