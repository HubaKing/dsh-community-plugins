# dsh-community-plugins

> A DeepSeek Harness (dsh) plugin that teaches agents how to discover, evaluate and install **community plugins** — and gives them one offline tool to check those plugins against the dsh build actually running on this machine.

[**English**](README.md) · [**中文**](docs/lang/README_zh.md)

---

This bundle adds two things to every session:

1. **A skill** (`dsh-community-plugins`) — how to find plugins through the GitHub `dsh-plugin` topic, curated indexes and npm; how to vet one before installing; how to install through the official `dsh plugin` mechanism; how to verify the result.
2. **A tool** (`dsh_plugin_audit`) — compares installed plugins against this machine's dsh build and reports, per plugin, what is broken, what is merely risky, and what could not be determined.

## Why this plugin

DeepSeek Harness provides plugin capabilities through two complementary mechanisms: **Tools** and **Skills**.

| | Tool (e.g. `market_search`) | Skill (registered by this plugin) |
|---|---|---|
| Nature | Capability channel: callable functions | Context knowledge: when, why, and how to call |
| Effect alone | Tool exists, but the agent does not recognize it | No marketplace interface to call |

A marketplace tool alone is not enough, because agent behavior is driven by context knowledge. `web_search` has an intuitive description and is any model's default approach; `market_search` is DSH-specific. Without this skill the agent does not know it exists, does not associate it with installing plugins, and does not understand the local profile layout, the bundle mechanism, the vetting workflow, or the restart requirement.

And knowledge alone is not enough either: the ecosystem's one hard practical question — *"will upgrading dsh break what I have installed?"* — cannot be answered reliably by hand, because the rc-prerelease rule below defeats eyeballing.

## Why a live probe instead of a compatibility dataset

Upstream declares the API surface unstable on purpose:

- `README.md` — **"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**
- `AGENTS.md` — **"Public APIs are pre-stable; update every consumer."**

A cached snapshot of that API surface therefore starts decaying the moment it is written. Measured here: **16 `0.x` prereleases in one month** — roughly one breaking change a week. A dataset would need continuous maintenance and would be wrong between updates, and a verification tool that is confidently wrong is worse than no tool at all.

So this plugin stores nothing. `dsh_plugin_audit` reads the dsh install root and the profile on every call and answers for *this machine, right now*. No network, no telemetry, no data to keep fresh — and when something genuinely cannot be checked offline, it says `unknown` and gives the reason instead of guessing.

This is the difference from the ~75 marketplace plugins, the 3+ static auditors already in the ecosystem, and even the official runtime inspector: those list, rank, scan for *security*, or describe what is live right now. None compare a plugin's **declared ranges and actual API usage** against **your** dsh build *before* you upgrade.

**Complementary to the official runtime inspector.** `@deepseek-ai/dsh-tool-cordis` ships `cordis_inspect_*`, which queries the live runtime exactly (`Service.listService`, `Event.listEvents`, `Tool.listTools`, and `Slots.listSubTree` for real client-side slot props). For "what does the runtime look like right now", that is strictly the better tool. This plugin answers a different question — "which installed plugin will break" — and it still works where the inspector cannot: **a plugin that failed to load is not in the live runtime, so the inspector cannot see it at all.** Static inspection reads the disk; the inspector reads the process. Both are needed.

## The audit tool

```
dsh_plugin_audit({})                                  # every third-party plugin in the profile
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # one package (name or directory)
```

Per plugin it reports:

| Check | Source of truth |
|---|---|
| `peerDependencies` ranges satisfied? | the version of each package actually on this machine, including `vendor/` |
| Imported `@deepseek-ai/*` packages still exist? | the dsh install root (`packages/`, `vendor/`, `node_modules/@deepseek-ai`) |
| Registered client slots still defined? | slot contracts extracted from official `packages/client` + `packages/core` source |
| `inject` service names resolvable? | the live Cordis context |
| Install-time risk signals? | npm lifecycle scripts, `child_process`, `eval`, remote import, network |

Verdicts are graded, not binary:

| Verdict | Meaning |
|---|---|
| `compatible` | every check this tool can perform passed |
| `at-risk` | a declared range no longer matches, though the code may still run — **the normal state of this ecosystem** |
| `incompatible` | hard evidence: a package or slot it needs is gone from this build |
| `unknown` | something needed a check that cannot be done offline; the reason is always stated |

### The rc-prerelease trap this exists to catch

`^0.1.0-rc.5` expands to `>=0.1.0-rc.5 <0.2.0-0`. Does it match `0.1.5-rc.1`?

**No.** A prerelease only satisfies a range when some comparator pins the *same* `major.minor.patch` and is itself a prerelease. The comparators are `[0,1,0]` and `[0,2,0]`; the version is `[0,1,5]`. Neither matches, so the prerelease rule rejects it.

