// 更新行呈现状态单测（node:test，零依赖）。归属：lib/client/update-state.mjs 的行为改动跑本文件
// （各状态的状态文案、按钮文案/可用性/主次/点击处理函数、提示色，以及 POST 结果到界面状态的映射）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROW_INITIAL, deriveUpdateRow, outcomeOf, reduceRow } from '../lib/client/update-state.mjs'

// 与宿主 locale 的 t 一致：支持 {name} 占位符插值。
const dict = {
  checking: '检查中…', check: '检查更新…', latest: '已是最新', latestAt: '已是最新（当前 {current}）',
  available: '有新版本 {target}', availableAt: '有新版本 {target}（当前 {current}）',
  availableLocal: '有新版本 {target}（当前 {current}）；更新会改成跟 {ref}',
  availableUnsupported: '有新版本 {target}，但此部署不支持应用内更新。',
  updateTo: '更新到 {target}…', updateToRef: '改跟 {ref}…', updating: '更新中…',
  updateUnsupported: '此部署不支持应用内更新。', updateUnknown: '无法确认上游版本。',
  checkFailed: '检查失败，稍后再试。', checkRateLimited: '上游请求受限（GitHub 限流），稍后再试。',
  localSource: '本地路径安装，无法检查更新。', updated: '已更新。',
  updatedRestart: '已更新，改动将在下次启动生效。',
  updatedOverridden: '已更新，但被更高优先级的配置覆盖，当前未生效。',
  updateFailed: '更新失败，稍后再试。', updateFailedDetail: '更新失败，稍后再试。（{reason}）',
  updateFailedEnabled: '更新失败：读不到当前启停状态，未做任何改动。',
  updateFailedSource: '更新失败：认不出这个安装来源。',
  updateFailedTracking: '更新失败，稍后再试。profile 现在固定在 {spec}——要恢复跟踪某条分支，需手动改回该分支。',
  reasonSeparator: '：',
}
const t = (key, vars) => {
  const text = dict[key] ?? key
  return vars === undefined ? text : text.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))
}

const onCheck = () => 'checked'
const onUpdate = () => 'updated'
const row = (overrides) => deriveUpdateRow({ phase: 'ready', translate: t, onCheck, onUpdate, ...overrides })
const presentation = (action) => ({ label: action.label, disabled: action.disabled, primary: action.primary })

const upstream = {
  current: { version: '0.1.0', commit: 'cd59f03' },
  latest: { sha: 'bfcada1'.repeat(6), commit: 'bfcada1', version: '0.1.0' },
  state: 'update-available',
  canUpdate: true,
}
const local = {
  current: { version: '0.1.0', source: 'link:/tmp/repo', commit: 'cd59f03' },
  latest: { sha: 'bfcada1'.repeat(6), commit: 'bfcada1', ref: 'main', repo: { owner: 'vlln', repo: 'whale-girl' } },
  state: 'update-available',
  canUpdate: true,
}

test('loading：状态与按钮都是「检查中…」，按钮禁用且点的是检查', () => {
  const view = row({ phase: 'loading' })
  assert.equal(view.status, '检查中…')
  assert.deepEqual(presentation(view.action), { label: '检查中…', disabled: true, primary: false })
  assert.equal(view.action.run, onCheck)
})

test('检查失败 / 上游限流：两条文案分开，按钮仍可重试', () => {
  const failed = row({ phase: 'error' })
  assert.equal(failed.status, '检查失败，稍后再试。')
  assert.equal(failed.action.run, onCheck)
  const limited = row({ info: { current: { version: '0.1.0' }, state: 'unknown', canUpdate: false, reason: 'rate-limited' } })
  assert.equal(limited.status, '上游请求受限（GitHub 限流），稍后再试。')
})

test('已是最新：状态行给出当前提交，按钮仍可点（不把唯一的按钮永久禁用）', () => {
  const view = row({ info: { current: { version: '0.1.0', commit: 'bfcada1' }, latest: { commit: 'bfcada1' }, state: 'up-to-date', canUpdate: false } })
  assert.equal(view.status, '已是最新（当前 bfcada1）')
  assert.deepEqual(presentation(view.action), { label: '检查更新…', disabled: false, primary: false })
  assert.equal(view.action.run, onCheck)
})

