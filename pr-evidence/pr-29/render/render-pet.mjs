// 离屏渲染 whale-girl 宠物气泡（真实 client half 在无头浏览器里跑）。
//
// 真货清单：
//   - 宠物与气泡：各分支仓库的 lib/client/index.mjs 原文（apply() 传空 ctx → 跳过设置卡注册，
//     宠物本体只依赖 DOM），打包后由页面调用 apply()
//   - 气泡文案：lib/client/logic.mjs 的 memoryLine 纯函数真实输出（脚本再用 node import 独立复算一遍做断言）
//   - 素材：各分支仓库 lib/assets 的真实 manifest 与 sprite PNG
// 桩数据：宿主 /state 与 /config 的响应（见 STUB 注释），以及 bubbleMs 调大（只为截图窗口稳定）。
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, createReadStream, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createServer } from 'node:http'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'

const ROOT = '/tmp/wg-render'
const HARNESS = join(ROOT, 'harness')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'out')
const DSH = '/Users/li/deepseek-harness/default-workspace/dsh-src'
const THEME_CSS = ['base.css', 'design-platform.css', 'corner-shape.css', 'focus.css', 'scrollbar.css']
const CHROME = '/Users/li/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const VIEWPORT = { width: 580, height: 180 }

// STUB：会话记忆回读快照（Node half 的 memorySnapshot 形状：{at, distance, title, tasks}）。
// 任务条目形状 {label, ok, at}（src/session-memory.mjs 的归一契约）。
const MEM_TASKS = [
  { label: '实现会话记忆回读', ok: true, at: 1760471000000 },
  { label: '补充单元测试与门禁', ok: true, at: 1760471100000 },
  { label: '跑 gates 全量（失败，不进气泡）', ok: false, at: 1760471200000 },
]
const AT = 1760471789000

const VARIANTS = [
  { id: 'before', dir: join(ROOT, 'before'), memory: null },
  { id: 'after-resume', dir: join(ROOT, 'after'), memory: { at: AT, distance: 0, title: '会话记忆回读', tasks: MEM_TASKS } },
  { id: 'after-fork', dir: join(ROOT, 'after'), memory: { at: AT, distance: 1, title: '会话记忆回读', tasks: MEM_TASKS } },
]

// STUB：宿主下发的体验层配置。/state 的 configRevision 触发客户端拉 /config。
const CONFIG = (sessionMemory) => ({
  enabled: true,
  sessionMemory,
  size: 110,
  opacity: 1,
  walk: { enabled: false, minWaitMs: 18000, maxWaitMs: 40000, minMs: 3000, maxMs: 6000, speedPxPerSec: 45 },
  sleepAfterMs: 60000,
  pollMs: 3000,
  bubbleMs: 600000, // 真实默认 2500ms；截图只调大时长让窗口稳定（不改视觉）
})

// STUB：宿主 /state。pet 数值取自 pet-state.mjs 的形状（level/xp/stats/titles/memory）。
const STATE = (memory) => ({
  apiVersion: 1,
  pet: {
    level: 3,
    xp: 150,
    titles: ['初次协作', '勤劳伙伴'],
    stats: { tasksDone: 24, failures: 0, sessions: 3, activeMs: 0, firstSeenAt: null },
    memory: ['[10-14 23:01] 完成任务：补充会话记忆单测'],
  },
  activity: { name: 'idle', until: 0 },
  configRevision: 1,
  companionOnline: false,
  ...(memory === null ? {} : { memory }),
})

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }

