---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现（GitHub dsh-plugin topic 检索、策展索引、npm）、评估与安装社区插件（仓库名≠npm 包名、许可证交叉核验、peer 区间与 rc 预发布 semver 语义、具名导出与 slot/服务契约核查、安装脚本风险、bundle 机制、tarball），含安装提速与供应链策略。本插件同时注册两个工具：dsh_plugin_audit 离线审计**已装**插件，dsh_plugin_inspect 联网下载 tarball 审计**尚未安装**的插件。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/themes/skills for this harness, asks what community plugins exist, asks whether a plugin is safe to install, or asks whether upgrading dsh will break installed plugins.
---

# DSH 社区插件：发现、评估与安装

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包展开。动手前先确认本机实际装了什么，不假设、不绑定单一市场。

## 0. 先用本机审计工具（若已注册）

本插件注册**两个**宿主工具，职责按「插件装没装」划分：

| 工具 | 用于 | 网络 |
|---|---|---|
| `dsh_plugin_audit` | **已装**插件：与本机 dsh 构建逐条比对 | 全程不联网 |
| `dsh_plugin_inspect` | **未装**插件（npm 包 / `github:owner/repo` / tarball 直链）：下载、校验、解包到临时目录后判定，再删除 | **联网**（只读 GET） |

判断规则很简单：**要装的包还没装 → 用 `dsh_plugin_inspect`；已经装上了 → 用 `dsh_plugin_audit`。** 两者用的是同一套判定引擎、同一个「本机 dsh 构建」参照系，所以结论口径一致。离线审计不提供任何联网开关——它承诺不联网，而这个承诺不该是有条件的。

### 0.1 `dsh_plugin_audit`（离线，已装插件）

它在**本机离线**完成 §3 里绝大部分静态核查，且不依赖任何预烘焙数据集——结论永远反映本机当下的 dsh 构建：

| 它会告诉你 | 依据 |
|---|---|
| **插件的 bundle 层能不能挂载**（决定 dsh 能否启动） | `dsh.bundle.patch` 指向的文件是否存在、是否登记进 `dsh.profile.bundles`（见下） |
| 已装插件的 `peerDependencies` 区间是否匹配本机版本 | 逐包比对，含 rc 预发布语义（§3 的关键坑） |
| 插件 `import` 的 `@deepseek-ai/*` 包在本机是否仍存在 | 扫描安装根 `packages/` 与 `vendor/` |
| **这些 import 要的具名导出是否还在导出** | 逐包走完声明入口的 `export *` 图（含 `.ts` 后缀的 re-export），再与运行时入口的导出列表取并集 |
| 插件注册的 slot 名是否仍在官方源码中 | 从官方 client/core 源码提取 slot 契约 |
| 插件 `inject` 的服务在运行时是否可解析 | 直接读当前 Cordis 上下文 |
| 安装期风险信号 | lifecycle 脚本、动态代码、shell 执行、网络请求 |

```
dsh_plugin_audit({})                          # 审计 profile 里全部第三方插件
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # 只审计一个（包名或目录路径）
```

判读结论：

- **`incompatible`** —— 硬证据：它需要的包、**具名导出**或 slot 在本机已不存在，**或它的 bundle 层根本无法挂载**（下表的启动失败项）。
- **`at-risk`** —— 声明的区间已不匹配、或层没被组合进去，但代码可能仍能跑。**这是本生态的常态**：pnpm 默认不阻断 peer 不满足的安装（`strictPeerDependencies` 默认 false），所以"装上了"从来不等于"区间满足"。要不要继续用由用户判断。
- **`unknown`** —— 需要联网或 client 侧才能确认的项（见 §3「工具做不到什么」）。

**符号级核对怎么读**：`incompatible` 里的「does not export」是有条件的硬结论——只有当那个包的导出图**完整解析**、且该名字在声明与运行时入口里都找不到时才会报。图不完整时会报 `unknown` 并列出没解析到的 re-export。这条区别是本工具的核心纪律：**「我没解析到」不等于「它没了」**。实测（2026-09，dsh `0.1.5-rc.1`）：279 个官方包，276 个图完整解析，1874 个运行时导出名逐一核对、0 个未确认；剩下 3 张图报 `unknown`。

### ⚠️ dsh 起不来时，先查这一项

这三种情形上游是**抛错**而非降级——**profile 直接无法启动**，而社区插件里很常见：

