// 设置卡片表单语义单测（node:test，零依赖）。归属：lib/client/settings-form.mjs 的行为改动
// 跑本文件（暂存语义、快照引用稳定、深路径 mutate 写、宿主拒绝 → failed、文案池行解析）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_FIELDS, leafOf, sameLeaf, parseLines, serializeLines, WhaleSettingsForm,
} from '../lib/client/settings-form.mjs'

/** 假 scope（官方 ConfigForm 面：getSnapshot/subscribe/mutate + revision CAS）。
 * mutate 按深路径落库并广播；可注入「宿主拒绝」模式（返回 false 且不落库）。 */
function makeScope(initialValue = {}, { applyWrites = true, revision = 7 } = {}) {
  let snap = { status: 'ready', writable: true, value: structuredClone(initialValue), revision }
  const listeners = new Set()
  const calls = []
  const setPath = (root, path, value) => {
    let node = root
    for (const seg of path.slice(0, -1)) {
      if (node[seg] === null || typeof node[seg] !== 'object') node[seg] = {}
      node = node[seg]
    }
    node[path[path.length - 1]] = value
  }
  return {
    calls,
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate: async (ops, expectedRevision) => {
      calls.push({ ops, expectedRevision })
      if (!applyWrites) return false
      if (expectedRevision !== undefined && expectedRevision !== snap.revision) return false
      const value = structuredClone(snap.value)
      for (const op of ops) if (op.op === 'set') setPath(value, op.path, op.value)
      snap = { ...snap, value, revision: snap.revision + 1 }
      for (const fn of [...listeners]) fn()
      return true
    },
  }
}

const DEFAULTS = { enabled: true, size: 110, opacity: 1, walk: { enabled: true, speedPxPerSec: 45 }, sleepAfterMs: 60000 }

test('CARD_FIELDS 全是合法叶路径（点分、文案键非空）', () => {
  for (const def of CARD_FIELDS) {
    assert.ok(def.path.length > 0)
    assert.ok(!def.path.includes('..'))
    assert.ok(def.labelKey.length > 0)
  }
})

test('初始快照：可用可写、无暂存、字段取已提交值、缺省回退默认值', () => {
  const scope = makeScope({ size: 120 })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  const state = form.getSnapshot()
  assert.equal(state.available, true)
  assert.equal(state.writable, true)
  assert.equal(state.dirty, false)
  assert.equal(state.fields.size, 120) // 已提交值优先
  assert.equal(state.fields.enabled, true) // 缺省回退 DEFAULTS
  assert.equal(state.fields['walk.enabled'], true)
})

test('不可用命名空间 → available false', () => {
  const scope = makeScope()
  Object.defineProperty(scope.getSnapshot(), 'status', { value: 'unavailable' })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  assert.equal(form.getSnapshot().available, false)
})

test('edit 暂存 + dirty；快照内容未变时引用稳定（React #185 防线）', () => {
  const scope = makeScope()
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  const before = form.getSnapshot()
  form.edit('size', 130)
  const dirty = form.getSnapshot()
  assert.equal(form.getSnapshot().dirty, true)
  assert.equal(dirty.fields.size, 130)
  assert.equal(form.getSnapshot(), dirty) // 无新变更 → 同一对象
  assert.notEqual(before, dirty)
})

test('save：一次 mutate 提交全部暂存（深路径 ops + 首存 revision 基线）', async () => {
  const scope = makeScope({ size: 110, walk: { enabled: true, speedPxPerSec: 45, minMs: 3000 } })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('size', 130)
  form.edit('walk.enabled', false)
  await form.save()
  assert.equal(scope.calls.length, 1) // 单次提交（同一次 revision 栅栏）
  assert.equal(scope.calls[0].expectedRevision, 7) // 首次暂存时的 revision
  assert.deepEqual(scope.calls[0].ops, [
    { op: 'set', path: ['size'], value: 130 },
    { op: 'set', path: ['walk', 'enabled'], value: false },
  ])
  const state = form.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.failed, false)
  assert.equal(state.fields.size, 130)
  // 深路径写不触碰同组其他叶（无需整组合并写）。
  assert.equal(scope.getSnapshot().value.walk.speedPxPerSec, 45)
})

