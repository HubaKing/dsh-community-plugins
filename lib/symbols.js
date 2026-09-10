/**
 * Symbol-level verification against the official packages installed here.
 *
 * A plugin that imports `{ PiAiAdapter }` from `@deepseek-ai/dsh-llm` keeps
 * working only while that package still *exports* `PiAiAdapter`. Checking that
 * the package exists is not enough â€?a rename or a split leaves the package in
 * place and the binding gone, and an ESM named import of a binding that the
 * module does not provide is a hard link-time failure, not a degraded feature.
 *
 * The honest difficulty is that a package's export surface is a graph, not a
 * file. Official declarations are barrels:
 *
 *     export * from './attribution.ts';        // note the .ts specifier
 *     export { BlockAssembler } from './assembler.ts';
 *
 * so a single-file scan reports every re-exported symbol as missing. This module
 * therefore walks the graph â€?relative specifiers, the `.ts`/`.js` â†?`.d.ts`
 * mapping, bare specifiers into other packages â€?and reports two things it must
 * never conflate:
 *
 *   - the set of symbols it *confirmed*, and
 *   - whether that set is *complete*.
 *
 * Only a complete graph licenses the word "removed". An incomplete one yields
 * `unknown`, because "I could not resolve it" is not "it is gone" â€?and a
 * verification tool that guesses is worse than no tool at all.
 *
 * The runtime entry is scanned as well and unioned in. Type declarations are
 * emitted by the same build as the runtime, so they normally agree; where they
 * do not, the runtime is what an `import` statement actually resolves against.
 *
 * @module dsh-community-plugins/symbols
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Bound the graph walk so one pathological package cannot stall an audit. */
const MAX_GRAPH_FILES = 400
const MAX_GRAPH_BYTES = 8_000_000

/**
 * @typedef {object} SymbolRequest
 * @property {string} package - the official package name.
 * @property {string} subpath - '' for the root entry, otherwise the subpath.
 * @property {string} exported - the *upstream* name the import requires.
 * @property {string} file - where the import was found, for evidence.
 */

/**
 * @typedef {object} PackageSurface
 * @property {Set<string>} symbols - names confirmed to be exported.
 * @property {boolean} complete - whether an absent name may be called removed.
 * @property {string | null} entry - the declaration file the check started from.
 * @property {string | null} runtimeEntry - the runtime module, when locatable.
 * @property {number} files - declaration files visited.
 * @property {string[]} unresolved - what stopped the walk, for evidence.
 */

// ---------------------------------------------------------------------------
// Reading imports out of plugin source
// ---------------------------------------------------------------------------

/**
 * `import â€?from 'â€?` and `export â€?from 'â€?`, with the clause captured whole so
 * multi-line and mixed default/named forms are handled.
 *
 * The clause excludes `;` and quotes so it cannot span two statements: a
 * side-effect import immediately followed by a re-export would otherwise be
 * read as one clause, attributing the later statement's bindings to the earlier
 * package â€?a confident false attribution, which is the failure mode this whole
 * module is arranged to avoid.
 *
 * `import type â€¦` is deliberately left out of the runtime check: a missing type
 * export cannot break loading, and reporting it would be a false alarm about a
 * runtime failure. Inline `type` specifiers inside a mixed statement are dropped
 * individually instead, so `import { type A, B }` still verifies `B`.
 */
const CLAUSE = "([^;'\"]{0,600}?)"
const IMPORT_FROM = new RegExp(`\\bimport\\s+(?!\\()${CLAUSE}\\sfrom\\s*["']([^"']+)["']`, 'g')
const REEXPORT_FROM = new RegExp(`\\bexport\\s+(?!\\*)${CLAUSE}\\sfrom\\s*["']([^"']+)["']`, 'g')
const STAR_FROM = /\bexport\s+\*\s*(?:as\s+[\w$]+\s*)?from\s*["']([^"']+)["']/g

/**
 * Extract every upstream export name the source requires from official packages.
 *
 * Namespace imports (`* as ns`) and side-effect imports (`import 'pkg'`) require
 * no particular symbol, so they contribute nothing â€?but the package itself is
 * still recorded by `scanPluginSource`, which owns the package-existence check.
 * @param {string} text - comment-stripped source.
 * @param {string} file - the file the text came from, for evidence.
 * @returns {SymbolRequest[]}
 */