| Range | Version | Result |
|---|---|---|
| `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ not satisfied |
| `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ not satisfied |
| `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ satisfied |
| `^0.1.0-rc.5` | `0.1.5` | ✓ satisfied |

Verified against npm's own `semver` 7.7.4. This matters because pnpm does **not** block installs on unsatisfied peers by default — so "it installed" has never meant "the range matches", and the `Issues with peer dependencies found` warning is telling the truth.

## Positioning: lightweight by design

| Property | Value |
|---|---|
| Runtime dependencies | 1 (`yaml`, used only to parse the bundle patch) |
| Build step | None — plain JavaScript, no `prepare` script, no `allowBuilds` authorization |
| Plugin form | bundle + one host tool; no `dsh.client`, no UI surface |
| Network / telemetry | None in the tool; it reads local files only |
| Tracked files | 17 (source, tests, docs) |

The tool definition is **written by hand** as a plain object rather than built with `defineTool` from `@deepseek-ai/dsh-tools`. `ctx.tools.register` only requires `{ name, description, parameters, output: { schema, render }, execute }` — a plain object cannot break when upstream renames or moves an exported symbol, which the "pre-stable" policy says will happen. The test suite proves the shape is acceptable by running it through **dsh's own `assertSupportedJsonSchema` and `validateJsonSchemaValue`**.

The tool is attached through `ctx.get('tools')` rather than `inject = ['tools']`. Declaring it as a dependency would put the whole plugin — including the skill — into a `waiting` state on any deployment that composes no `tools` service. The skill must always load; the tool degrades away quietly.

The tool declares a `timeoutMs` budget and actually honours it. That field is a promise rather than a decoration: dsh's contract states that declaring `timeoutMs` asserts the tool forwards `exec.signal` and can reach quiescence when the budget aborts. `execute` therefore passes the signal down into the scan, which re-checks it at every file boundary — an abort stops the work and surfaces as an `AbortError` instead of a silent overrun. (The budget is never sent to the model; `schemas()` whitelists only `name`, `description`, and `parameters`.)

### Neutrality

This plugin is deliberately **not a recommendation engine**. It teaches method and reports facts; it does not rank, endorse, or recommend any third-party plugin or marketplace. Candidate plugins are presented with verifiable facts (form, license, activity, known risks) and the user makes the choice. The audit tool reports compatibility, never "better".

## Install

Prerequisite: the dsh CLI (or invoke `apps/cli/lib/bin.js` from the dsh install root).

```bash
# npm (recommended: no clone, no build)
dsh plugin --profile web add @hubaking/dsh-community-plugins

# GitHub direct install (pure JS, no build scripts, no build authorization)
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee mirror (faster in mainland China)
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball (works offline)
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.2.1/dsh-community-plugins-0.2.1.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.2.1.tgz

# source + link (development mode, edits to SKILL.md take effect immediately)
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

**Restart dsh after installing** (bundle layers are composed at startup). Installation succeeds when `dsh-community-plugins` appears in `<available_skills>` and `dsh_plugin_audit` in the tool list.

> ⚠️ **Always use the `@hubaking/` scope for the npm form.** The unscoped name `dsh-community-plugins` on npm belongs to a **different project** ([`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins), TypeScript, with build scripts), so `dsh plugin add dsh-community-plugins` silently installs that other package.

> When `dsh` is not on PATH, use `node <dsh install root>/apps/cli/lib/bin.js plugin --profile web add <spec>`.

## How it works

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: registers the skill provider, then attaches the tool via `ctx.get('tools')` |
| `lib/skills.js` | Parses `skills/<name>/SKILL.md` bundles and registers them on `ctx.skills` |
| `lib/tool.js` | The hand-written tool definition and the human-readable report renderer |
| `lib/audit.js` | Locates the dsh root and profile, scans plugins, produces verdicts |
| `lib/semver.js` | Dependency-free semver matching aligned with node-semver, including prerelease rules |
| `cordis.patch.yml` | Bundle patch layer: the `- insert:` row mounts the plugin at profile startup |

## Development

```bash
npm install      # only `yaml`
npm test         # semver cross-validation + live audit + plugin contract
```

The suites are designed to be useful on any machine:

- `test/semver.test.mjs` — cross-validates `lib/semver.js` against npm's `semver` when one is reachable (930 range/version pairs and 900 ordering pairs, currently zero mismatches, plus 36 explicit assertions).
- `test/audit.test.mjs` — runs the audit against this machine's real installation and prints the report; machine-specific values are printed, never asserted.
- `test/plugin.test.mjs` — exercises the `apply` contract, all graceful-degradation paths, and validates the hand-written tool definition with dsh's own schema validators.

## Layout

```
dsh-community-plugins/
├── index.js                  # Plugin entry
├── lib/
│   ├── audit.js              # Environment probe + verdicts
│   ├── semver.js             # rc-aware range matching (no deps)
│   ├── skills.js             # SKILL.md provider
│   └── tool.js               # Tool definition + report renderer
├── test/                     # Node-native tests, no framework
├── cordis.patch.yml          # Bundle patch layer
├── package.json              # dsh.bundle manifest
├── README.md                 # English
├── docs/lang/README_zh.md    # 中文
└── skills/dsh-community-plugins/SKILL.md
```

## Modifying the skill content

Edit `skills/dsh-community-plugins/SKILL.md`; changes take effect on save (the provider re-reads from disk on every discovery), then `git push` to share. Changes to `index.js` or `lib/` require a dsh restart — `patchReload: live` re-reads `cordis.patch.yml` only and does not replace source modules.

## Related docs

- [DeepSeek Harness official repository](https://github.com/deepseek-ai/deepseek-harness)
- [Official docs (English)](https://deepseek-harness.github.io/deepseek-harness/en/)
- [Official docs (简体中文)](https://deepseek-harness.github.io/deepseek-harness/)
- [Packaging and installing plugins](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [Plugins and lifecycle](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
- [GitHub `dsh-plugin` topic](https://github.com/topics/dsh-plugin)

## License

MIT
