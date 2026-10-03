// 门禁：配置默认值与命名空间同一性（verify-config-sync）。
// 拒绝不变量：
// 1. client 的 CFG_DEFAULTS 字面量与 src/config.mjs 的 DEFAULTS 数值不一致
//    （配置默认值只能有一个权威——Node half 引用 DEFAULTS，client bundle 因平台模块
//    限制不能 import src/config.mjs，但字面量必须与 DEFAULTS 数值同步，漂移即红）；
// 2. 设置命名空间的四处声明不同名：cordis.patch.yml 的 insert 条目 id、package.json 包名、
//    src/config.mjs NAMESPACE、client/index.mjs SETTINGS_NAMESPACE 字面量
//    （宿主以**条目 id** 作为设置命名空间、以**包名**作为 plugins.bundle.config 的 key，
//    卡片 key = 命名空间——任一处改名而其余不同步，卡片静默不出现或设置面不再被读取）。
// 只读、确定性。
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')

/**
 * 提取 JS 源码里 `KEY: value` 数值字面量（含嵌套对象）。
 * @param {string} src 源码
 * @param {string} objectName 目标对象名（如 'DEFAULTS' / 'CFG_DEFAULTS'）
 * @returns {{ [key: string]: number | boolean | object }} 扁平化的键→数值映射
 */
function extractNumericLeaf(src, objectName) {
  // 支持 `NAME = { ... }` 与 `NAME = Object.freeze({ ... })`
  const re = new RegExp(`${objectName}\\s*=\\s*(?:Object\\.freeze\\()?(\\{[\\s\\S]*?\\n\\})(?:\\))?`)
  const m = re.exec(src)
  if (m === null) return null
  // 用 Function 求值提取纯字面量对象（无执行副作用——字面量仅数字/布尔/对象）
  const obj = new Function(`return (${m[1]})`)()
  return flatten(obj)
}

function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
    else out[key] = v
  }
  return out
}

/** 取 cordis.patch.yml 中 `insert:` 下的第一个条目 id（条目 id = 宿主设置命名空间）。 */
function patchEntryId(patchSrc) {
  let insertIndent = null
  for (const line of patchSrc.split('\n')) {
    const insert = /^(\s*)-\s*insert:/.exec(line)
    if (insert !== null) {
      insertIndent = insert[1].length
      continue
    }
    if (insertIndent === null) continue
    const entry = /^(\s*)-\s*id:\s*(\S+)/.exec(line)
    if (entry !== null && entry[1].length > insertIndent) return entry[2].replace(/['"]/g, '')
  }
  return null
}

/** 提取设置命名空间的四处声明。 */
function identity(root) {
  const patchSrc = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const pkgSrc = readFileSync(join(root, 'package.json'), 'utf8')
  const configSrc = readFileSync(join(root, 'lib', 'src', 'config.mjs'), 'utf8')
  const clientSrc = readFileSync(join(root, 'lib', 'client', 'index.mjs'), 'utf8')
  return {
    'cordis.patch.yml 条目 id': patchEntryId(patchSrc),
    'package.json 包名': JSON.parse(pkgSrc).name ?? null,
    'src/config.mjs NAMESPACE': /export const NAMESPACE\s*=\s*['"]([^'"]+)['"]/.exec(configSrc)?.[1] ?? null,
    'client SETTINGS_NAMESPACE': /const SETTINGS_NAMESPACE\s*=\s*['"]([^'"]+)['"]/.exec(clientSrc)?.[1] ?? null,
  }
}

/** 校验配置默认值与命名空间同一性。返回 { ok, errors }。 */
export function check(root = ROOT) {
  const errors = []
  const configSrc = readFileSync(join(root, 'lib', 'src', 'config.mjs'), 'utf8')
  const clientSrc = readFileSync(join(root, 'lib', 'client', 'index.mjs'), 'utf8')

  const defaults = extractNumericLeaf(configSrc, 'DEFAULTS')
  const clientDefaults = extractNumericLeaf(clientSrc, 'CFG_DEFAULTS')
  if (defaults === null) {
    return { ok: false, errors: ['src/config.mjs 未找到 DEFAULTS 对象'] }
  }
  if (clientDefaults === null) {
    return { ok: false, errors: ['client/index.mjs 未找到 CFG_DEFAULTS 对象'] }
  }

  // client 的 CFG_DEFAULTS 应与 DEFAULTS 的子集一致（client 只消费部分项）。
  for (const [key, value] of Object.entries(clientDefaults)) {
    if (!(key in defaults)) {
      errors.push(`client CFG_DEFAULTS.${key} 不在 src/config.mjs DEFAULTS（配置项须先声明于 config.mjs）`)
      continue
    }
    if (defaults[key] !== value) {
      errors.push(`client CFG_DEFAULTS.${key} = ${value} ≠ src/config.mjs DEFAULTS.${key} = ${defaults[key]}（默认值单一来源，漂移即改两处之一）`)
    }
  }

  // 命名空间同一性：四处声明必须同名（缺声明也是违规——漂移后无从对齐）。
  const names = identity(root)
  const reference = names['src/config.mjs NAMESPACE']
  for (const [label, value] of Object.entries(names)) {
    if (value === null || value === '') {
      errors.push(`${label}：未找到设置命名空间声明（四处须同名：条目 id / 包名 / NAMESPACE / SETTINGS_NAMESPACE）`)
    } else if (reference === null) {
      break
    } else if (value !== reference) {
      errors.push(`${label} = ${value} ≠ src/config.mjs NAMESPACE = ${reference}（设置命名空间 = 条目 id = 包名 = 卡片 key）`)
    }
  }
  return { ok: errors.length === 0, errors }
}

// CLI 入口（被 import 时不执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { ok, errors } = check()
  for (const e of errors) console.error(`[verify-config-sync] ${e}`)
  if (!ok) {
    console.error(`[verify-config-sync] ${errors.length} 处违规`)
    process.exit(1)
  }
  console.log('[verify-config-sync] OK（默认值与命名空间同一性：条目 id / 包名 / NAMESPACE / client 字面量）')
}
