// 离屏渲染 whale-girl 设置卡（before = main / after = feat/session-memory）。
//
// 真货清单：
//   - 卡片组件：各分支仓库的 lib/client/settings-card.mjs 原文（React 组件）
//   - 控件：dsh-src 里官方 @deepseek-ai/dsh-client-ui-primitives 的 Switch/Input/Button 源码 + 官方 CSS Module
//   - 主题：dsh-src 里官方 ui-theme 的 design-platform.css / base.css / corner-shape.css / focus.css / scrollbar.css
//   - 页壳：复刻 PluginManagerPage.module.css 的 .page / .detailSections / .detailSection 值（该槽没有自有卡片底色）
// 唯一人工项：宿主注入的 props（useWhaleSettings 快照、write、t=zh 文案表）——见下面 STUB 注释。
import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
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

// STUB：宿主注入的字段快照。取值 = src/config.mjs 的 DEFAULTS（after 分支多一个 sessionMemory:false，
// 与 patch 后新增的开关默认值一致）。before 分支的 CARD_FIELDS 没有该键，多传也无害。
const FIELDS = (extra) => ({
  enabled: true,
  size: 110,
  opacity: 1,
  'walk.enabled': true,
  sleepAfterMs: 60000,
  'replies.feed': ['「啊呜——谢谢投喂！」', '「好好吃，能量满满！」', '「嘻嘻，投喂成功！」'],
  'replies.play': ['「嘿嘿，再来一次！」', '「玩得好开心～」', '「我赢了！再来！」'],
  ...extra,
})

const BRANCHES = [
  { id: 'before', dir: join(ROOT, 'before'), extra: {} },
  { id: 'after', dir: join(ROOT, 'after'), extra: { sessionMemory: false } },
]

const entrySource = (dir, extra) => `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WhaleSettingsCard, zh } from '${dir}/lib/client/settings-card.mjs'

const FIELDS = ${JSON.stringify(FIELDS(extra))}
const state = { available: true, writable: true, fields: FIELDS }
const useWhaleSettings = (select) => select(state)
const write = (path, value) => { state.fields[path] = value; return Promise.resolve() }
const t = (key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)

function Harness() {
  return React.createElement(WhaleSettingsCard, { useWhaleSettings, write, t, view: 'page' })
}
createRoot(document.getElementById('card-slot')).render(React.createElement(Harness))
`

const html = (id) => `<!doctype html>
<html lang="zh-CN" data-platform="darwin">
<head>
<meta charset="utf-8">
${THEME_CSS.map((f) => `<link rel="stylesheet" href="theme/${f}">`).join('\n')}
<link rel="stylesheet" href="card-${id}.css">
<link rel="stylesheet" href="shell.css">
</head>
<body data-ds-dark-theme>
<div id="shot" class="page">
  <div class="detailSections">
    <section class="detailSection" data-plugin-config>
      <div id="card-slot"></div>
    </section>
  </div>
</div>
<script src="card-${id}.js"></script>
</body>
</html>
`

async function main() {
  rmSync(DIST, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(DIST, 'theme'), { recursive: true })
  mkdirSync(OUT, { recursive: true })
  for (const f of THEME_CSS) copyFileSync(join(DSH, 'packages/client/ui-theme/src/styles', f), join(DIST, 'theme', f))
  copyFileSync(join(HARNESS, 'shell.css'), join(DIST, 'shell.css'))

  for (const b of BRANCHES) {
    const entry = join(DIST, `card-${b.id}.entry.mjs`)
    writeFileSync(entry, entrySource(b.dir, b.extra))
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(DIST, `card-${b.id}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      jsx: 'automatic',
      loader: { '.css': 'local-css' },
      alias: {
        '@deepseek-ai/dsh-client-ui-primitives': join(HARNESS, 'primitives-shim.mjs'),
      },
      absWorkingDir: ROOT,
      logLevel: 'warning',
    })
    writeFileSync(join(DIST, `card-${b.id}.html`), html(b.id))
  }

  // 静态服务 + 更新端点桩：卡片首行 UpdateRow 会 GET /whale-girl/update。
  // STUB：宿主更新服务的检查结果（state:'up-to-date'，current 取包版本 0.2.0）。
  // 这一行不属于本 PR 的改动，桩成「已是最新」只为不让它显示红色的「检查失败」。
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/whale-girl/update') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ state: 'up-to-date', current: { version: '0.2.0' }, latest: null, canUpdate: false }))
      return
    }
    try {
      const body = readFileSync(join(DIST, url.pathname))
      res.writeHead(200, { 'content-type': MIME[extname(url.pathname)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 }, deviceScaleFactor: 2 })
  // 一过：量内容高度，取两者最大值当统一画框高度（before/after 同尺寸，只有新行不同）。
  let maxH = 0
  const heights = {}
  for (const b of BRANCHES) {
    await page.goto(`${base}/card-${b.id}.html`)
    await page.waitForSelector('[data-whale-girl-settings-card]')
    await page.evaluate(() => document.fonts.ready)
    heights[b.id] = await page.evaluate(() => Math.ceil(document.querySelector('#shot').getBoundingClientRect().height))
    maxH = Math.max(maxH, heights[b.id])
  }
  console.log('content heights', heights, '→ frame height', maxH)

  for (const theme of ['dark', 'light']) {
    for (const b of BRANCHES) {
      await page.goto(`${base}/card-${b.id}.html`)
      await page.waitForSelector('[data-whale-girl-settings-card]')
      if (theme === 'light') await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
      await page.evaluate((h) => { document.querySelector('#shot').style.minHeight = `${h}px` }, maxH)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(250)
      const name = `settings-card-${b.id}-${theme}.png`
      await page.locator('#shot').screenshot({ path: join(OUT, name), animations: 'disabled' })
      console.log('wrote', name)
    }
  }
  await browser.close()
  server.close()
}

await main()
