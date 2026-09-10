/**
 * Pre-install audit tests, against a local registry instead of npm.
 *
 * The networked tool is the one that handles bytes nobody in this repository
 * produced, so it is tested with bytes nobody in this repository would produce
 * voluntarily: a name that escapes the extraction root, an absolute path, a
 * symlink, a tarball that does not match its published hash, a package that
 * ships `install.sh`. A tiny HTTP server stands in for the registry so the suite
 * is deterministic and never depends on the public npm being up — or on it
 * serving the same version twice.
 *
 * Run: node test/inspect.test.mjs
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixture, patchBodyFor } from './fixtures.mjs'
import { resolveEnvironment } from '../lib/audit.js'
import { inspectPackage } from '../lib/inspect.js'
import { renderInspection } from '../lib/inspect-tool.js'
import { maxSatisfying, parseSpec, verifyIntegrity } from '../lib/registry.js'
import { extractTarGz } from '../lib/tar.js'
import { makeTarball } from './tarball.mjs'

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

// ---------------------------------------------------------------------------
// Fixtures: a synthetic dsh home with one official package that has declarations
// ---------------------------------------------------------------------------

const PLUGIN_FILES = {
  'package.json': JSON.stringify({
    name: 'fixture-plugin',
    version: '1.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.5' },
  }),
  'cordis.patch.yml': patchBodyFor('fixture-plugin'),
  'index.js': "import { LlmError, RemovedSymbol } from '@deepseek-ai/dsh-llm'\nexport { LlmError, RemovedSymbol }\n",
  'README.md': '# fixture\n',
}

const fixture = buildFixture({
  plugins: [],
  bundles: [],
  officialPackages: {
    '@deepseek-ai/dsh-llm': {
      version: '0.1.5',
      files: {
        'index.js': "export { LlmError } from './error.js'\n",
        'index.d.ts': "export * from './error.ts'\n",
        'error.d.ts': 'export declare class LlmError extends Error {}\n',
      },
    },
  },
})
const environment = resolveEnvironment({ dshHome: fixture.dshHome, dshRoot: fixture.dshRoot, profileName: 'web' })

/** Re-root a `package/…` file map under the npm tarball's `package/` prefix. */
function npmTarball(files) {
  return makeTarball(Object.entries(files).map(([name, content]) => ({ name: `package/${name}`, content })))
}

const healthy = npmTarball(PLUGIN_FILES)
const hostile = makeTarball([
  { name: 'package/package.json', content: JSON.stringify({ name: 'hostile', version: '1.0.0' }) },
  { name: 'package/index.js', content: 'export const ok = 1\n' },
  { name: '../escape.txt', content: 'should never be written\n' },
  { name: '/absolute.txt', content: 'should never be written\n' },
  { name: 'package/sneaky', type: '2', linkname: '../../outside' },
  { name: 'package/install.sh', content: '#!/bin/sh\npnpm add .\n' },
  {
    name: 'package/deep/deeper/deepest/deeply-nested-directory-name-that-exceeds-the-ustar-name-field/package.json',
    content: JSON.stringify({ name: 'long-name', version: '1.0.0' }),
    longName: true,
  },
])
const lifecycle = npmTarball({
  'package.json': JSON.stringify({
    name: 'lifecycle-plugin',
    version: '2.0.0',
    scripts: { postinstall: 'node ./setup.mjs' },
  }),
  'index.js': 'export const noop = 1\n',
})

const integrityOf = buffer => `sha512-${createHash('sha512').update(buffer).digest('base64')}`

function metadata(origin, name, versions, options = {}) {
  return {
    name,
    'dist-tags': { latest: options.latest ?? versions[versions.length - 1] },
    time: { [versions[versions.length - 1]]: '2026-09-01T00:00:00.000Z' },
    versions: Object.fromEntries(versions.map((version, index) => [version, {
      version,
      dist: {
        tarball: `${origin}/${name}/-/${name}-${version}.tgz`,
        integrity: options.integrity ?? null,
        shasum: options.shasum ?? undefined,
      },
      fileCount: index + 1,
    }])),
  }
}

const payloads = new Map()
let origin = ''

