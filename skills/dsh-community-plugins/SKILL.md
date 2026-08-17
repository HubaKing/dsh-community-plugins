---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现社区插件（GitHub dsh-plugin topic、第三方目录/市场、npm）、评估并安装它们（dsh plugin 命令、bundle 机制、tarball、GUI），含安装提速与供应链策略。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/skills for this harness, or asks what community plugins exist.
---

# DSH 社区插件：发现、评估与安装

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包展开。**动手前先确认本机实际装了什么**，不假设、不绑定单一市场。

## 1. 先看本机已装什么

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出生效的 bundle 层，`dependencies` 列出已安装的插件依赖；`node_modules` 是已下载的包；已装市场的状态目录（如 `.dsh-market/`）可能残留。**以实际读到的结果为准**，不要把文档提到的插件当作已安装。

官方基线（profile 模板自带，非社区插件）：

- `@deepseek-ai/dsh-base` — 官方宿主核心（工具、持久化、策略等基础行）
- `@deepseek-ai/dsh-web-app` — 官方 Web 表层（浏览器宿主、前端产物）

若本机已装有市场类插件（§2 短名单中的安装器或面板），优先使用其自带工具；未安装时按 §2 渠道查找，**不主动推荐、不引导安装某个市场**——除非用户明确要求装市场。

## 2. 发现渠道与市场选择

先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）、**provider 类**（模型路由/凭据）——分类搜索命中更准。

### 发现渠道（按可靠性排序）

1. **本机已装市场的工具/面板**（§1 实测为准）：如自带搜索/安装工具的可直接调用。
2. **目录/索引源（纯发现、零执行，安全性最高）**：
   - `Oh-My-DSH`（github:like-study1/Oh-My-DSH）— 自动同步 + 人工策展：机器可读 `data/plugins.json`（精选 1419 条，字段含 stars/language/license/pushed_at/category）与 `data/snapshot.json`（全量 1744 条），每 4 小时更新。直接抓 `https://raw.githubusercontent.com/like-study1/Oh-My-DSH/main/data/plugins.json` 做结构化检索。
   - `awesome-dsh-plugin`（awesome-dsh-plugin.com）— 精选列表，条目标注可 `dsh plugin add` 的包，可与目录源交叉核验。
