#!/usr/bin/env python3
"""生成桌面壳的图标资源（Windows 必需的 icons/icon.ico + Tauri 默认列表引用的标准尺寸）。

契约：
- 源是 `src-tauri/icons/icon.png`（正方形，≥256；当前 512×512）。产物一律由本脚本生成，不手改。
- 产物：`icon.ico`（16/24/32/48/64/128/256 多尺寸）、`32x32.png`、`128x128.png`、`128x128@2x.png`。
- ICO 编码与官方 `tauri icon` 一致：≤128 用 BMP（兼容旧工具与资源编译器），256 用 PNG（体积）。
- `tauri.conf.json` 的 `bundle.icon` 显式声明这些产物；Windows 上 tauri-build 生成资源文件时
  无条件要求 `icon.ico`，缺失即构建失败（见 decisions/implemented/bug-fix/2026-10-04-desktop-windows-icon-ico.md）。

用法（在仓库根或 desktop/ 下均可）：
    python3 desktop/scripts/make-icons.py
依赖：Pillow（`pip install pillow`）。
"""
from pathlib import Path
import io
import struct
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境缺失时的可读报错
    sys.exit("需要 Pillow：pip install pillow")

ICON_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SOURCE = ICON_DIR / "icon.png"
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_ENTRY_MIN = 256  # 该尺寸及以上用 PNG 编码，其余用 BMP（与 tauri icon 一致）
PNG_SIZES = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256}


def _entry_blob(img: Image.Image, size: int) -> tuple[int, bytes]:
    """把一个尺寸编码成单条目 ICO，取出其 (bpp, 载荷)。"""
    bitmap_format = "png" if size >= PNG_ENTRY_MIN else "bmp"
    buf = io.BytesIO()
    img.save(buf, format="ICO", sizes=[(size, size)], bitmap_format=bitmap_format)
    data = buf.getvalue()
    bpp = struct.unpack("<H", data[12:14])[0]
    length, offset = struct.unpack("<II", data[14:22])  # 目录项：size 在 14，imageOffset 在 18
    return bpp, data[offset:offset + length]


def build_ico(src: Image.Image, sizes: list[int]) -> bytes:
    entries = [(size, *_entry_blob(src.resize((size, size), Image.LANCZOS), size)) for size in sizes]
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b""
    payload = b""
    for size, bpp, blob in entries:
        dim = 0 if size == 256 else size  # ICO 目录里 256 记作 0
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, bpp, len(blob), offset + len(payload))
        payload += blob
    return header + directory + payload


def main() -> int:
    if not SOURCE.is_file():
        sys.exit(f"缺少源图：{SOURCE}")
    src = Image.open(SOURCE).convert("RGBA")
    if src.width != src.height:
        sys.exit(f"源图必须是正方形：{SOURCE} 是 {src.width}×{src.height}")
    if src.width < max(ICO_SIZES):
        sys.exit(f"源图至少 {max(ICO_SIZES)}px：{SOURCE} 是 {src.width}px")

    ico = build_ico(src, ICO_SIZES)
    (ICON_DIR / "icon.ico").write_bytes(ico)
    print(f"icon.ico  {ICO_SIZES}  {len(ico)} bytes")
    for name, size in PNG_SIZES.items():
        src.resize((size, size), Image.LANCZOS).save(ICON_DIR / name, format="PNG")
        print(f"{name}  {size}×{size}")
    print(f"源图 {SOURCE.name} 保留为 {src.width}×{src.height} 设计源（不覆盖）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())