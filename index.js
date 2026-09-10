/**
 * dsh-community-plugins bundle entry.
 *
 * Three layers, one bundle, no build step:
 *
 *   1. **Knowledge** — registers the packaged `skills/<name>/SKILL.md` bundle on
 *      `ctx.skills`, so every session on this deployment knows how to discover,
 *      evaluate and install community plugins.
 *   2. **Capability (offline)** — registers `dsh_plugin_audit`, which checks an
 *      installed plugin's declared peers, imported `@deepseek-ai` packages and
 *      their named exports, registered slots and inject names against the dsh
 *      build actually installed here.
 *   3. **Capability (networked)** — registers `dsh_plugin_inspect`, which does
 *      the same for a plugin that is *not* installed yet, by downloading its
 *      published tarball into a temporary directory and throwing it away.
 *
 * The tools are separate on purpose. The audit's whole promise is that it
 * fetches nothing; a flag that sometimes made it fetch would make that promise
 * conditional, and a conditional promise is not one. So the networked capability
 * is a different tool with a different name and a description that says so.
 *
 * Both are attached through `ctx.get('tools')` rather than an `inject`
 * dependency. `inject = ['tools']` would make this whole plugin — including the
 * skill — sit in a `waiting` state on any deployment that composes no `tools`
 * service, turning an optional extra into a hard prerequisite. The skill must
 * always load; the tools degrade away quietly when they cannot exist.
 *
 * @module dsh-community-plugins
 */

import { registerSkills } from './lib/skills.js'
import { INSPECT_TOOL_NAME, createInspectTool } from './lib/inspect-tool.js'
import { AUDIT_TOOL_NAME, createAuditTool } from './lib/tool.js'

export const name = 'dsh-community-plugins'
export const inject = ['skills']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  registerSkills(ctx)
  registerTools(ctx)
}

/**
 * Register both tools when this deployment provides a `tools` service.
 *
 * A plain-object tool definition is used instead of `defineTool` from
 * `@deepseek-ai/dsh-tools`; see `lib/tool.js` for why.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string[]} the names that were registered.
 */
function registerTools(ctx) {
  let tools
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  } catch {
    tools = undefined
  }
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return []

  const definitions = [createAuditTool(ctx), createInspectTool(ctx)]
  const registered = []
  for (const definition of definitions) {
    try {
      // `ctx.effect` ties the registration to this plugin's fiber, so unloading
      // the plugin also removes the tool. Fall back to a bare registration when
      // the context predates `effect`.
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => tools.register(definition), `dsh-community-plugins: ${definition.name}`)
      } else {
        tools.register(definition)
      }
      registered.push(definition.name)
    } catch (error) {
      // The skill is this plugin's core value; a rejected tool registration must
      // not take it down with it — and one rejected tool must not take the other
      // one with it either.
      warn(ctx, `could not register the ${definition.name} tool; the skill is still available`, error)
    }
  }
  return registered
}

/** The two tool names this bundle registers, in registration order. */
export const TOOL_NAMES = [AUDIT_TOOL_NAME, INSPECT_TOOL_NAME]

function warn(ctx, message, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const line = `dsh-community-plugins: ${message} (${detail})`
  try {
    const logger = ctx.logger ?? ctx.get?.('logger')
    if (typeof logger?.warn === 'function') {
      logger.warn(line)
      return
    }
  } catch { /* fall through to console */ }
  console.warn(line)
}
