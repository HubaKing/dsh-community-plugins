## dsh-community-plugins __VERSION__

为 DeepSeek Harness 提供社区插件生态指南的 bundle 插件：注册 `dsh-community-plugins` skill，并注册两个工具，把插件与本机 dsh 构建逐条比对。纯 JavaScript、单一依赖、无构建步骤、无 UI。本版为**输出契约与判定口径的缺陷修复版**。

> 本版修的是「工具跑完了、结论也算出来了，却被宿主整份丢弃」这一类问题，以及一个把正常插件误判成不可用的系统性偏差。所有条目均有复现命令与实测记录。

### 本版要点

- **修复 `dsh_plugin_inspect` 对 github / tarball 路径返回 `invalid output: value is not lossless JSON`**（阻断级）。`inspect.js` 曾用 `Object.assign` 无条件合并 `latestVersion` / `ageMinutes` / `skippedByAge` 三个字段，而 `resolveGithub()` 根本不产生它们，于是 `report.source` 上出现值为 `undefined` 的自有属性。宿主要求返回值为 lossless JSON，一个 `undefined` 就足以让**整份已经算完的报告被丢弃**——下载、校验、解包、判定全部白做。npm 路径不受影响，所以该缺陷只在真正需要 github 路径时暴露：实测一次会话中连续失败 3 次，而同一工具的 npm 调用全部正常。
  - 修复分两层：根因上两个 resolver 改为**同构返回**（缺省键显式写 `null`，并新增 `requestedRef`）；兜底上新增 `lib/serialize.js`，由 `finalizeReport()` 对报告做递归净化。被净化过的报告会在正文末尾**如实说明改动了几项**，不做静默修正。

- **修复 `dsh_plugin_audit` 自身的同类缺陷**（实施中发现）。`runtimeServices[].present` 只判断了 `=== null`，而 live service probe 在「服务不存在」时返回 `undefined`，该值被直接存入 payload，同样使整份审计报告被丢弃。现在 `present` 收紧为严格布尔（`probed === true`），`undefined` 与 `null` 统一归入「离线不可判定」；并把净化兜底**同样加到审计工具的返回路径**——契约由代码强制，不依赖每个调用点自律。

- **`github:` ref 的 `v` 前缀归一化**。`#v0.8.1` 曾被原样当作版本号（`v0.8.1`），与已安装的 `0.8.1` 无法比较，导致装完之后再审计会误报「版本不同」。现在只剥离语义版本形状的前导 `v`，分支名（`main`）、短标签（`v2`）、commit sha 一律不动，同时保留 `requestedRef` 显示实际 pin 的 ref。

- **`react` 等浏览器端 peer 不再把整包降级为 `unknown`**。官方 client 包把 `react` 声明为 `devDependencies` 而非 peer——Web 客户端产物自带 React，因此本机任何 host 侧 `node_modules` 都查不到它，这是**正常形态**。此前工具把它记为 `unknown`，实测一次会话中**12 个正常工作**的 client 插件因此从 `COMPATIBLE` 被降为 `UNKNOWN`。
  - 修复比「白名单豁免」更进一步：从 `<dshRoot>/apps/web/node_modules/react`（本机实测 `18.3.1`）读取**权威版本**做真比对。
  - 判据没有放宽：`react: ^17` 在 18.3.1 上仍会被正确判为 **at-risk**。只有在确实读不到时才计入新的 `structural` 桶——单独计数、不影响 verdict，并在 `peers:` 行显示为 `supplied by the Web client (browser-half, not host-resolved)`。

- **预筛 verdict 改用 `METADATA-OK`**，并给每一行加上 `· package contents not audited`。此前的 `COMPATIBLE` 与完整审计共用同一个最强词汇：实测一次预筛 14 个包全部显示 `COMPATIBLE`，被读成「14 个都能装」，而其中一个包带着绕过 `dsh plugin` 的 `install.cmd`、另一个必须做完整审计才能看出问题。「没看什么」现在写在每一行上，而不是只躺在报告底部。

