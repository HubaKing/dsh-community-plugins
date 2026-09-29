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

import { audit, createServiceProbe, resolveEnvironment, selectProfile } from './audit.js'

export const AUDIT_TOOL_NAME = 'dsh_plugin_audit'

/** How many findings of one kind to spell out before summarizing the rest. */
const MAX_FINDINGS_SHOWN = 3

/**
 * Build the audit tool bound to this plugin's Cordis context.
 *
 * `ctx` is used for two things: the runtime service probe (the live context is
 * the one source of truth for whether an `inject` name still resolves) and the
 * identity of the profile this process is running, so the default target is the
 * profile that is actually composed rather than a guess. Both are read through
 * `ctx.get` and degrade silently, so no service becomes a hard dependency.
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
      + 'fails to match a differently-pinned prerelease), and separately whether dsh\'s own version gate will load the '
      + 'plugin at all: that gate judges only @deepseek-ai/dsh* peers, compares them against the running dsh version '
      + 'with includePrerelease semantics, disables just that one row when they conflict, and admits it again only if '
      + 'the profile\'s compatibility.json grants an exact-version exemption for this package version on this dsh '
      + 'version. It then checks whether the @deepseek-ai packages its source imports still '
      + 'exist in this build, whether the specific named exports those imports require are still exported (the '
      + 'declaration graphs of the official packages are walked through `export *` re-exports, and a name is only '
      + 'called removed when that walk resolved completely), whether the client slots it registers are still defined '
      + 'upstream, whether the services it injects resolve on the live context, and install-time risk signals such '
      + 'as npm lifecycle scripts, dynamic code, and shell execution. Lifecycle hooks are graded by install source: '
      + 'preinstall/install/postinstall run for a registry install, while prepare/prepublishOnly run only for a git '
      + 'or local install. It also compares the profile configuration and each installed package against the start '
      + 'instant of the calling process, so it reports when a plugin is installed but not loaded because the process '
      + 'predates it — bundle layers are composed only at startup. '
      + 'Use it after upgrading dsh to see which installed plugins no longer fit, when a profile will not boot, or '
      + 'to check a plugin that is already installed. To check a plugin BEFORE installing it, use '
      + 'dsh_plugin_inspect instead — that one downloads the published tarball and is the only tool here that '
      + 'touches the network. '
      + 'This tool reports the state of this machine as it is now: it cannot see a dsh version that is not '
      + 'installed yet, so it does not predict a future upgrade. '
      + 'Verdicts: "incompatible" means the plugin cannot work here — a package or export or slot it needs is gone '
      + 'from this build, or its bundle layer cannot be mounted; "at-risk" means a declared range no longer matches, '
      + 'its layer is not composed in, or dsh\'s version gate will refuse to load the row unless it is exempted, '
      + 'though in the gate\'s case the profile itself still boots; "unknown" means a check this tool cannot '
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
          description: 'Profile name under the dsh home directory (e.g. "web", "desktop"). Defaults to the profile '
            + 'this dsh process is actually running; only pass it to read a different profile on disk.',
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
      const selection = selectProfile(ctx, args.profile)
      const environment = resolveEnvironment({
        profileName: selection.profileName,
        profileDir: selection.profileDir,
        // The audit runs inside the process whose graph it is describing, so the
        // process's own start instant is the exact boundary after which a bundle
        // change cannot have been composed. Derived from `uptime()` rather than a
        // timestamp helper so it needs no import and cannot drift.
        hostStartedAt: Date.now() - Math.round(process.uptime() * 1000),
      })
      if (selection.notes.length > 0) environment.notes.push(...selection.notes)
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
    notices: Array.isArray(result.notices) ? result.notices : [],
    limits: environment.notes,
  }
}

export const VERDICT_LABEL = {
  compatible: 'COMPATIBLE',
  'at-risk': 'AT-RISK',
  incompatible: 'INCOMPATIBLE',
  unknown: 'UNKNOWN',
}

/**
 * The peer rollup line: how many ranges were declared, how many were judged, and
 * against what. Without this, "no peer findings" and "no peers declared" render
 * identically, and the first is the strongest evidence the tool can give.
 * @param {*} plugin
 * @param {string} runtimeVersion
 */
