// 更新行的呈现状态与状态机（纯函数：零 React、零 DOM、零宿主依赖，可单测）。
//
// - `deriveUpdateRow({ info, phase, notice, noticeTone, translate, onCheck, onUpdate })` 把「Node half 的
//   检查结果 + 本地交互阶段」映射成这一行要画的东西：
//   `{ status, tone, action: { label, disabled, primary, run } }`——`run` 就是这次点击该调的处理函数
//   （检查或更新），组件只负责 `action.run()`，不在组件里再判一次状态。
// - `outcomeOf(payload, translate)` 把 POST /whale-girl/update 的结果映射成 `{ phase, notice, tone }`：
//   宿主的 application 有 applied / restart-required / overridden / failed / cancelled 五种，除了
//   「重启生效」和「热发布」，其余都必须说成失败而不是成功。
// - `reduceRow(state, event)` 是状态机本身：组件只派发事件，不再手工同步几个 useState
//   （漏设一次就差状态/差色）。
//
// 归属测试：tests/update-state.test.mjs。

/** 更新行的初始状态（组件与状态机共用同一份形状）。 */
export const ROW_INITIAL = { phase: 'loading', info: undefined, notice: undefined, noticeTone: 'default' }

/** 状态机：`check-started` / `checked` / `check-failed` / `update-started` / `settled`（带 phase/notice/tone）。 */
export function reduceRow(state, event) {
  switch (event?.type) {
    case 'check-started': return { ...state, phase: 'loading', notice: undefined, noticeTone: 'default' }
    case 'checked': return { ...state, phase: 'ready', info: event.info }
    case 'check-failed': return { ...state, phase: 'error' }
    case 'update-started': return { ...state, phase: 'updating', notice: undefined, noticeTone: 'default' }
    case 'settled': return { ...state, phase: event.phase, notice: event.notice, noticeTone: event.tone }
    default: return state
  }
}

/** 上游目标的显示名：git 安装用短提交，registry 安装用版本号。 */
function targetOf(info) {
  const latest = info?.latest
  if (latest === null || typeof latest !== 'object') return undefined
  if (typeof latest.commit === 'string' && latest.commit !== '') return latest.commit
  if (typeof latest.version === 'string' && latest.version !== '') return latest.version
  return undefined
}

/** 当前安装的短提交（只有 git 安装有；宿主页面的「来源信息」只显示版本号，提交只有这里能看到）。 */
function currentOf(info) {
  const commit = info?.current?.commit
  return typeof commit === 'string' && commit !== '' ? commit : undefined
}

