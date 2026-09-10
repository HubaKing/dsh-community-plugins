# dsh-community-plugins

> A DeepSeek Harness (dsh) plugin that teaches agents how to discover, evaluate and install **community plugins** — and gives them two tools to check those plugins against the dsh build actually running on this machine: one that stays offline, and one that fetches a package *before* it is installed.

[**English**](README.md) · [**中文**](docs/lang/README_zh.md)

---

This bundle adds three things to every session:

1. **A skill** (`dsh-community-plugins`) — how to find plugins through the GitHub `dsh-plugin` topic, curated indexes and npm; how to vet one before installing; how to install through the official `dsh plugin` mechanism; how to verify the result.
2. **An offline tool** (`dsh_plugin_audit`) — compares **installed** plugins against this machine's dsh build and reports, per plugin, what is broken, what is merely risky, and what could not be determined. It fetches nothing.
3. **A networked tool** (`dsh_plugin_inspect`) — downloads a package's published tarball, verifies it against the registry's published hash, unpacks it into a temporary directory, and judges it **before** it is installed. It never installs anything and never runs the package's lifecycle scripts.

The two tools are separate on purpose. The audit's promise is that it touches no network; a flag that sometimes made it fetch would make the promise conditional, and a conditional promise is not one. Two tools, two guarantees, and each says which one it is.

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

So this plugin stores nothing. `dsh_plugin_audit` reads the dsh install root and the profile on every call and answers for *this machine, right now*; `dsh_plugin_inspect` reads the tarball it just downloaded and answers against that same build. No telemetry, no cache, no data to keep fresh — and when something genuinely cannot be checked, both say `unknown` and give the reason instead of guessing.

This is the difference from the ~75 marketplace plugins, the 3+ static auditors already in the ecosystem, and even the official runtime inspector: those list, rank, scan for *security*, or describe what is live right now. None compare a plugin's **declared ranges and actual API usage** against **your** dsh build, and none can do it for a plugin that is not installed yet.

**Complementary to the official runtime inspector.** `@deepseek-ai/dsh-tool-cordis` ships `cordis_inspect_*`, which queries the live runtime exactly (`Service.listService`, `Event.listEvents`, `Tool.listTools`, and `Slots.listSubTree` for real client-side slot props). For "what does the runtime look like right now", that is strictly the better tool. This plugin answers a different question — "do the declarations on disk still line up with the build installed here" — and it still works where the inspector cannot: **a plugin that failed to load is not in the live runtime, so the inspector cannot see it at all.** Static inspection reads the disk; the inspector reads the process. Both are needed.

Neither predicts a future upgrade. Both only ever see the build installed on this machine; the honest answer to "what will break after I upgrade" is to run them again after upgrading.

## The offline audit tool

```
dsh_plugin_audit({})                                  # every third-party plugin in the profile
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # one package (name or directory)
```

Per plugin it reports:

| Check | Source of truth |
|---|---|
| **Can its bundle layer be mounted?** | whether `dsh.bundle.patch` exists on disk, and whether the package is named in `dsh.profile.bundles` |
| `peerDependencies` ranges satisfied? | the version of each package actually on this machine, including `vendor/` |
| Imported `@deepseek-ai/*` packages still exist? | the dsh install root (`packages/`, `vendor/`, `node_modules/@deepseek-ai`) |
| **Are the named exports those imports need still exported?** | the package's declaration entry, walked through `export *` re-exports, unioned with its runtime entry |
| Registered client slots still defined? | slot contracts extracted from official `packages/client` + `packages/core` source |
| `inject` service names resolvable? | the live Cordis context |
| Install-time risk signals? | npm lifecycle scripts, `child_process`, `eval`, remote import, network |

Verdicts are graded, not binary:

| Verdict | Meaning |
|---|---|
| `compatible` | every check this tool can perform passed |
| `at-risk` | a declared range no longer matches or its layer is not composed in, though the code may still run — **the normal state of this ecosystem** |
| `incompatible` | hard evidence: a package, export or slot it needs is gone from this build, or its bundle layer cannot be mounted |
| `unknown` | something needed a check that cannot be done offline; the reason is always stated |

