/**
 * Loads the plugin into a real Cordis runtime and exercises it end to end.
 *
 * This exists because a mock context cannot catch everything. The service probe
 * once read `ctx.reflect.store` with plain string keys; the real store is keyed
 * by `Symbol(name)`, so every lookup missed and every `inject` name was reported
 * as absent. A hand-rolled mock agreed with the bug — only a real context found
 * it. Regressing that fix is exactly what this file prevents.
 *
 * Skips cleanly when no Cordis runtime is reachable.
 *
 * Run: node test/integration.test.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServiceProbe, resolveEnvironment } from '../lib/audit.js'

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

const environment = resolveEnvironment()
const cordisPath = environment.dshRoot === undefined
  ? undefined
  : join(environment.dshRoot, 'vendor', 'cordis', 'lib', 'index.js')

if (cordisPath === undefined || !existsSync(cordisPath)) {
  console.log('! cordis runtime not found — skipping integration test\n')
  console.log(`passed ${passed}, failed ${failed}`)
} else {
  console.log(`cordis runtime: ${cordisPath}\n`)
  const { Context } = await import(pathToFileURL(cordisPath).href)
  const plugin = await import('../index.js')

  const seen = { providers: [], tools: [], disposers: 0 }
  const ctx = new Context()
  ctx.provide('skills', {
    registerProvider(provider) {
      seen.providers.push(provider)
      return () => {}
    },
  })
  ctx.provide('tools', {
    register(definition) {
      seen.tools.push(definition)
      return () => {
        seen.disposers += 1
      }
    },
  })

  const fiber = ctx.plugin(plugin)
  await new Promise(resolve => setTimeout(resolve, 60))

  check('the plugin fiber reaches an active state', (fiber?.state ?? 0) > 0, `state ${fiber?.state}`)
  check('the skill provider is registered on the real context', seen.providers.length === 1)
  check('the tool is registered on the real tools service', seen.tools.length === 1,
    `registered: ${seen.tools.map(tool => tool.name).join(', ') || '(none)'}`)
  check('the registered tool is dsh_plugin_audit', seen.tools[0]?.name === 'dsh_plugin_audit')

  // The regression guard: this is what the Symbol-keyed store bug broke.
  const probe = createServiceProbe(ctx)
  check('probe finds a service provided on the real context', probe('skills') === true,
    `probe("skills") returned ${String(probe('skills'))}`)
  check('probe finds a second provided service', probe('tools') === true)
  check('probe reports an absent service as absent', probe('no-such-service') === false,
    `probe("no-such-service") returned ${String(probe('no-such-service'))}`)

  // The tool must run against a real context, not just a mock one.
  const report = await seen.tools[0].execute({}, {})
  check('the tool runs on a real context', typeof report?.summary === 'object')
  check('runtime service probes now resolve rather than reporting absence',
    JSON.stringify(report.plugins).includes('"present":true')
    || report.plugins.every(entry => entry.runtimeServices.length === 0),
    'expected at least one inject name resolved present')

  // Unloading the plugin must remove the tool it added.
  await fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('unloading the plugin disposes the tool registration', seen.disposers === 1,
    `disposers called: ${seen.disposers}`)
}

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
