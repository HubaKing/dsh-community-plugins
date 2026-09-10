# dsh-community-plugins

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供社区插件生态指南，并附带一个离线审计工具的 bundle 插件。安装后，每个 agent 会话都会注册 `dsh-community-plugins` skill，并可用 `dsh_plugin_audit` 工具把已装插件与本机实际运行的 dsh 构建逐条比对。

[**English**](../../README.md) · [**中文**](README_zh.md)

---

安装本插件后，每个新会话获得两样东西：

1. **一份指南（skill）** —— 如何通过 GitHub `dsh-plugin` 话题、策展索引与 npm 发现插件；安装前如何评估；如何按官方 `dsh plugin` 机制安装；装完如何验证。
2. **一个工具（tool）** —— `dsh_plugin_audit`，把已装插件与本机 dsh 构建比对，逐条报告：什么是坏的、什么只是有风险、什么无法判定。

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

所以本插件**不存任何东西**。`dsh_plugin_audit` 每次调用都重新读 dsh 安装根与 profile，为**此刻的这台机器**作答。不联网、无遥测、没有需要保鲜的数据；确实无法离线判定时，它会如实报 `unknown` 并给出原因，而不是猜。

这正是它与生态里已有的 ~75 个市场插件、3 个以上静态审计器、以及官方运行时探测器之间的区别：那些工具做的是**陈列、排序、安全扫描，或描述当前活体运行时**；没有一个在**升级之前**把插件的**声明区间与实际 API 调用面**比对本机的 dsh 构建。

**与官方运行时探测器互补。** `@deepseek-ai/dsh-tool-cordis` 自带 `cordis_inspect_*`，它查询的是**运行时精确事实**（`Service.listService`、`Event.listEvents`、`Tool.listTools`，以及能拿到浏览器端真实 slot props 的 `Slots.listSubTree`）。问"现在运行时长什么样"，那严格来说是更好的工具。本插件回答的是另一个问题——"**哪个已装插件会坏**"——而且在探测器看不到的地方仍然有效：**加载失败的插件不在活体运行时里，探测器根本看不见它。** 静态检查读磁盘，探测器读进程，两者都需要。

## 审计工具

```
dsh_plugin_audit({})                                  # 审计 profile 里全部第三方插件
dsh_plugin_audit({ target: 'dsh-llm-local-token' })   # 只审计一个（包名或目录路径）
```

每个插件会报告：

| 检查项 | 判定依据 |
|---|---|
| `peerDependencies` 区间是否满足 | 本机各包的真实版本（含 `vendor/`） |
| import 的 `@deepseek-ai/*` 包是否仍存在 | dsh 安装根（`packages/`、`vendor/`、`node_modules/@deepseek-ai`） |
| 注册的 client slot 是否仍有定义 | 从官方 `packages/client` + `packages/core` 源码提取的 slot 契约 |
| `inject` 服务名是否可解析 | 当前 Cordis 上下文 |
| 安装期风险信号 | npm lifecycle 脚本、`child_process`、`eval`、远程 import、网络请求 |

结论分四级，不是非黑即白：

| 结论 | 含义 |
|---|---|
| `compatible` | 本工具能做的检查全部通过 |
| `at-risk` | 声明的区间已不匹配，但代码可能仍能跑 —— **这是本生态的常态** |
| `incompatible` | 硬证据：它需要的包或 slot 在本机已不存在 |
| `unknown` | 有项检查无法离线完成，且必定说明原因 |

### 这条 rc 预发布陷阱，就是它存在的理由

`^0.1.0-rc.5` 展开为 `>=0.1.0-rc.5 <0.2.0-0`。它能匹配 `0.1.5-rc.1` 吗？

**不能。** 预发布版本只有在一个比较器的 `major.minor.patch` 与它**完全一致**、且该比较器自身是预发布时才满足。这里比较器的 tuple 是 `[0,1,0]` 与 `[0,2,0]`，版本是 `[0,1,5]`——都不一致，于是被预发布规则挡下。

| 区间 | 本机版本 | 结果 |
|---|---|---|
| `^0.1.0-rc.5` | `0.1.5-rc.1` | ✗ 不满足 |
| `^0.1.0-rc.6` | `0.1.5-rc.1` | ✗ 不满足 |
| `^0.1.0-rc.5` | `0.1.0-rc.6` | ✓ 满足 |
| `^0.1.0-rc.5` | `0.1.5` | ✓ 满足 |

已用 npm 官方 `semver` 7.7.4 实测验证。这条重要，是因为 **pnpm 默认不阻断 peer 不满足的安装**——所以「装上了」从不等于「区间满足」，那条 `Issues with peer dependencies found` 警告说的是实话。

## 定位：轻量化

