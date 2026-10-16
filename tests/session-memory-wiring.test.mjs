// 会话记忆的接线测试：用最小假宿主起 Node half，直接驱动 agent/created · session/event ·
// jobs settled 边沿并调 /state 处理器——覆盖纯逻辑单测够不到的那一段：宿主缝名与事件载荷形状、
// 归属兜底、回读窗口、开关语义（零读零写 / 关闭边沿末次落盘）、子会话不播报。
// 归属：lib/index.mjs 里会话记忆接线的行为改动跑本文件；账本自身语义（血缘/裁剪/容错）在
// tests/session-memory.test.mjs（那边不需要宿主，跑得更快也更细）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_WINDOW_MS } from '../lib/src/snapshot.mjs'

/**
 * 起一个 Node half 实例（每个用例独立 DSH_HOME：记忆文件与宠物账本都落在里面）。
 * DSH_HOME 在模块加载时就被读走，所以必须在动态 import 之前设好。
 * @param {{sessionMemory?: boolean}} options 开关初值（volatile 叶子按宿主形状给 `{ get() }`）
 */
async function boot({ sessionMemory = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'whale-memory-'))
  process.env.DSH_HOME = home
  const memoryFile = join(home, 'data', 'whale-girl', 'sessions.json')
  const flags = { sessionMemory }
  const handlers = {}
  const routes = []
  const cleanups = []
  let jobListener = null
  // 宿主的每个注册缝都返回 disposer（插件把它们收进数组，卸载时逐个调用）——假宿主同样得给。
  const services = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
  const ctx = {
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return () => {} },
    on: (event, handler) => { handlers[event] = handler; return () => {} },
    provide: () => () => {},
    get: (name) => services[name],
    agents: { list: () => [] },
    jobs: { list: () => [], events: { subscribe: (filter, listener) => { jobListener = listener; return () => {} } } },
    sessions: { list: () => [] },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  const module = await import(`../lib/index.mjs?memory-test=${Date.now()}${Math.random()}`)
  module.apply(ctx, { sessionMemory: { get: () => flags.sessionMemory } })
  const route = routes.find((candidate) => candidate.path === module.STATE_PATH)
  assert.ok(route !== undefined, '/state 路由应注册到 webServer')
  assert.ok(typeof jobListener === 'function', 'jobs 事件应被订阅')

  const readState = () => new Promise((resolve, reject) => {
    const req = { method: 'GET', headers: { host: '127.0.0.1:1234' }, url: module.STATE_PATH }
    const res = {
      status: 0,
      writeHead(code) { this.status = code },
      setHeader() {},
      end(payload) {
        try { resolve(JSON.parse(payload)) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  /** 记忆账本的磁盘内容（null = 文件不存在，即零写）。 */
  const ledger = () => (existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')) : null)
  const raw = () => (existsSync(memoryFile) ? readFileSync(memoryFile, 'utf8') : null)

  return {
    home,
    memoryFile,
    flags,
    ledger,
    raw,
    readState,
    /** 卸载（disable）：触发插件自己的末次落盘。 */
    dispose: () => { for (const cleanup of cleanups) cleanup() },
    /** 配置热更新边沿（volatile 叶子变了宿主发这个，不重挂载）。 */
    volatileUpdate: () => handlers['loader/volatile-update'](),
    /** agent 发布边沿：source 'startup'（新会话）或 'resume'（续接）。 */
    created: ({ id, source = 'resume', parentSession, origin }) => handlers['agent/created']({
      source,
      agent: { session: { id, header: { createdAt: Date.now(), ...(parentSession === undefined ? {} : { parentSession }), ...(origin === undefined ? {} : { origin }) } } },
    }),
    /** 会话事件边沿（turn/title 等）：这里只需要它登记会话与归属兜底。 */
    sessionEvent: (id, header = {}, event = { type: 'turn/start' }) => handlers['session/event']({ id, header }, event),
    /** 任务终态边沿（settled）：owner 缺省即「无属主」。 */
    settle: ({ owner, label = '任务', status = 'completed' }) => jobListener({
      type: 'settled',
      job: { id: `job-${label}-${Math.random()}`, label, status, ...(owner === undefined ? {} : { owner }) },
    }),
    cleanup: () => { rmSync(home, { recursive: true, force: true }) },
  }
}

test('开关关闭：零读零写，/state 不带 memory 字段', async () => {
  const bus = await boot({ sessionMemory: false })
  bus.sessionEvent('s1')
  bus.settle({ owner: 's1', label: '不该被记录' })
  bus.created({ id: 's1' })
  const body = await bus.readState()
  assert.equal('memory' in body, false, '关 = 不下发回读')
  assert.equal(bus.raw(), null, '关 = 不写记忆文件（连空账本也不建）')
  bus.dispose()
  assert.equal(bus.raw(), null, '卸载也不写')
  bus.cleanup()
})

test('开启后：任务按 owner 归属，同会话 resume 在窗口内下发回读', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 's1', label: '修复门禁' })
  bus.settle({ owner: 's1', label: '补决策记录', status: 'failed' })
  bus.created({ id: 's1' })
  const body = await bus.readState()
  assert.equal(body.memory.distance, 0, '自己的会话 → distance 0')
  assert.deepEqual(body.memory.tasks.map((task) => [task.label, task.ok]), [['修复门禁', true], ['补决策记录', false]])
  assert.equal(body.memory.title, null)
  assert.equal(typeof body.memory.at, 'number')
  // 卸载触发末次落盘：文件里是同一份归属（1s 防抖窗口内不必等真实时间）。
  bus.dispose()
  const ledger = bus.ledger()
  assert.deepEqual(Object.keys(ledger.sessions), ['s1'])
  assert.equal(ledger.sessions.s1.tasks.length, 2)
  bus.cleanup()
})

test('懒加载：开关从关拨到开才开始读写，此前的事件不补记', async () => {
  const bus = await boot({ sessionMemory: false })
  bus.settle({ owner: 's0', label: '开关关着时的任务' })
  bus.flags.sessionMemory = true
  bus.volatileUpdate()
  bus.settle({ owner: 's1', label: '开关开着时的任务' })
  bus.created({ id: 's1' })
  const body = await bus.readState()
  assert.deepEqual(body.memory.tasks.map((task) => task.label), ['开关开着时的任务'])
  bus.dispose()
  assert.deepEqual(Object.keys(bus.ledger().sessions), ['s1'], '关闭期间的任务不补记')
  bus.cleanup()
})

test('fork 血缘：child 的 resume 沿 parentSession 读到父会话任务（distance 1）', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 'parent', label: '父会话任务' })
  bus.created({ id: 'parent' })
  bus.created({ id: 'child', parentSession: 'parent' })
  const body = await bus.readState()
  assert.equal(body.memory.distance, 1)
  assert.deepEqual(body.memory.tasks.map((task) => task.label), ['父会话任务'])
  bus.dispose()
  assert.equal(bus.ledger().sessions.child.parent, 'parent', '血缘落盘，重启后仍可回读')
  bus.cleanup()
})

