/**
 * Deterministic verdict tests against synthetic dsh homes.
 *
 * The real-machine suite (`audit.test.mjs`) can only assert invariants, because
 * it does not control what is installed. These tests build the machine, so every
 * verdict — including the boot-failure ones — is asserted exactly. That matters
 * most in CI, which has no dsh checkout and previously exercised no part of the
 * verdict logic.
 *
 * Run: node test/fixtures.test.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFixture, patchBodyFor, SLOT_SOURCE } from './fixtures.mjs'
import { audit, lifecycleSignals, liveProfile, resolveEnvironment, selectProfile } from '../lib/audit.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}

const cleanups = []

/**
 * Audit a fixture and return the result.
 * @param {import('./fixtures.mjs').FixtureOptions} options
 */
function auditFixture(options) {
  const fixture = buildFixture(options)
  cleanups.push(fixture.cleanup)
  const environment = resolveEnvironment({ dshHome: fixture.dshHome, dshRoot: fixture.dshRoot, profileName: 'web' })
  return { environment, result: audit({ environment }) }
}

const PLUGIN = 'some-plugin'

/**
 * A plugin shaped like the real ones: a bundle manifest plus the patch it names.
 * @param {object} [overrides] - merged over the manifest.
 * @param {Record<string, string>} [files] - extra/replacement files.
 */
function bundlePlugin(overrides = {}, files = {}) {
  return {
    name: PLUGIN,
    manifest: {
      name: PLUGIN,
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      ...overrides,
    },
    files: { 'cordis.patch.yml': patchBodyFor(PLUGIN), ...files },
  }
}

// ---------------------------------------------------------------------------
// A healthy plugin produces no findings at all
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({ plugins: [bundlePlugin()], bundles: [PLUGIN] })
  const plugin = result.plugins[0]
  console.log('# healthy bundle plugin')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  bundle  : ${JSON.stringify(plugin.bundle)}`)
  console.log()
  check('a healthy bundle plugin is compatible', plugin.verdict === 'compatible', plugin.verdict)
  check('a healthy plugin reports no blockers', plugin.blockers.length === 0, plugin.blockers.join('; '))
  check('a healthy plugin reports no risks', plugin.risks.length === 0, plugin.risks.join('; '))
  check('an active layer is recorded as active', plugin.bundle.exists === true && plugin.bundle.active === true,
    JSON.stringify(plugin.bundle))
  check('a healthy profile reports no composition issues', result.profileIssues.length === 0,
    JSON.stringify(result.profileIssues))
}

// ---------------------------------------------------------------------------
// A declared patch that is not in the package: the launcher cannot boot
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, { 'cordis.patch.yml': undefined })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  console.log('# declared patch, file absent')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  blocker : ${plugin.blockers[0]}`)
  console.log()
  check('a missing patch file is incompatible', plugin.verdict === 'incompatible', plugin.verdict)
  check('the missing patch file is named in the blocker',
    plugin.blockers.some(blocker => blocker.includes('failed to read overlay')),
    plugin.blockers.join('; '))
  check('the absent patch is reflected in the bundle record', plugin.bundle.exists === false,
    JSON.stringify(plugin.bundle))
}

// ---------------------------------------------------------------------------
// `dsh.bundle` with no `patch`: a type violation the launcher throws on
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({ dsh: { bundle: {} } })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  console.log('# dsh.bundle without patch')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  blocker : ${plugin.blockers[0]}`)
  console.log()
  check('a dsh.bundle without a patch path is incompatible', plugin.verdict === 'incompatible', plugin.verdict)
  check('the blocker names the launcher error it will cause',
    plugin.blockers.some(blocker => blocker.includes('declares no dsh.bundle')),
    plugin.blockers.join('; '))
}

// ---------------------------------------------------------------------------
// A readable layer that is not composed into the profile
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({ plugins: [bundlePlugin()], bundles: [] })
  const plugin = result.plugins[0]
  console.log('# readable layer absent from dsh.profile.bundles')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  risk    : ${plugin.risks[0]}`)
  console.log()
  check('a readable but unlisted layer is at-risk, not incompatible', plugin.verdict === 'at-risk', plugin.verdict)
  check('a readable but unlisted layer is not a blocker', plugin.blockers.length === 0, plugin.blockers.join('; '))
  check('the risk explains the layer is never applied',
    plugin.risks.some(risk => risk.includes('never applied')), plugin.risks.join('; '))
  check('the layer record shows it is not composed in', plugin.bundle.active === false,
    JSON.stringify(plugin.bundle))
}

