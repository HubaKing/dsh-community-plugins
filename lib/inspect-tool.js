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

import { resolveEnvironment } from './audit.js'
import { inspectPackage } from './inspect.js'
import { DEFAULT_REGISTRY } from './registry.js'
import { VERDICT_LABEL, pushFindings } from './tool.js'

export const INSPECT_TOOL_NAME = 'dsh_plugin_inspect'

/** A download plus a cold declaration-graph walk needs more room than the offline audit. */
const INSPECT_TIMEOUT_MS = 60_000
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000

/**
 * @param {object} _ctx - unused: this tool needs no runtime state, unlike the audit's service probe.
 * @returns {object} a registry-ready tool definition.
 */
export function createInspectTool(_ctx) {
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
      + 'versions installed here, applying the rc-prerelease semver rule; do the @deepseek-ai packages and '
      + 'the named exports it imports still exist in this build; do the client slots it registers still exist '
      + 'upstream; what install-time risks does the code carry (npm lifecycle scripts, dynamic code, shell '
      + 'execution, network calls, a repo-provided install.sh that bypasses `dsh plugin` management). '
      + 'Accept a package name (optionally name@version or name@range), a github:owner/repo#ref spec, or an '
      + 'http(s) tarball URL. Verdicts mean the same as in dsh_plugin_audit: "incompatible" is a hard '
      + 'failure, "at-risk" means a declared range no longer matches, "unknown" means a check that cannot be '
      + 'decided. For plugins already installed, prefer dsh_plugin_audit, which stays offline.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'What to inspect: an npm package name ("dsh-llm-local-token", "pkg@1.2.3", '
            + '"@scope/pkg@^1.2"), a "github:owner/repo#ref" spec, or an http(s) tarball URL.',
        },
        profile: {
          type: 'string',
          description: 'Profile whose dsh build to compare against (e.g. "web"). Defaults to "web" when it '
            + 'exists, otherwise the only profile present.',
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
      const environment = resolveEnvironment({ profileName: args.profile })
      const registry = typeof args.registry === 'string' && args.registry.trim() !== ''
        ? args.registry.trim()
        : undefined
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
 * Rendering must be total: replay can hand it any logged value, and a throw here
 * would lose the report entirely.
 * @param {unknown} value
 */
export function renderInspection(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return String(value)
  const report = /** @type {*} */ (value)
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
