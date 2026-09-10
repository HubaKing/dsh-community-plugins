/**
 * Pre-install audit: fetch, unpack, and judge a plugin *before* it is installed.
 *
 * The offline audit can only look at what is already on disk, and by then the
 * decision has been made. This module closes that gap. It downloads a package's
 * tarball into a temporary directory, runs the same verdict engine the installed
 * audit uses, and deletes everything it wrote.
 *
 * Four properties are load-bearing, and each has a test:
 *
 *   1. **Nothing is installed.** No profile is touched, `dsh plugin add` is never
 *      invoked, and npm lifecycle scripts are never executed — a `postinstall`
 *      is reported as a finding, not obeyed.
 *   2. **The artifact is pinned.** When the registry published an integrity
 *      hash, the bytes are verified against it before anything is unpacked, so
 *      the report cannot describe a different file than the one that arrived.
 *   3. **Unpacking is sandboxed.** Path traversal and link entries are refused
 *      by `lib/tar.js`, and the tree is removed on every exit path.
 *   4. **The network is disclosed.** `network: true` rides in the result, because
 *      the project's other tool promises the opposite and the difference has to
 *      be visible in the output, not just in the documentation.
 *
 * @module dsh-community-plugins/inspect
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { judgePlugin } from './audit.js'
import { DEFAULT_GITHUB, DEFAULT_REGISTRY, downloadTarball, parseSpec, resolveGithub, resolveNpm } from './registry.js'
import { extractTarGz } from './tar.js'

/** Repo-provided installer scripts: they bypass `dsh plugin` dependency management. */
const INSTALL_SCRIPT_PATTERN = /^(install|setup|deploy|bootstrap)[.-]?(sh|ps1|bat|cmd|bash|zsh|mjs|js)$/i

/** How much of the extracted file list to keep, so a huge package cannot bloat the report. */
const MAX_LISTED_FILES = 200
const MAX_MANIFEST_DEPTH = 4

/**
 * @typedef {object} InspectInput
 * @property {string} spec - package name, `github:owner/repo`, or an http(s) tarball URL.
 * @property {import('./audit.js').Environment} environment
 * @property {string} [registry]
 * @property {string} [github]
 * @property {number} [networkTimeoutMs]
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetchImpl] - injected by tests; never exposed on the tool.
 */

/**
 * Fetch a package and judge it against this machine without installing it.
 * @param {InspectInput} input
 * @returns {Promise<object>} a report; network failures come back as `error`, not as a throw.
 */
export async function inspectPackage(input) {
  const registry = (input.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '')
  /** @type {object} */
  const report = {
    network: true,
    // Restated in the payload, not only in the description: a caller that only
    // reads machine-readable output must still be able to tell this tool apart
    // from the offline one.
    source: { spec: input.spec, registry },
    package: null,
    extraction: null,
    alreadyInstalled: null,
    error: null,
  }
  let temporary
  try {
    if (!/^https?:\/\//i.test(registry)) {
      throw new Error(`the registry must be an http(s) URL, got "${registry}"`)
    }
    const spec = parseSpec(input.spec, { registry, github: input.github ?? DEFAULT_GITHUB })
    report.source.kind = spec.kind
    report.source.name = spec.name
    report.source.requested = spec.range
    const signal = combineSignals(input.signal, input.networkTimeoutMs)
    const resolved = spec.kind === 'npm'
      ? await resolveNpm(spec, { registry, fetchImpl: input.fetchImpl, signal })
      : resolveGithub(spec)
    Object.assign(report.source, {
      version: resolved.version,
      url: resolved.url,
      host: hostOf(resolved.url) ?? new URL(registry).host,
      integrity: resolved.integrity,
      publishedAt: resolved.publishedAt,
      unpackedSize: resolved.unpackedSize,
    })

    const download = await downloadTarball(
      { url: resolved.url, integrity: resolved.integrity, shasum: resolved.shasum },
      { fetchImpl: input.fetchImpl, signal },
    )
    Object.assign(report.source, {
      bytes: download.bytes,
      sha256: download.sha256,
      integrityVerified: download.integrityVerified,
    })

    temporary = mkdtempSync(join(tmpdir(), 'dsh-plugin-inspect-'))
    const extraction = extractTarGz(download.body, temporary)
    const listed = extraction.files.slice(0, MAX_LISTED_FILES)
    report.extraction = {
      files: extraction.files.length,
      bytes: extraction.bytes,
      skipped: extraction.skipped,
      limited: extraction.limited,
      listed,
      truncated: extraction.files.length > listed.length,
    }

    const located = locateManifest(temporary)
    if (located === null) throw new Error('the tarball contains no package.json, so it is not a plugin package')
    report.packageRoot = relative(temporary, located.dir).replaceAll('\\', '/') || '.'
    report.candidates = located.candidates

    const plugin = {
      name: typeof located.manifest.name === 'string' ? located.manifest.name : input.spec,
      version: typeof located.manifest.version === 'string' ? located.manifest.version : 'unknown',
      directory: located.dir,
      manifest: located.manifest,
      linked: false,
    }
    // `prospective: true` suppresses the "not composed into dsh.profile.bundles"
    // finding: nothing can be in that list before it is installed, and
    // `dsh plugin add` is what puts it there. Everything else is judged exactly
    // as an installed plugin would be, against the dsh build on this machine.
    const verdict = judgePlugin(plugin, input.environment, {}, { signal: input.signal, prospective: true })
    appendInstallScriptSignal(verdict, extraction.files)
    appendExtractionSignal(verdict, report.extraction)
    verdict.bundle.prospective = true
    report.package = verdict
    report.alreadyInstalled = findInstalled(input.environment, plugin.name, plugin.version)
    // The prospective suppression above is about the *candidate*. If the same
    // package is already installed here and its layer is not composed in, that
    // is a fact about today and belongs in the report.
    if (report.alreadyInstalled?.installedVersion != null
      && report.alreadyInstalled.inProfileBundles === false
      && verdict.bundle.declared !== null) {
      verdict.risks.push('a copy is already installed in this profile but is not named in dsh.profile.bundles, '
        + 'so its bundle layer is not applied today: `dsh plugin add` reconciles that list, a direct `pnpm add` '
        + 'inside the profile does not')
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true })
  }
  return report
}