// ---------------------------------------------------------------------------
// A bundle entry with nothing installed behind it
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [],
    bundles: ['@deepseek-ai/dsh-base', 'ghost-bundle'],
    officialPackages: { '@deepseek-ai/dsh-base': '0.1.5-rc.1' },
  })
  console.log('# profile lists an unresolvable bundle')
  console.log(`  issues : ${JSON.stringify(result.profileIssues)}`)
  console.log()
  check('an official bundle is never reported as unresolvable',
    !result.profileIssues.some(issue => issue.detail.includes('dsh-base')),
    JSON.stringify(result.profileIssues))
  check('an unresolvable bundle entry is reported as a blocker',
    result.profileIssues.length === 1 && result.profileIssues[0].level === 'blocker',
    JSON.stringify(result.profileIssues))
  check('the unresolvable entry is named', result.profileIssues[0]?.detail.includes('ghost-bundle') === true)
}

// ---------------------------------------------------------------------------
// Peer ranges: the rc-prerelease rule is the reason this tool exists
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0-rc.6' } })],
    bundles: [PLUGIN],
    officialPackages: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' },
  })
  const plugin = result.plugins[0]
  console.log('# rc-prerelease peer range')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  risk    : ${plugin.risks[0]}`)
  console.log()
  check('a pinned rc range that the host moved past is at-risk', plugin.verdict === 'at-risk', plugin.verdict)
  check('the rc mismatch is explained with both versions',
    plugin.risks.some(risk => risk.includes('^0.1.0-rc.6') && risk.includes('0.1.5-rc.1')),
    plugin.risks.join('; '))
}

{
  // The runtime version has to admit the range too: `@deepseek-ai/dsh-llm` is in
  // the version gate's namespace, and the gate compares it against the running
  // dsh version rather than against the installed package. Keeping the two in
  // agreement here is what makes this test about the peer check.
  const { result } = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.5' } })],
    bundles: [PLUGIN],
    officialPackages: { '@deepseek-ai/dsh-llm': '0.1.5' },
    dshVersion: '0.1.5',
  })
  const plugin = result.plugins[0]
  check('a satisfied peer range is compatible', plugin.verdict === 'compatible', plugin.verdict)
  check('a satisfied peer range produces no risk', plugin.risks.length === 0, plugin.risks.join('; '))
  check('the gate agrees with a satisfied range', plugin.gate.applicable === true && plugin.gate.denied === false,
    JSON.stringify(plugin.gate))
}

// ---------------------------------------------------------------------------
// Absence is a fact only when the package set is complete
// ---------------------------------------------------------------------------
{
  const gone = bundlePlugin({}, {
    'index.js': "import { thing } from '@deepseek-ai/dsh-gone'\nexport default thing\n",
  })
  const withSource = auditFixture({
    plugins: [gone],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' },
  }).result.plugins[0]
  const packed = auditFixture({
    plugins: [gone],
    bundles: [PLUGIN],
    dshRoot: 'packed',
    officialPackages: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' },
  }).result.plugins[0]

  console.log('# imported official package absent from this build')
  console.log(`  with source tree : ${withSource.verdict} — ${withSource.blockers[0] ?? '(no blocker)'}`)
  console.log(`  packed install   : ${packed.verdict} — ${packed.risks[0] ?? '(no risk)'}`)
  console.log()
  check('a missing import is a blocker when a source tree proves the package set is complete',
    withSource.verdict === 'incompatible'
    && withSource.blockers.some(blocker => blocker.includes('renamed or removed')),
    `${withSource.verdict}: ${withSource.blockers.join('; ')}`)
  check('the same absence is only a risk without a source tree',
    packed.verdict === 'at-risk' && packed.blockers.length === 0,
    `${packed.verdict}: ${packed.blockers.join('; ')}`)
  check('the packed-install risk says why it cannot be a fact',
    packed.risks.some(risk => risk.includes('source checkout')), packed.risks.join('; '))
}

// ---------------------------------------------------------------------------
// Slot names are hard contracts
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, {
      'index.js': "slots.register({ name: 'settings.gone.item', component: () => null })\n",
    })],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' },
    sourceFiles: SLOT_SOURCE,
  })
  const plugin = result.plugins[0]
  console.log('# slot registered against a renamed upstream slot')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  blocker : ${plugin.blockers[0]}`)
  console.log()
  check('the official slot set was extracted from the fixture source',
    result.environment.officialSlots.has('settings.plugin.item'),
    [...result.environment.officialSlots].join(', '))
  check('a slot absent upstream is a blocker',
    plugin.verdict === 'incompatible' && plugin.blockers.some(blocker => blocker.includes('settings.gone.item')),
    plugin.blockers.join('; '))
}