/** 本地路径安装跟的那条线（只有本地安装带 ref；git/registry 安装没有）。 */
function refOf(info) {
  const ref = info?.latest?.ref
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/** 状态行文案：结论（已是最新 / 有新版 / 查不到）与进行中状态都写在这里，按钮只摆动作。 */
function statusOf({ info, phase, notice, target, current, translate: t }) {
  if (typeof notice === 'string' && notice !== '') return notice
  if (phase === 'loading') return t('checking')
  if (phase === 'updating') return t('updating')
  if (phase === 'error') return t('checkFailed')
  if (info?.state === 'up-to-date') return current === undefined ? t('latest') : t('latestAt', { current })
  if (info?.state === 'update-available') {
    if (target === undefined) return t('updateUnknown')
    // 有新版但宿主不提供包管理服务：状态行说完原因，按钮只留动作名。
    if (info?.canUpdate !== true) return t('availableUnsupported', { target })
    const ref = refOf(info)
    // 本地路径安装点更新会把 link: 换成跟上游那条线——这件事必须在点之前说出来。
    if (ref !== undefined && current !== undefined) return t('availableLocal', { target, current, ref })
    return current === undefined ? t('available', { target }) : t('availableAt', { target, current })
  }
  if (info?.reason === 'rate-limited') return t('checkRateLimited')
  if (info?.reason === 'local-source') return t('localSource')
  return t('updateUnknown')
}

/** 按钮：只摆动作，并选定这次点击该调的处理函数。已是最新、刚更新完、检查失败都留一个可点的
 * 「检查更新…」，不摆禁用结论。 */
function actionOf({ info, phase, target, translate: t, onCheck, onUpdate }) {
  const idle = { label: t('check'), disabled: false, primary: false, run: onCheck }
  if (phase === 'loading') return { label: t('checking'), disabled: true, primary: false, run: onCheck }
  if (phase === 'updating') return { label: t('updating'), disabled: true, primary: false, run: onCheck }
  if (phase === 'ready' && info?.state === 'update-available' && target !== undefined) {
    const ref = refOf(info)
    const label = ref === undefined ? t('updateTo', { target }) : t('updateToRef', { ref })
    return info?.canUpdate === true
      ? { label, disabled: false, primary: true, run: onUpdate }
      : { label, disabled: true, primary: false, run: onCheck }
  }
  return idle
}

/**
 * @param {{info?: object, phase: 'loading'|'ready'|'error'|'updating'|'done', notice?: string, noticeTone?: 'default'|'error', translate: (key: string, vars?: object) => string, onCheck: Function, onUpdate: Function}} input
 * @returns {{status: string, tone: 'default'|'error', action: {label: string, disabled: boolean, primary: boolean, run: Function}}}
 */
export function deriveUpdateRow({ info, phase, notice, noticeTone, translate, onCheck, onUpdate }) {
  const target = targetOf(info)
  const current = currentOf(info)
  return {
    status: statusOf({ info, phase, notice, target, current, translate }),
    // 提示色跟着结果走：成功的提示不该是报错红。
    tone: typeof notice === 'string' && notice !== '' && noticeTone === 'error' ? 'error' : 'default',
    action: actionOf({ info, phase, target, translate, onCheck, onUpdate }),
  }
}

/**
 * 更新动作的结果 → 界面状态。
 * @param {{state?: string, application?: string, errorCode?: string, errorDetail?: string}} payload
 * @param {(key: string, vars?: object) => string} translate
 * @returns {{phase: 'done'|'ready', notice: string, tone: 'default'|'error'}}
 */
/** 自家错误码 → 文案键（宿主的码我们不逐条翻译，只翻自己能给出的这几种）。 */
const FAILURE_KEYS = {
  'tracking-not-restored': 'updateFailedTracking',
  'unknown-enabled-state': 'updateFailedEnabled',
  'unsupported-source': 'updateFailedSource',
}

export function outcomeOf(payload, translate) {
  const t = translate
  switch (payload?.state) {
    case 'restart-required': return { phase: 'done', notice: t('updatedRestart'), tone: 'default' }
    case 'installed': return { phase: 'done', notice: t('updated'), tone: 'default' }
    case 'overridden': return { phase: 'done', notice: t('updatedOverridden'), tone: 'default' }
    case 'unsupported': return { phase: 'ready', notice: t('updateUnsupported'), tone: 'default' }
    case 'up-to-date': return { phase: 'ready', notice: t('latest'), tone: 'default' }
    // 检查本身没结论（限流 / 网络）：不是「更新失败」，别用报错色。
    case 'check-failed': return {
      phase: 'ready',
      notice: payload?.errorCode === 'rate-limited' ? t('checkRateLimited') : t('checkFailed'),
      tone: 'default',
    }
    default: {
      const spec = typeof payload?.pinnedSpec === 'string' && payload.pinnedSpec !== '' ? payload.pinnedSpec : undefined
      if (payload?.errorCode === 'tracking-not-restored' && spec !== undefined) {
        return { phase: 'ready', notice: t('updateFailedTracking', { spec }), tone: 'error' }
      }
      const key = payload?.errorCode === undefined ? undefined : FAILURE_KEYS[payload.errorCode]
      if (key !== undefined) return { phase: 'ready', notice: t(key), tone: 'error' }
      // 分隔符也走文案表，免得英文界面里冒出全角标点。
      const reason = [payload?.errorCode, payload?.errorDetail]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(t('reasonSeparator'))
      return {
        phase: 'ready',
        notice: reason === '' ? t('updateFailed') : t('updateFailedDetail', { reason }),
        tone: 'error',
      }
    }
  }
}
