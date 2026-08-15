# dsh-community-plugins

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供社区插件生态指南的 bundle 插件。安装后，每个 agent 会话都会注册 `dsh-community-plugins` skill，使 agent 具备发现、评估、安装社区插件的能力。

[**English**](../../README.md) · [**中文**](README_zh.md)

---

> ⚡ 一页命令速查表：[docs/quick-reference.md](../quick-reference.md)

## 为什么需要本插件

DeepSeek Harness 的插件能力通过两类机制提供：**工具（Tools）** 与 **技能（Skills）**。两者互补，缺一不可：

| | 工具（如 `market_search`） | 技能（本插件注册的 skill） |
|---|---|---|
| 本质 | 能力通道：可调用的函数 | 上下文知识：何时、为何、如何调用 |
| 安装来源 | `dsh-plugin-marketplace` 等插件 | 本插件 |
| 单独安装时的效果 | 工具存在，但 agent 不认识它 | 无法调用任何市场接口 |

**仅安装市场工具是不够的。** LLM agent 的行为由上下文中的知识驱动：

- `web_search` 描述直观，是模型的默认通用手段；
- `market_search` 是 DSH 专属工具，agent 默认不知道它的存在、不觉得「安装插件」与其相关，也不了解本机 profile 结构、bundle 机制、评估流程与重启要求。

没有本插件时，agent 只能退化为网页搜索碰运气。安装本插件后，每个新会话的 agent 自动获得完整知识：本机已装哪些市场与工具、优先走哪条结构化检索通道、如何评估来源、如何按官方机制安装、装完如何验证。实测中，同一环境在 skill 生效前依赖网页搜索，生效后首次响应即直接调用 `market_search` 并给出准确安装命令。

## 功能

- 注册全局 skill：所有会话的 `<available_skills>` 目录自动出现 `dsh-community-plugins`
- 指导 agent 识别本机已安装插件（dshmarket、dsh-plugin-marketplace 等）
- 提供社区插件查找途径：GitHub `dsh-plugin` topic、npm、dshmarket 市场快照
- 提供官方推荐的安装方式：`dsh plugin` 命令、GitHub 直装、tarball、`link:` 开发模式
- 约束说明：不改官方 shipped preset、装后需重启、构建授权边界

## 安装

前置条件：dsh CLI（或从 dsh 安装根调用 `apps/cli/lib/bin.js`）。以下方式任选其一：

```bash
# GitHub 直装（纯 JS 零依赖，无需构建授权）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# tarball（可离线）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.0/dsh-community-plugins-0.1.0.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.0.tgz

# 源码 + link（开发模式，修改即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

安装后**重启 dsh**（bundle 层在启动时组合）。新会话中 `<available_skills>` 出现 `dsh-community-plugins` 即安装成功。

> `dsh` 不在 PATH 时，使用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。

## 工作原理

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：将 `skills/` 目录注册到 `ctx.skills` 全局注册表 |
| `cordis.patch.yml` | bundle 补丁层：`- insert:` 行在 profile 启动时挂载插件 |
| `skills/dsh-community-plugins/SKILL.md` | skill 正文，即 agent 读取的指南 |
| `package.json` | 声明 `dsh.bundle.patch` manifest |

要点：

- **纯 JavaScript、零依赖**：GitHub 直装无需 `prepare` 脚本与 `allowBuilds` 授权（TypeScript 插件的构建门槛，见官方文档）
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

## 构建与发布

本插件为纯 JavaScript、零依赖，无编译步骤，GitHub 直装与 tarball 均无需构建授权。

```bash
# 语法检查
node --check index.js

# 打包分发 tarball（pnpm pack）
pnpm pack

# 发布到 GitHub Release
# 1. 更新 package.json 的 version
# 2. 打 tag 并推送：git tag v<version> && git push origin v<version>
# 3. 在 GitHub Releases 页面创建 Release 并上传 pnpm pack 生成的 tarball
```

## License

MIT