### Symbol-level checking, and why "the package still exists" is not enough

A plugin that does `import { PiAiAdapter } from '@deepseek-ai/dsh-llm'` keeps working only while that package still *exports* `PiAiAdapter`. A rename or a split leaves the package in place and the binding gone — and an ESM named import of a binding the module does not provide is a **link-time throw**, not a degraded feature.

Confirming that is harder than grepping one file, because a package's export surface is a graph. Official declarations are barrels, and TypeScript emits the source extension:

```ts
export * from './attribution.ts';          // the file shipped beside it is attribution.d.ts
export { BlockAssembler } from './assembler.ts';
```

A single-file scan reports every re-exported symbol as missing. So the check walks the graph — relative specifiers, the `.ts`/`.js` → `.d.ts` mapping, bare specifiers into other packages — and keeps two things strictly apart:

- the set of symbols it **confirmed**, and
- whether that set is **complete**.

Only a complete graph licenses the word *removed*. An incomplete one yields `unknown`, because "I could not resolve it" is not "it is gone". The declared-type surface is unioned with the runtime entry's own export list, so a stale declaration cannot manufacture a failure.

Validated on this machine (**2026-09**, dsh `0.1.5-rc.1`): **279 official packages inspected, 276 declaration graphs resolved completely, 1,874 runtime export names checked, 0 unconfirmed.** The three incomplete graphs are reported as `unknown`, never as removals. The suite re-runs this sweep on whatever machine it is run on.

### A bad plugin can stop dsh from booting

This is why the layer check comes first. Three of these throw rather than degrade, so the whole profile fails to start:

| Situation | Upstream behaviour |
|---|---|
| Declares `dsh.bundle.patch` but the package does not contain that file | `failed to read overlay` — throws (`packages/boot/app-boot/src/index.ts:315-323`) |
| Declares `dsh.bundle` with no `patch` path | `declares no dsh.bundle` — throws (`packages/boot/app-boot/src/profile.ts:792-797`) |
| `dsh.profile.bundles` names a package that cannot be resolved | layer resolution fails — throws (same file) |

And one that fails **silently**: a readable patch whose package is not in `dsh.profile.bundles` — the layer is never applied, so the plugin does nothing at all. The usual cause is installing with `pnpm add` inside the profile instead of `dsh plugin add`, which is what reconciles that list (`apps/cli/src/plugin.ts:59-91`).

The tool prints one `layer …` line per plugin and raises the rest as blockers, so you can see all of this **before restarting dsh**. These particular judgements are exact — they read `package.json` and the filesystem, not source heuristics.

### The rc-prerelease trap this exists to catch

`^0.1.0-rc.5` expands to `>=0.1.0-rc.5 <0.2.0-0`. Does it match `0.1.5-rc.1`?

**No.** A prerelease only satisfies a range when some comparator pins the *same* `major.minor.patch` and is itself a prerelease. The comparators are `[0,1,0]` and `[0,2,0]`; the version is `[0,1,5]`. Neither matches, so the prerelease rule rejects it.

