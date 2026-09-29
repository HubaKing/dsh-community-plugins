/**
 * The metadata-only screen: what it decides, and what it refuses to do.
 *
 * The suite's centrepiece is negative: the registry in this file answers every
 * tarball path with HTTP 500 and counts the attempts. A screen that downloaded
 * anything would fail here, which is the property the mode exists for — the
 * question "which of these forty candidates can I install?" has to be answerable
 * without forty downloads.
 *
 * It also pins the wording: the screen and the offline audit must print the exact
 * same sentence for the same manifest, because two code paths describing one fact
 * differently is how a tool starts contradicting itself.
 *
 * Run: node test/screen.test.mjs
 */

import { createServer } from 'node:http'
import { buildFixture } from './fixtures.mjs'
import { resolveEnvironment } from '../lib/audit.js'
import { screenPackages } from '../lib/inspect.js'
import { audit } from '../lib/audit.js'
import { renderScreen } from '../lib/inspect-tool.js'
import { createInspectTool } from '../lib/inspect-tool.js'

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

const DSH = '0.2.0-rc.2'
let origin = ''
let tarballRequests = 0
let documentRequests = 0
/** What the registry was asked for. npm trims the manifest unless the client asks nicely. */
const acceptHeaders = []

/** A packument whose version manifest is exactly what the caller wants judged. */
function packument(name, version, manifest) {
  return {
    name,
    'dist-tags': { latest: version },
    time: { [version]: '2026-09-20T00:00:00.000Z' },
    versions: {
      [version]: {
        ...manifest,
        name,
        version,
        dist: { tarball: `${origin}/${name}/-/${name}-${version}.tgz` },
        fileCount: 3,
        unpackedSize: 2048,
      },
    },
  }
}

/** A packument with several versions and their publish times, for the age policy. */
function versionedPackument(name, entries) {
  const latest = entries[entries.length - 1].version
  return {
    name,
    'dist-tags': { latest },
    time: Object.fromEntries(entries.map(entry => [entry.version, entry.published])),
    versions: Object.fromEntries(entries.map(entry => [entry.version, {
      ...entry.manifest,
      name,
      version: entry.version,
      dist: { tarball: `${origin}/${name}/-/${name}-${entry.version}.tgz` },
      fileCount: 2,
      unpackedSize: 1024,
    }])),
  }
}

const HOUR = 3600_000
const ago = ms => new Date(Date.now() - ms).toISOString()

function respondJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

