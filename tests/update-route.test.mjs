// 更新端点（/whale-girl/update）的路由级测试：用一个最小 mock ctx 起 Node half，直接调路由处理器。
// 归属：lib/index.mjs 里更新端点与 applyUpdate 的行为改动跑本文件。
// 这一层只管 HTTP 层与端到端接线：跨源请求被拒、方法/缓存头、载荷形状、来源取 profile 记录、两步重装与
// 启停状态；状态机、.git 布局解析与各失败分支的精确行为在 tests/update-host.test.mjs（那边用真实临时目录
// 与注入的假依赖，能覆盖到 worktree、限流、第二步失败等路由层不好造的场景）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH_HOME 在模块加载时就被读走（状态文件位置），所以先设再动态 import。
const home = mkdtempSync(join(tmpdir(), 'whale-route-'))
process.env.DSH_HOME = home

const SOURCE = 'github:vlln/whale-girl#main'
const SHA = 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90'

/** 建一个临时 profile：package.json 记来源，pnpm-lock.yaml 记已安装提交。 */
function makeProfile(source) {
  const dir = mkdtempSync(join(home, 'profile-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'whale-girl': source } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), [
    'packages:',
    `  whale-girl@https://codeload.github.com/vlln/whale-girl/tar.gz/${SHA}:`,
    '    resolution: {gitHosted: true}',
  ].join('\n'))
  return dir
}

/** 起一个 Node half 实例，返回取到的路由与安装调用记录。 */
async function boot({
  source = SOURCE,
  enabled = true,
  omitEnabled = false,
  application = 'restart-required',
  failAtStep = 0,
  local = undefined,
} = {}) {
  const routes = []
  const installs = []
  const services = {
    webServer: { register: (route) => { routes.push(route) } },
    pluginManager: {
      listBundles: async () => [{ name: 'whale-girl', source, installed: true, ...(omitEnabled ? {} : { enabled }) }],
      installBundle: async (spec, options) => {
        installs.push({ spec, options })
        const step = installs.length
        if (failAtStep === step) return { application: 'failed', changed: false, error: { code: 'ambiguous-install', diagnostic: 'the profile changed two dependencies' } }
        return { application, changed: true }
      },
    },
    profileContext: { dir: local === undefined ? makeProfile(source) : makeLocalProfile(local) },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    provide: () => {},
    get: (name) => services[name],
    agents: { list: () => [] },
    jobs: { list: () => [], events: { subscribe: () => () => {} } },
    sessions: { list: () => [] },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  const module = await import(`../lib/index.mjs?route-test=${Date.now()}${Math.random()}`)
  module.apply(ctx, {})
  const route = routes.find((candidate) => candidate.path === module.UPDATE_PATH)
  assert.ok(route !== undefined, '更新端点应该注册到 webServer')
  const call = (method, headers = {}) => new Promise((resolve) => {
    const req = { method, headers: { host: '127.0.0.1:1234', ...headers }, url: module.UPDATE_PATH }
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
      end(payload) { this.body = payload; resolve(this) },
    }
    route.handler(req, res)
  })
  return { call, installs }
}