| 情形 | 上游行为（源码位置） |
|---|---|
| 声明了 `dsh.bundle.patch`，但包里没有那个文件 | `failed to read overlay` → 抛错（`packages/boot/app-boot/src/index.ts:315-323`） |
| 声明了 `dsh.bundle` 却没写 `patch` | `declares no dsh.bundle` → 抛错（`packages/boot/app-boot/src/profile.ts:792-797`） |
| `dsh.profile.bundles` 里列了装不上的包 | 层解析失败 → 抛错（同上） |

还有一种**不报错但完全没用**的：插件带了可读的 patch，但没被登记进 `dsh.profile.bundles`——**它的层永远不会被应用**。常见成因是绕开 `dsh plugin add`、直接在 profile 目录里跑 `pnpm add`（`dsh plugin add` 会调和该列表，`pnpm add` 不会：`apps/cli/src/plugin.ts:59-91`）。

工具会把这几条报成 `blocker` / `risk`，并在每个插件下打印一行 `layer <路径> — readable|MISSING, in|NOT in dsh.profile.bundles`。**判据是精确的**：全部来自 package.json 与文件系统，不是启发式推测。

**工具不在你的工具列表里？** 两种情形，原因不同，别当成"插件没装"：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 完全没有 `dsh_plugin_audit`（通常 `dsh_plugin_inspect` 也一起消失） | 该部署未组合 `tools` 服务（`tools` 由 bundle 配置的 `- id: tools` 行装配）。未组合时两个工具**静默降级**——skill 照常可用，只有工具消失 | 按下面各节人工核查，结论口径一致 |
| 不在原生工具列表，只能经 `run_code` 调用 | 部署设了 `DSH_TOOLS_MODE=ptc`，该模式下模型只直接看到 `run_code`，其余工具经生成的 SDK 可达 | 用 `run_code` 间接调用；或改回默认 `native` |

本工具声明了 30s **协作式**超时预算：超时会中止扫描（在文件边界检查取消信号）并如实报错，不会返回一份不完整的报告。工具全程不联网、不写文件、不执行被审计插件的代码。

### 0.2 `dsh_plugin_inspect`（联网，安装前）

```
dsh_plugin_inspect({ spec: 'dsh-llm-local-token' })          # npm，最新版
dsh_plugin_inspect({ spec: '@scope/pkg@^1.2' })              # npm，指定区间
dsh_plugin_inspect({ spec: 'github:owner/repo#v1.2.0' })     # 仓库
dsh_plugin_inspect({ spec: 'https://host/pkg.tgz' })         # tarball 直链
```

它做的事，以及**为什么值得在装之前花这一次网络**：

| 步骤 | 细节 | 为什么重要 |
|---|---|---|
| 解析 | 读 registry 文档，选出**一个具体版本** | 报告能说清判的是哪个版本，而不是"最新" |
| 下载 | 流式下载 tarball，上限 64 MiB | 有界 |
| 校验 | 解包**之前**核对 registry 公布的 `integrity`（sha512/384/256）或 `shasum` | 审计的和装上的确实是同一份字节 |
| 解包 | 解到临时目录，**每条退出路径**都删除 | 不留残留；穿越、绝对路径、symlink/hardlink 条目、谎报大小的头部、解压炸弹一律拒绝并报告 |
| 判定 | 与离线审计同一套引擎，针对同一个本机 dsh 构建 | 口径一致；且**不会**因为"包尚未登记进 `dsh.profile.bundles`"而误报（那是 `dsh plugin add` 的职责） |

它**不做**的事，用之前要清楚：不安装任何东西、不写 profile、不执行包的 lifecycle 脚本。`postinstall` 会被报成高危发现，而不会被服从。报告还会标出**仓库自带安装脚本**（`install.sh` / `setup.ps1` / `deploy.*`）——那类脚本直接改写 profile、手工把包链进 `node_modules`，绕过 `dsh plugin` 的依赖管理，之后 `update` / `remove` 就管不到它（§3 有详述）。

> ⚠️ **这是本插件唯一联网的部分。** 不要用它去问"我现在装的东西怎么样"——那是 `dsh_plugin_audit` 的活，而且不需要网络。

## 1. 先看本机已装什么

