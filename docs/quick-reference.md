# dsh-community-plugins — Quick Reference / 速查表

> One page for the common commands. Full guide: [README](../README.md) (EN) / [中文](../docs/lang/README_zh.md)

## Discover / 查找插件

| Task | Command / Channel |
|---|---|
| Search GitHub `dsh-plugin` topic | `market_search` tool, or `https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars` |
| Browse curated snapshot | `${DSH_HOME:-~/.dsh}/profiles/web/node_modules/dshmarket/data/registry-snapshot.json` |
| Check npm | `npm view <package>` |
| web_search blocked? | Use Node https (`node -e` with `https.get`) or npm registry |

## Install / 安装插件

```bash
# dsh CLI on PATH
dsh plugin --profile web add <spec>
# dsh CLI NOT on PATH
node <dsh-install-root>/apps/cli/lib/bin.js plugin --profile web add <spec>
```

`<spec>`: npm package name | `github:owner/repo` | local path / `link:` | tarball

**Form detection / 形态判断**:

| Manifest | Kind | Mount | Restart |
|---|---|---|---|
| `dsh.bundle.patch` | bundle | auto → `dsh.profile.bundles` | **required** |
| `dsh.client` only | client-only | dshmarket hot-mount (if installed) | maybe |
| neither | plain cordis plugin | profile `cordis.patch.yml` `- insert:` | usually not |

## Vet / 安装前评估（危险信号）

Stop and confirm with the user when any of:

- `install` / `postinstall` / `preinstall` scripts
- `child_process` / `spawn` / `exec` in source
- Network calls that **send** data (`fetch`/`http`/`https`/`WebSocket`)
- Writes outside cache dirs (home / profile / sensitive paths)
- Obfuscated code, `eval` / `Function` / remote dynamic import
- Missing or non-permissive license (GPL/AGPL/unknown)

## Verify / 安装后验证

1. `${DSH_HOME:-~/.dsh}/profiles/web/package.json` `dsh.profile.bundles` contains the name
2. After restart: skill in `<available_skills>`, tool in tool list, UI in settings

## Gotchas / 坑位速查

| Symptom | Fix |
|---|---|
| Windows: no persistent bash | use pwsh / Git Bash |
| `schannel: SEC_E_NO_CREDENTIALS` | `git config --global http.sslBackend openssl` |
| curl/git blocked | Node https / npm registry / web_search |
| fine-grained PAT 403 on repo create/delete | use the web UI |
| npm publish blocked by 2FA | bypass-2FA token or OTP |
| git install: TS plugin has no `lib/` | needs `prepare` + `allowBuilds` |
| installed but not working | restart dsh (bundle layers compose at startup) |

## This plugin / 本插件

```bash
# install this skill plugin
dsh plugin --profile web add github:HubaKing/dsh-community-plugins
# or tarball
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.0/dsh-community-plugins-0.1.0.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.0.tgz
```
