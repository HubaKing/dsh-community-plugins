---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现社区插件（GitHub dsh-plugin topic 检索、第三方目录/市场、npm）、评估与安装（仓库名≠npm 包名的识别、许可证交叉核验、API 兼容性核查、安装脚本风险、dsh plugin 命令、bundle 机制、tarball、GUI），含安装提速与供应链策略。**只提供方法与客观事实，不推荐、不排序、不背书任何第三方插件或市场，选择权交回用户**。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/themes/skills for this harness, or asks what community plugins exist.
---

# DSH 社区插件：发现、评估与安装

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包展开。**动手前先确认本机实际装了什么**，不假设、不绑定单一市场。

> **本 skill 只提供方法与客观事实，不做任何推荐**（详见 §2「本 skill 的立场」）。用户问「用哪个」时，给出候选与逐条事实，**由用户自己评估决定**。

## 1. 先看本机已装什么

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出生效的 bundle 层，`dependencies` 列出已安装的插件依赖；**以实际读到的结果为准**，不要把文档提到的插件当作已安装。

关于 `node_modules`：profile 的 `node_modules` 里**只有 profile 自己安装的依赖**（含 `dsh plugin add` 装进来的社区插件），**不含官方 `@deepseek-ai/*` 包**——那些从 dsh 安装根解析（要查本机 API 版本见 §3「API 兼容性核查」）。想知道 profile 到底装了什么，也可以读 `node_modules/.modules.yaml` 的 `hoistedLocations`。

官方基线（profile 模板自带，非社区插件）：

- `@deepseek-ai/dsh-base` — 官方宿主核心（工具、持久化、策略等基础行）
- `@deepseek-ai/dsh-web-app` — 官方 Web 表层（浏览器宿主、前端产物）

若本机已装有市场类插件（§2 已列出的安装器或面板），优先使用其自带工具；未安装时按 §2 渠道查找，**不主动推荐、不引导安装某个市场**——除非用户明确要求装市场。本 skill 只提供方法与客观事实，**选择权始终在用户**。

## 2. 发现渠道与市场选择

先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）、**provider 类**（模型路由/凭据）——分类搜索命中更准。

### 发现渠道（按可靠性排序）

1. **本机已装市场的工具/面板**（§1 实测为准）：如自带搜索/安装工具的可直接调用。
2. **目录/索引源（只做检索，不执行任何代码）**：这类源本身不安装、不运行第三方插件，只是可检索的清单，用于**发现候选**。以下是已知的几个（**仅说明存在与用法，非推荐，使用前请自行核查其内容与时效**）：
   - 机器可读的索引源示例：提供 `data/plugins.json` 之类的结构化清单（含 stars / language / license / pushed_at / category 字段），可直接抓取做筛选；注意其条目数为**抓取时的快照**，会随时间变化，不要当固定值。
   - 人工策展的 awesome 列表类站点：条目标注可用 `dsh plugin add` 的包，可与机器可读索引交叉核验。
   > 索引源的价值是**扩大候选池**，不是替你做质量判断：清单里的条目同样要按 §3 独立核查。
