/**
 * Registry and repository access for the pre-install audit.
 *
 * This is the project's only networked module, and it exists as a separate file
 * for exactly that reason: the offline audit must be provably incapable of
 * reaching the network, and it is easier to demonstrate that when there is one
 * file to point at.
 *
 * Everything here is read-only. No registry credentials are sent, no lifecycle
 * script is executed, nothing is installed, and the bytes are checked against
 * the integrity hash the registry published before they are unpacked.
 *
 * @module dsh-community-plugins/registry
 */

import { createHash } from 'node:crypto'
import { compareVersions, satisfies } from './semver.js'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_GITHUB = 'https://codeload.github.com'
/** Download ceiling. Registry tarballs are kilobytes; anything larger is a mistake or an attack. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/**
 * @typedef {object} Spec
 * @property {'npm' | 'github' | 'url'} kind
 * @property {string} name - package name (npm) or `owner/repo` (github).
 * @property {string} range - version, range, or dist-tag (npm); ref (github).
 * @property {string} url - the tarball URL.
 */

/**
 * Parse a package specifier into something fetchable.
 *
 * Accepted forms, matching what `dsh plugin add` takes:
 *
 *   `name` · `name@1.2.3` · `name@^1.2` · `name@next` · `@scope/name`
 *   `github:owner/repo` · `github:owner/repo#ref`
 *   `https://host/path.tgz`
 * @param {string} spec
 * @param {{ registry?: string, github?: string }} [options]
 * @returns {Spec}
 * @throws {Error} when the specifier is not one of the supported forms.
 */
