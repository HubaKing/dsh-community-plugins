/**
 * Tests for the lossless-JSON output contract.
 *
 * The defect these guard against is not cosmetic: `dsh_plugin_inspect` on any
 * github: or tarball-URL spec returned a fully computed report and the host threw
 * it away with `returned invalid output: value is not lossless JSON`, because
 * three `undefined` properties had been merged onto `report.source`. Registry
 * specs were unaffected, which is why it survived until a real install needed the
 * github path.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assignDefined, isLosslessJSON, renderSanitizeNote, sanitizeReport, toLosslessJSON,
} from '../lib/serialize.js'
import { normalizeRefVersion } from '../lib/registry.js'
import { finalizeReport } from '../lib/inspect.js'

describe('sanitizeReport', () => {
  it('drops undefined object properties', () => {
    const { value, changes } = sanitizeReport({ a: 1, b: undefined, c: 'x' })
    assert.deepEqual(value, { a: 1, c: 'x' })
    assert.equal(changes.length, 1)
    assert.match(changes[0], /b: dropped undefined/)
    assert.equal(isLosslessJSON(value), true)
  })

  it('turns undefined array slots into null rather than collapsing them', () => {
    const { value } = sanitizeReport({ list: [1, undefined, 3] })
    assert.deepEqual(value.list, [1, null, 3])
    assert.equal(isLosslessJSON(value), true)
  })

  it('turns NaN and Infinity into null', () => {
    const { value } = sanitizeReport({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 1 })
    assert.deepEqual(value, { a: null, b: null, c: 1 })
    assert.equal(isLosslessJSON(value), true)
  })

  it('stringifies a bigint instead of throwing', () => {
    const { value } = sanitizeReport({ big: 10n })
    assert.deepEqual(value, { big: '10' })
    assert.equal(isLosslessJSON(value), true)
  })

  it('replaces a cycle with a marker', () => {
    /** @type {any} */
    const node = { name: 'root' }
    node.self = node
    const { value, changes } = sanitizeReport(node)
    assert.equal(value.self, '[circular]')
    assert.equal(isLosslessJSON(value), true)
    assert.ok(changes.some(change => /circular/.test(change)))
  })

  it('leaves an already-clean report untouched and reports no changes', () => {
    const clean = { source: { name: 'x', version: '1.0.0', latestVersion: null, skippedByAge: [] } }
    const { value, changes } = sanitizeReport(clean)
    assert.deepEqual(value, clean)
    assert.deepEqual(changes, [])
  })

  it('survives deep nesting without hanging', () => {
    /** @type {any} */
    let deep = {}
    let cursor = deep
    for (let index = 0; index < 200; index += 1) {
      cursor.next = {}
      cursor = cursor.next
    }
    const { value } = sanitizeReport(deep)
    assert.equal(isLosslessJSON(value), true)
  })
})

describe('assignDefined', () => {
  it('never plants an undefined property', () => {
    const target = { keep: 1 }
    assignDefined(target, { present: 'yes', missing: undefined, nothing: null })
    assert.deepEqual(target, { keep: 1, present: 'yes', nothing: null })
    assert.equal('missing' in target, false)
  })
})

describe('isLosslessJSON', () => {
  it('rejects a report carrying an undefined property', () => {
    // This is the exact shape that broke the github path.
    assert.equal(isLosslessJSON({ source: { ageMinutes: undefined, version: '0.8.1' } }), false)
  })

  it('accepts nulls, which JSON can represent', () => {
    assert.equal(isLosslessJSON({ source: { ageMinutes: null, skippedByAge: [] } }), true)
  })
})

describe('finalizeReport', () => {
  it('records repairs on the report so the renderer can disclose them', () => {
    const finalized = finalizeReport({ ok: 1, broken: undefined })
    assert.deepEqual(finalized.ok, 1)
    assert.ok(Array.isArray(finalized.sanitized))
    assert.equal(isLosslessJSON(finalized), true)
  })

  it('adds no sanitized key for a clean report', () => {
    const finalized = finalizeReport({ ok: 1 })
    assert.equal('sanitized' in finalized, false)
  })
})

describe('renderSanitizeNote', () => {
  it('names the repairs and counts the overflow', () => {
    const note = renderSanitizeNote(['a: dropped undefined property', 'b: dropped undefined property',
      'c: dropped undefined property', 'd: dropped undefined property'])
    assert.match(note, /sanitized/)
    assert.match(note, /\+1 more/)
  })
})