`${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 列出生效的 bundle 层，`dependencies` 列出已安装的插件依赖；**以实际读到的结果为准**，不要把文档提到的插件当作已安装。

关于 `node_modules`：profile 的 `node_modules` 里**只有 profile 自己安装的依赖**（含 `dsh plugin add` 装进来的社区插件），**不含官方 `@deepseek-ai/*` 包**——那些从 dsh 安装根解析（要查本机 API 版本见 §3）。想知道 profile 到底装了什么，也可以读 `node_modules/.modules.yaml` 的 `hoistedLocations`。

官方基线（profile 模板自带，非社区插件）：

- `@deepseek-ai/dsh-base` — 官方宿主核心（工具、持久化、策略等基础行）
- `@deepseek-ai/dsh-web-app` — 官方 Web 表层（浏览器宿主、前端产物）

若本机已装有市场类插件（§2 已列出的安装器或面板），优先使用其自带工具；未安装时按 §2 渠道查找。不主动推荐或引导安装某个市场，除非用户明确要求。

## 2. 发现渠道与市场选择

先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）、**provider 类**（模型路由/凭据）——分类搜索命中更准。

### 发现渠道

1. **本机已装市场的工具/面板**（§1 实测为准）：自带搜索/安装工具的可直接调用。
2. **策展索引 `awesome-dsh-plugin/awesome-dsh-plugin`（CC0）**：只做检索，不安装、不执行代码。用于扩大候选池，条目仍须按 §3 核查。
   - 权威清单在仓库 `README.md`（实测 2026-09 约 3,400 条 / 20+ 品类 / 2,200+ 独立维护者；数字会变，不是固定值）。
   - 机器可读数据在 `data/plugins/<owner>__<repo>.yml`（每个维护者一个 YAML）+ `data/stars.json` / `data/downloads.json` / `data/added-dates.json`。
   - ⚠️ **YAML 覆盖面小于 README 条目数**（实测 README 3,400+ 条 vs YAML 约 1,000 个文件）。要全量候选就用 README，要结构化字段就用 YAML，不要假设两者等价。
   - ⚠️ **不要用 GitHub API 的 `/readme` 端点抓 README 做统计**——它会**静默截断**（实测只拿到一半内容，据此统计会得出错误结论）。用 `/contents/<path>` 端点、base64 解码、并校验返回的 `size`。
   - ⚠️ YAML schema 只记录 `url / name / category / description`，**不含** license、peer 区间、安装脚本、兼容性判定——那些必须自己核（§3）。
3. **GitHub topic 检索（按类别找插件的主力渠道）**：按 topic + 类别词检索，一次拿到带 stars / 推送时间的候选池，比通用 web_search 精准。
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin+skin&sort=stars&per_page=30
   ```
   把 `skin` 换成类别词（`theme` / `ui` / `memory` / `mcp` / `skill` / `tui` …）。宽泛词候选多但噪声大，具体词更准。中文关键词可直接 URL 编码。
   ⚠️ `topic:dsh-plugin` 本身**噪声极大**（实测命中上万仓库，混入大量无关项目），必须叠加类别词或 `in:name` 收窄。
   ⚠️ 部分机器 shell 直连外网被阻断（curl/git 失败），此时用 Node.js https 通道（`node -e` 内 `https.get`）；`raw.githubusercontent.com` 在部分网络下同样被阻断，可改用 `api.github.com` 的 `contents` 端点。GitHub API 未认证会限流（403），省着用。
4. **web_search**：搜 `dsh-plugin` 话题与 npm 的 `dsh-*` 包（通用兜底）。
5. **npm**：`npm view <包名>` 查版本、许可证、依赖。`<包名>` 必须是 `package.json` 的 `name`，不是仓库名（见下节）。

### ⚠️ 仓库名 ≠ npm 包名

`dsh plugin add` 用 `package.json` 的 `name`，不是 GitHub 仓库名。二者常完全不同，按仓库名查 npm 会得到假 404，误判为「未发布」。

常见差异形态：

| 形态 | 表现 |
|---|---|
| 名称完全不同 | 仓库名与包名无字面关系（最常见） |
| 带 npm scope | 包名为 `@<scope>/<name>`，scope 与作者/组织名可能不同 |
| 后缀不同 | 包名是仓库名的变体（加/减词、改后缀） |

**流程**：读仓库 `package.json` 的 `name`（用 `api.github.com/repos/<owner>/<repo>/contents/package.json` 并 base64 解码）→ 用它查 npm。

monorepo 注意：根 `package.json` 可能无 `name` 或是总包，真正的插件包在子目录（如 `packages/<name>/`）。此时分别读各子包 `package.json`。

### 立场

不推荐、不排序、不背书任何第三方插件或市场。理由：该生态变化快，任何排名都会过期。

- 用户问「哪个插件好」：列出候选，逐条给事实（形态、许可、活跃度、风险），结论由用户下。
- 本文档出现的包名仅为事实实例，不构成推荐。
- 任何第三方插件一律按 §3 独立核查，不因在本文档出现过而降低标准。

### 市场/安装器核查维度

逐项核查，不打分：

- **生效方式**：装完是否需重启 dsh。支持热挂载则免重启。
- **来源范围**：人工策展（防 name-squatting）或 topic 全量同步（覆盖广、噪声多）。
- **闭环能力**：安装/更新/卸载/回滚/降级保护。
- **agent 工具**：提供 market_search 类工具，或仅 GUI。
- **安全**：网络是否只读、有无遥测、是否执行第三方安装脚本。
- **活跃度与许可证**：最近提交/发布；许可证类型（宽松：MIT/Apache/BSD；GPL/AGPL/未知需提示）。

### 已知市场/安装器

截至 2026-09 实测，非完整清单，不构成推荐。该品类极度拥挤（策展索引中同类 70+ 个），下表只列有代表性的形态：

| 市场/安装器 | 形态 | 属性 |
|---|---|---|
| `dshmarket`（npm） | bundle+client | 热挂载（自身首次安装需重启）；策展索引；含安装/更新/卸载/回滚/降级保护；纯 GUI；MIT、联网只读、无遥测 |
| `dsh-plugin`（npm） | bundle+client | 自称收录 4000+ 条；按 star 排序检索 |
| `dsh-plugin-shop`（npm） | bundle+client | 商店形态，含 agent 工具 |
| `dsh-find-plugin`（npm） | bundle+tool | 只做**发现**：agent 内实时 topic 检索并按 star 排序，不含安装 |
| GitHub `*-marketplace` 类 | bundle+client | 无热挂载；topic 同步；自带 agent 工具；monorepo 走 clone+构建 |
| 目录/索引类站点 | 非安装器 | 仅检索；安装走插件仓库或 `dsh plugin add` |

### 已知自动化审计/检测类

这类工具与 §3 人工核查**部分重叠**，遇到时先用它们，再补人工判断。同样是拥挤赛道，下面只列事实：

| 工具 | 它做什么 | 它不做什么 |
|---|---|---|
| **官方自带** `cordis_inspect_*`（`@deepseek-ai/dsh-tool-cordis`） | **运行时可查询真实 API 契约**：`Service.listService`、`Event.listEvents`、`Tool.listTools`，以及 `Slots.listSubTree`（能查**浏览器端真实 slot 树与 props**） | 只描述**当前活体运行时**：不读插件文件、不判 peer 区间、不预测"升级后谁会坏"；插件加载失败时它看不见那个插件 |
| `dsh-vet`（npm） | 安装前权限与供应链审计，带 `dsh-vet/v1` 报告标准 | 不做跨版本 API 面比对 |
| `dsh-plugin-vetting`（npm） | 静态启发式扫描：恶意模式、越权路径、未检查依赖 | 不做许可证交叉核验、不比对本机版本 |
| `dsh-stability-audit`（npm） | 扫**已装**插件的稳定性风险：钩子面、启动任务、依赖 | 不判 peer 区间是否匹配本机 |
| 运行时兼容垫片（`@dsh-plugin/dsh-loader` 等） | 运行时兜底，让第三方 bundle 与官方解耦 | 是**运行时**兜底，不预测"升级后谁会坏" |

> ⚠️ **别把官方 `cordis_inspect_*` 忘在一边。** 它随官方 `tool-cordis` 一同提供（若本机装了 cordis 相关 bundle 就有），是**查询当前运行时真实契约的最强手段**——比任何静态扫描都准，因为它是运行时事实而非源码推断。凡是"现在这个服务/slot/工具到底长什么样"的问题，优先问它。

**它们都没做的事**（也就是 `dsh_plugin_audit` 的定位）：把插件的**声明区间 + 实际 API 调用面**与**本机 dsh 构建**做逐条比对。注意：官方明确声明 API **pre-stable**（见 §3 末），所以任何"预烘焙的兼容性数据集"都会迅速过期——这正是本工具坚持**运行时现算、不存快照**的原因。

**和官方 `cordis_inspect_*` 的分工**（互补，不是竞争）：

| | 官方 `cordis_inspect_*` | `dsh_plugin_audit` |
|---|---|---|
| 回答 | 当前运行时**有什么可用** | 磁盘上插件的声明**和本机构建对不对得上** |
| 时机 | 进程运行中 + 插件已加载 | **离线**，任意时刻（装完/升级完核验，装前预判层能否挂载） |
| 对象 | 活体服务 / 事件 / slot / 工具 | 已装或待装插件的声明与调用面 |
| 插件加载失败时 | **看不见它**（它不在活体里） | 能指出它缺什么 |
| 能否预测一次**未来**升级 | 不能 | **也不能**——它只看得到本机**已装**的那个构建 |

关键差异：插件停在 `waiting`（加载失败）时，官方 inspect 帮不上忙——那个插件压根不在活体运行时里。这种"坏了但还没跑起来"的情形，用本工具。

**两者都不预测未来。** "升级后谁会坏"这个问题的诚实答案是：**升完再跑一次**。本工具能给你的前置信号只是"现在谁已经对不上了"——那说明它很脆，但不等于它会坏；反之亦然。

### 已收录插件

收录门槛：已发布 npm、许可证宽松、通过 §3 检查。收录不等于推荐。

| 插件 | 类别 | 活跃度 | 已核实事实 |
|---|---|---|---|
| `dsh-llm-local-token`（npm） | provider / 模型路由 / 凭据 | 3 stars；2026-08 创建，最近推送 2026-09 | bundle+client；读取本机 Codex CLI 与 Claude Code 的 OAuth 凭据，注册 `openai-codex`、`anthropic` 路由（token 按请求解析、临期自动刷新，交给 dsh 自带 pi-ai 引擎）；面板读 provider 限流响应头、按计划刷新展示订阅剩余额度（含 GLM Coding Plan）；缺凭据的路由跳过而非启动失败；MIT、Node >=22.13.0、web profile、无 install 脚本。安装：`dsh plugin --profile web add dsh-llm-local-token` |

**本地实测记录（2026-09，dsh `0.1.5-rc.1` / Windows）**：安装 904ms 完成并自动进入 `dsh.profile.bundles`；供应链复验 7 个 lib 文件与 npm tarball SHA-256 全部一致；`import()` 加载正常。

**⚠️ 但它的 `peerDependencies` 区间实际不满足**：声明 `@deepseek-ai/dsh-llm@^0.1.0-rc.6`、`dsh-llm-pi-ai@^0.1.0-rc.6`，而本机是 `0.1.5-rc.1`——按 rc semver 规则**不匹配**（见 §3）。`dsh_plugin_audit` 会把它判为 `at-risk`。代码当前可用，但它挂的是 LLM 引擎行（rc 期内部 API），升级 dsh 前必须重新核对。

## 3. 评估插件（安装前必做）

安装前检查包内容；**命中危险信号时停下，向用户确认后再继续**：

- `package.json` — 名称、`dsh.bundle` / `dsh.client` manifest、许可证（宽松：MIT/Apache/BSD；GPL/AGPL/未知许可证需提示）
- `cordis.patch.yml` — 插入哪些行、注册什么
- main 入口源码 — 是否执行网络请求/子进程等可疑行为
- **活跃度** — stars 数量与最近提交时间：停更超一年且 star 少的项目谨慎采用
- **维护者弃养声明** — 读 README 顶部：部分作者会明确写「无法及时适配新 API，崩溃请自行修理」。这不是拒绝安装的理由，但必须**告诉用户**：未来升级 dsh 后可能需自行修复或卸载
- 用索引源（§2）检索时，直接过滤 `archived: true`、`fork: true`、许可证缺失、`pushed_at` 过老的条目

### ⚠️ 不写版本号：npm latest ≠ 仓库 main

npm 发布与仓库 main 是两条独立推进的线，钉死版本号必然过期（实测某包 npm 为 `1.5.1`、仓库已 `1.6.1`）。

1. 描述插件时只写包名，让 pnpm 解析最新版；要装用 `add <包名>`。
2. 确需引用版本时，当场核实并标注日期（如「截至 2026-09 为 1.6.1」）。
3. 两个来源不一致时都要说明，不要只报一个数字。
4. `dsh plugin update` 报「已最新」但 `npm view` 有新版：多半是 pnpm `minimumReleaseAge` 拦截，见 §4。

### ⚠️ 许可证判定：不要信 GitHub 徽章

GitHub 的许可证识别（网页徽章与 API `license.spdx_id`）会把仓库内 vendored 的第三方文件误判为主许可证。实测有仓库徽章与 API 均报 AGPL-3.0，但 `LICENSE` 全文与 npm 包 `license` 字段都是 MIT。

只要仓库含其他协议的第三方文件（vendored 代码、字体、图标、生成物）就可能触发，因此任何仓库都须交叉核验：

1. 读仓库 `LICENSE` 全文首行（不是徽章）
2. 读 npm 包 `license` 字段（`npm view <pkg> license`）
3. 不一致时以 1、2 为准，并说明分歧

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
  - 脚本逻辑规范不等于该用它：实测有仓库的 `install.ps1` 写法克制、幂等、注释清楚，但同名 npm 包已发布，用 npm 装仍更优（无需绕过依赖管理）

确认时说明发现的具体信号与风险，由用户决定是否继续。

### API 兼容性核查（第三方 UI/工具插件安装前建议做）

社区插件针对某个 dsh 版本区间开发，而 dsh 自身在快速迭代。**「能装上」不等于「装上能跑」**——尤其 UI 类插件（皮肤/主题/面板）会直接调用官方 client API。

**先跑工具**（§0）：装之前的包用 `dsh_plugin_inspect`（联网，把 tarball 拉下来审）；已经装上的用 `dsh_plugin_audit`（离线）。两者把下面 1-3 步自动化了。需要手工复核或工具不可用时，按下列步骤做。

**关键：官方 `@deepseek-ai/*` 包不在 profile 的 `node_modules` 里。**

profile 的 `node_modules` 只有「profile 自己安装的依赖」（能用 `node_modules\.modules.yaml` 的 `hoistedLocations` 确认）。官方包从 **dsh 安装根**解析，所以这样查本机 API 版本：

```bash
# 1) 本机 dsh 版本（安装根）
node -p "require('<dsh 根>/package.json').version"
# 2) 本机官方包实际版本
#    源码部署：<dsh 根>/packages/**/package.json 与 <dsh 根>/vendor/*/package.json
#    打包部署：<dsh 根>/node_modules/@deepseek-ai/<name>/package.json
node -p "require('<dsh 根>/packages/client/ui-slots/package.json').version"
```

> 注意 `vendor/`：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 等**不在 `packages/` 而在 `vendor/`**。只扫 `packages/` 会把它们误判为「不存在」，进而把一堆正常插件误判为不兼容。

**核查步骤**：

1. 读插件 `package.json` 的 `peerDependencies`（它声明支持的区间，如 `^0.1.0-rc.5`）。
2. 取本机实际版本（上面的命令），**判断是否落在区间内**。

   ⚠️ **rc 预发布有特殊语义，这是最容易判错的一步**：预发布版本**只有**在区间中某个比较器的 `major.minor.patch` 与它**完全一致**、且该比较器自身带预发布标签时才可能满足。

   | 区间 | 本机版本 | 结果 |
   |---|---|---|
   | `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ **不满足** |
   | `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ **不满足** |
   | `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ 满足 |
   | `^0.1.0-rc.5` | `0.1.5` | ✓ 满足（正式版无预发布，不受该规则限制） |

   为什么：`^0.1.0-rc.5` 展开为 `>=0.1.0-rc.5 <0.2.0-0`，比较器的 tuple 是 `[0,1,0]` 与 `[0,2,0]`；而 `0.1.5-rc.1` 的 tuple 是 `[0,1,5]`——**两者都不匹配**，所以它被预发布规则挡下。`>=0.1.0-rc.5` 的上界挡不住它，下界也不挡，挡它的是这条预发布规则。
   （上表用 npm 官方 `semver` 7.7.4 实测得出；pnpm 用的是同一套语义。）

   ⚠️ **因此：pnpm 报 `Issues with peer dependencies found` 时，它是对的。不要"忽略这个警告"。** pnpm 默认不阻断 peer 不满足的安装，所以插件能装上，但区间确实不满足——这两件事互不矛盾。

3. **更进一步：确认它调用的具体 API 还存在**。分两层：

   **① 具名导出**：插件写 `import { PiAiAdapter } from '@deepseek-ai/dsh-llm'`，只有当那个包**仍然导出** `PiAiAdapter` 时才成立——包还在、符号被改名或拆走，同样是**链接期抛错**，不是降级。工具会自动做这件事，但手工核的时候要知道它为什么不能靠 grep：

   - 官方声明是 barrel，且 TypeScript 保留源码扩展名：`export * from './attribution.ts'`，而实际与它同目录发布的是 `attribution.d.ts`。单文件 grep 会把每一条 re-export 的符号都报成「已移除」。
   - 所以要**递归**走完相对 re-export（含 `.ts`/`.js` → `.d.ts` 映射）、再递归走裸 specifier 指向的其他包，最后与运行时入口（`main` / `exports` 的 `default`）的 `export { … }` 列表取并集。
   - **只在图完整解析、且该名字在两处都找不到时，才可以说「已移除」**；解析不了就是 `unknown`。
     手工起点：`node -e "console.log(require('<dsh 根>/node_modules/@deepseek-ai/dsh-llm/package.json').exports['.'].types)"`，从那个 `.d.ts` 开始看。

   **② slot 契约**：UI 类插件常用 `ctx.slots.register` 注册设置卡片，slot 名是硬契约。验证有两条路，**优先用第一条**：

   - **进程正在运行** → 用官方 `cordis_inspect_query`（见 §2）：`Slots.listSubTree` 先不给 root 列出目录，再查具体 root 拿完整注册契约与 props。这是**运行时事实**，比读源码准，而且能看到浏览器端真实 slot 树——静态扫描永远看不到这一层。
   - **离线 / 本机没装 cordis 工具** → 在 dsh 源码里 grep slot 名：
     ```bash
     # 插件里读到的 slot 名，例如 settings.plugin.item
     grep -rn "settings.plugin.item" <dsh 根>/packages/client --include=*.ts --include=*.tsx
     ```
    slot 名/契约若已被改名或移除，插件会静默失效或报错。
4. 结论要如实说：**「现在能跑，但作者已停更 N 周、且声明不跟进 API，未来升级 dsh 可能要自行修复」**——把风险讲清楚，由用户决定。

> **静态扫描 vs 运行时 inspect，怎么选**：问的是"**这个插件**的声明对不对" → 用 `dsh_plugin_audit`（离线即可，能覆盖没装/装不上的插件）；问的是"**现在运行时**某个服务/slot/工具到底长什么样" → 用官方 `cordis_inspect_*`（运行时事实，含 client 侧）。两者互不替代。

### 工具做不到什么（诚实边界）

两个工具只报它们**真的能判定**的事，无法判定的会明写 `unknown`，不会猜：

- **client slot 的运行时形状**：工具只能读官方**源码**里的 slot 名集合，读不到浏览器端实际的 slot 树。名字对不上就是硬信号；名字对得上也不保证 props 契约没变。**但这不等于查不到**——官方 `cordis_inspect_query` 的 `Slots.listSubTree` 能在运行时拿到真实的 slot 树与 props（见 §2）。所以「某 slot 的 props 契约到底变没变」这类问题应该问官方 inspect，而不是本工具。
- **导出的具体符号，边界在哪**：核对**是**做了，但只在能证明的范围内。`dsh_plugin_audit` / `dsh_plugin_inspect` 会走完声明图并核对运行时导出列表；只有图**完整解析**、且该名字在声明与运行时入口都找不到时，才报 `incompatible`。图不完整（某个 re-export 指向的包不在本机、没有 `types` 入口、`export =` 形式……）时一律报 `unknown` 并列出原因。类型专用 import（`import type …`、行内 `type X`）不参与核对——它们被构建期抹掉，不可能导致运行期失败。**CJS 里靠 `require()` 取属性的用法**（`require('pkg').Foo`）也拿不到名字，不参与核对。
- **不在本机的包**：如 `react`、外部 npm 依赖，本机查不到版本就无法判定区间。
- **`ctx.<service>` 的静态注册表**：服务名在运行时才能确认；运行时也拿不到时会报 `unknown`。
- **没有 dsh 源码树时的"包缺失"判定**：此时包集合只来自 `profiles/node_modules`（dsh 启动时修复的运行时解析图），它**比源码树少**（尤其缺 client 侧包）。所以工具会把"某包不存在"降级为 `at-risk` 并注明需复核，而不是断言它被移除。有源码 checkout 时判定才是硬的。
- **`dsh_plugin_inspect` 的固有边界**：它看到的是 tarball 里的静态文件，**看不到构建产物**。若仓库只发布源码、由安装脚本现场构建，它审的就不是最终运行的那份代码——这种情况报告里的 `installer-script` 信号会提醒你。它也不做恶意代码判定，只做**风险信号**（lifecycle、`eval`、网络、shell、自带安装脚本），判读由你负责。

### 官方对 API 稳定性的真实态度（决定了本生态的性质）

读 dsh 安装根的 `README.md` 与 `AGENTS.md`，官方是**明确声明不做稳定性承诺**的：

- `README.md` — "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."
- `AGENTS.md` — "Public APIs are pre-stable; update every consumer."

实践含义（实测：一个月内发布了 16 个 `0.x` 预发布，约每周一次破坏性变更）：

- 任何**缓存/快照式的兼容性数据**（包括本工具不做的"预烘焙数据集"）都会迅速失真——所以核查必须**当下现算**。
- 社区插件的 peer 区间**普遍滞后于 dsh 实际版本**，`at-risk` 是常态而非异常。
- 因此"升级 dsh 前先跑一次核查、升完再跑一次"应成为固定动作，而不是一次性判断。

## 4. 安装插件（含提速原则）

**装之前先看权限与内容，再决定装不装**（§3）。想省事就让工具做：`dsh_plugin_inspect({ spec: '<包名>' })` 会把 tarball 拉下来，核对 registry 的 integrity，走完层完整性、peer 区间、具名导出、slot 契约与安装期风险，然后删掉临时目录——**不装、不写 profile、不跑 lifecycle 脚本**。看到 `incompatible` 就别装；看到 `at-risk` 把原因讲给用户听。

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
3. **核对兼容性**：跑 `dsh_plugin_audit({ target: '<包名>' })`，确认 verdict 与 blocker/risk 项，把风险如实告知用户。（装**之前**想先看一眼，就用 `dsh_plugin_inspect`——它联网，会把 tarball 拉下来审，结论口径与审计一致。）
4. **确认层能挂载**（这一步能挡住"装完 dsh 起不来"）：`dsh_plugin_audit` 输出的 `layer` 行必须是 `readable` 且 `in dsh.profile.bundles`。若显示 `MISSING`，说明包里没有它声明的 patch 文件；若显示 `NOT in dsh.profile.bundles`，说明层不会被应用——**在重启 dsh 之前修掉**，否则前者会让 profile 直接启动失败。成因通常是绕开 `dsh plugin add` 装了包
5. **供应链复验（可选但推荐）**：比对落盘文件与审计过的产物是否同一份——npm 装的用 `npm pack` / registry tarball 下载解包后比 SHA-256：
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<安装后路径>/lib/client.js')).digest('hex'))"
   ```
   哈希一致 = 审计的和装上的确实是同一个东西（排除安装环节掉包）。对来源可疑或 star 少的插件尤其值得做。

**重启后**：

6. skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板
7. 若更新无效果：按 §4 供应链策略排查 minimumReleaseAge
8. **装完告知用户回滚路径**：安装前备份 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`，或直接 `dsh plugin --profile web remove <包名>`。UI 类插件出问题会导致界面异常，用户需要知道怎么退回去

## 6. 约束与边界

- **不做推荐**：不推荐、不排序、不背书任何第三方插件或市场（见 §2「立场」）。本文档出现的包名仅为事实实例，不构成推荐；用户问「用哪个」时给出事实与取舍，由用户决定。
- 本 skill 与 `dsh_plugin_audit` / `dsh_plugin_inspect` 两个工具由 `dsh-community-plugins` 插件注册提供；能读到本 skill 即说明插件已生效。
- **联网能力与离线能力是两个工具，不要混淆**：`dsh_plugin_audit` 承诺不联网（这是它的价值所在，不提供联网开关）；`dsh_plugin_inspect` 是唯一联网的那个，且只发起只读 GET——不发凭据、不装包、不写 profile、不执行 lifecycle 脚本、解包后删临时目录。要装包却只想先看一眼，用它；只是想知道本机现状，用离线那个。
- **不改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；要改就复制成用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 装完插件要重启才生效；动态插件（cordis_define 等）只活在当前进程，不属社区插件。
- **审计结论不是保证**：`compatible` 只表示"工具能查的项都通过了"，不表示运行时一定无问题；`at-risk` 是常态。**但工具内部区分了两类判据**：`blocker` 里的层完整性、包存在性、具名导出存在性、slot 存在性来自 package.json、文件系统与包的导出图，是精确事实（且导出符号只在图完整解析时才下断言）；source 扫描出来的风险信号（lifecycle、`eval`、网络、自带安装脚本）是启发式提示，需要你自己判断。`dsh_plugin_audit` 不联网、不写文件、不执行被审计插件的任何代码。
- 本插件源码在 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：改 `skills/dsh-community-plugins/SKILL.md` 即时生效（每次发现从磁盘重读），无需重装；改 `lib/` 或 `index.js` **必须重启 dsh**（`cordis.patch.yml` 的 live reload 不重载模块）。