export function collectSymbolRequests(text, file) {
  /** @type {SymbolRequest[]} */
  const requests = []
  const push = (specifier, clause) => {
    const parsed = splitSpecifier(specifier)
    if (parsed === null) return
    for (const exported of clauseBindings(clause)) {
      requests.push({ package: parsed.name, subpath: parsed.subpath, exported, file })
    }
  }
  for (const match of text.matchAll(IMPORT_FROM)) {
    // A whole-statement `import type` is erased at build time and cannot fail.
    if (/^\s*type\s/.test(match[1])) continue
    push(match[2], match[1])
  }
  for (const match of text.matchAll(REEXPORT_FROM)) {
    if (/^\s*type\s/.test(match[1])) continue
    push(match[2], match[1])
  }
  for (const match of text.matchAll(STAR_FROM)) push(match[1], '* as namespace')
  return requests
}

/**
 * Split `@scope/name/sub/path` into a package name and subpath.
 * @param {string} specifier
 * @returns {{ name: string, subpath: string } | null}
 */
export function splitSpecifier(specifier) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2 || parts[0].length < 2 || parts[1] === '') return null
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join('/') }
  }
  if (parts[0] === '') return null
  return { name: parts[0], subpath: parts.slice(1).join('/') }
}

/**
 * Turn one import clause into the upstream names it requires.
 *
 * `{ A as B }` requires upstream `A`; the local alias is irrelevant. A default
 * binding requires the `default` export. A namespace binding requires nothing.
 * @param {string} rawClause
 * @returns {string[]}
 */
function clauseBindings(rawClause) {
  const clause = rawClause.replace(/^\s*type\s+/, '').trim()
  if (clause === '' || clause.startsWith('*')) return []
  const braceStart = clause.indexOf('{')
  if (braceStart === -1) {
    // A bare default binding: `import Foo from 'pkg'`.
    return /^[A-Za-z_$][\w$]*$/.test(clause) ? ['default'] : []
  }
  const braceEnd = clause.lastIndexOf('}')
  if (braceEnd < braceStart) return []
  /** @type {string[]} */
  const names = []
  // `import Foo, { A } from 'pkg'` also requires the default export.
  const beforeBrace = clause.slice(0, braceStart).trim().replace(/,$/, '').trim()
  if (/^[A-Za-z_$][\w$]*$/.test(beforeBrace)) names.push('default')
  for (const entry of clause.slice(braceStart + 1, braceEnd).split(',')) {
    const specifier = entry.trim()
    // `{ type A }` is erased at build time and cannot fail to resolve.
    if (specifier === '' || /^type\s/.test(specifier)) continue
    const upstream = specifier.split(/\s+as\s+/)[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(upstream)) names.push(upstream)
  }
  return names
}

// ---------------------------------------------------------------------------
// Walking a package's export graph
// ---------------------------------------------------------------------------

/**
 * Map an explicit specifier onto a file that exists.
 *
 * This is where the `.ts` suffix in published declarations has to be handled:
 * `export * from './attribution.ts'` is emitted verbatim by TypeScript, while
 * the file actually shipped beside it is `attribution.d.ts`. Resolving the
 * literal path finds nothing, and a resolver that gives up there reports every
 * re-exported symbol as missing.
 * @param {string} specifier
 * @param {string} fromFile
 * @returns {string | undefined}
 */
export function resolveRelativeFile(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier)
  const stripped = base.replace(/\.(d\.ts|d\.mts|d\.cts|tsx?|jsx?|mjs|cjs)$/, '')
  const candidates = [
    base,
    `${stripped}.d.ts`, `${stripped}.d.mts`, `${stripped}.d.cts`,
    `${base}.d.ts`,
    `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`, `${stripped}.mjs`, `${stripped}.cjs`,
    join(stripped, 'index.d.ts'), join(stripped, 'index.ts'), join(stripped, 'index.js'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (isDirectory(candidate)) continue
    return candidate
  }
  return undefined
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The declaration file a package's `exports` map (or `types` field) points at.
 * @param {object} manifest
 * @param {string} subpath
 * @returns {string | null} a path relative to the package directory.
 */
export function declarationEntry(manifest, subpath) {
  const key = subpath === '' ? '.' : `./${subpath}`
  const entry = manifest?.exports?.[key]
  if (typeof entry === 'string' || entry === null) {
    // A string target is the runtime file; its declaration sibling is implied.
    if (typeof entry === 'string') return entry.replace(/\.(js|mjs|cjs)$/, '.d.ts')
    return null
  }
  if (typeof entry === 'object' && entry !== null) {
    for (const key of ['types', 'typings']) {
      if (typeof entry[key] === 'string') return entry[key]
    }
    // Nested condition objects (`import`/`require`) are not walked: guessing a
    // declaration path is exactly the confident-wrong answer to avoid.
    return null
  }
  if (subpath === '') {
    if (typeof manifest?.types === 'string') return manifest.types
    if (typeof manifest?.typings === 'string') return manifest.typings
  }
  return null
}

/**
 * The runtime file a package's `exports` map (or `main` field) points at.
 * @param {object} manifest
 * @param {string} subpath
 * @returns {string | null}
 */
export function runtimeEntry(manifest, subpath) {
  const key = subpath === '' ? '.' : `./${subpath}`
  const entry = manifest?.exports?.[key]
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null) {
    for (const condition of ['default', 'import', 'require', 'node']) {
      if (typeof entry[condition] === 'string') return entry[condition]
    }
  }
  if (subpath === '') {
    if (typeof manifest?.module === 'string') return manifest.module
    if (typeof manifest?.main === 'string') return manifest.main
  }
  return null
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /^[ \t]*\/\/[^\n]*/gm

/** Strip comments, which otherwise read as declarations (`/** export const x *â€?`). */
function withoutComments(text) {
  return text.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '')
}

