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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describeRange, satisfies } from './semver.js'
import { buildPackageSurface, collectSymbolRequests } from './symbols.js'

const OFFICIAL_SCOPE = '@deepseek-ai/'
/**
 * The profile's independent compatibility file, where dsh stores the
 * exact-version grants its version gate consults
 * (`PROFILE_COMPATIBILITY_FILENAME` in `@deepseek-ai/dsh-app-boot`).
 */
const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'
/**
 * The gate only ever judges peers in dsh's own namespace: `@deepseek-ai/dsh` and
 * `@deepseek-ai/dsh-*`. `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are
 * outside it, which is why a plugin whose only peer is cordis can never be
 * refused by the gate however far the host has moved.
 */
const GATE_PEER_PREFIX = '@deepseek-ai/dsh-'
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
 * `SKIPPED_DIRECTORIES` plus build output, for scans of an official *source*
 * checkout only.
 *
 * `lib/` must stay scannable for a third-party plugin — that is where its
 * runtime code lives — but in the monorepo it is emitted output sitting beside
 * the source it came from. A built `packages/client` carries well over a
 * thousand generated files, and they are reached before `src/` because the
 * traversal walks the package directory in order: the shared file budget then
 * runs out before the slot contracts are read, and the extracted set silently
 * becomes a function of whether the checkout happens to be built. Measured on
 * dsh 0.2.0-rc.2: 76 slots from a pristine checkout, 56 once it had been built.
 */
const OFFICIAL_SOURCE_DIRECTORIES = new Set([...SKIPPED_DIRECTORIES, 'lib'])

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
 * @property {Map<string, string>} officialPackageDirs - official package name → directory on disk.
 * @property {Set<string>} officialSlots - slot names registered by official source.
 * @property {boolean} sourceTreeAvailable - whether the package set is complete enough to state absence as fact.
 * @property {string[] | undefined} profileBundles - `dsh.profile.bundles`, or undefined when unreadable.
 * @property {Record<string, string[]> | undefined} versionExemptions - the profile's exact-version grants
 *   (`compatibility.json`), or undefined when there is no profile. Read fresh on every call, like the bundles list.
 * @property {string[]} notes - what could not be determined, and why.
 */

const installSurfaceCache = new Map()

/**
 * Locate the dsh install root and the official API surface available on this
 * machine.
 *
 * Cached per (root, dshHome) pair for the process. Deliberately *not* keyed by
 * profile and deliberately not holding any profile state: `dsh plugin add` and
 * `remove` rewrite the profile manifest while dsh is running, so a cached
 * `dsh.profile.bundles` made the tool contradict the disk it had just been told
 * to verify — it reported a freshly added package as "not in dsh.profile.bundles"
 * and a removed one as still listed, which is exactly the check the workflow
 * depends on. The install root's package set is the expensive part to collect and
 * never changes without a restart, so that is what stays cached.
 * @param {{ dshRoot?: string, dshHome: string, notes: string[] }} input
 * @returns {object}
 */
function resolveInstallSurface(input) {
  const dshHome = input.dshHome
  const root = input.dshRoot
  const notes = input.notes
  const cacheKey = `${root ?? ''}::${dshHome}`
  const cached = installSurfaceCache.get(cacheKey)
  if (cached !== undefined) {
    notes.push(...cached.notes)
    return cached
  }

  /** @type {string[]} */
  const localNotes = []
  // dsh heals a flat `profiles/node_modules` at startup and every out-of-tree
  // plugin resolves its missing dependencies through it. That directory is the
  // runtime truth about which packages exist and at what version — more reliable
  // than a source checkout, and the only source at all for a packed install.
  const fallbackModulesDir = join(dshHome, 'profiles', 'node_modules')

  const officialPackages = new Map()
  const officialPackageDirs = new Map()
  let officialSlots = new Set()
  let dshVersion
  if (root === undefined) {
    localNotes.push('dsh install root not found: searches $DSH_ROOT, the running entry point, and common paths. '
      + 'API-surface checks fall back to the profile fallback directory only.')
  } else {
    dshVersion = readJson(join(root, 'package.json'))?.version
    collectOfficialPackages(officialPackages, officialPackageDirs, root)
    officialSlots = collectOfficialSlots(root)
  }
  collectScopedPackages(officialPackages, officialPackageDirs, join(fallbackModulesDir, OFFICIAL_SCOPE))
  if (officialPackages.size === 0) {
    localNotes.push('no @deepseek-ai packages found on this machine; peer checks cannot resolve any official range')
  }
  // A source checkout lists every package; the profile fallback lists only what
  // the installed bundles actually resolve. That difference decides whether
  // "this package is missing" may be stated as fact or only as a suspicion.
  const sourceTreeAvailable = root !== undefined && existsSync(join(root, 'packages'))
  if (!sourceTreeAvailable) {
    localNotes.push('no dsh source checkout found, so the package set comes from profiles/node_modules only: '
      + 'a package reported as missing here may still exist upstream (client-side packages in particular)')
  }

  const surface = {
    dshRoot: root,
    dshVersion,
    dshHome,
    fallbackModulesDir,
    officialPackages,
    officialPackageDirs,
    officialSlots,
    sourceTreeAvailable,
    notes: localNotes,
  }
  installSurfaceCache.set(cacheKey, surface)
  notes.push(...localNotes)
  return surface
}

