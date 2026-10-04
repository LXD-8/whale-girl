// whale-girl 配置卡片（client half，React）——官方 plugins.item 槽（list 槽，
// Plugins 页「官方」组里的卡片；dsh-client-ui-plugin-manager 声明）。列表里一眼可见，
// 点开是卡片自己的页面：chrome（标题/描述）由页面画，本组件画 summary 一行描述、
// page 视图的字段区与保存脚注。
// 契约（client 半运行时缝）：
// - 注册：ctx.slots.inject('plugins.item', () => ctx.slots.register({ name, id, order,
//   label, locale, inject }, Card))——list 槽要 id（本插件用 bundle 包名字面量）；label 是
//   卡片标题（thunk，按当前语言重读）；配置读写与卡片 key 无关，靠 configForms 命名空间。
// - 传输：ctx.configForms.get(namespace)（官方 ConfigFormController，revision-fenced 文档
//   变更；写走 mutate 深路径 + CAS revision，见 settings-form.mjs）。注册经
//   configForms.whileServed([namespace])：宿主不服务该命名空间时不注册，不给空卡片。
// - 官方没有 Switch 组件：自绘轨道/滑块（开 brand-primary / 关 border-l2+bg-layer-2，滑块
//   label-primary-inverted，focus 环 interactive-bg-hover，role="switch"+aria-checked）。
// - locale 独立命名空间 settings.whale-girl（zh/en 两套，与 README 行为描述一致）。
// - 快照引用稳定由 settings-form.mjs 的 WhaleSettingsForm 保证（React #185 血泪）。
// 纯 DOM 卡片不可行：槽渲染方是 React（web-react 的 SlotOutlet），组件必须是 React 组件；
// react 由平台种子表提供（esbuild --external:react，bundle 内 require('react')）。

import React from 'react'
import { CARD_FIELDS, parseLines, serializeLines, WhaleSettingsForm } from './settings-form.mjs'

/** 卡片 locale 命名空间（独立于设置命名空间 'whale-girl'）。 */
export const SETTINGS_NS = 'settings.whale-girl'

/** 卡片文案（zh/en；与 README 配置节行为描述保持一致）。 */
export const zh = {
  title: '鲸鱼娘',
  description: '尺寸、透明度、游走与回话文案（保存即生效）',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: '本次保存未全部生效，已保留供你修改。',
  readOnly: '当前部署只读，无法修改。',
  enabled: '网页端显示',
  'enabled.hint': '关闭后网页端宠物不渲染（桌面伴侣并存时用）。',
  size: '尺寸',
  'size.hint': '宠物绘制尺寸（64–160 px）。',
  opacity: '透明度',
  'opacity.hint': '常态透明度（0.2–1）。',
  walk: '游走',
  'walk.hint': '关闭后宠物不再四处游走。',
  sleep: '睡眠等待',
  'sleep.hint': '空闲多久进入睡眠（毫秒）。',
  feed: '投喂回话',
  'feed.hint': '每行一条，空行忽略；清空回退内置文案。',
  play: '玩耍回话',
  'play.hint': '每行一条，空行忽略；清空回退内置文案。',
}

export const en = {
  title: 'Whale Girl',
  description: 'Size, opacity, wandering and reply copy — saves live',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept all values; they were left for you to correct.',
  readOnly: 'This deployment is read-only.',
  enabled: 'Show on page',
  'enabled.hint': 'Off hides the in-page pet (e.g. while a desktop companion runs).',
  size: 'Size',
  'size.hint': 'Pet render size (64–160 px).',
  opacity: 'Opacity',
  'opacity.hint': 'Default opacity (0.2–1).',
  walk: 'Wander',
  'walk.hint': 'Off stops the pet wandering.',
  sleep: 'Sleep delay',
  'sleep.hint': 'Idle time before sleeping (ms).',
  feed: 'Feed replies',
  'feed.hint': 'One per line, empty lines ignored; empty falls back to built-in copy.',
  play: 'Play replies',
  'play.hint': 'One per line, empty lines ignored; empty falls back to built-in copy.',
}

