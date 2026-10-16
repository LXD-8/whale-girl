// 浏览器级行为验证（人工验证步骤，非门禁——依赖 Chrome 与运行中的 web，同 verify-client-smoke）。
// 用法：node scripts/verify-client-behavior.mjs <web-url> [scenario]
// 场景：sleep-drag-wake（默认）——验证「sleep → 拖拽 → 放下 → idle 缓冲 → wake → 保持清醒
// 不回 sleep」完整链路（v6 交互醒觉回归防线，见决策记录 2026-08-10-client-behavior-probe.md）。
// 场景：update-row——验证配置卡片的更新行「点检查 → 点更新 → 真的发出 POST /whale-girl/update」链路
// （需要部署里确实有新版可更新；按钮接线错位这类问题只有真点一下才暴露）。
// 场景：memory-bubble——验证会话记忆回读气泡「/state 的 memory → 气泡文案 → 按 at 去重」链路
// （拦 /state 响应注入 memory，不依赖真实任务/会话边沿，因此可重复跑）。
// 此前同类验证是一次性 /tmp/cdp-*.mjs 探针（不入库、不可重跑）——本文件固化场景，
// 断言失败非零退出，供 client 行为改动后重跑。
// 依赖：本机 Chrome（CHROME_BIN 可覆盖）；Node ≥22（全局 WebSocket）。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2]
const SCENARIO = process.argv[3] ?? 'sleep-drag-wake'
const DEBUG_PORT = 9240
// 新版 Chrome 拒绝带 Origin 的 CDP WebSocket（需 --remote-allow-origins）；不隔离
// --user-data-dir 时会挂到默认 profile（复用已有浏览器实例，/json 里可能是别的标签页）。
const PROFILE_DIR = mkdtempSync(join(tmpdir(), 'whale-girl-behavior-'))

if (!URL) {
  console.error('用法: node scripts/verify-client-behavior.mjs <web-url> [scenario]')
  process.exit(2)
}

// ---- CDP 基础（headless Chrome + Runtime/Input）----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function connect() {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*', `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=1280,800', URL], { stdio: 'ignore' })
  let ws
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      const page = tabs.find((t) => t.type === 'page')
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break }
    } catch {}
  }
  if (!ws) { chrome.kill(); throw new Error('CDP 连接失败（Chrome 未就绪）') }
  await new Promise((r) => { ws.onopen = r })
  let id = 0
  const call = (method, params) => new Promise((resolve) => {
    const myId = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result) }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  // CDP 事件（无 id 的通知）分发：Fetch.requestPaused 这类要边跑边应答的场景需要它。
  const listeners = new Map()
  const on = (method, handler) => {
    const set = listeners.get(method) ?? new Set()
    set.add(handler)
    listeners.set(method, set)
  }
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined || typeof m.method !== 'string') return
    for (const handler of listeners.get(m.method) ?? []) void handler(m.params)
  })
  await call('Runtime.enable')
  return { chrome, call, on }
}
/** 读取当前 sprite 的 sheet 名（background-image URL 末段）与 motion 类——状态观察面。 */
const SNAP = `(() => {
  const sprite = document.querySelector('[data-whale-girl] .pet-sprite')
  const stage = document.querySelector('[data-whale-girl] .pet-stage')
  if (!sprite || !stage) return JSON.stringify({ ok: false })
  const m = (sprite.style.backgroundImage || '').match(/[a-z-]+\\.png/)
  const motion = [...stage.classList].find((c) => c.startsWith('pet-motion-')) || ''
  return JSON.stringify({ ok: true, sheet: m ? m[0].replace('.png', '') : 'unknown', motion: motion.replace('pet-motion-', '') })
})()`