// Declaration forms. `export declare const A, B` is covered by collecting the
// first declarator here and letting the runtime scan catch the rest.
const DECLARATION = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum|interface|type|namespace|module)\s+([A-Za-z_$][\w$]*)/g
const LOCAL_BRACES = /\bexport\s+(?:declare\s+)?(?:type\s+)?\{([^}]*)\}(?!\s*from)/g
const REEXPORT_NAMED = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
const REEXPORT_STAR = /\bexport\s+\*\s*(?:as\s+([\w$]+)\s*)?from\s*["']([^"']+)["']/g
const HAS_DEFAULT = /\bexport\s+(?:default\b|declare\s+default\b)/
const AS_DEFAULT = /\bexport\s*\{[^}]*\bas\s+default\b/
const EXPORT_EQUALS = /\bexport\s*=/
const RUNTIME_DECLARATION = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g
const RUNTIME_BRACES = /\bexport\s*\{([^}]*)\}/g
const CJS_ASSIGN = /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g
/** esbuild's CJS-interop annotation: `0 && (module.exports = { a, b })`. */
const CJS_ANNOTATION = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g

/**
 * The name each `{ â€?}` specifier introduces, taking the alias when there is
 * one: `B as C` introduces `C`, a bare `B` introduces `B`, and an inline
 * `type B` is skipped â€?a type-only binding is not what an `import` needs.
 * @param {string} body - the text between the braces.
 * @returns {string[]}
 */
function braceSpecifiers(body) {
  /** @type {string[]} */
  const names = []
  for (const entry of body.split(',')) {
    const specifier = entry.trim().replace(/^type\s+/, '')
    if (specifier === '') continue
    const asIndex = specifier.search(/\s+as\s+/)
    const name = (asIndex === -1 ? specifier : specifier.slice(asIndex).replace(/\s+as\s+/, '')).trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
  }
  return names
}

/**
 * Read the export names out of one module's text.
 *
 * Used for both declaration files and runtime entries; the forms differ enough
 * that both families are always tried, and a surplus name is harmless because
 * this set only ever *confirms* presence.
 * @param {string} text
 * @param {{ runtime?: boolean }} [options]
 * @returns {{ names: Set<string>, reexports: { specifier: string, star: boolean }[], exportEquals: boolean }}
 */
export function readExportNames(text, options = {}) {
  const runtime = options.runtime === true
  const source = withoutComments(text)
  const names = new Set()
  /** @type {{ specifier: string, star: boolean }[]} */
  const reexports = []
  for (const match of source.matchAll(runtime ? RUNTIME_DECLARATION : DECLARATION)) names.add(match[1])
  for (const match of source.matchAll(runtime ? RUNTIME_BRACES : LOCAL_BRACES)) {
    for (const name of braceSpecifiers(match[1])) names.add(name)
  }
  // `export { A as B } from './x'` exports `B` here; the target may export `A`
  // under any name, so the forwarded symbols are followed separately.
  for (const match of source.matchAll(REEXPORT_NAMED)) {
    for (const name of braceSpecifiers(match[1])) names.add(name)
  }
  for (const match of source.matchAll(REEXPORT_STAR)) {
    // `export * as ns from './x'` introduces only `ns`; following the target
    // there would wrongly promote every symbol of `./x` to this module's surface.
    if (match[1] !== undefined) {
      names.add(match[1])
      continue
    }
    reexports.push({ specifier: match[2], star: true })
  }
  if (HAS_DEFAULT.test(source) || AS_DEFAULT.test(source)) names.add('default')
  for (const match of source.matchAll(CJS_ASSIGN)) names.add(match[1])
  for (const match of source.matchAll(CJS_ANNOTATION)) {
    for (const entry of match[1].split(',')) {
      const specifier = entry.split(':')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(specifier)) names.add(specifier)
    }
  }
  return { names, reexports, exportEquals: EXPORT_EQUALS.test(source) }
}