{
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, {
      'index.js': "slots.register({ name: 'settings.plugin.item', component: () => null })\n",
    })],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: { '@deepseek-ai/dsh-llm': '0.1.5-rc.1' },
    sourceFiles: SLOT_SOURCE,
  })
  check('a slot that still exists upstream is not a finding',
    result.plugins[0].verdict === 'compatible',
    [...result.plugins[0].blockers, ...result.plugins[0].risks].join('; '))
}

{
  // The build emits `packages/client/*/lib/**` beside the `src/` it came from,
  // and the traversal walks a package directory in order — so generated files are
  // reached first and the shared file budget is spent before a contract is read.
  // Measured on a real dsh 0.2.0-rc.2 checkout: 76 slots pristine, 56 once built.
  // Shrinking the set that way is not a smaller answer, it is a wrong one: a slot
  // that is still defined upstream starts being reported as absent. Contracts are
  // authored in source, so the official scan must never read build output.
  const { environment } = auditFixture({
    dshRoot: 'source',
    sourceFiles: {
      ...SLOT_SOURCE,
      'packages/client/ui-slots/lib/slots.js':
        "export const slots = { 'generated.only.slot': { kind: 'list' } }\n",
    },
  })
  console.log('# official slot extraction reads source, not build output')
  console.log(`  slots : ${[...environment.officialSlots].join(', ')}`)
  console.log()
  check('a slot declared in source is extracted with build output beside it',
    environment.officialSlots.has('settings.plugin.item'),
    [...environment.officialSlots].join(', '))
  check('a slot that exists only in build output is never extracted',
    !environment.officialSlots.has('generated.only.slot'),
    [...environment.officialSlots].join(', '))
}

// ---------------------------------------------------------------------------
// Install-time risk signals survive the fixture path too
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({ scripts: { postinstall: 'node ./setup.mjs', prepare: 'npm run build' } })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  console.log('# lifecycle script')
  console.log(`  signals : ${plugin.signals.map(signal => `${signal.kind}(${signal.level})`).join(', ')}`)
  console.log()
  check('a registry install-time lifecycle script is surfaced at high severity',
    plugin.signals.some(signal => signal.kind === 'lifecycle:postinstall' && signal.level === 'high'),
    JSON.stringify(plugin.signals))
  // npm and pnpm run `prepare` for a git or local install, never for a registry
  // tarball, so reporting it at install-time severity would be a false positive
  // on every registry install.
  check('prepare is reported as source-install-only, not as an install-time hook',
    plugin.signals.some(signal => signal.kind === 'lifecycle:prepare' && signal.level === 'info'),
    JSON.stringify(plugin.signals))
  check('prepublishOnly is in the same source-install-only class',
    lifecycleSignals({ scripts: { prepublishOnly: 'npm run build' } })
      .every(signal => signal.level === 'info'),
    JSON.stringify(lifecycleSignals({ scripts: { prepublishOnly: 'npm run build' } })))
}

