/**
 * Verifies the plugin's exported contract and, when a built dsh is reachable,
 * validates the hand-written tool definition with dsh's own schema validator.
 *
 * That second part matters: this plugin deliberately does not import
 * `@deepseek-ai/dsh-tools`, so nothing at build time would otherwise catch a
 * definition that `register()` would reject at runtime. The official validator
 * is loaded here, in the test only, to prove the shape is acceptable.
 *
 * Run: node test/plugin.test.mjs
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'
import { resolveEnvironment } from '../lib/audit.js'

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

/** A minimal stand-in for the Cordis context this plugin is applied with. */
function makeContext({ withTools = true, toolsRegisterThrows = false, getThrows = false } = {}) {
  const calls = { providers: [], tools: [], effects: [] }
  const ctx = {
    skills: {
      registerProvider(provider) {
        calls.providers.push(provider)
        return () => {}
      },
    },
    get(key) {
      if (getThrows) throw new Error('context exploded')
      if (key === 'skills') return ctx.skills
      return key === 'tools' && withTools ? ctx.tools : undefined
    },
    effect(callback, label) {
      calls.effects.push({ label, dispose: callback() })
    },
    logger: { warn() {} },
  }
  if (withTools) {
    ctx.tools = {
      register(definition) {
        if (toolsRegisterThrows) throw new TypeError('tool rejected')
        calls.tools.push(definition)
        return () => {}
      },
    }
  }
  return { ctx, calls }
}

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

check('exports a bundle name', name === 'dsh-community-plugins')
check('declares skills as its only hard dependency',
  Array.isArray(inject) && inject.length === 1 && inject[0] === 'skills',
  JSON.stringify(inject))
check('apply is a function', typeof apply === 'function')

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

const happy = makeContext()
apply(happy.ctx)
check('registers exactly one skill provider', happy.calls.providers.length === 1)
check('registers exactly one tool', happy.calls.tools.length === 1)
check('wires the tool registration through ctx.effect', happy.calls.effects.length === 1,
  `effects: ${happy.calls.effects.length}`)

const provider = happy.calls.providers[0]?.()
check('skill provider has the expected name', provider?.name === 'dsh-community-plugins')
check('skill provider declares list and get',
  typeof provider?.list === 'function' && typeof provider?.get === 'function')

const tool = happy.calls.tools[0]
check('tool is named dsh_plugin_audit', tool?.name === 'dsh_plugin_audit')
check('tool has a description', typeof tool?.description === 'string' && tool.description.length > 80)
check('tool declares parameters', typeof tool?.parameters === 'object' && tool.parameters !== null)
check('tool declares output.schema', typeof tool?.output?.schema === 'object')
check('tool declares output.render', typeof tool?.output?.render === 'function')
check('tool declares execute', typeof tool?.execute === 'function')

// ---------------------------------------------------------------------------
// Graceful degradation: the skill is the core value and must never be lost
// because the optional tool could not attach.
// ---------------------------------------------------------------------------

const noTools = makeContext({ withTools: false })
let noToolsThrew = null
try {
  apply(noTools.ctx)
} catch (error) {
  noToolsThrew = error
}
check('applies cleanly when the deployment has no tools service',
  noToolsThrew === null, noToolsThrew?.message)
check('skill is still registered without a tools service', noTools.calls.providers.length === 1)
check('no tool is registered without a tools service', noTools.calls.tools.length === 0)

const brokenRegister = makeContext({ toolsRegisterThrows: true })
let brokenThrew = null
try {
  apply(brokenRegister.ctx)
} catch (error) {
  brokenThrew = error
}
check('a rejected tool registration does not break the plugin',
  brokenThrew === null, brokenThrew?.message)
check('skill survives a rejected tool registration', brokenRegister.calls.providers.length === 1)

const throwingGet = makeContext({ getThrows: true })
let throwingGetThrew = null
try {
  apply(throwingGet.ctx)
} catch (error) {
  throwingGetThrew = error
}
check('a throwing ctx.get does not break the plugin', throwingGetThrew === null)
check('skill survives a throwing ctx.get', throwingGet.providers === undefined
  || throwingGet.calls.providers.length === 1)

// ---------------------------------------------------------------------------
// Validate the hand-written definition with dsh's own validator.
// ---------------------------------------------------------------------------

