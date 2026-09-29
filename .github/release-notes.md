## dsh-community-plugins __VERSION__

为 DeepSeek Harness 提供社区插件生态指南的 bundle 插件：注册 `dsh-community-plugins` skill，并注册两个工具，把插件与本机 dsh 构建逐条比对。纯 JavaScript、单一依赖、无构建步骤、无 UI。

### 本版要点

- **补齐三项只有实测才能得到的排障与定位**（全部来自一次真实安装的踩坑记录）：

  - **安装根与 CLI 的定位**。此前文档只给了一条 `node <dsh 根>/apps/cli/lib/bin.js`，而**打包安装上那个路径并不存在**（`resources/app.asar.unpacked/dsh` 里只有 `node_modules`）。现在写清两种形态：打包安装用应用自带的 `resources/runtime/cli/bin/dsh.cmd`（内部是 `ELECTRON_RUN_AS_NODE=1` + asar 里的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`，其所在目录在部分机器上并不在 PATH），源码 checkout 用 `apps/cli/lib/bin.js`；并给出安装根的搜索顺序，以及「只有源码 checkout 能当审计工具的安装根、纯打包安装会把 API 面检查降级为 `unknown`」这一结论。

  - **要包名就搜 registry，别从 GitHub 反查**。GitHub 未认证搜索实测 8 个候选后开始 403，而 registry 的 `/-/v1/search` 一次返回 100 条包名+描述+版本+发布日。推荐顺序：先 registry 拿包名与候选池，再用 GitHub topic 补 stars / 活跃度 / 许可证全文。

  - **`dsh plugin remove` 报错却什么都没删**。profile 的 `pnpm-workspace.yaml` 里残留的 `patchedDependencies` 条目会让 pnpm 报 `ERR_PNPM_UNUSED_PATCH` 并**整体回滚**（包、`node_modules`、`dsh.profile.bundles` 原封不动）。文档给出成因、处置步骤与事后该确认的三处；同时写明 `add` 被版本门禁拒绝也是原子失败，什么都没装。

- **发布说明改为仓库内文件**（`.github/release-notes.md`）。此前的说明内嵌在 workflow 里、经 runner 环境变量传递，实测在 v0.5.0 的 Release 正文里产生了 2 个 U+FFFD 替换字符（而本地文件与 GitHub 上的副本都是干净的）。现在用 `sed` 替换版本号后 `gh release create --notes-file` 读取文件，这类重编码不会再有，说明本身也可评审、可 diff。v0.5.0 的正文已一并订正。

- 注：**判定口径与工具行为在本版没有变化**。上一版（v0.5.0）新增的预筛模式 `dsh_plugin_inspect({ spec: [...] })`（只读 registry 文档、不下载包内容）与 `gate:` 版本门禁判定仍然照旧，细节见 v0.5.0 的发布说明。

### 安装

```bash
# 方式 1：GitHub 直装
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# 方式 2：tarball（可离线）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/__VERSION__/hubaking-dsh-community-plugins-__VERSION__.tgz
dsh plugin --profile web add ./hubaking-dsh-community-plugins-__VERSION__.tgz

# 方式 3：源码 + link（开发模式，修改即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:"${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"

# 方式 4：npm —— 仅当本仓库配置了 NPM_TOKEN secret 且发布步骤真正执行时才可用
dsh plugin --profile web add @hubaking/dsh-community-plugins
```

> `dsh` 不在 PATH 时，形态有两种：打包安装用 `& "<安装根>\resources\runtime\cli\bin\dsh.cmd"`，源码 checkout 用 `node <checkout>/apps/cli/lib/bin.js`。完整定位方法见 skill 的 §4。

> **npm 形态必须带 `@hubaking/` scope**：无 scope 的同名包属于另一个项目（funcodingdev），`add dsh-community-plugins` 会装错。

### 使用

1. 安装后**重启 dsh**（bundle 层在启动时组合；改 `index.js` / `lib/` 必须重启）
2. 新开一个会话，`<available_skills>` 出现 `dsh-community-plugins`、工具列表出现 `dsh_plugin_audit` 与 `dsh_plugin_inspect` 即生效
3. 装某个包**之前**问：「这个包能装吗？」——agent 会调用 `dsh_plugin_inspect`（联网，把 tarball 拉下来审）；候选多时先让它传数组做预筛
4. 已经装了的，或升级 dsh **之后**问：「我装的插件现在怎么样？」——agent 会调用 `dsh_plugin_audit`（离线）

### 验证

- `${DSH_HOME:-~/.dsh}/profiles/web/package.json` 的 `dsh.profile.bundles` 含包名
- 会话 skill 目录出现本 skill
- `dsh_plugin_audit({})` 返回本机全部第三方插件的结论
- `dsh_plugin_inspect({ spec: '<某个包>' })` 返回下载、校验与判定结果，且临时目录已清空
- `dsh_plugin_inspect({ spec: ['包 a', '包 b'] })` 返回预筛结果，且全程未下载任何包内容

### 文档

- README 中英双语（English / 中文），语言切换栏在文档顶部
- 官方文档：[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/publish) · [生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
