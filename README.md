# dsh-community-plugins

> A DeepSeek Harness (dsh) plugin that registers a global **skill** teaching agents how to discover, evaluate and install **community plugins** — from the GitHub `dsh-plugin` topic, directory indexes, and npm.

[**English**](README.md) · [**中文**](docs/lang/README_zh.md)

---

This bundle adds the `dsh-community-plugins` skill to every agent session: agents learn what is actually installed on this machine, how to search the `dsh-plugin` ecosystem, how to vet a plugin before installing it, and how to install through the official `dsh plugin` mechanism (npm, GitHub, tarball, or `link:` development mode).

## Why this plugin

DeepSeek Harness provides plugin capabilities through two complementary mechanisms: **Tools** and **Skills**.

| | Tool (e.g. `market_search`) | Skill (registered by this plugin) |
|---|---|---|
| Nature | Capability channel: callable functions | Context knowledge: when, why, and how to call |
| Installed by | A marketplace plugin | This plugin |
| Effect alone | Tool exists, but the agent does not recognize it | No marketplace interface to call |

Installing a marketplace tool alone is not enough, because agent behavior is driven by context knowledge:

- `web_search` has an intuitive description and is any model's default generic approach.
- `market_search` is a DSH-specific tool. Without this skill, the agent does not know it exists, does not associate it with installing plugins, and does not understand the local profile layout, the bundle mechanism, the vetting workflow, or the restart requirement.

Without this plugin, agents fall back to generic web search. With it, every new session knows which tools are installed, which structured channels to query, how to vet sources, how to install through the official mechanism, and how to verify the result.

## Positioning: lightweight by design

This is a **knowledge-only** plugin. It ships no runtime service, no client bundle, and no build step.

| Property | Value |
|---|---|
| Runtime dependencies | 1 (`yaml`, used only to parse the bundle patch) |
| Build step | None — plain JavaScript, no `prepare` script, no `allowBuilds` authorization |
| Plugin form | bundle only (`dsh.bundle.patch`); no `dsh.client`, no UI surface |
| Tracked files | 9 |
| Repository size | ~49 KB |

Because it is a single bundle layer with no client half, installing it does not add a UI, does not touch the model or request path, and does not require build authorization — the gate TypeScript plugins hit.

### Neutrality

This skill is deliberately **not a recommendation engine**. It teaches method and reports facts; it does not rank, endorse, or recommend any third-party plugin or marketplace. Candidate plugins are presented with verifiable facts (form, license, activity, known risks) and the user makes the choice.

## Features

- Registers a global skill: `dsh-community-plugins` appears in every session's `<available_skills>` catalog
- Teaches the agent to verify what is actually installed on this machine (read the profile manifest; never assume)
- Provides neutral discovery channels: installed tooling, directory/index sources, GitHub `dsh-plugin` topic search, npm
- Prevents the **repo-name ≠ npm-package-name** trap: read the real package name from `package.json` before querying npm (a wrong name yields a false 404 and a wrong "not published" verdict)
- Tells the agent not to trust GitHub's license badge: cross-check the `LICENSE` text against the npm `license` field instead
- Covers API-compatibility checking for third-party plugins: where local `@deepseek-ai/*` versions resolve from, rc-prerelease semver semantics, and verifying that the APIs a plugin calls still exist
- Flags repository-shipped installers (`install.sh` / `install.ps1`) separately from npm lifecycle scripts: they bypass `dsh plugin` dependency management, so the npm form is preferred
- Documents the official install methods plus speed-ups: `dsh plugin` usage, npm-first, batch installs, and hot-mount vs restart by plugin form
- Documents the pnpm supply-chain policy (`minimumReleaseAge`) and its workarounds
- States the constraints: no modification of official shipped presets, restart rules, build-authorization boundaries

## Install

Prerequisite: the dsh CLI (or invoke `apps/cli/lib/bin.js` from the dsh install root). Choose one of the following:

```bash
# GitHub direct install (pure JS, no build scripts, no build authorization)
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee mirror (faster in mainland China)
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball (works offline)
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.6/dsh-community-plugins-0.1.6.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.6.tgz

# source + link (development mode, edits take effect immediately)
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

**Restart dsh after installing** (bundle layers are composed at startup). Installation succeeds when `dsh-community-plugins` appears in `<available_skills>` of a new session.

> ⚠️ **Do not install this via npm.** The name `dsh-community-plugins` on npm belongs to a **different project** ([`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins), TypeScript, with build scripts). This repository is distributed only through GitHub, the release tarball, or `link:` — installing `dsh plugin add dsh-community-plugins` silently gets you that other package. Use the `github:` form above.

> When `dsh` is not on PATH, use `node <dsh install root>/apps/cli/lib/bin.js plugin --profile web add <spec>`.

## How it works

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: registers the `skills/` directory into the global `ctx.skills` registry |
| `cordis.patch.yml` | Bundle patch layer: the `- insert:` row mounts the plugin at profile startup |
| `skills/dsh-community-plugins/SKILL.md` | The skill body the agent reads |
| `package.json` | Declares the `dsh.bundle.patch` manifest |

Key points:

- **Plain JavaScript, no build scripts**: single dependency `yaml`; GitHub direct install needs no `prepare` script or `allowBuilds` authorization (the build gate for TypeScript plugins, per the official docs)
- **Hot update**: `index.js` re-reads from disk on every discovery; editing `SKILL.md` requires no restart or reinstall
- **Official plugin shape**: function form `export const name` + `export function apply(ctx)` + `dsh.bundle` manifest

## Modifying the skill content

Edit `skills/dsh-community-plugins/SKILL.md`; changes take effect on save, then `git push` to share with other users.

## Layout

```
dsh-community-plugins/
├── index.js              # Plugin entry (skill registration)
├── cordis.patch.yml      # Bundle patch layer
├── package.json          # dsh.bundle manifest
├── README.md             # English
├── docs/
│   └── lang/
│       └── README_zh.md  # 中文
└── skills/
    └── dsh-community-plugins/
        └── SKILL.md      # The guide read by agents
```

## Related docs

- [DeepSeek Harness official repository](https://github.com/deepseek-ai/deepseek-harness)
- [Official docs (English)](https://deepseek-harness.github.io/deepseek-harness/en/)
- [Official docs (简体中文)](https://deepseek-harness.github.io/deepseek-harness/)
- [Quickstart (Web UI)](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
- [First plugin](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) — plugin shape, `apply`/`inject`, lifecycle
- [Packaging and installing plugins](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) — bundle manifest, profile install, build authorization
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config) — Config/Schema conventions
- [Plugins and lifecycle](https://deepseek-harness.github.io/deepseek-harness/develop/framework/) — Fiber state machine and automatic cleanup
- [Event system](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events) — event modes and naming conventions
- [Run from source (root README)](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#run-from-source) — build and launch from source
- [Source execution (CLI reference)](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#source-execution) — build and launcher behavior
- [GitHub `dsh-plugin` topic](https://github.com/topics/dsh-plugin) — community plugin aggregation

## License

MIT