3. **web_search**：搜索 GitHub `dsh-plugin` 话题与 npm 上的 `dsh-*` 包（默认渠道，任何模型可用）。
4. **GitHub API**：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
   ```
   注意：部分机器 shell 直连外网被阻断（curl/git 失败），但 **Node.js https 通道通常可用**（`node -e` 内 `https.get` 可通 api.github.com），npm registry 也可达；GitHub API 未认证有时限流（403），此时换 raw.githubusercontent.com 或网页渠道。
5. **npm**：`npm view <包名>` 查发布情况（版本、许可证、依赖）。

### 市场选择标准（判断力，不点名站队）

评估一个「插件市场」用以下标准：

- **热挂载 vs 重启**：装完第三方插件是否需要重启 dsh？能热挂载（如 dshmarket 的 include 子树机制）的体验远好于「每装一个重启一次」。
- **curated vs 全量**：列表是人工策展（防 name-squatting、质量高）还是 topic 全量同步（覆盖大但噪声多）？
- **闭环能力**：是否支持安装/更新/卸载/失败回滚/降级保护？
- **agent 工具**：是否提供 market_search 类工具（agent 可直接调用）还是纯 GUI？
- **安全审查**：安装来源是否收窄（curated registry）？网络是否只读？有无遥测？是否执行第三方脚本（需确认弹窗 + 静态扫描）？
- **活跃度与许可证**：最近提交/发布、宽松许可（MIT/Apache/BSD）。

### 短名单（2026-08 静态实测结论，非背书；按需求选择）

| 市场 | 定位 | 关键结论 |
|---|---|---|
| `dshmarket`（npm） | 安装器**首选** | bundle+client；**热挂载免重启**（首次装它自己需重启一次）；839 个 curated 插件（awesome-dsh-plugin.com 源）；安装/更新/卸载/回滚/降级保护齐全；纯 GUI 无 agent 工具；MIT、联网只读、无遥测 |
| `dsh-plugin-marketplace`（github:AwesomeHou/…） | 安装器备选 | bundle+client；**装完需重启**（无热挂载）；GitHub topic 同步；4 个 agent 工具（market_search/market_install/market_installed/market_update）；monorepo 插件走 clone+构建（慢） |
| `DSH-Plugins-Marketplace`（github:bradeGithub/…） | 全量安装器（谨慎） | bundle+client；**装完需重启**；5000+ 全量索引（CDN 分发）；**会执行第三方安装脚本**（有确认弹窗+静态扫描，非沙箱）；新项目（2026-08 创建），建议备份 profile 试用 |
| `Oh-My-DSH` / `awesome-dsh-plugin` | 纯发现渠道 | 非安装器，只「找得到」，落地安装仍需回插件仓库或 `dsh plugin add` |

### 单插件短名单（非背书；按需求选择）

| 插件 | 类别 | 关键结论 |
|---|---|---|
| `dsh-llm-local-token`（github:tianxia--/dsh-llm-local-token） | provider / 模型路由 / 凭据 | 复用本机 Codex CLI 与 Claude Code OAuth 凭据提供 `openai-codex`、`anthropic` 路由；缺凭据时跳过对应路由；MIT、Node >=22.13.0；npm 发布中，当前可用 git URL 安装 |

## 3. 评估插件（安装前必做）

安装前检查包内容；**命中危险信号时停下，向用户确认后再继续**：

- `package.json` — 名称、`dsh.bundle` / `dsh.client` manifest、许可证（宽松：MIT/Apache/BSD；GPL/AGPL/未知许可证需提示）
- `cordis.patch.yml` — 插入哪些行、注册什么
- main 入口源码 — 是否执行网络请求/子进程等可疑行为
- **活跃度** — stars 数量与最近提交时间：停更超一年且 star 少的项目谨慎采用
- 用目录源（§2）检索时，直接过滤 `archived: true`、`fork: true`、许可证缺失、`pushed_at` 过老的条目

**危险信号清单**（任一命中 → 停下确认）：

- `install` / `postinstall` / `preinstall` 脚本（npm 包安装时会执行）
- 源码中出现 `child_process` / `spawn` / `exec`（运行外部命令；市场类工具内置的 dsh/git/pnpm 调用属正常，需确认参数有白名单/注入校验）
- 源码中出现网络请求（`fetch` / `http` / `https` / `WebSocket`），特别是**发送数据**而非仅读取
- 源码写入非缓存目录（如主目录、profile 目录外的敏感路径）
- 代码被混淆/压缩到不可读，或从远程加载并执行代码（`eval` / `Function` / 动态 import 远程 URL）
- 许可证缺失或非宽松协议
- 会执行第三方提供的安装脚本（`irm|iex` / `curl|bash` / 复制进 profile 后触发构建）——需用户显式确认

确认时说明发现的具体信号与风险，由用户决定是否继续。

## 4. 安装插件（含提速原则）

机制依据官方文档（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)）。先**判断安装形态**（决定怎么挂载与是否需重启）：

1. **bundle 插件**（`package.json` 有 `dsh.bundle.patch`）→ `dsh plugin --profile web add <spec>` 自动进 `dsh.profile.bundles`；**装完需重启 dsh**（bundle 层启动时组合，HMR 不重载 bundle 层）。
2. **client-only 插件**（只有 `dsh.client`，无 `dsh.bundle`）→ 不进 bundles；有热挂载能力的市场（如 dshmarket）可免重启，否则需在 profile 的 patch 层配置 `dsh.client` 行后重启生效。
3. **纯 cordis 插件**（无 `dsh.bundle` / `dsh.client`，只导出 `apply`）→ 经 profile 的 `cordis.patch.yml` 加 `- insert:` 行挂载（配置层 HMR 实时生效，通常无需重启）。

标准安装命令：

```bash
# 安装（dsh CLI 不在 PATH 时用 node 调 <dsh 根>/apps/cli/lib/bin.js）
dsh plugin --profile web add <spec>
# spec 可以是：npm 包名 | github:owner/repo | 本地路径/链接 | tarball
```

**提速原则**（按此顺序决策，避免慢安装）：

1. **npm-first**：已发布到 npm 的插件优先 `add <npm 包名>`（走缓存/CDN、快且稳、无需 GitHub 网络与构建授权）；git spec 仅作兜底——git 安装拉源码且 TypeScript 包要 prepare 构建（慢 + 可能被 allowBuilds 卡住）。
2. **批量安装**：一次装多个插件 `dsh plugin --profile web add a b c`，多个插件只需一次重启。
3. **按形态省重启**：client-only 优先选支持热挂载的市场；纯 cordis 走 cordis.patch.yml（HMR 即生效）；只有 bundle 才需要重启。
4. **allowBuilds 一次性授权**：git 装 TypeScript 包被 pnpm 拦截时，把 pnpm 提示的 key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑（pnpm≥10 行为）。

**供应链策略（pnpm ≥10/11 的 minimumReleaseAge）**：

- 现象：发布太新的包可能被**静默跳过**——`dsh plugin update` 报 "Already up to date"，但 `npm view <pkg> version` 明明有更新版本。
- 原因：pnpm 的 `minimumReleaseAge`（发布年龄门槛）把「太新」的版本排除出解析；`pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 是白名单。
- 对策：
  1. 先 `npm view <pkg> version` 核对最新版；
  2. `dsh plugin --profile web add <pkg>@<精确版本>` —— pnpm 会自动把该版本写入 `minimumReleaseAgeExclude` 并放行；
  3. 或手动把 `pkg@版本` 加进 profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；
  4. 想从「静默放行」改为「显式询问」：设 `minimumReleaseAgeStrict: true`。

**作用域**：skill 类插件可装在**全局**（`${DSH_HOME:-~/.dsh}/skills/`，所有会话可见）或**工作区**（`<工作区>/.dsh/skills/`，仅该项目会话可见）；`SKILL.md` 改名 `.disabled` 即停用，热生效。安装 `dsh plugin` 之外的纯 skill 包可直接复制到上述目录。

## 5. 安装后验证

1. `${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `bundles` 数组含包名（或 cordis.patch.yml 含挂载行）
2. 重启后：skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板
3. 若更新无效果：按 §4 供应链策略排查 minimumReleaseAge

## 6. 约束与边界

- 本 skill 由 `dsh-community-plugins` 插件注册提供；能读到本 skill 即说明插件已生效。
- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（`index.js` 每次发现从磁盘重读），无需重装；改动要同步到其他机器需提交到插件仓库。