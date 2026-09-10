/**
 * Synthetic dsh homes for deterministic audit tests.
 *
 * Every verdict this plugin produces was previously only ever exercised against
 * whatever happened to be installed on the machine running the suite. CI has no
 * dsh checkout at all, so the verdict logic was effectively untested there. These
 * fixtures build a complete, small dsh layout in a temp directory — profile,
 * installed plugins, the `profiles/node_modules` fallback, and optionally a
 * source tree — so a verdict can be asserted exactly instead of described.
 *
 * Nothing here is written into the repository: the tree lives in `tmpdir()` and
 * is removed by `cleanup()`.
 *
 * @module dsh-community-plugins/test/fixtures
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * @typedef {object} FixturePlugin
 * @property {string} name
 * @property {object} [manifest] - defaults to `{ name, version }`.
 * @property {Record<string, string>} [files] - relative path → contents.
 */

/**
 * @typedef {object} FixtureOptions
 * @property {FixturePlugin[]} [plugins] - installed in the profile.
 * @property {string[]} [bundles] - `dsh.profile.bundles`.
 * @property {Record<string, string | { version: string, manifest?: object, files?: Record<string, string> }>} [officialPackages]
 *   Official packages placed in the fallback. A plain string is a version; an
 *   object additionally writes `manifest` overrides and `files`, which is what
 *   the symbol check needs in order to have declarations to resolve.
 * @property {'source' | 'packed'} [dshRoot] - source checkout (with `packages/`) or a packed install.
 * @property {Record<string, string | { version: string, manifest?: object, files?: Record<string, string> }>} [sourcePackages]
 *   Same shape as `officialPackages`, placed in `<root>/packages`.
 * @property {Record<string, string>} [sourceFiles] - relative to `<root>`, for slot extraction.
 * @property {string} [dshVersion]
 * @property {object} [profileManifest] - merged over the generated profile manifest.
 */

/**
 * Build a dsh home in a temp directory.
 * @param {FixtureOptions} [options]
 * @returns {{ dshHome: string, dshRoot: string | undefined, profileDir: string, cleanup: () => void }}
 */
export function buildFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-audit-fixture-'))
  const dshHome = join(root, 'home')
  const profilesDir = join(dshHome, 'profiles')
  const profileDir = join(profilesDir, 'web')
  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })

  const plugins = options.plugins ?? []
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(plugins.map(plugin => [plugin.name, '1.0.0'])),
    dsh: { profile: { bundles: options.bundles ?? [], patchReload: 'live' } },
    ...options.profileManifest,
  })

  for (const plugin of plugins) {
    const dir = scoped(modulesDir, plugin.name)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'package.json'), plugin.manifest ?? { name: plugin.name, version: '1.0.0' })
    writeFiles(dir, plugin.files)
  }

  // The launcher heals this directory at startup; out-of-tree plugins resolve
  // their missing dependencies through it, so it is the runtime package truth.
  const fallbackScope = join(profilesDir, 'node_modules', '@deepseek-ai')
  for (const [name, entry] of Object.entries(options.officialPackages ?? {})) {
    const dir = join(fallbackScope, packageDirName(name))
    mkdirSync(dir, { recursive: true })
    const spec = typeof entry === 'string' ? { version: entry } : entry
    writeJson(join(dir, 'package.json'), {
      name,
      version: spec.version,
      main: 'index.js',
      types: 'index.d.ts',
      ...spec.manifest,
    })
    writeFiles(dir, spec.files)
  }

  const mode = options.dshRoot ?? 'packed'
  const dshRoot = join(root, 'dsh')
  writeJson(join(dshRoot, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: options.dshVersion ?? '0.0.0-fixture',
  })
  if (mode === 'source') {
    mkdirSync(join(dshRoot, 'packages'), { recursive: true })
    for (const [name, entry] of Object.entries(options.sourcePackages ?? {})) {
      const dir = join(dshRoot, 'packages', packageDirName(name))
      mkdirSync(dir, { recursive: true })
      const spec = typeof entry === 'string' ? { version: entry } : entry
      writeJson(join(dir, 'package.json'), {
        name,
        version: spec.version,
        main: 'index.js',
        types: 'index.d.ts',
        ...spec.manifest,
      })
      writeFiles(dir, spec.files)
    }
    writeFiles(dshRoot, options.sourceFiles)
  }

  return { dshHome, dshRoot, profileDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * A `cordis.patch.yml` body that mounts `name`, matching what a real bundle ships.
 * @param {string} name
 */
export function patchBodyFor(name) {
  return `- insert:\n    - id: ${name.split('/').pop()}\n      name: '${name}'\n`
}

/** A source tree that defines one slot, for exercising the slot-name check. */
export const SLOT_SOURCE = {
  'packages/client/ui-slots/src/slots.ts': [
    'export const slots = {',
    "  'settings.plugin.item': { kind: 'single' },",
    "  'conversation.input.right': { kind: 'list' },",
    '}',
    '',
  ].join('\n'),
}

function scoped(base, name) {
  return join(base, ...name.split('/'))
}

/** Official packages live under a scope directory: `@deepseek-ai/dsh-llm` → `dsh-llm`. */
function packageDirName(name) {
  return name.split('/').pop()
}

/** Write `relative → contents` under `base`. An `undefined` value omits the file. */
function writeFiles(base, files) {
  for (const [relative, content] of Object.entries(files ?? {})) {
    if (content === undefined) continue
    const file = join(base, ...relative.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
