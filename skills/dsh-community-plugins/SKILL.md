---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现社区插件（GitHub dsh-plugin topic、dshmarket 市场、npm）、评估并安装它们（dsh plugin 命令、bundle 机制、tarball、GUI）。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/skills for this harness, or asks what community plugins exist.
---

# DSH 社区插件：发现、评估与安装

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题（3300+ 仓库）和 npm 上的 `dsh-*` 包展开。本机**可能已安装插件市场**——动手前先确认现状。

## 1. 先看本机已装什么

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出生效的 bundle 层；`node_modules` 是已下载的包。常见成员：

- `dshmarket`（npm）— 可视化插件市场：GUI 逛市场、一键安装；注册 `/dsh-market/*` HTTP 路由 + Client 面板
- `dsh-plugin-marketplace`（github:AwesomeHou/dsh-plugin-marketplace）— 插件市场 + agent 工具：`market_search` / `market_install` / `market_installed` / `market_update`
- `dsh-community-plugins`（本插件）— 注册本 skill 到全局
- `dsh-design-skills`（github:zhaiyateng/dsh-design-skills）— 设计美学 skill 包
- `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` — 官方宿主基础与 Web 应用

若本机没有市场插件：先装本插件（见第 4 节），或让用户装 `dshmarket`。

## 2. 查找社区插件

按可靠性排序：

1. **`market_search` 工具**（若 `dsh-plugin-marketplace` 已生效）：直接搜 GitHub `dsh-plugin` 话题，返回 JSON 列表（name/stars/language/description/url）。
2. **dshmarket 市场快照**：`${DSH_HOME:-~/.dsh}/profiles/web/node_modules/dshmarket/data/registry-snapshot.json`（数百个精选插件：name/owner/url/category/description/install 命令）。
3. **GitHub API**（web_search 不可用时）：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
   ```
   注意：部分机器 shell 直连外网被阻断（curl/git 失败），但 **Node.js https 通道通常可用**（`node -e` 内 `https.get` 可通 api.github.com），npm registry 也可达。
4. **npm**：`npm view <包名>` 查发布情况。

## 3. 评估插件

安装前检查包内容：

- `package.json` — 名称、`dsh.bundle`/`dsh.client` manifest、许可证（宽松：MIT/Apache/BSD）
- `cordis.patch.yml` — 插入哪些行、注册什么
- main 入口源码 — 是否执行网络请求/子进程等可疑行为

## 4. 安装插件

标准形态是 **npm 包或 GitHub 仓库**，通过 bundle patch 挂载：

```bash
# 安装（dsh CLI 不在 PATH 时用 node 调 <dsh 根>/apps/cli/lib/bin.js）
dsh plugin --profile web add <spec>
# spec 可以是：npm 包名 | github:owner/repo | 本地路径/链接 | tarball
```

**机制**：包的 `dsh.bundle.patch` → 包内 `cordis.patch.yml` → `- insert:` 行在 profile 启动时插入 loader 条目。装完**必须重启 dsh** 才生效（bundle 层在启动时组合；HMR 只热重载用户 patch 层，不重载 bundle 层）。

**注意**：`dsh plugin add` 把包加入 `dependencies`，只有带 `dsh.bundle` 的包自动进 `bundles` 数组成为 profile 层；client-only 包（只有 `dsh.client`）由 dshmarket 启动时热挂载。

**GitHub 直装与构建**：git 安装拉源码不跑构建。TypeScript 包需要 `prepare` 脚本 + pnpm `allowBuilds` 授权（用户必须显式允许，见官方文档）；纯 JS 零依赖包（如本插件）无需任何授权。

## 5. 安装本插件（首次使用）

本 skill 由 `dsh-community-plugins` 插件提供。能读到本 skill 说明已安装；否则：

```bash
# 方式 A：GitHub 直装
dsh plugin --profile web add github:HubaKing/dsh-community-plugins
# 方式 B：tarball
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.0/dsh-community-plugins-0.1.0.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.0.tgz
```

装完重启 dsh，新会话 `<available_skills>` 出现本 skill 即成功。

## 6. 安装后验证

1. `profiles/web/package.json` 的 `bundles` 数组含包名
2. 重启后：skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板

## 7. 约束与边界

- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（`index.js` 每次发现从磁盘重读），无需重装。
