# dsh-community-plugins

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供社区插件生态指南的 bundle 插件。安装后，每个 agent 会话都会注册 `dsh-community-plugins` skill，使 agent 具备发现、评估、安装社区插件的能力。

[**English**](../../README.md) · [**中文**](README_zh.md)

---

安装本插件后，每个新会话的 agent 都会获得一份指南：本机实际装了哪些工具、如何检索 `dsh-plugin` 生态、安装前如何评估一个插件、如何按官方 `dsh plugin` 机制安装（npm / GitHub / tarball / `link:` 开发模式）。

## 为什么需要本插件

DeepSeek Harness 的插件能力通过两类机制提供：**工具（Tools）** 与 **技能（Skills）**，两者互补：

| | 工具（如 `market_search`） | 技能（本插件注册的 skill） |
|---|---|---|
| 本质 | 能力通道：可调用的函数 | 上下文知识：何时、为何、如何调用 |
| 安装来源 | 某个市场插件 | 本插件 |
| 单独安装时的效果 | 工具存在，但 agent 不认识它 | 无法调用任何市场接口 |

仅安装市场工具是不够的，因为 agent 的行为由上下文知识驱动：

- `web_search` 描述直观，是模型的默认通用手段；
- `market_search` 是 DSH 专属工具，agent 默认不知道它的存在、不觉得「安装插件」与其相关，也不了解本机 profile 结构、bundle 机制、评估流程与重启要求。

没有本插件时，agent 只能退化为网页搜索碰运气。安装本插件后，每个新会话的 agent 自动获得完整知识：本机已装哪些工具、优先走哪条结构化检索通道、如何评估来源、如何按官方机制安装、装完如何验证。

## 定位：轻量化

本插件是**纯知识插件**：不提供运行时服务、不包含 client 端产物、没有构建步骤。

| 属性 | 值 |
|---|---|
| 运行时依赖 | 1 个（`yaml`，仅用于解析 bundle 补丁） |
| 构建步骤 | 无 —— 纯 JavaScript，无 `prepare` 脚本，无需 `allowBuilds` 授权 |
| 插件形态 | 仅 bundle（`dsh.bundle.patch`），无 `dsh.client`，无 UI 界面 |
| 仓库文件数 | 9 |
| 仓库体积 | 约 49 KB |

由于只有单个 bundle 层、没有 client 半边，安装它不会引入 UI、不介入模型与请求链路、也不需要 TypeScript 插件才会遇到的构建授权。

### 中立性

本 skill **刻意不做推荐引擎**：只提供方法与事实，不对任何第三方插件或市场排序、背书或推荐。候选插件附带可核实的事实（形态、许可、活跃度、已知风险），由用户自行选择。

## 功能

- 注册全局 skill：所有会话的 `<available_skills>` 目录自动出现 `dsh-community-plugins`
- 指导 agent 以实测为准识别本机已装内容（读 profile manifest，不假设）
- 提供中立的发现渠道：已装工具、目录/索引源、GitHub `dsh-plugin` topic 检索、npm
- 规避**仓库名 ≠ npm 包名**的陷阱：先读 `package.json` 的 `name` 字段再查 npm（用仓库名查会得到假 404，进而误判「未发布」）
- 指导不轻信 GitHub 的 license 徽章：交叉核验 `LICENSE` 全文与 npm `license` 字段
- 覆盖第三方插件的 API 兼容性核查：本机 `@deepseek-ai/*` 包的真实解析位置、rc 预发布版本 semver 语义、验证插件调用的 API 是否仍存在
- 单独提示仓库自带安装脚本（`install.sh` / `install.ps1`）的风险：它们绕过 `dsh plugin` 的依赖管理，优先用 npm 形态
- 提供官方安装方式与提速要点：`dsh plugin` 用法、npm-first、批量安装、按形态决定热挂载 vs 重启
- 说明 pnpm 供应链策略（`minimumReleaseAge`）及其对策
- 约束说明：不改官方 shipped preset、重启规则、构建授权边界

## 安装

前置条件：dsh CLI（或从 dsh 安装根调用 `apps/cli/lib/bin.js`）。以下方式任选其一：

```bash
# npm（推荐：免克隆、免构建）
dsh plugin --profile web add @hubaking/dsh-community-plugins

# GitHub 直装（纯 JS，无构建脚本，无需构建授权）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# Gitee 镜像（国内访问更快）
dsh plugin --profile web add https://gitee.com/HubaKing/dsh-community-plugins.git

# tarball（可离线）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.6/dsh-community-plugins-0.1.6.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.6.tgz

# 源码 + link（开发模式，修改即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

安装后**重启 dsh**（bundle 层在启动时组合）。新会话中 `<available_skills>` 出现 `dsh-community-plugins` 即安装成功。

> ⚠️ **npm 形态必须带 `@hubaking/` scope。** npm 上的无 scope 名 `dsh-community-plugins` 属于**另一个项目**（[`funcodingdev/dsh-community-plugins`](https://github.com/funcodingdev/dsh-community-plugins)，TypeScript、含构建脚本），执行 `dsh plugin add dsh-community-plugins` 会静默装上那个包。本仓库发布名为 `@hubaking/dsh-community-plugins`。

> `dsh` 不在 PATH 时，使用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。

## 工作原理

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：将 `skills/` 目录注册到 `ctx.skills` 全局注册表 |
| `cordis.patch.yml` | bundle 补丁层：`- insert:` 行在 profile 启动时挂载插件 |
| `skills/dsh-community-plugins/SKILL.md` | skill 正文，即 agent 读取的指南 |
| `package.json` | 声明 `dsh.bundle.patch` manifest |

要点：

- **纯 JavaScript、无构建脚本**（唯一依赖 `yaml`）：GitHub 直装无需 `prepare` 脚本与 `allowBuilds` 授权（TypeScript 插件的构建门槛，见官方文档）
- **热更新**：`index.js` 每次发现时从磁盘重读，编辑 `SKILL.md` 无需重启、无需重装
- **符合官方插件规范**：函数形式 `export const name` + `export function apply(ctx)` + `dsh.bundle` manifest

## 修改 skill 内容

编辑 `skills/dsh-community-plugins/SKILL.md` 后保存即生效，随后 `git push` 同步给其他使用者。

## 目录结构

```
dsh-community-plugins/
├── index.js              # 插件入口（skill 注册）
├── cordis.patch.yml      # bundle 补丁层
├── package.json          # dsh.bundle manifest
├── README.md             # English
├── docs/
│   └── lang/
│       └── README_zh.md  # 中文
└── skills/
    └── dsh-community-plugins/
        └── SKILL.md      # agent 读取的指南
```

## 相关文档

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方文档（简体中文）](https://deepseek-harness.github.io/deepseek-harness/)
- [官方文档（English）](https://deepseek-harness.github.io/deepseek-harness/en/)
- [快速开始（Web UI）](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
- [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) — 插件形态、`apply`/`inject`、生命周期
- [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) — bundle manifest、profile 安装、构建授权
- [插件配置](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config) — Config/Schema 约定
- [插件与生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/) — Fiber 状态机与自动清理
- [事件系统](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events) — 事件模式与命名约定
- [从源码运行（根 README）](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#run-from-source) — 源码构建与启动
- [源码执行（CLI 参考）](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md#source-execution) — 构建与启动器行为
- [GitHub `dsh-plugin` 话题](https://github.com/topics/dsh-plugin) — 社区插件聚合

## License

MIT
