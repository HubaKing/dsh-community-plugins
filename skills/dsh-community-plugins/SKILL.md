---
name: dsh-community-plugins
description: DeepSeek Harness 社区插件生态指南：发现（GitHub dsh-plugin topic 检索、策展索引、npm）、评估与安装社区插件（仓库名≠npm 包名、许可证交叉核验、peer 区间与 rc 预发布 semver 语义、具名导出与 slot/服务契约核查、安装脚本风险、bundle 机制、tarball），含安装提速与供应链策略。本插件同时注册两个工具：dsh_plugin_audit 离线审计**已装**插件，dsh_plugin_inspect 联网下载 tarball 审计**尚未安装**的插件。Use when the user asks to find, browse, install, update, or remove community plugins/extensions/skins/themes/skills for this harness, asks what community plugins exist, asks whether a plugin is safe to install, or asks whether upgrading dsh will break installed plugins.
---

# DSH 社区插件：发现、评估与安装

**桌面版适配声明**：本插件全面适配 DSH 桌面版（DeepSeek Harness Desktop）。其安装与判定均默认跟随「正在运行的 profile（配置档）」：判定基准取自运行时 `profileContext` 服务的 `name` 与 `dir`，审计报告头部的 `profile <名字>` 即该基准。`desktop` 与 `web` 属并列 profile，安装必须指向正在运行的那一个；安装至非运行 profile 时，bundle 层（bundle layer）、依赖与 `dsh.profile.bundles` 各项均正确，界面不会发生任何变化。

本 Harness 运行 DeepSeek Harness（dsh）。社区插件生态围绕 GitHub 的 `dsh-plugin` 话题与 npm 上的 `dsh-*` 包展开。操作前应先确认本机实际安装内容，不作假设，也不绑定单一市场。

## 0. 先用本机审计工具（若已注册）

本插件注册**两个**宿主工具，职责按「插件是否已安装」划分：

| 工具 | 用途 | 网络 |
|---|---|---|
| `dsh_plugin_audit` | **已安装**插件：与本机 dsh 构建逐条比对 | 全程不联网 |
| `dsh_plugin_inspect` | **未安装**插件（npm 包 / `github:owner/repo` / tarball 直链）：下载、校验、解包至临时目录后判定，随后删除 | **联网**（只读 GET） |

判定规则：**尚未安装的包使用 `dsh_plugin_inspect`；已经安装的包使用 `dsh_plugin_audit`。** 两者使用同一套判定引擎与同一个「本机 dsh 构建」参照系，因此结论口径一致。离线审计不提供任何联网开关——它承诺不联网，该承诺不应附带条件。

### 0.1 `dsh_plugin_audit`（离线，已安装插件）

该工具在**本机离线**完成 §3 中绝大部分静态核查，且不依赖任何预烘焙数据集；结论始终反映本机当前的 dsh 构建：

| 它报告的内容 | 依据 |
|---|---|
| **插件的 bundle 层能否挂载**（决定 dsh 能否启动） | `dsh.bundle.patch` 指向的文件是否存在、是否登记进 `dsh.profile.bundles`（见下） |
| 已安装插件的 `peerDependencies` 区间是否匹配本机版本 | 逐包比对，含 rc 预发布语义（§3 的关键判据） |
| 插件 `import` 的 `@deepseek-ai/*` 包在本机是否仍然存在 | 扫描安装根（dsh install root）的 `packages/` 与 `vendor/` |
| **这些 import 所需的具名导出是否仍被导出** | 逐包走完声明入口的 `export *` 图（含 `.ts` 后缀的 re-export），再与运行时入口的导出列表取并集 |
| 插件注册的 slot 名是否仍在官方源码中 | 从官方 client/core 源码提取 slot 契约 |
| 插件 `inject` 的服务在运行时是否可解析 | 直接读当前 Cordis 上下文（活体上下文，live Cordis context） |
| 安装期风险信号 | lifecycle 脚本（按安装来源分级：`preinstall` / `install` / `postinstall` 于 registry 安装时执行，`prepare` / `prepublishOnly` 仅于 git 或本地安装时执行）、动态代码、shell 执行、网络请求 |
| **插件是否已生效（区别于是否已安装）** | 调用进程的启动时刻与 profile 配置文件、各插件目录的 mtime 比对；晚于启动时刻写入的 bundle 层不在该进程的图层内（提示项，不改变结论，见 §7） |

```
dsh_plugin_audit({})                          # 审计 profile 里全部第三方插件
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # 只审计一个（包名或目录路径）
```

判定结论：

- **`incompatible`** —— 硬证据：它所需的包、**具名导出**或 slot 在本机已不存在，**或其 bundle 层无法挂载**（见下文启动失败项）。
- **`at-risk`** —— 声明的区间已不匹配、层未被组合进去，**或 dsh 自带的版本门禁（version gate）会在启动时禁用它**。该状态是本生态的常态；同时需注意 dsh 版本差异：**自 `0.2.0-rc.2` 起，自带的版本门禁会使 `dsh plugin add` 直接拒绝** peer 不匹配的包（见 §3「版本门禁」与 §4）。因此旧文档中「pnpm 不阻断、可以安装」的表述在新版本上不再成立。
- **`unknown`** —— 需要联网或 client 侧才能确认的项（见 §3「工具做不到什么」）。

**两条关于沉默的纪律**：报告中出现 `peers: N declared …` 与 `gate: …` 两行属于刻意设计——**「未发现任何 peer」与「未声明任何 peer」是两件不同的事**，只打印失败项会使二者在外观上相同。`gate:` 行判定的是 dsh 自身是否会加载该行（见下）。

**符号级核对的判读**：`incompatible` 中的「does not export」是有条件的硬结论——只有当该包的导出图**完整解析**、且该名字在声明入口与运行时入口中均不存在时才会报告。图不完整时报告 `unknown`，并列出未解析到的 re-export。该区别是本工具的核心纪律：**「未解析到」不等于「该符号已不存在」**。实测记录（2026-09，dsh `0.1.5-rc.1`）：279 个官方包中 276 个导出图完整解析，1874 个运行时导出名逐一核对，0 个未确认；其余 3 张图报告 `unknown`。

### ⚠️ dsh 无法启动时，优先核查本项

下列三种情形的上游行为是**抛错**而非降级——**profile 直接无法启动**，且在社区插件中较为常见：

| 情形 | 上游行为（源码位置） |
|---|---|
| 声明了 `dsh.bundle.patch`，但包内不存在该文件 | `failed to read overlay` → 抛错（`packages/boot/app-boot/src/index.ts:315-323`） |
| 声明了 `dsh.bundle` 却未写 `patch` | `declares no dsh.bundle` → 抛错（`packages/boot/app-boot/src/profile.ts:792-797`） |
| `dsh.profile.bundles` 中列入了无法挂载的包 | 层解析失败 → 抛错（同上） |

另有一种**不报错但完全无效**的情形：插件带有可读的 patch，但未被登记进 `dsh.profile.bundles`——**其层永远不会被应用**。常见成因是绕开 `dsh plugin add`、直接在 profile 目录中执行 `pnpm add`（`dsh plugin add` 会调和该列表，`pnpm add` 不会：`apps/cli/src/plugin.ts:59-91`）。

工具会将上述各条报告为 `blocker` / `risk`，并在每个插件下打印一行 `layer <路径> — readable|MISSING, in|NOT in dsh.profile.bundles`。**判据是精确的**：全部来自 package.json 与文件系统，而非启发式推测。

**工具不在工具列表中？** 两种情形，原因不同，不得当作「插件未安装」：

| 现象 | 原因 | 处置 |
|---|---|---|
| 完全没有 `dsh_plugin_audit`（通常 `dsh_plugin_inspect` 一并消失） | 该部署未组合 `tools` 服务（`tools` 由 bundle 配置的 `- id: tools` 行装配）。未组合时两个工具**静默降级**——skill 照常可用，仅工具缺失 | 按下文各节人工核查，结论口径一致 |
| 不在原生工具列表，仅能经 `run_code` 调用 | 部署设置了 `DSH_TOOLS_MODE=ptc`；该模式下模型仅直接可见 `run_code`，其余工具经生成的 SDK 可达 | 经 `run_code` 间接调用；或改回默认 `native` |

该工具声明了 30s **协作式**超时预算：超时会中止扫描（在文件边界检查取消信号）并如实报错，不返回不完整的报告。工具全程不联网、不写文件、不执行被审计插件的代码。

### 0.2 `dsh_plugin_inspect`（联网，安装前）

