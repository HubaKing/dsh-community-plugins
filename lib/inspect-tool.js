/**
 * The model-facing pre-install tool.
 *
 * Kept in its own module, and registered under its own name, because it is the
 * only part of this plugin that uses the network. `dsh_plugin_audit` promises
 * "nothing is fetched"; a flag on that tool would make the promise conditional
 * and therefore worthless. Two tools, two guarantees, no ambiguity about which
 * one is running.
 *
 * @module dsh-community-plugins/inspect-tool
 */

import { resolveEnvironment, selectProfile } from './audit.js'
import { inspectPackage, screenPackages } from './inspect.js'
import { DEFAULT_REGISTRY } from './registry.js'
import { VERDICT_LABEL, marker, pushFindings, renderGate, renderPeerSummary } from './tool.js'

export const INSPECT_TOOL_NAME = 'dsh_plugin_inspect'

/** A download plus a cold declaration-graph walk needs more room than the offline audit. */
const INSPECT_TIMEOUT_MS = 60_000
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000

/**
 * @param {object} ctx - used only to learn which profile this process is running,
 *   so the candidate is judged against the build that is actually composed.
 * @returns {object} a registry-ready tool definition.
 */
export function createInspectTool(ctx) {
  return {
    name: INSPECT_TOOL_NAME,
    description:
      'Inspect a DSH plugin BEFORE installing it: download its published tarball, unpack it in a temporary '
      + 'directory, and audit it against the dsh build on this machine. '
      + 'THIS TOOL USES THE NETWORK — it fetches from the npm registry (or codeload.github.com for a '
      + 'github: spec). It never installs anything, never writes into the profile, and never runs the '
      + 'package\'s lifecycle scripts: a postinstall hook is reported as a finding, not executed. It reports '
      + 'the resolved version and the tarball\'s sha256, verifies the registry\'s published integrity hash '
      + 'when there is one, and lists what it unpacked. '
      + 'It answers the questions that decide whether an install is safe: would this plugin\'s bundle layer '
      + 'mount at all (a declared dsh.bundle.patch that is missing, or a dsh.bundle with no patch, makes the '
      + 'launcher throw and the profile fail to boot); do its declared peerDependencies ranges admit the '
      + 'versions installed here, applying the rc-prerelease semver rule; will dsh\'s own version gate refuse the '
      + 'install (it judges only @deepseek-ai/dsh* peers against the running dsh version and requires an '
      + 'exact-version exemption in compatibility.json when they conflict — this is the check that turns "at-risk" '
      + 'into "this install will be rejected"); do the @deepseek-ai packages and '
      + 'the named exports it imports still exist in this build; do the client slots it registers still exist '
      + 'upstream; what install-time risks does the code carry (npm lifecycle scripts, dynamic code, shell '
      + 'execution, network calls, a repo-provided install.sh that bypasses `dsh plugin` management). '
      + 'Accept a package name (optionally name@version or name@range), a github:owner/repo#ref spec, or an '
      + 'http(s) tarball URL. Verdicts mean the same as in dsh_plugin_audit: "incompatible" is a hard '
      + 'failure, "at-risk" means a declared range no longer matches or the version gate will refuse the row, '
      + '"unknown" means a check that cannot be '
      + 'decided. For plugins already installed, prefer dsh_plugin_audit, which stays offline. '
      + 'To screen MANY candidates at once — "which of these can I actually install here?" — pass an array of npm '
      + 'specs instead of a single string: that mode reads the registry documents only and downloads no package '
      + 'bytes at all, so it judges the declared peer ranges, the version gate and the manifest\'s lifecycle '
      + 'scripts, and states what it could not see. Use a single string on the survivors for the full audit.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          // One parameter, two shapes, validated by dsh's own checker: a string
          // audits one package in full; an array screens many from metadata.
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'One package to audit in full (an npm package name such as "dsh-llm-local-token", '
            + '"pkg@1.2.3", "@scope/pkg@^1.2", a "github:owner/repo#ref" spec, or an http(s) tarball URL), '
            + 'or an array of npm specs to screen from registry metadata alone without downloading any package '
            + 'bytes. Use the array to shortlist candidates, then the string on the ones worth auditing.',
        },
        profile: {
          type: 'string',
          description: 'Profile whose dsh build to compare against (e.g. "web", "desktop"). Defaults to the '
            + 'profile this dsh process is actually running.',
        },
        registry: {
          type: 'string',
          description: `npm registry base URL. Defaults to ${DEFAULT_REGISTRY}; set it only for a mirror.`,
        },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderInspection(value) }],
    },
    timeoutMs: INSPECT_TIMEOUT_MS,
    async execute(args, exec) {
      const signal = exec?.signal
      signal?.throwIfAborted()
      const selection = selectProfile(ctx, args.profile)
      const environment = resolveEnvironment({
        profileName: selection.profileName,
        profileDir: selection.profileDir,
      })
      if (selection.notes.length > 0) environment.notes.push(...selection.notes)
      const registry = typeof args.registry === 'string' && args.registry.trim() !== ''
        ? args.registry.trim()
        : undefined
      // The array form is the screen: metadata only, no package bytes.
      if (Array.isArray(args.spec)) {
        const specs = args.spec.filter(spec => typeof spec === 'string' && spec.trim() !== '')
        if (specs.length === 0) return argumentError('"spec" was an empty array: give at least one package name', registry)
        return screenPackages({
          specs,
          environment,
          registry,
          signal,
          networkTimeoutMs: DEFAULT_NETWORK_TIMEOUT_MS,
        })
      }
      // A missing or unusable spec comes back as a report, never as a throw and
      // never as a request: this tool fails closed on bad arguments.
      if (typeof args.spec !== 'string' || args.spec.trim() === '') {
        return argumentError('"spec" must be a package specifier, or an array of them to screen', registry)
      }
      return inspectPackage({
        spec: args.spec,
        environment,
        registry,
        signal,
        networkTimeoutMs: DEFAULT_NETWORK_TIMEOUT_MS,
      })
    },
  }
}