// ---- 场景：sleep → drag → 放下 → 清醒不回 sleep ----
// 走真实时间（sleepAfterMs=60000 + 3s 轮询）；断言序列是 v6 交互醒觉的契约：
// 放下后直接 wake（3s，睡着被拖起时放下缓冲让位 wake）→ 底层状态，10s 内不得回到 sleep。
async function sleepDragWake({ call, log }) {
  await call('Runtime.evaluate', { expression: `(() => {
    const t = document.getElementById('deepseek-onboarding-title')
    if (t) t.remove()
    const labelled = document.querySelector('[aria-labelledby="deepseek-onboarding-title"]')
    if (labelled) labelled.remove()
    return 'ok'
  })()`, returnByValue: true })
  await sleep(1500) // 等 onboarding 隐藏的宠物恢复显示（syncInert 经 MutationObserver）
  const read = async (label) => {
    const r = await call('Runtime.evaluate', { expression: SNAP, returnByValue: true })
    const v = JSON.parse(r.result.value)
    log(label, `${v.ok ? v.sheet + '/' + v.motion : 'no-sprite'}`)
    return v
  }
  // 轮询等待某状态出现（消除固定 sleep 的时序脆弱性——headless 下事件/资源处理有抖动）。
  const waitFor = async (label, predicate, timeoutMs = 4000) => {
    const start = Date.now()
    let last = null
    while (Date.now() - start < timeoutMs) {
      last = await read(label)
      if (last.ok && predicate(last)) return last
      await sleep(250)
    }
    throw new Error(`等待 ${label} 超时（最后状态 ${last?.ok ? last.sheet : '无 sprite'}）`)
  }
  await read('initial')
  log('wait', '等待 65s 让宠物入睡（sleepAfterMs=60000 + 轮询粒度）')
  await sleep(65000)
  await waitFor('after-65s', (v) => v.sheet === 'sleep')

  const r0 = await call('Runtime.evaluate', { expression: `(() => {
    const hit = document.querySelector('[data-whale-girl] .pet-hitarea')
    const rect = hit.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })
  })()`, returnByValue: true })
  const { x, y } = JSON.parse(r0.result.value)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  for (let i = 1; i <= 10; i++) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - i * 25, y, button: 'left' })
    await sleep(30)
  }
  await waitFor('during-drag', (v) => v.sheet === 'drag')
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 250, y, button: 'left', clickCount: 1 })
  // 放下后：睡着被拖起直接 wake（3s，放下缓冲让位 wake）→ 底层状态，全程不得回 sleep。
  await waitFor('release-wake', (v) => v.sheet === 'wake', 4000)
  const t3 = await waitFor('release-settled', (v) => v.sheet !== 'wake' && v.sheet !== 'sleep', 5000)
  if (t3.sheet === 'sleep') throw new Error('放下后回到 sleep（空闲计时未重置）')
  await sleep(5000)
  const t4 = await read('release+10s')
  if (t4.sheet === 'sleep') throw new Error('放下 10s 后回到 sleep（空闲计时未重置）')
  return { during: 'drag', releaseWake: 'wake', settled: t3.sheet, release10s: t4.sheet }
}