```
dsh_plugin_inspect({ spec: 'dsh-llm-local-token' })          # npm，最新版
dsh_plugin_inspect({ spec: '@scope/pkg@^1.2' })              # npm，指定区间
dsh_plugin_inspect({ spec: 'github:owner/repo#v1.2.0' })     # 仓库
dsh_plugin_inspect({ spec: 'https://host/pkg.tgz' })         # tarball 直链
dsh_plugin_inspect({ spec: ['pkg-a', 'pkg-b', 'pkg-c'] })    # 预筛多个候选（不下载包内容）
```

**`spec` 传数组即为预筛模式（screening mode）**：候选较多时（例如由 topic 检索得到数十个皮肤），先用它收窄候选池，再对通过的包使用单个 `spec` 做完整审计（full audit）。该模式**只读 registry 文档，不下载任何包内容、不解包、不读代码**，因此能判定的仅有三项：声明的 peer 区间、dsh 的版本门禁、manifest 中的 lifecycle 脚本；无法判定的项（bundle patch 文件、slot、具名导出、inject 服务名）在报告的 `limits` 中一次说明，不作猜测。判定与措辞与 `dsh_plugin_audit` 完全同源（同一批函数），两处结论一致。

> ⚠️ **它读取的是 registry 的完整文档，而非 npm 的精简文档。** 此点必须固定：请求头一旦携带 `application/vnd.npm.install-v1+json`，registry 会丢失 `dsh` / `scripts` / `license`（实测字段数 3–6 对 25–28），于是形态一律被读成 `cordis`、license 恒为 null，**且「判定 lifecycle 脚本」这一承诺会静默失效**。

其执行步骤，以及**为何值得在安装前付出这一次网络开销**：

| 步骤 | 细节 | 重要性 |
|---|---|---|
| 解析 | 读 registry 文档，选出**一个具体版本** | 报告能够说明判定的是哪个版本，而非「最新」 |
| 下载 | 流式下载 tarball，上限 64 MiB | 有界 |
| 校验 | 在解包**之前**核对 registry 公布的 `integrity`（sha512/384/256）或 `shasum` | 确保审计对象与安装对象为同一份字节 |
| 解包 | 解至临时目录，**每条退出路径**均删除 | 不留残留；路径穿越、绝对路径、symlink/hardlink 条目、谎报大小的头部、解压炸弹一律拒绝并报告 |
| 判定 | 与离线审计使用同一套引擎，针对同一个本机 dsh 构建 | 口径一致；且**不会**因为「包尚未登记进 `dsh.profile.bundles`」而误报（登记是 `dsh plugin add` 的职责） |

其**不执行**的操作，使用前需明确：不安装任何内容、不写 profile、不执行包的 lifecycle 脚本。`postinstall` 会被报告为高危发现，而不会被服从。报告还会标出**仓库自带的独立安装脚本**（`install.sh` / `setup.ps1` / `deploy.*`）——该类脚本直接改写 profile、手工将包链入 `node_modules`，绕过 `dsh plugin` 的依赖管理，此后 `update` / `remove` 无法管辖（§3 有详述）。

**lifecycle 脚本按安装来源区分**（判据）：`preinstall` / `install` / `postinstall` 在 registry 安装时执行；`prepare` / `prepublishOnly` 仅在 git/local 安装与发布流程中执行，registry tarball 安装不执行。因此审计报告须区分「registry 安装时执行」与「仅 git/local 安装时执行」，不得将仅适用于 git 安装的 `prepare` 一律列为安装期高危项。实测记录（2026-09-30，Windows，dsh `0.2.0-rc.2`）：有包的 manifest 声明 `prepare: node scripts/build.mjs`，但其 tarball 并未包含 `scripts/` 目录，说明该脚本在 registry 安装路径上不可能执行。

> ⚠️ **这是本插件唯一联网的部分。** 不得用它查询「本机已安装内容的状态」——该问题属于 `dsh_plugin_audit`，且不需要网络。

## 1. 先看本机已装什么

### ⚠️ 第一步：确认**正在运行的是哪个 profile**

`${DSH_HOME:-~/.dsh}/profiles/` 下可能同时存在多个 profile（实测记录：`desktop` 与 `web` 并存），而**安装必须指向正在运行的那一个**——安装至另一个 profile 时，bundle 层、依赖、`dsh.profile.bundles` 全部正确，界面却**毫无变化**（实测记录：皮肤安装进 `web`，而桌面应用组合的是 `desktop`，现象与「插件失效」完全一致）。

**确认方法**（按可靠性排序）：