// ---------------------------------------------------------------------------
// Activation: a bundle written after the process started is not composed
// ---------------------------------------------------------------------------
{
  const fixture = buildFixture({ plugins: [bundlePlugin()], bundles: [PLUGIN] })
  cleanups.push(fixture.cleanup)
  const base = { dshHome: fixture.dshHome, dshRoot: fixture.dshRoot, profileName: 'web' }

  // The fixture was written moments ago, so a process that started an hour
  // earlier cannot have composed this row.
  const older = audit({ environment: resolveEnvironment({ ...base, hostStartedAt: Date.now() - 3_600_000 }) })
  console.log('# activation: process predates the install')
  console.log(`  flag    : ${older.plugins[0].installedAfterHostStart}`)
  console.log(`  notices : ${older.notices.length}`)
  console.log()
  check('a plugin installed after the process started is flagged',
    older.plugins[0].installedAfterHostStart === true, String(older.plugins[0].installedAfterHostStart))
  check('a reconfiguration after the process started raises a notice',
    older.notices.length > 0, JSON.stringify(older.notices))
  check('the activation flag does not change the compatibility verdict',
    older.plugins[0].verdict === 'compatible', older.plugins[0].verdict)

  const newer = audit({ environment: resolveEnvironment({ ...base, hostStartedAt: Date.now() + 3_600_000 }) })
  check('a plugin older than the process start is not flagged',
    newer.plugins[0].installedAfterHostStart === false, String(newer.plugins[0].installedAfterHostStart))
  check('no notice is raised when the process postdates the configuration',
    newer.notices.length === 0, JSON.stringify(newer.notices))

  const undecided = audit({ environment: resolveEnvironment(base) })
  check('without a process start instant the activation check stays undecided',
    undecided.plugins[0].installedAfterHostStart === null, String(undecided.plugins[0].installedAfterHostStart))
  check('without a process start instant no notice is raised',
    undecided.notices.length === 0, JSON.stringify(undecided.notices))
}

// ---------------------------------------------------------------------------
// `dsh.client.inject` is documented as informational and must not be reported
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-not-installed'] },
      },
    })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  check('an informational client inject is never reported as a missing package',
    ![...plugin.blockers, ...plugin.risks].some(finding => finding.includes('dsh-client-not-installed')),
    [...plugin.blockers, ...plugin.risks].join('; '))
  check('a plugin with an informational client inject stays compatible',
    plugin.verdict === 'compatible', plugin.verdict)
}

