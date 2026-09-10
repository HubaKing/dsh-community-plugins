# dsh-community-plugins

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供社区插件生态指南，并附带两个审计工具的 bundle 插件：一个全程离线，一个在**安装之前**把包装下来审计。安装后，每个 agent 会话都会注册 `dsh-community-plugins` skill，并可用 `dsh_plugin_audit` / `dsh_plugin_inspect` 把插件与本机实际运行的 dsh 构建逐条比对。

[**English**](../../README.md) · [**中文**](README_zh.md)

---

安装本插件后，每个新会话获得三样东西：

1. **一份指南（skill）** —— 如何通过 GitHub `dsh-plugin` 话题、策展索引与 npm 发现插件；安装前如何评估；如何按官方 `dsh plugin` 机制安装；装完如何验证。
2. **一个离线工具** —— `dsh_plugin_audit`，把**已装**插件与本机 dsh 构建比对，逐条报告：什么是坏的、什么只是有风险、什么无法判定。它不联网。
3. **一个联网工具** —— `dsh_plugin_inspect`，下载包的发布 tarball、用 registry 公布的哈希校验、解包到临时目录、在**安装之前**给出结论。它不安装任何东西，也不执行包的 lifecycle 脚本。

两个工具**刻意分开**。离线审计的承诺是「不发起任何网络请求」；如果加个开关让它有时联网，这个承诺就变成了有条件的，而有条件的承诺等于没有承诺。两个工具、两条保证，各自在自己的名字、描述和输出里说清是哪一条。

## 为什么需要本插件

DeepSeek Harness 的插件能力通过两类机制提供：**工具（Tools）** 与 **技能（Skills）**，两者互补：

| | 工具（如 `market_search`） | 技能（本插件注册的 skill） |
|---|---|---|
| 本质 | 能力通道：可调用的函数 | 上下文知识：何时、为何、如何调用 |
| 单独安装时的效果 | 工具存在，但 agent 不认识它 | 无法调用任何市场接口 |

仅安装市场工具是不够的：`web_search` 描述直观，是模型的默认通用手段；`market_search` 是 DSH 专属工具，agent 默认不知道它的存在、不觉得「安装插件」与其相关，也不了解本机 profile 结构、bundle 机制、评估流程与重启要求。

而只有知识也不够：这个生态里最实际的那个问题——**「升级 dsh 会不会弄坏我装的东西？」**——靠人眼判断是不可靠的，下面那条 rc 预发布规则就是原因。

## 为什么做实时探针，而不是兼容性数据集

官方**刻意**声明 API 面不稳定：

- `README.md` —— **"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**
- `AGENTS.md` —— **"Public APIs are pre-stable; update every consumer."**

因此任何**缓存快照式的 API 面**在写下的一刻就开始失真。本机实测：**一个月内 16 个 `0.x` 预发布**，约每周一次破坏性变更。数据集需要持续维护，且在两次更新之间就是错的——而一个**自信地给出错误结论**的验证工具，比没有工具更危险。

所以本插件**不存任何东西**。`dsh_plugin_audit` 每次调用都重新读 dsh 安装根与 profile，为**此刻的这台机器**作答；`dsh_plugin_inspect` 读它刚下载的 tarball，针对**同一个本机构建**判定。无遥测、无缓存、没有需要保鲜的数据；确实无法判定时，两者都会如实报 `unknown` 并给出原因，而不是猜。

这正是它与生态里已有的 ~75 个市场插件、3 个以上静态审计器、以及官方运行时探测器之间的区别：那些工具做的是**陈列、排序、安全扫描，或描述当前活体运行时**；没有一个在**升级之前**把插件的**声明区间与实际 API 调用面**比对本机的 dsh 构建，也没有一个能对**还没安装**的插件这么做。