| Range | Version | Result |
|---|---|---|
| `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ not satisfied |
| `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ not satisfied |
| `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ satisfied |
| `^0.1.0-rc.5` | `0.1.5` | ✓ satisfied |

Verified against npm's own `semver`. This matters because pnpm does **not** block installs on unsatisfied peers by default — so "it installed" has never meant "the range matches", and the `Issues with peer dependencies found` warning is telling the truth.

## The pre-install tool

```
dsh_plugin_inspect({ spec: 'dsh-llm-local-token' })          # npm, latest
dsh_plugin_inspect({ spec: '@scope/pkg@^1.2' })              # npm, a range
dsh_plugin_inspect({ spec: 'github:owner/repo#v1.2.0' })     # a repository
dsh_plugin_inspect({ spec: 'https://host/pkg.tgz' })         # a tarball URL
```

**This is the only part of the plugin that uses the network, and it says so in its own name, its description, and its output.** What it does:

| Step | Detail |
|---|---|
| Resolve | reads the registry document and picks one concrete version, so the report can state *which* version it judged |
| Download | streams the tarball with a 64 MiB ceiling |
| Verify | checks the registry's published `integrity` (`sha512`/`sha384`/`sha256`) or `shasum` before unpacking — a mismatch aborts the audit |
| Unpack | into an `mkdtemp` directory, then deletes it on every exit path |
| Judge | the same verdict engine as the offline audit, run against the same local dsh build |

What it does **not** do: install anything, write to the profile, or run the package's lifecycle scripts. A `postinstall` hook is reported as a high-severity finding, not obeyed.

Because it handles bytes nobody in this repository produced, the extractor is hand-written and hardened rather than pulled in:

| Attack | Behaviour |
|---|---|
| `../escape.txt`, `package/../../escape.txt` | refused and reported |
| `/absolute.txt`, `C:\…` | refused and reported |
| symlink / hardlink entries | skipped, never created — so a later entry cannot be written through the link |
| a header that overstates its size | the reader stops instead of reading past the end |
| a decompression bomb | per-file, total-size, and entry-count caps stop it loudly |

The report also flags install-time risk, including the class `SKILL.md` warns about: a repo-provided `install.sh` / `setup.ps1` that edits the profile directly and links the package into `node_modules` by hand, bypassing `dsh plugin`'s dependency management — after which `dsh plugin update` and `remove` no longer manage it.

## Positioning: lightweight by design

| Property | Value |
|---|---|
| Runtime dependencies | 1 (`yaml`, used only to parse the bundle patch) — the tar reader is hand-written rather than a dependency |
| Build step | None — plain JavaScript, no `prepare` script, no `allowBuilds` authorization |
| Plugin form | bundle + two host tools; no `dsh.client`, no UI surface |
| Network / telemetry | `dsh_plugin_audit`: none, reads local files only. `dsh_plugin_inspect`: read-only GETs, only when called; no telemetry, no credentials |

The tool definitions are **written by hand** as plain objects rather than built with `defineTool` from `@deepseek-ai/dsh-tools`. `ctx.tools.register` only requires `{ name, description, parameters, output: { schema, render }, execute }` — a plain object cannot break when upstream renames or moves an exported symbol, which the "pre-stable" policy says will happen. The test suite proves both shapes are acceptable by running them through **dsh's own `assertSupportedJsonSchema` and `validateJsonSchemaValue`**.

Both tools are attached through `ctx.get('tools')` rather than `inject = ['tools']`. Declaring it as a dependency would put the whole plugin — including the skill — into a `waiting` state on any deployment that composes no `tools` service. The skill must always load; the tools degrade away quietly, and one rejected registration does not take the other tool down with it.

Both declare a `timeoutMs` budget and actually honour it. That field is a promise rather than a decoration: dsh's contract states that declaring `timeoutMs` asserts the tool forwards `exec.signal` and can reach quiescence when the budget aborts. `execute` therefore passes the signal down into the scan and into the download, and an abort surfaces as an `AbortError` instead of a silent overrun. (The budget is never sent to the model; `schemas()` whitelists only `name`, `description`, and `parameters`.)

### Neutrality

This plugin is deliberately **not a recommendation engine**. It teaches method and reports facts; it does not rank, endorse, or recommend any third-party plugin or marketplace. Candidate plugins are presented with verifiable facts (form, license, activity, known risks) and the user makes the choice. The tools report compatibility, never "better".

## Install

Prerequisite: the dsh CLI (or invoke `apps/cli/lib/bin.js` from the dsh install root).

```bash
# GitHub direct install (pure JS, no build scripts, no build authorization)
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee mirror (faster in mainland China)
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball (works offline)
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.4.0/hubaking-dsh-community-plugins-0.4.0.tgz
dsh plugin --profile web add ./hubaking-dsh-community-plugins-0.4.0.tgz

# source + link (development mode, edits to SKILL.md take effect immediately)
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