// ---------------------------------------------------------------------------
// Symbol-level checks: a package can still exist while the binding is gone
// ---------------------------------------------------------------------------
{
  const declaration = {
    '@deepseek-ai/dsh-llm': {
      version: '0.1.5-rc.1',
      files: {
        'index.js': "export { LlmError } from './error.js'\n",
        'index.d.ts': "export * from './error.ts'\n",
        'error.d.ts': 'export declare class LlmError extends Error {}\n',
      },
    },
  }
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, {
      'index.js': "import { LlmError, GoneSymbol } from '@deepseek-ai/dsh-llm'\nexport { LlmError, GoneSymbol }\n",
    })],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: declaration,
  })
  const plugin = result.plugins[0]
  console.log('# named export removed upstream')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  blocker : ${plugin.blockers[0]}`)
  console.log()
  check('a named import that is no longer exported is a blocker',
    plugin.verdict === 'incompatible' && plugin.blockers.some(blocker => blocker.includes('GoneSymbol')),
    `${plugin.verdict}: ${plugin.blockers.join('; ')}`)
  check('a named import that still exists is confirmed, not reported',
    plugin.symbols[0].confirmed.includes('LlmError')
    && !plugin.blockers.some(blocker => blocker.includes('"LlmError"')),
    JSON.stringify(plugin.symbols[0]))
  check('the symbol check records the surface it read',
    plugin.symbols[0].surfaceSize === 1 && plugin.symbols[0].complete === true,
    JSON.stringify(plugin.symbols[0]))
}

{
  // The same import, against a package whose declaration graph cannot be read
  // to completion. "Could not resolve" must not become "removed".
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, {
      'index.js': "import { MaybeThere } from '@deepseek-ai/dsh-broken'\nexport { MaybeThere }\n",
    })],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: {
      '@deepseek-ai/dsh-broken': {
        version: '0.1.0',
        files: { 'index.d.ts': "export * from './absent.ts'\n" },
      },
    },
  })
  const plugin = result.plugins[0]
  console.log('# unreadable declaration graph')
  console.log(`  verdict : ${plugin.verdict}`)
  console.log(`  unknown : ${plugin.unknowns.find(entry => entry.includes('MaybeThere'))}`)
  console.log()
  check('an unresolved graph yields unknown, never a blocker',
    plugin.blockers.length === 0 && plugin.verdict === 'unknown',
    `${plugin.verdict}: ${plugin.blockers.join('; ')}`)
  check('the unknown says the graph is what stopped the check',
    plugin.unknowns.some(entry => entry.includes('MaybeThere') && entry.includes('incomplete')),
    JSON.stringify(plugin.unknowns))
  check('the incomplete surface is recorded as such',
    plugin.symbols[0].complete === false && plugin.symbols[0].missing.length === 0,
    JSON.stringify(plugin.symbols[0]))
}

{
  const { result } = auditFixture({
    plugins: [bundlePlugin({}, {
      'index.js': "import { LlmError } from '@deepseek-ai/dsh-llm'\nexport { LlmError }\n",
    })],
    bundles: [PLUGIN],
    dshRoot: 'source',
    sourcePackages: {
      '@deepseek-ai/dsh-llm': {
        version: '0.1.5-rc.1',
        files: {
          'index.js': "export { LlmError } from './error.js'\n",
          'index.d.ts': "export * from './error.ts'\n",
          'error.d.ts': 'export declare class LlmError extends Error {}\n',
        },
      },
    },
  })
  check('a plugin whose imports all resolve stays compatible',
    result.plugins[0].verdict === 'compatible',
    [...result.plugins[0].blockers, ...result.plugins[0].risks, ...result.plugins[0].unknowns].join('; '))
}

// ---------------------------------------------------------------------------
// A plugin with no dsh block is untouched by the layer checks
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [{ name: PLUGIN, manifest: { name: PLUGIN, version: '1.0.0' }, files: {} }],
    bundles: [],
  })
  const plugin = result.plugins[0]
  check('a plugin without dsh.bundle records no layer',
    plugin.bundle.declared === null && plugin.bundle.exists === null && plugin.bundle.active === null,
    JSON.stringify(plugin.bundle))
  check('a plugin without dsh.bundle is not blamed for a missing layer',
    plugin.blockers.length === 0 && plugin.risks.length === 0,
    [...plugin.blockers, ...plugin.risks].join('; '))
}

// ---------------------------------------------------------------------------
// The profile manifest is re-read on every call
//
// `dsh plugin add` and `remove` rewrite it while dsh is running. A process-level
// cache made the audit report a package that had just been added as "not in
// dsh.profile.bundles" — the exact check the documented workflow depends on —
// and a package that had just been removed as still listed.
// ---------------------------------------------------------------------------
{
  const fixture = buildFixture({ plugins: [bundlePlugin()], bundles: [] })
  cleanups.push(fixture.cleanup)
  const options = { dshHome: fixture.dshHome, dshRoot: fixture.dshRoot, profileName: 'web' }
  const first = audit({ environment: resolveEnvironment(options) })
  const beforeChange = first.plugins[0].bundle.active

  // Same cache key, rewritten manifest: this is what `dsh plugin add` does.
  writeFileSync(join(fixture.profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { [PLUGIN]: '1.0.0' },
    dsh: { profile: { bundles: [PLUGIN], patchReload: 'live' } },
  }, null, 2)}\n`)
  const second = audit({ environment: resolveEnvironment(options) })

  console.log('# profile manifest re-read between calls')
  console.log(`  layer active before : ${beforeChange}`)
  console.log(`  layer active after  : ${second.plugins[0].bundle.active}`)
  console.log()
  check('a layer missing from dsh.profile.bundles is reported inactive', beforeChange === false)
  check('rewriting dsh.profile.bundles is picked up without a restart',
    second.plugins[0].bundle.active === true, JSON.stringify(second.plugins[0].bundle))
  check('the re-read profile reports no composition issues', second.profileIssues.length === 0,
    JSON.stringify(second.profileIssues))
}

