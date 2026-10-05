import { compareVersions } from './semver.mjs'

// 更新检查的纯逻辑（零宿主依赖、零网络，可单测）。
//
// 契约：
// - `parseInstallSource(spec)` 把 profile 记录下来的 pnpm spec 归一到
//   `{ kind: 'git', owner, repo, ref? }` 或 `{ kind: 'registry', name, version? }`；认不出返回 undefined。
//   spec 的来源与写法见 @deepseek-ai/dsh-plugin-manager 的 `listBundles().source`
//   （「git 地址或 URL 按记录给出」，registry 版本范围/标签接在包名之后）。
// - `readLockIdentity(lockText, name)` 从 profile 的 pnpm-lock.yaml 文本里一遍读出该包实际解析到
//   的东西：git 安装给 `sha`（只有锁文件知道装的是哪个提交，包的 package.json 版本号在 git 安装下
//   不随提交变化），registry 安装给 `version`。
// - 版本比较在 `src/semver.mjs`（自带测试）。
// - `decideUpdate(input)` 给出 'update-available' | 'up-to-date' | 'unknown' 三态判断。
// - `resolveGitHead(head, packedRefs)` 从 `.git/HEAD` 与 `.git/packed-refs` 的文本里解出提交
//   （本地路径安装要对上游那条线，得先知道本地检出的是哪个提交）。
// - `updateSpecs(parsed, target)` 给出这次要按顺序装的 spec 列表。
//
// 归属测试：tests/update.test.mjs。

/** GitHub 仓库归一到 `{ owner, repo }`；非 GitHub 或形状不对返回 undefined。
 * 只用于解析 git spec 本身（检查不再拿包清单的 repository 兜底来源）。 */
export function parseRepository(url) {
  if (typeof url !== 'string') return undefined
  const text = url.trim().replace(/^git\+/, '').replace(/\.git$/, '')
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/u.exec(text)
  if (ssh !== null) return { owner: ssh[1], repo: ssh[2] }
  const http = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)$/u.exec(text)
  if (http !== null) return { owner: http[1], repo: http[2] }
  return undefined
}

/** 去掉 owner/repo 里可能带的 `.git` 后缀。 */
function cleanRepo(repo) {
  return repo.replace(/\.git$/u, '')
}

/** pnpm spec 归一。认不出返回 undefined。 */
export function parseInstallSource(spec) {
  if (typeof spec !== 'string') return undefined
  const text = spec.trim()
  if (text === '') return undefined
  // 本地路径（绝对/相对/file:/link:）：profile 记录成路径，没有可查询的上游。
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('file:') || text.startsWith('link:')) {
    return { kind: 'local', path: text.replace(/^(?:file|link):/u, '') }
  }
  // github:owner/repo[#ref] 与裸 owner/repo[#ref] 简写。
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:#([^\s#]+))?$/u.exec(text)
  if (shorthand !== null && !text.includes('://')) {
    return { kind: 'git', owner: shorthand[1], repo: cleanRepo(shorthand[2]), ...(shorthand[3] === undefined ? {} : { ref: shorthand[3] }) }
  }
  // git+https://… / https://github.com/… / git@github.com:…
  if (/^(?:git\+|git:|git@|https?:\/\/)/u.test(text)) {
    const ref = text.includes('#') ? text.slice(text.indexOf('#') + 1) : undefined
    const bare = text.includes('#') ? text.slice(0, text.indexOf('#')) : text
    const repo = parseRepository(bare)
    if (repo === undefined) return undefined
    return { kind: 'git', owner: repo.owner, repo: repo.repo, ...(ref === undefined || ref === '' ? {} : { ref }) }
  }
  // registry：@scope/name@range 或 name@range（@ 只能有一个版本分隔符）。
  const at = text.startsWith('@') ? text.indexOf('@', 1) : text.indexOf('@')
  const registry = at > 0
    ? { kind: 'registry', name: text.slice(0, at), ...(text.slice(at + 1) === '' ? {} : { version: text.slice(at + 1) }) }
    : { kind: 'registry', name: text }
  // 名字必须长得像包名（可选一个 @scope/），版本范围里不该出现 `:`/`/`：`gitlab:owner/repo`、
  // `name@github:owner/repo` 这类别的托管写法认不出就别猜——猜成 registry 会拿垃圾名字去问 npm。
  const named = /^(?:@[^/@:\s]+\/)?[^/@:\s]+$/u.test(registry.name)
  const ranged = registry.version === undefined || !/[:/]/u.test(registry.version)
  return named && ranged ? registry : undefined
}

/** 从 profile 的 pnpm-lock.yaml 文本里一遍读出该包解析到的东西。
 * 锁键的三种写法：`<name>@https://…/tar.gz/<sha>`、`<name>@git+…#<sha>`、`<name>@github:owner/repo#<sha>`
 * 给 git 提交；`<name>@<version>` 给 registry 版本。 */