const server = createServer((request, response) => {
  const path = new URL(request.url, origin).pathname
  if (path === '/fixture-plugin') {
    respondJson(response, metadata(origin, 'fixture-plugin', ['1.0.0', '1.1.0'], { integrity: integrityOf(healthy) }))
    return
  }
  if (path === '/fixture-plugin/-/fixture-plugin-1.1.0.tgz') {
    respondTarball(response, healthy)
    return
  }
  if (path === '/bad-hash') {
    respondJson(response, metadata(origin, 'bad-hash', ['1.0.0'], { integrity: 'sha512-AAAAAAAA' }))
    return
  }
  if (path === '/bad-hash/-/bad-hash-1.0.0.tgz') {
    respondTarball(response, healthy)
    return
  }
  if (path === '/hostile') {
    respondJson(response, metadata(origin, 'hostile', ['1.0.0'], { integrity: integrityOf(hostile) }))
    return
  }
  if (path === '/hostile/-/hostile-1.0.0.tgz') {
    respondTarball(response, hostile)
    return
  }
  if (path === '/lifecycle-plugin') {
    respondJson(response, metadata(origin, 'lifecycle-plugin', ['2.0.0'], { integrity: integrityOf(lifecycle) }))
    return
  }
  if (path === '/lifecycle-plugin/-/lifecycle-plugin-2.0.0.tgz') {
    respondTarball(response, lifecycle)
    return
  }
  if (payloads.has(path)) {
    respondTarball(response, payloads.get(path))
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'Not found' }))
})

function respondJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function respondTarball(response, buffer) {
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  response.end(buffer)
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`
const registry = origin

// ---------------------------------------------------------------------------
// Spec parsing and version selection
// ---------------------------------------------------------------------------
{
  console.log('# spec parsing')
  const cases = [
    ['dsh-llm-local-token', 'npm', 'dsh-llm-local-token', 'latest'],
    ['pkg@1.2.3', 'npm', 'pkg', '1.2.3'],
    ['@scope/pkg', 'npm', '@scope/pkg', 'latest'],
    ['@scope/pkg@^1.2.0', 'npm', '@scope/pkg', '^1.2.0'],
    ['github:owner/repo', 'github', 'owner/repo', 'HEAD'],
    ['github:owner/repo#v1', 'github', 'owner/repo', 'v1'],
    ['https://example.test/a.tgz', 'url', 'a.tgz', ''],
  ]
  for (const [spec, kind, name, range] of cases) {
    const parsed = parseSpec(spec, { registry })
    console.log(`  ${spec} → ${parsed.kind} ${parsed.name}@${parsed.range}`)
    check(`${spec} parses as ${kind}`, parsed.kind === kind, parsed.kind)
    check(`${spec} yields the name ${name}`, parsed.name === name, parsed.name)
    check(`${spec} yields the selector ${range}`, parsed.range === range, parsed.range)
  }
  let specError = null
  try {
    parseSpec('   ')
  } catch (error) {
    specError = error
  }
  check('an empty spec is rejected rather than guessed at', specError !== null)

  check('a range picks the highest satisfying version',
    maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0') === '1.2.0',
    String(maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0')))
  check('an unsatisfiable range picks nothing',
    maxSatisfying(['1.0.0'], '^3.0.0') === undefined)
  check('the rc-prerelease rule applies to registry selection too',
    maxSatisfying(['0.1.0-rc.5', '0.1.5-rc.1'], '^0.1.0-rc.5') === '0.1.0-rc.5',
    String(maxSatisfying(['0.1.0-rc.5', '0.1.5-rc.1'], '^0.1.0-rc.5')))
  console.log()
}

// ---------------------------------------------------------------------------
// The healthy path: fetch, verify, unpack, judge
// ---------------------------------------------------------------------------
{
  const before = tempEntries()
  const report = await inspectPackage({ spec: 'fixture-plugin', environment, registry, networkTimeoutMs: 10_000 })
  const after = tempEntries()
  console.log('# healthy pre-install audit')
  console.log(renderInspection(report))
  console.log()
  check('the audit succeeds', report.error === null, String(report.error))
  check('the network is disclosed in the payload, not just the description',
    report.network === true)
  check('the latest version is selected', report.source.version === '1.1.0', report.source.version)
  check('the registry integrity hash is verified before unpacking',
    report.source.integrityVerified === true, String(report.source.integrityVerified))
  check('a sha256 of the artifact is reported',
    typeof report.source.sha256 === 'string' && report.source.sha256.length === 64)
  check('the report names the host it actually used',
    report.source.host === `127.0.0.1:${server.address().port}`, String(report.source.host))
  check('the plugin is judged against this machine',
    report.package?.name === 'fixture-plugin' && report.package?.form === 'bundle+client'
    || report.package?.form === 'bundle', JSON.stringify(report.package?.form))
  check('the layer is found readable inside the tarball', report.package?.bundle?.exists === true)
  check('a not-yet-installed package is never blamed for missing from dsh.profile.bundles',
    report.package?.risks.every(risk => !risk.includes('dsh.profile.bundles')), JSON.stringify(report.package?.risks))
  check('the bundle record is marked prospective', report.package?.bundle?.prospective === true)
  check('a satisfied peer range produces no peer risk',
    report.package?.risks.every(risk => !risk.includes('peer')), JSON.stringify(report.package?.risks))
  check('nothing is left in the temp directory afterwards',
    after.length === before.length, `${before.length} -> ${after.length}`)

  const llm = report.package.symbols.find(entry => entry.package === '@deepseek-ai/dsh-llm')
  check('the named exports are checked against the official package',
    llm !== undefined && llm.required.includes('LlmError'), JSON.stringify(llm))
  check('a real export is confirmed', llm.confirmed.includes('LlmError'))
  check('a removed export is a blocker, with the graph read to completion',
    report.package.verdict === 'incompatible'
    && report.package.blockers.some(blocker => blocker.includes('RemovedSymbol')),
    `${report.package.verdict}: ${report.package.blockers.join('; ')}`)
  check('the blocker says the graph resolved completely',
    report.package.blockers.some(blocker => blocker.includes('resolved completely')),
    report.package.blockers.join('; '))
  check('a package already installed is reported as such',
    report.alreadyInstalled?.installedVersion === null, JSON.stringify(report.alreadyInstalled))
}

// ---------------------------------------------------------------------------
// An integrity mismatch stops the audit before anything is unpacked
// ---------------------------------------------------------------------------
{
  const report = await inspectPackage({ spec: 'bad-hash', environment, registry, networkTimeoutMs: 10_000 })
  console.log('# integrity mismatch')
  console.log(`  error: ${report.error}`)
  console.log()
  check('a tarball that does not match its published hash is refused',
    typeof report.error === 'string' && report.error.includes('integrity'), String(report.error))
  check('nothing is judged when the artifact cannot be trusted', report.package === null)
  check('direct integrity verification accepts the matching hash',
    verifyIntegrity(Buffer.from('abc'), `sha512-${createHash('sha512').update('abc').digest('base64')}`) === true)
  check('direct integrity verification rejects a mismatched hash',
    verifyIntegrity(Buffer.from('abc'), 'sha512-AAAAAAAA') === false)
  check('an integrity string with no known algorithm does not pass',
    verifyIntegrity(Buffer.from('abc'), 'md5-AAAA') === false)
}

// ---------------------------------------------------------------------------
// A hostile archive: traversal, absolute paths, links
// ---------------------------------------------------------------------------
{
  const report = await inspectPackage({ spec: 'hostile', environment, registry, networkTimeoutMs: 10_000 })
  const skipped = report.extraction?.skipped ?? []
  console.log('# hostile archive')
  for (const entry of skipped) console.log(`  refused ${entry.name}: ${entry.reason}`)
  console.log()
  check('a `../` entry never reaches the extracted list',
    !report.extraction.listed.includes('../escape.txt'), JSON.stringify(report.extraction.listed.slice(0, 5)))
  check('a `../` entry is reported as refused',
    skipped.some(entry => entry.name === '../escape.txt' && entry.reason.includes('escapes')), JSON.stringify(skipped))
  check('an absolute path is reported as refused',
    skipped.some(entry => entry.name === '/absolute.txt'), JSON.stringify(skipped))
  check('a symlink entry is skipped rather than created',
    skipped.some(entry => entry.reason === 'symlink'), JSON.stringify(skipped))
  check('the extraction anomaly becomes a high-severity signal',
    report.package.signals.some(signal => signal.kind === 'unsafe-archive-entry' && signal.level === 'high'),
    JSON.stringify(report.package.signals))
  check('a repo-provided install.sh is flagged as bypassing `dsh plugin`',
    report.package.signals.some(signal => signal.kind === 'installer-script'), JSON.stringify(report.package.signals))
  check('a long path in the archive is read rather than truncated',
    report.extraction.listed.some(file => file.includes('deeply-nested-directory-name')), 'long name lost')
}

// ---------------------------------------------------------------------------
// Lifecycle scripts are reported, never executed
// ---------------------------------------------------------------------------
{
  const report = await inspectPackage({ spec: 'lifecycle-plugin', environment, registry, networkTimeoutMs: 10_000 })
  console.log('# lifecycle script in a candidate')
  console.log(`  signals: ${report.package.signals.map(signal => `${signal.kind}(${signal.level})`).join(', ')}`)
  console.log()
  check('a postinstall hook is surfaced before anything is installed',
    report.package.signals.some(signal => signal.kind === 'lifecycle:postinstall' && signal.level === 'high'),
    JSON.stringify(report.package.signals))
}

// ---------------------------------------------------------------------------
// Failure paths stay honest
// ---------------------------------------------------------------------------
{
  const missing = await inspectPackage({ spec: 'not-a-real-package-xyz', environment, registry, networkTimeoutMs: 10_000 })
  check('an unknown package comes back as an error, not a throw',
    typeof missing.error === 'string' && missing.error.includes('404'), String(missing.error))
  check('a failed fetch still reports that nothing was installed',
    renderInspection(missing).includes('nothing was installed'))

  const unreachable = await inspectPackage({
    spec: 'fixture-plugin',
    environment,
    registry: `http://127.0.0.1:${1}`,
    networkTimeoutMs: 2_000,
  })
  check('a network failure is reported as a message, not a crash',
    typeof unreachable.error === 'string' && unreachable.error !== '', String(unreachable.error))

  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await inspectPackage({ spec: 'fixture-plugin', environment, registry, signal: aborted.signal })
  check('an aborted signal stops the audit instead of fetching anyway',
    typeof cancelled.error === 'string' && cancelled.error !== '', String(cancelled.error))
  check('an aborted audit has no package verdict', cancelled.package === null)

  const badRegistry = await inspectPackage({
    spec: 'fixture-plugin',
    environment,
    registry: 'file:///etc/passwd',
    networkTimeoutMs: 2_000,
  })
  check('a registry that is not http(s) is refused before any request',
    typeof badRegistry.error === 'string' && badRegistry.error.includes('http(s)'), String(badRegistry.error))
}

