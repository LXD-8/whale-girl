// 会话记忆（纯逻辑：零宿主依赖、零 IO，可单测）。
// 契约：
// - 存储是「sessionId → { parent?, title?, subagent?, at, tasks[] }」的独立文件（data/whale-girl/sessions.json，
//   与宠物账本 state.json 分离——两者生命周期与容错策略不同，见 src/persistence.mjs 的账本契约）。
// - 淘汰分预算：用户会话 SESSIONS_MAX 条、subagent 子会话 SUBAGENT_SESSIONS_MAX 条，各按 at 淘汰。
//   子会话永不播报回读，一次密集委派 spawn 出的几十个子会话不得把用户自己的会话挤出账本。
// - 血缘回读：fork 的会话在 header 里带 parentSession（DSH 会话头字段），链上逐级找最近一条有任务
//   记录的会话——这就是「分支会话也记得上次做了什么」的来源；链断（祖先未被记录）即返回 null，
//   不猜。
// - 归属：任务 settle 事件带 owner（JobView.owner?: SessionId，宿主按 agent 会话授权的属主会话 id），
//   精确归属；无属主的任务退回最近活跃的**用户**会话（落在子会话上等于丢掉——它的记忆永不播报），
//   无会话则跳过（不猜）。
// - 容错：normalizeSessionMemory 对手改/旧文件逐字段容错，越界裁剪（会话数、每会话任务数、标签长度
//   都有上限），非法返回空账本——记忆丢失只影响气泡文案，不阻塞插件。
// - 记录是**本机状态文件**：不进入模型上下文、不写会话日志、不上传网络（设置卡说明与此一致）。
//
// 归属测试：tests/session-memory.test.mjs。

/** 保留的最近**用户**会话数（超出按 at 淘汰最旧）。 */
export const SESSIONS_MAX = 64
/** subagent 子会话条目的独立预算：子会话永不播报回读，不得与用户会话竞争 SESSIONS_MAX
 *  （一次密集委派能 spawn 几十个子会话，共用一个预算会把用户自己的会话挤出账本）。 */
export const SUBAGENT_SESSIONS_MAX = 16
/** 每会话保留的任务条数（环形，最新在末尾）。 */
export const TASKS_MAX = 8
/** 任务标签长度上限（标签由宿主生产者给出，裁剪防手改文件撑爆气泡）。 */
export const LABEL_MAX = 160
/** 会话标题长度上限。 */
export const TITLE_MAX = 120
/** 血缘回读最大跳数（防手改文件造出的环把遍历拖死）。 */
export const LINEAGE_HOPS_MAX = 8

/** 空记忆账本。 */
export function emptySessionMemory() {
  return { sessions: {} }
}

function str(v, max) {
  if (typeof v !== 'string' || v === '') return null
  const text = v.trim()
  if (text === '') return null
  return text.length > max ? text.slice(0, max) : text
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 任务条目归一：{ label, ok, at }；label 缺失或 at 非数丢弃。 */
function normalizeTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const label = str(raw.label, LABEL_MAX)
  const at = num(raw.at)
  if (label === null || at === null) return null
  return { label, ok: raw.ok !== false, at }
}

/** 会话条目归一：{ parent?, title?, subagent?, at, tasks }；会话 id 是账本的键、不进条目，非法整条丢弃。 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = num(raw.at)
  if (at === null) return null
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map(normalizeTask)
    .filter((task) => task !== null)
    .slice(-TASKS_MAX)
  const parent = str(raw.parent, 128)
  const title = str(raw.title, TITLE_MAX)
  return {
    ...(parent === null ? {} : { parent }),
    ...(title === null ? {} : { title }),
    ...(raw.subagent === true ? { subagent: true } : {}),
    at,
    tasks,
  }
}

/** 归一化保存的记忆账本；非法输入返回空账本（记忆可丢，不影响插件）。 */
export function normalizeSessionMemory(saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return emptySessionMemory()
  const raw = saved.sessions
  const entries = {}
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw)) {
      if (typeof id !== 'string' || id === '') continue
      const entry = normalizeEntry(value)
      if (entry !== null) entries[id] = entry
    }
  }
  return { sessions: pruneSessions(entries) }
}

/** 分预算淘汰：用户会话与 subagent 子会话各按 at 淘汰自己的额度——子会话再多也挤不掉用户会话。
 *  新写入的会话 at 最新，不会被误删；没有条目被淘汰时原样返回（同一引用）。 */
