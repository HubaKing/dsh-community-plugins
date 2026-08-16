---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现社区插件（GitHub dsh-plugin topic、npm）、评估并安装它们（dsh plugin 命令、bundle 机制、tarball、GUI）。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/skills for this harness, or asks what community plugins exist.
---

# DSH 社区插件：发现、评估与安装

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包展开。**动手前先确认本机实际装了什么**，不假设、不推荐未安装的第三方插件。

## 1. 先看本机已装什么

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出生效的 bundle 层，`dependencies` 列出已安装的插件依赖；`node_modules` 是已下载的包。**以实际读到的结果为准**，不要把文档提到的插件当作已安装。

官方基线（profile 模板自带，非社区插件）：

- `@deepseek-ai/dsh-base` — 官方宿主核心（工具、持久化、策略等基础行）
- `@deepseek-ai/dsh-web-app` — 官方 Web 表层（浏览器宿主、前端产物）

若用户想安装市场类插件，先按第 3 节评估并向用户确认，不要默认推荐某个市场。

## 2. 查找社区插件

先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）——分类搜索命中更准。

按可靠性排序：

1. **web_search**：搜索 GitHub `dsh-plugin` 话题与 npm 上的 `dsh-*` 包（默认渠道，任何模型可用）。
2. **GitHub API**：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
   ```
   注意：部分机器 shell 直连外网被阻断（curl/git 失败），但 **Node.js https 通道通常可用**（`node -e` 内 `https.get` 可通 api.github.com），npm registry 也可达。
3. **npm**：`npm view <包名>` 查发布情况（版本、许可证、依赖）。

若 §1 实测发现本机已安装市场类插件（自带搜索/安装工具），可优先使用其工具；未安装时按上述渠道查找，不引导安装。

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
2. **client-only 插件**（只有 `dsh.client`，无 `dsh.bundle`）→ 不进 bundles；需在 profile 的 patch 层配置 `dsh.client` 行后重启生效。
3. **纯 cordis 插件**（无 `dsh.bundle` / `dsh.client`，只导出 `apply`）→ 经 profile 的 `cordis.patch.yml` 加 `- insert:` 行挂载（配置层 HMR 实时生效，通常无需重启）。

标准安装命令：

```bash
# 安装（dsh CLI 不在 PATH 时用 node 调 <dsh 根>/apps/cli/lib/bin.js）
dsh plugin --profile web add <spec>
# spec 可以是：npm 包名 | github:owner/repo | 本地路径/链接 | tarball
```

**GitHub 直装与构建**：git 安装拉源码不跑构建。TypeScript 包需要 `prepare` 脚本 + pnpm `allowBuilds` 授权（用户必须显式允许，见官方文档）；纯 JS 无构建脚本的包无需任何授权。

**作用域**：skill 类插件可装在**全局**（`${DSH_HOME:-~/.dsh}/skills/`，所有会话可见）或**工作区**（`<工作区>/.dsh/skills/`，仅该项目会话可见）；`SKILL.md` 改名 `.disabled` 即停用，热生效。安装 `dsh plugin` 之外的纯 skill 包可直接复制到上述目录。

## 5. 安装后验证

1. `${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `bundles` 数组含包名
2. 重启后：skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板

## 6. 约束与边界

- 本 skill 由 `dsh-community-plugins` 插件注册提供；能读到本 skill 即说明插件已生效。
- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（`index.js` 每次发现从磁盘重读），无需重装；改动要同步到其他机器需提交到插件仓库。
