/**
 * Dependency-free semver range matching, aligned with node-semver's comparator
 * and prerelease rules.
 *
 * Why this exists instead of importing `semver`: this plugin deliberately ships
 * zero non-`yaml` dependencies and no build step, so the one piece of semver
 * semantics it needs is implemented here. The rules that matter are exactly the
 * ones pnpm applies when it prints "Issues with peer dependencies found":
 *
 *   1. `^`/`~`/x-ranges desugar into a lower and an upper comparator, and the
 *      upper bound of a zero-major range is bounded one component further in
 *      (`^0.1.0` → `<0.2.0-0`, not `<1.0.0-0`).
 *   2. The upper bound carries a `-0` prerelease suffix, so `2.0.0-alpha`
 *      never satisfies `^1.2.3`.
 *   3. A prerelease version satisfies a range only when some comparator in the
 *      matching set pins the *same* [major, minor, patch] tuple and itself
 *      carries a prerelease tag. This is why `0.1.5-rc.1` does NOT satisfy
 *      `^0.1.0-rc.5` — the comparators are `[0,1,0]` and `[0,2,0]`, neither of
 *      which is `[0,1,5]`.
 *
 * Every exported function returns `null` (never throws) when an input cannot be
 * understood, so callers can distinguish "known incompatible" from "cannot
 * determine" instead of reporting a false verdict.
 *
 * @module dsh-community-plugins/semver
 */

/** Marker comparator for a range that constrains nothing (e.g. `*`). */
export const ANY = Symbol('any')

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const COMPARATOR_OPERATORS = ['>=', '<=', '>', '<', '=', '^', '~']
/**
 * Prerelease suffix node-semver puts on desugared exclusive upper bounds, so
 * `^1.2.3` becomes `<2.0.0-0` and never admits `2.0.0-alpha`. Numeric, matching
 * the normalization `parseVersion` applies, or the two would never compare equal.
 */
const ZERO_PRERELEASE = [0]

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {(string | number)[]} prerelease - empty for a release version
 */

/**
 * @typedef {object} Comparator
 * @property {'>' | '>=' | '<' | '<=' | '=' | typeof ANY} op
 * @property {Version | typeof ANY} version
 */

/**
 * @typedef {{ raw: string, comparators: Comparator[] }[]} RangeSets - OR of ANDs
 */

/**
 * Parse one strict `major.minor.patch[-prerelease][+build]` version.
 * @param {unknown} input
 * @returns {Version | null} the parsed version, or `null` when unparseable.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const match = VERSION_PATTERN.exec(input.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined
      ? []
      : match[4].split('.').map(identifier => (/^\d+$/.test(identifier) ? Number(identifier) : identifier)),
  }
}

/**
 * Compare two versions using semver precedence, including prerelease ordering
 * (`1.0.0-alpha` < `1.0.0-beta` < `1.0.0`).
 * @param {string | Version} left
 * @param {string | Version} right
 * @returns {number | null} negative, zero, or positive; `null` when unparseable.
 */
export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left
  const b = typeof right === 'string' ? parseVersion(right) : right
  if (a === null || b === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  // A release version always outranks a prerelease of the same tuple.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    // A shorter identifier list has lower precedence when all shared ids match.
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = typeof x === 'number'
    const yNumeric = typeof y === 'number'
    if (xNumeric && yNumeric) return x < y ? -1 : 1
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Whether `version` satisfies `range`.
 * @param {string} version - the concrete version to test.
 * @param {string} range - a node-semver range expression.
 * @returns {boolean | null} `true`/`false`, or `null` when either side is unparseable.
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version)
  const sets = parseRange(range)
  if (parsed === null || sets === null) return null
  for (const set of sets) {
    if (testComparatorSet(set, parsed)) return true
  }
  return false
}

/**
 * Expand a range into its readable comparator form (e.g. `^0.1.0-rc.5` →
 * `>=0.1.0-rc.5 <0.2.0-0`), for use as evidence in a report.
 * @param {string} range
 * @returns {string | null} the desugared description, or `null` when unparseable.
 */
export function describeRange(range) {
  const sets = parseRange(range)
  if (sets === null) return null
  return sets
    .map(set => (set.length === 0 ? '*' : set.map(renderComparator).join(' ')))
    .join(' || ')
}

function renderComparator(comparator) {
  if (comparator.version === ANY || comparator.op === ANY) return '*'
  const { major, minor, patch, prerelease } = comparator.version
  const suffix = prerelease.length === 0 ? '' : `-${prerelease.join('.')}`
  return `${comparator.op}${major}.${minor}.${patch}${suffix}`
}

/**
 * Parse a range expression into an OR-list of AND-lists of comparators.
 * @param {unknown} range
 * @returns {RangeSets | null}
 */
export function parseRange(range) {
  if (typeof range !== 'string') return null
  const trimmed = range.trim()
  // An empty string and `*` both mean "any non-prerelease version".
  if (trimmed === '' || trimmed === '*') return [[]]
  const sets = []
  for (const alternative of trimmed.split('||')) {
    const comparators = parseComparatorSet(alternative)
    if (comparators === null) return null
    sets.push(comparators)
  }
  return sets
}

function parseComparatorSet(text) {
  /** @type {Comparator[]} */
  const comparators = []
  for (const token of text.trim().split(/\s+/)) {
    if (token === '') continue
    const expanded = expandToken(token)
    if (expanded === null) return null
    comparators.push(...expanded)
  }
  return comparators
}

function splitOperator(token) {
  for (const op of COMPARATOR_OPERATORS) {
    if (token.startsWith(op)) return { op, rest: token.slice(op.length) }
  }
  return { op: '', rest: token }
}