/**
 * Build the confirmed export surface of one package entry point.
 *
 * `resolvePackage` maps a bare specifier onto an installed package directory; a
 * `null` result means the walk could not continue, which makes the surface
 * incomplete rather than wrong.
 * @param {string} packageDir
 * @param {object} manifest
 * @param {string} subpath
 * @param {{ resolvePackage: (name: string) => { dir: string, manifest: object } | null }} options
 * @returns {PackageSurface}
 */
export function buildPackageSurface(packageDir, manifest, subpath, options) {
  const symbols = new Set()
  const unresolved = []
  const visited = new Set()
  let runtimeEntryFile = null
  let files = 0
  let bytes = 0
  let complete = true

  const note = message => {
    if (unresolved.length < 6 && !unresolved.includes(message)) unresolved.push(message)
  }

  // Evidence is rendered into user-facing findings, so it names the file
  // relative to its package rather than leaking an absolute install path.
  const label = file => relative(packageDir, file).replaceAll('\\', '/') || file

  const visitDeclaration = file => {
    if (visited.has(file)) return
    if (visited.size >= MAX_GRAPH_FILES) {
      complete = false
      note(`stopped after ${MAX_GRAPH_FILES} declaration files`)
      return
    }
    visited.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      complete = false
      note(`unreadable declaration file ${label(file)}`)
      return
    }
    bytes += text.length
    if (bytes > MAX_GRAPH_BYTES) {
      complete = false
      note('declaration graph exceeds the size budget')
      return
    }
    files += 1
    const { names, reexports, exportEquals } = readExportNames(text)
    for (const name of names) symbols.add(name)
    if (exportEquals) {
      // `export = X` makes the whole named-import surface unknowable here.
      complete = false
      note(`${label(file)} uses \`export =\`, which has no named export list`)
    }
    for (const reexport of reexports) {
      if (!reexport.star) continue
      const specifier = reexport.specifier
      if (specifier.startsWith('.')) {
        const target = resolveRelativeFile(specifier, file)
        if (target === undefined) {
          complete = false
          note(`${label(file)} re-exports ${specifier}, which does not resolve`)
        } else {
          visitDeclaration(target)
        }
        continue
      }
      const resolved = options.resolvePackage(specifier)
      if (resolved === null) {
        complete = false
        note(`${label(file)} re-exports ${specifier}, which is not installed here`)
        continue
      }
      const parsed = splitSpecifier(specifier)
      const target = declarationEntryFor(resolved, parsed?.subpath ?? '')
      if (target === undefined) {
        complete = false
        note(`${label(file)} re-exports ${specifier}, which declares no type entry`)
        continue
      }
      visitDeclaration(target)
    }
  }

  const declarationRelative = declarationEntry(manifest, subpath)
  let declarationFile = null
  if (declarationRelative === null) {
    complete = false
    note(`no type declaration entry is declared for "${subpath === '' ? '.' : `./${subpath}`}"`)
  } else {
    const candidate = join(packageDir, declarationRelative)
    if (existsSync(candidate) && !isDirectory(candidate)) {
      declarationFile = candidate
      visitDeclaration(candidate)
    } else {
      complete = false
      note(`the declared type entry ${declarationRelative} is not in the package`)
    }
  }

  // The runtime entry is not a fallback for a broken graph â€?it is the thing an
  // `import` statement is actually resolved against, so it is unioned in.
  const runtimeRelative = runtimeEntry(manifest, subpath)
  if (runtimeRelative === null) {
    complete = false
    note('no runtime entry is declared')
  } else {
    const candidate = join(packageDir, runtimeRelative)
    if (existsSync(candidate) && !isDirectory(candidate)) {
      runtimeEntryFile = candidate
      try {
        const text = readFileSync(candidate, 'utf8')
        const { names } = readExportNames(text, { runtime: true })
        for (const name of names) symbols.add(name)
        // A bundled runtime that re-exports from another module is still fully
        // described by its own `export { â€?}` list, so its re-exports are not
        // walked: whatever it forwards also appears as a binding there.
      } catch {
        complete = false
        note('the runtime entry is unreadable')
      }
    } else {
      complete = false
      note(`the declared runtime entry ${runtimeRelative} is not in the package`)
    }
  }

  return {
    symbols,
    complete: complete && unresolved.length === 0,
    entry: declarationFile,
    runtimeEntry: runtimeEntryFile,
    files,
    unresolved,
  }
}

/** Resolve a bare specifier to the type entry of the installed package. */
function declarationEntryFor(resolved, subpath) {
  const relative = declarationEntry(resolved.manifest, subpath)
  if (relative === null) return undefined
  const candidate = join(resolved.dir, relative)
  return existsSync(candidate) && !isDirectory(candidate) ? candidate : undefined
}