**与官方运行时探测器互补。** `@deepseek-ai/dsh-tool-cordis` 自带 `cordis_inspect_*`，它查询的是**运行时精确事实**（`Service.listService`、`Event.listEvents`、`Tool.listTools`，以及能拿到浏览器端真实 slot props 的 `Slots.listSubTree`）。问"现在运行时长什么样"，那严格来说是更好的工具。本插件回答的是另一个问题——"**磁盘上的声明和本机这个构建还对得上吗**"——而且在探测器看不到的地方仍然有效：**加载失败的插件不在活体运行时里，探测器根本看不见它。** 静态检查读磁盘，探测器读进程，两者都需要。

两者都不预测未来升级。它们只看得到本机**已装**的那个构建；"升级后什么会坏"的诚实答案是**升完再跑一次**。

## 离线审计工具

```
dsh_plugin_audit({})                                  # 审计 profile 里全部第三方插件
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # 只审计一个（包名或目录路径）
```

每个插件会报告：

| 检查项 | 判定依据 |
|---|---|
| **bundle 层能否挂载** | `dsh.bundle.patch` 指向的文件是否存在，以及该包是否登记在 `dsh.profile.bundles` |
| `peerDependencies` 区间是否满足 | 本机各包的真实版本（含 `vendor/`） |
| import 的 `@deepseek-ai/*` 包是否仍存在 | dsh 安装根（`packages/`、`vendor/`、`node_modules/@deepseek-ai`） |
| **这些 import 要的具名导出是否还在导出** | 包的声明入口，递归穿过 `export *`，再与其运行时入口的导出列表取并集 |
| 注册的 client slot 是否仍有定义 | 从官方 `packages/client` + `packages/core` 源码提取的 slot 契约 |
| `inject` 服务名是否可解析 | 当前 Cordis 上下文 |
| 安装期风险信号 | npm lifecycle 脚本、`child_process`、`eval`、远程 import、网络请求 |

结论是分级的，不是二元的：

| 结论 | 含义 |
|---|---|
| `compatible` | 本工具能做的检查全部通过 |
| `at-risk` | 声明的区间已不匹配、或层没被组合进去，但代码可能仍能跑 —— **这是本生态的常态** |
| `incompatible` | 硬证据：它需要的包、导出或 slot 在本机已不存在，**或它的 bundle 层根本无法挂载** |
| `unknown` | 有项检查无法离线完成，且必定说明原因 |

### 符号级核对：为什么「包还在」远远不够

插件写 `import { PiAiAdapter } from '@deepseek-ai/dsh-llm'`，只有当那个包**仍然导出** `PiAiAdapter` 时才成立。改名或拆分会让包留在原地、而那个绑定消失——而 ESM 具名 import 一个模块并未提供的绑定时，是**链接期抛错**，不是功能降级。

要确认这一点比 grep 一个文件难，因为包的导出面是一张**图**。官方声明是 barrel，而 TypeScript 会保留源码扩展名：

```ts
export * from './attribution.ts';          // 实际与它同目录发布的是 attribution.d.ts
export { BlockAssembler } from './assembler.ts';
```

单文件扫描会把每一条 re-export 出来的符号都报成「已移除」。所以这项检查会**走完这张图**——相对 specifier、`.ts`/`.js` → `.d.ts` 的映射、指向其他包的裸 specifier——并严格区分两件事：

- 它**已确认存在**的符号集合；
- 这个集合是否**完整**。

只有完整解析过的图才配说「已移除」。图不完整时结果是 `unknown`，因为「我没解析到」不等于「它没了」。声明面还会与运行时入口自己的导出列表取并集，这样一份过期的 `.d.ts` 也造不出假故障。

本机实测（**2026-09**，dsh `0.1.5-rc.1`）：**279 个官方包全部扫过，276 个声明图完整解析，1874 个运行时导出名逐一核对，0 个未确认。** 剩下 3 张不完整的图报 `unknown`，绝不报「已移除」。这套扫描会随测试在任何机器上重跑一遍。

### 一个坏插件能让 dsh 起不来

这就是层检查被放在第一位的原因。下面三种上游是**抛错**而非降级，整个 profile 直接起不来：