const environment = resolveEnvironment()
const validatorPath = environment.dshRoot === undefined
  ? undefined
  : join(environment.dshRoot, 'packages', 'core', 'tools', 'lib', 'index.js')

if (validatorPath === undefined || !existsSync(validatorPath)) {
  console.log('! built dsh not found — skipping validation with the official schema checker\n')
} else {
  const official = await import(pathToFileURL(validatorPath).href)
  console.log(`official validator: ${validatorPath}\n`)

  let schemaError = null
  try {
    official.assertSupportedJsonSchema(tool.parameters)
  } catch (error) {
    schemaError = error
  }
  check('official validator accepts the parameters schema',
    schemaError === null, schemaError?.message)

  let outputError = null
  try {
    official.assertSupportedJsonSchema(tool.output.schema)
  } catch (error) {
    outputError = error
  }
  check('official validator accepts the output schema', outputError === null, outputError?.message)

  // An empty call is valid; an unknown key is not, because additionalProperties
  // is false. This is the behaviour `register()` would rely on at dispatch time.
  const acceptsEmpty = official.validateJsonSchemaValue(tool.parameters, {})
  check('official validator accepts an empty argument object',
    Array.isArray(acceptsEmpty) && acceptsEmpty.length === 0, JSON.stringify(acceptsEmpty))

  const rejectsUnknown = official.validateJsonSchemaValue(tool.parameters, { nope: 1 })
  check('official validator rejects unknown arguments',
    Array.isArray(rejectsUnknown) && rejectsUnknown.length > 0, JSON.stringify(rejectsUnknown))

  const rejectsWrongType = official.validateJsonSchemaValue(tool.parameters, { target: 42 })
  check('official validator rejects a wrongly typed argument',
    Array.isArray(rejectsWrongType) && rejectsWrongType.length > 0, JSON.stringify(rejectsWrongType))

  // `register()` performs exactly these two checks on a definition.
  let registerable = null
  try {
    const output = tool.output
    const ok = output !== undefined && typeof output === 'object'
      && typeof output.render === 'function'
      && (output.presentationMeta === undefined || typeof output.presentationMeta === 'function')
    if (!ok) throw new TypeError('output contract violated')
    official.assertSupportedJsonSchema(output.schema)
  } catch (error) {
    registerable = error
  }
  check('definition satisfies the two checks register() performs',
    registerable === null, registerable?.message)
}

// ---------------------------------------------------------------------------
// The tool actually runs.
// ---------------------------------------------------------------------------

const report = await tool.execute({}, { signal: undefined })
check('execute returns a report object', typeof report === 'object' && report !== null)
check('report carries an environment block', typeof report.environment === 'object')
check('report carries a summary', typeof report.summary === 'object')
check('summary counts every plugin',
  Array.isArray(report.plugins) && report.summary.total === report.plugins.length,
  `total ${report.summary?.total} vs plugins ${report.plugins?.length}`)
check('every plugin entry carries a verdict and evidence arrays',
  report.plugins.every(plugin => typeof plugin.verdict === 'string'
    && Array.isArray(plugin.blockers) && Array.isArray(plugin.risks) && Array.isArray(plugin.unknowns)))

const missingTarget = await tool.execute({ target: 'this-package-does-not-exist-xyz' }, {})
check('an unmatched target yields an empty result rather than throwing',
  missingTarget.plugins.length === 0 && missingTarget.target === null)

const blocks = tool.output.render({}, report)
check('render returns content blocks',
  Array.isArray(blocks) && blocks.length > 0 && blocks[0].type === 'text')
check('render output names the tool', typeof blocks[0]?.text === 'string' && blocks[0].text.includes('dsh plugin audit'))

// Rendering must be total: replay may hand it arbitrary logged values.
for (const value of [undefined, null, 42, 'text', [], {}]) {
  let threw = null
  try {
    tool.output.render({}, value)
  } catch (error) {
    threw = error
  }
  check(`render tolerates ${JSON.stringify(value) ?? 'undefined'}`, threw === null, threw?.message)
}

console.log('# rendered report\n')
console.log(tool.output.render({}, report)[0].text.split('\n').map(line => `  ${line}`).join('\n'))
console.log()

console.log(`passed ${passed}, failed ${failed}`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
