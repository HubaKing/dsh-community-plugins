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
      + 'whether its bundle layer is mountable at all (a declared dsh.bundle.patch that is missing, or a dsh.bundle '
      + 'with no patch path, makes the launcher throw and the profile fail to boot; a readable layer that is absent '
      + 'from dsh.profile.bundles is never applied), its declared peerDependencies ranges compared against the '
      + 'versions actually installed (applying the rc-prerelease semver rule, so a pinned `^0.1.0-rc.5` correctly '
      + 'fails to match a differently-pinned prerelease), whether the @deepseek-ai packages its source imports still '
      + 'exist in this build, whether the specific named exports those imports require are still exported (the '
      + 'declaration graphs of the official packages are walked through `export *` re-exports, and a name is only '
      + 'called removed when that walk resolved completely), whether the client slots it registers are still defined '
      + 'upstream, whether the services it injects resolve on the live context, and install-time risk signals such '
      + 'as npm lifecycle scripts, dynamic code, and shell execution. '
      + 'Use it after upgrading dsh to see which installed plugins no longer fit, when a profile will not boot, or '
      + 'to check a plugin that is already installed. To check a plugin BEFORE installing it, use '
      + 'dsh_plugin_inspect instead — that one downloads the published tarball and is the only tool here that '
      + 'touches the network. '
      + 'This tool reports the state of this machine as it is now: it cannot see a dsh version that is not '
      + 'installed yet, so it does not predict a future upgrade. '
      + 'Verdicts: "incompatible" means the plugin cannot work here — a package or export or slot it needs is gone '
      + 'from this build, or its bundle layer cannot be mounted; "at-risk" means a declared range no longer matches '
      + 'or its layer is not composed in, though the code may still run; "unknown" means a check this tool cannot '
      + 'perform offline. Nothing is fetched from the network and no dataset is consulted, so the result always '
      + 'describes this machine right now.',
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
 * @param {{ environment: import('./audit.js').Environment, plugins: import('./audit.js').PluginVerdict[], resolvedTarget: string | null, profileIssues: import('./audit.js').ProfileIssue[] }} result
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
    profileIssues: result.profileIssues,
    limits: environment.notes,
  }
}

export const VERDICT_LABEL = {
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
    const bundle = plugin.bundle
    if (bundle?.declared != null || bundle?.exists === false) {
      lines.push(`   layer ${bundle.declared ?? '(none)'} — ${bundle.exists ? 'readable' : 'MISSING'}`
        + `${bundle.active === null ? '' : bundle.active ? ', in dsh.profile.bundles' : ', NOT in dsh.profile.bundles'}`)
    }
    pushFindings(lines, plugin.blockers, 'blocker')
    pushFindings(lines, plugin.risks, 'risk')
    pushFindings(lines, plugin.unknowns, 'unknown')
    if (Array.isArray(plugin.symbols) && plugin.symbols.length > 0) {
      const summary = plugin.symbols
        .map(check => `${check.subpath === '' ? check.package : `${check.package}/${check.subpath}`}`
          + ` ${check.confirmed.length}/${check.required.length} named export(s) confirmed`
          + `${check.complete ? '' : ' (graph incomplete — unresolved names are reported as unknown)'}`)
        .join(', ')
      lines.push(`   imported official names: ${summary}`)
    }
    if (Array.isArray(plugin.signals) && plugin.signals.length > 0) {
      for (const signal of plugin.signals) {
        const times = signal.occurrences > 1 ? ` ×${signal.occurrences}` : ''
        lines.push(`   • [${signal.level}] ${signal.kind}${times}:${signal.detail}`)
      }
    }
    lines.push('')
  }

  const profileIssues = Array.isArray(report.profileIssues) ? report.profileIssues : []
  if (profileIssues.length > 0) {
    lines.push('profile composition:')
    for (const issue of profileIssues) lines.push(`   ${marker(issue.level === 'blocker' ? 'blocker' : 'risk')} ${issue.detail}`)
    lines.push('')
  }

  if (Array.isArray(report.limits) && report.limits.length > 0) {
    lines.push('limits of this run:')
    for (const limit of report.limits) lines.push(`   - ${limit}`)
  }
  return lines.join('\n').trimEnd()
}

export function pushFindings(lines, findings, label) {
  if (!Array.isArray(findings) || findings.length === 0) return
  for (const finding of findings.slice(0, MAX_FINDINGS_SHOWN)) lines.push(`   ${marker(label)} ${finding}`)
  if (findings.length > MAX_FINDINGS_SHOWN) {
    lines.push(`   ${marker(label)} …and ${findings.length - MAX_FINDINGS_SHOWN} more ${label}(s)`)
  }
}

export function marker(label) {
  if (label === 'blocker') return '✗'
  if (label === 'risk') return '!'
  return '?'
}