test('save：数组叶按形状确认（宿主往返后引用不同不算失败）', async () => {
  const scope = makeScope({})
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('replies.play', ['再来一次'])
  await form.save()
  assert.equal(form.getSnapshot().failed, false)
  assert.deepEqual(scope.getSnapshot().value.replies.play, ['再来一次'])
})

test('save 后失败判定：宿主拒绝 → failed 置位且暂存清空', async () => {
  const scope = makeScope({}, { applyWrites: false })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('size', 130)
  await form.save()
  const state = form.getSnapshot()
  assert.equal(state.failed, true)
  assert.equal(state.dirty, false) // 暂存清空（值保留在宿主侧供修正）
})

test('save 后失败判定：宿主静默丢字段（接受但未落库）→ failed', async () => {
  const scope = makeScope({})
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('size', 130)
  scope.mutate = async () => true // 假接受、不落库
  await form.save()
  assert.equal(form.getSnapshot().failed, true)
})

test('discard 丢弃暂存并清 revision 基线', () => {
  const scope = makeScope()
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('size', 130)
  form.discard()
  const state = form.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.fields.size, 110)
  assert.equal(form.baselineRevision, undefined)
})

test('edit 清除 failed 标记；宿主侧变更（scope 广播）驱动重渲', () => {
  const scope = makeScope({ size: 110 }, { applyWrites: false })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  form.edit('size', 130)
  form.edit('size', 140) // 再次编辑 → failed 清除
  assert.equal(form.getSnapshot().failed, false)
  // 宿主侧写（他端/连接重置）→ subscribe 触发 → 快照重算取新值
  const external = makeScope({ size: 99 })
  const form2 = new WhaleSettingsForm(external, DEFAULTS)
  let notified = 0
  form2.subscribe(() => { notified += 1 })
  void external.mutate([{ op: 'set', path: ['size'], value: 77 }])
  assert.equal(notified, 1)
  assert.equal(form2.getSnapshot().fields.size, 77)
})

test('dispose 退订 scope 广播且幂等（dispose 后宿主侧写入不再驱动重渲）', async () => {
  const scope = makeScope({ size: 110 })
  const form = new WhaleSettingsForm(scope, DEFAULTS)
  let notified = 0
  form.subscribe(() => { notified += 1 })
  await scope.mutate([{ op: 'set', path: ['size'], value: 120 }])
  assert.equal(notified, 1)
  form.dispose()
  await scope.mutate([{ op: 'set', path: ['size'], value: 130 }])
  assert.equal(notified, 1) // 已退订
  form.dispose() // 幂等：重复调用不抛
})

test('文案池行解析：trim/去空/空串回空数组；序列化往返', () => {
  assert.deepEqual(parseLines(' a \n\n b '), ['a', 'b'])
  assert.deepEqual(parseLines(''), [])
  assert.deepEqual(parseLines('   \n  \n'), [])
  assert.deepEqual(serializeLines(['a', 'b']), 'a\nb')
  assert.equal(serializeLines(undefined), '')
  assert.deepEqual(parseLines(serializeLines(['谢谢', '加油'])), ['谢谢', '加油'])
})

test('leafOf / sameLeaf 纯函数语义', () => {
  assert.equal(leafOf({ walk: { enabled: true } }, 'walk.enabled'), true)
  assert.equal(leafOf({ walk: null }, 'walk.enabled'), undefined)
  assert.equal(leafOf(undefined, 'enabled'), undefined)
  assert.equal(sameLeaf(1, 1), true)
  assert.equal(sameLeaf(1, 2), false)
  assert.equal(sameLeaf(['a'], ['a']), true)
  assert.equal(sameLeaf({ a: 1 }, { a: 1 }), true)
  assert.equal(sameLeaf(['a'], ['b']), false)
  assert.equal(sameLeaf(undefined, null), false)
})