// ---------------------------------------------------------------------------
// A targeted audit still judges the whole profile's composition
//
// Passing only the target into the integrity check made every other bundle entry
// look uninstalled, and each one produced a "the profile does not boot" blocker.
// ---------------------------------------------------------------------------
{
  const other = 'another-plugin'
  const second = { ...bundlePlugin(), name: other, manifest: {
    name: other, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  } }
  const fixture = buildFixture({ plugins: [bundlePlugin(), second], bundles: [PLUGIN, other] })
  cleanups.push(fixture.cleanup)
  const environment = resolveEnvironment({
    dshHome: fixture.dshHome, dshRoot: fixture.dshRoot, profileName: 'web',
  })
  const targeted = audit({ environment, target: PLUGIN })
  const full = audit({ environment })
  console.log('# targeted audit of a multi-bundle profile')
  console.log(`  target plugins      : ${targeted.plugins.length}`)
  console.log(`  profile issues      : ${JSON.stringify(targeted.profileIssues)}`)
  console.log()
  check('a targeted audit judges exactly one plugin', targeted.plugins.length === 1)
  check('a targeted audit does not blame the other bundles',
    targeted.profileIssues.length === 0, JSON.stringify(targeted.profileIssues))
  check('the full audit of the same profile is also clean', full.profileIssues.length === 0,
    JSON.stringify(full.profileIssues))
}

