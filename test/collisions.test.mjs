/**
 * Name-collision detection.
 *
 * One session found `dsh-reasoning-effort` published by five different owners:
 * the bare name by one author (audited at-risk), three scoped variants, and the
 * package the user actually wanted living only in a GitHub Release. Writing
 * `dsh plugin add dsh-reasoning-effort` would have installed a package from an
 * author nobody had looked at, and the two behave identically until something
 * breaks.
 *
 * The check exists to answer "is this the one I meant?", which no amount of
 * manifest analysis can answer. It is advisory by construction: it never changes
 * a verdict, and a registry that will not answer makes it report nothing rather
 * than fail the audit.
 *
 * Run: node test/collisions.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { findNameCollisions } from '../lib/registry.js'
import { renderNameCollisions } from '../lib/inspect-tool.js'

/** The registry's search endpoint answers with `objects[].package`. */
function searchDocument(query, names) {
  return {
    objects: names.map(name => ({
      package: {
        name,
        version: '1.0.0',
        description: `a package named ${name}`,
      },
      searchScore: 1,
    })),
    total: names.length,
  }
}

describe('findNameCollisions', () => {
  let server
  let origin = ''
  /** Every query the server was asked for, so the request shape can be asserted. */
  const queries = []

  before(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/-/v1/search') {
        const text = url.searchParams.get('text') ?? ''
        queries.push(text)
        // The fixture registry knows exactly one collision family.
        if (text === 'dsh-reasoning-effort') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(searchDocument(text, [
            '@hajilongshi/dsh-reasoning-effort',
            'dsh-reasoning-effort',
            '@x1a0f3n9/dsh-reasoning-effort',
            // A near-name that shares a prefix but is a different package: it must
            // not be reported as a collision.
            'dsh-reasoning-effort-plus',
            'dsh-thinking-levels',
          ])))
          return
        }
        if (text === 'exploding') {
          response.writeHead(500)
          response.end('nope')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(searchDocument(text, [`${text}`, `@scope/${text}`])))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('finds scoped publishers of the same name', async () => {
    const collisions = await findNameCollisions('dsh-reasoning-effort', { registry: origin })
    const names = collisions.map(entry => entry.name)
    assert.deepEqual(names, [
      '@hajilongshi/dsh-reasoning-effort',
      '@x1a0f3n9/dsh-reasoning-effort',
    ])
  })

  it('never reports the resolved package itself as a collision', async () => {
    const collisions = await findNameCollisions('dsh-reasoning-effort', { registry: origin })
    assert.equal(collisions.some(entry => entry.name === 'dsh-reasoning-effort'), false)
  })

  it('does not match a name that merely shares a prefix', async () => {
    const collisions = await findNameCollisions('dsh-reasoning-effort', { registry: origin })
    assert.equal(collisions.some(entry => entry.name === 'dsh-reasoning-effort-plus'), false,
      'a longer name is a different package, not a collision')
  })

  it('searches on the unscoped tail, because scoped siblings are the point', async () => {
    queries.length = 0
    await findNameCollisions('@someone/dsh-thinking-levels', { registry: origin })
    assert.deepEqual(queries, ['dsh-thinking-levels'])
  })

  it('reports nothing when the registry fails, rather than failing the audit', async () => {
    // Advisory checks must never take the report down with them.
    const collisions = await findNameCollisions('exploding', { registry: origin })
    assert.deepEqual(collisions, [])
  })

  it('reports nothing for a non-http registry', async () => {
    assert.deepEqual(await findNameCollisions('anything', { registry: 'file:///tmp' }), [])
  })

  it('returns a JSON-safe shape', async () => {
    const collisions = await findNameCollisions('dsh-reasoning-effort', { registry: origin })
    assert.equal(JSON.parse(JSON.stringify(collisions)).length, collisions.length)
    for (const entry of collisions) {
      assert.equal(typeof entry.name, 'string')
      assert.equal(entry.version === null || typeof entry.version === 'string', true)
      assert.equal(entry.description === null || typeof entry.description === 'string', true)
    }
  })
})

describe('renderNameCollisions', () => {
  it('states the count and names each sibling', () => {
    const lines = renderNameCollisions([
      { name: '@a/dsh-x', version: '1.0.0', description: 'first' },
      { name: '@b/dsh-x', version: '2.0.0', description: null },
    ]).join('\n')
    assert.match(lines, /2 other publisher\(s\)/)
    assert.match(lines, /@a\/dsh-x@1\.0\.0 — first/)
    assert.match(lines, /@b\/dsh-x@2\.0\.0/)
  })

  it('says an unscoped add installs the bare name only', () => {
    const lines = renderNameCollisions([{ name: '@a/dsh-x', version: '1.0.0', description: null }]).join('\n')
    assert.match(lines, /unscoped/)
  })

  it('renders nothing when there is no collision', () => {
    assert.deepEqual(renderNameCollisions([]), [])
    assert.deepEqual(renderNameCollisions(null), [])
  })
})
