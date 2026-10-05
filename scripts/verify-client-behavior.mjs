// 浏览器级行为验证（人工验证步骤，非门禁——依赖 Chrome 与运行中的 web，同 verify-client-smoke）。
// 用法：node scripts/verify-client-behavior.mjs <web-url> [scenario]
// 场景：sleep-drag-wake（默认）——验证「sleep → 拖拽 → 放下 → idle 缓冲 → wake → 保持清醒
// 不回 sleep」完整链路（v6 交互醒觉回归防线，见决策记录 2026-08-10-client-behavior-probe.md）。
// 场景：update-row——验证配置卡片的更新行「点检查 → 点更新 → 真的发出 POST /whale-girl/update」链路
// （需要部署里确实有新版可更新；按钮接线错位这类问题只有真点一下才暴露）。
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
  await call('Runtime.enable')
  return { chrome, call }
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

const SCENARIOS = { 'sleep-drag-wake': sleepDragWake, 'update-row': updateRow }

async function main() {
  const scenario = SCENARIOS[SCENARIO]
  if (scenario === undefined) {
    console.error(`未知场景 "${SCENARIO}"（可用：${Object.keys(SCENARIOS).join(', ')}）`)
    process.exit(2)
  }
  const { chrome, call } = await connect()
  try {
    const log = (label, detail) => console.log(`  [${label}] ${detail}`)
    console.log(`[verify-client-behavior] 场景 ${SCENARIO} @ ${URL}`)
    const result = await scenario({ call, log })
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