1. **询问运行时**：`dsh_plugin_audit` / `dsh_plugin_inspect` 默认采用**本进程正在运行的 profile**（读官方 `profileContext` 服务的 `name` / `dir`），报告头部的 `profile <名字>` 即为答案。
2. **查看进程启动参数**（最硬的证据）：宿主进程会将 profile 目录作为参数传入：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek%'" |
     Where-Object { $_.CommandLine -match 'profile' } |
     Select-Object ProcessId, CommandLine | Format-List
   # 形如 …dsh-desktop-host/lib/index.js …app.asar\dsh  C:\Users\HubaKing\.dsh\profiles\desktop  …
   ```
3. **比较 profile 目录 mtime**：`Get-ChildItem "$env:USERPROFILE\.dsh\profiles"`。启动时被组合的 profile，其 `cordis.yml` 会在进程启动时刻被改写；若此后发生过 `dsh plugin add` / `remove`，该文件会被再次重写，其 mtime 将晚于进程启动时刻。实测记录（2026-09-30，Windows，dsh `0.2.0-rc.2`，profile `desktop`）：宿主进程启动于 03:31:42，`cordis.yml` 于 03:37:28 因一次 `remove` 操作被重写，而运行进程的图层集仍以 03:31:42 的组合结果为准（判定方法见 §7）。

**命令行上的对应关系**：`dsh plugin --profile <名字> add …`。安装前应确认该名字是否为**正在运行的那个**；安装并重启后仍无效果时，第一项应复查此处，而非先怀疑插件本身。

### 再看已安装内容

在**正确 profile** 的 `package.json` 中：`dsh.profile.bundles` 列出生效的 bundle 层，`dependencies` 列出已安装的插件依赖；**以实际读取的结果为准**，不得将文档提及的插件视为已安装。

关于 `node_modules`：profile 的 `node_modules` 中**仅有 profile 自身安装的依赖**（含 `dsh plugin add` 安装的社区插件），**不含官方 `@deepseek-ai/*` 包**——后者从 dsh 安装根解析（查询本机 API 版本见 §3）。若需确认 profile 的实际安装内容，亦可读 `node_modules/.modules.yaml` 的 `hoistedLocations`。

官方基线（profile 模板自带，非社区插件）：

- `@deepseek-ai/dsh-base` —— 官方宿主核心（工具、持久化、策略等基础行）
- `@deepseek-ai/dsh-web-app` —— 官方 Web 表层（浏览器宿主、前端产物）

若本机已安装市场类插件（§2 列出的安装器或面板），应优先使用其自带工具；未安装时按 §2 渠道查找。除用户明确要求外，不主动推荐或引导安装某个市场。

## 2. 发现渠道与市场选择

首先明确需求类别：**skill 类**（知识/流程）、**工具类**（模型工具/能力）、**UI 类**（Web 界面/皮肤）、**集成类**（外部服务/渠道）、**provider 类**（模型路由/凭据）。按类别检索命中率更高。

### 发现渠道

1. **本机已安装市场的工具/面板**（以 §1 实测为准）：自带搜索/安装工具者可直接调用。
2. **策展索引 `awesome-dsh-plugin/awesome-dsh-plugin`（CC0）**：仅做检索，不安装、不执行代码。用于扩大候选池，条目仍须按 §3 核查。
   - 权威清单位于仓库 `README.md`（实测记录 2026-09：约 3,400 条 / 20+ 品类 / 2,200+ 独立维护者；该数字会变化，并非固定值）。
   - 机器可读数据位于 `data/plugins/<owner>__<repo>.yml`（每个维护者一个 YAML）与 `data/stars.json` / `data/downloads.json` / `data/added-dates.json`。
   - ⚠️ **YAML 覆盖面小于 README 条目数**（实测 README 3,400+ 条，YAML 约 1,000 个文件）。需要全量候选时使用 README，需要结构化字段时使用 YAML，不得假设两者等价。
   - ⚠️ **不得使用 GitHub API 的 `/readme` 端点抓取 README 做统计**——该端点会**静默截断**（实测仅取得约一半内容，据此统计会得出错误结论）。应使用 `/contents/<path>` 端点、base64 解码，并校验返回的 `size`。
   - ⚠️ YAML schema 仅记录 `url / name / category / description`，**不含** license、peer 区间、安装脚本、兼容性判定——这些必须自行核查（§3）。
3. **GitHub topic 检索（按类别查找插件的主要渠道）**：以 topic 加类别词检索，一次取得带 stars 与推送时间的候选池，精度高于通用 web_search。
   ```
   https://api.github.com/search/repositories?q=topic:dsh-plugin+skin&sort=stars&per_page=30
   ```
   将 `skin` 替换为类别词（`theme` / `ui` / `memory` / `mcp` / `skill` / `tui` 等）。宽泛词候选较多但噪声较大，具体词精度更高。中文关键词可直接 URL 编码。
   ⚠️ `topic:dsh-plugin` 本身**噪声极大**（实测命中上万仓库，混入大量无关项目），必须叠加类别词或 `in:name` 收窄。
   ⚠️ 部分机器的 shell 直连外网被阻断（curl/git 失败），此时应使用 Node.js https 通道（`node -e` 内 `https.get`）；`raw.githubusercontent.com` 在部分网络下同样被阻断，可改用 `api.github.com` 的 `contents` 端点。GitHub API 未认证时会限流（403），应节约调用。
4. **web_search**：检索 `dsh-plugin` 话题与 npm 的 `dsh-*` 包（通用兜底）。
5. **npm**：`npm view <包名>` 查询版本、许可证、依赖。`<包名>` 必须是 `package.json` 的 `name`，而非仓库名（见下节）。

> **需要的是包名时，不应从 GitHub 反查，应直接检索 registry。** 按关键词检索 npm 可一次取得**包名**、描述、版本与发布日；而「GitHub 仓库 → 读 `package.json` → 得到包名」的路径对每个候选需 2 次 API 调用，且**未认证时会限流**（实测 8 个候选之后开始返回 403）；registry 检索不存在对应的限流。实测顺序应为：**先以 `npm search` 取得包名与候选池 → 再以 GitHub topic 补充 stars / 维护活跃度 / 许可证全文**。
>
> ```bash
> # 一次取得最多 100 条：包名、版本、描述、发布日；随后按 §3 的方法筛选
> curl -s "https://registry.npmjs.org/-/v1/search?size=100&text=dsh%20glass" | head -c 400
> # 在 Node 中更便于使用：GET https://registry.npmjs.org/-/v1/search?text=<关键词>&size=100
> #   条目结构：objects[].package = { name, version, description, date, keywords, links }
> # 以描述中的类别词（glass / 玻璃 / 磨砂 / 主题 / 皮肤 / memory / mcp …）收窄
> ```
> 实测记录（2026-09，dsh `0.2.0-rc.2`）：为筛选「液态玻璃」皮肤，62 个玻璃类 dsh 包仅凭几个关键词的 registry 检索即全部取得；同一候选池若经 GitHub 反查则需上百次 API 调用。

### ⚠️ 仓库名与 npm 包名不等

`dsh plugin add` 使用 `package.json` 的 `name`，而非 GitHub 仓库名。二者常完全不同；按仓库名查询 npm 会得到假 404，从而误判为「未发布」。

常见差异形态：

| 形态 | 表现 |
|---|---|
| 名称完全不同 | 仓库名与包名无字面关系（最常见） |
| 带 npm scope | 包名为 `@<scope>/<name>`，scope 与作者/组织名可能不同 |
| 后缀不同 | 包名是仓库名的变体（增删词、改后缀） |

**流程**：读取仓库 `package.json` 的 `name`（使用 `api.github.com/repos/<owner>/<repo>/contents/package.json` 并 base64 解码）→ 以该名称查询 npm。

monorepo 注意：根 `package.json` 可能无 `name`，或仅是总包；真正的插件包位于子目录（如 `packages/<name>/`）。此时应分别读取各子包的 `package.json`。

### 立场

不推荐、不排序、不背书任何第三方插件或市场。理由：该生态变化较快，任何排名都会过期。

- 用户询问「哪个插件好」时：列出候选，逐条给出事实（形态、许可、活跃度、风险），结论由用户作出。
- 本文档出现的包名仅为事实实例，不构成推荐。
- 任何第三方插件一律按 §3 独立核查，不因在本文档中出现过而降低标准。

### 市场/安装器核查维度

逐项核查，不打分：

- **生效方式**：安装后是否需要重启 dsh。支持热挂载则可免重启。
- **来源范围**：人工策展（防 name-squatting）或 topic 全量同步（覆盖广、噪声多）。
- **闭环能力**：安装 / 更新 / 卸载 / 回滚 / 降级保护。
- **agent 工具**：提供 market_search 类工具，或仅 GUI。
- **安全**：网络是否只读、有无遥测、是否执行第三方安装脚本。
- **活跃度与许可证**：最近提交/发布；许可证类型（宽松：MIT/Apache/BSD；GPL/AGPL/未知需提示）。

### 已知市场/安装器

截至 2026-09 实测，非完整清单，不构成推荐。该品类极为拥挤（策展索引中同类 70+ 个），下表仅列有代表性的形态：

| 市场/安装器 | 形态 | 属性 |
|---|---|---|
| `dshmarket`（npm） | bundle+client | 热挂载（自身首次安装需重启）；策展索引；含安装/更新/卸载/回滚/降级保护；纯 GUI；MIT、联网只读、无遥测 |
| `dsh-plugin`（npm） | bundle+client | 自称收录 4000+ 条；按 star 排序检索 |
| `dsh-plugin-shop`（npm） | bundle+client | 商店形态，含 agent 工具 |
| `dsh-find-plugin`（npm） | bundle+tool | 只做**发现**：agent 内实时 topic 检索并按 star 排序，不含安装 |
| GitHub `*-marketplace` 类 | bundle+client | 无热挂载；topic 同步；自带 agent 工具；monorepo 走 clone+构建 |
| 目录/索引类站点 | 非安装器 | 仅检索；安装走插件仓库或 `dsh plugin add` |

### 已知自动化审计/检测类

这类工具与 §3 的人工核查**部分重叠**；遇到时应先使用它们，再补人工判断。同样是拥挤赛道，下表仅列事实：

| 工具 | 它做什么 | 它不做什么 |
|---|---|---|
| **官方自带** `cordis_inspect_*`（`@deepseek-ai/dsh-tool-cordis`） | **运行时可查询真实 API 契约**：`Service.listService`、`Event.listEvents`、`Tool.listTools`，以及 `Slots.listSubTree`（能查**浏览器端真实 slot 树与 props**） | 只描述**当前活体运行时**：不读插件文件、不判 peer 区间、不预测「升级后谁会被破坏」；插件加载失败时它看不见该插件 |
| `dsh-vet`（npm） | 安装前权限与供应链审计，带 `dsh-vet/v1` 报告标准 | 不做跨版本 API 面比对 |
| `dsh-plugin-vetting`（npm） | 静态启发式扫描：恶意模式、越权路径、未检查依赖 | 不做许可证交叉核验、不比对本机版本 |
| `dsh-stability-audit`（npm） | 扫**已安装**插件的稳定性风险：钩子面、启动任务、依赖 | 不判 peer 区间是否匹配本机 |
| 运行时兼容垫片（`@dsh-plugin/dsh-loader` 等） | 运行时兜底，使第三方 bundle 与官方解耦 | 是**运行时**兜底，不预测「升级后谁会被破坏」 |

> ⚠️ **官方 `cordis_inspect_*` 不可忽略。** 它随官方 `tool-cordis` 一同提供（本机若装有 cordis 相关 bundle 即具备），是**查询当前运行时真实契约的最强手段**——比任何静态扫描都准确，因为它给出的是运行时事实而非源码推断。凡涉及「当前该服务 / slot / 工具的具体形态」的问题，应优先询问它。

**它们均未完成的工作**（即 `dsh_plugin_audit` 的定位）：将插件的**声明区间与实际 API 调用面**同**本机 dsh 构建**做逐条比对。注意：官方明确声明 API 处于 **pre-stable** 状态（见 §3 末），因此任何「预烘焙的兼容性数据集」都会迅速失真——这正是本工具坚持**运行时现算、不存快照**的原因。

**与官方 `cordis_inspect_*` 的分工**（互补，并非竞争）：

| | 官方 `cordis_inspect_*` | `dsh_plugin_audit` |
|---|---|---|
| 回答 | 当前运行时**有什么可用** | 磁盘上插件的声明**与本机构建是否一致** |
| 时机 | 进程运行中且插件已加载 | **离线**，任意时刻（安装后/升级后核验，安装前预判层能否挂载） |
| 对象 | 活体服务 / 事件 / slot / 工具 | 已安装或待安装插件的声明与调用面 |
| 插件加载失败时 | **看不见它**（它不在活体里） | 能指出它缺什么 |
| 能否预测一次**未来**升级 | 不能 | **也不能**——它只可见本机**已安装**的那个构建 |

关键差异：插件停在 `waiting`（加载失败）时，官方 inspect 无法提供帮助——该插件并不存在于活体运行时中。这种「已损坏但尚未运行」的情形，应使用本工具。

**两者均不预测未来。** 对「升级后谁会被破坏」这一问题的准确回答是：**升级后再次核查**。本工具能提供的前置信号仅为「当前已经与构建不匹配的项」——该信号表明其较为脆弱，但不等于它必然损坏；反之亦然。

### 已收录插件

收录门槛：已发布 npm、许可证宽松、通过 §3 检查。收录不等于推荐。

| 插件 | 类别 | 活跃度 | 已核实事实 |
|---|---|---|---|
| `dsh-llm-local-token`（npm） | provider / 模型路由 / 凭据 | 3 stars；2026-08 创建，最近推送 2026-09 | bundle+client；读取本机 Codex CLI 与 Claude Code 的 OAuth 凭据，注册 `openai-codex`、`anthropic` 路由（token 按请求解析、临期自动刷新，交给 dsh 自带 pi-ai 引擎）；面板读 provider 限流响应头、按计划刷新展示订阅剩余额度（含 GLM Coding Plan）；缺凭据的路由跳过而非启动失败；MIT、Node >=22.13.0、web profile、无 install 脚本。安装：`dsh plugin --profile web add dsh-llm-local-token` |

**本地实测记录（2026-09，dsh `0.1.5-rc.1` / Windows）**：安装 904ms 完成并自动进入 `dsh.profile.bundles`；供应链复验 7 个 lib 文件与 npm tarball SHA-256 全部一致；`import()` 加载正常。

**⚠️ 但其 `peerDependencies` 区间实际不满足**：声明 `@deepseek-ai/dsh-llm@^0.1.0-rc.6`、`dsh-llm-pi-ai@^0.1.0-rc.6`，而本机为 `0.1.5-rc.1`——按 rc semver 规则**不匹配**（见 §3）。`dsh_plugin_audit` 会将其判为 `at-risk`。代码当前可用，但它挂载的是 LLM 引擎行（rc 期内部 API），升级 dsh 前必须重新核对。

## 3. 评估插件（安装前必做）

安装前应检查包内容；**命中危险信号时停止，向用户确认后再继续**：

- `package.json` —— 名称、`dsh.bundle` / `dsh.client` manifest、许可证（宽松：MIT/Apache/BSD；GPL/AGPL/未知许可证需提示）
- `cordis.patch.yml` —— 插入哪些行、注册什么
- main 入口源码 —— 是否执行网络请求/子进程等可疑行为
- **活跃度** —— stars 数量与最近提交时间：停更超过一年且 star 较少的项目应谨慎采用
- **维护者弃养声明** —— 读 README 顶部：部分作者会明确写出「无法及时适配新 API，崩溃请自行修理」。该声明不构成拒绝安装的理由，但必须**告知用户**：未来升级 dsh 后可能需自行修复或卸载
- 使用索引源（§2）检索时，直接过滤 `archived: true`、`fork: true`、许可证缺失、`pushed_at` 过老的条目

### ⚠️ 包自述文档可能与 manifest 冲突，判定以 manifest 为准

仓库的 README / INSTALL 属于作者自述，与包内 `peerDependencies` 冲突时以后者为准。实测记录（2026-09-30）：某仓库的 `INSTALL.md` 声明「current releases target DSH 0.1.7 and 0.2」，而其包内 `peerDependencies` 为 `@deepseek-ai/dsh@>=0.1.7-rc.1 <0.1.8-0`，上界排除了 0.2 线。因此兼容性判定一律以包内 `peerDependencies` 与版本门禁的实际比对结果为准，README / INSTALL 的表述不得作为兼容性依据。

### ⚠️ 不写版本号：npm latest 与仓库 main 不等

npm 发布与仓库 main 是两条独立推进的线，钉死版本号必然过期（实测某包 npm 为 `1.5.1`，仓库已达 `1.6.1`）。

1. 描述插件时只写包名，由 pnpm 解析最新版；安装使用 `add <包名>`。
2. 确需引用版本时，当场核实并标注日期（如「截至 2026-09 为 1.6.1」）。
3. 两个来源不一致时须同时说明，不得只报告一个数字。
4. `dsh plugin update` 报告「已最新」而 `npm view` 显示有新版时：通常由 pnpm 的 `minimumReleaseAge` 拦截所致，见 §4。

### ⚠️ 许可证判定：不以 GitHub 徽章为依据

GitHub 的许可证识别（网页徽章与 API `license.spdx_id`）会将仓库内 vendored 的第三方文件误判为主许可证。实测记录：某仓库的徽章与 API 均报告 AGPL-3.0，而其 `LICENSE` 全文与 npm 包的 `license` 字段均为 MIT。

只要仓库包含其他协议的第三方文件（vendored 代码、字体、图标、生成物）即可能触发该误判，因此任何仓库均须交叉核验：

1. 读仓库 `LICENSE` 全文首行（不是徽章）。
2. 读 npm 包 `license` 字段（`npm view <pkg> license`）。
3. 两者不一致时以第 1、2 项为准，并说明分歧。

**危险信号清单**（任一命中即停止并确认）：

- `install` / `postinstall` / `preinstall` 脚本（registry 安装时执行）
- 源码中出现 `child_process` / `spawn` / `exec`（运行外部命令；市场类工具内置的 dsh/git/pnpm 调用属正常，需确认参数具备白名单或注入校验）
- 源码中出现网络请求（`fetch` / `http` / `https` / `WebSocket`），特别是**发送数据**而非仅读取；须区分同源本机路由与外部地址
- 源码写入非缓存目录（如主目录、profile 目录之外的敏感路径）
- 代码被混淆或压缩到不可读，或从远程加载并执行代码（`eval` / `Function` / 动态 import 远程 URL）
- 许可证缺失或非宽松协议
- 会执行第三方提供的安装脚本（`irm|iex` / `curl|bash` / 复制进 profile 后触发构建）——需用户显式确认
- **仓库自带的独立安装脚本**（`install.sh` / `install.ps1` / `setup.*` / `deploy.*`）——这是本生态的**常见形态**，与 npm 生命周期脚本是两回事，但同样应单独审计：
  - 该类脚本通常**手工改写 profile 的 `cordis.patch.yml`、为 `node_modules` 建立 junction 或软链**，从而**绕过 `dsh plugin` 的依赖管理**——后续 `dsh plugin update` / `remove` 无法管辖，卸载会残留
  - **应优先使用 `dsh plugin --profile <name> add <包名>`**；仅当包确实未发布到 npm 时，才考虑此类脚本，且必须**读完全文**再决定
  - 审计时应确认：是否幂等（重复执行不重复登记）、删除链接时是否以 `-Recurse` 跟随（会误删目标目录）、下载源是否固定版本（跟随 `main` 分支意味着每次安装内容不同）
  - 脚本逻辑规范不等同于应当使用它：实测某仓库的 `install.ps1` 写法克制、幂等、注释清楚，但同名 npm 包已发布，使用 npm 安装仍然更优（无需绕过依赖管理）

确认时应说明发现的具体信号与风险，由用户决定是否继续。

### API 兼容性核查（第三方 UI/工具插件安装前建议执行）

社区插件针对某个 dsh 版本区间开发，而 dsh 自身迭代迅速。**「能够安装」不等同于「安装后能够运行」**——尤其 UI 类插件（皮肤/主题/面板）会直接调用官方 client API。

**应先运行工具**（§0）：安装前的包使用 `dsh_plugin_inspect`（联网，将 tarball 拉取后审计）；已经安装的包使用 `dsh_plugin_audit`（离线）。两者已将下列第 1–3 步自动化。需要手工复核或工具不可用时，按下列步骤执行。

**关键前提：官方 `@deepseek-ai/*` 包不在 profile 的 `node_modules` 中。**

profile 的 `node_modules` 仅有「profile 自身安装的依赖」（可用 `node_modules/.modules.yaml` 的 `hoistedLocations` 确认）。官方包从 **dsh 安装根**解析，因此按下列方式查询本机 API 版本：

```bash
# 1) 本机 dsh 版本（安装根）
node -p "require('<dsh 根>/package.json').version"
# 2) 本机官方包实际版本
#    源码部署：<dsh 根>/packages/**/package.json 与 <dsh 根>/vendor/*/package.json
#    打包部署：<dsh 根>/node_modules/@deepseek-ai/<name>/package.json
node -p "require('<dsh 根>/packages/client/ui-slots/package.json').version"
```

> 注意 `vendor/`：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 等**不在 `packages/` 而在 `vendor/`**。仅扫描 `packages/` 会把它们误判为「不存在」，进而将一批正常插件误判为不兼容。

**核查步骤**：

1. 读插件 `package.json` 的 `peerDependencies`（其声明支持的区间，如 `^0.1.0-rc.5`）。
2. 取本机实际版本（上述命令），**判定是否落在区间内**。

   ⚠️ **rc 预发布具有特殊语义，此步最易判错**：预发布版本**只有**在区间中某个比较器的 `major.minor.patch` 与它**完全一致**、且该比较器自身带预发布标签时才可能满足。

   | 区间 | 本机版本 | 结果 |
   |---|---|---|
   | `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ **不满足** |
   | `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ **不满足** |
   | `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ 满足 |
   | `^0.1.0-rc.5` | `0.1.5` | ✓ 满足（正式版无预发布，不受该规则限制） |

   原因：`^0.1.0-rc.5` 展开为 `>=0.1.0-rc.5 <0.2.0-0`，比较器的 tuple 为 `[0,1,0]` 与 `[0,2,0]`；而 `0.1.5-rc.1` 的 tuple 为 `[0,1,5]`——**两者均不匹配**，因此被预发布规则挡下。`>=0.1.0-rc.5` 的上界与下界均不构成阻碍，实际阻碍来自该预发布规则。
   （上表由 npm 官方 `semver` 7.7.4 实测得出；pnpm 使用同一套语义。）

   ⚠️ **因此：pnpm 报告 `Issues with peer dependencies found` 时，该判定是正确的，不应忽略此警告。** 但「区间不满足」的后果按 dsh 版本分为两条完全不同的路径：

   - **dsh 具备版本门禁时（实测自 `0.2.0-rc.2` 起）→ 无法安装**。`dsh plugin add` 会打印 `installation rejected: … is incompatible with dsh …`，且**不安装任何内容**。若需安装，必须先授权精确版本豁免（exact-version exemption，见下）。
   - **更早的版本 → 可以安装但区间确实不满足**，代码可能仍可运行。此时 pnpm 的警告与「已安装」并不矛盾。

   不得以「pnpm 默认不阻断」推断当前 dsh 的行为——那是 pnpm 的行为，而非 dsh 版本门禁的行为。

   **版本门禁（自 `0.2.0-rc.2` 起自带）**——它与 pnpm 的 peer 检查不是同一机制，判据须依据源码（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`）：

   | 维度 | pnpm 的 peer 检查 | dsh 的版本门禁 |
   |---|---|---|
   | 管哪些 peer | 全部 | **仅 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`**；`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 均不在其内 |
   | 拿什么比 | 每个包**实际安装**的版本 | **运行中的 dsh 版本**（每个 range 均与该版本比对） |
   | 预发布语义 | 默认规则（见上表） | **`includePrerelease: true`**，因此 `>=0.1.0` 会**接受** `0.2.0-rc.2`，而默认规则会拒绝 |
   | `workspace:^` / `workspace:~` / `workspace:*` | 不适用 | 视为「当前 runtime」，永远满足 |
   | 冲突后果 | 警告，不阻断安装 | **仅禁用这一行**（`row.disabled = true`），**profile 照常启动**；该插件永远不加载 |

   豁免记录存放于 profile 的 `compatibility.json`（`PROFILE_COMPATIBILITY_FILENAME`），键为**精确**的 `包名@版本`，值为允许的 **dsh 精确版本**列表，粒度为「这个包的这个版本 × 这个 dsh 版本」：

   ```bash
   dsh plugin --profile <name> allow-version <包名@版本> --dsh-version <本机正在运行的 dsh 版本> --accept-risk
   dsh plugin --profile <name> revoke-version <包名@版本> --dsh-version <本机正在运行的 dsh 版本>
   dsh plugin --profile <name> version-exemptions      # 查看当前已授权的豁免
   ```

   `allow-version` 必须显式携带 `--accept-risk`（其语义为承认「可能崩溃或丢失数据」），且 `--dsh-version` 必须是**本机正在运行的**那个版本，否则报错。文件损坏或含非法记录时**不授权任何内容，但也不阻止启动**，且此时写入会被拒绝（须先手工修复）。

   **精确版本豁免的完整流程**（实测记录：2026-09-30，Windows，dsh `0.2.0-rc.2`，profile `desktop`）：`@smalltailqwq/dsh-client-ui-skin-orca-link@0.1.6` 与 `@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.6` 声明 `@deepseek-ai/dsh@>=0.1.7-rc.1 <0.1.8-0`，与本机运行版本 `0.2.0-rc.2` 不匹配，判定为 `gate: DENIED`；执行

   ```bash
   dsh plugin --profile desktop allow-version '@smalltailqwq/dsh-client-ui-skin-orca-link@0.1.6' --dsh-version 0.2.0-rc.2 --accept-risk
   dsh plugin --profile desktop allow-version '@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.6' --dsh-version 0.2.0-rc.2 --accept-risk
   ```

   之后 `add` 方可成功；授权写入 profile 的 `compatibility.json`，其内容为

   ```json
   {
     "@smalltailqwq/dsh-client-ui-skin-orca-link@0.1.6": ["0.2.0-rc.2"],
     "@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.6": ["0.2.0-rc.2"]
   }
   ```

   `version-exemptions` 用于查看已授权内容，`revoke-version` 用于撤销。离线审计的 `gate:` 行会显示 `exempted for dsh <版本> in compatibility.json — the row loads`。豁免的语义是「承认该组合未经作者测试」，因此风险须由用户确认后承担。

   ⚠️ **因此「at-risk」须再分一层**：声明区间不满足**且**命中门禁、**且**不存在对应豁免 = **该行当前不会加载**（profile 仍在运行）；存在豁免 = 会加载。`dsh_plugin_audit` 的 `gate:` 行直接给出该判定，并提供可直接粘贴的 `allow-version` 命令。

3. **进一步确认其调用的具体 API 是否仍然存在**，分两层：

   **① 具名导出**：插件写入 `import { PiAiAdapter } from '@deepseek-ai/dsh-llm'`，仅当该包**仍然导出** `PiAiAdapter` 时才成立——包仍存在但符号被改名或拆分，同样构成**链接期抛错**，而非降级。工具会自动完成该核对，手工核对应注意其为何不能依赖 grep：

   - 官方声明是 barrel，且 TypeScript 保留源码扩展名：`export * from './attribution.ts'`，而与该文件同目录实际发布的是 `attribution.d.ts`。单文件 grep 会把每一条 re-export 的符号都报告为「已移除」。
   - 因此须**递归**走完相对 re-export（含 `.ts`/`.js` → `.d.ts` 映射），再递归走裸 specifier 指向的其他包，最后与运行时入口（`main` / `exports` 的 `default`）的 `export { … }` 列表取并集。
   - **仅在导出图完整解析、且该名字在两处均不存在时，才可以判定「已移除」**；无法解析即报告 `unknown`。
     手工起点：`node -e "console.log(require('<dsh 根>/node_modules/@deepseek-ai/dsh-llm/package.json').exports['.'].types)"`，从该 `.d.ts` 开始查看。

   **② slot 契约**：UI 类插件常用 `ctx.slots.register` 注册设置卡片，slot 名是硬契约。验证有两条路径，**优先使用第一条**：

   - **进程正在运行时** → 使用官方 `cordis_inspect_query`（见 §2）：`Slots.listSubTree` 先不给 root 列出目录，再查具体 root 取得完整注册契约与 props。这是**运行时事实**，比读源码准确，且能看到浏览器端真实 slot 树——静态扫描无法覆盖这一层。
   - **离线 / 本机未安装 cordis 工具时** → 在 dsh 源码中检索 slot 名：
     ```bash
     # 插件里读到的 slot 名，例如 settings.plugin.item
     grep -rn "settings.plugin.item" <dsh 根>/packages/client --include=*.ts --include=*.tsx
     ```
     slot 名或契约若已被改名或移除，插件会静默失效或报错。
4. 结论须如实陈述：**「当前可以运行，但作者已停更 N 周，且声明不跟进 API，未来升级 dsh 后可能需要自行修复」**——将风险说明清楚，由用户决定。

> **静态扫描与运行时 inspect 的选择**：问题为「**该插件**的声明是否正确」时 → 使用 `dsh_plugin_audit`（离线即可，能覆盖未安装/无法安装的插件）；问题为「**当前运行时**某个服务 / slot / 工具的具体形态」时 → 使用官方 `cordis_inspect_*`（运行时事实，含 client 侧）。两者互不替代。

### 工具做不到什么（能力边界）

两个工具只报告它们**确实能够判定**的内容，无法判定的项会明确写出 `unknown`，不作猜测：

- **client slot 的运行时形状**：工具只能读取官方**源码**中的 slot 名集合，读不到浏览器端实际的 slot 树。名称不匹配即为硬信号；名称匹配也不保证 props 契约未变。**但这不等于无法查证**——官方 `cordis_inspect_query` 的 `Slots.listSubTree` 能在运行时取得真实的 slot 树与 props（见 §2）。因此「某 slot 的 props 契约是否变化」一类问题应询问官方 inspect，而非本工具。
- **导出的具体符号，边界在哪**：核对**确已执行**，但仅限于能够证明的范围。`dsh_plugin_audit` / `dsh_plugin_inspect` 会走完声明图并核对运行时导出列表；只有图**完整解析**、且该名字在声明入口与运行时入口均不存在时，才报告 `incompatible`。图不完整（某个 re-export 指向的包不在本机、没有 `types` 入口、`export =` 形式等）时一律报告 `unknown` 并列出原因。类型专用 import（`import type …`、行内 `type X`）不参与核对——它们被构建期抹除，不可能导致运行期失败。**CJS 中通过 `require()` 取属性的用法**（`require('pkg').Foo`）同样拿不到名字，不参与核对。
- **不在本机的包**：如 `react`、外部 npm 依赖，本机查不到版本即无法判定区间。
- **`gate:` 行比较的是哪个版本**：门禁在源码中使用的是 **`@deepseek-ai/dsh-app-boot` 自身 package.json 的版本**（`getDshRuntimeVersion()`），而工具读取的是**安装根 `package.json` 的 `version`**。本机实测二者一致（均为 `0.2.0-rc.2`）；若某日不一致，`gate:` 行可能偏移一档，此时应以 `dsh plugin add` 的实际报错为准。
- **pnpm 的发布年龄门槛（`minimumReleaseAge`）**：它决定 `dsh plugin add` **实际解析到哪个版本**，因此也决定审计的对象究竟是谁。工具会读取 profile 的 `pnpm-workspace.yaml` / `.npmrc`：**配置了阈值即精确计算**（报告直接写明「该版本是 pnpm 会安装的版本」）；**未配置则明确声明不作猜测**——pnpm 11 具有自身默认值（本机实测：9.4 小时前发布的版本被跳过，改用 57 小时前的版本），而该默认值**离线不可读**，因此报告只给出 `limits` 与钉版本命令，不编造阈值。⚠️ 实测记录：`inspect` 审计了 `latest`（9.29.0），而 pnpm 解析到 9.27.1；两者的 peer 声明对本机 dsh 一个可用、一个被判死——**审计的版本与安装到的版本可能并非同一个**。
- **client 侧的 `inject` token**：`[bundle+client]` 插件中由**浏览器半区**声明的服务名（实测形态：`slots`、`theme`、`locale`）运行在渲染进程自身的 Cordis 上下文中，**宿主上下文永远无法解析**。工具会将这些单独列为 `client-side injects (…)`，且**不因此降低 verdict**——否则一个能够正常工作的主题会被误报为 `unknown`。可核对的 client 契约是 slot 名（由工具核对）。
- **`ctx.<service>` 的静态注册表**：服务名须在运行时才能确认；运行时也无法取得时会报告 `unknown`。
- **没有 dsh 源码树时的「包缺失」判定**：此时包集合仅来自 `profiles/node_modules`（dsh 启动时修复的依赖解析图），它**比源码树更少**（尤其缺少 client 侧包）。因此工具会将「某包不存在」降级为 `at-risk` 并注明需复核，而不断言其被移除。具有源码 checkout 时判定才是硬结论。
- **`dsh_plugin_inspect` 的固有边界**：它看到的是 tarball 中的静态文件，**看不到构建产物**。若仓库仅发布源码、由安装脚本现场构建，则它审计的不是最终运行的那份代码——该情形由报告中的 `installer-script` 信号提示。它也不做恶意代码判定，只做**风险信号**（lifecycle、`eval`、网络、shell、自带安装脚本），判读由使用者负责。

### 官方对 API 稳定性的态度（决定本生态的性质）

读 dsh 安装根的 `README.md` 与 `AGENTS.md` 可知，官方**明确声明不做稳定性承诺**：

- `README.md` —— "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."
- `AGENTS.md` —— "Public APIs are pre-stable; update every consumer."

实践含义（实测：一个月内发布了 16 个 `0.x` 预发布，约每周一次破坏性变更）：

- 任何**缓存或快照式的兼容性数据**（包括本工具刻意不做的「预烘焙数据集」）都会迅速失真——因此核查必须**当下现算**。
- 社区插件的 peer 区间**普遍滞后于 dsh 实际版本**，`at-risk` 是常态而非异常。
- 因此「升级 dsh 前运行一次核查、升级后再次运行」应成为固定动作，而非一次性判断。

## 4. 安装插件（含提速原则）

**安装前先查看权限与内容，再决定是否安装**（§3）。若希望简化流程，可交由工具完成：`dsh_plugin_inspect({ spec: '<包名>' })` 会拉取 tarball、核对 registry 的 integrity，走完层完整性、peer 区间、**dsh 版本门禁（会直接预告 `dsh plugin add` 是否会被拒绝）**、具名导出、slot 契约与安装期风险，随后删除临时目录——**不安装、不写 profile、不执行 lifecycle 脚本**。判定为 `incompatible` 时不应安装；判定为 `gate: DENIED` 时即为**无法安装**（除非先授权豁免）；判定为 `at-risk` 时应将原因告知用户。

机制依据官方文档（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、[生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)）。应首先**判断安装形态**（决定挂载方式与是否需要重启）：

1. **bundle 插件**（`package.json` 含 `dsh.bundle.patch`）→ `dsh plugin --profile <name> add <spec>` 自动登记进 `dsh.profile.bundles`；**安装后需重启 dsh**（bundle 层在启动时组合，HMR 不重载 bundle 层）。
2. **client-only 插件**（仅有 `dsh.client`，无 `dsh.bundle`）→ **不进入 `dsh.profile.bundles`**；`dsh plugin add` 成功后仍须由宿主侧接线（皮肤中心一类的加载器，或 profile 自身的 patch 层）。若所使用的市场或安装器**支持热挂载**则可免重启，否则须在 profile 的 patch 层配置 `dsh.client` 行后重启生效。其 `skin.json` 若含 `wiring.bundleWired: false`，即表示由皮肤管理器负责接线（实测：`@linxin666/dsh-client-ui-skin-whale-song`）。详见 §8。
3. **纯 cordis 插件**（无 `dsh.bundle` / `dsh.client`，仅导出 `apply`）→ 经 profile 的 `cordis.patch.yml` 添加 `- insert:` 行挂载（配置层 HMR 实时生效，通常无需重启）。

标准安装命令：

```bash
dsh plugin --profile <name> add <spec>
# spec 可以是：npm 包名 | github:owner/repo | github:owner/repo#path:/<子目录> | 本地路径/链接 | tarball
```

**monorepo 的 git 安装形式**：`github:<owner>/<repo>#path:/<subdir>`。实测来源（2026-09-30）：`Small-tailqwq/dsh-deep-whale` 含 `skin-manager/`、`maid-atelier/`、`orca-link/` 三个子包，仓库根目录没有 `package.json`，因此 `github:<owner>/<repo>` 形式不可用。同一仓库发布多个包时，须分别安装各子包。

> **`dsh` 不在 PATH 时**（`Get-Command dsh` / `which dsh` 为空，实测常见）：不应照抄某一条路径后逐个尝试，应按下列顺序定位；两种部署形态的命令不同。

**① 打包安装（Windows 上位于 `…\Programs\DeepSeek Harness`）** —— CLI 位于 asar 内，须经应用自带的 shim 启动：

```powershell
# 应用会将该目录加入用户 PATH（由 resources\runtime\cli\command-manager.js 管理）；
# 若 dsh 仍不在 PATH（本机实测即为此情形），直接以绝对路径调用同一个 shim：
& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> add <spec>
```

shim 内部等价于 `ELECTRON_RUN_AS_NODE=1 "<安装根>\DeepSeek Harness.exe" --expose-internals "<安装根>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*` —— 因此 **`<安装根>\resources\app.asar.unpacked\dsh` 内只有 `node_modules`，并不是安装根**；在该目录中查找 `apps/cli/lib/bin.js` 必然失败（实测记录：2026-09，本机）。

**② 源码 checkout** —— CLI 是普通 node 入口，功能与上述 shim 完全一致：

```bash
node "<checkout>/apps/cli/lib/bin.js" plugin --profile <name> add <spec>
```

**如何定位安装根**（`dsh_plugin_audit` 使用同一套顺序，见 `lib/audit.js` 的 `detectDshRoot`）：`$DSH_ROOT` → 从**当前进程的入口路径**逐级向上找到同时含 `packages/` 与 `apps/cli/` 的目录 → 常见位置 `~/work/deepseek-harness`、`~/deepseek-harness`、`~/dsh`。

⚠️ 两点实测结论：
- **只有源码 checkout 可以作为「安装根」供审计工具使用**。纯打包安装没有 `packages/`，`dsh_plugin_audit` 会报告 `dsh install root not found`，并将 API 面检查降级为 `unknown`（它会在 `limits of this run:` 中如实说明）；此时官方包集合仅剩 `profiles/node_modules`，比源码树更少（尤其缺少 client 侧包）——**不应将该降级判定为「插件不兼容」**。
- 本机为 checkout（`C:\Users\HubaKing\work\deepseek-harness`）与打包应用共存的形态：**CLI 使用 ① 或 ② 均可，而审计工具需要 ② 所指的 checkout**。

**安装完成后先验证，再重启**（重启前即可确认安装是否正确，避免重启后才发现问题）：

```bash
node "<checkout>/apps/cli/lib/bin.js" plugin --profile <name> list   # 应列出该包
# 打包安装则使用：& "<安装根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> list
```

随后读 profile 的 `package.json`，确认包名已进入 `dsh.profile.bundles` 数组（bundle 插件）或 `cordis.patch.yml` 中出现挂载行（纯 cordis 插件）。

**提速原则**（按此顺序决策，以避免缓慢安装）：

1. **npm-first**：已发布到 npm 的插件优先使用 `add <npm 包名>`（走缓存/CDN，快速且稳定，无需 GitHub 网络与构建授权）；git spec 仅作兜底——git 安装会拉取源码，且 TypeScript 包需要 `prepare` 构建（较慢，且可能被 `allowBuilds` 拦截）。
2. **批量安装**：一次安装多个插件 `dsh plugin --profile <name> add a b c`，多个插件只需一次重启。
3. **按形态减少重启**：client-only 优先选择支持热挂载的市场；纯 cordis 走 `cordis.patch.yml`（HMR 即时生效）；仅 bundle 插件需要重启。
4. **`allowBuilds` 一次性授权**：以 git 安装 TypeScript 包被 pnpm 拦截时，将 pnpm 提示的 key 加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重新执行（pnpm ≥10 的行为）。

**供应链策略（pnpm ≥10/11 的 `minimumReleaseAge`）**：

- 现象：发布过新的包可能被**静默跳过**——`dsh plugin update` 报告 "Already up to date"，而 `npm view <pkg> version` 明明存在更新的版本；更严重的是 `dsh plugin add <包名>` 会**安装到更旧的版本**，而使用者以为安装的是 latest。
- 实测记录（2026-09-30，pnpm 11.7.0，未配置任何阈值）：`dsh plugin add dsh-dream-skin` 解析到 **9.27.1**，而 registry 的 `latest` 是发布仅 **9.4 小时**的 **9.29.0**。二者差异具有决定性——9.27.1 的 peer 在 0.2.x 上会被版本门禁整包判死，9.29.0 才修复。**门禁拒绝的那次安装，与审计的版本并非同一个包。**
- 原因：pnpm 的 `minimumReleaseAge`（发布年龄门槛）将「过新」的版本排除出解析范围；`pnpm-workspace.yaml` 中的 `minimumReleaseAgeExclude` 是白名单。
- 对策：
  1. 先以 `npm view <pkg> version` 核对最新版本；
  2. `dsh plugin --profile <name> add <pkg>@<精确版本>` —— pnpm 会自动将该版本写入 `minimumReleaseAgeExclude` 并放行；
  3. 或手工将 `pkg@版本` 加入 profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；
  4. 若希望将「静默放行」改为「显式询问」，设置 `minimumReleaseAgeStrict: true`。

**作用域**：skill 类插件可安装在**全局**（`${DSH_HOME:-~/.dsh}/skills/`，所有会话可见）或**工作区**（`<工作区>/.dsh/skills/`，仅该项目会话可见）；将 `SKILL.md` 改名为 `.disabled` 即停用，且热生效。`dsh plugin` 之外的纯 skill 包可直接复制到上述目录。

## 5. 安装后验证

**安装完成后（重启前）**：

1. `dsh plugin --profile <name> list` 能够列出该包。
2. profile `package.json`：bundle 插件 → `dsh.profile.bundles` 数组包含包名；纯 cordis 插件 → `cordis.patch.yml` 包含挂载行。
3. **核对兼容性**：运行 `dsh_plugin_audit({ target: '<包名>' })`，确认 verdict 与 blocker/risk 项，并将风险如实告知用户。**重点查看 `gate:` 行**：它回答「dsh 究竟是否会加载该插件」。
   - `gate: DENIED …` = 版本门禁将禁用它（profile 仍启动，但插件永不加载），行内已给出可直接粘贴的 `allow-version` 命令；是否授权由用户决定。
   - `gate: every declared @deepseek-ai/dsh* range admits dsh …` / `no @deepseek-ai/dsh* peer ranges declared` = 版本门禁不会拦截。
   - 同时查看 `peers: N declared …`：**分不清「未发现」与「未声明」会导致误判**。
   （若希望在安装**之前**先行查看，使用 `dsh_plugin_inspect`——它联网，会拉取 tarball 审计，并直接预告 `dsh plugin add` 是否会被拒绝；结论口径与离线审计一致。）
4. **确认层能够挂载**（此步可拦截「安装后 dsh 无法启动」）：`dsh_plugin_audit` 输出的 `layer` 行必须为 `readable` 且 `in dsh.profile.bundles`。若显示 `MISSING`，说明包内不存在其声明的 patch 文件；若显示 `NOT in dsh.profile.bundles`，说明该层不会被应用——**应在重启 dsh 之前修复**，否则前者会导致 profile 直接启动失败。常见成因是绕开 `dsh plugin add` 安装了包。
   ⚠️ 计划的顺序是「先 `add` 再审计」；工具每次调用都会重读 profile 的 `package.json` 与 `compatibility.json`，因此刚 `add` 完成后立即审计**不会**看到过期的 bundles 列表（早期版本会按进程缓存该列表，症状是刚安装的包显示 `NOT in dsh.profile.bundles`）。若仍显示 `NOT in dsh.profile.bundles` 而 `package.json` 中确实存在，应先核对 profile 路径是否为所修改的那一个。
5. **供应链复验（可选但推荐）**：比对落盘文件与审计过的产物是否为同一份——npm 安装的使用 `npm pack` 或下载 registry tarball 解包后比对 SHA-256：
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<安装后路径>/lib/client.js')).digest('hex'))"
   ```
   哈希一致即表明审计对象与安装对象确实是同一个（排除安装环节替换）。对来源可疑或 star 较少的插件尤其值得执行。

**重启后**：

6. skill 出现在 `<available_skills>`；工具出现在工具列表；UI 出现在设置面板。
7. 若更新无效果：按 §4 的供应链策略排查 `minimumReleaseAge`。
8. **安装后应告知用户回滚路径**：安装前备份 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`，或直接执行 `dsh plugin --profile <name> remove <包名>`。UI 类插件出现问题会导致界面异常，用户需要知道如何回退。
9. **区分三处状态**（判定依据见 §7）：`dsh.profile.bundles`（是否登记）、profile 的 `cordis.yml`（启动组合产物）、运行进程的活体图层（是否真正加载）。**只有第三处能够证明插件已生效**；前两处均通过而第三处未加载时，应重启后再评估。

### 命令本身失败时（实测排障）

**① `dsh plugin add` 被拒绝** —— `installation rejected: Plugin <包>@<版本> is incompatible with dsh <版本>: peerDependencies {…}`：

这并非缺陷，而是本机版本门禁的行为（§3）。它**不安装任何内容、profile 不产生任何改动**（原子失败），不应理解为部分安装。两条处置路径：更换声明了本机版本的包或版本；或按 §3 授权精确版本豁免后重新安装。

**② `dsh plugin remove` 报错且未删除任何内容** —— 典型输出：

```
[ERR_PNPM_UNUSED_PATCH] The following patches were not used: <包>@<版本>
Either remove them from "patchedDependencies" or update them to match packages in your dependencies.
dsh: plugin command failed; diagnostics: …\.plugin-manager\logs\operation-XXXX\pnpm.log
```

成因：profile 的 `pnpm-workspace.yaml` 中仍保留**该包的 `patchedDependencies` 条目**（值为相对 profile 的补丁路径，如 `patches/<包>@<版本>.patch`）。一旦该包不再是依赖，pnpm 即认定该补丁「未被使用」而报错，整条 remove 原子回滚——**包、`node_modules`、`dsh.profile.bundles` 全部保持原状**（实测记录：该失败为原子回滚，因此报错不应理解为已删除一半）。

处置（实测有效）：备份 `pnpm-workspace.yaml` → 删除 `patchedDependencies` 整块（补丁文件可一并移至备份目录）→ 重新执行 `remove`：

```yaml
# ${DSH_HOME:-~/.dsh}/profiles/<name>/pnpm-workspace.yaml 实测形态
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
patchedDependencies:            # 卸载时若残留条目即会阻塞 remove，整块删除后重跑
  <包>@<版本>: patches/<包>@<版本>.patch
```

事后确认三处均为空：`dsh plugin --profile <name> list` 不再列出、`dsh.profile.bundles` 不再包含它、`node_modules/<包>` 目录已消失。

**③ 修改 profile 后「未生效」** —— 应先分清修改的是哪个文件：`dsh.profile.bundles`（层是否组合，由 `add` / `remove` 自动维护）、`cordis.patch.yml`（纯 cordis 插件的挂载行，配置层 HMR 生效）、`compatibility.json`（版本门禁的精确授权）。仅 bundle 层的增删需要重启 dsh；判定方法见 §7。

## 6. 约束与边界

- **不做推荐**：不推荐、不排序、不背书任何第三方插件或市场（见 §2「立场」）。本文档出现的包名仅为事实实例，不构成推荐；用户询问「用哪个」时应给出事实与取舍，由用户决定。
- 本 skill 与 `dsh_plugin_audit` / `dsh_plugin_inspect` 两个工具由 `dsh-community-plugins` 插件注册提供；能够读到本 skill 即说明该插件已生效。
- **联网能力与离线能力分属两个工具，不应混淆**：`dsh_plugin_audit` 承诺不联网（这是其价值所在，不提供联网开关）；`dsh_plugin_inspect` 是唯一联网的工具，且只发起只读 GET——不发送凭据、不安装包、不写 profile、不执行 lifecycle 脚本、解包后删除临时目录。需要安装包但希望先查看时使用它；仅需了解本机现状时使用离线工具。
- **不修改官方 shipped preset**（部署 `agent-presets` 目录下的 standard/code/minimal/cordis）——升级会被覆盖；如需修改，应复制为用户预设（`${DSH_HOME:-~/.dsh}/.agent-presets/`）。
- 插件安装后需重启才生效；动态插件（`cordis_define` 等）仅存活于当前进程，不属于社区插件。
- **审计结论不是保证**：`compatible` 仅表示「工具能够核查的项均已通过」，不表示运行时必然无问题；`at-risk` 是常态。**但工具内部区分了两类判据**：`blocker` 中的层完整性、包存在性、具名导出存在性、slot 存在性来自 package.json、文件系统与包的导出图，属精确事实（且导出符号仅在导出图完整解析时才作断言）；源码扫描得到的风险信号（lifecycle、`eval`、网络、自带安装脚本）属启发式提示，需要使用者自行判断。`dsh_plugin_audit` 不联网、不写文件、不执行被审计插件的任何代码。
- 本插件源码位于 `${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins/`（或克隆位置）：修改 `skills/dsh-community-plugins/SKILL.md` 即时生效（每次发现均从磁盘重读），无需重装；修改 `lib/` 或 `index.js` **必须重启 dsh**（`cordis.patch.yml` 的 live reload 不重载模块）。

## 7. 生效时机：安装、登记与加载的三处状态

### 7.1 bundle 层仅在进程启动时组合

`dsh plugin add` 只改写 profile 的 `dsh.profile.bundles` 与依赖清单，**不会改变已运行进程的图层**（组合，compose，发生在启动阶段）。因此「安装成功」与「界面已生效」是两件不同的事，前者不蕴含后者。

**判定方法**：取得宿主进程的启动时刻，以及 profile 配置文件（`package.json`、`cordis.yml`）的 mtime。若后者晚于前者，则该进程的图层集不包含新增行，必须完全退出应用后重新启动再评估效果。

实测记录（2026-09-30，Windows，dsh `0.2.0-rc.2`，profile `desktop`）：宿主进程启动于 03:31:42；`dsh-theme-kit` 于 03:34:38 写入 profile。对运行中的 HTTP 服务探测 `/dsh-theme-kit-wallpapers/...` 返回 **404**（未知路由），而 `/`、`/index.html`、`/api/health` 返回 **401**（路由存在但需要鉴权）；据此判定该插件的宿主半区未挂载。`cordis.yml` 中确实存在该插件的行（于 03:34:40 写入），但其写入时刻晚于进程启动时刻，因此对运行进程无效。

**纪律**：在重启之前，不得依据界面外观判断任何主题或皮肤类插件的质量或兼容性。界面未变化时，首先应核查进程启动时刻与安装时刻的先后，而非更换插件。

### 7.2 「已安装」不等于「已加载」

以下三处状态相互独立，须分别核查：

| 状态 | 载体 | 含义 |
|---|---|---|
| 是否登记 | profile 的 `dsh.profile.bundles`（及 `dependencies`） | `dsh plugin add` 的产物；表示下次启动是否组合该层 |
| 启动组合产物 | profile 的 `cordis.yml` | 启动或插件操作时由组合流程写出；表示该层在某一时刻被组合过 |
| 是否真正加载 | 运行进程的活体图层 | **唯一能够证明插件已生效的状态**；由宿主进程的启动时刻决定 |

判定顺序：先读前两处确认安装无误（§5 第 1–4 步），再以运行时事实（活体服务、已注册路由、`cordis_inspect_*` 查询）确认加载。前两处均通过而第三处未加载时，结论是「需要重启」，而非「插件不兼容」。

## 8. 皮肤与主题类插件的适配线

皮肤与主题类插件在生态中存在两条相互独立的适配线，选择前应先确定 profile 属于哪一条，并注意二者不可混装。

### 8.1 原生 npm 皮肤包

- 形如 `@<scope>/dsh-client-ui-skin-<id>`，含 `dsh.bundle.patch` 与 `cordis.patch.yml`，安装后进入 `dsh.profile.bundles`，重启一次后生效；后续切换皮肤由该系列自带的管理器负责，通常不再需要重启。
- 同一作者可能同时发布一个**管理器包**与若干**皮肤包**，须分别安装各子包（monorepo 的 git 形式见 §4）。
- 管理器若在首次启动时先禁用其管理的全部皮肤（以避免同时启用互相冲突），**首次重启后界面仍为官方默认外观属预期行为**，不得据此判定安装失败；首次选择应在管理器自身的设置页面（如「设置 → 皮肤管理」）内完成。

### 8.2 皮肤中心的资产目录

- 皮肤中心（如 `@linxin666/dsh-client-ui-skin-center`）自身是标准 bundle 插件，需重启一次；此后皮肤是 `$DSH_HOME/skins/<id>/` 下的**纯资产目录**（无 `package.json`、不发布 npm），新增与切换均**不需要重启**。
- 该路线的毛玻璃类参数（背景遮蔽、背景模糊、输入卡模糊、气泡不透明度）在皮肤中心的设置卡片内调节，属该加载器自身的能力，不由各皮肤提供。
- 其皮肤格式与 `skin.json` 契约由皮肤中心定义，与 §8.1 的包形态不同。

### 8.3 client-only 皮肤包

仅声明 `dsh.client`、无 `dsh.bundle` 及 patch 的包（实测：`@linxin666/dsh-client-ui-skin-whale-song`）**不会进入 `dsh.profile.bundles`**；`dsh plugin add` 成功后仍须由宿主侧接线——或由皮肤中心一类的加载器接管，或在 profile 自身的 patch 层配置 `dsh.client` 行。其 `skin.json` 中的 `wiring.bundleWired: false` 即表示由皮肤管理器负责接线。此类包单独安装后界面无变化属预期结果，应先行确认接线方式。

判定形态时以 manifest 的 `dsh.bundle` 为准，**不得以 `skin.json` 的 `wiring.bundleWired` 为依据**：实测 `dsh-theme-whalegirl` 同样带有 `wiring.bundleWired: false`，但其 `package.json` 声明了 `dsh.bundle.patch`，属 §8.1 的 bundle 包形态，两者不可混为一谈。

### 8.4 两条适配线不得混装

同一份美术可能存在两个分别适配的版本：作者原生 npm 皮肤包，以及皮肤中心路线下的资产目录。二者的作者均明确警告：**不得装入同一 profile**，否则界面显示错乱。选择其中一条后，应避免安装另一条的同名皮肤。

### 8.5 其余核查要点

- 美术资源的许可证常与代码分离（实测形态：代码 MIT、美术 CC BY-NC-SA 4.0，即禁止商用）。许可证判定须按 §3 交叉核验，并将美术协议单独告知用户。
- 皮肤类插件若以官方 DOM 的 hash 或 class 作为挂钩，dsh 大版本更新后可能因挂钩变化而**静默失效**（不破坏布局）。该风险应由作者文档或源码判定，并前置告知用户。
- 皮肤与主题类插件的效果评估必须在重启之后执行（§7.1）。