test('subagent 子会话：照常登记（含血缘与任务）但不播报回读', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 'parent', label: '父会话任务' })
  // 子会话 spawn：登记血缘、不生成回读快照——否则每次委派都刷一条重逢气泡。
  bus.created({ id: 'sub', parentSession: 'parent', origin: 'subagent' })
  assert.equal('memory' in await bus.readState(), false)
  bus.settle({ owner: 'sub', label: '子会话任务' })
  // 父会话自己的 resume 边沿照常播报（子会话 spawn 没有污染它）。
  bus.created({ id: 'parent' })
  assert.deepEqual((await bus.readState()).memory.tasks.map((task) => task.label), ['父会话任务'])
  bus.dispose()
  const ledger = bus.ledger()
  assert.equal(ledger.sessions.sub.subagent, true, '登记时打上子会话标记（走独立淘汰预算）')
  assert.equal(ledger.sessions.sub.parent, 'parent')
  assert.deepEqual(ledger.sessions.sub.tasks.map((task) => task.label), ['子会话任务'], '子会话的任务照样入账')
  bus.cleanup()
})

test('归属兜底：无属主任务落最近活跃的用户会话，子会话不抢兜底', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.sessionEvent('u1')
  bus.sessionEvent('sub', { origin: 'subagent' }) // 子会话更晚出现，但不是兜底目标
  bus.settle({ label: '无属主任务' })
  bus.dispose()
  const ledger = bus.ledger()
  assert.deepEqual(ledger.sessions.u1.tasks.map((task) => task.label), ['无属主任务'])
  assert.deepEqual(ledger.sessions.sub.tasks, [], '落到子会话等于丢掉——它的回读永不播报')
  bus.cleanup()
})

test('无属主且没见过任何用户会话：跳过不猜（不建条目、不播报）', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ label: '无属主任务' })
  bus.dispose()
  assert.equal(bus.raw(), null, '没有可归属的会话就不写文件')
  bus.cleanup()
})

test('回读窗口：MEMORY_WINDOW_MS 内下发，超窗即撤', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 's1', label: '窗口任务' })
  bus.created({ id: 's1' })
  assert.equal((await bus.readState()).memory.distance, 0)
  t.mock.timers.tick(MEMORY_WINDOW_MS - 1000)
  assert.equal((await bus.readState()).memory.distance, 0, '窗口内仍下发（客户端按 at 去重只播一次）')
  t.mock.timers.tick(2000)
  assert.equal('memory' in await bus.readState(), false, '超窗不再下发')
  bus.dispose()
  bus.cleanup()
})

test('关开关：先末次落盘再停写，未播报的回读即刻撤下', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 's1', label: '防抖窗口内的任务' })
  bus.created({ id: 's1' })
  assert.equal(bus.raw(), null, '1s 防抖内还没落盘')
  bus.flags.sessionMemory = false
  bus.volatileUpdate()
  // 关闭边沿把已记的写完：拨开关不该吞掉开启期间的记录。
  const flushed = bus.ledger()
  assert.deepEqual(flushed.sessions.s1.tasks.map((task) => task.label), ['防抖窗口内的任务'])
  assert.equal('memory' in await bus.readState(), false, '关开关即刻撤下回读')
  const before = bus.raw()
  bus.settle({ owner: 's1', label: '关闭之后的任务' })
  bus.created({ id: 's1' })
  bus.dispose()
  assert.equal(bus.raw(), before, '关闭后零写（含卸载路径）')
  bus.cleanup()
})

test('重新开启：从磁盘接着用，关闭期间的任务不在账本里', async () => {
  const bus = await boot({ sessionMemory: true })
  bus.settle({ owner: 's1', label: '开启时记的' })
  bus.flags.sessionMemory = false
  bus.volatileUpdate() // 关闭边沿落盘
  bus.settle({ owner: 's1', label: '关闭时记的' })
  bus.flags.sessionMemory = true
  bus.volatileUpdate() // 懒加载回磁盘内容
  bus.created({ id: 's1' })
  assert.deepEqual((await bus.readState()).memory.tasks.map((task) => task.label), ['开启时记的'])
  bus.dispose()
  assert.deepEqual(bus.ledger().sessions.s1.tasks.map((task) => task.label), ['开启时记的'])
  bus.cleanup()
})
