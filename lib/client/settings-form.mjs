// 设置卡片表单语义（纯逻辑，零 React、零宿主依赖，可单测）。
// 契约：对齐官方 CardForm 语义与参考实现 vlln/dsh-loop 的 LoopSettingsForm——
// edit 暂存（draft 整体替换使引用失效）→ save 一次性提交（revision-fenced 写）→
// 提交后按宿主接受值重读逐字段确认（失败置 failed）；discard 丢弃暂存。
// 快照必须引用稳定：内容未变时返回同一对象（React .useWhaleSettings 走
// useSyncExternalStore，否则无限重渲——React #185 血泪，见 plugin-registry
// make-dsh-plugin skill 的 settings-panel.md）。
// 嵌套组（walk/replies）写整个顶层键：官方 client settingsScope 只暴露单段路径
// set（如 'walk.enabled' 会字面落键），宿主 mutate 虽支持深路径但 client 面不达；
// 整组写天然幂等、无需 unset。默认值不在此写第二份——由 index.mjs 传入
// CFG_DEFAULTS（verify-config-sync 门禁保证其与 src/config.mjs DEFAULTS 一致）。

/** 卡片字段表（path = 设置叶路径；labelKey = locale 文案键；组字段 group = 写入的顶层键，
 * leaf 从 path 取）。min/max/step 与 src/config.mjs buildSchema 的 clamp 对齐（UI 边界，
 * 非默认值——默认值单一来源仍是 DEFAULTS/CFG_DEFAULTS）。 */
export const CARD_FIELDS = [
  { path: 'enabled', labelKey: 'enabled', kind: 'toggle' },
  { path: 'size', labelKey: 'size', kind: 'number', min: 64, max: 160, step: 1 },
  { path: 'opacity', labelKey: 'opacity', kind: 'number', min: 0.2, max: 1, step: 0.05 },
  { path: 'walk.enabled', labelKey: 'walk', kind: 'toggle', group: 'walk' },
  { path: 'sleepAfterMs', labelKey: 'sleep', kind: 'number', min: 5000, max: 600000, step: 1000 },
  { path: 'replies.feed', labelKey: 'feed', kind: 'lines', group: 'replies' },
  { path: 'replies.play', labelKey: 'play', kind: 'lines', group: 'replies' },
]

/** 按点分路径读叶值；路径段缺失返回 undefined。 */
export function leafOf(value, path) {
  let cur = value
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 组字段的写入值：基于已提交组对象合并叶（幂等，不丢组内其他叶）。 */
export function groupWrite(committed, path, value) {
  const group = path.slice(0, path.indexOf('.'))
  const leaf = path.slice(path.indexOf('.') + 1)
  const base = (() => {
    const cur = committed === null || typeof committed !== 'object' ? undefined : committed[group]
    return cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : {}
  })()
  return { key: group, value: { ...base, [leaf]: value } }
}

/** 文案池文本 ↔ 数组：按行拆分/trim/去空；行尾空行不产生空串。 */
export function parseLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function serializeLines(lines) {
  return (Array.isArray(lines) ? lines : []).join('\n')
}

/** 多字段暂存表单（语义对齐官方 CardForm；见文件头契约）。 */
export class WhaleSettingsForm {
  /**
   * @param {object} scope 设置命名空间控制器（0.2.x：ctx.configForms.get(条目 id)；
   *   快照 { status, value, writable, … } + subscribe/set 与本类接口一致）
   * @param {object} defaults 叶默认值兜底（index.mjs 传 CFG_DEFAULTS，单一来源）
   */
  constructor(scope, defaults) {
    this.scope = scope
    this.defaults = defaults
    /** @type {Record<string, unknown>} 逐字段暂存（path → 值）；每次变更整体替换。 */
    this.draft = {}
    this.saving = false
    this.failed = false
    this.listeners = new Set()
    this.cache = undefined
    // 宿主侧变更（其他客户端写入、连接重置重读）也驱动卡片重渲。
    this.scope.subscribe(() => this.emit())
  }

  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => {
    const snap = this.scope.getSnapshot()
    if (this.cache !== undefined
      && this.cache.snap === snap
      && this.cache.draft === this.draft
      && this.cache.saving === this.saving
      && this.cache.failed === this.failed) {
      return this.cache.state
    }
    const committed = snap.value ?? {}
    const fields = {}
    for (const def of CARD_FIELDS) {
      const staged = this.draft[def.path]
      if (staged !== undefined) {
        fields[def.path] = staged
        continue
      }
      const fromCommitted = leafOf(committed, def.path)
      fields[def.path] = fromCommitted !== undefined ? fromCommitted : leafOf(this.defaults, def.path)
    }
    const state = {
      available: snap.status !== 'unavailable',
      writable: snap.writable === true,
      dirty: Object.keys(this.draft).length > 0,
      saving: this.saving,
      failed: this.failed,
      fields,
    }
    this.cache = { snap, draft: this.draft, saving: this.saving, failed: this.failed, state }
    return state
  }

  emit() {
    for (const listener of this.listeners) listener()
  }

  /** 暂存一次编辑（按叶路径；组字段存叶值，save 时整组合并写）。 */
  edit = (path, value) => {
    this.draft = { ...this.draft, [path]: value }
    this.failed = false
    this.emit()
  }

  /** 丢弃全部暂存。 */
  discard = () => {
    if (Object.keys(this.draft).length === 0) return
    this.draft = {}
    this.failed = false
    this.emit()
  }

  /** 提交全部暂存（revision-fenced 写），随后按宿主接受值重读确认。 */
  save = async () => {
    const staged = Object.entries(this.draft)
    if (staged.length === 0 || this.saving) return
    this.saving = true
    this.emit()
    let failed = false
    try {
      const committedBase = this.scope.getSnapshot().value ?? {}
      for (const [path, value] of staged) {
        const def = CARD_FIELDS.find((candidate) => candidate.path === path)
        if (def !== undefined && def.group !== undefined) {
          const { key, value: next } = groupWrite(committedBase, path, value)
          await this.scope.set(key, next)
        } else {
          await this.scope.set(path, value)
        }
      }
    } catch {
      // 传输失败：controller 已做恢复重读，下面按快照逐字段判定。
    }
    const snap = this.scope.getSnapshot()
    const committed = snap.value ?? {}
    for (const [path, value] of staged) {
      if (leafOf(committed, path) !== value) failed = true
    }
    this.saving = false
    this.draft = {}
    this.failed = failed
    this.emit()
  }
}