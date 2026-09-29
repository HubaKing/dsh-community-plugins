## dsh-community-plugins __VERSION__

为 DeepSeek Harness 提供社区插件生态指南的 bundle 插件：注册 `dsh-community-plugins` skill，并注册两个工具，把插件与本机 dsh 构建逐条比对。纯 JavaScript、单一依赖、无构建步骤、无 UI。本版为**全面适配 DSH 桌面版**的文档与判定修订版。

### 本版要点

- **新增「已安装」与「已生效」的判定**（`dsh_plugin_audit`）。bundle 层仅在进程启动时组合一次，因此「安装成功」与「运行进程已加载」是两个独立事实；此前工具只能报告前者，而生态中最常见的误判正是把二者混为一谈。现在审计会把**调用进程的启动时刻**与 profile 配置文件（`package.json`、`cordis.yml`）及各插件目录的 mtime 比较：晚于该时刻写入的 bundle 层不在运行进程中，报告头部给出激活提示，对应插件行下给出 `activation:` 说明。该判定为提示项，不改变兼容性结论；调用方未提供启动时刻时结果保持 `null`，不作推测。
  - 实测依据（2026-09-30，Windows，dsh `0.2.0-rc.2`，profile `desktop`）：桌面宿主进程启动于 03:31:42，`dsh-theme-kit` 于 03:34:38 写入 profile；对运行中的 HTTP 服务探测 `/dsh-theme-kit-wallpapers/...` 返回 404（未知路由），而 `/`、`/index.html`、`/api/health` 返回 401（路由存在、需鉴权），据此判定该插件的宿主半区未挂载。

- **lifecycle 脚本按安装来源分级**。`preinstall` / `install` / `postinstall` 在 registry 安装时执行，`prepare` / `prepublishOnly` 仅在 git 或本地（`link:`）安装与发布流程中执行。此前四者一律按安装期高危项报告，属于误报：实测中三个包声明了 `prepare` 而 `dsh plugin add` 未执行任何 lifecycle 脚本。现在前者报 `high`，后者报 `info` 并注明适用来源。

- **文档新增「适配范围」与「生效时机」两节**：明确本插件全面适配 DSH 桌面版，安装与判定默认跟随正在运行的 profile（`desktop` 与 `web` 属并列 profile，`bundles` / 依赖 / `compatibility.json` 互相独立）；并给出「是否登记 / 是否被组合 / 是否加载」三处独立状态的判据，说明只有活体图层能证明插件已生效。中英文 README 同步。

- **SKILL.md 全文改为标准书面语**，同时纳入本轮实测得到的新结论：
  - 版本门禁的精确版本豁免流程（`allow-version` / `revoke-version`，写入 `compatibility.json`，粒度为「包版本 × dsh 版本」），以及审计报告 `gate:` 行的豁免显示形态；
  - **包自述文档可能与 manifest 冲突，一律以 manifest 的 peer 区间与门禁实际比对结果为准**（实测：某仓库 INSTALL 声明支持 0.1.7 与 0.2，而包内 peer 上界 `<0.1.8-0` 排除 0.2）；
  - monorepo 的 git 安装形式 `github:<owner>/<repo>#path:/<subdir>`，以及仓库根目录无 `package.json` 时该形式的不可用性；
  - client-only 包（仅 `dsh.client`、无 `dsh.bundle`）不进入 `dsh.profile.bundles`，需宿主侧接线（皮肤中心一类加载器或 profile 自身 patch 层）；
  - 皮肤中心路线（`$DSH_HOME/skins/<id>/` 纯资产目录、加入与切换无需重启）与原生皮肤包属两条互不兼容的适配线，不得装入同一 profile；
  - 管理器型插件首次启动先禁用其管理的全部皮肤时，首次重启后仍为官方默认外观属预期行为。

- 注：判定口径中**除上述两项外没有其他变化**。v0.5.1 的安装根与 CLI 定位、`patchedDependencies` 残留导致 `remove` 整体回滚、预筛模式与发布年龄处理等结论仍然照旧。

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

> 上列 `--profile web` 均为示例；**在 DSH 桌面版上运行的是 `desktop` profile，须替换为 `--profile desktop`**。向非运行中的 profile 安装不会产生任何可见效果。

> `dsh` 不在 PATH 时，形态有两种：打包安装用 `& "<安装根>\resources\runtime\cli\bin\dsh.cmd"`，源码 checkout 用 `node <checkout>/apps/cli/lib/bin.js`。完整定位方法见 skill 的 §4。

> **npm 形态必须带 `@hubaking/` scope**：无 scope 的同名包属于另一个项目（funcodingdev），`add dsh-community-plugins` 会装错。

### 使用

1. 安装后**完全退出应用并重新启动**（bundle 层在启动时组合一次；改 `index.js` / `lib/` 同样必须重启）
2. 新开一个会话，`<available_skills>` 出现 `dsh-community-plugins`、工具列表出现 `dsh_plugin_audit` 与 `dsh_plugin_inspect` 即生效
3. 装某个包**之前**问：「这个包能装吗？」——agent 会调用 `dsh_plugin_inspect`（联网，把 tarball 拉下来审）；候选多时先让它传数组做预筛
4. 已经装了的，或升级 dsh **之后**问：「我装的插件现在怎么样？」——agent 会调用 `dsh_plugin_audit`（离线）；报告头部的激活提示用于判断是否存在「已安装但未生效」

### 验证

- profile 的 `package.json` 中，`dsh.profile.bundles` 含包名
- 会话 skill 目录出现本 skill；工具列表出现两个工具
- `dsh_plugin_audit({})` 返回本机全部第三方插件的结论；若 profile 在进程启动后被改写，报告头部出现激活提示
- `dsh_plugin_inspect({ spec: '<某个包>' })` 返回下载、校验与判定结果，且临时目录已清空
- `dsh_plugin_inspect({ spec: ['包 a', '包 b'] })` 返回预筛结果，且全程未下载任何包内容
- 九个测试套件全部通过（`npm test`，本版共 433 项检查）

### 文档

- README 中英双语（English / 中文），语言切换栏在文档顶部；两版均含「适配范围」与「生效时机」
- 官方文档：[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/publish) · [生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
