/**
 * The model-facing audit tool.
 *
 * The definition is written by hand as a plain object rather than built with
 * `defineTool` from `@deepseek-ai/dsh-tools`. That is a deliberate compatibility
 * decision: `ctx.tools.register` only requires `{ name, description, parameters,
 * output: { schema, render }, execute }`, and a plain object cannot break when
 * upstream renames or moves an exported symbol. Upstream states plainly that
 * "Public APIs are pre-stable", so the narrowest possible surface — the shape
 * `register` validates — is the one least likely to change under it.
 *
 * @module dsh-community-plugins/tool
 */

import { audit, createServiceProbe, resolveEnvironment } from './audit.js'

export const AUDIT_TOOL_NAME = 'dsh_plugin_audit'

/** How many findings of one kind to spell out before summarizing the rest. */
const MAX_FINDINGS_SHOWN = 3

/**
 * Build the audit tool bound to this plugin's Cordis context.
 *
 * `ctx` is only used for the runtime service probe: the live context is the one
 * source of truth for whether an `inject` name still resolves, and it is
 * available here without ever being declared as a hard dependency.
 * @param {object} ctx
 * @returns {object} a registry-ready tool definition.
 */
export function createAuditTool(ctx) {
  const probe = createServiceProbe(ctx)
  return {
    name: AUDIT_TOOL_NAME,
    description:
      'Audit the community plugins installed in a DSH profile against the dsh build running on this machine. '
      + 'Runs entirely offline, reading the dsh install root and the profile from disk, and reports for each plugin: '
      + 'declared peerDependencies ranges compared against the versions actually installed (applying the '
      + 'rc-prerelease semver rule, so a pinned `^0.1.0-rc.5` correctly fails to match a differently-pinned '
      + 'prerelease), whether the @deepseek-ai packages its source imports still exist in this build, whether the '
      + 'client slots it registers are still defined upstream, whether the services it injects resolve on the live '
      + 'context, and install-time risk signals such as npm lifecycle scripts, dynamic code, and shell execution. '
      + 'Use this before upgrading dsh to learn which installed plugins may break, or after installing a plugin to '
      + 'verify it. Verdicts: "incompatible" means a package or slot it needs is gone from this build; "at-risk" '
      + 'means a declared range no longer matches though the code may still run; "unknown" means something needed a '
      + 'check this tool cannot perform offline. Nothing is fetched from the network and no dataset is consulted, '
      + 'so the result always describes this machine right now.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Audit one plugin only: an installed package name (e.g. "dsh-llm-local-token") or a '
            + 'directory path. Omit to audit every third-party plugin installed in the profile.',
        },
        profile: {
          type: 'string',
          description: 'Profile name under the dsh home directory (e.g. "web"). Defaults to "web" when it exists, '
            + 'otherwise the only profile present.',
        },
      },
      additionalProperties: false,
    },
    output: {
      // Any JSON value: the report is assembled below and rendered to text.
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    // Declaring a budget is a promise, not a decoration: `timeoutMs` asserts
    // that this tool forwards `exec.signal` and can reach quiescence when the
    // budget aborts. The audit reads many small files, so a cold cache can make
    // it slow; `execute` therefore passes `signal` all the way into the scan,
    // which re-checks it at every file boundary (`lib/audit.js`).
    timeoutMs: 30_000,
    async execute(args, exec) {
      const signal = exec?.signal
      signal?.throwIfAborted()
      const environment = resolveEnvironment({ profileName: args.profile })
      const result = audit({ environment, target: args.target, runtime: { probe }, signal })
      signal?.throwIfAborted()
      return buildReport(result)
    },
  }
}

/**
 * @param {{ environment: import('./audit.js').Environment, plugins: import('./audit.js').PluginVerdict[], resolvedTarget: string | null }} result
 */
function buildReport(result) {
  const { environment, plugins } = result
  const summary = { total: plugins.length, compatible: 0, 'at-risk': 0, incompatible: 0, unknown: 0 }
  for (const plugin of plugins) summary[plugin.verdict] += 1
  return {
    environment: {
      dshVersion: environment.dshVersion ?? null,
      dshRoot: environment.dshRoot ?? null,
      profileName: environment.profileName ?? null,
      profileDir: environment.profileDir ?? null,
      officialPackageCount: environment.officialPackages.size,
      officialSlotCount: environment.officialSlots.size,
    },
    summary,
    target: result.resolvedTarget,
    plugins,
    limits: environment.notes,
  }
}

const VERDICT_LABEL = {
  compatible: 'COMPATIBLE',
  'at-risk': 'AT-RISK',
  incompatible: 'INCOMPATIBLE',
  unknown: 'UNKNOWN',
}

function renderReport(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return String(value)
  const report = /** @type {*} */ (value)
  const lines = []
  const environment = report.environment ?? {}
  lines.push(`dsh plugin audit — dsh ${environment.dshVersion ?? '?'} · profile ${environment.profileName ?? '?'}`
    + ` · ${environment.officialPackageCount ?? 0} official packages, ${environment.officialSlotCount ?? 0} slots`)
  if (typeof environment.profileDir === 'string') lines.push(`profile: ${environment.profileDir}`)
  lines.push('')

  const summary = report.summary ?? {}
  lines.push(`${summary.total ?? 0} plugin(s) · ${summary.compatible ?? 0} compatible · `
    + `${summary['at-risk'] ?? 0} at-risk · ${summary.incompatible ?? 0} incompatible · ${summary.unknown ?? 0} unknown`)

  const plugins = Array.isArray(report.plugins) ? report.plugins : []
  if (plugins.length === 0) {
    lines.push('', typeof report.target === 'string'
      ? `nothing matched target "${report.target}" — check the package name or path`
      : 'no third-party plugins are installed in this profile')
  }
  lines.push('')

  for (const plugin of plugins) {
    lines.push(`── ${plugin.name}@${plugin.version}  [${plugin.form}${plugin.linked ? ', linked' : ''}]`
      + `  →  ${VERDICT_LABEL[plugin.verdict] ?? plugin.verdict}`)
    pushFindings(lines, plugin.blockers, 'blocker')
    pushFindings(lines, plugin.risks, 'risk')
    pushFindings(lines, plugin.unknowns, 'unknown')
    if (Array.isArray(plugin.signals) && plugin.signals.length > 0) {
      for (const signal of plugin.signals) {
        const times = signal.occurrences > 1 ? ` ×${signal.occurrences}` : ''
        lines.push(`   • [${signal.level}] ${signal.kind}${times}:${signal.detail}`)
      }
    }
    lines.push('')
  }

  if (Array.isArray(report.limits) && report.limits.length > 0) {
    lines.push('limits of this run:')
    for (const limit of report.limits) lines.push(`   - ${limit}`)
  }
  return lines.join('\n').trimEnd()
}

function pushFindings(lines, findings, label) {
  if (!Array.isArray(findings) || findings.length === 0) return
  for (const finding of findings.slice(0, MAX_FINDINGS_SHOWN)) lines.push(`   ${marker(label)} ${finding}`)
  if (findings.length > MAX_FINDINGS_SHOWN) {
    lines.push(`   ${marker(label)} …and ${findings.length - MAX_FINDINGS_SHOWN} more ${label}(s)`)
  }
}

function marker(label) {
  if (label === 'blocker') return '✗'
  if (label === 'risk') return '!'
  return '?'
}