test('已是最新但当前身份没有提交（registry 安装）：状态行只报结论', () => {
  assert.equal(row({ info: { current: { version: '0.2.0' }, latest: { version: '0.2.0' }, state: 'up-to-date', canUpdate: false } }).status, '已是最新')
})

test('有新版（git）：状态行带当前提交，按钮为可点的 primary，点的是更新', () => {
  const view = row({ info: upstream })
  assert.equal(view.status, '有新版本 bfcada1（当前 cd59f03）')
  assert.deepEqual(presentation(view.action), { label: '更新到 bfcada1…', disabled: false, primary: true })
  assert.equal(view.action.run, onUpdate, '能更新时按钮必须调更新（这条正是按钮接错线的回归防线）')
})

test('有新版（本地路径安装）：说清「更新会改成跟 <分支>」，按钮文案跟着改', () => {
  const view = row({ info: local })
  assert.equal(view.status, '有新版本 bfcada1（当前 cd59f03）；更新会改成跟 main')
  assert.deepEqual(presentation(view.action), { label: '改跟 main…', disabled: false, primary: true })
  assert.equal(view.action.run, onUpdate)
})

test('有新版（registry）：目标是版本号', () => {
  const view = row({ info: { current: { version: '0.1.0' }, latest: { version: '0.2.0' }, state: 'update-available', canUpdate: true } })
  assert.equal(view.status, '有新版本 0.2.0')
  assert.equal(view.action.label, '更新到 0.2.0…')
})

test('有新版但宿主不能装：状态行说明原因，按钮保留动作名并禁用、不接线到更新', () => {
  const view = row({ info: { ...upstream, canUpdate: false } })
  assert.equal(view.status, '有新版本 bfcada1，但此部署不支持应用内更新。')
  assert.deepEqual(presentation(view.action), { label: '更新到 bfcada1…', disabled: true, primary: false })
  assert.equal(view.action.run, onCheck)
  assert.equal(view.tone, 'default')
})

test('更新中：状态与按钮都是「更新中…」，按钮禁用', () => {
  const view = row({ phase: 'updating', info: upstream })
  assert.equal(view.status, '更新中…')
  assert.deepEqual(presentation(view.action), { label: '更新中…', disabled: true, primary: false })
})

test('更新完成：状态行说结果，按钮回到可点的「检查更新…」，且不是报错色', () => {
  const view = row({ phase: 'done', info: upstream, notice: '已更新，改动将在下次启动生效。', noticeTone: 'default' })
  assert.equal(view.status, '已更新，改动将在下次启动生效。')
  assert.deepEqual(presentation(view.action), { label: '检查更新…', disabled: false, primary: false })
  assert.equal(view.action.run, onCheck)
  assert.equal(view.tone, 'default', '成功提示不该用报错色')
})

test('更新失败：状态行带诊断、用报错色，按钮仍可重试', () => {
  const view = row({ info: upstream, notice: '更新失败，稍后再试。（ambiguous-install：two deps）', noticeTone: 'error' })
  assert.equal(view.status, '更新失败，稍后再试。（ambiguous-install：two deps）')
  assert.equal(view.tone, 'error')
  assert.equal(view.action.run, onUpdate)
})

test('本地路径但不是 git 检出 / 无来源：各自的说明文案', () => {
  assert.equal(row({ info: { current: { version: '0.1.0' }, state: 'unknown', canUpdate: false, reason: 'local-source' } }).status, '本地路径安装，无法检查更新。')
  assert.equal(row({ info: { current: { version: '0.1.0' }, state: 'unknown', canUpdate: false, reason: 'no-source' } }).status, '无法确认上游版本。')
})

