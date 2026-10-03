// 门禁：client half 不得引用已退役的宿主缝名（verify-client-seams）。
// 拒绝不变量：lib/client/**（含生成物 lib/client.js）出现已从 dsh 客户端移除的缝名——
// 注入一个宿主不存在的服务会让整个 client 条目永久 pending（cordis 严格注入），
// 宠物与卡片一起消失，且只在 web 启动面板可见：静默失败，故用门禁兜住。
// 只读、确定性。
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')

/** 已退役的客户端缝名 → 现行替代（本表即契约；改 dsh 客户端缝时同步改这里）。 */
export const RETIRED_SEAMS = {
  settingsScope: 'configForms.get(namespace)（同步 settingsSchema）',
  'settings.plugin.item': 'plugins.item / plugins.bundle.config / plugins.row.config',
}

/** 扫描目标：client half 源码与生成产物。 */
function scanTargets(root) {
  const dir = join(root, 'lib', 'client')
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).map((name) => join(dir, name))
  files.push(join(root, 'lib', 'client.js'))
  return files
}

/** 校验 client half 缝名。返回 { ok, errors }。 */
export function check(root = ROOT) {
  const errors = []
  let targets
  try {
    targets = scanTargets(root)
  } catch {
    return { ok: false, errors: ['lib/client: 无法列举（client half 源码目录缺失）'] }
  }
  for (const file of targets) {
    let src
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      errors.push(`${file.slice(root.length + 1)}: 无法读取（client half 产物缺失）`)
      continue
    }
    for (const [name, replacement] of Object.entries(RETIRED_SEAMS)) {
      if (src.includes(name)) {
        errors.push(`${file.slice(root.length + 1)}: 引用已退役的客户端缝名 ${name}（现行：${replacement}）`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

// CLI 入口（被 import 时不执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { ok, errors } = check()
  for (const e of errors) console.error(`[verify-client-seams] ${e}`)
  if (!ok) {
    console.error(`[verify-client-seams] ${errors.length} 处违规`)
    process.exit(1)
  }
  console.log('[verify-client-seams] OK（client half 只用现行宿主缝名）')
}