export function renderPeerSummary(plugin, runtimeVersion) {
  const summary = plugin?.peerSummary
  if (summary === undefined || summary === null) return null
  if (summary.declared === 0) {
    return 'peers: none declared — this plugin declares no peerDependencies at all, so no range can be out of date'
  }
  const parts = [`${summary.declared} declared`]
  if (summary.official > 0) parts.push(`${summary.official} in @deepseek-ai/dsh* (the version gate's scope)`)
  parts.push(`${summary.satisfied} satisfied`, `${summary.unsatisfied} unsatisfied`, `${summary.undecidable} undecidable`)
  return `peers: ${parts.join(' · ')} (against the versions installed here, i.e. ${runtimeVersion})`
}

/**
 * The version-gate line: whether dsh itself will load this row.
 *
 * This is the answer the peer rollup cannot give. A failing range is not the same
 * as a refused plugin, and a refused plugin is not the same as a profile that
 * will not boot — the gate disables one row and the profile starts.
 * @param {*} plugin
 * @param {boolean} prospective - true when the package is not installed yet.
 */
export function renderGate(plugin, prospective) {
  const gate = plugin?.gate
  if (gate === undefined || gate === null) return null
  if (!gate.applicable) {
    // A package that declares no peers at all is already covered by the peer
    // rollup, and most of what a profile's node_modules holds is a transitive
    // dependency rather than an installed plugin: repeating "the gate cannot
    // refuse this" for each one buries the two lines that do carry information.
    if ((plugin?.peerSummary?.declared ?? 0) === 0) return null
    return 'gate: no @deepseek-ai/dsh* peer ranges declared — dsh\'s version gate cannot refuse this package'
  }
  if (gate.undecidable) {
    return 'gate: not decidable here — the dsh runtime version could not be read, and that is what the gate compares against'
  }
  if (gate.peers.length === 0) {
    return `gate: every declared @deepseek-ai/dsh* range admits dsh ${gate.runtimeVersion}`
      + (prospective ? ' — `dsh plugin add` will accept it' : ' — this row loads')
  }
  const named = gate.peers.slice(0, 2).map(peer => `${peer.package}@${peer.range}`).join(', ')
  const more = gate.peers.length > 2 ? `, +${gate.peers.length - 2} more` : ''
  if (gate.exempted) {
    return `gate: exempted for dsh ${gate.runtimeVersion} in compatibility.json — the row loads despite `
      + `${named}${more} not admitting it`
  }
  return prospective
    ? `gate: DENIED — dsh will refuse this install (${named}${more} do not admit dsh ${gate.runtimeVersion}) `
      + 'unless an exact-version exemption is granted first'
    : `gate: DENIED at startup — ${named}${more} do not admit dsh ${gate.runtimeVersion}, so the preflight `
      + 'disables this row and the plugin never loads (the profile itself still boots)'
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

  // Activation comes before the per-plugin verdicts: when the profile was
  // reconfigured after this process started, the whole report describes a graph
  // that the running application is not using.
  if (Array.isArray(report.notices) && report.notices.length > 0) {
    lines.push('')
    for (const notice of report.notices) lines.push(`   ! ${notice}`)
  }

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
    if (plugin.installedAfterHostStart === true) {
      lines.push('   activation: this package was written after this process started. Its bundle layer is composed '
        + 'only at startup, so the row is not loaded here — restart dsh to activate it before judging it.')
    }
    pushFindings(lines, plugin.blockers, 'blocker')
    pushFindings(lines, plugin.risks, 'risk')
    pushFindings(lines, plugin.unknowns, 'unknown')
    const peers = renderPeerSummary(plugin, environment.dshVersion ?? 'the build installed here')
    if (peers !== null) lines.push(`   ${peers}`)
    const gate = renderGate(plugin, false)
    if (gate !== null) lines.push(`   ${gate}`)
    if (Array.isArray(plugin.clientServices) && plugin.clientServices.length > 0) {
      lines.push(`   client-side injects (declared by the browser half; the host context cannot resolve them): `
        + plugin.clientServices.join(', '))
    }
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