/**
 * The report shape a bad argument produces: the same envelope the renderer
 * already handles for a network failure, so a caller that reads machine output
 * cannot mistake it for a result.
 * @param {string} message
 * @param {string | undefined} registry
 */
function argumentError(message, registry) {
  return {
    network: true,
    source: { registry: registry ?? DEFAULT_REGISTRY },
    package: null,
    extraction: null,
    alreadyInstalled: null,
    error: message,
  }
}

/**
 * Rendering must be total: replay can hand it any logged value, and a throw here
 * would lose the report entirely.
 * @param {unknown} value
 */
export function renderInspection(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return String(value)
  const report = /** @type {*} */ (value)
  // One tool, two shapes: a single audit, or a screen over many specs. Keyed on
  // the screen's own marker, not on `candidates` — a single inspection carries
  // package.json candidates from inside the tarball under the same name.
  if (report.metadataOnly === true && Array.isArray(report.candidates)) return renderScreen(report)
  const source = report.source ?? {}
  const lines = []
  lines.push(`dsh plugin inspect — ${source.name ?? '?'}@${source.version ?? source.requested ?? '?'}`
    + `  ⚠ USES THE NETWORK (${source.host ?? source.registry ?? DEFAULT_REGISTRY})`)
  if (typeof source.url === 'string') lines.push(`source: ${source.url}`)
  const facts = []
  if (typeof source.sha256 === 'string') facts.push(`sha256 ${source.sha256}`)
  if (typeof source.bytes === 'number') facts.push(`${source.bytes} bytes`)
  if (source.integrityVerified === true) facts.push('registry integrity VERIFIED')
  else if (source.integrityVerified === false) facts.push('registry integrity MISMATCH')
  else facts.push('no published hash to verify against')
  if (typeof source.publishedAt === 'string') facts.push(`published ${source.publishedAt}`)
  lines.push(facts.join(' · '))
  lines.push('')

  if (typeof report.error === 'string' && report.error !== '') {
    lines.push(`✗ ${report.error}`)
    lines.push('')
    lines.push('nothing was installed and no profile was modified.')
    return lines.join('\n').trimEnd()
  }

  const plugin = report.package
  if (typeof plugin === 'object' && plugin !== null) {
    lines.push(`${plugin.name}@${plugin.version}  [${plugin.form}]  →  ${VERDICT_LABEL[plugin.verdict] ?? plugin.verdict}`
      + '   (would install; nothing was changed)')
    if (plugin.bundle?.declared != null || plugin.bundle?.exists === false) {
      lines.push(`   layer ${plugin.bundle.declared ?? '(none)'} — ${plugin.bundle.exists ? 'readable' : 'MISSING'}`
        + ' (would be added to dsh.profile.bundles by `dsh plugin add`)')
    }
    pushFindings(lines, plugin.blockers, 'blocker')
    pushFindings(lines, plugin.risks, 'risk')
    pushFindings(lines, plugin.unknowns, 'unknown')
    const peers = renderPeerSummary(plugin, report.environment?.dshVersion ?? 'the build installed here')
    if (peers !== null) lines.push(`   ${peers}`)
    const gate = renderGate(plugin, true)
    if (gate !== null) lines.push(`   ${gate}`)
    if (Array.isArray(plugin.clientServices) && plugin.clientServices.length > 0) {
      lines.push(`   client-side injects (declared by the browser half; the host context cannot resolve them): `
        + plugin.clientServices.join(', '))
    }
    for (const signal of Array.isArray(plugin.signals) ? plugin.signals : []) {
      const times = signal.occurrences > 1 ? ` ×${signal.occurrences}` : ''
      lines.push(`   • [${signal.level}] ${signal.kind}${times}:${signal.detail}`)
    }
    if (Array.isArray(plugin.symbols) && plugin.symbols.length > 0) {
      const summary = plugin.symbols
        .map(check => `${check.subpath === '' ? check.package : `${check.package}/${check.subpath}`}`
          + ` ${check.confirmed.length}/${check.required.length} confirmed${check.complete ? '' : ' (partial analysis)'}`)
        .join(', ')
      lines.push(`   names imported from official packages: ${summary}`)
    }
    lines.push('')
  }

  const installed = report.alreadyInstalled
  if (typeof installed === 'object' && installed !== null) {
    lines.push(installed.installedVersion === null
      ? 'not installed in this profile'
      : `already installed here: ${installed.installedVersion}`
        + `${installed.same ? ' (same version — reinstalling changes nothing)' : ' (different from the candidate)'}`)
    lines.push('')
  }

  const extraction = report.extraction
  if (typeof extraction === 'object' && extraction !== null) {
    lines.push(`unpacked ${extraction.files} file(s), ${extraction.bytes} bytes`
      + `${extraction.limited ? ' (a limit stopped extraction)' : ''}`)
    if (Array.isArray(extraction.skipped) && extraction.skipped.length > 0) {
      for (const entry of extraction.skipped.slice(0, 3)) {
        lines.push(`   ✗ refused ${entry.name}: ${entry.reason}`)
      }
    }
    lines.push('')
  }

  if (Array.isArray(report.candidates) && report.candidates.length > 1) {
    lines.push(`package.json candidates in the tarball (audited "${report.packageRoot}"):`)
    for (const candidate of report.candidates.slice(0, 6)) {
      lines.push(`   ${candidate.dsh ? '*' : '-'} ${candidate.path} — ${candidate.name ?? '?'}@${candidate.version ?? '?'}`)
    }
    lines.push('')
  }

  lines.push('nothing was installed, nothing was written to the profile, and no lifecycle script was run.')
  return lines.join('\n').trimEnd()
}