/**
 * Read the profile's `compatibility.json`: the exact-version grants that decide
 * whether dsh's own version gate admits an otherwise-incompatible plugin.
 *
 * A damaged file authorizes nothing but must not stop a profile from booting
 * (that is upstream's rule in `app-boot`'s preflight), so its problems are
 * reported as notes rather than as findings.
 * @param {string | undefined} profileDir
 * @param {string[]} notes
 * @returns {Record<string, string[]> | undefined}
 */
function readVersionExemptions(profileDir, notes) {
  if (profileDir === undefined) return undefined
  const file = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const json = readJson(file)
  if (json === null) {
    if (existsSync(file)) notes.push(`${PROFILE_COMPATIBILITY_FILENAME} could not be parsed; treating the profile as having no version exemptions`)
    return {}
  }
  if (typeof json !== 'object' || Array.isArray(json)) {
    notes.push(`${PROFILE_COMPATIBILITY_FILENAME} must map exact package@version keys to DSH version lists; ignoring it`)
    return {}
  }
  /** @type {Record<string, string[]>} */
  const exemptions = {}
  for (const [key, versions] of Object.entries(json)) {
    if (!Array.isArray(versions) || !versions.every(version => typeof version === 'string')) {
      notes.push(`${PROFILE_COMPATIBILITY_FILENAME}: ${key} must contain a list of exact DSH versions; the record is ignored`)
      continue
    }
    exemptions[key] = versions
  }
  return exemptions
}

/**
 * Locate the dsh install root, the active profile, and the official API surface
 * available on this machine.
 *
 * The install surface is cached for the process; the profile's own composition
 * (`dsh.profile.bundles` and `compatibility.json`) is re-read on every call,
 * because both are written by `dsh plugin add` / `remove` while dsh is running.
 * @param {{ dshRoot?: string, dshHome?: string, profileName?: string, home?: string }} [options]
 * @returns {Environment}
 */
export function resolveEnvironment(options = {}) {
  const home = options.home ?? homedir()
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh')
  const root = options.dshRoot ?? detectDshRoot(home)
  const requestedProfile = options.profileName

  /** @type {string[]} */
  const notes = []
  const profile = resolveProfile(dshHome, requestedProfile, notes)
  // The launcher builds its layers *only* from `dsh.profile.bundles`
  // (packages/boot/app-boot/src/profile.ts:781), so this list decides whether an
  // installed plugin's patch layer is applied at all.
  const profileManifest = profile === undefined
    ? null
    : readJson(join(profile.dir, 'package.json'))
  const profileBundles = Array.isArray(profileManifest?.dsh?.profile?.bundles)
    ? profileManifest.dsh.profile.bundles.filter(name => typeof name === 'string')
    : profile === undefined || profileManifest === null ? undefined : []
  const versionExemptions = readVersionExemptions(profile?.dir, notes)

  const install = resolveInstallSurface({ dshRoot: root, dshHome, notes })

  return {
    ...install,
    profileName: profile?.name,
    profileDir: profile?.dir,
    availableProfiles: profile?.available ?? [],
    profileBundles,
    versionExemptions,
    notes,
  }
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
 * Collect official package versions (and their directories) from a dsh source
 * checkout into `packages`/`directories`.
 *
 * `vendor/` is easy to miss and costly: cordis and schemastery live there, so
 * skipping it makes every plugin that imports them look broken.
 * @param {Map<string, string>} packages
 * @param {Map<string, string>} directories
 * @param {string} root
 */
function collectOfficialPackages(packages, directories, root) {
  for (const manifest of findManifests(join(root, 'packages'), 3)) rememberManifest(packages, directories, manifest)
  for (const manifest of findManifests(join(root, 'vendor'), 2)) rememberManifest(packages, directories, manifest)
  collectScopedPackages(packages, directories, join(root, 'node_modules', OFFICIAL_SCOPE))
}

/**
 * Collect every package under one `@scope` directory. Entries may be symlinks,
 * which is how the profile fallback points back into the installation.
 * @param {Map<string, string>} packages
 * @param {Map<string, string>} directories
 * @param {string} scopeDir
 */
function collectScopedPackages(packages, directories, scopeDir) {
  let entries
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    rememberManifest(packages, directories, join(scopeDir, entry.name, 'package.json'))
  }
}