// ---------------------------------------------------------------------------
// dsh's own version gate
//
// Reproduces `evaluatePluginCompatibility`: only @deepseek-ai/dsh* peers count,
// they are compared against the running dsh version with includePrerelease, and
// the row is disabled unless compatibility.json grants that exact pair.
// ---------------------------------------------------------------------------
{
  const DSH = '0.2.0-rc.2'
  const gated = {
    name: PLUGIN,
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-client-ui-theme': '^0.1.0-rc.6' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const { result } = auditFixture({
    plugins: [bundlePlugin(gated)], bundles: [PLUGIN], dshVersion: DSH,
  })
  const plugin = result.plugins[0]
  console.log('# version gate: a @deepseek-ai/dsh* range that does not admit this dsh')
  console.log(`  gate    : ${JSON.stringify(plugin.gate)}`)
  console.log(`  risk    : ${plugin.risks.find(risk => risk.includes('version gate'))}`)
  console.log()
  check('the gate is evaluated for a @deepseek-ai/dsh* peer', plugin.gate.applicable === true,
    JSON.stringify(plugin.gate))
  check('a range that does not admit this dsh is a gate denial',
    plugin.gate.denied === true && plugin.gate.peers.length === 1, JSON.stringify(plugin.gate))
  check('a denied gate is reported as a risk naming the exemption command',
    plugin.risks.some(risk => risk.includes('version gate') && risk.includes('allow-version')),
    plugin.risks.join('; '))
  check('the gate denial does not claim the profile fails to boot',
    plugin.blockers.every(blocker => !blocker.includes('version gate')), plugin.blockers.join('; '))

  // The same plugin, granted: the gate admits it and the finding disappears.
  const exemptFixture = auditFixture({
    plugins: [bundlePlugin(gated)],
    bundles: [PLUGIN],
    dshVersion: DSH,
    compatibility: { [`${PLUGIN}@1.0.0`]: [DSH] },
  })
  const exemptPlugin = exemptFixture.result.plugins[0]
  check('an exact-version exemption in compatibility.json clears the denial',
    exemptPlugin.gate.denied === false && exemptPlugin.gate.exempted === true,
    JSON.stringify(exemptPlugin.gate))
  check('an exempted plugin carries no gate risk',
    exemptPlugin.risks.every(risk => !risk.includes('version gate')), exemptPlugin.risks.join('; '))

  // A peer that is not in dsh's namespace can never be refused by the gate. This
  // is why a plugin whose only peer is cordis installs on any newer build.
  const cordisOnly = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/cordis': '^0.1.0-rc.5' } })],
    bundles: [PLUGIN],
    dshVersion: DSH,
  })
  check('a non-dsh peer is outside the gate entirely',
    cordisOnly.result.plugins[0].gate.applicable === false,
    JSON.stringify(cordisOnly.result.plugins[0].gate))

  // includePrerelease: the gate admits a prerelease that the peer check refuses.
  const openRange = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.1.0' } })],
    bundles: [PLUGIN],
    dshVersion: DSH,
  })
  const openPlugin = openRange.result.plugins[0]
  check('the gate runs in includePrerelease mode',
    openPlugin.gate.applicable === true && openPlugin.gate.peers.length === 0,
    JSON.stringify(openPlugin.gate))
}

// ---------------------------------------------------------------------------
// The peer rollup makes silence unambiguous
// ---------------------------------------------------------------------------
{
  const noPeers = auditFixture({ plugins: [bundlePlugin()], bundles: [PLUGIN] })
  const withPeers = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', react: '^18.2.0' } })],
    bundles: [PLUGIN],
  })
  const empty = noPeers.result.plugins[0].peerSummary
  const full = withPeers.result.plugins[0].peerSummary
  console.log('# peer rollup')
  console.log(`  no peers   : ${JSON.stringify(empty)}`)
  console.log(`  two peers  : ${JSON.stringify(full)}`)
  console.log()
  check('a plugin with no peers reports zero declared', empty.declared === 0, JSON.stringify(empty))
  check('declared peers are counted even when nothing fails',
    full.declared === 2, JSON.stringify(full))
  check('unsatisfiable peers are counted, never dropped',
    full.satisfied + full.unsatisfied + full.undecidable === full.declared, JSON.stringify(full))
}

