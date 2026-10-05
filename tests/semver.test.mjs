// semver 形状比较单测（node:test，零依赖）。归属：lib/src/semver.mjs 的行为改动跑本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions } from '../lib/src/semver.mjs'

test('compareVersions：数字段与预发布段', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1, '预发布低于同号正式')
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1, '数字段按数值比')
  assert.equal(compareVersions('0.1.0', '0.1.0+build.5'), 0, '构建元数据不参与比较')
  assert.equal(compareVersions('乱七八糟', '1.0.0'), undefined)
  assert.equal(compareVersions(undefined, '1.0.0'), undefined)
})
