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

import { buildFixture, patchBodyFor, SLOT_SOURCE } from './fixtures.mjs'
import { audit, resolveEnvironment } from '../lib/audit.js'

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
  const { result } = auditFixture({
    plugins: [bundlePlugin({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.5' } })],
    bundles: [PLUGIN],
    officialPackages: { '@deepseek-ai/dsh-llm': '0.1.5' },
  })
  const plugin = result.plugins[0]
  check('a satisfied peer range is compatible', plugin.verdict === 'compatible', plugin.verdict)
  check('a satisfied peer range produces no risk', plugin.risks.length === 0, plugin.risks.join('; '))
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

// ---------------------------------------------------------------------------
// Install-time risk signals survive the fixture path too
// ---------------------------------------------------------------------------
{
  const { result } = auditFixture({
    plugins: [bundlePlugin({ scripts: { postinstall: 'node ./setup.mjs' } })],
    bundles: [PLUGIN],
  })
  const plugin = result.plugins[0]
  console.log('# lifecycle script')
  console.log(`  signals : ${plugin.signals.map(signal => `${signal.kind}(${signal.level})`).join(', ')}`)
  console.log()
  check('an install-time lifecycle script is surfaced at high severity',
    plugin.signals.some(signal => signal.kind === 'lifecycle:postinstall' && signal.level === 'high'),
    JSON.stringify(plugin.signals))
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

for (const cleanup of cleanups) cleanup()

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