/**
 * A repo-provided `install.sh` / `install.ps1` / `setup.*` is a distinct risk
 * from an npm lifecycle hook: it rewrites the profile's patch file and links the
 * package into `node_modules` by hand, so `dsh plugin update` and `remove` can no
 * longer manage it. `SKILL.md` warns about this class; this is where the warning
 * gets teeth.
 * @param {object} verdict
 * @param {string[]} files
 */
function appendInstallScriptSignal(verdict, files) {
  for (const file of files) {
    const depth = file.split('/').length
    if (depth > 2) continue
    const base = file.split('/').pop()
    if (!INSTALL_SCRIPT_PATTERN.test(base)) continue
    verdict.signals.push({
      kind: 'installer-script',
      level: 'high',
      detail: `ships ${file}, which bypasses \`dsh plugin\` dependency management`
        + ' (it edits the profile directly, so update and remove stop managing it)',
      occurrences: 1,
    })
  }
}

/** Extraction anomalies are facts about the artifact and belong in the report. */
function appendExtractionSignal(verdict, extraction) {
  if (extraction.skipped.length > 0) {
    verdict.signals.push({
      kind: 'unsafe-archive-entry',
      level: 'high',
      detail: `the tarball contains ${extraction.skipped.length} entry/entries the extractor refused: `
        + extraction.skipped.slice(0, 3).map(entry => `${entry.name} (${entry.reason})`).join(', '),
      occurrences: extraction.skipped.length,
    })
  }
}

/**
 * Find the package root inside an extracted tree.
 *
 * An npm tarball always unpacks under `package/`; a GitHub tarball under
 * `<repo>-<ref>/`, and a monorepo has no root manifest at all. The shallowest
 * manifest that declares a `dsh` block wins, because that is the thing that
 * would actually be installed; the rest are reported as candidates rather than
 * silently ignored.
 * @param {string} root
 * @returns {{ dir: string, manifest: object, candidates: { path: string, name: string | null }[] } | null}
 */
function locateManifest(root) {
  /** @type {{ dir: string, manifest: object, depth: number }[]} */
  const found = []
  const visit = (directory, depth) => {
    if (depth > MAX_MANIFEST_DEPTH) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    const manifestPath = join(directory, 'package.json')
    try {
      if (statSync(manifestPath).isFile()) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest?.name === 'string') found.push({ dir: directory, manifest, depth })
      }
    } catch { /* not a readable manifest */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      visit(join(directory, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  if (found.length === 0) return null
  const dshPackages = found.filter(entry => typeof entry.manifest.dsh === 'object' && entry.manifest.dsh !== null)
  const chosen = (dshPackages.length > 0 ? dshPackages : found)
    .slice()
    .sort((left, right) => left.depth - right.depth)[0]
  return {
    dir: chosen.dir,
    manifest: chosen.manifest,
    candidates: found.map(entry => ({
      path: relative(root, entry.dir).replaceAll('\\', '/') || '.',
      name: typeof entry.manifest.name === 'string' ? entry.manifest.name : null,
      version: typeof entry.manifest.version === 'string' ? entry.manifest.version : null,
      dsh: typeof entry.manifest.dsh === 'object' && entry.manifest.dsh !== null,
    })),
  }
}

/**
 * Compare the candidate with what is installed, when it is installed at all.
 * "You are about to install the version you already have" is worth knowing.
 * @param {import('./audit.js').Environment} environment
 * @param {string} name
 * @param {string} version
 */
function findInstalled(environment, name, version) {
  if (environment.profileDir === undefined) return null
  const manifestPath = join(environment.profileDir, 'node_modules', ...name.split('/'), 'package.json')
  try {
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return {
      installedVersion: typeof installed.version === 'string' ? installed.version : 'unknown',
      candidateVersion: version,
      same: installed.version === version,
      inProfileBundles: Array.isArray(environment.profileBundles)
        ? environment.profileBundles.includes(name)
        : null,
    }
  } catch {
    return { installedVersion: null, candidateVersion: version, same: false, inProfileBundles: null }
  }
}

/** Bound a single network call, and keep honouring the caller's abort signal. */
function combineSignals(signal, timeoutMs) {
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  if (signal === undefined) return timeout
  if (timeout === undefined) return signal
  return AbortSignal.any([signal, timeout])
}

/** The host a tarball actually comes from, so the report names it correctly. */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