/**
 * Expand one token (`^1.2.3`, `~1.2`, `1.x`, `>=2.0.0`, `*`) into comparators.
 * @param {string} token
 * @returns {Comparator[] | null}
 */
function expandToken(token) {
  const { op, rest } = splitOperator(token)
  const partial = parsePartial(rest)
  if (partial === null) return null
  // `*`, `x`, and a bare operator with nothing meaningful are unconstrained.
  if (partial.major === null) return op === '' ? [] : [{ op: op === '=' ? '=' : op, version: ANY }]

  const { major, minor, patch } = partial
  if (op === '^') return caretRange(partial)
  if (op === '~') return tildeRange(partial)
  if (minor === null) return partialRange(major, 0, 0, 0, op)
  if (patch === null) return partialRange(major, minor, 0, 1, op)
  return exactComparator(op, /** @type {Version} */ (partial))
}

function exactComparator(op, partial) {
  const version = { major: partial.major, minor: partial.minor, patch: partial.patch, prerelease: partial.prerelease }
  if (op === '' || op === '=') return [{ op: '=', version }]
  return [{ op, version }]
}

/**
 * A version segment is `null` when the range left it a wildcard (`1.x`, `1`).
 * @typedef {{major:number|null, minor:number|null, patch:number|null, prerelease:(string|number)[]}} Partial
 */

/**
 * @param {string} text
 * @returns {Partial | null}
 */
function parsePartial(text) {
  const body = text.trim()
  if (body === '' || body === '*' || body === 'x' || body === 'X') {
    return { major: null, minor: null, patch: null, prerelease: [] }
  }
  const [core, prerelease] = splitPrerelease(body)
  const segments = core.split('.')
  if (segments.length > 3) return null
  const numbers = []
  for (const segment of segments) {
    if (segment === '' || segment === '*' || segment === 'x' || segment === 'X') {
      numbers.push(null)
      continue
    }
    if (!/^\d+$/.test(segment)) return null
    numbers.push(Number(segment))
  }
  // A wildcard segment makes every later segment a wildcard too (`1.x.3` → `1.x`).
  const firstWildcard = numbers.indexOf(null)
  if (firstWildcard !== -1) {
    for (let index = firstWildcard; index < numbers.length; index += 1) numbers[index] = null
  }
  return {
    major: numbers[0] ?? null,
    minor: numbers[1] ?? null,
    patch: numbers[2] ?? null,
    prerelease: prerelease === undefined ? [] : prerelease.split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)),
  }
}

function splitPrerelease(body) {
  const index = body.indexOf('-')
  return index === -1 ? [body, undefined] : [body.slice(0, index), body.slice(index + 1)]
}

/** `^`: bounded by the leftmost non-zero component (`^0.1.0` → `<0.2.0-0`). */
function caretRange(partial) {
  const { major, minor, patch, prerelease } = partial
  const lower = /** @type {Version} */ ({ major, minor, patch, prerelease })
  if (minor === null) return upperBound(lower, { major: major + 1, minor: 0, patch: 0 })
  if (patch === null) {
    // `^0.x` stays inside major 0: `<1.0.0-0`.
    return upperBound(lower, major > 0 ? { major: major + 1, minor: 0, patch: 0 } : { major: 1, minor: 0, patch: 0 })
  }
  let upper
  if (major > 0) upper = { major: major + 1, minor: 0, patch: 0 }
  else if (minor > 0) upper = { major: 0, minor: minor + 1, patch: 0 }
  else upper = { major: 0, minor: 0, patch: patch + 1 }
  return upperBound(lower, upper)
}

/** `~`: allows patch-level drift only (`~1.2.3` → `<1.3.0-0`). */
function tildeRange(partial) {
  const { major, minor, patch, prerelease } = partial
  const lower = /** @type {Version} */ ({ major, minor, patch: patch ?? 0, prerelease })
  if (minor === null) return upperBound(lower, { major: major + 1, minor: 0, patch: 0 })
  return upperBound(lower, { major, minor: minor + 1, patch: 0 })
}

/** A partial version with no operator behaves like a tilde range at its precision. */
function partialRange(major, minor, patch, precision, op) {
  const upper = precision === 0 ? { major: major + 1, minor: 0, patch: 0 } : { major, minor: minor + 1, patch: 0 }
  const lower = { major, minor, patch, prerelease: [] }
  const comparators = [{ op: '>=', version: lower }]
  if (op === '' || op === '=') return [...comparators, { op: '<', version: withZeroPrerelease(upper) }]
  return [...comparators, { op: '<', version: withZeroPrerelease(upper) }]
}

function upperBound(lower, upper) {
  return [
    { op: '>=', version: lower },
    { op: '<', version: withZeroPrerelease(upper) },
  ]
}

function withZeroPrerelease({ major, minor, patch }) {
  return { major, minor, patch, prerelease: ZERO_PRERELEASE }
}

function testComparatorSet(set, version) {
  for (const comparator of set) {
    if (!testComparator(comparator, version)) return false
  }
  if (version.prerelease.length === 0) return true
  // Prerelease gate: the version must be pinned by a comparator that shares its
  // exact tuple and is itself a prerelease (node-semver's `includePrerelease`
  // default). Without this, `0.1.5-rc.1` would wrongly satisfy `^0.1.0-rc.5`.
  for (const comparator of set) {
    if (comparator.version === ANY) continue
    const pinned = comparator.version
    if (pinned.prerelease.length > 0
      && pinned.major === version.major
      && pinned.minor === version.minor
      && pinned.patch === version.patch) return true
  }
  return false
}

function testComparator(comparator, version) {
  if (comparator.version === ANY) return true
  const order = compareVersions(version, comparator.version)
  if (order === null) return false
  switch (comparator.op) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    case '=': return order === 0
    default: return false
  }
}