// ---- 场景：更新行「检查 → 更新」点击链路 ----
// 先点一次按钮把检查跑起来（挂载时本来也会查一次），等状态行给出「有新版本 / 已是最新」；若按钮
// 变成更新动作（primary），再点一次，断言真的发出 POST /whale-girl/update、且按钮没有抛异常。
async function updateRow({ call, log }) {
  const evaluate = async (expression) => {
    // awaitPromise：场景里的导航/点击是 async IIFE，不 await 拿回来的是 Promise 对象。
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`页面脚本抛错：${r.exceptionDetails.text ?? 'unknown'}`)
    return r.result.value
  }
  // 首启弹窗（Preview Notice / 稍后配置）会挡住外壳：先点掉再等侧栏出现（英文界面同样要认）。
  const shell = await evaluate(`(async () => {
    const texts = (label) => [...document.querySelectorAll('a,button,div,span,p')].filter((n) => (n.innerText || '').trim() === label)
    for (let i = 0; i < 90; i += 1) {
      for (const label of ['Continue', '继续', 'Set up later', '稍后配置']) {
        const hit = texts(label).at(-1)
        if (hit) { hit.click(); await new Promise((r) => setTimeout(r, 800)) }
      }
      const nav = ['插件', 'Plugins'].some((label) => [...document.querySelectorAll('*')].some((n) => (n.innerText || '').trim() === label))
      if (nav) return 'ready'
      await new Promise((r) => setTimeout(r, 500))
    }
    return 'timeout'
  })()`)
  if (shell !== 'ready') throw new Error('等待应用外壳超时（侧栏没出现）')
  // 清掉首启弹窗并进入插件列表 → whale-girl 包页。
  const gotoPluginPage = `(async () => {
    const click = async (labels, ms) => {
      for (const label of labels) {
        const hit = [...document.querySelectorAll('a,button,[role="button"],[role="tab"],li,div,span,p')]
          .filter((n) => (n.innerText || '').trim() === label).at(-1)
        if (hit === undefined) continue
        hit.click()
        await new Promise((r) => setTimeout(r, ms))
        return true
      }
      return false
    }
    if (!(await click(['插件', 'Plugins'], 2500))) return 'no-plugins-nav'
    if (!(await click(['whale-girl'], 3000))) return 'no-plugin-card'
    return document.querySelector('[data-whale-girl-update]') === null ? 'no-update-row' : 'ok'
  })()`
  const landed = await evaluate(gotoPluginPage)
  if (landed !== 'ok') throw new Error(`没能停在更新行上（${landed}）`)
  // 记录端点请求：接线错位时这里一条都不会有。
  await evaluate(`(() => {
    window.__wgCalls = []
    const real = window.fetch
    window.fetch = (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : String(args[0]?.url ?? '')
      if (url.includes('/whale-girl/update')) window.__wgCalls.push({ url, method: String(args[1]?.method ?? 'GET').toUpperCase() })
      return real(...args)
    }
    return 'ok'
  })()`)
  const rowState = () => evaluate(`(() => {
    const row = document.querySelector('[data-whale-girl-update]')
    const button = row.querySelector('button')
    return JSON.stringify({ status: row.innerText, label: button.innerText.trim(), disabled: button.disabled, primary: button.className.includes('primary') || getComputedStyle(button).backgroundColor !== 'rgba(0, 0, 0, 0)' })
  })()`)
  const clickRowButton = () => evaluate(`(() => {
    const button = document.querySelector('[data-whale-girl-update] button')
    button.click()
    return 'clicked'
  })()`)
  const waitFor = async (label, predicate, timeoutMs = 20000) => {
    const start = Date.now()
    let last = null
    while (Date.now() - start < timeoutMs) {
      last = JSON.parse(await rowState())
      if (predicate(last)) return last
      await sleep(500)
    }
    throw new Error(`等待 ${label} 超时（最后状态 ${JSON.stringify(last)}）`)
  }
  const settled = await waitFor('row-mounted', (view) => !view.label.includes('检查中'))
  log('row', `状态行「${settled.status.replace(/\n/gu, ' ')}」按钮「${settled.label}」`)
  if (settled.label.startsWith('检查更新')) {
    await clickRowButton()
    await waitFor('after-check', (view) => !view.label.includes('检查中'))
  }
  const ready = JSON.parse(await rowState())
  if (!ready.label.startsWith('更新到') && !ready.label.startsWith('改跟')) {
    throw new Error(`这个部署现在没有可更新版本（按钮是「${ready.label}」）——本场景需要一个有新版的环境`)
  }
  await clickRowButton()
  const calls = async () => JSON.parse(await evaluate('JSON.stringify(window.__wgCalls)'))
  const start = Date.now()
  let posted = []
  while (Date.now() - start < 180000) {
    posted = (await calls()).filter((entry) => entry.method === 'POST')
    const view = JSON.parse(await rowState())
    if (posted.length > 0 && !view.label.includes('更新中')) break
    await sleep(1000)
  }
  if (posted.length === 0) throw new Error('点了更新按钮却没有发出 POST /whale-girl/update（按钮接线断了）')
  const after = await waitFor('after-update', (view) => !view.label.includes('更新中'), 180000)
  log('result', `发出 ${posted.length} 次 POST，状态行「${after.status.replace(/\n/gu, ' ')}」`)
  const exceptions = await evaluate(`(() => {
    const row = document.querySelector('[data-whale-girl-update]')
    return row.innerText.includes('TypeError') ? 'TypeError' : 'ok'
  })()`)
  if (exceptions !== 'ok') throw new Error('更新行显示了异常文本')
  return { posted: posted.length, label: after.label, status: after.status.replace(/\n/gu, ' ') }
}

