// 设置卡片表单语义（纯逻辑，零 React、零宿主依赖，可单测）。
// 契约：对齐官方 CardForm / SettingsFormModel 语义——edit 暂存（draft 整体替换使引用失效）→
// save 一次性提交（单次 revision-fenced 文档变更）→ 提交后按宿主接受值重读逐字段确认
// （失败置 failed）；discard 丢弃暂存。
// 写路径用完整叶路径（path.split('.')）：官方 ConfigForm 的 mutate 接受任意深度的
// ops，`set` 只达单段——嵌套字段（walk.enabled / replies.feed）不必再整组合并写。
// revision 在首次暂存时取（CAS 基线：暂存期间的他人写入 → 保存被拒 → failed），
// save/discard 后清空。
// 快照必须引用稳定：内容未变时返回同一对象（React .useWhaleSettings 走
// useSyncExternalStore，否则无限重渲——React #185 血泪）。
// 默认值不在此写第二份——由 index.mjs 传入 CFG_DEFAULTS（verify-config-sync 门禁
// 保证其与 src/config.mjs DEFAULTS 一致）。

/** 卡片字段表（path = 设置叶路径，即写入的 mutate 路径；labelKey = locale 文案键）。
 * min/max/step 与 src/config.mjs buildSchema 的 clamp 对齐（UI 边界，
 * 非默认值——默认值单一来源仍是 DEFAULTS/CFG_DEFAULTS）。 */
export const CARD_FIELDS = [
  { path: 'enabled', labelKey: 'enabled', kind: 'toggle' },
  { path: 'size', labelKey: 'size', kind: 'number', min: 64, max: 160, step: 1 },
  { path: 'opacity', labelKey: 'opacity', kind: 'number', min: 0.2, max: 1, step: 0.05 },
  { path: 'walk.enabled', labelKey: 'walk', kind: 'toggle' },
  { path: 'sleepAfterMs', labelKey: 'sleep', kind: 'number', min: 5000, max: 600000, step: 1000 },
  { path: 'replies.feed', labelKey: 'feed', kind: 'lines' },
  { path: 'replies.play', labelKey: 'play', kind: 'lines' },
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

/** 叶值等价（标量同值；数组/对象按 JSON 形状比——宿主往返后引用必然不同）。 */
export function sameLeaf(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
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
   * @param {object} scope 已绑定的设置命名空间 scope（configForms.get(namespace)，
   *   即官方 ConfigForm：getSnapshot/subscribe/set/unset/mutate）
   * @param {object} defaults 叶默认值兜底（index.mjs 传 CFG_DEFAULTS，单一来源）
   */
  constructor(scope, defaults) {
    this.scope = scope
    this.defaults = defaults
    /** @type {Record<string, unknown>} 逐字段暂存（path → 值）；每次变更整体替换。 */
    this.draft = {}
    this.saving = false
    this.failed = false
    /** 首次暂存时的 scope revision（CAS 基线；save/discard 后清空）。 */
    this.baselineRevision = undefined
    this.listeners = new Set()
    this.cache = undefined
    // 宿主侧变更（其他客户端写入、连接重置重读）也驱动卡片重渲。
    this.offScope = this.scope.subscribe(() => this.emit())
  }

  /** 退订 scope（注册方 dispose 时调用；幂等）。 */
  dispose = () => {
    if (this.offScope === undefined) return
    this.offScope()
    this.offScope = undefined
    this.listeners.clear()
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

  /** 暂存一次编辑（按叶路径；首次暂存记 CAS 基线 revision）。 */
  edit = (path, value) => {
    if (this.baselineRevision === undefined) this.baselineRevision = this.scope.getSnapshot().revision
    this.draft = { ...this.draft, [path]: value }
    this.failed = false
    this.emit()
  }

  /** 丢弃全部暂存。 */
  discard = () => {
    if (Object.keys(this.draft).length === 0) return
    this.draft = {}
    this.baselineRevision = undefined
    this.failed = false
    this.emit()
  }

  /** 提交全部暂存（一次 revision-fenced mutate），随后按宿主接受值重读确认。 */
  save = async () => {
    const staged = Object.entries(this.draft)
    if (staged.length === 0 || this.saving) return
    this.saving = true
    this.emit()
    let failed = false
    try {
      const ops = staged.map(([path, value]) => ({ op: 'set', path: path.split('.'), value }))
      const accepted = await this.scope.mutate(ops, this.baselineRevision)
      if (accepted !== true) failed = true
    } catch {
      // 传输失败：controller 已做恢复重读，下面按快照逐字段判定。
      failed = true
    }
    if (!failed) {
      const committed = this.scope.getSnapshot().value ?? {}
      for (const [path, value] of staged) {
        if (!sameLeaf(leafOf(committed, path), value)) failed = true
      }
    }
    this.saving = false
    this.draft = {}
    this.baselineRevision = undefined
    this.failed = failed
    this.emit()
  }
}