3. **GitHub topic 检索（按类别找插件的主力渠道）**：用户说「帮我找一个好用的 X 类插件」时，这是命中率最高的入口——直接按 topic + 类别关键词检索，一次拿到带 stars / 推送时间的候选池，比通用 web_search 精准得多：
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin+skin&sort=stars&per_page=30
   ```
   把 `skin` 换成需求类别词（`theme` / `ui` / `memory` / `mcp` / `skill` / `tui` …）；`+theme`、`+ui` 等宽泛词候选多但噪声大，具体词（`skin`）更准。实测 `topic:dsh-plugin+skin` 出 187 个仓库、`+theme` 出 334 个、`+ui` 出 936 个。想按中文找，直接 URL 编码中文关键词（如 `topic:dsh-plugin+%E7%9A%AE%E8%82%A4`）。
   注意：部分机器 shell 直连外网被阻断（curl/git 失败），但 **Node.js https 通道通常可用**（`node -e` 内 `https.get` 可通 api.github.com），npm registry 也可达；GitHub API 未认证有时限流（403），此时换 raw.githubusercontent.com 或网页渠道。
4. **web_search**：搜 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包（通用兜底，任何模型可用）。
5. **npm**：`npm view <包名>` 查发布情况（版本、许可证、依赖）——**注意 `<包名>` 必须是 `package.json` 的 `name` 字段，不是仓库名**，见下节。

### ⚠️ 仓库名 ≠ npm 包名（判断「是否已发布」前必读）

**`dsh plugin add` 用的是 `package.json` 的 `name` 字段，不是 GitHub 仓库名。二者经常完全不同**，拿仓库名去 `npm view` 会得到假 404，从而误判「未发布、只能走 GitHub 慢装」。

常见的差异形态（**形态说明，非具体插件**——本 skill 不列举具体第三方包名）：

| 差异形态 | 表现 | 说明 |
|---|---|---|
| 名称完全不同 | 仓库名与包名毫无字面关系 | 最常见，按仓库名查 npm 必然 404 |
| 带 npm scope | 包名形如 `@<scope>/<name>` | scope 通常与作者/组织名相关，但仍可能不同 |
| 后缀不同 | 包名是仓库名的变体（加/减词、改后缀） | 字面接近但**不等于**仓库名，仍会 404 |

**正确流程**：拉 `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/package.json` → 读 `name` 字段 → 再用它查 npm。

注意仓库内可能有多个包（monorepo）：根 `package.json` 可能没有 `name` 或是总包，真正的插件包在子目录（常见的如 `packages/<name>/`、`plugin-<name>/`）。此时分别读各子包 `package.json`。

> 这条直接影响呈现给用户的事实是否准确：曾因按仓库名查 npm 得到 404，把一个**实际已发布**的插件错误归类为「未发布、需 GitHub 慢装」，给出了错误对比结论。

### 本 skill 的立场：只做方法，不做推荐

**本 skill 不推荐任何第三方插件或市场，不为任何一方背书，也不替用户排序。** 原因是这个生态里没有稳定的"最佳选择"——插件质量、维护状态、许可证、API 兼容性都在快速变化，任何排名都会很快过期并误导用户。

**因此：**

- 用户问「哪个插件好」时，**不要给排名或指名推荐**。应当：说明有哪些候选，给出下面这套**客观事实与检查项**，让用户自己判断取舍。
- 本 skill 里出现的具体包名，**只作为「客观事实的实例」或「用于验证方法有效性的样本」**，不构成推荐。是否采用由用户决定。
- 遇到任何第三方插件，**一律按 §3 独立核查**（危险信号、许可证、API 兼容性、活跃度），**不因为它在本文档里出现过就降低标准**。
- 用户明确要求「帮我挑一个」时，可以列出候选并**逐条呈现事实**（形态、许可、活跃度、已知风险），但**结论必须交回用户**——说清各自的取舍，不代做选择。

### 评估「插件市场/安装器」时看什么

不排名，但可用以下维度逐项核查（每一项都是事实判断，不是打分）：

- **生效方式**：装完第三方插件是否需要重启 dsh？支持热挂载的可免重启，不支持则每装一个都要重启一次。
- **来源收窄程度**：列表是人工策展（可防 name-squatting）还是 topic 全量同步（覆盖大但噪声多）？
- **闭环能力**：是否支持安装/更新/卸载/失败回滚/降级保护？
- **agent 工具**：是否提供 market_search 类工具（agent 可直接调用）还是纯 GUI？
- **安全审查**：网络是否只读？有无遥测？**是否执行第三方安装脚本**（是否沙箱、有无确认弹窗与静态扫描）？
- **活跃度与许可证**：最近提交/发布、许可证类型（宽松：MIT/Apache/BSD；GPL/AGPL/未知需提示）。

### 已知的市场/安装器（客观事实，非推荐）

> 以下是**截至 2026-08 的静态实测属性**，**不构成推荐、不排序、不承诺仍然有效**。列出的唯一目的：让你知道"这类工具存在、它们之间客观差异在哪"，以便按上面的维度自行核查。**这不是完整清单**——仅列当时已知的几个；新出现的、更好的、或已废弃的都可能不在此表内。
>
> 属性会随时间变化（条目数、是否执行安装脚本、维护状态都会变），**使用前必须自行复核**，不要直接采信本表。

| 市场/安装器 | 形态 | 当时实测的客观属性 |
|---|---|---|
| `dshmarket`（npm） | bundle+client | 支持热挂载（首次安装其自身需重启一次）；当时索引约 839 条 curated 插件；含安装/更新/卸载/回滚/降级保护；纯 GUI、无 agent 工具；MIT、联网只读、无遥测 |
| `dsh-plugin-marketplace`（github） | bundle+client | 无热挂载，装完需重启；GitHub topic 同步；提供 4 个 agent 工具（market_search/market_install/market_installed/market_update）；monorepo 插件走 clone+构建 |
| `DSH-Plugins-Marketplace`（github） | bundle+client | 无热挂载，装完需重启；当时索引 5000+ 条（CDN 分发）；**会执行第三方安装脚本**（有确认弹窗+静态扫描，非沙箱）；2026-08 创建 |
| 目录/索引类站点 | 非安装器 | 只提供检索，不安装、不执行代码；落地安装仍需回插件仓库或 `dsh plugin add` |

### 已收录插件（客观事实，非推荐）

> 收录门槛：已发布 npm、许可证宽松、通过 §3 危险信号检查。**收录不等于推荐、不等于背书**——每条只陈述已核实的事实与已知风险，**是否采用由用户自行评估**。
>
> 表格中**不写版本号**（npm latest 与仓库 main 常不同步，钉版本号必然过期，见 §3）；需要最新版用 `npm view <包名> version` 当场核实。

| 插件 | 类别 | 活跃度 | 已核实事实 |
|---|---|---|---|
| `dsh-llm-local-token`（npm） | provider / 模型路由 / 凭据 | 3 stars；2026-08 创建，活跃（最近推送 2026-09） | bundle+client；读取本机 Codex CLI 与 Claude Code 已有的 OAuth 凭据，注册 `openai-codex`、`anthropic` 路由（token 按请求解析、临期自动刷新，交给 dsh 自带 pi-ai 引擎）；面板读 provider 限流响应头、按计划刷新展示订阅剩余额度（含 GLM Coding Plan）；缺凭据的路由跳过而非启动失败；MIT、Node >=22.13.0、web profile、**无 install 脚本**；安装：`dsh plugin --profile web add dsh-llm-local-token` |

**本地实测记录（2026-09，dsh `0.1.5-rc.1` / Node v24.21.0 / Windows）**：安装 904ms 完成并自动进入 `dsh.profile.bundles`；供应链复验 7 个 lib 文件与 npm tarball SHA-256 全部一致；`import()` 加载正常；peer `^0.1.0-rc.6` 区间满足，`registerAdapter` / `LlmError` / `PiAiAdapter` 均存在。即"能装上且当前 API 可用"，但**这不等于它适合你的场景**。

**⚠️ 该插件的 API 兼容风险高于皮肤/主题类**：它直接挂 LLM 引擎行，`peerDependencies` 钉在 `@deepseek-ai/dsh-llm@^0.1.0-rc.6`、`dsh-llm-pi-ai@^0.1.0-rc.6`（rc 预发布内部 API，可能随 dsh 升级变动）。安装前按 §3「API 兼容性核查」比对本机版本。

## 3. 评估插件（安装前必做）

安装前检查包内容；**命中危险信号时停下，向用户确认后再继续**：

- `package.json` — 名称、`dsh.bundle` / `dsh.client` manifest、许可证（宽松：MIT/Apache/BSD；GPL/AGPL/未知许可证需提示）
- `cordis.patch.yml` — 插入哪些行、注册什么
- main 入口源码 — 是否执行网络请求/子进程等可疑行为
- **活跃度** — stars 数量与最近提交时间：停更超一年且 star 少的项目谨慎采用
- **维护者弃养声明** — 读 README 顶部：部分作者会明确写「无法及时适配新 API，崩溃请自行修理」。这不是拒绝安装的理由，但必须**告诉用户**：未来升级 dsh 后可能需自行修复或卸载
- 用目录源（§2）检索时，直接过滤 `archived: true`、`fork: true`、许可证缺失、`pushed_at` 过老的条目

### ⚠️ 写版本号必过期：npm latest ≠ 仓库 main

**在 skill/文档里钉死某个插件的版本号，几乎必然写错**——npm 发布与仓库 main 是两条独立推进的线，作者常常先推代码后发 npm（或反之）：

- 实测 `dsh-llm-local-token`：npm latest 为 **`1.5.1`**，但仓库 `package.json` 已是 **`1.6.1`**，且仓库 `pushed_at` 晚于该 npm 发布。

**规则**：

1. **描述插件时不写版本号**，只写包名（要装就 `add <包名>`，让 pnpm 解析最新版）。
2. 需要引用版本时，**必须当场核实并标注核实日期**，例如「截至 2026-09 为 1.6.1」。
3. 反馈两类来源不一致时，**两个都说**（如「npm 1.5.1 / 仓库 1.6.1」），不要只报一个数字当成事实。
4. 反过来，**`dsh plugin update` 报「已最新」但 `npm view` 有新版**时，多半不是这里的问题，而是 pnpm 的 `minimumReleaseAge` 拦了（见 §4）。

> 这条与「仓库名 ≠ npm 包名」是同一类错误的两面：都是**把一条线上的事实当成另一条线的结论**。

### ⚠️ 许可证判定：不要信 GitHub 的 license 徽章

GitHub 的许可证识别（网页徽章与 API `license.spdx_id`）**会把仓库内 vendored 的第三方文件误判为主许可证**，实测会给出错误结论：

- 实测某仓库：GitHub 徽章与 API 均报 **AGPL-3.0**，但仓库 `LICENSE` 全文与 npm 包 `license` 字段**都是 MIT**（该仓库内含其他协议的文件，被分类器当成了主协议）。

> 该误判**不是个例**：只要仓库里带了别的协议的第三方文件（vendored 代码、字体、图标、生成物），徽章就可能指向那个文件而不是主许可证。所以**任何**仓库都必须按下面的流程交叉核验，不能只看徽章。

**判定流程（必须交叉核验，不要单凭徽章下结论）**：

1. 读仓库 `LICENSE` **文件全文**首行（不是徽章）
2. 读 npm 包 `package.json` 的 `license` 字段（`npm view <pkg> license`）
3. 两者不一致时，以 LICENSE 全文 + 包内 `license` 字段为准，并在结论里说明分歧

误判代价是双向的：把 MIT 误报成 AGPL 会让用户白白放弃一个合规插件；反过来漏报真正的强传染协议则更严重。**不确认就不要下许可证结论。**

**危险信号清单**（任一命中 → 停下确认）：

- `install` / `postinstall` / `preinstall` 脚本（npm 包安装时会执行）
- 源码中出现 `child_process` / `spawn` / `exec`（运行外部命令；市场类工具内置的 dsh/git/pnpm 调用属正常，需确认参数有白名单/注入校验）
- 源码中出现网络请求（`fetch` / `http` / `https` / `WebSocket`），特别是**发送数据**而非仅读取
- 源码写入非缓存目录（如主目录、profile 目录外的敏感路径）
- 代码被混淆/压缩到不可读，或从远程加载并执行代码（`eval` / `Function` / 动态 import 远程 URL）
- 许可证缺失或非宽松协议
- 会执行第三方提供的安装脚本（`irm|iex` / `curl|bash` / 复制进 profile 后触发构建）——需用户显式确认
- **仓库自带的独立安装脚本**（`install.sh` / `install.ps1` / `setup.*` / `deploy.*`）——这是本生态的**常见形态**，与 npm 生命周期脚本是两回事，但同样要单独审：
  - 它们通常**手工改写 profile 的 `cordis.patch.yml`、建 junction/软链到 `node_modules`**，从而**绕过 `dsh plugin` 的依赖管理**——后续 `dsh plugin update` / `remove` 管不到它，卸载会残留
  - **优先用 `dsh plugin --profile web add <包名>`**；仅当包确实未发布到 npm 时，才考虑这类脚本，且必须**读完全文**再决定
  - 审的时候确认：是否幂等（重复跑不重复登记）、删除链接时是否 `-Recurse` 跟随（会误删目标目录）、下载源是否固定版本（跟随 `main` 分支等于每次安装内容都不同）
  - 脚本本身逻辑规范**不等于**该用它——`DSH-Transparent-UI-Plugin` 的 `install.ps1` 写法克制、幂等、注释清楚，但 npm 包已发布，用 npm 装仍明显更优

确认时说明发现的具体信号与风险，由用户决定是否继续。

### API 兼容性核查（第三方 UI/工具插件安装前建议做）

社区插件针对某个 dsh 版本区间开发，而 dsh 自身在快速迭代。**「能装上」不等于「装上能跑」**——尤其 UI 类插件（皮肤/主题/面板）会直接调用官方 client API。

**关键：官方 `@deepseek-ai/*` 包不在 profile 的 `node_modules` 里。**

profile 的 `node_modules` 只有「profile 自己安装的依赖」（能用 `node_modules\.modules.yaml` 的 `hoistedLocations` 确认）。官方包从 **dsh 安装根**解析，所以这样查本机 API 版本：

```bash
# 1) 本机 dsh 版本（安装根）
node -p "require('<dsh 根>/package.json').version"
# 2) 本机官方 client 包实际版本（安装根 node_modules，或源码仓库 packages/client/*/package.json）
node -p "require('<dsh 根>/node_modules/@deepseek-ai/dsh-client-ui-slots/package.json').version"

