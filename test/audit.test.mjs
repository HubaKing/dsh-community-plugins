/**
 * Runs the audit against this machine's real installation and asserts the
 * invariants the tool promises. Machine-specific values (how many plugins are
 * installed, which packages the official set contains) are printed, never
 * asserted, so the suite stays useful on any box.
 *
 * Run: node test/audit.test.mjs
 */

import { join } from 'node:path'
import {
  audit,
  createServiceProbe,
  listInstalledPlugins,
  resolveEnvironment,
  resolveInstalledDirectory,
  scanPluginSource,
} from '../lib/audit.js'
import { buildPackageSurface, readExportNames, runtimeEntry } from '../lib/symbols.js'
import { existsSync, readFileSync } from 'node:fs'

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

const startedAt = Date.now()
const environment = resolveEnvironment()
const elapsed = Date.now() - startedAt

console.log('# environment')
console.log(`  dsh root        : ${environment.dshRoot ?? '(not found)'}`)
console.log(`  dsh version     : ${environment.dshVersion ?? '(unknown)'}`)
console.log(`  profile         : ${environment.profileName ?? '(none)'} -> ${environment.profileDir ?? '(none)'}`)
console.log(`  official pkgs   : ${environment.officialPackages.size}`)
console.log(`  official slots  : ${environment.officialSlots.size}`)
console.log(`  resolved in     : ${elapsed}ms`)
for (const note of environment.notes) console.log(`  note            : ${note}`)
console.log()

check('environment resolves a profile or explains why not',
  environment.profileDir !== undefined || environment.notes.length > 0)

