/**
 * Local, network-free inspection of this machine's DSH plugin installation.
 *
 * Everything here answers questions from files already on disk (the dsh install
 * root, the active profile, the installed packages) plus the live Cordis
 * context. Nothing is fetched, nothing is pre-baked into a dataset, and nothing
 * is written: a verdict is computed at the moment it is asked for, against the
 * dsh build this machine is actually running.
 *
 * That design is deliberate. Upstream declares "THERE WILL BE
 * COMPATIBILITY-BREAKING CHANGES" (deepseek-harness README) and "Public APIs are
 * pre-stable" (AGENTS.md), so any cached snapshot of the API surface starts
 * lying the moment dsh is upgraded. A probe that claims less and stays true
 * beats a dataset that claims more and rots.
 *
 * Every uncertain branch reports `null`/an explicit unknown rather than a
 * guessed verdict, because a verification tool that guesses is worse than none.
 *
 * @module dsh-community-plugins/audit
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { describeRange, satisfies } from './semver.js'

const OFFICIAL_SCOPE = '@deepseek-ai/'
/**
 * Directories that never contain a plugin's own runtime source.
 *
 * `.workbuddy` and friends matter more than they look: scanning a working
 * directory picks up scratch scripts and fixture strings, which produce exactly
 * the kind of confident false positive this tool is supposed to eliminate.
 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'test', 'tests', '__tests__', 'coverage', '.git',
  'dist', 'build', '.workbuddy', '.github', '.vscode', '.idea',
  'docs', 'skills', 'examples',
])
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']
const MAX_SOURCE_BYTES = 1_500_000
const MAX_SOURCE_FILES = 400

/**
 * Remove comments before pattern-scanning.
 *
 * Without this a scanner reads its own documentation: `lib/audit.js` contains
 * the example `export const inject = ['tools', ...]` in a comment, and a bare
 * `inject = [` pattern faithfully extracted `tools` from a plugin that never
 * declared it. Stripping comments makes every later pattern mean "real code".
 * @param {string} text
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '')
    .replace(/[ \t]\/\/[^\n]*/g, '')
}

/**
 * Remove type-only import forms before scanning for runtime dependencies.
 *
 * This is not cosmetic. A published plugin's declaration files under `lib/types`
 * routinely import packages that never load at runtime (aqua's types reference
 * `@deepseek-ai/dsh-client-runtime`, which is not a runtime dependency of
 * anything and does not exist as a package at all). Counting those produced a
 * confident "this build does not provide it" blocker on a plugin that works.
 * @param {string} text
 */
function stripTypeOnlyImports(text) {
  return text
    .replace(/\bimport\s+type\s[^;\n]*?from\s*['"][^'"]*['"]/g, '')
    .replace(/\bexport\s+type\s[^;\n]*?from\s*['"][^'"]*['"]/g, '')
    .replace(/\bimport\s*\{[^}\n]*\btype\s[^}\n]*\}\s*from\s*['"][^'"]*['"]/g, '')
}

/**
 * Real `inject` declarations, in the shapes plugins actually use:
 * `export const inject = [...]`, `exports.inject = [...]`, and the object-literal
 * `inject: [...]` of a default export. Deliberately not a bare `inject = [`,
 * which also matches computed values and documentation.
 */
const INJECT_PATTERNS = [
  /\bexport\s+const\s+inject\s*=\s*\[([^\]]*)\]/g,
  /\bexports?\.inject\s*=\s*\[([^\]]*)\]/g,
  /\binject\s*:\s*\[([^\]]*)\]/g,
]

/** npm lifecycle hooks that run arbitrary code during install. */
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/**
 * Source-level signals worth a second look before installing. These are hints,
 * not verdicts: a marketplace plugin calling `dsh plugin` internally is normal,
 * a theme plugin spawning a shell is not.
 */
