/**
 * dsh-community-plugins bundle entry: registers the packaged
 * `skills/<name>/SKILL.md` bundle on `ctx.skills`, so every session on this
 * deployment sees the community-plugin guide (market discovery + install).
 *
 * Zero-dependency on purpose: frontmatter parsing is a tiny hand-rolled
 * parser for the `name`/`description` fields this bundle's own skills use,
 * so the package installs without pulling extra deps into the profile.
 * @module dsh-community-plugins
 */

import { readdirSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
/** Same rank as packaged dsh skill providers (`BUNDLED_SKILL_RANK` in `@deepseek-ai/dsh-skill`). */
const BUNDLED_SKILL_RANK = 600
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROVIDER_NAME = 'dsh-community-plugins'
const SKILLS_ROOT = fileURLToPath(new URL('./skills/', import.meta.url))

export const name = 'dsh-community-plugins'
export const inject = ['skills']

/**
 * Register the packaged skill directory as one `ctx.skills` provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Fail loudly at mount time rather than serving an empty catalog later.
  if (loadSkillsSync().length === 0) {
    throw new Error(`dsh-community-plugins: no SKILL.md bundles found under ${SKILLS_ROOT}`)
  }
  ctx.skills.registerProvider(() => ({
    name: PROVIDER_NAME,
    async list(options) {
      options?.signal?.throwIfAborted()
      const listed = await loadSkills(options?.signal)
      options?.signal?.throwIfAborted()
      return listed.map(toCandidate)
    },
    async get(candidate, options) {
      options?.signal?.throwIfAborted()
      const listed = await loadSkills(options?.signal)
      const skill = listed.find(entry => entry.name === candidate.name)
      return skill === undefined ? undefined : toDefinition(skill)
    },
  }))
}

/**
 * Read every `skills/<name>/SKILL.md` bundle from disk on each discovery, so
 * an edited skill body is picked up without restarting the harness.
 * @param {AbortSignal} [signal]
 */
async function loadSkills(signal) {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true, signal })
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    signal?.throwIfAborted()
    const directory = join(SKILLS_ROOT, entry.name)
    const skillFile = join(directory, 'SKILL.md')
    const parsed = parseSkill(await readFile(skillFile, 'utf8'), directory, skillFile)
    if (parsed !== undefined) skills.push(parsed)
  }
  return sortSkills(skills)
}

function loadSkillsSync() {
  const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const directory = join(SKILLS_ROOT, entry.name)
    const skillFile = join(directory, 'SKILL.md')
    const parsed = parseSkill(readFileSync(skillFile, 'utf8'), directory, skillFile)
    if (parsed !== undefined) skills.push(parsed)
  }
  return sortSkills(skills)
}

/**
 * Parse one SKILL.md into the shape `ctx.skills` candidates and definitions
 * are projected from. Hand-rolled frontmatter: only the `name` and
 * `description` keys are read (plus optional `disable-model-invocation` and
 * `user-invocable` booleans); anything else is ignored.
 * @param {string} raw - the file contents.
 * @param {string} directory - the skill bundle directory, used as its resource base.
 * @param {string} skillFile - the absolute SKILL.md path.
 * @returns the parsed skill, or undefined when the file is not a skill bundle.
 */
function parseSkill(raw, directory, skillFile) {
  const data = parseFrontmatter(raw)
  if (data === undefined) return undefined
  const skillName = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (skillName === undefined || description === undefined) {
    throw new Error(`dsh-community-plugins: ${skillFile} frontmatter requires name and description`)
  }
  if (!SKILL_NAME.test(skillName)) {
    throw new Error(`dsh-community-plugins: invalid skill name "${skillName}"`)
  }
  return {
    name: skillName,
    description,
    invocation: {
      modelInvocable: data['disable-model-invocation'] !== true,
      userInvocable: data['user-invocable'] !== false,
    },
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: directory },
    rank: BUNDLED_SKILL_RANK,
    locator: skillFile,
    path: skillFile,
    content: stripFrontmatter(raw).trim(),
  }
}

function sortSkills(skills) {
  const names = new Set()
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new Error(`dsh-community-plugins: duplicate skill name "${skill.name}"`)
    }
    names.add(skill.name)
  }
  return [...skills].sort((left, right) => left.name.localeCompare(right.name))
}

function toCandidate(skill) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: skill.invocation,
    provider: skill.provider,
    source: skill.source,
    resourceBase: skill.resourceBase,
    rank: skill.rank,
    locator: skill.locator,
    path: skill.path,
  }
}

function toDefinition(skill) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: skill.invocation,
    provider: skill.provider,
    source: skill.source,
    resourceBase: skill.resourceBase,
    path: skill.path,
    content: skill.content,
  }
}

/**
 * Split a leading `---` fenced block from the Markdown body and parse it as
 * flat `key: value` lines (no nested YAML). Unknown keys are kept verbatim
 * as strings/booleans when unambiguous.
 * @param {string} raw
 * @returns {Record<string, unknown> | undefined}
 */
function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const body = stripFrontmatter(raw)
  const closing = raw.length - body.length
  const block = raw.slice(firstLineEnd + 1, closing)
  const data = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === '---') continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (key === '') continue
    const value = line.slice(colon + 1).trim()
    if (value === 'true') data[key] = true
    else if (value === 'false') data[key] = false
    else data[key] = value
  }
  return data
}

/** Strip the leading `---` frontmatter block, returning the Markdown body. */
function stripFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return raw
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return nextNewline < 0 ? '' : raw.slice(nextNewline + 1)
    }
    if (nextNewline < 0) return ''
    lineStart = nextNewline + 1
  }
  return raw
}

function stringField(data, key) {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
