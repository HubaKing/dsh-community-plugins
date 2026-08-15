---
name: dsh-community-plugins
description: 本 DeepSeek Harness 已内置社区插件生态——发现社区插件（GitHub dsh-plugin topic、dshmarket 市场）、评估并安装它们（dsh plugin 命令、bundle 配置、dshmarket UI）。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/skills for this harness, or asks what community plugins exist.
---

# DSH 社区插件：发现与安装

本 Harness 运行的是 DeepSeek Harness（dsh），社区插件生态围绕 GitHub 的 `dsh-plugin` 话题（1800+ 仓库）和 npm 上的 `dsh-*` 包展开。本机**可能已经安装了插件市场**，动手前先确认现状，不要假装不知道。

## 先看本机装了什么（profiles/web bundle）

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出当前生效的 bundle 层；`node_modules` 里是已下载的包。常见成员：

- `dshmarket`（npm）— **可视化插件市场**：浏览器 UI 逛市场、一键安装社区插件；注册了 `/dsh-market/*` HTTP 路由和 Client 市场面板
- `dsh-plugin-marketplace`（github:AwesomeHou/dsh-plugin-marketplace）— **插件市场 + agent 工具**：注册 `market_search`/`market_install`/`market_installed`/`market_update` 四个模型工具，可直接在对话里搜索 GitHub dsh-plugin 话题并安装插件；附带 Web 设置页「插件市场」面板
- `dsh-community-plugins`（本 skill 的宿主插件包）— 注册 `dsh-community-plugins` skill 到全局
- `dsh-design-skills`（github:zhaiyateng/dsh-design-skills）— 设计美学 skill 包（apple-minimal、dark-saas、brutalism 等），通过 `ctx.skills.registerProvider` 注册为全局 skill
- `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` — 官方宿主基础与 Web 应用

**如果本机没有安装任何市场插件**：用下面的「安装本 skill 插件」一节装好本插件，或让用户装 `dshmarket`。

## 查找社区插件

1. **dshmarket 市场**（推荐入口）：浏览器 GUI 有市场面板（dshmarket 的 Client UI），可搜索、分页浏览、一键安装。数据源快照在 `${DSH_HOME:-~/.dsh}/profiles/web/node_modules/dshmarket/data/registry-snapshot.json`（数百个精选插件，含 name/owner/url/category/description/install 命令）。
2. **模型工具 `market_search`**（若 `dsh-plugin-marketplace` 已生效）：直接搜索 GitHub dsh-plugin 话题，返回 JSON 列表。
3. **GitHub dsh-plugin 话题**：`https://github.com/topics/dsh-plugin`。通过 web_search 或 API 查询：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
   ```
   注意：部分机器 shell 直接访问外网被网络策略阻断（curl/git 均失败），但 **Node.js https 通道通常可用**（`node -e "..."` 里用 https.get 访问 api.github.com 可通），npm registry 也可达。web_search 工具是最可靠的发现途径。
4. **npm**：`npm view <包名>` 查发布情况（registry.npmjs.org 可达）。

## 安装插件

社区插件的标准形态是 **npm 包或 GitHub 仓库**，通过 bundle patch 机制挂载：

- **npm 包**：`npm view <name>` 确认后，在 `${DSH_HOME:-~/.dsh}/profiles/web/` 下执行 `pnpm add <name>`（或 `npm install <name>`），然后把包名加进 `package.json` 的 `dsh.profile.bundles` 数组，并确认包内 `cordis.patch.yml` 的 `insert` 行会被 bundle 层应用（见下）。
- **GitHub 仓库**：`github:owner/repo` 规范，同样装进 profiles/web。
- **GUI 一键安装**：用户可在 dshmarket 市场面板点安装，无需手动改配置。
- **模型工具 `market_install`**：若 `dsh-plugin-marketplace` 已生效，可直接在对话中调用。

**bundle 机制说明**：每个插件包的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，其 `- insert:` 行在 profile 启动时插入该插件的 loader 条目。插件安装后**需要重启 dsh 进程**（或 HMR 重载）才生效。

**dsh CLI 入口**：`dsh` 可能不在 PATH，可从安装根调用（路径因部署而异，用 glob/grep 找 `apps/cli/lib/bin.js` 或全局安装的 dsh）：`node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`（dsh 内部转发 pnpm 管理 profile 依赖）。注意：这个命令会把包加进 `package.json` 的 `dependencies`，但只有带 `dsh.bundle` 的包才会自动进 `bundles` 数组成为 profile 层；client-only 包（只有 `dsh.client`）由 dshmarket 启动时热挂载。

## 安装本 skill 插件（首次使用）

本 skill 由 `dsh-community-plugins` 插件包提供。若当前会话能读到本 skill，说明它已安装；否则：

1. 把仓库 clone 或下载到用户根：`${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`
2. 安装进 web profile：`node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add link:<上面目录的绝对路径>`
3. 重启 dsh（bundle 层在启动时组合）

## 安装后验证

1. 确认包已出现在 `profiles/web/node_modules`；
2. 确认 `package.json` 的 bundles 数组包含包名；
3. 重启后检查插件是否生效（其注册的 skill 会出现在 `<available_skills>`，工具会出现在工具列表，UI 会出现在设置面板）。

## 约束

- **不要修改官方 shipped preset**（部署自带的 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设。
- 安装第三方插件前先看包内容（package.json、cordis.patch.yml、main 入口），确认来源可信、许可证宽松（MIT/Apache 等）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件的源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或安装时的克隆位置）：改 `skills\dsh-community-plugins\SKILL.md` 即可更新本指南，无需重装（`index.js` 每次发现时从磁盘重读，热更新无需重启）。