const el = React.createElement

/** 官方质感自绘 Switch（无官方组件；语义 role="switch" + aria-checked）。 */
function Switch({ checked, disabled, label, onChange }) {
  const [focused, setFocused] = React.useState(false)
  return el('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    disabled,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onClick: () => { onChange(!checked) },
    style: {
      flex: 'none', width: 34, height: 20, borderRadius: 999, border: '1px solid',
      cursor: disabled ? 'not-allowed' : 'pointer', appearance: 'none', padding: 0,
      position: 'relative', boxSizing: 'border-box', transition: 'background .16s, border-color .16s',
      background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
      borderColor: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
      opacity: disabled ? 0.4 : 1,
      outline: focused ? '2px solid var(--dsw-alias-interactive-bg-hover)' : 'none',
      outlineOffset: 2,
    },
  }, el('span', {
    style: {
      position: 'absolute', top: 2, left: checked ? 16 : 2, width: 14, height: 14,
      borderRadius: 999, background: 'var(--dsw-alias-label-primary-inverted)',
      transition: 'left .16s',
    },
  }))
}

/** 数字输入（本地文本暂存，失焦/回车提交解析后的值；解析失败回退当前值）。 */
function NumberField({ value, min, max, step, disabled, label, onChange }) {
  const initial = value === undefined || value === null ? '' : String(value)
  const [text, setText] = React.useState(initial)
  const [lastKey, setLastKey] = React.useState(initial)
  // 渲染期同步：外部值变化（保存生效/他端写入）时重置文本；lastKey 防重渲循环。
  if (initial !== lastKey) {
    setLastKey(initial)
    setText(initial)
  }
  const commit = () => {
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      setText(initial)
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    onChange(clamped)
    if (clamped !== parsed) setText(String(clamped))
  }
  return el('input', {
    type: 'number', value: text, min, max, step, disabled,
    'aria-label': label,
    onChange: (e) => { setText(e.target.value) },
    onBlur: commit,
    onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
    style: {
      flex: 'none', width: 104, padding: '4px 8px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
      textAlign: 'right', boxSizing: 'border-box', opacity: disabled ? 0.4 : 1,
    },
  })
}

/** 文案池输入（textarea，每行一条；失焦提交 parseLines 结果）。 */
function LinesField({ value, disabled, label, onChange }) {
  const initial = serializeLines(value)
  const [text, setText] = React.useState(initial)
  const [lastKey, setLastKey] = React.useState(initial)
  if (initial !== lastKey) {
    setLastKey(initial)
    setText(initial)
  }
  return el('textarea', {
    rows: 3,
    value: text,
    disabled,
    'aria-label': label,
    onChange: (e) => { setText(e.target.value) },
    onBlur: () => { onChange(parseLines(text)) },
    style: {
      flex: 'none', width: 220, padding: '4px 8px', borderRadius: 8, resize: 'vertical',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12,
      lineHeight: 1.5, boxSizing: 'border-box', opacity: disabled ? 0.4 : 1,
    },
  })
}

/** Plugins 页卡片的配置表单（plugins.item 槽组件；页面画标题/描述，
 * 本组件只画 summary 一行与 page 的字段区/保存脚注；dsw alias tokens 从应用 CSS 取）。 */
