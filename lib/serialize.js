/**
 * Lossless-JSON output hygiene.
 *
 * The host validates a tool's return value as *lossless JSON*: every reachable
 * value must survive `JSON.parse(JSON.stringify(x))` unchanged. A single
 * `undefined`-valued own property breaks that contract, and the failure mode is
 * the worst kind — the tool ran to completion, downloaded and unpacked the
 * package, computed a full report, and then the host discarded all of it with
 * `returned invalid output: value is not lossless JSON`.
 *
 * That is exactly what used to happen to `dsh_plugin_inspect` on any github: or
 * tarball-URL spec: `resolveGithub()` has no `latestVersion` / `ageMinutes` /
 * `skippedByAge` (they belong to registry resolution alone), yet `inspect.js`
 * assigned all three unconditionally, planting three `undefined` properties on
 * `report.source`. Registry specs were fine, so the defect was invisible from
 * the npm path and 100% reproducible from the github path.
 *
 * Two defences, deliberately both:
 *
 *   1. **Root cause** — callers only assign keys that carry a value
 *      (`assignDefined`), and the two resolvers now return structurally
 *      identical objects. Absence is spelled `null`, not `undefined`.
 *   2. **Backstop** — `toLosslessJSON` walks the finished report and repairs
 *      anything a future caller forgets. A report is better delivered with a
 *      sanitized note than silently dropped.
 *
 * The backstop reports what it changed. A silent repair teaches nothing and
 * hides the next regression; `sanitizeReport` returns the count so the renderer
 * can say so out loud.
 *
 * @module dsh-community-plugins/serialize
 */

/** Deep-nesting guard: reports are shallow, but a cyclic or hostile value must not hang the tool. */
const MAX_DEPTH = 64

/**
 * Assign only the entries that carry a value.
 *
 * `undefined` is treated as "no value here" — the same as omission — so the
 * target never gains a property that cannot be represented in JSON. Callers use
 * this instead of `Object.assign` when merging optional resolution fields.
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @returns {Record<string, any>} the target, for chaining.
 */
export function assignDefined(target, source) {
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value !== undefined) target[key] = value
  }
  return target
}

/**
 * @typedef {object} SanitizeResult
 * @property {any} value - a value that round-trips through JSON unchanged.
 * @property {string[]} changes - one line per repair, e.g. `source.ageMinutes: dropped undefined`.
 */

/**
 * Convert a report into lossless JSON, recording every repair.
 *
 * Rules:
 *   - `undefined`-valued object properties are dropped;
 *   - `undefined` inside an array becomes `null` (dropping it would collapse
 *     indices and misrepresent the array);
 *   - `NaN` and `±Infinity` become `null` (JSON cannot express them);
 *   - functions and symbols are dropped (object) or nulled (array);
 *   - a bigint becomes its decimal string rather than throwing;
 *   - a cycle becomes the string `"[circular]"`.
 * @param {any} input
 * @returns {SanitizeResult}
 */
export function sanitizeReport(input) {
  /** @type {string[]} */
  const changes = []
  const seen = new Set()
  let changed = false

  /**
   * @param {any} value
   * @param {string} path
   * @param {number} depth
   * @returns {any}
   */
  const walk = (value, path, depth) => {
    if (depth > MAX_DEPTH) {
      changes.push(`${path}: dropped (nesting deeper than ${MAX_DEPTH})`)
      changed = true
      return null
    }
    if (value === undefined) {
      // Reached only from an array slot; object keys are handled by the caller,
      // which can delete the property outright.
      changes.push(`${path}: undefined → null (array slot)`)
      changed = true
      return null
    }
    if (value === null) return null
    const type = typeof value
    if (type === 'string' || type === 'boolean') return value
    if (type === 'number') {
      if (Number.isFinite(value)) return value
      changes.push(`${path}: ${value} → null (not representable in JSON)`)
      changed = true
      return null
    }
    if (type === 'bigint') {
      changes.push(`${path}: bigint → string`)
      changed = true
      return value.toString()
    }
    if (type === 'function' || type === 'symbol') {
      changes.push(`${path}: ${type} → null`)
      changed = true
      return null
    }
    if (type !== 'object') return value

    if (seen.has(value)) {
      changes.push(`${path}: circular reference → "[circular]"`)
      changed = true
      return '[circular]'
    }
    seen.add(value)
    let result
    if (Array.isArray(value)) {
      result = value.map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1))
    } else {
      result = {}
      for (const key of Object.keys(value)) {
        const entry = value[key]
        if (entry === undefined) {
          changes.push(`${path}.${key}: dropped undefined property`)
          changed = true
          continue
        }
        result[key] = walk(entry, `${path}.${key}`, depth + 1)
      }
    }
    seen.delete(value)
    return result
  }

  const value = walk(input, '$', 0)
  // A report whose own root is a primitive has nothing to repair.
  return { value, changes: changed ? changes : [] }
}

/**
 * The backstop in its one-line form: repair a report, and say whether anything
 * had to be repaired.
 *
 * Callers put the report on the wire as `value`; when `changes.length > 0` they
 * append one visible sentence to the rendering, so a repaired report is never
 * mistaken for a clean one.
 * @param {any} input
 * @returns {SanitizeResult}
 */
export function toLosslessJSON(input) {
  return sanitizeReport(input)
}

/**
 * Verify the contract the host enforces, without changing anything.
 *
 * Used by tests and by the renderer's own assertion: this is the check that would
 * have caught the github-path defect, so it belongs in the code rather than only
 * in a test file.
 *
 * The comparison is deliberately made against the value **as given**. An earlier
 * version of this function stripped `undefined` before comparing, which made it
 * agree with the round-trip by construction and therefore fail to detect the one
 * defect it exists to detect.
 * @param {any} value
 * @returns {boolean}
 */
export function isLosslessJSON(value) {
  try {
    return deepEqual(JSON.parse(JSON.stringify(value)), value)
  } catch {
    return false
  }
}

/**
 * Structural equality that counts an own `undefined` property as present, so a
 * value carrying one can never compare equal to its JSON round-trip.
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function deepEqual(left, right) {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') {
    // `NaN !== NaN`, but JSON also cannot express NaN, so either side being a
    // non-finite number is a failure rather than a mismatch to paper over.
    if (typeof left === 'number' || typeof right === 'number') {
      return typeof left === 'number' && typeof right === 'number'
        && Number.isFinite(left) && Number.isFinite(right) && left === right
    }
    return false
  }
  const leftIsArray = Array.isArray(left)
  if (leftIsArray !== Array.isArray(right)) return false
  if (leftIsArray) {
    if (left.length !== right.length) return false
    return left.every((entry, index) => deepEqual(entry, right[index]))
  }
  // Own enumerable keys, so an `undefined`-valued property makes the key sets
  // disagree with the round-tripped object and the check returns false.
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
}

/**
 * The sentence a repaired report carries, so the repair is visible.
 * @param {string[]} changes
 * @returns {string}
 */
export function renderSanitizeNote(changes) {
  const shown = changes.slice(0, 3).join('; ')
  const more = changes.length > 3 ? `; +${changes.length - 3} more` : ''
  return `output sanitized for the host's lossless-JSON contract: ${shown}${more}`
}