- **新增同名包歧义告警**。本生态存在真实的命名撞车：`dsh-reasoning-effort` 一个尾部名称对应 **5 个不同发布者**——裸名那个审计为 `AT-RISK`，而用户真正想要的（★227）**根本没发 npm、只存在于 GitHub Release**。直接 `add dsh-reasoning-effort` 会装到前者，两者表现几乎一样，只在出问题时才暴露。
  - 新增 `findNameCollisions()`：单包审计与预筛两种模式都会报告 `! this name has N other publisher(s)`。
  - 该探测**不改变 verdict**（被审计的包按自身证据判定），只回答「你选的是不是这一个」；只读 registry 元数据，失败时静默跳过而**不拖垮整份审计**。
  - 实测：精确命中 3 个 `dsh-reasoning-effort` scope 变体，且对唯一名（如 `dsh-codex-effort-slider`）不误报；前缀相近的 `dsh-reasoning-effort-plus` 也不会被当成撞名。

- **pin 版本时提示持久化副作用**。`dsh plugin add <pkg>@<version>` 会让 pnpm 把该版本写入 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，该豁免会**存活到安装之后**。现在报告中一并说明如何撤销。

### 文档更新

- **新增「GitHub Release 预构建 tarball」安装路径**。生态中高 star 插件常常只发 Release、不发 npm，此时 `github:` 源码形式需要现场构建 TypeScript，而 Release 附件是构建产物、装完即用。文档给出三者的取舍表、判断依据、完整命令，以及 tarball 直链没有 registry integrity 兜底时应如何比对字节（附可直接粘贴的 PowerShell 片段）。
- **新增「同名歧义」判据**，含上述 5 个 `dsh-reasoning-effort` 的实例表。
- **更正两处原结论**：其一，`react` peer 并非「不可判定」，而是版本在 client 构建里；其二，安装根探测**本来就正确选中了源码 checkout**（实测 `sourceTreeAvailable: true`、329 个官方包），原先「打包安装导致降级」的推断不成立。

### 测试

- 测试从 **436 项增至 469 项**，全部通过。
- 新增 `test/serialize.test.mjs`（输出契约、`v` 前缀、probe 各种返回形态、审计工具入口）与 `test/collisions.test.mjs`（撞名探测与渲染）。
- 真实包回归：**27 个** npm 包逐个完整审计，**0 个 lossless 失败**；预筛 27/27 无 error（其中 2 个仅因网络抖动超时，重试后正常返回报告——提示：修复后超时也会**返回带错误的报告**，而不是被静默丢弃）。

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
3. 装某个包**之前**问：「这个包能装吗？」——agent 会调用 `dsh_plugin_inspect`（联网，把 tarball 拉下来审）；候选多时先让它传数组做预筛。注意预筛结论是 `METADATA-OK`，**不等于可以装**
4. 已经装了的，或升级 dsh **之后**问：「我装的插件现在怎么样？」——agent 会调用 `dsh_plugin_audit`（离线）；报告头部的激活提示用于判断是否存在「已安装但未生效」

### 验证

- profile 的 `package.json` 中，`dsh.profile.bundles` 含包名
- 会话 skill 目录出现本 skill；工具列表出现两个工具
- `dsh_plugin_audit({})` 返回本机全部第三方插件的结论；若 profile 在进程启动后被改写，报告头部出现激活提示
- `dsh_plugin_inspect({ spec: '<某个包>' })` 返回下载、校验与判定结果，且临时目录已清空
- `dsh_plugin_inspect({ spec: 'github:<owner>/<repo>#v1.2.3' })` **必须返回报告**（本版修复的核心）；报告头 `version` 显示 `1.2.3`，并保留 `requestedRef: v1.2.3`
- `dsh_plugin_inspect({ spec: ['包 a', '包 b'] })` 返回预筛结果，且全程未下载任何包内容
- 十一个测试套件全部通过（`npm test`，本版共 469 项检查）

### 文档

- README 中英双语（English / 中文），语言切换栏在文档顶部
- 官方文档：[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/publish) · [生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
