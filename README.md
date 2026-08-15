# dsh-community-plugins

> A DeepSeek Harness (dsh) plugin that registers a global **skill** for discovering, evaluating and installing **community plugins** — from the GitHub `dsh-plugin` topic, the dshmarket GUI, and npm.

[**English**](README.md) · [**中文**](docs/lang/README_zh.md)

---

**Looking for a DeepSeek Harness plugin to install?** This bundle adds the `dsh-community-plugins` skill to every agent session: agents learn which marketplace tools are already installed (`market_search`, dshmarket), how to search the `dsh-plugin` ecosystem, how to vet a plugin before installing it, and how to install via `dsh plugin` (npm, GitHub, tarball, or `link:` development mode).

## Why this plugin

DeepSeek Harness plugins provide capabilities through two complementary mechanisms: **Tools** and **Skills**.

| | Tool (e.g. `market_search`) | Skill (registered by this plugin) |
|---|---|---|
| Nature | Capability channel: callable functions | Context knowledge: when, why, and how to call |
| Installed by | `dsh-plugin-marketplace` etc. | This plugin |
| Effect alone | Tool exists, but the agent does not recognize it | No marketplace interface to call |

Installing a marketplace tool alone is not enough. An LLM agent's behavior is driven by context knowledge:

- `web_search` has an intuitive description and is any model's default generic approach;
- `market_search` is a DSH-specific tool. Without this skill, the agent does not know it exists, does not associate it with installing plugins, and does not understand the local profile layout, the bundle mechanism, the vetting workflow, or the restart requirement.

Without this plugin, agents fall back to generic web search. With it, every new session's agent automatically knows which marketplaces and tools are installed, which structured channels to query first, how to vet sources, how to install through the official mechanism, and how to verify the result. In practice, on the same environment, agents relied on web search before the skill was active, and invoked `market_search` directly with accurate install commands on their first response afterwards.

## Features

- Registers a global skill: `dsh-community-plugins` appears in every session's `<available_skills>` catalog
- Teaches the agent to identify locally installed plugins (dshmarket, dsh-plugin-marketplace, etc.)
- Provides community plugin discovery channels: GitHub `dsh-plugin` topic, npm, dshmarket registry snapshot
- Documents the official install methods: `dsh plugin` command, GitHub direct install, tarball, `link:` development mode
- States the constraints: do not modify official shipped presets, restart required after install, build-authorization boundaries

## Install

Prerequisite: dsh CLI (or invoke `apps/cli/lib/bin.js` from the dsh install root). Choose one of the following:

```bash
# GitHub direct install (pure JS, zero dependencies, no build authorization)
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# tarball (works offline)
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.1/dsh-community-plugins-0.1.1.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.1.tgz

# source + link (development mode, edits take effect immediately)
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

**Restart dsh after installing** (bundle layers are composed at startup). Installation succeeds when `dsh-community-plugins` appears in `<available_skills>` of a new session.

> When `dsh` is not on PATH, use `node <dsh install root>/apps/cli/lib/bin.js plugin --profile web add <spec>`.

## How it works

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry: registers the `skills/` directory into the global `ctx.skills` registry |
| `cordis.patch.yml` | Bundle patch layer: the `- insert:` row mounts the plugin at profile startup |
| `skills/dsh-community-plugins/SKILL.md` | The skill body the agent reads |
| `package.json` | Declares the `dsh.bundle.patch` manifest |

Key points:

- **Pure JavaScript, zero dependencies**: GitHub direct install needs no `prepare` script or `allowBuilds` authorization (the build gate for TypeScript plugins, per the official docs)
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

## Build and release

This plugin is pure JavaScript with zero dependencies and no compilation step; both GitHub direct install and tarball require no build authorization.

```bash
# Syntax check
node --check index.js

# Package a distribution tarball (pnpm pack)
pnpm pack

# Release to GitHub Releases
# 1. Bump the version in package.json
# 2. Tag and push: git tag v<version> && git push origin v<version>
# 3. Create a Release on the GitHub Releases page and upload the tarball from pnpm pack
```

## License

MIT