export function WhaleSettingsCard(props) {
  // hooks 先于视图分支：summary 与 page 两处渲染共用同一钩子序列（React 钩子顺序稳定）。
  const state = props.useWhaleSettings((s) => s)
  const t = props.t
  if (props.view === 'summary') return t('description')
  if (!state.available) return null
  const disabled = !state.writable
  const blocked = !state.dirty || state.saving

  const row = (def, index) => {
    const control = def.kind === 'toggle'
      ? el(Switch, { checked: state.fields[def.path] === true, disabled, label: t(def.labelKey), onChange: (checked) => { props.edit(def.path, checked) } })
      : def.kind === 'number'
        ? el(NumberField, { value: state.fields[def.path], min: def.min, max: def.max, step: def.step, disabled, label: t(def.labelKey), onChange: (value) => { props.edit(def.path, value) } })
        : el(LinesField, { value: state.fields[def.path], disabled, label: t(def.labelKey), onChange: (lines) => { props.edit(def.path, lines) } })
    return el('div', {
      key: def.path,
      style: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
        borderBottom: index < CARD_FIELDS.length - 1 ? '1px solid var(--dsw-alias-border-l1)' : 'none',
      },
    }, el('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      el('span', { style: { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' } }, t(def.labelKey)),
      el('span', { style: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-line' } }, t(`${def.labelKey}.hint`)),
    ), control)
  }

  return el('div', {
    'data-whale-girl-settings-card': '',
    style: { display: 'flex', flexDirection: 'column', boxSizing: 'border-box' },
  },
  disabled ? el('p', { role: 'status', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('readOnly')) : null,
  el('div', { style: { display: 'flex', flexDirection: 'column', gap: 0 } },
    CARD_FIELDS.map((def, index) => row(def, index)),
  ),
  el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
    state.failed
      ? el('p', { role: 'status', style: { flex: 1, minWidth: 0, margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' } }, t('saveFailed'))
      : state.dirty
        ? el('span', {
          style: {
            flex: 1, borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px',
            fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, t('unsaved'))
        : el('span', { style: { flex: 1 } }),
    el('button', {
      type: 'button', disabled: blocked, onClick: () => { props.discard() },
      style: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', opacity: blocked ? 0.4 : 1,
      },
    }, t('discard')),
    el('button', {
      type: 'button', disabled: blocked, onClick: () => { void props.save() },
      style: {
        appearance: 'none', border: '1px solid transparent', borderRadius: 8,
        padding: '5px 14px', font: 'inherit', fontSize: 13, lineHeight: 1.5, cursor: 'pointer',
        background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
        opacity: blocked ? 0.4 : 1,
      },
    }, state.saving ? t('saving') : t('save')),
  ),
  )
}

/**
 * 注册配置卡片（`plugins.item` 卡片 + locale）。返回 disposer（随 apply dispose 调用）。
 * @param {object} ctx 浏览器 half 上下文（inject 声明 slots/locale/configForms）
 * @param {string} namespace 设置命名空间（= 条目 id，配置读写用）
 * @param {object} defaults 叶默认值兜底（index.mjs 传 CFG_DEFAULTS）
 */
export function registerWhaleSettingsCard(ctx, namespace, defaults) {
  const scope = ctx.configForms.get(namespace)
  const form = new WhaleSettingsForm(scope, defaults)
  const offForm = ctx.effect(() => () => form.dispose(), 'whale-girl: settings form subscription')
  const offLocale = ctx.locale.register(SETTINGS_NS, { zh, en })
  // 注册经 whileServed：命名空间进宿主 describe 镜像后才注册（宿主不服务该命名空间时不留卡片），
  // 离开后自动移除。slots.inject 等槽声明（Plugins 页挂载）后注册。
  // 槽选 plugins.item（list 槽，官方组卡片）而不是 plugins.bundle.config：后者要先进包页才见，
  // 前者在 Plugins 页列表里一眼可见；本插件是自有 bundle，两个缝都合法，取发现性。
  const offServed = ctx.configForms.whileServed([namespace], () =>
    ctx.slots.inject('plugins.item', () =>
      ctx.slots.register({
        name: 'plugins.item',
        id: namespace, // list 槽只要求唯一；本插件取包名/命名空间同一字面量
        order: 50, // 官方同族卡片占 10–40，第三方排在它们之后
        label: () => ctx.locale.bind(SETTINGS_NS)('title'),
        locale: SETTINGS_NS,
        inject: () => ({
          hooks: {
            whaleSettings: { getSnapshot: form.getSnapshot, subscribe: form.subscribe },
          },
          edit: form.edit,
          save: form.save,
          discard: form.discard,
        }),
      }, WhaleSettingsCard)))
  return () => { offServed(); offLocale(); offForm() }
}