// ---------------------------------------------------------------------------
// Client-side injects: declared by the browser half, unresolvable from the host
// ---------------------------------------------------------------------------
{
  const clientPlugin = {
    name: PLUGIN,
    version: '1.0.0',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-theme'] },
    },
  }
  const { result } = auditFixture({
    plugins: [bundlePlugin(clientPlugin, {
      // Both spellings the scanner recognises, in the paths a real plugin uses:
      // the source `export const inject` and the built `exports.inject`.
      'src/client/index.ts': "export const inject = ['slots', 'theme']\n",
      'client/client.js': "const inject = ['slots', 'theme']\nexports.inject = inject\n",
      'lib/index.js': "export const inject = ['webServer']\n",
    })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  console.log('# client-side injects')
  console.log(`  client services : ${plugin.clientServices.join(', ')}`)
  console.log(`  unknowns        : ${plugin.unknowns.join(' | ') || '(none)'}`)
  console.log()
  check('a token declared only by the browser half is classified as client-side',
    plugin.clientServices.includes('slots') && plugin.clientServices.includes('theme'),
    plugin.clientServices.join(', '))
  check('a client-side token is never reported as missing from the host context',
    plugin.unknowns.every(unknown => !unknown.includes('"slots"') && !unknown.includes('"theme"')),
    plugin.unknowns.join('; '))
  check('a host-declared token is still probed', !plugin.clientServices.includes('webServer'),
    plugin.clientServices.join(', '))
}

// ---------------------------------------------------------------------------
// The default profile follows the running process, not a name heuristic
//
// "web when it exists" sent a whole session of audits at a profile the running
// app does not compose: a theme installed into `web` was reported as installed
// while the desktop app showed no change. `profileContext` is the launcher's own
// fact about which profile is live, and it is what the default now follows.
// ---------------------------------------------------------------------------
{
  const fixture = buildFixture({ plugins: [bundlePlugin()], bundles: [PLUGIN] })
  cleanups.push(fixture.cleanup)
  // A second profile, as a desktop install has: the fixture only writes `web`.
  const desktopDir = join(fixture.dshHome, 'profiles', 'desktop')
  mkdirSync(desktopDir, { recursive: true })
  writeFileSync(join(desktopDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`)

  const base = { dshHome: fixture.dshHome, dshRoot: fixture.dshRoot }
  const byNameHeuristic = resolveEnvironment(base)
  const liveCtx = { get: name => (name === 'profileContext' ? { name: 'desktop', dir: desktopDir } : undefined) }
  const live = liveProfile(liveCtx)
  const selection = selectProfile(liveCtx, undefined)
  const byLiveProfile = resolveEnvironment({
    ...base,
    profileName: selection.profileName,
    profileDir: selection.profileDir,
  })
  const mismatched = selectProfile(liveCtx, 'web')

  console.log('# profile selection')
  console.log(`  name heuristic         : ${byNameHeuristic.profileName} (${byNameHeuristic.profileDir})`)
  console.log(`  live profileContext    : ${live.name} -> ${live.dir}`)
  console.log(`  resolved by live       : ${byLiveProfile.profileName} (${byLiveProfile.profileDir})`)
  console.log(`  explicit mismatch note : ${mismatched.notes[0] ?? '(none)'}`)
  console.log()

  check('without a live context the old heuristic still picks web',
    byNameHeuristic.profileName === 'web', String(byNameHeuristic.profileName))
  check('the live profile name and directory are read from profileContext',
    live.name === 'desktop' && live.dir === desktopDir, JSON.stringify(live))
  check('the default follows the live profile instead of the heuristic',
    byLiveProfile.profileName === 'desktop', String(byLiveProfile.profileName))
  check('an explicit profile directory is honoured verbatim',
    byLiveProfile.profileDir === desktopDir, String(byLiveProfile.profileDir))
  check('an explicit request that differs from the live profile says so',
    mismatched.notes.length === 1
      && mismatched.notes[0].includes('"web"') && mismatched.notes[0].includes('"desktop"'),
    JSON.stringify(mismatched.notes))
  check('an explicit request equal to the live profile carries no note',
    selectProfile(liveCtx, 'desktop').notes.length === 0,
    JSON.stringify(selectProfile(liveCtx, 'desktop').notes))

  // A context that cannot answer must not decide anything.
  check('a context without profileContext yields no live profile',
    liveProfile({ get: () => undefined }).name === undefined)
  check('a throwing ctx.get is swallowed rather than propagated',
    liveProfile({ get: () => { throw new Error('no such service') } }).name === undefined)
  check('no ctx at all is handled', liveProfile(undefined).name === undefined)
}

for (const cleanup of cleanups) cleanup()

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