if (environment.profileDir === undefined) {
  console.log('! no profile on this machine — skipping plugin-level assertions\n')
} else {
  const installed = listInstalledPlugins(environment.profileDir)
  console.log('# installed third-party plugins')
  if (installed.length === 0) console.log('  (none)')
  for (const plugin of installed) console.log(`  ${plugin.name}@${plugin.version}${plugin.linked ? ' [linked]' : ''}`)
  console.log()

  check('installed plugin list excludes official packages',
    installed.every(plugin => !plugin.name.startsWith('@deepseek-ai/')))

  const scanStartedAt = Date.now()
  const result = audit({ environment, runtime: { probe: createServiceProbe(undefined) } })
  console.log(`# audit (${Date.now() - scanStartedAt}ms)`)
  for (const plugin of result.plugins) {
    console.log(`  ${plugin.name}@${plugin.version} -> ${plugin.verdict} [${plugin.form}]`)
    for (const check_ of plugin.peers) {
      console.log(`      peer ${check_.package}@${check_.range}`
        + ` vs ${check_.actual ?? '?'} => ${check_.satisfied === null ? 'unknown' : check_.satisfied}`
        + `${check_.expanded === null ? '' : `  (${check_.expanded})`}`)
    }
    for (const blocker of plugin.blockers) console.log(`      blocker: ${blocker}`)
    for (const risk of plugin.risks) console.log(`      risk: ${risk}`)
    for (const unknown of plugin.unknowns) console.log(`      unknown: ${unknown}`)
    for (const symbol of plugin.symbols ?? []) {
      console.log(`      symbols ${symbol.package}${symbol.subpath === '' ? '' : `/${symbol.subpath}`}: `
        + `${symbol.confirmed.length}/${symbol.required.length} confirmed`
        + `${symbol.complete ? '' : ` (graph incomplete: ${symbol.unresolved.join('; ')})`}`)
    }
    if (plugin.signals.length > 0) {
      console.log(`      signals: ${plugin.signals.map(s => `${s.kind}${s.occurrences > 1 ? `×${s.occurrences}` : ''}`).join(', ')}`)
    }
  }
  console.log()

  const verdicts = new Set(['compatible', 'at-risk', 'incompatible', 'unknown'])
  check('every verdict is one of the documented values',
    result.plugins.every(plugin => verdicts.has(plugin.verdict)))
  check('a plugin with blockers is never reported compatible',
    result.plugins.every(plugin => plugin.blockers.length === 0 || plugin.verdict === 'incompatible'))
  check('a failing peer range is at-risk, never silently compatible',
    result.plugins.every(plugin => plugin.risks.length === 0 || plugin.verdict !== 'compatible'))
  check('nothing is reported clean while something is undecided',
    result.plugins.every(plugin => plugin.unknowns.length === 0 || plugin.verdict !== 'compatible'))
  check('audit returns one verdict per installed plugin',
    result.plugins.length === installed.length,
    `installed ${installed.length}, audited ${result.plugins.length}`)

  // The symbol check's contract, stated as invariants: every required name is
  // accounted for exactly once, and "missing" is only ever populated on a
  // surface that was read to completion.
  const symbolChecks = result.plugins.flatMap(plugin => plugin.symbols ?? [])
  check('every plugin carries a symbol-check array',
    result.plugins.every(plugin => Array.isArray(plugin.symbols)))
  check('every required name is classified exactly once',
    symbolChecks.every(check_ => check_.confirmed.length + check_.missing.length === check_.required.length
      && check_.required.every(name => check_.confirmed.includes(name) || check_.missing.includes(name))),
    JSON.stringify(symbolChecks.filter(check_ => check_.confirmed.length + check_.missing.length !== check_.required.length)))
  check('a missing export is only ever reported on a complete graph',
    symbolChecks.every(check_ => check_.missing.length === 0 || check_.complete))
  check('a symbol finding always shows up as a blocker on the plugin',
    result.plugins.every(plugin => (plugin.symbols ?? []).every(check_ => check_.missing.length === 0)
      || plugin.blockers.some(blocker => blocker.includes('does not export'))))
  check('the symbol check ran against this machine\'s plugins',
    installed.length === 0 || symbolChecks.length > 0 || result.plugins.every(plugin => plugin.officialImports.length === 0),
    `installed ${installed.length}, checks ${symbolChecks.length}`)

  // A plugin must never be judged against a package the host actually ships.
  // cordis and schemastery live in vendor/, and missing them was a real bug.
  const falseMissing = result.plugins.flatMap(plugin => plugin.missingPackages)
    .filter(name => ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'].includes(name))
  check('packages provided by vendor/ are not reported missing', falseMissing.length === 0,
    `false positives: ${falseMissing.join(', ')}`)

  // The finding this whole module exists for: an rc peer range with a different
  // tuple must be flagged, never silently passed.
  const localToken = result.plugins.find(plugin => plugin.name === 'dsh-llm-local-token')
  if (localToken !== undefined) {
    const rcPeer = localToken.peers.find(peer => peer.range.includes('rc.'))
    if (rcPeer?.actual !== null && rcPeer !== undefined) {
      check('rc peer range is judged against the installed version, not eyeballed',
        rcPeer.satisfied !== null,
        `${rcPeer.package}@${rcPeer.range} vs ${rcPeer.actual}`)
    }
  }
}

// Source scanning must stay bounded even on a large plugin tree.
const selfScanStartedAt = Date.now()
const selfScan = scanPluginSource('.')
const selfScanElapsed = Date.now() - selfScanStartedAt
console.log('# self-scan (this plugin)')
console.log(`  files scanned : ${selfScan.filesScanned}`)
console.log(`  official refs : ${selfScan.officialImports.length}`)
console.log(`  inject names  : ${selfScan.injectNames.join(', ') || '(none)'}`)
console.log(`  elapsed       : ${selfScanElapsed}ms`)
console.log()
check('self-scan completes under 3s', selfScanElapsed < 3000, `${selfScanElapsed}ms`)
check('self-scan does not read node_modules', !selfScan.officialImports.includes('@deepseek-ai/dsh-tools'))

// The scan is the slow part, so it is where a declared timeout has to bite.
const abortedScan = new AbortController()
abortedScan.abort()
let scanAbortError = null
try {
  scanPluginSource('.', { signal: abortedScan.signal })
} catch (error) {
  scanAbortError = error
}
check('scanPluginSource honours an aborted signal', scanAbortError !== null,
  'the scan ran to completion despite an already-aborted signal')
check('an abort is propagated as an AbortError',
  scanAbortError === null || scanAbortError.name === 'AbortError', scanAbortError?.name)

// An unaborted signal must not change the result.
const liveScan = scanPluginSource('.', { signal: new AbortController().signal })
check('a live signal leaves the scan result unchanged',
  liveScan.filesScanned === selfScan.filesScanned,
  `${liveScan.filesScanned} vs ${selfScan.filesScanned}`)

// A packed install has no source checkout, only the profile fallback. That set
// is smaller (it omits client-only packages), so absence must be reported as a
// risk rather than as a fact. Getting this wrong produced a confident
// "incompatible" verdict on plugins that work.
const packedEnv = resolveEnvironment({ dshRoot: join(process.cwd(), 'no-such-dsh-checkout') })
const packedResult = audit({ environment: packedEnv })
console.log('# packed-install simulation (no source checkout)')
console.log(`  sourceTreeAvailable : ${packedEnv.sourceTreeAvailable}`)
console.log(`  official packages   : ${packedEnv.officialPackages.size}`)
for (const plugin of packedResult.plugins) {
  console.log(`  ${plugin.name} -> ${plugin.verdict} (blockers ${plugin.blockers.length}, risks ${plugin.risks.length})`)
}
console.log()

check('a missing source checkout is detected', packedEnv.sourceTreeAvailable === false)
check('absence is never stated as fact without a source checkout',
  packedResult.plugins.every(plugin => !plugin.blockers.some(blocker => blocker.includes('absent from the package set'))),
  packedResult.plugins.flatMap(plugin => plugin.blockers).join('; '))
check('the fallback still resolves official package versions without a source checkout',
  packedEnv.officialPackages.size > 0 || environment.officialPackages.size === 0)

// ---------------------------------------------------------------------------
// Surface self-consistency: the check that proves the symbol analysis cannot
// produce a false "removed" on this machine.
//
// Every name an official package actually exports at runtime is read out of its
// runtime entry and required to appear in the surface the declaration walk
// built. If the resolver missed a re-export form, this is where it shows up —
// before a plugin ever gets blamed for importing a symbol that is still there.
// ---------------------------------------------------------------------------
const surfaceStartedAt = Date.now()
let packagesChecked = 0
let runtimeNamesChecked = 0
let incompleteSurfaces = 0
const unconfirmed = []
for (const [name] of environment.officialPackages) {
  const resolved = resolveInstalledDirectory(name, environment)
  if (resolved === null) continue
  const surface = buildPackageSurface(resolved.dir, resolved.manifest, '', {
    resolvePackage: dependency => resolveInstalledDirectory(dependency, environment),
  })
  packagesChecked += 1
  if (!surface.complete) incompleteSurfaces += 1
  const relative = runtimeEntry(resolved.manifest, '')
  if (relative === null) continue
  const file = join(resolved.dir, relative)
  if (!existsSync(file)) continue
  for (const exported of readExportNames(readFileSync(file, 'utf8'), { runtime: true }).names) {
    runtimeNamesChecked += 1
    if (!surface.symbols.has(exported)) unconfirmed.push(`${name}: ${exported}`)
  }
}
console.log('# official export surfaces')
console.log(`  packages inspected        : ${packagesChecked}`)
console.log(`  graphs resolved completely: ${packagesChecked - incompleteSurfaces}`
  + `${incompleteSurfaces === 0 ? '' : ` (${incompleteSurfaces} incomplete -> reported as unknown, never as removed)`}`)
console.log(`  runtime export names checked: ${runtimeNamesChecked}`)
console.log(`  not confirmed by the surface: ${unconfirmed.length}`)
console.log(`  elapsed                   : ${Date.now() - surfaceStartedAt}ms`)
console.log()
check('every runtime export of every official package is confirmed by the surface',
  unconfirmed.length === 0,
  unconfirmed.slice(0, 10).join(', '))
check('a name that is exported nowhere is never confirmed',
  environment.officialPackages.size === 0
  || !buildPackageSurface(
    resolveInstalledDirectory([...environment.officialPackages.keys()][0], environment).dir,
    resolveInstalledDirectory([...environment.officialPackages.keys()][0], environment).manifest,
    '',
    { resolvePackage: dependency => resolveInstalledDirectory(dependency, environment) },
  ).symbols.has('DefinitelyNotAnExportOfThisPackage'))
check('the surface walk is bounded', Date.now() - surfaceStartedAt < 60_000,
  `${Date.now() - surfaceStartedAt}ms`)

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