# 从源码仓库（development 部署）：
#   <dsh 根>/packages/client/ui-slots/package.json 等，版本形如 0.1.5-rc.1
```

**核查步骤**：

1. 读插件 `package.json` 的 `peerDependencies`（它声明支持的区间，如 `^0.1.0-rc.5`）
2. 取本机实际版本（上面命令），**判断是否落在区间内**——注意 rc 预发布版本的 semver 语义：`^0.1.0-rc.5` 表示 `>=0.1.0-rc.5 <0.2.0-0`，因此 `0.1.5-rc.1` **是满足的**（主版本 0 且次版本 1 未变）。**不要因为版本号字面不同（rc.5 vs rc.1）就断言不兼容**
3. **更进一步：确认它调用的具体 API 还存在**。UI 类插件常用 `ctx.slots.register` 注册设置卡片，slot 名是硬契约。在 dsh 源码里 grep 该 slot 名即可验证：
   ```bash
   # 插件里读到的 slot 名，例如 settings.plugin.item / settings.general.item
   grep -rn "settings.plugin.item" <dsh 根>/packages/client --include=*.ts --include=*.tsx
   ```
   slot 名/契约若已被改名或移除，插件会静默失效或报错
4. 结论要如实说：**「现在能跑，但作者已停更 N 周、且声明不跟进 API，未来升级 dsh 可能要自行修复」**——把风险讲清楚，由用户决定

> pnpm 装完常报 `Issues with peer dependencies found`。若已按上面 1-3 步确认区间满足且 API 存在，这个警告可忽略，安装是成功的。

## 4. 安装插件（含提速原则）

机制依据官方文档（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)）。先**判断安装形态**（决定怎么挂载与是否需重启）：

1. **bundle 插件**（`package.json` 有 `dsh.bundle.patch`）→ `dsh plugin --profile web add <spec>` 自动进 `dsh.profile.bundles`；**装完需重启 dsh**（bundle 层启动时组合，HMR 不重载 bundle 层）。
2. **client-only 插件**（只有 `dsh.client`，无 `dsh.bundle`）→ 不进 bundles；若你所用的市场/安装器**支持热挂载**则可免重启，否则需在 profile 的 patch 层配置 `dsh.client` 行后重启生效。
3. **纯 cordis 插件**（无 `dsh.bundle` / `dsh.client`，只导出 `apply`）→ 经 profile 的 `cordis.patch.yml` 加 `- insert:` 行挂载（配置层 HMR 实时生效，通常无需重启）。

标准安装命令：

```bash
dsh plugin --profile web add <spec>
# spec 可以是：npm 包名 | github:owner/repo | 本地路径/链接 | tarball
```

> **`dsh` 不在 PATH 时**（`Get-Command dsh` / `which dsh` 为空，实测常见）：直接用 node 调安装根的 CLI 入口，功能完全一致：
> ```bash
> node "<dsh 根>/apps/cli/lib/bin.js" plugin --profile web add <spec>
> ```

**装完先验证再重启**（重启前就能确认装对没有，避免重启后才发现问题）：

```bash
node "<dsh 根>/apps/cli/lib/bin.js" plugin --profile web list   # 应列出该包
```

再读 profile 的 `package.json`，确认包名已进入 `dsh.profile.bundles` 数组（bundle 插件）或 `cordis.patch.yml` 出现挂载行（纯 cordis 插件）。

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

**装完（重启前）**：

1. `dsh plugin --profile web list` 能列出该包
2. profile `package.json`：bundle 插件 → `dsh.profile.bundles` 数组含包名；纯 cordis 插件 → `cordis.patch.yml` 含挂载行
3. **供应链复验（可选但推荐）**：比对落盘文件与审计过的产物是否同一份——npm 装的用 `npm pack` / registry tarball 下载解包后比 SHA-256：
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<安装后路径>/lib/client.js')).digest('hex'))"
   ```
   哈希一致 = 审计的和装上的确实是同一个东西（排除安装环节掉包）。对来源可疑或 star 少的插件尤其值得做。

**重启后**：

4. skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板
5. 若更新无效果：按 §4 供应链策略排查 minimumReleaseAge
6. **装完告知用户回滚路径**：安装前备份 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`，或直接 `dsh plugin --profile web remove <包名>`。UI 类插件出问题会导致界面异常，用户需要知道怎么退回去

## 6. 约束与边界

- **不做推荐**：不推荐、不排序、不背书任何第三方插件或市场（详见 §2「本 skill 的立场」）。本 skill 提到的具体包名只是客观事实实例，不构成推荐；用户问「用哪个」时给出事实与取舍，**由用户自己评估决定**。
- 本 skill 由 `dsh-community-plugins` 插件注册提供；能读到本 skill 即说明插件已生效。
- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（`index.js` 每次发现从磁盘重读），无需重装；改动要同步到其他机器需提交到插件仓库。