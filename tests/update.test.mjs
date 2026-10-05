// 更新检查纯逻辑单测（node:test，零依赖）。归属：lib/src/update.mjs 的行为改动跑本文件
// （来源 spec 归一、锁文件读值、三态判断、应用结果映射、更新 spec 计划、git HEAD 解析）。
// 版本比较在 tests/semver.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applicationState, decideUpdate, parseInstallSource, parseRepository, readLockIdentity, resolveGitHead, shortSha,
  updateSpecs,
} from '../lib/src/update.mjs'

test('parseRepository：github 的三种写法归一，非 github 返回 undefined', () => {
  assert.deepEqual(parseRepository('git+https://github.com/vlln/whale-girl.git'), { owner: 'vlln', repo: 'whale-girl' })
  assert.deepEqual(parseRepository('https://github.com/vlln/whale-girl'), { owner: 'vlln', repo: 'whale-girl' })
  assert.deepEqual(parseRepository('git@github.com:vlln/whale-girl.git'), { owner: 'vlln', repo: 'whale-girl' })
  assert.equal(parseRepository('https://gitlab.com/vlln/whale-girl'), undefined)
})

test('parseInstallSource：git spec 归一（简写 / github: / git+https / 裸 URL）', () => {
  assert.deepEqual(parseInstallSource('github:vlln/whale-girl#main'), { kind: 'git', owner: 'vlln', repo: 'whale-girl', ref: 'main' })
  assert.deepEqual(parseInstallSource('vlln/whale-girl'), { kind: 'git', owner: 'vlln', repo: 'whale-girl' })
  assert.deepEqual(parseInstallSource('vlln/whale-girl#ab12cd3'), { kind: 'git', owner: 'vlln', repo: 'whale-girl', ref: 'ab12cd3' })
  assert.deepEqual(parseInstallSource('git+https://github.com/vlln/whale-girl.git#main'), { kind: 'git', owner: 'vlln', repo: 'whale-girl', ref: 'main' })
  assert.deepEqual(parseInstallSource('https://github.com/vlln/whale-girl'), { kind: 'git', owner: 'vlln', repo: 'whale-girl' })
})

test('parseInstallSource：registry spec 归一（含 scope 与范围）', () => {
  assert.deepEqual(parseInstallSource('whale-girl'), { kind: 'registry', name: 'whale-girl' })
  assert.deepEqual(parseInstallSource('whale-girl@0.2.0'), { kind: 'registry', name: 'whale-girl', version: '0.2.0' })
  assert.deepEqual(parseInstallSource('@scope/name@^1.0.0'), { kind: 'registry', name: '@scope/name', version: '^1.0.0' })
  assert.deepEqual(parseInstallSource('@scope/name'), { kind: 'registry', name: '@scope/name' })
  assert.equal(parseInstallSource('gitlab:vlln/whale-girl'), undefined, '别的托管写法认不出就别猜成 registry')
  assert.equal(parseInstallSource('whale-girl@github:vlln/whale-girl'), undefined, 'registry 的「版本」位置塞 git spec 也不认')
  assert.deepEqual(parseInstallSource('/Users/li/whale-girl/repo'), { kind: 'local', path: '/Users/li/whale-girl/repo' })
  assert.deepEqual(parseInstallSource('link:../repo'), { kind: 'local', path: '../repo' })
  assert.equal(parseInstallSource('https://codeload.github.com/vlln/whale-girl/tar.gz/abc'), undefined, 'tarball 链接认不出')
  assert.equal(parseInstallSource('   '), undefined)
})