test('outcomeOf：成功各态进 done，检查失败不算更新失败也不上红色', () => {
  assert.deepEqual(outcomeOf({ state: 'restart-required' }, t), { phase: 'done', notice: '已更新，改动将在下次启动生效。', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'installed' }, t), { phase: 'done', notice: '已更新。', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'overridden' }, t), { phase: 'done', notice: '已更新，但被更高优先级的配置覆盖，当前未生效。', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'unsupported' }, t), { phase: 'ready', notice: '此部署不支持应用内更新。', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'up-to-date' }, t), { phase: 'ready', notice: '已是最新', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'check-failed' }, t), { phase: 'ready', notice: '检查失败，稍后再试。', tone: 'default' })
  assert.deepEqual(outcomeOf({ state: 'check-failed', errorCode: 'rate-limited' }, t), { phase: 'ready', notice: '上游请求受限（GitHub 限流），稍后再试。', tone: 'default' })
})

test('outcomeOf：自己的错误码走文案表，第二步失败会把钉住的 spec 说出来', () => {
  assert.deepEqual(outcomeOf({ state: 'failed', errorCode: 'unknown-enabled-state' }, t), { phase: 'ready', notice: '更新失败：读不到当前启停状态，未做任何改动。', tone: 'error' })
  assert.deepEqual(outcomeOf({ state: 'failed', errorCode: 'unsupported-source' }, t), { phase: 'ready', notice: '更新失败：认不出这个安装来源。', tone: 'error' })
  const pinned = outcomeOf({ state: 'failed', errorCode: 'tracking-not-restored', errorDetail: 'ambiguous-install · two deps', pinnedSpec: 'github:vlln/whale-girl#abc1234' }, t)
  assert.equal(pinned.notice, '更新失败，稍后再试。profile 现在固定在 github:vlln/whale-girl#abc1234——要恢复跟踪某条分支，需手动改回该分支。')
  assert.equal(pinned.tone, 'error')
})

test('outcomeOf：宿主自己的码原样带出（不翻译），没有结果体按失败处理', () => {
  const failed = outcomeOf({ state: 'failed', errorCode: 'ambiguous-install', errorDetail: 'the profile changed two dependencies' }, t)
  assert.equal(failed.phase, 'ready')
  assert.equal(failed.tone, 'error')
  assert.equal(failed.notice, '更新失败，稍后再试。（ambiguous-install：the profile changed two dependencies）')
  assert.deepEqual(outcomeOf({ state: 'failed' }, t), { phase: 'ready', notice: '更新失败，稍后再试。', tone: 'error' })
  assert.equal(outcomeOf(undefined, t).phase, 'ready', '没有结果体时按失败处理，不假装成功')
})

test('reduceRow：状态迁移只有一条路，检查/更新的起止与结果都覆盖', () => {
  const loaded = { ...ROW_INITIAL, phase: 'ready', info: upstream }
  assert.deepEqual(reduceRow(loaded, { type: 'check-started' }), { ...loaded, phase: 'loading', notice: undefined, noticeTone: 'default' }, '重新检查：清掉上次提示，保留已拿到的 info')
  assert.deepEqual(reduceRow(ROW_INITIAL, { type: 'checked', info: upstream }), { ...ROW_INITIAL, phase: 'ready', info: upstream })
  assert.deepEqual(reduceRow(loaded, { type: 'check-failed' }), { ...loaded, phase: 'error' })
  assert.deepEqual(reduceRow(loaded, { type: 'update-started' }), { ...loaded, phase: 'updating', notice: undefined, noticeTone: 'default' })
  assert.deepEqual(
    reduceRow(loaded, { type: 'settled', phase: 'done', notice: '已更新。', tone: 'default' }),
    { ...loaded, phase: 'done', notice: '已更新。', noticeTone: 'default' },
  )
})

test('reduceRow：失败结果一定带上报错色，未知事件保持原状态', () => {
  const settled = reduceRow({ ...ROW_INITIAL, phase: 'updating' }, { type: 'settled', ...outcomeOf({ state: 'failed' }, t) })
  assert.equal(settled.phase, 'ready')
  assert.equal(settled.noticeTone, 'error', '请求失败/宿主失败都必须按报错色呈现')
  const before = { ...ROW_INITIAL, phase: 'ready' }
  assert.equal(reduceRow(before, { type: '没听说过' }), before)
  assert.equal(reduceRow(before, undefined), before)
})
