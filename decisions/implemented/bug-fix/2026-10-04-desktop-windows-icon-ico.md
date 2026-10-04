# Decision: 桌面壳随包提供 Windows 必需的 icons/icon.ico

Status: implemented

## Problem

issue #17：Windows 11 + Rust stable-msvc 下，`npm install -g whale-girl-desktop` 后进
`$(npm root -g)/whale-girl-desktop/src-tauri` 跑 `cargo build --release` 失败：

```
icons/icon.ico not found; required for generating a Windows Resource file during tauri-build
```

tauri-build 在 Windows 上无条件要求 `src-tauri/icons/icon.ico` 来生成资源文件，而仓库此前只随包
发 `icons/icon.png`（512×512 设计源）——开发机是 macOS，`cargo build` 不走 ico 这条路径，所以这个
失败只在 Windows 上暴露（**环境事实**，首次复现即沉淀）。同时 `tauri.conf.json` 没有 `bundle.icon`，
Tauri 会退回默认图标列表（`icons/32x32.png`、`icons/128x128.png`、`icons/128x128@2x.png`、
`icons/icon.icns`、`icons/icon.ico`）——其中四项仓库并不存在，等于把同一个失败换成另一个。

## Decision

- 随包提供 `desktop/src-tauri/icons/icon.ico`（16/24/32/48/64/128/256 七档；≤128 用 BMP 编码、
  256 用 PNG，与官方 `tauri icon` 的产物一致——BMP 兼容旧工具与资源编译器，256 用 PNG 控体积）。
- 生成器入库为 `desktop/scripts/make-icons.py`（Pillow），从既有 `icon.png` 重新生成；产物入库
  （`desktop/.gitignore` 不排除 `icons/`），不手改产物。脚本同时产出 Tauri 默认列表引用的标准尺寸
  PNG：`32x32.png`、`128x128.png`、`128x128@2x.png`。
- `tauri.conf.json` 的 `bundle.icon` 显式声明仓库真正存在的四项
  （`icons/32x32.png`、`icons/128x128.png`、`icons/128x128@2x.png`、`icons/icon.ico`），不再依赖
  默认列表；`icon.png` 保留为设计源，不进列表。
- 未生成 `icon.icns`：macOS 打包（`bundle.active`）当前为关闭，启用时再补。

## 取代检查

无重叠——本记录只覆盖「桌面壳的图标资源与 Windows 资源文件要求」。桌面壳选型、渲染契约与
Electron 遗留路径归 [feature/2026-08-16-desktop-companion.md](../feature/2026-08-16-desktop-companion.md)
与 [feature/2026-08-17-tauri-render-shell.md](../feature/2026-08-17-tauri-render-shell.md)；随包文件的
构建/安装说明归 [desktop/BUILD-RUN.md](../../../desktop/BUILD-RUN.md)。

## Alternatives considered

**A：只在文档里让用户自己跑 `npx tauri icon`。** 需要网络、Tauri CLI 与 Rust 工具链，新机器 clone
下来仍然缺文件——把失败从仓库转移给用户，弃。

**B：只补 `icon.ico`，不动 `tauri.conf.json`。** 默认列表仍引用 `icons/icon.icns` 等不存在的文件，
同一个坑换个触发条件；故显式声明存在的四项，弃。

**C：改 `bundle.active` 或改 tauri-build 配置绕开图标要求。** `cargo build`（非 bundling）在 Windows
上照样要资源文件，绕不开；改动打包开关还会把无关行为一起改掉，弃。

**D：ico 全部用 PNG 编码（体积最小，109KB）。** PNG 条目在 Vista+ 可用，但小尺寸用 BMP 才是各工具
与资源编译器普遍预期的形态；混合编码只多约 60KB，弃。

## Consequences

- Windows 上 `cargo build --release` 不再因缺 ico 失败；`bundle.icon` 与实际文件一一对应。
- 图标产物是生成物：改图标要改 `icon.png`（设计源）后重跑 `python3 desktop/scripts/make-icons.py`，
  需要环境里有 Pillow（生成器会给出可读报错）。
- 多出约 170KB 的 `icon.ico` 与三张标准尺寸 PNG（合计约 96KB）随 npm 包发布（`files` 已含
  `src-tauri`），未改变运行时代码与网页端行为。