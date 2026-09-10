/**
 * dsh-community-plugins bundle entry.
 *
 * Two layers, one bundle, no build step:
 *
 *   1. **Knowledge** — registers the packaged `skills/<name>/SKILL.md` bundle on
 *      `ctx.skills`, so every session on this deployment knows how to discover,
 *      evaluate and install community plugins.
 *   2. **Capability** — registers one host tool, `dsh_plugin_audit`, that checks
 *      a plugin's declared peers, imported `@deepseek-ai` packages, registered
 *      slots and inject names against the dsh build actually installed here.
 *
 * The tool is attached through `ctx.get('tools')` rather than an `inject`
 * dependency, on purpose. `inject = ['tools']` would make this whole plugin —
 * including the skill — sit in a `waiting` state on any deployment that composes
 * no `tools` service, turning an optional extra into a hard prerequisite. The
 * skill must always load; the tool degrades away quietly when it cannot exist.
 *
 * @module dsh-community-plugins
 */

import { registerSkills } from './lib/skills.js'
import { AUDIT_TOOL_NAME, createAuditTool } from './lib/tool.js'

export const name = 'dsh-community-plugins'
export const inject = ['skills']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  registerSkills(ctx)
  registerAuditTool(ctx)
}

/**
 * Register the audit tool when this deployment provides a `tools` service.
 *
 * A plain-object tool definition is used instead of `defineTool` from
 * `@deepseek-ai/dsh-tools`; see `lib/tool.js` for why.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean} whether the tool was registered.
 */
function registerAuditTool(ctx) {
  let tools
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  } catch {
    tools = undefined
  }
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return false

  const register = () => tools.register(createAuditTool(ctx))
  try {
    // `ctx.effect` ties the registration to this plugin's fiber, so unloading the
    // plugin also removes the tool. Fall back to a bare registration when the
    // context predates `effect`.
    if (typeof ctx.effect === 'function') ctx.effect(register, `dsh-community-plugins: ${AUDIT_TOOL_NAME}`)
    else register()
    return true
  } catch (error) {
    // The skill is this plugin's core value; a rejected tool registration must
    // not take it down with it.
    warn(ctx, `could not register the ${AUDIT_TOOL_NAME} tool; the skill is still available`, error)
    return false
  }
}

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