> ⚠️ **Always use the `@hubaking/` scope for the npm form.** The unscoped name `dsh-community-plugins` on npm belongs to a **different project** ([`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins), TypeScript, with build scripts), so `dsh plugin add dsh-community-plugins` silently installs that other package.
>
> ⚠️ **The scoped package is not on npm yet.** `dsh plugin add @hubaking/dsh-community-plugins` returns 404 as of 2026-09; the release workflow publishes it on a `v*` tag once `NPM_TOKEN` is configured. Use one of the forms above until then.

**Restart dsh after installing** (bundle layers are composed at startup). Installation succeeded when `dsh-community-plugins` appears in `<available_skills>` and both `dsh_plugin_audit` and `dsh_plugin_inspect` appear in the tool list.

> When `dsh` is not on PATH, use `node <dsh install root>/apps/cli/lib/bin.js plugin --profile web add <spec>`.

## How it works

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: registers the skill provider, then attaches both tools via `ctx.get('tools')` |
| `lib/skills.js` | Parses `skills/<name>/SKILL.md` bundles and registers them on `ctx.skills` |
| `lib/tool.js` | The offline tool definition and the human-readable report renderer |
| `lib/inspect-tool.js` | The networked tool definition and its renderer |
| `lib/audit.js` | Locates the dsh root and profile, scans plugins, produces verdicts |
| `lib/symbols.js` | Walks declaration graphs through `export *` barrels to confirm named exports |
| `lib/semver.js` | Dependency-free semver matching aligned with node-semver, including prerelease rules |
| `lib/registry.js` | Registry/repository resolution, integrity verification, capped downloads |
| `lib/inspect.js` | Fetches, unpacks and judges a not-yet-installed package, then deletes the temporary tree |
| `lib/tar.js` | Hand-written hardened tar reader: traversal, link entries and bombs are refused |
| `cordis.patch.yml` | Bundle patch layer: the `- insert:` row mounts the plugin at profile startup |

## Development

```bash
npm install      # only `yaml`
npm test         # semver + symbols + live audit + fixtures + tar + pre-install + contract + integration
```

The suites are designed to be useful on any machine:

- `test/semver.test.mjs` — cross-validates `lib/semver.js` against npm's `semver` when one is reachable (930 range/version pairs and 900 ordering pairs, currently zero mismatches, plus explicit assertions).
- `test/symbols.test.mjs` — the export-graph resolver against synthetic packages: `.ts`-suffixed `export *`, aliased re-exports, private classes in a barrel, unresolvable graphs, and the import forms that used to be mis-attributed.
- `test/audit.test.mjs` — runs the audit against this machine's real installation and prints the report; machine-specific values are printed, never asserted. It also re-runs the whole export-surface sweep described above as a self-consistency oracle.
- `test/fixtures.test.mjs` + `test/fixtures.mjs` — builds synthetic dsh homes in a temp directory (profile, installed plugins, fallback, optional source tree) and asserts exact verdicts, including every boot-failure path and every symbol-check outcome.
- `test/tar.test.mjs` — the extractor against archives it is not supposed to accept.
- `test/inspect.test.mjs` — the pre-install tool end to end against a **local HTTP server**, not npm: version selection, integrity verification, refusal of traversal and link entries, temp-directory cleanup, and the "nothing was installed" guarantee.
- `test/plugin.test.mjs` — exercises the `apply` contract, all graceful-degradation paths, and validates both hand-written tool definitions with dsh's own schema validators.
- `test/integration.test.mjs` — loads the plugin through a real Cordis `Context` and a real `ToolRuntime`, then checks that both tools are actually visible to the model and disposed on unload.

## Layout

```
dsh-community-plugins/
├── index.js                  # Plugin entry
├── lib/
│   ├── audit.js              # Environment probe + verdicts
│   ├── semver.js             # rc-aware range matching (no deps)
│   ├── skills.js             # SKILL.md provider
│   ├── symbols.js            # Export-graph resolution
│   ├── tool.js               # Offline tool + renderer
│   ├── registry.js           # Registry access + integrity
│   ├── inspect.js            # Pre-install audit
│   ├── inspect-tool.js       # Networked tool + renderer
│   └── tar.js                # Hardened tar reader
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
