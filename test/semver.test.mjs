/**
 * Cross-validates `lib/semver.js` against node-semver, the implementation pnpm
 * itself uses when it prints "Issues with peer dependencies found".
 *
 * The oracle is optional: when node-semver cannot be located on this machine
 * the suite still runs its built-in assertions, so the test never depends on a
 * monorepo layout that only exists on the author's box.
 *
 * Run: node test/semver.test.mjs
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, describeRange, parseVersion, satisfies } from '../lib/semver.js'

const require = createRequire(import.meta.url)
let oracle = null
let oracleSource = 'not found'

function findOracle() {
  try {
    return { module: require('semver'), source: 'bare specifier' }
  } catch { /* keep looking */ }
  const roots = [
    process.env.DSH_ROOT,
    `${process.env.HOME ?? ''}/work/deepseek-harness`,
    'C:/Users/HubaKing/work/deepseek-harness',
  ].filter(Boolean)
  for (const root of roots) {
    const store = join(root, 'node_modules', '.pnpm')
    if (!existsSync(store)) continue
    const hit = readdirSync(store).filter(name => /^semver@\d+\.\d+\.\d+$/.test(name)).sort().pop()
    if (hit === undefined) continue
    const entry = join(store, hit, 'node_modules', 'semver', 'index.js')
    if (existsSync(entry)) return { module: require(entry), source: entry }
  }
  return null
}

const found = findOracle()
if (found !== null) {
  oracle = found.module
  oracleSource = found.source
}