describe('normalizeRefVersion', () => {
  it('strips a leading v from a semver-shaped ref', () => {
    assert.equal(normalizeRefVersion('v0.8.1'), '0.8.1')
    assert.equal(normalizeRefVersion('V1.2.3'), '1.2.3')
    assert.equal(normalizeRefVersion('v1.2.3-rc.1'), '1.2.3-rc.1')
  })

  it('leaves a plain version alone', () => {
    assert.equal(normalizeRefVersion('0.8.1'), '0.8.1')
  })

  it('does not touch a branch name, a sha, or a short tag', () => {
    assert.equal(normalizeRefVersion('main'), 'main')
    assert.equal(normalizeRefVersion('abc1234'), 'abc1234')
    // A branch literally named v2 must not become "2".
    assert.equal(normalizeRefVersion('v2'), 'v2')
  })
})

describe('registry/github shape contract', () => {
  it('keeps both resolvers structurally identical on the optional keys', async () => {
    const { resolveGithub, parseSpec } = await import('../lib/registry.js')
    const spec = parseSpec('github:owner/repo#v1.2.3', {
      registry: 'https://registry.npmjs.org',
      github: 'https://codeload.github.com',
    })
    const resolved = resolveGithub(spec)
    // Presence, not truthiness: an absent key is what breaks the JSON contract.
    for (const key of ['latestVersion', 'ageMinutes', 'skippedByAge', 'requestedRef', 'manifest']) {
      assert.ok(key in resolved, `resolveGithub must declare ${key} explicitly`)
    }
    assert.equal(resolved.latestVersion, null)
    assert.equal(resolved.ageMinutes, null)
    assert.deepEqual(resolved.skippedByAge, [])
    assert.equal(resolved.version, '1.2.3')
    assert.equal(resolved.requestedRef, 'v1.2.3')
    assert.equal(isLosslessJSON(resolved), true)
  })
})

describe('the live service probe may not poison the audit payload', () => {
  // The second occurrence of the same class of defect: `createServiceProbe` can
  // legitimately answer "absent" and the old code stored that answer verbatim on
  // `runtimeServices[].present`. One `undefined` there emptied the entire audit
  // report at the host boundary — the tool ran, read every file, and delivered
  // nothing. Both the fix (`present: probed === true`) and the backstop matter,
  // so this asserts the payload survives every probe shape a real context can
  // produce.
  it('survives a probe that answers undefined, null, false, true, or throws', async () => {
    const { audit, resolveEnvironment } = await import('../lib/audit.js')
    const { createServiceProbe } = await import('../lib/audit.js')
    const environment = resolveEnvironment({ profileName: 'desktop' })
    const contexts = {
      'missing ctx.get': {},
      'get returns undefined': { get: () => undefined },
      'get returns null': { get: () => null },
      'get returns false': { get: () => false },
      'get returns true': { get: () => true },
      'get throws': { get: () => { throw new Error('boom') } },
    }
    for (const [label, ctx] of Object.entries(contexts)) {
      const result = audit({ environment, runtime: { probe: createServiceProbe(ctx) } })
      assert.equal(isLosslessJSON(result), true, `${label} produced a non-lossless report`)
    }
  })

  it('stores present as a strict boolean, never the probe value itself', async () => {
    const { audit, resolveEnvironment, createServiceProbe } = await import('../lib/audit.js')
    const environment = resolveEnvironment({ profileName: 'desktop' })
    const result = audit({
      environment,
      runtime: { probe: createServiceProbe({ get: () => undefined }) },
    })
    for (const plugin of result.plugins ?? []) {
      for (const service of plugin.runtimeServices ?? []) {
        assert.equal(typeof service.present, 'boolean', `${plugin.name}: present was ${JSON.stringify(service.present)}`)
      }
    }
  })
})

describe('the audit tool sanitizes its own output', () => {
  it('returns a lossless report through the tool entry point', async () => {
    const { createAuditTool } = await import('../lib/tool.js')
    const tool = createAuditTool({})
    const report = await tool.execute({ target: '@hubaking/dsh-community-plugins' }, {})
    assert.equal(isLosslessJSON(report), true)
    assert.equal(Array.isArray(report.plugins), true)
  })
})