test('readLockIdentity：一遍读出 git 提交或 registry 版本', () => {
  const gitLock = [
    "lockfileVersion: '9.0'",
    'packages:',
    '  whale-girl@https://codeload.github.com/vlln/whale-girl/tar.gz/ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90:',
    '    resolution: {gitHosted: true, integrity: sha512-xxx}',
  ].join('\n')
  assert.deepEqual(readLockIdentity(gitLock, 'whale-girl'), { sha: 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90' }, 'tar.gz 形式')
  assert.deepEqual(readLockIdentity([
    'packages:',
    '  whale-girl@github:vlln/whale-girl#ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90:',
    '    resolution: {tarball: https://codeload.github.com/vlln/whale-girl/tar.gz/ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90}',
  ].join('\n'), 'whale-girl'), { sha: 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90' }, '#<提交> 形式')
  const registryLock = [
    'packages:',
    '  whale-girl@0.2.0:',
    '    resolution: {integrity: sha512-yyy}',
    "  '@scope/thing@1.4.2':",
    '    resolution: {integrity: sha512-zzz}',
    '  other@1.0.0(react@18.3.1):',
    '    resolution: {integrity: sha512-www}',
  ].join('\n')
  assert.deepEqual(readLockIdentity(registryLock, 'whale-girl'), { version: '0.2.0' })
  assert.deepEqual(readLockIdentity(registryLock, '@scope/thing'), { version: '1.4.2' }, 'scope 键带引号也认')
  assert.deepEqual(readLockIdentity(registryLock, 'other'), { version: '1.0.0' }, '去掉 peer 后缀')
  assert.deepEqual(readLockIdentity(registryLock, 'missing'), {})
  assert.deepEqual(readLockIdentity('', 'whale-girl'), {})
})

test('decideUpdate：git 安装按提交判断（前缀相等视为同一提交）', () => {
  const sha = 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90'
  assert.equal(decideUpdate({ kind: 'git', currentSha: sha, latestSha: sha }), 'up-to-date')
  assert.equal(decideUpdate({ kind: 'git', currentSha: sha, latestSha: 'ab12cd3' }), 'up-to-date')
  assert.equal(decideUpdate({ kind: 'git', currentSha: 'aaaaaaa', latestSha: 'bbbbbbb' }), 'update-available')
  assert.equal(decideUpdate({ kind: 'git', currentSha: undefined, latestSha: sha }), 'unknown')
  assert.equal(decideUpdate({ kind: 'git', currentSha: '', latestSha: sha }), 'unknown')
})

test('decideUpdate：本地路径安装永远无法判断', () => {
  assert.equal(decideUpdate({ kind: 'local', currentVersion: '0.1.0', latestVersion: '9.9.9' }), 'unknown')
})

test('decideUpdate：registry 安装按版本判断', () => {
  assert.equal(decideUpdate({ kind: 'registry', currentVersion: '0.1.0', latestVersion: '0.2.0' }), 'update-available')
  assert.equal(decideUpdate({ kind: 'registry', currentVersion: '0.2.0', latestVersion: '0.2.0' }), 'up-to-date')
  assert.equal(decideUpdate({ kind: 'registry', currentVersion: '0.2.0', latestVersion: '0.1.9' }), 'up-to-date', '上游更旧不算可更新')
  assert.equal(decideUpdate({ kind: 'registry', currentVersion: undefined, latestVersion: '0.2.0' }), 'unknown')
  assert.equal(decideUpdate({ kind: 'registry', currentVersion: '0.1.0', latestVersion: undefined }), 'unknown')
})

test('shortSha：取 7 位，空值安全', () => {
  assert.equal(shortSha('ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90'), 'ab12cd3')
  assert.equal(shortSha('abc'), 'abc')
  assert.equal(shortSha(undefined), '')
})

test('applicationState：只有 applied 与 restart-required 算装成功，未知取值一律算失败', () => {
  assert.equal(applicationState('applied'), 'installed')
  assert.equal(applicationState('restart-required'), 'restart-required')
  assert.equal(applicationState('overridden'), 'overridden')
  assert.equal(applicationState('failed'), 'failed')
  assert.equal(applicationState('cancelled'), 'failed')
  assert.equal(applicationState(undefined), 'failed', '宿主没给结果不能当成功')
  assert.equal(applicationState('something-new'), 'failed', '宿主以后新增取值也不能当成功')
})

test('updateSpecs：先装确切提交，跟踪分支/标签时再换回那条线', () => {
  const sha = 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90'
  assert.deepEqual(updateSpecs(parseInstallSource('github:vlln/whale-girl#main'), { sha }), {
    specs: [`github:vlln/whale-girl#${sha}`, 'github:vlln/whale-girl#main'],
  })
  assert.deepEqual(updateSpecs(parseInstallSource('github:vlln/whale-girl'), { sha }), {
    specs: [`github:vlln/whale-girl#${sha}`, 'github:vlln/whale-girl'],
  }, '没有 ref 的安装换回不带 ref 的写法，继续跟默认分支')
  assert.deepEqual(updateSpecs(parseInstallSource('github:vlln/whale-girl#v1.2.3'), { sha }), {
    specs: [`github:vlln/whale-girl#${sha}`, 'github:vlln/whale-girl#v1.2.3'],
  }, '标签也继续跟踪')
  assert.deepEqual(updateSpecs(parseInstallSource(`github:vlln/whale-girl#${sha}`), { sha }), {
    specs: [`github:vlln/whale-girl#${sha}`],
  }, '已经钉在提交上的安装一次就够')
  assert.deepEqual(updateSpecs(parseInstallSource('whale-girl@^0.1.0'), { version: '0.2.0' }), {
    specs: ['whale-girl@0.2.0'],
  }, 'registry 装完记的是版本范围，不需要第二步')
  assert.equal(updateSpecs(parseInstallSource('github:vlln/whale-girl#main'), {}), undefined, '没有目标提交就没有计划')
})

test('updateSpecs：本地路径安装改成跟包声明的仓库的默认分支', () => {
  const local = parseInstallSource('link:/Users/li/whale-girl/repo')
  const target = { sha: 'f'.repeat(40), ref: 'main', repo: { owner: 'vlln', repo: 'whale-girl' } }
  assert.deepEqual(updateSpecs(local, target), { specs: ['github:vlln/whale-girl#main'] }, '一步：直接换成跟上游那条线')
  assert.equal(updateSpecs(local, { sha: target.sha }), undefined, '不知道跟哪条线时不给计划')
  assert.equal(updateSpecs(local, { sha: target.sha, ref: 'main' }), undefined, '不知道仓库时不给计划')
})

test('resolveGitHead：游离 HEAD 直接用，符号引用从已读到的引用或 packed-refs 解出', () => {
  const sha = 'a'.repeat(40)
  assert.equal(resolveGitHead(`${sha}\n`), sha)
  assert.equal(resolveGitHead('ref: refs/heads/main\n', `${sha} refs/heads/main\n`), sha)
  assert.equal(resolveGitHead('ref: refs/heads/main\n', 'b'.repeat(40) + ' refs/heads/other\n'), undefined)
  assert.equal(resolveGitHead('乱七八糟'), undefined)
})