const server = createServer((request, response) => {
  const path = new URL(request.url, origin).pathname
  if (path.endsWith('.tgz')) {
    // Nothing in this suite may fetch package bytes.
    tarballRequests += 1
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'a screen must not download tarballs' }))
    return
  }
  acceptHeaders.push(String(request.headers.accept ?? ''))
  documentRequests += 1
  if (path === '/fresh-plugin') {
    // 2.0.0 is an hour old; 1.0.0 is ten days old. Which one pnpm installs is
    // decided entirely by the release-age policy.
    respondJson(response, versionedPackument('fresh-plugin', [
      { version: '1.0.0', published: ago(10 * 24 * HOUR), manifest: { license: 'MIT' } },
      { version: '2.0.0', published: ago(1 * HOUR), manifest: { license: 'MIT' } },
    ]))
    return
  }
  if (path === '/plain-plugin') {
    respondJson(response, packument('plain-plugin', '1.2.3', {
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      license: 'MIT',
    }))
    return
  }
  if (path === '/gated-plugin') {
    respondJson(response, packument('gated-plugin', '1.0.0', {
      peerDependencies: { '@deepseek-ai/dsh-client-ui-theme': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      license: 'MIT',
    }))
    return
  }
  if (path === '/gated-plugin-exempt') {
    respondJson(response, packument('gated-plugin-exempt', '1.0.0', {
      peerDependencies: { '@deepseek-ai/dsh-client-ui-theme': '^0.1.0-rc.6' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    return
  }
  if (path === '/old-plugin') {
    respondJson(response, packument('old-plugin', '0.9.0', {
      peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0-rc.6' },
      deprecated: 'renamed to something else',
      scripts: { postinstall: 'node ./setup.mjs' },
      license: 'Apache-2.0',
    }))
    return
  }
  if (path === '/no-peers') {
    respondJson(response, packument('no-peers', '2.0.0', { license: 'MIT' }))
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'Not found' }))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`

const fixture = buildFixture({
  dshVersion: DSH,
  plugins: [],
  bundles: [],
  compatibility: { 'gated-plugin-exempt@1.0.0': [DSH] },
})
const environment = resolveEnvironment({
  dshHome: fixture.dshHome,
  dshRoot: fixture.dshRoot,
  profileName: 'web',
})
check('the fixture pins the dsh version the gate is judged against',
  environment.dshVersion === DSH, String(environment.dshVersion))

const report = await screenPackages({
  specs: [
    'plain-plugin',
    'gated-plugin',
    'gated-plugin-exempt',
    'old-plugin',
    'no-peers',
    'ghost-plugin',
    'github:someone/something',
  ],
  environment,
  registry: origin,
})

const byName = new Map(report.candidates.map(candidate => [candidate.name ?? candidate.requested, candidate]))

console.log('# screen over seven specs')
console.log(`  candidates        : ${report.candidates.length}`)
console.log(`  tarball requests  : ${tarballRequests}`)
console.log(`  document requests : ${documentRequests}`)
for (const candidate of report.candidates) {
  const label = candidate.name ?? candidate.requested
  console.log(`  ${label} -> ${candidate.verdict ?? 'error'}`
    + `${candidate.name === undefined ? ` (${candidate.error})` : ''}`)
}
console.log()

check('every spec produces exactly one candidate row',
  report.candidates.length === 7, String(report.candidates.length))
check('the screen downloads no package bytes at all', tarballRequests === 0,
  `${tarballRequests} tarball request(s) were made`)
check('the screen is marked as metadata-only in the payload', report.metadataOnly === true)
check('the screen still discloses that it used the network', report.network === true)

// The registry trims the manifest when the client accepts its abbreviated form:
// measured, 3-6 fields instead of 25-28, with `dsh`, `scripts` and `license`
// dropped. Every request must therefore ask for the full document, or `form`
// reads as plain `cordis`, licences read as null, and the lifecycle check the
// screen advertises can never fire.
check('every registry request asks for the full document, never npm\'s trimmed one',
  acceptHeaders.length > 0
  && acceptHeaders.every(header => !header.includes('vnd.npm.install-v1+json'))
  && acceptHeaders.every(header => header.includes('application/json')),
  JSON.stringify(acceptHeaders.slice(0, 3)))
check('a manifest read this way still carries the dsh block and scripts',
  byName.get('plain-plugin')?.form === 'bundle' && byName.get('old-plugin')?.hasScripts === true,
  `${byName.get('plain-plugin')?.form} / ${byName.get('old-plugin')?.hasScripts}`)

// A package with nothing declared to check is compatible, and the rollup says so
// rather than staying silent.
const plain = byName.get('plain-plugin')
check('a package with no peers and no scripts is compatible', plain.verdict === 'compatible', plain.verdict)
check('the version and form are taken from the registry document',
  plain.version === '1.2.3' && plain.form === 'bundle', `${plain.version} ${plain.form}`)
check('a package with no peers reports zero declared',
  plain.peerSummary.declared === 0, JSON.stringify(plain.peerSummary))
check('the registry publication time is carried into the report',
  typeof plain.publishedAt === 'string', String(plain.publishedAt))

// The gate is the decisive filter, and it is judged exactly as the audit judges it.
const gated = byName.get('gated-plugin')
check('a @deepseek-ai/dsh* peer that does not admit this dsh makes the gate deny',
  gated.verdict === 'at-risk' && gated.gate.denied === true, JSON.stringify(gated.gate))
check('the gate denial explains itself and names the exemption command',
  gated.risks.some(risk => risk.includes('version gate') && risk.includes('allow-version')),
  gated.risks.join('; '))

const exempt = byName.get('gated-plugin-exempt')
check('an exact-version grant in compatibility.json clears the screen denial too',
  exempt.gate.exempted === true && exempt.gate.denied === false, JSON.stringify(exempt.gate))

// ---------------------------------------------------------------------------
// The release-age policy decides which version is even judged
//
// `pnpm add dsh-dream-skin` resolved 9.27.1 rather than the `latest` 9.29.0 on
// this machine, and the two versions' peers disagree about the running dsh — so
// auditing the newest version can describe a package nobody will install.
// Configured thresholds are honoured exactly; with none configured nothing is
// invented, and the report says so plus the pin that settles it.
// ---------------------------------------------------------------------------
{
  const policyFor = policy => screenPackages({
    specs: ['fresh-plugin'],
    environment: { ...environment, releaseAge: policy },
    registry: origin,
  })

  const configured = await policyFor({ minimumMinutes: 48 * 60, exclude: [], configured: true })
  const candidate = configured.candidates[0]
  console.log('# release-age policy')
  console.log(`  configured 48h -> ${candidate.name}@${candidate.version}`
    + ` skipped=${JSON.stringify(candidate.skippedByAge)} age=${candidate.ageMinutes}m`)
  check('a configured minimumReleaseAge sends resolution to the older version',
    candidate.version === '1.0.0', `${candidate.version} (latest ${candidate.latestVersion})`)
  check('the versions the policy passed over are reported as evidence',
    candidate.skippedByAge.includes('2.0.0'), JSON.stringify(candidate.skippedByAge))
  check('what is judged is the resolved version, not `latest`',
    candidate.ageMinutes > 24 * 60, String(candidate.ageMinutes))

  const whitelisted = await policyFor({
    minimumMinutes: 48 * 60, exclude: ['fresh-plugin@2.0.0'], configured: true,
  })
  check('a minimumReleaseAgeExclude entry admits the fresh version',
    whitelisted.candidates[0].version === '2.0.0', whitelisted.candidates[0].version)

  const unconfigured = await policyFor({ minimumMinutes: null, exclude: [], configured: false })
  const fresh = unconfigured.candidates[0]
  check('with nothing configured the newest version is resolved, and no threshold is invented',
    fresh.version === '2.0.0' && fresh.skippedByAge.length === 0,
    `${fresh.version} skipped=${JSON.stringify(fresh.skippedByAge)}`)
  check('with nothing configured the report still states the limit',
    unconfigured.limits.some(limit => limit.includes('release age of its own')
      && limit.includes('add <package>@<version>')),
    unconfigured.limits.join(' | '))

  const rendered = renderScreen(unconfigured)
  console.log(`  rendered : ${rendered.split('\n').find(line => line.includes('release age:'))}`)
  console.log()
  check('a fresh version with no policy renders the pin recipe',
    rendered.includes('release age:') && rendered.includes('add fresh-plugin@2.0.0'), rendered)
  check('a configured policy does not render the unconfigured caveat',
    !renderScreen(configured).includes('configures no'), renderScreen(configured))
}

// Wording parity: the same manifest, judged by the installed audit, must produce
// the identical sentence.
{
  const auditFixture = buildFixture({
    dshVersion: DSH,
    plugins: [{
      name: 'gated-plugin',
      manifest: {
        name: 'gated-plugin',
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh-client-ui-theme': '^0.1.0-rc.6' },
      },
    }],
    bundles: ['gated-plugin'],
  })
  const installed = audit({
    environment: resolveEnvironment({
      dshHome: auditFixture.dshHome, dshRoot: auditFixture.dshRoot, profileName: 'web',
    }),
  })
  const audited = installed.plugins[0].risks.find(risk => risk.includes('version gate'))
  const screened = gated.risks.find(risk => risk.includes('version gate'))
  console.log('# wording parity between the screen and the installed audit')
  console.log(`  audited  : ${audited}`)
  console.log(`  screened : ${screened}`)
  console.log()
  check('the screen and the audit print the same gate sentence character for character',
    audited !== undefined && audited === screened,
    `\n      audited : ${audited}\n      screened: ${screened}`)
  check('the screen and the audit agree on the peer sentence too',
    JSON.stringify(installed.plugins[0].peers) === JSON.stringify(gated.peers),
    `${JSON.stringify(installed.plugins[0].peers)} vs ${JSON.stringify(gated.peers)}`)
  auditFixture.cleanup()
}

// Manifest-level facts a screen can still see.
const old = byName.get('old-plugin')
check('a deprecated package is flagged', old.deprecated === 'renamed to something else', String(old.deprecated))
check('a lifecycle hook is reported from the manifest alone',
  old.signals.some(signal => signal.kind === 'lifecycle:postinstall'), JSON.stringify(old.signals))

// Specs a metadata-only pass must refuse rather than half-answer.
const ghost = byName.get('ghost-plugin')
check('an unknown package comes back as an error row, not as a verdict',
  ghost.verdict === undefined && typeof ghost.error === 'string', JSON.stringify(ghost))
check('the error is the registry\'s own message',
  ghost.error.includes('404') || ghost.error.includes('no versions'), ghost.error)
const github = byName.get('github:someone/something')
check('a github: spec is refused with the reason, not silently dropped',
  github.verdict === undefined && github.error.includes('only npm specs'), String(github.error))

// Limits: a screen must say what it could not check.
check('the report states what a screen cannot see',
  Array.isArray(report.limits) && report.limits.length >= 2, JSON.stringify(report.limits))
check('the limits name the checks that need the package contents',
  report.limits.some(limit => limit.includes('slots') && limit.includes('named exports')), report.limits.join('; '))
check('the limits state that "compatible" is about this screen only',
  report.limits.some(limit => limit.includes('nothing this screen can check failed')), report.limits.join('; '))

// Rendering: the bulk report reuses the audit's own lines and section headers.
const text = renderScreen(report)
console.log('# rendered screen')
console.log(text.split('\n').slice(0, 14).join('\n'))
console.log()
check('the screen header says no package bytes were downloaded',
  text.includes('metadata only: no package bytes downloaded'), text.split('\n')[0])
check('the rendered screen carries the peers line', text.includes('   peers: '), text)
check('the rendered screen carries the gate line', text.includes('   gate: '), text)
check('the rendered screen reuses the audit\'s limits header',
  text.includes('limits of this run:'), text)
check('the rendered screen ends with the same promise line as the single audit',
  text.trimEnd().endsWith('nothing was installed, nothing was written to the profile, and no lifecycle script was run.'),
  text.split('\n').slice(-1)[0])

// The single-audit shape must not be mistaken for the screen shape: both carry a
// `candidates` field, for different things.
check('a single inspection is not rendered as a screen', text.startsWith('dsh plugin screen — '))

// The same tool, the other shape: one string still audits by downloading.
const inspectTool = createInspectTool({})
const single = await inspectTool.execute({ spec: 'plain-plugin', registry: origin }, {})
check('a single-spec call still takes the download-and-audit path, not the screen',
  single.metadataOnly === undefined && single.package === null, JSON.stringify(Object.keys(single)))
check('the single-spec path really did try to download, so the two shapes differ',
  tarballRequests > 0, `tarballRequests=${tarballRequests}`)

// Fail closed: a missing or empty argument comes back as a report, not a throw
// and not a request. The schema already requires `spec`; this is the runtime half.
const missing = await inspectTool.execute({}, {})
check('a missing spec comes back as an error report',
  typeof missing.error === 'string' && missing.package === null, JSON.stringify(missing))
const emptyArray = await inspectTool.execute({ spec: [] }, {})
check('an empty array does not silently screen nothing',
  typeof emptyArray.error === 'string', JSON.stringify(emptyArray))

server.close()
fixture.cleanup()

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