function rememberManifest(packages, directories, manifest) {
  const json = readJson(manifest)
  if (typeof json?.name === 'string' && json.name.startsWith(OFFICIAL_SCOPE) && !packages.has(json.name)) {
    packages.set(json.name, typeof json.version === 'string' ? json.version : '0.0.0')
    directories.set(json.name, dirname(manifest))
  }
}

/**
 * The directory of `name` actually resolvable on this machine, in the same
 * precedence order as `resolveInstalledVersion`.
 *
 * Node-modules locations come first because they are what the module loader
 * itself would pick; the source manifest is the last resort, and a checkout that
 * has not been built yields no declaration files there — which the symbol check
 * reports as "cannot decide" rather than as a missing export.
 * @param {string} name
 * @param {Environment} environment
 * @returns {{ dir: string, manifest: object } | null}
 */
export function resolveInstalledDirectory(name, environment) {
  const modulesDirs = [
    environment.profileDir === undefined ? undefined : join(environment.profileDir, 'node_modules'),
    environment.fallbackModulesDir,
    environment.dshRoot === undefined ? undefined : join(environment.dshRoot, 'node_modules'),
  ]
  for (const modulesDir of modulesDirs) {
    if (modulesDir === undefined) continue
    const dir = join(modulesDir, name)
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest !== null) return { dir, manifest }
  }
  const source = environment.officialPackageDirs?.get(name)
  if (source === undefined) return null
  const manifest = readJson(join(source, 'package.json'))
  return manifest === null ? null : { dir: source, manifest }
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
    for (const file of findSources(directory, MAX_SOURCE_FILES * 4, undefined, OFFICIAL_SOURCE_DIRECTORIES)) {
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

function findSources(directory, limit, signal, skipDirectories = SKIPPED_DIRECTORIES) {
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
        if (skipDirectories.has(entry.name)) continue
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
 * @property {import('./symbols.js').SymbolRequest[]} symbolRequests - named bindings required from those packages.
 * @property {string[]} slotNames - slot names the source registers.
 * @property {string[]} injectNames - service names the source declares via `inject`.
 * @property {{ name: string, file: string }[]} injectDeclarations - the same names with the file that declared
 *   each one, so a token declared by the browser half can be told apart from a host service.
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
  /** @type {import('./symbols.js').SymbolRequest[]} */
  const symbolRequests = []
  /** @type {Set<string>} */
  const slotNames = new Set()
  /** @type {Set<string>} */
  const injectNames = new Set()
  /** @type {{ name: string, file: string }[]} */
  const injectDeclarations = []
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
    // Two views of the same file: package-level detection ignores type-only
    // imports, while the symbol check needs the mixed `import { type A, B }`
    // form intact so it can verify `B`.
    const declared = stripComments(raw)
    const text = stripTypeOnlyImports(declared)
    for (const match of text.matchAll(/(?:from|require\()\s*['"]@deepseek-ai\/([^'"/]+)/g)) {
      officialImports.add(`${OFFICIAL_SCOPE}${match[1]}`)
    }
    for (const request of collectSymbolRequests(declared, file)) {
      if (request.package.startsWith(OFFICIAL_SCOPE)) symbolRequests.push(request)
    }
    // `export const inject = ['tools', ...]` is the real declaration; the
    // package.json dsh block only carries it for client-half plugins.
    for (const pattern of INJECT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        for (const name of match[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) {
          injectNames.add(name[1])
          injectDeclarations.push({ name: name[1], file: relative(directory, file).replaceAll('\\', '/') })
        }
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
    symbolRequests,
    slotNames: [...slotNames].sort(),
    injectNames: [...injectNames].sort(),
    injectDeclarations,
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

/** Range spellings upstream resolves to "the current runtime", i.e. always met. */
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/**
 * @typedef {object} VersionGate
 * @property {boolean} applicable - the manifest declares peers the gate judges at all.
 * @property {string | null} runtimeVersion - the dsh version the gate compares against.
 * @property {{ package: string, range: string }[]} peers - ranges that do not admit that version.
 * @property {boolean} exempted - `compatibility.json` grants this exact package version on this exact dsh version.
 * @property {boolean} denied - the gate disables this row on startup.
 * @property {boolean} undecidable - the runtime version could not be read, so the gate cannot be predicted.
 * @property {string | null} key - the `name@version` exemption key, or null when the manifest lacks an identity.
 */

/** `name@version` as the exemption file spells it, or null when either half is missing. */
function gateKey(manifest) {
  const name = typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name : null
  const version = typeof manifest?.version === 'string' && manifest.version.trim() !== '' ? manifest.version : null
  return name !== null && version !== null ? `${name}@${version}` : null
}

/**
 * Evaluate dsh's own plugin version gate, offline.
 *
 * This mirrors `evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`,
 * which is a *different* rule from `checkPeers` above and had to be reproduced
 * rather than approximated:
 *
 *   - it only judges peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`,
 *     never cordis, schemastery or react;
 *   - it compares every one of those ranges against the **running dsh version**,
 *     not against each package's installed version;
 *   - it passes `includePrerelease: true`, so `>=0.1.0` admits `0.2.0-rc.2`
 *     where the default prerelease rule refuses it;
 *   - `workspace:^`, `workspace:~` and `workspace:*` mean the current runtime.
 *
 * A conflict is not a boot failure: the preflight disables that single row and
 * the profile still starts (`compatibility-preflight.ts`). The row does not load
 * unless `compatibility.json` grants this exact package version on this exact
 * dsh version — which is the difference between "the range no longer matches,
 * the code may still run" and "this will never load", and it is decidable
 * offline from the same two files.
 * @param {object} manifest
 * @param {Environment} environment
 * @returns {VersionGate}
 */
export function evaluateVersionGate(manifest, environment) {
  /** @type {VersionGate} */
  const none = {
    applicable: false, runtimeVersion: null, peers: [],
    exempted: false, denied: false, undecidable: false, key: null,
  }
  const declared = manifest?.peerDependencies
  if (typeof declared !== 'object' || declared === null) return none
  const judged = Object.entries(declared)
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith(GATE_PEER_PREFIX))
  if (judged.length === 0) return none

  const runtimeVersion = typeof environment.dshVersion === 'string' ? environment.dshVersion : null
  const applicable = { ...none, applicable: true, runtimeVersion, key: gateKey(manifest) }
  if (runtimeVersion === null) return { ...applicable, undecidable: true }

  const peers = []
  for (const [name, rawRange] of judged) {
    const range = typeof rawRange === 'string' ? rawRange : ''
    const requirement = WORKSPACE_RANGES.has(range) ? runtimeVersion : range
    const admitted = requirement.trim() !== ''
      && satisfies(runtimeVersion, requirement, { includePrerelease: true }) === true
    if (!admitted) peers.push({ package: name, range })
  }
  if (peers.length === 0) return applicable

  const exemptions = environment.versionExemptions
  const exempted = applicable.key !== null
    && exemptions !== undefined
    && (exemptions[applicable.key] ?? []).includes(runtimeVersion)
  return { ...applicable, peers, exempted, denied: !exempted }
}

/**
 * The findings a peer check produces.
 *
 * Extracted so every caller that reports peers — the offline audit and the
 * metadata-only screen — prints the identical sentence, character for character.
 * Two code paths that describe the same fact differently is how a tool starts
 * contradicting itself.
 * @param {PeerCheck[]} peers
 * @returns {{ risks: string[], unknowns: string[] }}
 */
export function peerFindings(peers) {
  const risks = []
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
  return { risks, unknowns }
}

/**
 * A rollup of a peer check, so silence is never ambiguous: "every declared range
 * admits this machine" and "nothing was declared" are different facts, and only
 * printing failures made them look identical.
 * @param {PeerCheck[]} peers
 * @returns {{ declared: number, official: number, satisfied: number, unsatisfied: number, undecidable: number }}
 */
export function summarizePeers(peers) {
  return {
    declared: peers.length,
    official: peers.filter(check => check.package === '@deepseek-ai/dsh' || check.package.startsWith(GATE_PEER_PREFIX)).length,
    satisfied: peers.filter(check => check.satisfied === true).length,
    unsatisfied: peers.filter(check => check.satisfied === false).length,
    undecidable: peers.filter(check => check.satisfied === null).length,
  }
}

/**
 * The host's own version gate, as findings.
 *
 * This is the difference between "the range no longer matches, the code may
 * still run" and "dsh will refuse to load this row". Upstream's preflight
 * disables exactly that row (`compatibility-preflight.ts`) — the profile still
 * boots — so it is a risk, not a boot failure; but it is a risk that ends in the
 * plugin never activating, which the bare peer wording did not convey.
 * @param {VersionGate} gate
 * @returns {{ risks: string[], unknowns: string[] }}
 */
export function gateFindings(gate) {
  const risks = []
  const unknowns = []
  if (gate.undecidable) {
    unknowns.push('declares @deepseek-ai/dsh* peer ranges, which dsh\'s own version gate judges against the running '
      + 'dsh version; that version could not be read here, so whether the gate would refuse this row is unknown')
    return { risks, unknowns }
  }
  if (!gate.applicable || gate.peers.length === 0 || gate.exempted) return { risks, unknowns }
  const rejected = gate.peers.length === 1
    ? `${gate.peers[0].package}@${gate.peers[0].range}`
    : `${gate.peers.length} declared @deepseek-ai/dsh* ranges`
  const remedy = gate.key === null
    ? 'this manifest has no readable name/version, which the gate treats as "peer dependencies cannot be validated"'
    : `grant the exact-version exemption: dsh plugin allow-version ${gate.key} --dsh-version ${gate.runtimeVersion} --accept-risk`
  risks.push(`is refused by dsh's own version gate on dsh ${gate.runtimeVersion}: ${rejected} do not admit `
    + `${gate.runtimeVersion}. The profile still boots — the gate disables this row — but the plugin never loads. `
    + `To load it anyway, ${remedy}. `
    + `dsh plugin version-exemptions lists the grants already in ${PROFILE_COMPATIBILITY_FILENAME}`)
  return { risks, unknowns }
}

/**
 * Lifecycle scripts run code at install time and are always worth surfacing.
 * Read straight off the manifest, so a screen that never downloads anything can
 * report them just as well as a full audit.
 * @param {object} manifest
 * @returns {{ kind: string, level: string, detail: string }[]}
 */
export function lifecycleSignals(manifest) {
  const scripts = manifest?.scripts
  /** @type {{ kind: string, level: string, detail: string }[]} */
  const signals = []
  if (typeof scripts === 'object' && scripts !== null) {
    for (const hook of LIFECYCLE_SCRIPTS) {
      if (typeof scripts[hook] === 'string') {
        signals.push({ kind: `lifecycle:${hook}`, level: 'high', detail: `runs at install time: ${scripts[hook]}` })
      }
    }
  }
  return signals
}

/**
 * The one verdict ladder, so a screen and a full audit can never grade the same
 * evidence differently. Hard evidence outranks a failing range declaration,
 * which in turn outranks "could not decide" — but none of them is silently
 * rounded to "fine".
 * @param {string[]} blockers
 * @param {string[]} risks
 * @param {string[]} unknowns
 * @returns {'compatible' | 'at-risk' | 'incompatible' | 'unknown'}
 */
export function verdictFor(blockers, risks, unknowns) {
  if (blockers.length > 0) return 'incompatible'
  if (risks.length > 0) return 'at-risk'
  return unknowns.length > 0 ? 'unknown' : 'compatible'
}

/**
 * @typedef {object} PluginVerdict
 * @property {string} name
 * @property {string} version
 * @property {string} form
 * @property {boolean} linked
 * @property {'compatible' | 'at-risk' | 'incompatible' | 'unknown'} verdict
 * @property {PeerCheck[]} peers
 * @property {{ declared: number, official: number, satisfied: number, unsatisfied: number, undecidable: number }} peerSummary
 *   - a rollup of `peers`, so "no peer findings" can be told apart from "no peers declared".
 * @property {VersionGate} gate - dsh's own version gate for this plugin.
 * @property {{ declared: string | null, exists: boolean | null, active: boolean | null }} bundle
 * @property {string[]} officialImports
 * @property {string[]} missingPackages
 * @property {SymbolCheck[]} symbols
 * @property {{ name: string, present: boolean }[]} runtimeServices
 * @property {string[]} clientServices - inject names declared by the browser half, which the host context
 *   cannot resolve and which therefore never lower the verdict.
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
 * @param {{ signal?: AbortSignal, prospective?: boolean }} [options] - `prospective` marks a package that is
 *   not installed yet, which suppresses the "not composed into dsh.profile.bundles" finding: a package cannot
 *   be in that list before it is installed, and `dsh plugin add` is what puts it there.
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

  // -------------------------------------------------------------------------
  // Bundle layer integrity
  // -------------------------------------------------------------------------
  // A plugin whose `dsh.bundle.patch` cannot be read does not degrade — the
  // launcher throws (`packages/boot/app-boot/src/index.ts:315-323`) and the
  // profile never boots. Both failures below are read straight off the manifest
  // and the filesystem, so they are stated as fact rather than suspicion.
  //
  // Deliberately NOT checked: `dsh.client.inject`. Upstream documents it as
  // "Informational package-name dependencies, not Cordis service injection"
  // (`packages/util/package-manifest/src/types.ts:47`). A name missing there is
  // not a defect, and reporting it would be exactly the confident-false-positive
  // this tool exists to avoid.
  const bundleBlock = plugin.manifest?.dsh?.bundle
  /** @type {{ declared: string | null, exists: boolean | null, active: boolean | null }} */
  const bundle = { declared: null, exists: null, active: null }
  if (bundleBlock !== undefined) {
    const declared = bundleBlock?.patch
    if (typeof declared !== 'string' || declared === '') {
      blockers.push('declares dsh.bundle without a "patch" path, which the launcher requires: it reads '
        + 'dsh.bundle.patch and throws "declares no dsh.bundle" when it is undefined')
    } else {
      const exists = existsSync(join(plugin.directory, declared))
      const active = options.prospective === true || environment.profileBundles === undefined
        ? null
        : environment.profileBundles.includes(plugin.name)
      Object.assign(bundle, { declared, exists, active })
      if (!exists) {
        blockers.push(`declares dsh.bundle.patch "${declared}" but no such file is in the installed package: `
          + 'the launcher throws "failed to read overlay" and the profile does not boot')
      } else if (active === false) {
        risks.push('is not named in dsh.profile.bundles, so its bundle layer is never applied: '
          + '`dsh plugin add` reconciles that list, a direct `pnpm add` inside the profile does not')
      }
    }
  }

  const peerOutcome = peerFindings(peers)
  risks.push(...peerOutcome.risks)
  unknowns.push(...peerOutcome.unknowns)
  const peerSummary = summarizePeers(peers)
  const gate = evaluateVersionGate(plugin.manifest, environment)
  const gateOutcome = gateFindings(gate)
  risks.push(...gateOutcome.risks)
  unknowns.push(...gateOutcome.unknowns)

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

  // Named bindings, one level below "the package still exists". Only a surface
  // read to completion licenses calling an absent export removed.
  const symbols = checkSymbols(scan, environment)
  blockers.push(...symbols.blockers)
  unknowns.push(...symbols.unknowns)

  // Runtime services: the live context is the ground truth for `inject` names.
  //
  // A plugin with a browser half also declares *client-side* tokens — the ones
  // actually seen in the wild are `slots`, `theme` and `locale`. Those resolve on
  // the renderer's own Cordis app, so this host context can never provide them,
  // and reporting them as missing turned a working theme into an "unknown". They
  // are still surfaced, but as a fact about where they live rather than as a
  // defect: the checkable client contract is the slot names, which are verified
  // against upstream source above.
  /** @type {{ name: string, present: boolean }[]} */
  const runtimeServices = []
  /** @type {string[]} */
  const clientServices = []
  const hostDeclared = new Set(collectInjectNames(plugin.manifest))
  const hasClientHalf = typeof plugin.manifest?.dsh?.client === 'object' && plugin.manifest.dsh.client !== null
  const inject = [...new Set([...scan.injectNames, ...hostDeclared])].sort()
  const probe = runtime?.probe
  for (const service of inject) {
    if (hasClientHalf && !hostDeclared.has(service) && declaredOnlyByClientHalf(service, scan)) {
      clientServices.push(service)
      continue
    }
    const present = probe === undefined ? null : probe(service)
    if (present === null) {
      unknowns.push(`inject "${service}" is a ctx service token with no static registry to check offline`)
      continue
    }
    runtimeServices.push({ name: service, present })
    if (!present) unknowns.push(`inject "${service}" was not found on the live context`)
  }

  // Lifecycle scripts run code at install time and are always worth surfacing.
  scan.signals.push(...lifecycleSignals(plugin.manifest))

  const verdict = verdictFor(blockers, risks, unknowns)
  return {
    name: plugin.name,
    version: plugin.version,
    form: describeForm(plugin.manifest),
    linked: plugin.linked === true,
    verdict,
    peers,
    peerSummary,
    gate,
    bundle,
    officialImports: scan.officialImports,
    missingPackages,
    symbols: symbols.checks,
    runtimeServices,
    clientServices,
    missingSlots,
    signals: mergeSignals(scan.signals),
    blockers,
    risks,
    unknowns,
  }
}

/**
 * @typedef {object} SymbolCheck
 * @property {string} package
 * @property {string} subpath - '' for the package root.
 * @property {boolean} checkable - whether the package's export surface could be read at all.
 * @property {string[]} required - upstream names the plugin's imports need.
 * @property {string[]} confirmed - of those, the ones this build exports.
 * @property {string[]} missing - of those, the ones it does not.
 * @property {boolean} complete - whether an absent name may be stated as fact.
 * @property {string | null} entry - the declaration entry the surface came from.
 * @property {string | null} runtimeEntry
 * @property {number} surfaceSize - confirmed symbols in the whole surface.
 * @property {string[]} unresolved - what stopped the graph walk, as evidence.
 */

/**
 * Export surfaces are keyed by the directory they were read from, so the cost of
 * walking one package's declaration graph is paid once per audit rather than
 * once per plugin that imports it.
 * @type {Map<string, import('./symbols.js').PackageSurface>}
 */
const surfaceCache = new Map()

function surfaceFor(name, subpath, environment) {
  const resolved = resolveInstalledDirectory(name, environment)
  if (resolved === null) return null
  const key = `${resolved.dir}::${subpath}`
  const cached = surfaceCache.get(key)
  if (cached !== undefined) return cached
  const surface = buildPackageSurface(resolved.dir, resolved.manifest, subpath, {
    resolvePackage: dependency => resolveInstalledDirectory(dependency, environment),
  })
  surfaceCache.set(key, surface)
  return surface
}

/**
 * Verify the named bindings a plugin imports from official packages.
 *
 * The distinction this function exists to preserve: "the graph is complete and
 * the name is not in it" may be reported as a hard failure, because an ESM named
 * import of a binding the module does not provide is a link-time throw. "The
 * graph could not be resolved" may not — it yields `unknown`, never `removed`.
 * @param {PluginScan} scan
 * @param {Environment} environment
 * @returns {{ checks: SymbolCheck[], blockers: string[], unknowns: string[] }}
 */
export function checkSymbols(scan, environment) {
  /** @type {SymbolCheck[]} */
  const checks = []
  /** @type {string[]} */
  const blockers = []
  /** @type {string[]} */
  const unknowns = []
  if (environment.officialPackages.size === 0 || scan.symbolRequests.length === 0) {
    return { checks, blockers, unknowns }
  }

  /** @type {Map<string, Set<string>>} */
  const grouped = new Map()
  for (const request of scan.symbolRequests) {
    // A package absent from this machine is already reported by the
    // package-existence check; naming its symbols again would be noise.
    if (!environment.officialPackages.has(request.package)) continue
    const key = `${request.package}\u0000${request.subpath}`
    if (!grouped.has(key)) grouped.set(key, new Set())
    grouped.get(key).add(request.exported)
  }

  for (const [key, requiredSet] of [...grouped].sort()) {
    const [name, subpath] = key.split('\u0000')
    const required = [...requiredSet].sort()
    const label = subpath === '' ? name : `${name}/${subpath}`
    const surface = surfaceFor(name, subpath, environment)
    if (surface === null) {
      checks.push({
        package: name, subpath, checkable: false, required, confirmed: [], missing: [],
        complete: false, entry: null, runtimeEntry: null, surfaceSize: 0,
        unresolved: ['the package directory could not be located'],
      })
      unknowns.push(`imports ${required.length} name(s) from ${label}, whose installed directory could not be located`)
      continue
    }
    const confirmed = required.filter(symbol => surface.symbols.has(symbol))
    const missing = required.filter(symbol => !surface.symbols.has(symbol))
    checks.push({
      package: name,
      subpath,
      checkable: true,
      required,
      confirmed,
      missing: surface.complete ? missing : [],
      complete: surface.complete,
      entry: surface.entry,
      runtimeEntry: surface.runtimeEntry,
      surfaceSize: surface.symbols.size,
      unresolved: surface.unresolved,
    })
    if (missing.length === 0) continue
    const names = missing.map(symbol => `"${symbol}"`).join(', ')
    if (surface.complete) {
      blockers.push(`imports ${names} from ${label}, which this build does not export: the surface was read from `
        + `${surface.files} declaration file(s)${surface.entry === null ? '' : ` starting at ${relativeLabel(surface.entry, name)}`}`
        + ', resolved completely, and the name appears in neither the declarations nor the runtime entry'
        + ' — an ESM named import of a binding that is not exported fails at load time')
    } else {
      unknowns.push(`imports ${names} from ${label}, which could not be confirmed as exported: `
        + `the declaration graph is incomplete (${surface.unresolved.join('; ') || 'unspecified'})`)
    }
  }
  return { checks, blockers, unknowns }
}

/** Render a declaration path relative to its package for a readable message. */
function relativeLabel(file, name) {
  const marker = name.split('/').pop()
  const index = file.lastIndexOf(marker)
  return (index === -1 ? file : file.slice(index)).replaceAll('\\', '/')
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

/**
 * Whether every place this plugin declares `name` is its browser half.
 *
 * Path based on purpose: the manifest's `dsh.client.inject` holds *package names*
 * for most plugins and bare service tokens for a few, so it cannot be used to
 * classify a token; the file that declared it can. Only consulted when the plugin
 * actually declares a client half, so a host-only plugin can never have a real
 * missing service excused this way.
 * @param {string} name
 * @param {PluginScan} scan
 */
function declaredOnlyByClientHalf(name, scan) {
  const files = (scan.injectDeclarations ?? [])
    .filter(entry => entry.name === name)
    .map(entry => entry.file)
  if (files.length === 0) return false
  return files.every(file => /(^|\/)client\//.test(file) || /(^|\/)client\.[cm]?[jt]sx?$/.test(file))
}

export function describeForm(manifest) {
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
 * @typedef {object} ProfileIssue
 * @property {'blocker' | 'risk'} level
 * @property {string} detail
 */

/**
 * Check the profile's own composition for an entry the launcher will refuse.
 *
 * `dsh.profile.bundles` is the only source of bundle layers, and every entry is
 * resolved and read during profile load: a name that does not resolve makes the
 * launcher throw (`packages/boot/app-boot/src/profile.ts:789-797`). The
 * per-plugin cases are reported on the plugin itself; this covers the entry that
 * has no plugin to attach to.
 *
 * `installed` must be the *whole* profile, never a target-filtered slice: passing
 * only the audited plugin made every other bundle entry look uninstalled, and the
 * resulting "the profile does not boot" blockers were the single most alarming
 * false positive this tool produced. A plugin that is installed but denied by the
 * version gate belongs to the per-plugin report, not here.
 * @param {Environment} environment
 * @param {(PluginVerdict | InstalledPlugin | { name: string })[]} installed - everything present in the profile.
 * @param {boolean} [enumerationComplete] - false when the profile's node_modules could not be read.
 * @returns {ProfileIssue[]}
 */
export function checkProfileIntegrity(environment, installed, enumerationComplete = true) {
  const bundles = environment.profileBundles
  if (bundles === undefined) return []
  if (!enumerationComplete && bundles.length > 0) {
    return [{
      level: 'risk',
      detail: `dsh.profile.bundles lists ${bundles.length} entr${bundles.length === 1 ? 'y' : 'ies'}, but the `
        + 'profile\'s node_modules could not be read, so none of them could be verified against what is installed',
    }]
  }
  const present = new Set(installed.map(entry => (typeof entry === 'string' ? entry : entry.name)))
  /** @type {ProfileIssue[]} */
  const issues = []
  for (const name of bundles) {
    if (present.has(name) || environment.officialPackages.has(name)) continue
    issues.push({
      level: 'blocker',
      detail: `dsh.profile.bundles names "${name}", but no package by that name is installed in this profile and it `
        + 'is not an official package. The launcher resolves every bundles entry while loading the profile, cannot '
        + `resolve this one, and throws — the profile does not boot. Remove the entry (dsh plugin remove ${name}) `
        + 'or reinstall the package.',
    })
  }
  return issues
}

/**
 * Audit one plugin, or every plugin installed in the profile.
 * @param {{ environment: Environment, target?: string, runtime?: { probe?: (name: string) => boolean | null }, signal?: AbortSignal }} input
 * @returns {{ environment: Environment, plugins: PluginVerdict[], resolvedTarget: string | null, profileIssues: ProfileIssue[] }}
 */
export function audit(input) {
  const { environment, target, runtime, signal } = input
  const profileDir = environment.profileDir
  if (profileDir === undefined) return { environment, plugins: [], resolvedTarget: null, profileIssues: [] }

  // Enumerated once, for the whole profile, regardless of `target`: profile
  // integrity is a statement about the profile, not about the audited slice.
  const installed = listInstalledPlugins(profileDir)
  const enumerationComplete = existsSync(join(profileDir, 'node_modules'))

  if (typeof target === 'string' && target.trim() !== '') {
    const plugin = resolveTarget(target.trim(), installed)
    if (plugin === null) return { environment, plugins: [], resolvedTarget: null, profileIssues: [] }
    const plugins = [judgePlugin(plugin, environment, runtime, { signal })]
    return {
      environment,
      plugins,
      resolvedTarget: plugin.directory,
      profileIssues: checkProfileIntegrity(environment, installed, enumerationComplete),
    }
  }

  const plugins = installed
    .map((plugin) => {
      signal?.throwIfAborted()
      return judgePlugin(plugin, environment, runtime, { signal })
    })
  return {
    environment,
    plugins,
    resolvedTarget: profileDir,
    profileIssues: checkProfileIntegrity(environment, installed, enumerationComplete),
  }
}

/**
 * Resolve an audit target: an absolute/relative directory, or a package name
 * installed in the profile.
 * @param {string} target
 * @param {InstalledPlugin[]} installed - the profile's plugins, enumerated once by the caller.
 * @returns {InstalledPlugin | null}
 */
function resolveTarget(target, installed) {
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
  return installed.find(plugin => plugin.name === target) ?? null
}