function pruneSessions(entries) {
  const users = []
  const subagents = []
  for (const id of Object.keys(entries)) (entries[id].subagent === true ? subagents : users).push(id)
  const within = (ids, max) => (ids.length <= max
    ? ids
    : [...ids].sort((a, b) => entries[b].at - entries[a].at).slice(0, max))
  const kept = [...within(users, SESSIONS_MAX), ...within(subagents, SUBAGENT_SESSIONS_MAX)]
  if (kept.length === Object.keys(entries).length) return entries
  return Object.fromEntries(kept.map((id) => [id, entries[id]]))
}

/** 序列化记忆账本为 JSON 文本。 */
export function serializeSessionMemory(memory) {
  return JSON.stringify(memory)
}

/**
 * 登记/更新一个会话（观测到会话边沿时调用）：补 parent 血缘与标题，刷新 at。
 * 已有条目保留 tasks（登记不覆盖记录）。`subagent: true` 一旦登记即粘住——origin 是会话创建时定死的，
 * 后续观测不得把它洗回用户会话（那会让子会话重新挤占用户会话的淘汰预算）。
 * @param {{sessions: object}} memory
 * @param {{id: string, parent?: string|null, title?: string|null, subagent?: boolean, at: number}} obs
 */
export function observeSession(memory, obs) {
  if (typeof obs?.id !== 'string' || obs.id === '' || num(obs.at) === null) return memory
  const existing = memory.sessions[obs.id]
  const parent = str(obs.parent, 128)
  const title = str(obs.title, TITLE_MAX)
  const subagent = obs.subagent === true || existing?.subagent === true
  const entry = {
    ...(parent === null ? (existing?.parent === undefined ? {} : { parent: existing.parent }) : { parent }),
    ...(title === null ? (existing?.title === undefined ? {} : { title: existing.title }) : { title }),
    ...(subagent ? { subagent: true } : {}),
    at: obs.at,
    tasks: existing?.tasks ?? [],
  }
  return { sessions: pruneSessions({ ...memory.sessions, [obs.id]: entry }) }
}

/**
 * 记一条任务（任务 settle 时调用）；会话未登记过则先建条目（parent/title 留待观测补齐）。
 * 同会话超出 TASKS_MAX 时丢最旧（任务在会话内的近期片段最有回忆价值）。
 */
export function recordTask(memory, sessionId, task) {
  if (typeof sessionId !== 'string' || sessionId === '') return memory
  const normalized = normalizeTask(task)
  if (normalized === null) return memory
  const existing = memory.sessions[sessionId] ?? { at: normalized.at, tasks: [] }
  const tasks = [...existing.tasks, normalized].slice(-TASKS_MAX)
  return { sessions: pruneSessions({ ...memory.sessions, [sessionId]: { ...existing, at: normalized.at, tasks } }) }
}

/**
 * 一次 agent/created 边沿是否值得播报回读快照。
 * subagent 子会话（header.origin === 'subagent'）是宿主内部委派——每次 subagent
 * spawn 都会发 agent/created，若在其上回读，宠物会在工作途中反复说「上次你们
 * 完成了…」，把重逢问候刷成噪音。只对用户会话（无 origin / 非 subagent）播报；
 * 子会话仍照常登记进账本（任务归属与血缘不丢）。
 */
export function recallable(header) {
  if (header === null || typeof header !== 'object') return true
  return header.origin !== 'subagent'
}

/**
 * 血缘回读：从 sessionId 起沿 parent 链找最近一条**有任务**的会话。
 * 自身有任务（resume 同会话）即返回自身；fork 新会话自身为空则上溯父链；
 * 链走到头、遇到未登记祖先或跳数/环越界即返回 null（不猜）。
 * @returns {{sessionId: string, title: string|null, tasks: object[], distance: number}|null}
 */
export function memoryFor(memory, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const seen = new Set()
  let current = sessionId
  for (let hop = 0; hop <= LINEAGE_HOPS_MAX; hop += 1) {
    if (current === null || seen.has(current)) return null
    seen.add(current)
    const entry = memory.sessions[current]
    if (entry === undefined) return null
    if (entry.tasks.length > 0) {
      return { sessionId: current, title: entry.title ?? null, tasks: [...entry.tasks], distance: hop }
    }
    current = entry.parent ?? null
  }
  return null
}

/** /state 下发的记忆快照：只带气泡要用的字段 + 读取时刻（窗口门控由调用方做）。 */
export function memorySnapshot(found, nowMs) {
  if (found === null) return null
  return { at: nowMs, distance: found.distance, title: found.title, tasks: found.tasks }
}