const SOURCE_SIGNALS = [
  {
    kind: 'child-process',
    level: 'warn',
    pattern: /(?:from|require\()\s*['"](?:node:)?child_process['"]/,
    detail: ' executes external commands',
  },
  {
    kind: 'dynamic-code',
    level: 'high',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/,
    detail: ' executes dynamic code',
  },
  {
    kind: 'remote-import',
    level: 'high',
    pattern: /import\s*\(\s*['"]https?:\/\//,
    detail: ' loads and runs code from a remote URL',
  },
  {
    kind: 'network',
    level: 'info',
    pattern: /\bfetch\s*\(|\bfrom\s*['"](?:node:)?https?['"]|require\(\s*['"](?:node:)?https?['"]\s*\)/,
    detail: ' performs network requests',
  },
]

/** Read and parse a JSON file, returning `null` for anything unreadable. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Environment
 * @property {string | undefined} dshRoot - the dsh install root, when locatable.
 * @property {string | undefined} dshVersion - its version.
 * @property {string | undefined} dshHome - `${DSH_HOME:-~/.dsh}`.
 * @property {string | undefined} fallbackModulesDir - `profiles/node_modules`, healed by dsh at startup.
 * @property {string | undefined} profileName
 * @property {string | undefined} profileDir
 * @property {string[]} availableProfiles
 * @property {Map<string, string>} officialPackages - official package name → version.
 * @property {Set<string>} officialSlots - slot names registered by official source.
 * @property {boolean} sourceTreeAvailable - whether the package set is complete enough to state absence as fact.
 * @property {string[]} notes - what could not be determined, and why.
 */

const environmentCache = new Map()

/**
 * Locate the dsh install root, the active profile, and the official API surface
 * available on this machine. Cached per (root, profile) pair for the process.
 * @param {{ dshRoot?: string, dshHome?: string, profileName?: string, home?: string }} [options]
 * @returns {Environment}
 */
export function resolveEnvironment(options = {}) {
  const home = options.home ?? homedir()
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh')
  const root = options.dshRoot ?? detectDshRoot(home)
  const requestedProfile = options.profileName
  const cacheKey = `${root ?? ''}::${dshHome}::${requestedProfile ?? ''}`
  const cached = environmentCache.get(cacheKey)
  if (cached !== undefined) return cached

  /** @type {string[]} */
  const notes = []
  const profile = resolveProfile(dshHome, requestedProfile, notes)
  // dsh heals a flat `profiles/node_modules` at startup and every out-of-tree
  // plugin resolves its missing dependencies through it. That directory is the
  // runtime truth about which packages exist and at what version — more reliable
  // than a source checkout, and the only source at all for a packed install.
  const fallbackModulesDir = join(dshHome, 'profiles', 'node_modules')

  const officialPackages = new Map()
  let officialSlots = new Set()
  let dshVersion
  if (root === undefined) {
    notes.push('dsh install root not found: searches $DSH_ROOT, the running entry point, and common paths. '
      + 'API-surface checks fall back to the profile fallback directory only.')
  } else {
    dshVersion = readJson(join(root, 'package.json'))?.version
    collectOfficialPackages(officialPackages, root)
    officialSlots = collectOfficialSlots(root)
  }
  collectScopedPackages(officialPackages, join(fallbackModulesDir, OFFICIAL_SCOPE))
  if (officialPackages.size === 0) {
    notes.push('no @deepseek-ai packages found on this machine; peer checks cannot resolve any official range')
  }
  // A source checkout lists every package; the profile fallback lists only what
  // the installed bundles actually resolve. That difference decides whether
  // "this package is missing" may be stated as fact or only as a suspicion.
  const sourceTreeAvailable = root !== undefined && existsSync(join(root, 'packages'))
  if (!sourceTreeAvailable) {
    notes.push('no dsh source checkout found, so the package set comes from profiles/node_modules only: '
      + 'a package reported as missing here may still exist upstream (client-side packages in particular)')
  }

  /** @type {Environment} */
  const environment = {
    dshRoot: root,
    dshVersion,
    dshHome,
    fallbackModulesDir,
    profileName: profile?.name,
    profileDir: profile?.dir,
    availableProfiles: profile?.available ?? [],
    officialPackages,
    officialSlots,
    sourceTreeAvailable,
    notes,
  }
  environmentCache.set(cacheKey, environment)
  return environment
}

function detectDshRoot(home) {
  const candidates = []
  if (typeof process.env.DSH_ROOT === 'string' && process.env.DSH_ROOT !== '') candidates.push(process.env.DSH_ROOT)
  // The running process is the strongest hint: dsh boots through its own bin.js.
  for (const entry of [process.argv[1], process.argv[0]]) {
    if (typeof entry !== 'string' || !isAbsolute(entry)) continue
    let directory = dirname(entry)
    for (let depth = 0; depth < 7; depth += 1) {
      candidates.push(directory)
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  candidates.push(
    join(home, 'work', 'deepseek-harness'),
    join(home, 'deepseek-harness'),
    join(home, 'dsh'),
  )
  for (const candidate of candidates) if (looksLikeDshRoot(candidate)) return resolve(candidate)
  return undefined
}

function looksLikeDshRoot(directory) {
  return existsSync(join(directory, 'packages', 'core', 'tools', 'package.json'))
    || (existsSync(join(directory, 'packages')) && existsSync(join(directory, 'apps', 'cli')))
}

function resolveProfile(dshHome, requested, notes) {
  const profilesDir = join(dshHome, 'profiles')
  /** @type {string[]} */
  let available = []
  try {
    available = readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    notes.push(`no profile directory at ${profilesDir}; pass profileName or install dsh first`)
    return undefined
  }
  const name = requested ?? (available.includes('web') ? 'web' : available[0])
  if (name === undefined) {
    notes.push(`${profilesDir} contains no profiles`)
    return undefined
  }
  if (requested !== undefined && !available.includes(requested)) {
    notes.push(`profile "${requested}" not found; available: ${available.join(', ') || '(none)'}`)
  }
  return { name, dir: join(profilesDir, name), available }
}

/**
 * Collect official package versions from a dsh source checkout into `packages`.
 *
 * `vendor/` is easy to miss and costly: cordis and schemastery live there, so
 * skipping it makes every plugin that imports them look broken.
 * @param {Map<string, string>} packages
 * @param {string} root
 */
function collectOfficialPackages(packages, root) {
  for (const manifest of findManifests(join(root, 'packages'), 3)) rememberManifest(packages, manifest)
  for (const manifest of findManifests(join(root, 'vendor'), 2)) rememberManifest(packages, manifest)
  collectScopedPackages(packages, join(root, 'node_modules', OFFICIAL_SCOPE))
}

/**
 * Collect every package under one `@scope` directory. Entries may be symlinks,
 * which is how the profile fallback points back into the installation.
 * @param {Map<string, string>} packages
 * @param {string} scopeDir
 */
function collectScopedPackages(packages, scopeDir) {
  let entries
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    rememberManifest(packages, join(scopeDir, entry.name, 'package.json'))
  }
}

function rememberManifest(packages, manifest) {
  const json = readJson(manifest)
  if (typeof json?.name === 'string' && json.name.startsWith(OFFICIAL_SCOPE) && !packages.has(json.name)) {
    packages.set(json.name, typeof json.version === 'string' ? json.version : '0.0.0')
  }
}

/**
 * The version of `name` actually resolvable on this machine.
 *
 * The profile's own modules come first, then the installation fallback dsh
 * heals at startup (what a plugin really resolves against), then the dsh root,
 * and only then the source manifest — so a version on disk always outranks a
 * version declared in a package.json that may not have been built.
 * @param {string} name
 * @param {Environment} environment
 * @returns {string | undefined}
 */
function resolveInstalledVersion(name, environment) {
  const modulesDirs = [
    environment.profileDir === undefined ? undefined : join(environment.profileDir, 'node_modules'),
    environment.fallbackModulesDir,
    environment.dshRoot === undefined ? undefined : join(environment.dshRoot, 'node_modules'),
  ]
  for (const modulesDir of modulesDirs) {
    if (modulesDir === undefined) continue
    const json = readJson(join(modulesDir, name, 'package.json'))
    if (typeof json?.version === 'string') return json.version
  }
  return environment.officialPackages.get(name)
}

function findManifests(directory, maxDepth) {
  /** @type {string[]} */
  const found = []
  const visit = (current, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      const child = join(current, entry.name)
      const manifest = join(child, 'package.json')
      if (existsSync(manifest)) found.push(manifest)
      visit(child, depth + 1)
    }
  }
  visit(directory, 0)
  return found
}

/**
 * Slot names are the hardest of the client-side contracts: a plugin that
 * registers `settings.plugin.item` breaks silently if that slot is renamed.
 *
 * Extracted from official source only — this is the one place where reading
 * upstream code is worth the cost, and the result is cached for the process.
 * @param {string} root
 * @returns {Set<string>}
 */
function collectOfficialSlots(root) {
  const slotPattern = /'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)'\s*:\s*\{\s*kind\s*:\s*'(?:single|list|keyed|chain)'/g
  /** @type {Set<string>} */
  const slots = new Set()
  for (const directory of [join(root, 'packages', 'client'), join(root, 'packages', 'core')]) {
    for (const file of findSources(directory, MAX_SOURCE_FILES * 4)) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const match of text.matchAll(slotPattern)) slots.add(match[1])
    }
  }
  return slots
}

function findSources(directory, limit, signal) {
  /** @type {string[]} */
  const found = []
  const visit = current => {
    if (found.length >= limit) return
    signal?.throwIfAborted()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        visit(child)
        continue
      }
      if (entry.name.endsWith('.d.ts')) continue
      if (SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) found.push(child)
    }
  }
  visit(directory)
  return found
}

// ---------------------------------------------------------------------------
// Installed plugins
// ---------------------------------------------------------------------------

/**
 * @typedef {object} InstalledPlugin
 * @property {string} name
 * @property {string} version
 * @property {string} directory - realpath of the installed package.
 * @property {object} manifest
 */

/**
 * List every third-party plugin installed in a profile.
 *
 * Official `@deepseek-ai/*` packages are excluded: they are the host, not a
 * guest that can be out of range against itself. Development `link:` entries are
 * included and flagged, because a linked plugin's code can change underfoot.
 * @param {string} profileDir
 * @returns {InstalledPlugin[]}
 */
export function listInstalledPlugins(profileDir) {
  const modulesDir = join(profileDir, 'node_modules')
  /** @type {InstalledPlugin[]} */
  const plugins = []
  /** @type {[string, string][]} */
  const candidates = []
  let topLevel
  try {
    topLevel = readdirSync(modulesDir, { withFileTypes: true })
  } catch {
    return plugins
  }
  for (const entry of topLevel) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      try {
        for (const scoped of readdirSync(join(modulesDir, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) {
            candidates.push([`${entry.name}/${scoped.name}`, join(modulesDir, entry.name, scoped.name)])
          }
        }
      } catch { /* unreadable scope */ }
      continue
    }
    candidates.push([entry.name, join(modulesDir, entry.name)])
  }
  for (const [name, directory] of candidates) {
    if (name.startsWith(OFFICIAL_SCOPE)) continue
    let real
    try {
      real = realpathSync(directory)
    } catch {
      continue
    }
    const manifest = readJson(join(real, 'package.json'))
    if (manifest === null) continue
    plugins.push({
      name: typeof manifest.name === 'string' ? manifest.name : name,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      directory: real,
      manifest,
      linked: real !== directory,
    })
  }
  return plugins.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * @typedef {object} PluginScan
 * @property {string[]} officialImports - `@deepseek-ai/*` packages the source imports.
 * @property {string[]} slotNames - slot names the source registers.
 * @property {string[]} injectNames - service names the source declares via `inject`.
 * @property {{ kind: string, level: string, detail: string, file?: string }[]} signals
 * @property {number} filesScanned
 */

/**
 * Read a plugin's own source (never its dependencies) for API usage and
 * risk signals.
 *
 * `options.signal` is honoured at every file boundary so a caller that declared
 * a timeout can actually stop this work. The scan is synchronous, so the
 * checks are cooperative checkpoints rather than a hard kill — which is
 * exactly what `timeoutMs` on the tool asserts.
 * @param {string} directory
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {PluginScan}
 */
export function scanPluginSource(directory, options = {}) {
  const { signal } = options
  /** @type {Set<string>} */
  const officialImports = new Set()
  /** @type {Set<string>} */
  const slotNames = new Set()
  /** @type {Set<string>} */
  const injectNames = new Set()
  /** @type {{ kind: string, level: string, detail: string, file?: string }[]} */
  const signals = []
  const files = findSources(directory, MAX_SOURCE_FILES, signal)
  for (const file of files) {
    signal?.throwIfAborted()
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (raw.length > MAX_SOURCE_BYTES) continue
    const text = stripTypeOnlyImports(stripComments(raw))
    for (const match of text.matchAll(/(?:from|require\()\s*['"]@deepseek-ai\/([^'"/]+)/g)) {
      officialImports.add(`${OFFICIAL_SCOPE}${match[1]}`)
    }
    // `export const inject = ['tools', ...]` is the real declaration; the
    // package.json dsh block only carries it for client-half plugins.
    for (const pattern of INJECT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        for (const name of match[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) injectNames.add(name[1])
      }
    }
    let index = 0
    while ((index = text.indexOf('register(', index)) !== -1) {
      const window = text.slice(index, index + 300)
      const name = window.match(/name\s*:\s*['"]([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)['"]/)
      if (name !== null) slotNames.add(name[1])
      index += 'register('.length
    }
    for (const signal of SOURCE_SIGNALS) {
      if (signal.pattern.test(text)) {
        signals.push({ kind: signal.kind, level: signal.level, detail: signal.detail.trim(), file })
      }
    }
  }
  return {
    officialImports: [...officialImports].sort(),
    slotNames: [...slotNames].sort(),
    injectNames: [...injectNames].sort(),
    signals,
    filesScanned: files.length,
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PeerCheck
 * @property {string} package
 * @property {string} range
 * @property {string | null} actual - version present on this machine, when known.
 * @property {boolean | null} satisfied - `null` when it cannot be decided locally.
 * @property {string | null} expanded - the desugared range, for evidence.
 */

/**
 * Check one plugin's declared peer ranges against this machine.
 *
 * The rc-prerelease rule is the subtle part and the reason this is computed
 * rather than eyeballed: `^0.1.0-rc.5` does NOT admit `0.1.5-rc.1`, because a
 * prerelease only matches a comparator pinned to the same major.minor.patch.
 * @param {InstalledPlugin} plugin
 * @param {Environment} environment
 * @returns {PeerCheck[]}
 */
export function checkPeers(plugin, environment) {
  const peers = plugin.manifest?.peerDependencies
  if (typeof peers !== 'object' || peers === null) return []
  /** @type {PeerCheck[]} */
  const checks = []
  for (const [name, rawRange] of Object.entries(peers)) {
    const range = typeof rawRange === 'string' ? rawRange : String(rawRange)
    const expanded = describeRange(range)
    const actual = resolveInstalledVersion(name, environment)
    if (actual === undefined) {
      checks.push({ package: name, range, actual: null, satisfied: null, expanded })
      continue
    }
    checks.push({ package: name, range, actual, satisfied: satisfies(actual, range), expanded })
  }
  return checks
}

/**
 * @typedef {object} PluginVerdict
 * @property {string} name
 * @property {string} version
 * @property {string} form
 * @property {boolean} linked
 * @property {'compatible' | 'at-risk' | 'incompatible' | 'unknown'} verdict
 * @property {PeerCheck[]} peers
 * @property {string[]} officialImports
 * @property {string[]} missingPackages
 * @property {{ name: string, present: boolean }[]} runtimeServices
 * @property {string[]} missingSlots
 * @property {{ kind: string, level: string, detail: string, file?: string }[]} signals
 * @property {string[]} blockers - hard evidence the plugin cannot work here.
 * @property {string[]} risks - declared ranges that no longer match this build.
 * @property {string[]} unknowns
 */

/**
 * Decide whether one installed plugin is compatible with the dsh build on this
 * machine, and say exactly what could not be decided.
 *
 * The verdict separates two things that are easy to conflate:
 *
 *   - `blockers` are hard facts — a package the plugin imports is not on this
 *     machine, or it registers a slot this build does not define.
 *   - `risks` are failing declared ranges. The author pinned `^0.1.0-rc.5` and
 *     the host moved on; the code may well still run, because pnpm does not
 *     enforce peers by default. That is `at-risk`, not `incompatible` — calling
 *     both of them "broken" would train the reader to ignore the output.
 * @param {InstalledPlugin} plugin
 * @param {Environment} environment
 * @param {{ probe?: (name: string) => boolean | null }} [runtime]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {PluginVerdict}
 */
export function judgePlugin(plugin, environment, runtime = {}, options = {}) {
  const scan = scanPluginSource(plugin.directory, options)
  const peers = checkPeers(plugin, environment)
  /** @type {string[]} */
  const blockers = []
  /** @type {string[]} */
  const risks = []
  /** @type {string[]} */
  const unknowns = []

  for (const check of peers) {
    if (check.satisfied === false) {
      risks.push(`declares peer ${check.package}@${check.range} but this machine has ${check.actual}`
        + `${check.expanded === null ? '' : ` (range expands to ${check.expanded})`}`)
    } else if (check.satisfied === null) {
      unknowns.push(check.actual === null
        ? `peer ${check.package}@${check.range}: not installed here, so the range cannot be checked`
        : `peer ${check.package}@${check.range}: range could not be parsed`)
    }
  }

  // Imported official packages that this build does not provide: a rename or a
  // split shows up here before it shows up as a runtime crash. Whether that is
  // stated as fact depends on how complete the package set is — the profile
  // fallback omits client-only packages that a source checkout lists, and
  // calling those "removed" would be a confident false positive.
  const missingPackages = environment.officialPackages.size === 0
    ? []
    : scan.officialImports.filter(name => !environment.officialPackages.has(name))
  for (const name of missingPackages) {
    const evidence = `imports ${name}, which is absent from the package set found on this machine`
    if (environment.sourceTreeAvailable) {
      blockers.push(`${evidence} (renamed or removed)`)
    } else {
      risks.push(`${evidence}; without a dsh source checkout this set is incomplete, so verify before concluding`)
    }
  }
  if (environment.officialPackages.size === 0 && scan.officialImports.length > 0) {
    unknowns.push(`imports ${scan.officialImports.length} official package(s) but the install root was not found, `
      + 'so their presence could not be verified')
  }

  // Slot names: only meaningful when we actually enumerated the official set.
  const missingSlots = environment.officialSlots.size === 0
    ? []
    : scan.slotNames.filter(name => !environment.officialSlots.has(name))
  for (const name of missingSlots) {
    blockers.push(`registers slot "${name}", which is absent from ${environment.dshVersion ?? 'this'} official source`)
  }

  // Runtime services: the live context is the ground truth for `inject` names.
  /** @type {{ name: string, present: boolean }[]} */
  const runtimeServices = []
  const inject = [...new Set([...scan.injectNames, ...collectInjectNames(plugin.manifest)])].sort()
  const probe = runtime?.probe
  for (const service of inject) {
    const present = probe === undefined ? null : probe(service)
    if (present === null) {
      unknowns.push(`inject "${service}" is a ctx service token with no static registry to check offline`)
      continue
    }
    runtimeServices.push({ name: service, present })
    if (!present) unknowns.push(`inject "${service}" was not found on the live context`)
  }

  // Lifecycle scripts run code at install time and are always worth surfacing.
  const scripts = plugin.manifest?.scripts
  if (typeof scripts === 'object' && scripts !== null) {
    for (const hook of LIFECYCLE_SCRIPTS) {
      if (typeof scripts[hook] === 'string') {
        scan.signals.push({ kind: `lifecycle:${hook}`, level: 'high', detail: `runs at install time: ${scripts[hook]}` })
      }
    }
  }

  // Hard evidence outranks a failing range declaration, which in turn outranks
  // "could not decide" — but none of them is silently rounded to "fine".
  const verdict = blockers.length > 0
    ? 'incompatible'
    : risks.length > 0
      ? 'at-risk'
      : unknowns.length > 0 ? 'unknown' : 'compatible'
  return {
    name: plugin.name,
    version: plugin.version,
    form: describeForm(plugin.manifest),
    linked: plugin.linked === true,
    verdict,
    peers,
    officialImports: scan.officialImports,
    missingPackages,
    runtimeServices,
    missingSlots,
    signals: mergeSignals(scan.signals),
    blockers,
    risks,
    unknowns,
  }
}

/**
 * Collapse per-file duplicates into one entry per kind: "network in 6 files" is
 * one fact about the plugin, not six.
 * @param {{ kind: string, level: string, detail: string, file?: string }[]} signals
 */
function mergeSignals(signals) {
  /** @type {Map<string, { kind: string, level: string, detail: string, files: string[] }>} */
  const merged = new Map()
  for (const signal of signals) {
    const existing = merged.get(signal.kind)
    if (existing === undefined) {
      merged.set(signal.kind, { kind: signal.kind, level: signal.level, detail: signal.detail, files: signal.file === undefined ? [] : [signal.file] })
      continue
    }
    if (signal.file !== undefined) existing.files.push(signal.file)
  }
  return [...merged.values()].map(entry => ({
    kind: entry.kind,
    level: entry.level,
    detail: entry.detail,
    occurrences: entry.files.length,
  }))
}

function collectInjectNames(manifest) {
  const names = new Set()
  const inject = manifest?.dsh?.inject
  if (Array.isArray(inject)) for (const name of inject) if (typeof name === 'string') names.add(name)
  return [...names].sort()
}

function describeForm(manifest) {
  const hasBundle = typeof manifest?.dsh?.bundle?.patch === 'string'
  const hasClient = typeof manifest?.dsh?.client === 'object' && manifest.dsh.client !== null
  if (hasBundle && hasClient) return 'bundle+client'
  if (hasBundle) return 'bundle'
  if (hasClient) return 'client'
  return 'cordis'
}

/**
 * Probe whether a service name resolves on the live context. Returns `null`
 * when the context cannot answer, so callers can report "unknown" instead of a
 * false negative.
 *
 * Uses `ctx.get(name, false)` — the public accessor. An earlier version read
 * `ctx.reflect.store` directly and looked up plain string keys, but that store
 * is keyed by `Symbol(name)`, so every lookup missed and every `inject` was
 * reported as absent. Only running against a real Cordis context exposed it;
 * a mock with a string-keyed object would have kept agreeing with the bug.
 *
 * `strict: false` is deliberate: a service whose providing fiber is still
 * settling is present, and blaming a plugin for activation order would be a
 * false positive.
 * @param {object} ctx - the Cordis context this plugin was applied with.
 * @returns {(name: string) => boolean | null}
 */
export function createServiceProbe(ctx) {
  if (typeof ctx?.get !== 'function') return () => null
  return name => {
    try {
      return ctx.get(name, false) !== undefined
    } catch {
      return null
    }
  }
}

/**
 * Audit one plugin, or every plugin installed in the profile.
 * @param {{ environment: Environment, target?: string, runtime?: { probe?: (name: string) => boolean | null }, signal?: AbortSignal }} input
 * @returns {{ environment: Environment, plugins: PluginVerdict[], resolvedTarget: string | null }}
 */
export function audit(input) {
  const { environment, target, runtime, signal } = input
  const profileDir = environment.profileDir
  if (profileDir === undefined) return { environment, plugins: [], resolvedTarget: null }

  if (typeof target === 'string' && target.trim() !== '') {
    const plugin = resolveTarget(target.trim(), profileDir)
    if (plugin === null) return { environment, plugins: [], resolvedTarget: null }
    return {
      environment,
      plugins: [judgePlugin(plugin, environment, runtime, { signal })],
      resolvedTarget: plugin.directory,
    }
  }

  const plugins = listInstalledPlugins(profileDir)
    .map((plugin) => {
      signal?.throwIfAborted()
      return judgePlugin(plugin, environment, runtime, { signal })
    })
  return { environment, plugins, resolvedTarget: profileDir }
}

/**
 * Resolve an audit target: an absolute/relative directory, or a package name
 * installed in the profile.
 * @param {string} target
 * @param {string} profileDir
 * @returns {InstalledPlugin | null}
 */
function resolveTarget(target, profileDir) {
  if (target.includes('/') || target.includes('\\') || target === '.' || target === '..') {
    const directory = isAbsolute(target) ? target : resolve(process.cwd(), target)
    if (!existsSync(join(directory, 'package.json'))) return null
    const manifest = readJson(join(directory, 'package.json'))
    if (manifest === null) return null
    return {
      name: typeof manifest.name === 'string' ? manifest.name : directory,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      directory,
      manifest,
      linked: false,
    }
  }
  return listInstalledPlugins(profileDir).find(plugin => plugin.name === target) ?? null
}