| 情形 | 上游行为 |
|---|---|
| 声明了 `dsh.bundle.patch`，但包里没有那个文件 | `failed to read overlay` → 抛错（`packages/boot/app-boot/src/index.ts:315-323`） |
| 声明了 `dsh.bundle` 却没写 `patch` | `declares no dsh.bundle` → 抛错（`packages/boot/app-boot/src/profile.ts:792-797`） |
| `dsh.profile.bundles` 里列了装不上的包 | 层解析失败 → 抛错（同上） |

还有一种**不报错但完全没用**的：patch 文件可读，但包没登记进 `dsh.profile.bundles` —— 层永远不会被应用，插件等于没装。常见成因是绕开 `dsh plugin add`、直接在 profile 目录里 `pnpm add`（调和那个列表的是前者，不是后者：`apps/cli/src/plugin.ts:59-91`）。

工具会为每个插件打印一行 `layer …`，其余作为 blocker 报出，**让你在重启 dsh 之前就看到**。这几条判据是**精确**的——读的是 `package.json` 和文件系统，不是源码启发式。

### 这条 rc 预发布陷阱，就是它存在的理由

`^0.1.0-rc.5` 展开为 `>=0.1.0-rc.5 <0.2.0-0`。它能匹配 `0.1.5-rc.1` 吗？

**不能。** 预发布版本只有在一个比较器的 `major.minor.patch` 与它**完全一致**、且该比较器自身是预发布时才满足。这里比较器的 tuple 是 `[0,1,0]` 与 `[0,2,0]`，版本是 `[0,1,5]`——都不一致，于是被预发布规则挡下。

| 区间 | 本机版本 | 结果 |
|---|---|---|
| `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ 不满足 |
| `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ 不满足 |
| `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ 满足 |
| `^0.1.0-rc.5` | `0.1.5` | ✓ 满足 |

已用 npm 官方 `semver` 实测验证。这条重要，是因为 **pnpm 默认不阻断 peer 不满足的安装**——所以「装上了」从不等于「区间满足」，那条 `Issues with peer dependencies found` 警告说的是实话。

## 安装前审计工具

```
dsh_plugin_inspect({ spec: 'dsh-llm-local-token' })          # npm，最新版
dsh_plugin_inspect({ spec: '@scope/pkg@^1.2' })              # npm，指定区间
dsh_plugin_inspect({ spec: 'github:owner/repo#v1.2.0' })     # 仓库
dsh_plugin_inspect({ spec: 'https://host/pkg.tgz' })         # 直链 tarball
```

**这是本插件唯一联网的部分，而它在名字、描述和输出里都写明了这一点。** 它做的事：

| 步骤 | 细节 |
|---|---|
| 解析 | 读 registry 文档，选出**一个具体版本**，这样报告能说清它判的是哪个版本 |
| 下载 | 流式下载 tarball，上限 64 MiB |
| 校验 | 解包之前先核对 registry 公布的 `integrity`（`sha512`/`sha384`/`sha256`）或 `shasum`，不一致就中止 |
| 解包 | 解到 `mkdtemp` 临时目录，并在**每条退出路径**上删除 |
| 判定 | 用与离线审计**同一套**判定引擎，针对同一个本机 dsh 构建 |

它**不做**的事：不安装任何东西、不写 profile、不执行包的 lifecycle 脚本。一个 `postinstall` 会被报成高危发现，而不会被服从。

因为它处理的是本仓库没人生产过的字节，解包器是**手写并加固**的，而不是引入依赖：

| 攻击 | 行为 |
|---|---|
| `../escape.txt`、`package/../../escape.txt` | 拒绝并报告 |
| `/absolute.txt`、`C:\…` | 拒绝并报告 |
| symlink / hardlink 条目 | 直接跳过、绝不创建 —— 后续条目也就无法经由该链接写到外面 |
| 头部谎报大小 | 读取器停止，而不是越界读 |
| 解压炸弹 | 单文件、总大小、条目数三重上限，大声失败 |

报告还会标出安装期风险，包括 SKILL.md 警告过的那一类：仓库自带的 `install.sh` / `setup.ps1` 直接改写 profile、手工把包链进 `node_modules`，绕过 `dsh plugin` 的依赖管理——之后 `dsh plugin update` 和 `remove` 就管不到它了。

## 定位：轻量化

| 属性 | 值 |
|---|---|
| 运行时依赖 | 1 个（`yaml`，仅用于解析 bundle 补丁）—— tar 读取器是手写的，不是依赖 |
| 构建步骤 | 无 —— 纯 JavaScript，无 `prepare` 脚本，无需 `allowBuilds` 授权 |
| 插件形态 | bundle + 两个 host tool；无 `dsh.client`，无 UI 界面 |
| 网络 / 遥测 | `dsh_plugin_audit`：全程不联网，只读本机文件。`dsh_plugin_inspect`：只在被调用时发起只读 GET；无遥测、不带凭据 |

工具定义是**手写的普通对象**，而不是用 `@deepseek-ai/dsh-tools` 的 `defineTool` 构造。`ctx.tools.register` 只要求 `{ name, description, parameters, output: { schema, render }, execute }`——普通对象不会因为上游改名或移动导出符号而崩，而"pre-stable"政策意味着那种事一定会发生。测试套件用 **dsh 自己的 `assertSupportedJsonSchema` 与 `validateJsonSchemaValue`** 跑一遍，证明两个形状都被接受。

两个工具都通过 `ctx.get('tools')` 挂载，而不是 `inject = ['tools']`。声明成硬依赖会让整个插件——**包括 skill**——在任何未组合 `tools` 服务的部署上停在 `waiting` 状态。skill 必须始终可用；工具则静默降级，而且**一个工具注册失败不会带走另一个**。

两个工具都声明了 `timeoutMs` 预算，并且**真的履行它**。这个字段是承诺而非装饰：dsh 的契约规定，声明 `timeoutMs` 就等于断言该工具会转发 `exec.signal`，并能在预算中止时达到静止。因此 `execute` 会把 signal 一路传进扫描过程和下载过程——中止会真正停下工作并以 `AbortError` 报出，而不是静默超时跑完。（该预算从不发给模型：`schemas()` 只白名单 `name` / `description` / `parameters`。）

### 中立性

本插件**刻意不做推荐引擎**：只提供方法与事实，不对任何第三方插件或市场排序、背书或推荐。候选插件附带可核实的事实（形态、许可、活跃度、已知风险），由用户自行选择。工具只报兼容性，从不评判"哪个更好"。

## 安装

前置条件：dsh CLI（或从 dsh 安装根调用 `apps/cli/lib/bin.js`）。

```bash
# GitHub 直装（纯 JS，无构建脚本，无需构建授权）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee 镜像（国内访问更快）
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball（可离线）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.4.0/hubaking-dsh-community-plugins-0.4.0.tgz
dsh plugin --profile web add ./hubaking-dsh-community-plugins-0.4.0.tgz