| 属性 | 值 |
|---|---|
| 运行时依赖 | 1 个（`yaml`，仅用于解析 bundle 补丁） |
| 构建步骤 | 无 —— 纯 JavaScript，无 `prepare` 脚本，无需 `allowBuilds` 授权 |
| 插件形态 | bundle + 一个 host tool；无 `dsh.client`，无 UI 界面 |
| 网络 / 遥测 | 工具全程不联网，只读本机文件 |
| 跟踪文件数 | 17（源码、测试、文档） |

工具定义是**手写的普通对象**，而不是用 `@deepseek-ai/dsh-tools` 的 `defineTool` 构造。`ctx.tools.register` 只要求 `{ name, description, parameters, output: { schema, render }, execute }`——普通对象不会因为上游改名或移动导出符号而崩，而"pre-stable"政策意味着那种事一定会发生。测试套件用 **dsh 自己的 `assertSupportedJsonSchema` 与 `validateJsonSchemaValue`** 跑一遍，证明这个形状是被接受的。

工具通过 `ctx.get('tools')` 挂载，而不是 `inject = ['tools']`。声明成硬依赖会让整个插件——**包括 skill**——在任何未组合 `tools` 服务的部署上停在 `waiting` 状态。skill 必须始终可用；工具则静默降级。

工具声明了 `timeoutMs` 预算，并且**真的履行它**。这个字段是承诺而非装饰：dsh 的契约规定，声明 `timeoutMs` 就等于断言该工具会转发 `exec.signal`，并能在预算中止时达到静止。因此 `execute` 会把 signal 一路传进扫描过程，扫描在每个文件边界重新检查一次——中止会真正停下工作并以 `AbortError` 报出，而不是静默超时跑完。（该预算从不发给模型：`schemas()` 只白名单 `name` / `description` / `parameters`。）

### 中立性

本插件**刻意不做推荐引擎**：只提供方法与事实，不对任何第三方插件或市场排序、背书或推荐。候选插件附带可核实的事实（形态、许可、活跃度、已知风险），由用户自行选择。审计工具只报兼容性，从不评判"哪个更好"。

## 安装

前置条件：dsh CLI（或从 dsh 安装根调用 `apps/cli/lib/bin.js`）。

```bash
# npm（推荐：免克隆、免构建）
dsh plugin --profile web add @hubaking/dsh-community-plugins

# GitHub 直装（纯 JS，无构建脚本，无需构建授权）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee 镜像（国内访问更快）
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball（可离线）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.2.1/hubaking-dsh-community-plugins-0.2.1.tgz
dsh plugin --profile web add ./hubaking-dsh-community-plugins-0.2.1.tgz

# 源码 + link（开发模式，改 SKILL.md 即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

安装后**重启 dsh**（bundle 层在启动时组合）。新会话中 `<available_skills>` 出现 `dsh-community-plugins`、工具列表出现 `dsh_plugin_audit`，即安装成功。

> ⚠️ **npm 形态必须带 `@hubaking/` scope。** npm 上的无 scope 名 `dsh-community-plugins` 属于**另一个项目**（[`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins)，TypeScript、含构建脚本），执行 `dsh plugin add dsh-community-plugins` 会静默装上那个包。

> `dsh` 不在 PATH 时，使用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。

## 工作原理

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：注册 skill provider，再通过 `ctx.get('tools')` 挂载工具 |
| `lib/skills.js` | 解析 `skills/<name>/SKILL.md` 并注册到 `ctx.skills` |
| `lib/tool.js` | 手写的工具定义与人类可读的报告渲染器 |
| `lib/audit.js` | 定位 dsh 安装根与 profile、扫描插件、产出结论 |
| `lib/semver.js` | 零依赖 semver 匹配，对齐 node-semver 语义（含预发布规则） |
| `cordis.patch.yml` | bundle 补丁层：`- insert:` 行在 profile 启动时挂载插件 |

## 开发

```bash
npm install      # 只有 yaml
npm test         # semver 交叉验证 + 真实环境审计 + 插件契约
```

测试套件在任何机器上都有意义：

- `test/semver.test.mjs` —— 本机能找到 npm `semver` 时做交叉验证（930 组区间/版本对 + 900 组排序对，当前零不一致，另有 36 条显式断言）。
- `test/audit.test.mjs` —— 对本机真实安装跑审计并打印报告；机器相关数值只打印、不断言。
- `test/plugin.test.mjs` —— 覆盖 `apply` 契约与全部降级路径，并用 dsh 自己的 schema 校验器验证手写的工具定义。

## 目录结构

```
dsh-community-plugins/
├── index.js                  # 插件入口
├── lib/
│   ├── audit.js              # 环境探测 + 结论判定
│   ├── semver.js             # rc-aware 区间匹配（零依赖）
│   ├── skills.js             # SKILL.md provider
│   └── tool.js               # 工具定义 + 报告渲染
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
