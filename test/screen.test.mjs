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
  documentRequests += 1
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
  Array.isArray(report.limits) && report.limits.length === 2, JSON.stringify(report.limits))
check('the limits name the checks that need the package contents',
  report.limits.some(limit => limit.includes('slots') && limit.includes('named exports')), report.limits.join('; '))

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