/**
 * The screening report: one line per candidate, with the same `peers:` and `gate:`
 * lines the single audit prints, then the limits of a metadata-only run.
 *
 * Rendering must stay total: replay can hand it any logged value.
 * @param {*} report
 */
export function renderScreen(report) {
  const source = report.source ?? {}
  const environment = report.environment ?? {}
  const candidates = Array.isArray(report.candidates) ? report.candidates : []
  const lines = []
  lines.push(`dsh plugin screen — ${candidates.length} spec(s) from ${source.registry ?? DEFAULT_REGISTRY}`
    + '  (metadata only: no package bytes downloaded)')
  lines.push(`dsh ${environment.dshVersion ?? '?'}`
    + `${environment.profileName == null ? '' : ` · profile ${environment.profileName}`}`)
  lines.push('')

  if (typeof report.error === 'string' && report.error !== '') {
    lines.push(`✗ ${report.error}`)
    lines.push('')
  }

  const failed = candidates.filter(candidate => typeof candidate.error === 'string' && candidate.error !== '')
  const screened = candidates.filter(candidate => typeof candidate.error !== 'string' || candidate.error === '')
  if (failed.length > 0) {
    for (const candidate of failed) lines.push(`${marker('blocker')} ${candidate.requested}: ${candidate.error}`)
    lines.push('')
  }

  for (const candidate of screened) {
    const facts = [candidate.form]
    if (candidate.license != null) facts.push(candidate.license)
    if (candidate.publishedAt != null) facts.push(`published ${String(candidate.publishedAt).slice(0, 10)}`)
    if (candidate.deprecated != null) facts.push('DEPRECATED')
    lines.push(`── ${candidate.name}@${candidate.version}  [${facts.join(' · ')}]`
      + `  →  ${VERDICT_LABEL[candidate.verdict] ?? candidate.verdict}`)
    pushFindings(lines, candidate.risks, 'risk')
    pushFindings(lines, candidate.unknowns, 'unknown')
    const peers = renderPeerSummary(candidate, environment.dshVersion ?? 'the build installed here')
    if (peers !== null) lines.push(`   ${peers}`)
    const gate = renderGate(candidate, false)
    if (gate !== null) lines.push(`   ${gate}`)
    if (candidate.deprecated != null) lines.push(`   ! deprecated by its publisher: ${candidate.deprecated}`)
    for (const signal of Array.isArray(candidate.signals) ? candidate.signals : []) {
      const times = signal.occurrences > 1 ? ` ×${signal.occurrences}` : ''
      lines.push(`   • [${signal.level}] ${signal.kind}${times}:${signal.detail}`)
    }
    lines.push('')
  }

  const limits = Array.isArray(report.limits) ? report.limits : []
  if (limits.length > 0) {
    lines.push('limits of this run:')
    for (const limit of limits) lines.push(`   - ${limit}`)
    lines.push('')
  }
  lines.push('nothing was installed, nothing was written to the profile, and no lifecycle script was run.')
  return lines.join('\n').trimEnd()
}
