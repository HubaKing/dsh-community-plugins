/**
 * A tiny tar.gz writer, for tests only.
 *
 * The pre-install audit's whole job is handling an archive it did not produce,
 * so the tests have to be able to produce hostile ones — a `../` name, an
 * absolute path, a symlink, a GNU long name. A real archiver refuses to emit
 * those, which is exactly why this exists instead of shelling out to `tar`.
 *
 * @module dsh-community-plugins/test/tarball
 */

import { gzipSync } from 'node:zlib'

/**
 * @typedef {object} TarEntry
 * @property {string} name
 * @property {string} [content]
 * @property {'0' | '5' | '2' | '1'} [type] - file, directory, symlink, hard link.
 * @property {string} [linkname]
 * @property {boolean} [longName] - emit a GNU `L` header carrying the name.
 * @property {boolean} [paxName] - emit a pax `x` record carrying the name.
 */

/**
 * Build a `.tar.gz` from entries, in the order given.
 * @param {TarEntry[]} entries
 * @returns {Buffer}
 */
export function makeTarball(entries) {
  const blocks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8')
    const type = entry.type ?? '0'
    const size = type === '0' ? content.length : 0
    const name = entry.name
    let headerName = name
    if (entry.paxName === true) {
      const payload = Buffer.from(paxRecord('path', name), 'utf8')
      blocks.push(header('PaxHeader', payload.length, 'x'), block(payload))
      headerName = name.slice(0, 90)
    } else if (entry.longName === true || Buffer.byteLength(name, 'utf8') > 100) {
      const payload = Buffer.from(`${name}\0`, 'utf8')
      blocks.push(header('longname', payload.length, 'L'), block(payload))
      headerName = name.slice(0, 90)
    }
    blocks.push(header(headerName, size, type, entry.linkname))
    if (size > 0) blocks.push(block(content))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/**
 * One pax extended-header record. The length prefix counts itself, so it is
 * computed by fixed point rather than by guessing.
 * @param {string} key
 * @param {string} value
 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = body.length
  while (true) {
    const candidate = `${length}${body}`.length
    if (candidate === length) return `${length}${body}`
    length = candidate
  }
}

function block(content) {
  const padding = (512 - (content.length % 512)) % 512
  return Buffer.concat([content, Buffer.alloc(padding)])
}

function header(name, size, type, linkname) {
  const buffer = Buffer.alloc(512)
  buffer.write(name, 0, 100, 'utf8')
  buffer.write('0000644\0', 100, 'utf8')
  buffer.write('0000000\0', 108, 'utf8')
  buffer.write('0000000\0', 116, 'utf8')
  buffer.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  buffer.write('00000000000\0', 136, 'utf8')
  buffer.write('        ', 148, 'utf8')
  buffer.write(type, 156, 'utf8')
  if (linkname !== undefined) buffer.write(linkname, 157, 100, 'utf8')
  buffer.write('ustar\0', 257, 'utf8')
  buffer.write('00', 263, 'utf8')
  let checksum = 0
  for (const byte of buffer) checksum += byte
  buffer.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return buffer
}