// ---------------------------------------------------------------------------
// The extractor on its own
// ---------------------------------------------------------------------------
{
  const destination = join(fixture.dshHome, 'extract-target')
  const skippedRoot = extractTarGz(hostile, destination)
  check('the extractor reports what it wrote', skippedRoot.files.length >= 2, JSON.stringify(skippedRoot.files))
  check('the extractor never writes outside the destination',
    !existsSync(join(fixture.dshHome, 'escape.txt')), 'a traversal entry was written')
  check('the extractor refuses link entries', skippedRoot.skipped.some(entry => entry.reason === 'symlink'))
  check('the extractor created no symlink on disk',
    !existsSync(join(destination, 'package', 'sneaky')) || !statSync(join(destination, 'package', 'sneaky')).isSymbolicLink())

  const capped = extractTarGz(healthy, join(fixture.dshHome, 'extract-capped'), { maxFileBytes: 4 })
  check('a per-file size cap stops oversized entries and says so',
    capped.limited === true && capped.skipped.some(entry => entry.reason.includes('exceeds')), JSON.stringify(capped.skipped))
  check('a capped extraction still reports what it did write without pretending to be complete',
    capped.files.length === 0, JSON.stringify(capped.files))
}

// ---------------------------------------------------------------------------
// Render is total: replay may hand it any logged value
// ---------------------------------------------------------------------------
for (const value of [undefined, null, 42, 'text', [], {}]) {
  let threw = null
  try {
    renderInspection(value)
  } catch (error) {
    threw = error
  }
  check(`inspect render tolerates ${JSON.stringify(value) ?? 'undefined'}`, threw === null, threw?.message)
}

/** Temporary directories the inspector created and should have removed. */
function tempEntries() {
  return readdirSync(tmpdir()).filter(name => name.startsWith('dsh-plugin-inspect-'))
}

server.close()
fixture.cleanup()

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