/** 建一个本地检出目录（`.git` 目录 + 松散引用）。 */
function makeCheckout({ sha, worktree = false }) {
  const dir = mkdtempSync(join(home, 'checkout-'))
  if (!worktree) {
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${sha}\n`)
    return dir
  }
  // worktree：<dir>/.git 是文件，指向 <common>/.git/worktrees/<name>；分支引用写在公共目录里。
  const common = mkdtempSync(join(home, 'common-'))
  mkdirSync(join(common, '.git', 'worktrees', 'wt1'), { recursive: true })
  mkdirSync(join(common, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(common, '.git', 'refs', 'heads', 'main'), `${sha}\n`)
  writeFileSync(join(common, '.git', 'worktrees', 'wt1', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(common, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n')
  writeFileSync(join(dir, '.git'), `gitdir: ${join(common, '.git', 'worktrees', 'wt1')}\n`)
  return dir
}

/** 本地路径安装的 profile：来源是 link: 指向的检出目录。 */
function makeLocalProfile(checkout) {
  const dir = mkdtempSync(join(home, 'profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'whale-girl': `link:${checkout}` } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages: {}\n')
  return dir
}

test('跨源请求一律 403：POST 是写动作，GET 也会出网刷上游配额', async () => {
  const { call, installs } = await boot()
  const crossSite = { 'sec-fetch-site': 'cross-site' }
  const foreign = { origin: 'https://evil.example' }
  for (const headers of [crossSite, foreign]) {
    const post = await call('POST', headers)
    assert.equal(post.status, 403, `POST ${JSON.stringify(headers)} 应被拒`)
    const get = await call('GET', headers)
    assert.equal(get.status, 403, `GET ${JSON.stringify(headers)} 应被拒`)
  }
  assert.deepEqual(installs, [], '被拒的请求不该触发任何安装')
})

test('GET 返回检查结果，来源取 profile 记录、提交取锁文件', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ sha: SHA, commit: { committer: { date: '2026-10-05T00:00:00Z' } }, html_url: 'https://example.test' }),
  })
  try {
    const { call } = await boot()
    const response = await call('GET', { 'sec-fetch-site': 'same-origin' })
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.current.source, SOURCE)
    assert.equal(payload.current.commit, SHA.slice(0, 7))
    assert.equal(payload.state, 'up-to-date')
    assert.equal(payload.canUpdate, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('没有 profile 记录来源时不提供更新动作（不拿包清单的 repository 兜底）', async () => {
  const { call, installs } = await boot({ source: '' })
  const response = await call('GET', { 'sec-fetch-site': 'same-origin' })
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.state, 'unknown')
  assert.equal(payload.reason, 'host-outdated', '记录里压根没有来源字段 = 旧宿主（BundleInfo 还没有 source）')
  assert.equal(payload.canUpdate, false)
  const post = await call('POST', { 'sec-fetch-site': 'same-origin' })
  const failed = JSON.parse(post.body)
  assert.equal(failed.state, 'check-failed', '检查给不出结论时按「检查失败」呈现，而不是更新失败')
  assert.equal(failed.errorCode, 'host-outdated')
  assert.deepEqual(installs, [])
})

test('POST 分两步重装：先确切提交，再换回 profile 记的那条线，且保持启停状态', async () => {
  const realFetch = globalThis.fetch
  const target = 'ffffffffffffffffffffffffffffffffffffffff'
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sha: target, commit: { committer: {} } }) })
  try {
    const { call, installs } = await boot({ enabled: false })
    const response = await call('POST', { 'sec-fetch-site': 'same-origin' })
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.state, 'restart-required')
    assert.deepEqual(installs.map((entry) => entry.spec), [`github:vlln/whale-girl#${target}`, SOURCE])
    assert.equal(installs[0].options.enabled, false, '关着的组合包不能在更新时被顺手打开')
    assert.equal(installs[1].options.enabled, false)
    for (const entry of installs) {
      assert.deepEqual(Object.keys(entry.options).sort(), ['enabled', 'requestId'], '更新只带启停与请求 id：不携带任何配置、补丁或构建授权，用户设置与条目 config 不归更新管')
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('宿主报告失败时如实转述，不报成更新成功', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sha: 'ffffffffffffffffffffffffffffffffffffffff', commit: { committer: {} } }) })
  try {
    const { call } = await boot({ application: 'failed' })
    const response = await call('POST', { 'sec-fetch-site': 'same-origin' })
    const payload = JSON.parse(response.body)
    assert.equal(payload.state, 'failed')
    assert.equal(payload.application, 'failed')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('不认识的 HTTP 方法回 405 并声明允许的方法', async () => {
  const { call } = await boot()
  const response = await call('DELETE', { 'sec-fetch-site': 'same-origin' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'GET, POST')
})

test('本地路径安装：跟包声明的仓库的默认分支，更新一步换成那条线', async () => {
  const realFetch = globalThis.fetch
  const localSha = 'c'.repeat(40)
  const upstreamSha = 'd'.repeat(40)
  const checkout = makeCheckout({ sha: localSha })
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    if (String(url).endsWith('/repos/vlln/whale-girl')) return { ok: true, json: async () => ({ default_branch: 'main' }) }
    return { ok: true, json: async () => ({ sha: upstreamSha, commit: { committer: {} } }) }
  }
  try {
    const { call, installs } = await boot({ source: `link:${checkout}`, local: checkout })
    const payload = JSON.parse((await call('GET', { 'sec-fetch-site': 'same-origin' })).body)
    assert.equal(payload.current.commit, localSha.slice(0, 7), '本地检出的提交就是当前身份')
    assert.equal(payload.latest.commit, upstreamSha.slice(0, 7))
    assert.equal(payload.state, 'update-available')
    assert.equal(payload.canUpdate, true)
    assert.ok(urls.some((url) => url.endsWith('/commits/main')), '问的是仓库的默认分支')

    const post = JSON.parse((await call('POST', { 'sec-fetch-site': 'same-origin' })).body)
    assert.equal(post.state, 'restart-required')
    assert.deepEqual(installs.map((entry) => entry.spec), ['github:vlln/whale-girl#main'], '一步：直接换成跟上游那条线')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('本地路径安装但不是 git 检出：退回「无法确认上游」，不动 profile', async () => {
  const dir = mkdtempSync(join(home, 'plain-'))
  const { call, installs } = await boot({ source: `link:${dir}` })
  const response = await call('GET', { 'sec-fetch-site': 'same-origin' })
  const payload = JSON.parse(response.body)
  assert.equal(payload.state, 'unknown')
  assert.equal(payload.reason, 'local-source')
  assert.equal(JSON.parse((await call('POST', { 'sec-fetch-site': 'same-origin' })).body).state, 'check-failed')
  assert.deepEqual(installs, [])
})

test('启停状态：开着的组合包更新后仍是开着（enabled: true 显式带上）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sha: 'a'.repeat(40), commit: { committer: {} } }) })
  try {
    const { call, installs } = await boot({ source: 'github:vlln/whale-girl#main', enabled: true })
    await call('POST', { 'sec-fetch-site': 'same-origin' })
    assert.equal(installs[0].options.enabled, true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('上游限流：检查用独立 reason，POST 说成「检查失败」而不是「更新失败」', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) })
  try {
    const { call, installs } = await boot()
    const payload = JSON.parse((await call('GET', { 'sec-fetch-site': 'same-origin' })).body)
    assert.equal(payload.state, 'unknown')
    assert.equal(payload.reason, 'rate-limited')
    assert.equal(payload.canUpdate, false)
    const post = JSON.parse((await call('POST', { 'sec-fetch-site': 'same-origin' })).body)
    assert.equal(post.state, 'check-failed')
    assert.equal(post.errorCode, 'rate-limited')
    assert.deepEqual(installs, [])
  } finally {
    globalThis.fetch = realFetch
  }
})
