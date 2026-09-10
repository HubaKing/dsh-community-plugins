/**
 * Unit tests for the export-graph resolver.
 *
 * This is the module with the highest false-positive risk in the project: a
 * resolver that gives up on a barrel reports every re-exported symbol as
 * removed, and "confidently wrong" is the one outcome this tool is built to
 * avoid. The cases below are the ones that produced wrong answers while it was
 * being written — the `.ts`-suffixed `export *`, the side-effect import followed
 * by a re-export, the private class in a barrel, the aliased re-export.
 *
 * Run: node test/symbols.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildPackageSurface,
  collectSymbolRequests,
  declarationEntry,
  readExportNames,
  resolveRelativeFile,
  runtimeEntry,
  splitSpecifier,
} from '../lib/symbols.js'

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

/** Write `relative → contents` under `base`. */
function writeTree(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(base, ...relative.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-symbols-test-'))

// ---------------------------------------------------------------------------
// A barrel package: `export *` with `.ts` specifiers, exactly as upstream emits
// ---------------------------------------------------------------------------
const pkgDir = join(root, 'pkg')
writeTree(pkgDir, {
  'package.json': JSON.stringify({
    name: '@test/barrel',
    version: '1.0.0',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
  }),
  'lib/index.js': [
    "export { Alpha, Helper } from './alpha.js'",
    "export { Beta, Hidden } from './beta.js'",
    '',
  ].join('\n'),
  'lib/types/index.d.ts': [
    "export * from './alpha.ts';",
    "export { Beta, Hidden as Renamed } from './beta.ts';",
    "export type { OnlyAType } from './types.ts';",
    '',
  ].join('\n'),
  'lib/types/alpha.d.ts': 'export declare const Alpha: number;\nexport declare function Helper(): void;\n',
  'lib/types/beta.d.ts': 'export declare class Beta {}\nexport declare class Hidden {}\n',
  'lib/types/types.d.ts': 'export type OnlyAType = string;\n',
})

const manifest = { name: '@test/barrel', version: '1.0.0', main: 'lib/index.js', types: 'lib/types/index.d.ts' }

{
  const surface = buildPackageSurface(pkgDir, manifest, '', { resolvePackage: () => null })
  console.log('# barrel package surface')
  console.log(`  symbols : ${[...surface.symbols].sort().join(', ')}`)
  console.log(`  complete: ${surface.complete} over ${surface.files} declaration file(s)`)
  console.log()
  check('a `.ts`-suffixed `export *` is followed, not treated as unresolved', surface.complete,
    JSON.stringify(surface.unresolved))
  check('symbols re-exported through `export *` are confirmed',
    surface.symbols.has('Alpha') && surface.symbols.has('Helper'), [...surface.symbols].join(', '))
  check('symbols named in an explicit re-export are confirmed', surface.symbols.has('Beta'))
  check('an aliased re-export is confirmed under its exported name', surface.symbols.has('Renamed'))
  check('a type-only re-export is confirmed', surface.symbols.has('OnlyAType'))
  check('the runtime entry contributes its own export names', surface.symbols.has('Hidden'))
  check('the surface records which declaration entry it came from',
    typeof surface.entry === 'string' && surface.entry.endsWith('index.d.ts'), String(surface.entry))
}

// A symbol that genuinely does not exist anywhere must not be confirmed.
{
  const surface = buildPackageSurface(pkgDir, manifest, '', { resolvePackage: () => null })
  check('a name that does not exist is not confirmed', !surface.symbols.has('DefinitelyNotExported'))
  check('a complete graph still refuses a bogus name while claiming completeness', surface.complete)
}

// ---------------------------------------------------------------------------
// An unresolvable re-export makes the surface incomplete, never wrong
// ---------------------------------------------------------------------------
{
  const brokenDir = join(root, 'broken')
  writeTree(brokenDir, {
    'package.json': JSON.stringify({ name: '@test/broken', version: '1.0.0', types: 'index.d.ts' }),
    'index.d.ts': "export * from './gone.ts';\nexport declare const Present: number;\n",
  })
  const surface = buildPackageSurface(
    brokenDir,
    { name: '@test/broken', version: '1.0.0', types: 'index.d.ts' },
    '',
    { resolvePackage: () => null },
  )
  console.log('# unresolvable re-export')
  console.log(`  complete  : ${surface.complete}`)
  console.log(`  unresolved: ${JSON.stringify(surface.unresolved)}`)
  console.log()
  check('a re-export that does not resolve marks the surface incomplete', surface.complete === false)
  check('the unresolved specifier is reported as evidence',
    surface.unresolved.some(entry => entry.includes('./gone.ts')), JSON.stringify(surface.unresolved))
  check('what did resolve is still confirmed', surface.symbols.has('Present'))
}

// A bare re-export into another package is followed when that package resolves.
{
  const otherDir = join(root, 'other')
  writeTree(otherDir, {
    'package.json': JSON.stringify({ name: '@test/other', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
    'index.js': 'export const Borrowed = 1;\n',
    'index.d.ts': 'export declare const Borrowed: number;\n',
  })
  const hostDir = join(root, 'host')
  writeTree(hostDir, {
    'package.json': JSON.stringify({ name: '@test/host', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
    'index.js': "export * from '@test/other';\n",
    'index.d.ts': "export * from '@test/other';\n",
  })
  const resolvePackage = name => (name === '@test/other'
    ? { dir: otherDir, manifest: { name, version: '1.0.0', main: 'index.js', types: 'index.d.ts' } }
    : null)
  const surface = buildPackageSurface(
    hostDir,
    { name: '@test/host', version: '1.0.0', main: 'index.js', types: 'index.d.ts' },
    '',
    { resolvePackage },
  )
  check('a bare re-export into another package is followed', surface.complete && surface.symbols.has('Borrowed'),
    `${surface.complete} ${[...surface.symbols].join(',')} ${JSON.stringify(surface.unresolved)}`)
}

// ---------------------------------------------------------------------------
// Reading imports out of plugin source
// ---------------------------------------------------------------------------
{
  const source = [
    "import { A, B as C } from '@deepseek-ai/pkg'",
    "import type { TypeOnly } from '@deepseek-ai/pkg'",
    "import { type InlineType, Real } from '@deepseek-ai/pkg/sub'",
    "import Default, { Named } from '@deepseek-ai/pkg'",
    "import * as namespace from '@deepseek-ai/pkg'",
    "import '@deepseek-ai/side-effect'",
    "import {",
    '  Multiline,',
    '} from "@deepseek-ai/pkg"',
    "export { Reexported } from '@deepseek-ai/pkg'",
    "export * from '@deepseek-ai/pkg'",
    "export * as Sub from '@deepseek-ai/pkg'",
    "const required = require('@deepseek-ai/required')",
  ].join('\n')
  const requests = collectSymbolRequests(source, 'index.js')
  const seen = requests.map(request => `${request.package}${request.subpath === '' ? '' : `/${request.subpath}`}#${request.exported}`)
  console.log('# import extraction')
  console.log(`  ${seen.join('\n  ')}`)
  console.log()
  const has = entry => seen.includes(entry)
  check('a named import is recorded under its upstream name', has('@deepseek-ai/pkg#A'))
  check('an aliased import is recorded under its upstream name, not the local alias', has('@deepseek-ai/pkg#B'))
  check('a whole-statement `import type` is not checked at runtime', !has('@deepseek-ai/pkg#TypeOnly'))
  check('an inline `type` specifier is skipped', !has('@deepseek-ai/pkg/sub#InlineType'))
  check('a mixed statement still verifies its value binding', has('@deepseek-ai/pkg/sub#Real'))
  check('a default binding requires the default export', has('@deepseek-ai/pkg#default'))
  check('a default binding does not hide the named ones', has('@deepseek-ai/pkg#Named'))
  check('a namespace import requires no particular name',
    !seen.some(entry => entry.includes('namespace')))
  check('a side-effect import requires no name',
    !seen.some(entry => entry.startsWith('@deepseek-ai/side-effect#')))
  check('a multi-line import clause is parsed', has('@deepseek-ai/pkg#Multiline'))
  check('a named re-export is treated as a required binding', has('@deepseek-ai/pkg#Reexported'))
  check('an aliased namespace re-export requires no inner name',
    !seen.some(entry => entry.includes('Sub#')))
  check('a `require()` call contributes no named binding',
    !seen.some(entry => entry.includes('required#')))
  // The regression that motivated the clause character class: a side-effect
  // import immediately before a re-export used to be read as one clause, so the
  // re-export's binding was attributed to the side-effect package.
  check('a side-effect import does not absorb the next statement\'s bindings',
    !seen.includes('@deepseek-ai/side-effect#Reexported'), seen.join(' '))
}

{
  const requests = collectSymbolRequests(
    "import { A } from '@scope/pkg'\nimport { B } from 'react'\nimport { C } from './local.js'\n",
    'index.js',
  )
  const packages = requests.map(request => request.package)
  check('non-official packages are left to the caller to filter',
    packages.includes('react') && packages.includes('@scope/pkg') && packages.includes('./local.js') === false,
    packages.join(', '))
  check('a scoped specifier is split into name and subpath',
    JSON.stringify(splitSpecifier('@scope/pkg/sub/deep')) === '{"name":"@scope/pkg","subpath":"sub/deep"}',
    JSON.stringify(splitSpecifier('@scope/pkg/sub/deep')))
}

// ---------------------------------------------------------------------------
// Export-name readers and path mapping
// ---------------------------------------------------------------------------
{
  const declaration = readExportNames([
    'export declare const A: number;',
    'export declare function fn(): void;',
    'export declare class Cls {}',
    'export declare interface Iface {}',
    'export declare type Alias = string;',
    'export declare enum E {}',
    'export declare namespace NS {}',
    'export { Local, Local2 as Renamed2 };',
    'export default class D {}',
    'export * from "./star.ts";',
    '// export declare const Commented: number;',
    '/* export declare const BlockCommented: number; */',
  ].join('\n'))
  const names = [...declaration.names].sort()
  console.log(`# declaration names: ${names.join(', ')}`)
  console.log()
  for (const expected of ['A', 'fn', 'Cls', 'Iface', 'Alias', 'E', 'NS', 'Local', 'Renamed2', 'default']) {
    check(`a declaration exports ${expected}`, declaration.names.has(expected), names.join(', '))
  }
  check('a commented-out declaration is not read as an export', !declaration.names.has('Commented'))
  check('a block-commented declaration is not read as an export', !declaration.names.has('BlockCommented'))
  check('a star re-export is queued for following',
    declaration.reexports.some(entry => entry.star && entry.specifier === './star.ts'),
    JSON.stringify(declaration.reexports))

  const runtime = readExportNames([
    'export { apple, banana as cherry };',
    'export const declared = 1;',
    'export default thing;',
    '0 && (module.exports = { annotated, other });',
    'exports.cjsNamed = 1;',
  ].join('\n'), { runtime: true })
  for (const expected of ['apple', 'cherry', 'declared', 'default', 'annotated', 'other', 'cjsNamed']) {
    check(`a runtime module exports ${expected}`, runtime.names.has(expected), [...runtime.names].join(', '))
  }
}

{
  const file = join(pkgDir, 'lib', 'types', 'index.d.ts')
  check('`.ts` maps to the emitted `.d.ts` sibling',
    resolveRelativeFile('./alpha.ts', file) === join(pkgDir, 'lib', 'types', 'alpha.d.ts'),
    String(resolveRelativeFile('./alpha.ts', file)))
  check('`.js` maps to the emitted `.d.ts` sibling',
    resolveRelativeFile('./alpha.js', file) === join(pkgDir, 'lib', 'types', 'alpha.d.ts'))
  check('a specifier with no extension resolves',
    resolveRelativeFile('./alpha', file) === join(pkgDir, 'lib', 'types', 'alpha.d.ts'))
  check('a specifier that does not exist resolves to undefined',
    resolveRelativeFile('./nope.ts', file) === undefined)
  // A directory specifier legitimately resolves through its index; what must
  // never happen is returning the directory itself.
  const directorySpecifier = resolveRelativeFile('.', file)
  check('a resolved path is always a file, never a directory',
    directorySpecifier === undefined || statSync(directorySpecifier).isFile(), String(directorySpecifier))
}

{
  const exportsManifest = { exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } } }
  check('a conditional exports map yields its types entry',
    declarationEntry(exportsManifest, '') === './lib/types/index.d.ts', String(declarationEntry(exportsManifest, '')))
  check('a conditional exports map yields its runtime entry',
    runtimeEntry(exportsManifest, '') === './lib/index.js', String(runtimeEntry(exportsManifest, '')))
  check('a subpath is looked up as its own exports key',
    declarationEntry({ exports: { './sub': { types: './sub.d.ts' } } }, 'sub') === './sub.d.ts')
  check('a root with no types entry yields null, not a guess',
    declarationEntry({ main: 'index.js' }, '') === null)
  check('a subpath with no exports entry yields null, not a guess',
    declarationEntry({ types: './index.d.ts' }, 'sub') === null)
  check('a string exports target implies the declaration sibling',
    declarationEntry({ exports: { '.': './lib/index.js' } }, '') === './lib/index.d.ts')
}

rmSync(root, { recursive: true, force: true })

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
