// 门禁自证：verify-config-sync 必须证明它会拒绝（法则 2）。
// 归属：门禁源码改动跑本文件（node --test scripts/gates/）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { check } from './verify-config-sync.mjs'

const DEFAULTS_BODY = `  size: 110, opacity: 1,
  walk: { enabled: true, minWaitMs: 18000, maxWaitMs: 40000, minMs: 3000, maxMs: 6000, speedPxPerSec: 45 },
  sleepAfterMs: 60000, pollMs: 3000, bubbleMs: 2500,
  welcomeMs: 6000, celebrateMs: 6000, errorMs: 4000, disappointedMs: 6000,`

const CONFIG_SRC = `export const NAMESPACE = 'whale-girl'
export const DEFAULTS = Object.freeze({
${DEFAULTS_BODY}
})`

const CLIENT_DEFAULTS = `const CFG_DEFAULTS = {
  size: 110, opacity: 1,
  walk: { enabled: true, minWaitMs: 18000, maxWaitMs: 40000, minMs: 3000, maxMs: 6000, speedPxPerSec: 45 },
  sleepAfterMs: 60000, pollMs: 3000, bubbleMs: 2500,
}`

const CLIENT_SRC = `const SETTINGS_NAMESPACE = 'whale-girl'\n${CLIENT_DEFAULTS}`
const PATCH_SRC = '- insert:\n    - id: whale-girl\n      name: whale-girl\n'
const PKG_SRC = '{ "name": "whale-girl", "version": "0.1.0" }'

/** 造最小树：config.mjs / client/index.mjs / cordis.patch.yml / package.json。 */
function makeTree({ config = CONFIG_SRC, client = CLIENT_SRC, patch = PATCH_SRC, pkg = PKG_SRC } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vcsync-'))
  const mk = (rel, content) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  mk('lib/src/config.mjs', config)
  mk('lib/client/index.mjs', client)
  mk('cordis.patch.yml', patch)
  mk('package.json', pkg)
  return root
}

test('接受：默认值一致且命名空间四处同名', () => {
  const { ok, errors } = check(makeTree())
  assert.equal(ok, true, errors.join('\n'))
})

test('拒绝：client 默认值与 DEFAULTS 不一致（漂移）', () => {
  const client = CLIENT_SRC.replace('size: 110', 'size: 140')
  const { ok, errors } = check(makeTree({ client }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /CFG_DEFAULTS\.size = 140 .* DEFAULTS\.size = 110/)
})

test('拒绝：client 配置项未在 DEFAULTS 声明', () => {
  const client = `const SETTINGS_NAMESPACE = 'whale-girl'\nconst CFG_DEFAULTS = {\n  size: 110, opacity: 1, teleportMs: 999,\n}`
  const { ok, errors } = check(makeTree({ client }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /CFG_DEFAULTS\.teleportMs 不在 src\/config.mjs DEFAULTS/)
})

test('拒绝：缺少 DEFAULTS / CFG_DEFAULTS 对象', () => {
  const { ok: ok1, errors: e1 } = check(makeTree({ config: 'export const x = 1' }))
  assert.equal(ok1, false)
  assert.match(e1.join('\n'), /未找到 DEFAULTS/)
  const { ok: ok2, errors: e2 } = check(makeTree({ client: 'export const y = 2' }))
  assert.equal(ok2, false)
  assert.match(e2.join('\n'), /未找到 CFG_DEFAULTS/)
})

test('拒绝：条目 id 与 NAMESPACE 不同名（命名空间漂移）', () => {
  const { ok, errors } = check(makeTree({ patch: '- insert:\n    - id: whale-girl-2\n      name: whale-girl\n' }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /cordis\.patch\.yml 条目 id = whale-girl-2 ≠ src\/config\.mjs NAMESPACE = whale-girl/)
})

test('拒绝：包名与 NAMESPACE 不同名（卡片 key 取包名）', () => {
  const { ok, errors } = check(makeTree({ pkg: '{ "name": "@vlln/whale-girl" }' }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /package\.json 包名 = @vlln\/whale-girl ≠ src\/config\.mjs NAMESPACE = whale-girl/)
})

test('拒绝：client SETTINGS_NAMESPACE 字面量与 NAMESPACE 不同名', () => {
  const client = CLIENT_SRC.replace("const SETTINGS_NAMESPACE = 'whale-girl'", "const SETTINGS_NAMESPACE = 'whale'")
  const { ok, errors } = check(makeTree({ client }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /client SETTINGS_NAMESPACE = whale ≠ src\/config\.mjs NAMESPACE = whale-girl/)
})

test('拒绝：缺 client 命名空间声明（无从对齐）', () => {
  const { ok, errors } = check(makeTree({ client: CLIENT_DEFAULTS }))
  assert.equal(ok, false)
  assert.match(errors.join('\n'), /client SETTINGS_NAMESPACE：未找到设置命名空间声明/)
})
