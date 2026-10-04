# Decision: 设置卡的控件换用官方 primitives

Status: implemented

## Problem

设置卡的自绘控件违反 `@deepseek-ai/dsh-client-ui-primitives` 的约定（其 README：*What is not fine is
copying a control that already exists here*），而该库**确实提供** `Switch`、`Input`、`Button`。自绘开关
只写 `borderRadius: 999`、没有官方用来退出主题层全局超椭圆的 `corner-shape: round`，圆滑块被渲染成
圆角方块；数字输入与脚注按钮同样是与官方件重复的第二实现。

## Decision

- **开关换用官方 `Switch`**。其 props（`checked`/`disabled`/`label`/`onChange`）与原自绘版逐一同名，
  调用点无需改动；`corner-shape: round` 由库负责，方形滑块问题从根上消失。
- **数字输入换用官方 `Input`**（其 `style` 转发给内层 `input`，故宽度与右对齐在调用侧指定，
  范围校验仍由本组件的失焦提交负责）。
- **字段行与文案池按官方输入框规范重排**：字段行分隔线统一 `0.5px solid var(--dsw-alias-border-l2)`；
  文案池 textarea 改 `0.5px border-l4` / `--dsw-radius-md` / `bg-layer-1` / 14px。卡片 chrome
  （图标、标题、描述、行清单）由 whale-girl 包页画，本组件只填字段区——槽位归
  [bug-fix/2026-10-04-settings-card-bundle-slot.md](../bug-fix/2026-10-04-settings-card-bundle-slot.md)。
- **保留两处自绘，并在文件头注释里写明理由**：字段行布局（官方自身也在功能包内自绘行——
  `ui-theme` 的 `FontSizeRow` 即先例，控件仍取官方件）与多行文案池（库内无「Enter 换行」语义的
  多行控件；`InlineEditor` 是 Enter 提交，与逐行编辑冲突）。
- **脚注按钮与暂存模型已不在当前形态里**：本记录最初把保存/放弃两颗自绘按钮换成官方 `Button`，
  同批的 [simplification/2026-10-04-settings-card-direct-write.md](./2026-10-04-settings-card-direct-write.md)
  随后把这两颗按钮与整套暂存模型整体删除（改动即时写入），当前卡片没有脚注按钮。
- 构建脚本为 `@deepseek-ai/dsh-client-ui-primitives` 增加 `--external`——该模块与 react 一样由
  平台种子表提供，不打进 bundle。

## 取代检查

部分取代 [feature/2026-08-31-settings-panel-card.md](../feature/2026-08-31-settings-panel-card.md)
的自绘控件实现（自绘开关/数字输入 → 官方 primitives；该记录已就地标注）。写语义归
[simplification/2026-10-04-settings-card-direct-write.md](./2026-10-04-settings-card-direct-write.md)，
卡片槽位归 [bug-fix/2026-10-04-settings-card-bundle-slot.md](../bug-fix/2026-10-04-settings-card-bundle-slot.md)。

## Alternatives considered

**只给自绘开关补 `corner-shape: round` 与官方几何参数。** 改动最小、当场修好观感，但自绘开关本身
仍违反「不得复制库内已有控件」的约定，下次主题层变动又会漂移；数字输入、按钮的同类偏差也仍在。

**整套换成 `SettingsForm` + `SettingsValueField` + `SettingsFormModel`（官方设置页的完整套件）。**
这些正是官方 `ui-settings-shell`/`-agent-loop`/`-web-search`/`-subagent` 的用法，也能白拿
「已覆盖 / 恢复默认」的官方能力。未采用的原因是它带来两处**行为**变化，超出了「迁移设计风格」的
范围：其一是字段行布局由「标签在左、控件在右」变为「标签在上、输入框在下」（`SettingsValueField`
的固定形态），而本卡片的行布局取自通用设置页；其二是 `SettingsForm` 只在**卸载时**丢弃草稿，
会引入与最终选定的「即时写入」相反的保存语义。

**把文案池也换成官方 `InlineEditor`。** 用官方控件换掉自绘 textarea，但 `InlineEditor` 的 Enter
语义是「提交」、Shift+Enter 才是换行，与「每行一条文案」的编辑手势直接冲突。

## Consequences

- 观感回到 DSH 体系内：开关为胶囊 + 正圆，输入框、分隔线与字号均取自官方控件与 token；
  此后主题层调整圆角标度时，本卡片自动跟随。
- 客户端产物新增一个运行时模块依赖（`require("@deepseek-ai/dsh-client-ui-primitives")`）。该路径已有
  先例：官方各设置页与第三方插件均如此引用。
- 控件选型本身不改数据通路；数据通路的改动（删暂存、即时写入）在同批的 direct-write 记录里，
  当前仓库 155 项测试、15 门禁（CI 组）通过，`build-client --check` 产物新鲜。
- 真机验证（dsh 0.2.0-rc.2 + 隔离实例 + headless Chrome）：卡片在 whale-girl 包页渲染出 7 个字段、
  开关为圆头胶囊、写入落库且可反复修改。