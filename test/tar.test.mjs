/**
 * Adversarial tests for the archive extractor.
 *
 * `lib/tar.js` reads bytes that nobody in this repository produced, so its
 * failure modes are the interesting part: a name that walks out of the
 * destination, an absolute path, a link that would redirect a later write, a
 * header that lies about its size, a decompression bomb. Each of those is
 * asserted here, because "we chose not to use a dependency" is only defensible
 * if the hand-written reader is actually tested against them.
 *
 * Run: node test/tar.test.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
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

function throws(label, fn) {
  let error = null
  try {
    fn()
  } catch (caught) {
    error = caught
  }
  check(label, error !== null, 'no error was raised')
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tar-test-'))
let counter = 0
const destinationFor = () => join(root, `target-${counter += 1}`)

// ---------------------------------------------------------------------------
// The ordinary path
// ---------------------------------------------------------------------------
{
  const destination = destinationFor()
  const result = extractTarGz(makeTarball([
    { name: 'package/package.json', content: '{"name":"x"}' },
    { name: 'package/lib/', type: '5' },
    { name: 'package/lib/index.js', content: 'export const x = 1\n' },
  ]), destination)
  check('a plain archive is extracted', result.files.length === 2, JSON.stringify(result.files))
  check('the file contents survive the round trip',
    readFileSync(join(destination, 'package/lib/index.js'), 'utf8') === 'export const x = 1\n')
  check('a directory entry is created', statSync(join(destination, 'package/lib')).isDirectory())
  check('a clean archive reports nothing skipped', result.skipped.length === 0, JSON.stringify(result.skipped))
  check('a clean archive is not marked limited', result.limited === false)
}

{
  const result = extractTarGz(makeTarball([]), destinationFor())
  check('an empty archive yields nothing rather than throwing', result.files.length === 0)
}

// ---------------------------------------------------------------------------
// Names that must never be honoured
// ---------------------------------------------------------------------------
{
  const destination = destinationFor()
  const result = extractTarGz(makeTarball([
    { name: 'ok.txt', content: 'fine\n' },
    { name: '../escape.txt', content: 'no\n' },
    { name: '../../escape.txt', content: 'no\n' },
    { name: 'package/../../escape.txt', content: 'no\n' },
    { name: '/absolute.txt', content: 'no\n' },
    { name: 'C:\\windows\\system32\\evil.txt', content: 'no\n' },
    { name: 'a\\b\\..\\..\\escape.txt', content: 'no\n' },
    { name: '..', content: 'no\n' },
  ]), destination)
  check('a safe entry is still written alongside the hostile ones', result.files.includes('ok.txt'))
  check('a `..` entry is refused', result.skipped.some(entry => entry.name === '../escape.txt'))
  check('a nested `..` entry is refused', result.skipped.some(entry => entry.name === 'package/../../escape.txt'))
  check('an absolute entry is refused', result.skipped.some(entry => entry.name === '/absolute.txt'))
  check('a Windows absolute entry is refused',
    result.skipped.some(entry => entry.name.startsWith('C:')))
  check('a backslash traversal is refused',
    result.skipped.some(entry => entry.name.startsWith('a\\b')))
  check('a bare `..` name is refused', result.skipped.some(entry => entry.name === '..'))
  check('no traversal file reached the parent directory', !existsSync(join(root, 'escape.txt')))
  check('nothing was written above the destination', !existsSync(join(root, '..', 'escape.txt')))
  check('the absolute path did not land on the filesystem', !existsSync('/absolute.txt'))
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
{
  const destination = destinationFor()
  const result = extractTarGz(makeTarball([
    { name: 'link', type: '2', linkname: '/etc/passwd' },
    { name: 'hard', type: '1', linkname: 'target' },
    { name: 'through-link/file.txt', content: 'no\n' },
  ]), destination)
  check('a symlink entry is skipped, not created',
    result.skipped.some(entry => entry.name === 'link' && entry.reason === 'symlink'))
  check('a hard link entry is skipped, not created',
    result.skipped.some(entry => entry.name === 'hard' && entry.reason === 'hard link'))
  check('no link exists on disk', !existsSync(join(destination, 'link')))
}

// ---------------------------------------------------------------------------
// Long names: GNU and pax
// ---------------------------------------------------------------------------
{
  const longName = `package/${'nested/'.repeat(20)}deep.txt`
  const gnu = destinationFor()
  const gnuResult = extractTarGz(makeTarball([{ name: longName, content: 'gnu\n', longName: true }]), gnu)
  check('a GNU long name is honoured', gnuResult.files.includes(longName), JSON.stringify(gnuResult.files))

  const pax = destinationFor()
  const paxResult = extractTarGz(makeTarball([{ name: longName, content: 'pax\n', paxName: true }]), pax)
  check('a pax long name is honoured', paxResult.files.includes(longName), JSON.stringify(paxResult.files))
  check('the pax entry is written where it claims',
    readFileSync(join(pax, ...longName.split('/')), 'utf8') === 'pax\n')
}

// ---------------------------------------------------------------------------
// Caps and malformed input
// ---------------------------------------------------------------------------
{
  const result = extractTarGz(makeTarball([
    { name: 'a.txt', content: 'aaaa' },
    { name: 'b.txt', content: 'bbbb' },
  ]), destinationFor(), { maxEntries: 1 })
  check('an entry cap stops the walk and says so',
    result.limited === true && result.skipped.some(entry => entry.reason.includes('entries')),
    JSON.stringify(result.skipped))

  const totalCapped = extractTarGz(makeTarball([
    { name: 'a.txt', content: 'aaaaaaaaaa' },
    { name: 'b.txt', content: 'bbbbbbbbbb' },
  ]), destinationFor(), { maxTotalBytes: 12 })
  check('a total size cap stops the walk and says so',
    totalCapped.limited === true && totalCapped.files.length === 1, JSON.stringify(totalCapped))

  const fileCapped = extractTarGz(makeTarball([
    { name: 'big.txt', content: 'x'.repeat(2048) },
    { name: 'small.txt', content: 'ok' },
  ]), destinationFor(), { maxFileBytes: 1024 })
  check('a per-file cap skips the file and keeps going',
    fileCapped.limited === true && fileCapped.files.length === 1 && fileCapped.files[0] === 'small.txt',
    JSON.stringify(fileCapped))

  throws('a non-gzip buffer is rejected rather than misparsed',
    () => extractTarGz(Buffer.from('this is not a tarball'), destinationFor()))
  throws('an empty buffer is rejected',
    () => extractTarGz(Buffer.alloc(0), destinationFor()))

  // A header that claims more payload than the archive holds: the reader must
  // stop, not read past the end.
  const truncated = gzipSync(Buffer.concat([
    headerFor('liar.txt', 4096),
    Buffer.from('short'),
  ]))
  const truncatedResult = extractTarGz(truncated, destinationFor())
  check('a header that overstates its size does not crash the reader',
    truncatedResult.files.length <= 1, JSON.stringify(truncatedResult.files))
}

rmSync(root, { recursive: true, force: true })

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}

/** A single ustar header with a deliberately overstated size. */
function headerFor(name, size) {
  const buffer = Buffer.alloc(512)
  buffer.write(name, 0, 100, 'utf8')
  buffer.write('0000644\0', 100, 'utf8')
  buffer.write('0000000\0', 108, 'utf8')
  buffer.write('0000000\0', 116, 'utf8')
  buffer.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  buffer.write('00000000000\0', 136, 'utf8')
  buffer.write('        ', 148, 'utf8')
  buffer.write('0', 156, 'utf8')
  buffer.write('ustar\0', 257, 'utf8')
  buffer.write('00', 263, 'utf8')
  let checksum = 0
  for (const byte of buffer) checksum += byte
  buffer.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return buffer
}
