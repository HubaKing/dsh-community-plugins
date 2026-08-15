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

若本机没有市场插件：先装本插件（见第 5 节），或让用户装 `dshmarket`。

## 2. 查找社区插件

先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）——分类搜索命中更准。

按可靠性排序：

1. **`market_search` 工具**（若 `dsh-plugin-marketplace` 已生效）：直接搜 GitHub `dsh-plugin` 话题，返回 JSON 列表（name/stars/language/description/url）。
2. **dshmarket 市场快照**：`${DSH_HOME:-~/.dsh}/profiles/web/node_modules/dshmarket/data/registry-snapshot.json`（数百个精选插件：name/owner/url/category/description/install 命令）。
3. **GitHub API**（web_search 不可用时）：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
   ```
   注意：部分机器 shell 直连外网被阻断（curl/git 失败），但 **Node.js https 通道通常可用**（`node -e` 内 `https.get` 可通 api.github.com），npm registry 也可达。
4. **npm**：`npm view <包名>` 查发布情况。

## 3. 评估插件（安装前必做）

安装前检查包内容；**命中危险信号时停下，向用户确认后再继续**：

- `package.json` — 名称、`dsh.bundle` / `dsh.client` manifest、许可证（宽松：MIT/Apache/BSD；GPL/AGPL/未知许可证需提示）
- `cordis.patch.yml` — 插入哪些行、注册什么
- main 入口源码 — 是否执行网络请求/子进程等可疑行为
- **活跃度** — stars 数量与最近提交时间（GitHub API 的 `pushed_at`）：停更超一年且 star 少的项目谨慎采用

**危险信号清单**（任一命中 → 停下确认）：

- `install` / `postinstall` / `preinstall` 脚本（npm 包安装时会执行）
- 源码中出现 `child_process` / `spawn` / `exec`（运行外部命令）
- 源码中出现网络请求（`fetch` / `http` / `https` / `WebSocket`），特别是**发送数据**而非仅读取
- 源码写入非缓存目录（如主目录、profile 目录外的敏感路径）
- 代码被混淆/压缩到不可读，或从远程加载并执行代码（`eval` / `Function` / 动态 import 远程 URL）
- 许可证缺失或非宽松协议

确认时说明发现的具体信号与风险，由用户决定是否继续。

## 4. 安装插件

机制依据官方文档（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)）。先**判断安装形态**（决定怎么挂载与是否需重启）：

1. **bundle 插件**（`package.json` 有 `dsh.bundle.patch`）→ `dsh plugin --profile web add <spec>` 自动进 `dsh.profile.bundles`；**装完需重启 dsh**（bundle 层启动时组合，HMR 不重载 bundle 层）。
2. **client-only 插件**（只有 `dsh.client`，无 `dsh.bundle`）→ 不进 bundles；已装 dshmarket 时由其启动热挂载，否则需手动在 profile 配置后重启。
3. **纯 cordis 插件**（无 `dsh.bundle` / `dsh.client`，只导出 `apply`）→ 经 profile 的 `cordis.patch.yml` 加 `- insert:` 行挂载（配置层 HMR 实时生效，通常无需重启）。

标准安装命令：

```bash
# 安装（dsh CLI 不在 PATH 时用 node 调 <dsh 根>/apps/cli/lib/bin.js）
dsh plugin --profile web add <spec>
# spec 可以是：npm 包名 | github:owner/repo | 本地路径/链接 | tarball
```

**GitHub 直装与构建**：git 安装拉源码不跑构建。TypeScript 包需要 `prepare` 脚本 + pnpm `allowBuilds` 授权（用户必须显式允许，见官方文档）；纯 JS 零依赖包（如本插件）无需任何授权。

**作用域**：skill 类插件可装在**全局**（`${DSH_HOME:-~/.dsh}/skills/`，所有会话可见）或**工作区**（`<工作区>/.dsh/skills/`，仅该项目会话可见）；`SKILL.md` 改名 `.disabled` 即停用，热生效。安装 `dsh plugin` 之外的纯 skill 包可直接复制到上述目录。

## 5. 安装本插件（首次使用）

本 skill 由 `dsh-community-plugins` 插件提供。能读到本 skill 说明已安装；否则：

```bash
# 方式 A：GitHub 直装
dsh plugin --profile web add github:HubaKing/dsh-community-plugins
# 方式 A2：Gitee 镜像（国内访问更快）
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git
# 方式 B：tarball（curl 直连被阻断时改用浏览器下载或 Node https）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.2/dsh-community-plugins-0.1.2.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.2.tgz
```

装完重启 dsh，新会话 `<available_skills>` 出现本 skill 即成功。

## 6. 安装后验证

1. `${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `bundles` 数组含包名
2. 重启后：skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板

## 7. 约束与边界

- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（`index.js` 每次发现从磁盘重读），无需重装。
