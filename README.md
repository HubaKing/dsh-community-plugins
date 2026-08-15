# dsh-community-plugins

> 一个 DeepSeek Harness 插件：让 agent 知道社区插件生态，学会找插件、装插件。
> A DeepSeek Harness plugin that teaches agents how to discover and install community plugins.

## 它是做什么的？

装了这个插件后，**每个 agent 会话**都会自动多出一个 skill：`dsh-community-plugins`。

agent 打开 skill 目录就能看到：

- 本机装了什么插件（dshmarket、dsh-plugin-marketplace 等）
- 去哪里找社区插件（GitHub `dsh-plugin` 话题、npm、dshmarket 市场）
- 怎么安装（dsh plugin 命令、GitHub 直装、tarball、GUI 一键安装）
- 注意事项（别改官方 preset、装完要重启）

简单说：**以后你问 agent「有没有 xx 插件」，它知道去哪找、怎么装，而不是一脸懵。**

## 安装

需要 dsh CLI（或从 dsh 安装根调 bin.js）。三种方式任选：

```bash
# 方式 1：GitHub 直装（推荐，零构建）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# 方式 2：tarball（离线可用）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.0/dsh-community-plugins-0.1.0.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.0.tgz

# 方式 3：源码 + link（开发模式，改文件即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
dsh plugin --profile web add link:${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins
```

> 💡 `dsh` 不在 PATH 时，用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。
> 装完**重启 dsh** 生效（bundle 层在启动时组合）。

**验证安装**：重启后新开一个会话，skill 目录里出现 `dsh-community-plugins` 就成功了。

## 工作原理

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：把 `skills/` 目录注册到全局 skill 注册表 |
| `cordis.patch.yml` | bundle 补丁：告诉 dsh 启动时加载这个插件 |
| `skills/dsh-community-plugins/SKILL.md` | skill 正文（就是 agent 会读到的那份指南） |

技术要点：

- **纯 JavaScript，零依赖** —— 从 GitHub 直接安装不需要构建授权（官方文档专门提醒 TypeScript 插件有这道坎，我们绕开了）
- **热更新** —— `index.js` 每次发现 skill 都从磁盘重读，改 `SKILL.md` 不用重启
- **写法完全符合官方教程**（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：`export const name` + `export function apply(ctx)` + `dsh.bundle` manifest

## 想改 skill 内容？

直接编辑 `skills/dsh-community-plugins/SKILL.md`，保存即生效（无需重启、无需重新安装）。

改完记得 `git push`，让其他使用者也能拉到。

## 目录结构

```
dsh-community-plugins/
├── index.js              # 插件入口（skill 注册）
├── cordis.patch.yml      # bundle 补丁层
├── package.json          # dsh.bundle manifest
├── README.md             # 本文件
└── skills/
    └── dsh-community-plugins/
        └── SKILL.md      # agent 读到的指南
```

## 常见问题

**Q: 装完没效果？**
重启 dsh 了吗？bundle 插件在启动时组合，必须重启。

**Q: 这个插件安全吗？**
纯 skill 注册，不执行任何网络请求、不运行任何外部代码，MIT 协议。

**Q: 以后 dsh 升级会不会丢？**
不会。插件装在 `$DSH_HOME`（用户根），官方升级只覆盖安装目录，不影响这里。

## License

MIT