export function readLockIdentity(lockText, packageName) {
  const line = lockKeyLine(lockText, packageName)
  if (line === undefined) return {}
  const sha = /tar\.gz\/([0-9a-f]{7,40})/u.exec(line)?.[1]
    ?? /#([0-9a-f]{7,40})(?=[:\s(]|$)/u.exec(line)?.[1]
    ?? /([0-9a-f]{40})(?=[:\s(]|$)/u.exec(line)?.[1]
  const version = /@(\d[^:\s(']*)/u.exec(line)?.[1]
  return {
    ...(sha === undefined ? {} : { sha }),
    ...(version === undefined ? {} : { version }),
  }
}

/** 锁文件里该包自己的那一行键（YAML 键带缩进，scope 包名会被引号包住）。 */
function lockKeyLine(lockText, packageName) {
  if (typeof lockText !== 'string' || packageName === '') return undefined
  const quoted = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^\\s{2,}'?${quoted}@\\S*`, 'mu').exec(lockText)
  return match === null ? undefined : match[0]
}

/** 短的提交显示（7 位；不足 7 位原样返回）。 */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : ''
}

/**
 * 三态判断。
 * @param {{kind: 'git'|'registry', currentSha?: string, latestSha?: string, currentVersion?: string, latestVersion?: string}} input
 * @returns {'update-available'|'up-to-date'|'unknown'}
 */
export function decideUpdate(input) {
  // 防御性保留：调用方对本地安装用的是 git 语义（本地检出提交 vs 上游），这里仍挡住 kind: 'local'
  // 直接判断的情况，免得以后有人把它并回 registry 分支。
  if (input.kind === 'local') return 'unknown'
  if (input.kind === 'git') {
    const { currentSha, latestSha } = input
    if (typeof currentSha !== 'string' || typeof latestSha !== 'string') return 'unknown'
    if (currentSha === '' || latestSha === '') return 'unknown'
    return currentSha.startsWith(latestSha) || latestSha.startsWith(currentSha) ? 'up-to-date' : 'update-available'
  }
  const comparison = compareVersions(input.latestVersion, input.currentVersion)
  if (comparison === undefined) {
    if (input.latestVersion === undefined || input.currentVersion === undefined) return 'unknown'
    return input.latestVersion === input.currentVersion ? 'up-to-date' : 'update-available'
  }
  return comparison > 0 ? 'update-available' : 'up-to-date'
}

/**
 * 宿主的 `ChangeResult.application` → 界面的更新状态。
 * 只有 `applied`（有 HMR，热发布）与 `restart-required`（覆盖已装包）算装成功；`overridden` 单独一类；
 * `failed` / `cancelled` 以及任何未知或缺失的取值都算失败——不认识的结果不能当成功报给用户。
 * @param {unknown} application
 * @returns {'installed'|'restart-required'|'overridden'|'failed'}
 */
export function applicationState(application) {
  switch (application) {
    case 'applied': return 'installed'
    case 'restart-required': return 'restart-required'
    case 'overridden': return 'overridden'
    default: return 'failed'
  }
}

/**
 * 这次更新要按顺序装的 spec 列表。
 * 宿主用「profile 里的依赖串变了没有」定位这次装的是哪个包，原样重装同一条 spec 会被判
 * `ambiguous-install`（本机真实 dsh web 宿主实测），所以：
 * - git 分支/标签/默认分支：先装刚检查到的确切提交，再换回 profile 记的那条线（继续跟踪）；
 *   已经钉在某个提交上的安装，一次就够。
 * - registry：装检查到的版本，pnpm 默认存成 `^` 范围，本身还会前进。
 * - 本地路径安装：profile 里没有上游可跟，改写包清单声明的仓库的默认分支（`target.repo` +
 *   `target.ref`），装完就从「链到本地目录」变成「跟上游那条线」。
 * @param {{kind: 'git'|'registry'|'local', owner?: string, repo?: string, name?: string, ref?: string}} parsed
 * @param {{sha?: string, version?: string, ref?: string, repo?: {owner: string, repo: string}}} target 刚检查到的上游目标
 * @returns {{specs: string[]}|undefined} 认不出的来源或目标返回 undefined
 */
export function updateSpecs(parsed, target) {
  if (parsed === undefined || parsed === null || target === null || typeof target !== 'object') return undefined
  if (parsed.kind === 'git') {
    if (typeof target.sha !== 'string' || target.sha === '') return undefined
    const pinned = `github:${parsed.owner}/${parsed.repo}#${target.sha}`
    const moving = parsed.ref === undefined || !/^[0-9a-f]{7,40}$/u.test(parsed.ref)
    return { specs: moving ? [pinned, `github:${parsed.owner}/${parsed.repo}${parsed.ref === undefined ? '' : `#${parsed.ref}`}`] : [pinned] }
  }
  if (parsed.kind === 'registry') {
    if (typeof target.version !== 'string' || target.version === '') return undefined
    return { specs: [`${parsed.name}@${target.version}`] }
  }
  if (parsed.kind === 'local') {
    const repo = target.repo
    if (repo === undefined || repo === null || typeof repo.owner !== 'string' || typeof repo.repo !== 'string') return undefined
    const ref = typeof target.ref === 'string' && target.ref !== '' ? target.ref : undefined
    if (ref === undefined) return undefined
    return { specs: [`github:${repo.owner}/${repo.repo}#${ref}`] }
  }
  return undefined
}

/** 从 `.git/HEAD` 与 `.git/packed-refs` 的文本里解出提交；游离 HEAD 直接用，符号引用只在
 * packed-refs 里找（松散引用由调用方读文件）。 */
export function resolveGitHead(head, packedRefs = '') {
  const text = typeof head === 'string' ? head.trim() : ''
  if (/^[0-9a-f]{40}$/u.test(text)) return text
  const symbolic = /^ref:\s*(\S+)$/u.exec(text)
  if (symbolic === null || typeof packedRefs !== 'string') return undefined
  for (const line of packedRefs.split('\n')) {
    const entry = /^([0-9a-f]{40})\s+(\S+)$/u.exec(line.trim())
    if (entry !== null && entry[2] === symbolic[1]) return entry[1]
  }
  return undefined
}