// ---- 场景：会话记忆回读气泡（/state 的 memory 字段 → 气泡文案 → 按 at 去重）----
// memory 是 Node half 与 client 之间唯一的记忆通路：字段名、形状或去重键任一处漂移，气泡就静默消失
// （不报错、宠物照常跑），所以必须真在浏览器里看一眼。用 CDP Fetch 拦 /state 响应注入 memory
// （其余字段原样透传，不动宠物状态机），断言「出现 → 同一 at 不重播 → at 变化再播」。
// 不依赖真实任务/会话边沿（那要求 60s 窗口内正好有一次 resume/fork），因此可重复跑。
async function memoryBubble({ call, log, on }) {
  await call('Runtime.evaluate', { expression: `(() => {
    const t = document.getElementById('deepseek-onboarding-title')
    if (t) t.remove()
    const labelled = document.querySelector('[aria-labelledby="deepseek-onboarding-title"]')
    if (labelled) labelled.remove()
    return 'ok'
  })()`, returnByValue: true })
  await sleep(1500) // 等 onboarding 隐藏的宠物恢复显示（syncInert 经 MutationObserver）

  let injected = null // null = 透传真实响应；否则把它作为 memory 字段下发
  let hits = 0
  on('Fetch.requestPaused', async (params) => {
    try {
      if (injected === null) {
        await call('Fetch.continueRequest', { requestId: params.requestId })
        return
      }
      const body = await call('Fetch.getResponseBody', { requestId: params.requestId })
      const text = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8').toString('utf8')
      const payload = JSON.parse(text)
      payload.memory = injected
      hits += 1
      await call('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      })
    } catch { /* 页面卸载/请求取消时 fulfill 会失败：与断言无关，忽略 */ }
  })
  await call('Fetch.enable', { patterns: [{ urlPattern: '*whale-girl/state*', requestStage: 'Response' }] })

  const readBubble = async () => {
    const r = await call('Runtime.evaluate', { expression: `(() => {
      const b = document.querySelector('[data-whale-girl] .pet-bubble')
      return JSON.stringify(b === null ? null : b.textContent)
    })()`, returnByValue: true })
    return JSON.parse(r.result.value)
  }
  /** 等气泡变成期望值（want=null 表示等它消失）；轮询间隔 pollMs 默认 3s，超时给足三轮。 */
  const waitBubble = async (want, what) => {
    const deadline = Date.now() + 12000
    for (;;) {
      const text = await readBubble()
      if (text === want) return text
      if (Date.now() > deadline) throw new Error(`${what}：气泡是 ${JSON.stringify(text)}，期望 ${JSON.stringify(want)}`)
      await sleep(200)
    }
  }

  // ① 首次下发：气泡出现，文案由 memoryLine 生成（distance 0 → 「上次你们完成了…」）。
  injected = { at: 1, distance: 0, title: null, tasks: [{ label: '修复门禁', ok: true, at: 1 }] }
  await waitBubble('上次你们完成了「修复门禁」', '首次回读')
  log('memory-bubble', `气泡出现「上次你们完成了「修复门禁」」（已拦截 /state ${hits} 次）`)

  // ② 同一个 at 继续下发：气泡寿命（bubbleMs 默认 2.5s）过后不得重播——去重键是 at，不是「每轮都播」。
  await waitBubble(null, '气泡消失')
  await sleep(8000) // ≥2 轮轮询
  const replayed = await readBubble()
  if (replayed !== null) throw new Error(`同一 at 重播了气泡：${JSON.stringify(replayed)}`)
  log('memory-bubble', '同一 at 未重播（去重生效）')

  // ③ at 变化（等价于新的 resume/fork 边沿）→ 再播一次；distance>0 走分支文案，失败任务不进文案。
  injected = {
    at: 2,
    distance: 1,
    title: null,
    tasks: [{ label: '补决策记录', ok: true, at: 2 }, { label: '跑挂的门禁', ok: false, at: 2 }],
  }
  await waitBubble('上次在分支前的会话里完成了「补决策记录」', 'at 变化后重播')
  log('memory-bubble', 'at 变化后重播（分支文案，ok:false 的任务不进文案）')
  return { hits }
}

const SCENARIOS = { 'sleep-drag-wake': sleepDragWake, 'update-row': updateRow, 'memory-bubble': memoryBubble }

async function main() {
  const scenario = SCENARIOS[SCENARIO]
  if (scenario === undefined) {
    console.error(`未知场景 "${SCENARIO}"（可用：${Object.keys(SCENARIOS).join(', ')}）`)
    process.exit(2)
  }
  const { chrome, call, on } = await connect()
  try {
    const log = (label, detail) => console.log(`  [${label}] ${detail}`)
    console.log(`[verify-client-behavior] 场景 ${SCENARIO} @ ${URL}`)
    const result = await scenario({ call, log, on })
    console.log(`[verify-client-behavior] OK：${JSON.stringify(result)}`)
    process.exit(0)
  } catch (error) {
    console.error(`[verify-client-behavior] FAIL：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  } finally {
    chrome.kill()
  }
}

main()