# 源码 + link（开发模式，改 SKILL.md 即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

> ⚠️ **npm 形态必须带 `@hubaking/` scope。** npm 上的无 scope 名 `dsh-community-plugins` 属于**另一个项目**（[`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins)，TypeScript、含构建脚本），执行 `dsh plugin add dsh-community-plugins` 会静默装上那个包。
>
> ⚠️ **带 scope 的包目前还没发布到 npm。** 截至 2026-09，`dsh plugin add @hubaking/dsh-community-plugins` 返回 404；release workflow 会在推 `v*` tag 且配置了 `NPM_TOKEN` 时发布。在那之前请用上面几种方式安装。

安装后**重启 dsh**（bundle 层在启动时组合）。新会话中 `<available_skills>` 出现 `dsh-community-plugins`、工具列表出现 `dsh_plugin_audit` 与 `dsh_plugin_inspect`，即安装成功。

> `dsh` 不在 PATH 时，使用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。

## 工作原理

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：注册 skill provider，再通过 `ctx.get('tools')` 挂载两个工具 |
| `lib/skills.js` | 解析 `skills/<name>/SKILL.md` 并注册到 `ctx.skills` |
| `lib/tool.js` | 离线工具的定义与人类可读的报告渲染器 |
| `lib/inspect-tool.js` | 联网工具的定义与其渲染器 |
| `lib/audit.js` | 定位 dsh 安装根与 profile、扫描插件、产出结论 |
| `lib/symbols.js` | 穿过 `export *` barrel 走声明图，确认具名导出是否存在 |
| `lib/semver.js` | 零依赖 semver 匹配，对齐 node-semver 语义（含预发布规则） |
| `lib/registry.js` | registry / 仓库解析、integrity 校验、带上限的下载 |
| `lib/inspect.js` | 取回、解包并判定尚未安装的包，随后删除临时目录 |
| `lib/tar.js` | 手写的加固 tar 读取器：路径穿越、链接条目、解压炸弹一律拒绝 |
| `cordis.patch.yml` | bundle 补丁层：`- insert:` 行在 profile 启动时挂载插件 |

## 开发

```bash
npm install      # 只有 yaml
npm test         # semver + 符号解析 + 真实环境审计 + fixture + tar + 安装前审计 + 契约 + 集成
```

测试套件在任何机器上都有意义：

- `test/semver.test.mjs` —— 本机能找到 npm `semver` 时做交叉验证（930 组区间/版本对 + 900 组排序对，当前零不一致，另有显式断言）。
- `test/symbols.test.mjs` —— 导出图解析器对合成包的测试：带 `.ts` 后缀的 `export *`、带别名的 re-export、barrel 里的私有类、无法解析的图，以及曾经被错误归因的那些 import 形式。
- `test/audit.test.mjs` —— 对本机真实安装跑审计并打印报告；机器相关数值只打印、不断言。它同时把上面那套导出面全量扫描作为**自洽性 oracle** 再跑一遍。
- `test/fixtures.test.mjs` + `test/fixtures.mjs` —— 在临时目录里合成完整的 dsh 布局（profile、已装插件、fallback、可选源码树），断言**精确的**判定结果，覆盖每一条启动失败路径与每一种符号核对结果。
- `test/tar.test.mjs` —— 解包器对那些「本不该被接受」的归档的行为。
- `test/inspect.test.mjs` —— 安装前审计对**本地 HTTP server**（不是 npm）跑端到端：版本选择、integrity 校验、穿越与链接条目的拒绝、临时目录清理，以及「什么都没装」的保证。
- `test/plugin.test.mjs` —— 覆盖 `apply` 契约与全部降级路径，并用 dsh 自己的 schema 校验器验证两个手写的工具定义。
- `test/integration.test.mjs` —— 用真实 Cordis `Context` 与真实 `ToolRuntime` 加载插件，验证两个工具真的能被模型看到，并在卸载时被回收。

## 目录结构

```
dsh-community-plugins/
├── index.js                  # 插件入口
├── lib/
│   ├── audit.js              # 环境探测 + 结论判定
│   ├── semver.js             # rc-aware 区间匹配（零依赖）
│   ├── skills.js             # SKILL.md provider
│   ├── symbols.js            # 导出图解析
│   ├── tool.js               # 离线工具 + 渲染
│   ├── registry.js           # registry 访问 + integrity
│   ├── inspect.js            # 安装前审计
│   ├── inspect-tool.js       # 联网工具 + 渲染
│   └── tar.js                # 加固 tar 读取器
├── test/                     # Node 原生测试，无框架
├── cordis.patch.yml          # bundle 补丁层
├── package.json              # dsh.bundle manifest
├── README.md                 # English
├── docs/lang/README_zh.md    # 中文
└── skills/dsh-community-plugins/SKILL.md
```

## 修改 skill 内容

编辑 `skills/dsh-community-plugins/SKILL.md` 后保存即生效（provider 每次发现都从磁盘重读），随后 `git push` 同步给其他使用者。改 `index.js` 或 `lib/` **必须重启 dsh**——`patchReload: live` 只重读 `cordis.patch.yml`，不重载模块。

## 相关文档

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方文档（简体中文）](https://deepseek-harness.github.io/deepseek-harness/)
- [官方文档（English）](https://deepseek-harness.github.io/deepseek-harness/en/)
- [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [插件与生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
- [GitHub `dsh-plugin` 话题](https://github.com/topics/dsh-plugin)

## License

MIT
