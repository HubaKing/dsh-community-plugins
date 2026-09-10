/**
 * A minimal, hardened tar reader for the pre-install audit.
 *
 * The pre-install tool downloads a third-party tarball, which makes this the one
 * place in the project that handles untrusted input. That is why the reader is
 * written here instead of pulled in: the security properties below are the point
 * of the file, and they are easier to guarantee than to audit in a dependency.
 *
 *   - nothing is executed, and nothing is written outside `destination`;
 *   - entries whose names escape the destination (`..`, absolute paths, Windows
 *     drive letters, backslashes) are skipped and reported, never normalized
 *     into a neighbouring directory;
 *   - symlink and hardlink entries are skipped entirely rather than created, so
 *     a later entry cannot be routed through a link out of the sandbox;
 *   - entry count, per-file size, and total size are capped, so a decompression
 *     bomb fails loudly instead of filling the disk.
 *
 * Supports the formats npm and GitHub actually emit: ustar/posix with a `prefix`
 * field, GNU long names (`L`), GNU long links (`K`), and pax extended headers
 * (`x`, `g`).
 *
 * @module dsh-community-plugins/tar
 */

import { gunzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

const BLOCK_SIZE = 512
const DEFAULT_LIMITS = {
  maxEntries: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
}

/**
 * @typedef {object} ExtractResult
 * @property {string[]} files - paths relative to the destination, with `/` separators.
 * @property {number} bytes - total bytes written.
 * @property {{ name: string, reason: string }[]} skipped - entries deliberately not written.
 * @property {boolean} limited - whether a limit stopped the extraction.
 */

/**
 * Decompress and extract a `.tar.gz` buffer into `destination`.
 * @param {Buffer | Uint8Array} archive
 * @param {string} destination - an existing directory.
 * @param {Partial<typeof DEFAULT_LIMITS>} [limits]
 * @returns {ExtractResult}
 */
export function extractTarGz(archive, destination, limits = {}) {
  const caps = { ...DEFAULT_LIMITS, ...limits }
  const tar = gunzipSync(archive)
  /** @type {string[]} */
  const files = []
  /** @type {{ name: string, reason: string }[]} */
  const skipped = []
  let bytes = 0
  let entries = 0
  let limited = false
  /** @type {string | undefined} */
  let pendingLongName
  /** @type {string | undefined} */
  let pendingLongLink
  let paxPath
  let globalPaxPath

  for (let offset = 0; offset + BLOCK_SIZE <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break
    if (entries >= caps.maxEntries) {
      limited = true
      skipped.push({ name: '(remainder)', reason: `more than ${caps.maxEntries} entries` })
      break
    }
    const size = readOctal(header, 124, 12)
    if (size === null) {
      skipped.push({ name: readString(header, 0, 100) || '(unnamed)', reason: 'unparseable size field' })
      break
    }
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const bodyStart = offset + BLOCK_SIZE
    const body = tar.subarray(bodyStart, bodyStart + size)
    const prefix = readString(header, 345, 155)
    const baseName = readString(header, 0, 100)
    let name = pendingLongName ?? (prefix === '' ? baseName : `${prefix}/${baseName}`)
    pendingLongName = undefined

    if (typeflag === 'L') {
      pendingLongName = readCString(body)
      offset = bodyStart + roundUp(size)
      continue
    }
    if (typeflag === 'K') {
      pendingLongLink = readCString(body)
      offset = bodyStart + roundUp(size)
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const fields = parsePax(body)
      if (typeflag === 'x') {
        paxPath = fields.get('path')
      } else {
        globalPaxPath = fields.get('path')
      }
      offset = bodyStart + roundUp(size)
      continue
    }
    if (paxPath !== undefined) {
      name = paxPath
      paxPath = undefined
    } else if (globalPaxPath !== undefined) {
      name = globalPaxPath
    }
    entries += 1
    offset = bodyStart + roundUp(size)

    if (typeflag === '2' || typeflag === '1') {
      // Creating these would let a later entry be written through the link,
      // outside the extraction root. Nothing legitimate needs them here.
      skipped.push({ name, reason: typeflag === '2' ? 'symlink' : 'hard link' })
      pendingLongLink = undefined
      continue
    }
    if (typeflag === '5' || name.endsWith('/')) {
      const directory = safeJoin(destination, name)
      if (directory === null) skipped.push({ name, reason: 'path escapes the extraction root' })
      else mkdirSync(directory, { recursive: true })
      continue
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') {
      skipped.push({ name, reason: `unsupported entry type ${JSON.stringify(typeflag)}` })
      continue
    }

    const target = safeJoin(destination, name)
    if (target === null) {
      skipped.push({ name, reason: 'path escapes the extraction root' })
      continue
    }
    if (size > caps.maxFileBytes) {
      limited = true
      skipped.push({ name, reason: `file exceeds ${caps.maxFileBytes} bytes` })
      continue
    }
    if (bytes + size > caps.maxTotalBytes) {
      limited = true
      skipped.push({ name, reason: `extraction exceeds ${caps.maxTotalBytes} bytes` })
      break
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    files.push(name.replaceAll('\\', '/'))
    bytes += size
  }

  return { files, bytes, skipped, limited }
}

/**
 * Join an archive entry name onto the destination, refusing anything that would
 * land outside it.
 *
 * The check is deliberately blunt: a name is either a plain relative path or it
 * is rejected. Windows drive letters and backslashes are rejected explicitly
 * because `node:path` on Windows would otherwise treat `C:\x` as absolute while
 * the same archive extracts harmlessly on Linux — the audit must behave the same
 * on both.
 * @param {string} destination
 * @param {string} name
 * @returns {string | null}
 */
function safeJoin(destination, name) {
  if (name === '' || name.includes('\\') || isAbsolute(name)) return null
  if (/^[A-Za-z]:/.test(name)) return null
  const normalized = normalize(name).replaceAll('\\', '/')
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null
  const target = join(destination, normalized)
  const root = join(destination, sep)
  return target === destination || target.startsWith(root) ? target : null
}

function roundUp(size) {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function readString(block, offset, length) {
  return readCString(block.subarray(offset, offset + length))
}

function readCString(bytes) {
  let end = bytes.indexOf(0)
  if (end === -1) end = bytes.length
  return Buffer.from(bytes.subarray(0, end)).toString('utf8').trim()
}

function readOctal(block, offset, length) {
  const text = readString(block, offset, length)
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Parse pax extended-header records (`<length> <key>=<value>\n`).
 * @param {Buffer | Uint8Array} body
 * @returns {Map<string, string>}
 */
function parsePax(body) {
  const fields = new Map()
  const text = Buffer.from(body).toString('utf8')
  let index = 0
  while (index < text.length) {
    const space = text.indexOf(' ', index)
    if (space === -1) break
    const length = Number.parseInt(text.slice(index, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, index + length - 1)
    const equals = record.indexOf('=')
    if (equals !== -1) fields.set(record.slice(0, equals), record.slice(equals + 1))
    index += length
  }
  return fields
}