let passed = 0
let failed = 0
const failures = []

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label}\n      expected ${String(expected)} / got ${String(actual)}`)
}

// ---------------------------------------------------------------------------
// Built-in assertions: the semantics this plugin depends on, stated explicitly.
// ---------------------------------------------------------------------------

// The finding that motivated this module: an rc range does NOT match a
// differently-pinned rc version. SKILL.md previously claimed the opposite.
check('rc range vs differently-pinned rc', satisfies('0.1.5-rc.1', '^0.1.0-rc.5'), false)
check('rc range vs differently-pinned rc (2)', satisfies('0.1.5-rc.1', '^0.1.0-rc.6'), false)
check('rc range vs same-tuple rc', satisfies('0.1.0-rc.6', '^0.1.0-rc.5'), true)
check('rc range vs same rc', satisfies('0.1.0-rc.5', '^0.1.0-rc.5'), true)
check('rc range vs release in range', satisfies('0.1.5', '^0.1.0-rc.5'), true)

// Zero-major caret bounds stop one component in.
check('caret zero-major upper bound', satisfies('0.2.0', '^0.1.0'), false)
check('caret zero-major in range', satisfies('0.1.9', '^0.1.0'), true)
check('caret zero-minor upper bound', satisfies('0.0.2', '^0.0.1'), false)
check('caret major upper bound', satisfies('1.5.0', '^1.2.3'), true)
check('caret major excluded', satisfies('2.0.0', '^1.2.3'), false)
check('caret excludes next-major prerelease', satisfies('2.0.0-alpha', '^1.2.3'), false)

// Tilde allows patch drift only.
check('tilde patch drift', satisfies('1.2.9', '~1.2.3'), true)
check('tilde minor excluded', satisfies('1.3.0', '~1.2.3'), false)
check('tilde two-segment', satisfies('1.2.9', '~1.2'), true)
check('tilde one-segment', satisfies('1.9.0', '~1'), true)

// x-ranges, comparators, unions.
check('x-range partial', satisfies('1.9.9', '1.x'), true)
check('x-range partial excludes', satisfies('2.0.0', '1.x'), false)
check('bare major', satisfies('1.4.4', '1'), true)
check('star matches release', satisfies('9.9.9', '*'), true)
check('star excludes prerelease', satisfies('9.9.9-alpha', '*'), false)
check('and-set', satisfies('1.5.0', '>=1.0.0 <2.0.0'), true)
check('and-set excludes', satisfies('2.0.0', '>=1.0.0 <2.0.0'), false)
check('or-set first', satisfies('1.0.0', '^1.0.0 || ^3.0.0'), true)
check('or-set second', satisfies('3.4.0', '^1.0.0 || ^3.0.0'), true)
check('or-set neither', satisfies('2.0.0', '^1.0.0 || ^3.0.0'), false)
check('exact comparator', satisfies('4.0.1', '4.0.1'), true)
check('external range passthrough', satisfies('18.2.0', '^18.2.0'), true)

// Failure modes must be reported, never guessed.
check('unparseable version', satisfies('not-a-version', '^1.0.0'), null)
check('unparseable range', satisfies('1.0.0', 'not a range'), null)
check('garbage range token', satisfies('1.0.0', '=>1'), null)
check('parseVersion rejects short form', parseVersion('1.2'), null)
check('compareVersions ordering', compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
check('compareVersions release beats rc', compareVersions('1.0.0', '1.0.0-rc.1'), 1)
check('describeRange desugars caret', describeRange('^0.1.0-rc.5'), '>=0.1.0-rc.5 <0.2.0-0')

// ---------------------------------------------------------------------------
// Cross-validation against node-semver.
// ---------------------------------------------------------------------------

const RANGES = [
  '^0.1.0-rc.5', '^0.1.0-rc.6', '^0.1.0', '^0.2.0', '^0.0.1', '^1.2.3', '^1.0.0', '^2.0.0',
  '~0.1.0', '~1.2.3', '~1.2', '~1', '1.x', '1.2.x', '1', '1.2', '*', '',
  '>=1.0.0', '>=1.0.0 <2.0.0', '>1.0.0', '<=2.0.0', '<2.0.0', '=1.2.3', '1.2.3',
  '>=0.1.0-rc.5 <0.2.0-0', '^1.0.0 || ^3.0.0', '^0.82.1', '^18.2.0', '^4.0.1', '>=22.13.0',
]

const VERSIONS = [
  '0.0.1', '0.1.0-rc.4', '0.1.0-rc.5', '0.1.0-rc.6', '0.1.0', '0.1.5-rc.1', '0.1.5', '0.1.9',
  '0.2.0-0', '0.2.0', '0.2.1', '0.3.0', '0.82.1', '0.82.9', '0.83.0', '0.85.0',
  '1.0.0-alpha', '1.0.0', '1.2.3', '1.2.9', '1.3.0', '1.9.9', '2.0.0-alpha', '2.0.0',
  '3.4.0', '4.0.1', '4.2.0', '18.2.0', '22.13.0', '22.9.0',
]

if (oracle === null) {
  console.log('! node-semver oracle not found — skipping cross-validation\n')
} else {
  console.log(`oracle: node-semver ${oracle.valid('1.0.0') ? '' : ''}${oracleSource}\n`)
  let compared = 0
  let mismatches = 0
  for (const range of RANGES) {
    for (const version of VERSIONS) {
      const mine = satisfies(version, range)
      const theirs = oracle.satisfies(version, range)
      compared += 1
      if (mine !== theirs) {
        mismatches += 1
        if (mismatches <= 15) {
          failures.push(`ORACLE MISMATCH ${JSON.stringify(range)} vs ${JSON.stringify(version)}`
            + `\n      node-semver ${theirs} / ours ${String(mine)} (expanded: ${String(describeRange(range))})`)
        }
      }
    }
  }
  console.log(`cross-validation: ${compared} pairs, ${mismatches} mismatch(es)`)
  check('cross-validation had no mismatches', mismatches, 0)

  // Ordering must agree on the full grid too.
  let orderCompared = 0
  let orderMismatches = 0
  for (const left of VERSIONS) {
    for (const right of VERSIONS) {
      const mine = compareVersions(left, right)
      const theirs = oracle.compare(left, right)
      orderCompared += 1
      if (Math.sign(mine ?? NaN) !== Math.sign(theirs)) orderMismatches += 1
    }
  }
  console.log(`ordering: ${orderCompared} pairs, ${orderMismatches} mismatch(es)`)
  check('ordering had no mismatches', orderMismatches, 0)
  console.log()
}

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