export function parseSpec(spec, options = {}) {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '')
  const github = (options.github ?? DEFAULT_GITHUB).replace(/\/$/, '')
  const trimmed = String(spec ?? '').trim()
  if (trimmed === '') throw new Error('the spec is empty')

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', name: tarballName(trimmed), range: '', url: trimmed }
  }

  const githubMatch = /^(?:github:|git\+https:\/\/github\.com\/)([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i.exec(trimmed)
  if (githubMatch !== null) {
    const owner = githubMatch[1]
    const repo = githubMatch[2]
    const ref = githubMatch[3] ?? 'HEAD'
    return {
      kind: 'github',
      name: `${owner}/${repo}`,
      range: ref,
      url: `${github}/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
    }
  }

  const { name, selector } = splitName(trimmed)
  if (name === '') throw new Error(`"${trimmed}" is not a package name, a github: spec, or an http(s) URL`)
  return { kind: 'npm', name, range: selector === '' ? 'latest' : selector, url: '' }
}

/**
 * Split `name@selector`, honouring the leading `@` of a scoped name.
 * @param {string} spec
 */
function splitName(spec) {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1)
    if (at === -1) return { name: spec, selector: '' }
    return { name: spec.slice(0, at), selector: spec.slice(at + 1) }
  }
  const at = spec.indexOf('@')
  if (at === -1) return { name: spec, selector: '' }
  return { name: spec.slice(0, at), selector: spec.slice(at + 1) }
}

function tarballName(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url
  } catch {
    return url
  }
}

/**
 * The registry's package-document URL.
 *
 * Only the `/` of a scoped name is escaped: the registry serves
 * `@scope%2Fname`, and escaping the leading `@` as well is a 404.
 * @param {string} registry
 * @param {string} name
 */
function documentUrl(registry, name) {
  return `${registry}/${name.replace('/', '%2F')}`
}

/**
 * @typedef {object} ResolvedTarball
 * @property {Spec} spec
 * @property {string} version - the concrete version that was selected.
 * @property {string} url
 * @property {string | null} integrity - the registry's subresource-integrity string.
 * @property {string | null} shasum - the registry's sha1, when it published one.
 * @property {string | null} publishedAt - ISO timestamp, when the registry knows it.
 * @property {number | null} fileCount
 * @property {number | null} unpackedSize
 */

/**
 * Resolve an npm specifier to one concrete version and its tarball URL.
 *
 * Resolution is done here rather than asking the registry for a pre-resolved
 * artifact so the chosen version is visible in the report — "which version would
 * this install" is half the answer, and a viewer that cannot see it cannot
 * disagree with it.
 * @param {Spec} spec
 * @param {{ registry?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<ResolvedTarball>}
 */
export async function resolveNpm(spec, options = {}) {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? fetch
  const document = await fetchJson(documentUrl(registry, spec.name), {
    fetchImpl: doFetch,
    signal: options.signal,
  })
  const versions = document?.versions
  if (typeof versions !== 'object' || versions === null || Object.keys(versions).length === 0) {
    throw new Error(`the registry returned no versions for ${spec.name}`)
  }
  const distTags = typeof document['dist-tags'] === 'object' && document['dist-tags'] !== null
    ? document['dist-tags']
    : {}
  const tag = distTags[spec.range]
  const version = typeof tag === 'string'
    ? tag
    : spec.range === 'latest'
      ? maxSatisfying(Object.keys(versions), '*')
      : maxSatisfying(Object.keys(versions), spec.range)
  if (version === undefined) {
    throw new Error(`${spec.name} has no version matching "${spec.range}"`
      + ` (latest is ${distTags.latest ?? 'unknown'})`)
  }
  const manifest = versions[version]
  const dist = manifest?.dist
  if (typeof dist?.tarball !== 'string') {
    throw new Error(`the registry listed ${spec.name}@${version} without a tarball URL`)
  }
  const time = document?.time
  return {
    spec,
    version,
    url: dist.tarball,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
    publishedAt: typeof time?.[version] === 'string' ? time[version] : null,
    fileCount: Number.isInteger(dist.fileCount) ? dist.fileCount : null,
    unpackedSize: Number.isInteger(dist.unpackedSize) ? dist.unpackedSize : null,
  }
}

/**
 * The newest version satisfying a range, or `undefined` when none does.
 * @param {string[]} versions
 * @param {string} range
 * @returns {string | undefined}
 */
export function maxSatisfying(versions, range) {
  let best
  for (const version of versions) {
    if (satisfies(version, range) !== true) continue
    if (best === undefined || (compareVersions(version, best) ?? 0) > 0) best = version
  }
  return best
}

/**
 * Describe a github: spec's tarball without contacting anything.
 * @param {Spec} spec
 * @returns {ResolvedTarball}
 */
export function resolveGithub(spec) {
  return {
    spec,
    version: spec.range,
    url: spec.url,
    integrity: null,
    shasum: null,
    publishedAt: null,
    fileCount: null,
    unpackedSize: null,
  }
}

/**
 * @typedef {object} Download
 * @property {Buffer} body
 * @property {string} url
 * @property {number} bytes
 * @property {string} sha256
 * @property {boolean | null} integrityVerified - `null` when the source published no hash.
 * @property {string | null} integrity
 */

/**
 * Download a tarball, enforcing a byte ceiling while the body streams in.
 *
 * The integrity check is what makes this safe to unpack: when the registry
 * published a hash, the bytes that reach the extractor are proven to be the ones
 * it published, so the analysis and the artifact cannot be two different things.
 * @param {{ url: string, integrity?: string | null, shasum?: string | null, maxBytes?: number }} request
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<Download>}
 */
export async function downloadTarball(request, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  const maxBytes = request.maxBytes ?? MAX_TARBALL_BYTES
  const response = await doFetch(request.url, {
    redirect: 'follow',
    headers: { accept: 'application/octet-stream, application/gzip, */*' },
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`downloading ${request.url} failed with HTTP ${response.status}`)
  const body = await readCapped(response, maxBytes)
  const sha256 = createHash('sha256').update(body).digest('hex')
  let integrityVerified = null
  if (typeof request.integrity === 'string' && request.integrity !== '') {
    integrityVerified = verifyIntegrity(body, request.integrity)
    if (integrityVerified === false) {
      throw new Error(`the downloaded tarball does not match the published integrity hash ${request.integrity}`)
    }
  } else if (typeof request.shasum === 'string' && request.shasum !== '') {
    integrityVerified = createHash('sha1').update(body).digest('hex') === request.shasum
    if (integrityVerified === false) throw new Error('the downloaded tarball does not match the published sha1')
  }
  return {
    body,
    url: request.url,
    bytes: body.length,
    sha256,
    integrityVerified,
    integrity: typeof request.integrity === 'string' ? request.integrity : null,
  }
}

/**
 * Verify a subresource-integrity string (`sha512-<base64>`, possibly a list).
 * @param {Buffer} body
 * @param {string} integrity
 * @returns {boolean}
 */
export function verifyIntegrity(body, integrity) {
  for (const candidate of integrity.trim().split(/\s+/)) {
    const dash = candidate.indexOf('-')
    if (dash === -1) continue
    const algorithm = candidate.slice(0, dash)
    const expected = candidate.slice(dash + 1)
    if (!['sha256', 'sha384', 'sha512', 'sha1'].includes(algorithm)) continue
    const actual = createHash(algorithm).update(body).digest('base64')
    if (actual === expected) return true
  }
  return false
}

async function readCapped(response, maxBytes) {
  if (response.body === null || response.body === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`the download exceeds ${maxBytes} bytes`)
    return buffer
  }
  /** @type {Buffer[]} */
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error(`the download exceeds ${maxBytes} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function fetchJson(url, options) {
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`the registry returned HTTP ${response.status} for ${url}`)
  return response.json()
}
