// 浮层定位（纯计算，零 DOM）：把挂在角色上的浮层——互动菜单、悬停状态卡、回话气泡——
// 收敛进视口，避免角色贴视口边缘时浮层有一半落在视口外（等于被裁）。
//
// 契约（入参全为数值，出参为可直接写入内联样式的字符串）：
// - 纵向：优先请求的朝向；该侧空间不足且另一侧更宽裕时翻面。可用空间扣掉 `offsetY`（角色与
//   浮层之间的间隙）与 `margin`，因为浮层实际占用 `offsetY + size.h`。`offsetY` 缺省按 0 处理。
// - 横向：浮层以角色中心居中；居中会越出视口时按实测宽度反向平移；比视口还宽时以视口居中为准。
// - left 用 `calc(50% ± Npx)` 表达位移，而不用 transform——气泡入场动画的关键帧占用了 transform。
//
// 归属测试：tests/overlay-placement.test.mjs（几何符号错误在浏览器里极难发现，这里用数值断言守住）。
export function planOverlay({ rect, viewport, size, above, offsetY = 0, margin = 8 }) {
  // 浮层实际占 rect.top - offsetY - size.h … rect.top - offsetY（上方）或
  // rect.bottom + offsetY … rect.bottom + offsetY + size.h（下方），所以两侧可用空间都要扣掉 offsetY：
  // 只比 size.h 会让「代码认为放得下、实际溢出 offsetY - margin」的窄带漏翻面（issue 实测 5px 裁切）。
  const roomAbove = rect.top - margin - offsetY
  const roomBelow = viewport.h - rect.bottom - margin - offsetY
  // 纵向：请求的朝向放不下、且另一侧更宽裕 → 翻面（两侧都不足时取宽裕的一侧）。
  let up = above
  if (above && roomAbove < size.h && roomBelow > roomAbove) up = false
  else if (!above && roomBelow < size.h && roomAbove > roomBelow) up = true
  // 横向：居中位置 = 角色中心 ± 半宽；越界则平移回视口内（左右各留 margin）。
  const centerX = rect.left + rect.width / 2
  let dx = 0
  if (size.w >= viewport.w - margin * 2) dx = viewport.w / 2 - centerX // 比视口还宽：以视口居中
  else if (centerX - size.w / 2 < margin) dx = margin - centerX + size.w / 2
  else if (centerX + size.w / 2 > viewport.w - margin) dx = viewport.w - margin - centerX - size.w / 2
  const shift = Math.round(dx)
  return {
    up,
    top: up ? `-${offsetY}px` : `calc(100% + ${offsetY}px)`,
    transform: up ? 'translate(-50%, -100%)' : 'translateX(-50%)',
    left: shift === 0 ? '50%' : `calc(50% ${shift > 0 ? '+' : '-'} ${Math.abs(shift)}px)`,
  }
}