async function build() {
  rmSync(join(DIST, 'pet'), { recursive: true, force: true })
  mkdirSync(join(DIST, 'pet'), { recursive: true })
  mkdirSync(join(DIST, 'theme'), { recursive: true })
  for (const f of THEME_CSS) copyFileSync(join(DSH, 'packages/client/ui-theme/src/styles', f), join(DIST, 'theme', f))
  const built = new Set()
  for (const v of VARIANTS) {
    if (built.has(v.dir)) continue
    built.add(v.dir)
    const id = v.id
    const entry = join(DIST, 'pet', `${id}.entry.mjs`)
    writeFileSync(entry, `import { apply } from '${v.dir}/lib/client/index.mjs'\napply()\n`)
    await esbuild.build({
      entryPoints: [entry], outfile: join(DIST, 'pet', `${id}.js`), bundle: true, format: 'iife',
      platform: 'browser', target: 'chrome120', jsx: 'automatic', loader: { '.css': 'local-css' },
      alias: { '@deepseek-ai/dsh-client-ui-primitives': join(HARNESS, 'primitives-shim.mjs') },
      absWorkingDir: ROOT, logLevel: 'warning',
    })
    writeFileSync(join(DIST, 'pet', `${id}.html`), `<!doctype html>
<html lang="zh-CN" data-platform="darwin"><head><meta charset="utf-8">
${THEME_CSS.map((f) => `<link rel="stylesheet" href="/theme/${f}">`).join('\n')}
<style>html,body{margin:0;height:100%}body{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}</style>
</head><body data-ds-dark-theme><script src="/pet/${id}.js"></script></body></html>`)
  }
  // after-resume / after-fork 共用 after 的 bundle 与页面，复制一份只有 id 不同的入口页。
  for (const v of VARIANTS) {
    const src = join(DIST, 'pet', `${VARIANTS.find((x) => x.dir === v.dir).id}.html`)
    const dst = join(DIST, 'pet', `${v.id}.html`)
    if (src !== dst) copyFileSync(src, dst)
  }
}

function serve(assetsDir, memory, config) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    if (p === '/whale-girl/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(STATE(memory))); return
    }
    if (p === '/whale-girl/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ config, revision: 1 })); return
    }
    if (p === '/whale-girl/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(':hello\n\n'); return // 保持打开，客户端不会反复重连
    }
    if (p.startsWith('/whale-girl/assets/')) {
      const file = join(assetsDir, 'lib/assets', p.slice('/whale-girl/assets/'.length))
      try { statSync(file); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }); createReadStream(file).pipe(res) }
      catch { res.writeHead(404); res.end('not found') }
      return
    }
    try {
      const body = readFileSync(join(DIST, p))
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  await build()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
  const expected = {}

  for (const v of VARIANTS) {
    const server = await serve(v.dir, v.memory, CONFIG(v.memory !== null))
    const base = `http://127.0.0.1:${server.address().port}`
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 })
    await page.goto(`${base}/pet/${v.id}.html`)
    await page.waitForSelector('.pet-sprite.ready', { timeout: 15000 })
    // 帧稳定：等到 idle 的第 0 帧（backgroundPosition 0px）并连续两次采样一致。
    await page.waitForFunction(() => {
      const s = document.querySelector('.pet-sprite.ready')
      return s !== null && /^0px 0px$/.test(s.style.backgroundPosition)
    }, { timeout: 15000 })
    if (v.memory !== null) {
      await page.waitForSelector('.pet-bubble', { timeout: 10000 })
      await page.waitForFunction(() => document.querySelector('.pet-bubble')?.textContent.length > 0)
    }
    await page.waitForTimeout(600) // 气泡入场动画 + 一帧稳态
    const info = await page.evaluate(() => ({
      sprite: document.querySelector('.pet-sprite.ready')?.style.backgroundPosition,
      bubble: document.querySelector('.pet-bubble')?.textContent ?? null,
      bubbleCount: document.querySelectorAll('.pet-bubble').length,
      box: (() => { const b = document.querySelector('.pet-bubble'); if (b === null) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
    }))
    expected[v.id] = info.bubble
    console.log(v.id, JSON.stringify(info))
    await page.locator('body').screenshot({ path: join(OUT, `bubble-${v.id}.png`), animations: 'disabled' })
    console.log('wrote bubble-' + v.id + '.png')
    await page.close()
    server.close()
  }
  await browser.close()
  console.log('bubble texts', JSON.stringify(expected, null, 1))
}

await main()
