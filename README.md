# dsh-community-plugins

> DeepSeek Harness 社区插件生态指南：让每个 agent 会话都知道本 harness 已内置插件市场（dshmarket / dsh-plugin-marketplace），以及如何发现、评估、安装社区插件。
>
> The community-plugin guide for DeepSeek Harness: makes every agent session aware of the built-in plugin marketplaces (dshmarket / dsh-plugin-marketplace) and how to discover, vet, and install community plugins.

## 这是什么 / What this is

一个 **dsh bundle 插件**，注册 `dsh-community-plugins` skill 到全局技能注册表。安装后，所有会话的 `<available_skills>` 目录都会出现该 skill，agent 从此知道：

- 本机已经装了哪些插件（dshmarket、dsh-plugin-marketplace 等）
- 去哪里找社区插件（GitHub `dsh-plugin` topic、npm、dshmarket 快照）
- 怎么安装（`dsh plugin` 命令、bundle 配置、GUI 一键安装、`market_install` 工具）
- 注意事项（不要改官方 preset、装完要重启、link: 热更新等）

A dsh bundle plugin that registers the `dsh-community-plugins` skill into the global skill registry. Once installed, the skill shows up in every session's `<available_skills>` catalog, so agents know which plugins are installed, where to find more, and how to install them.

## 安装 / Install

三种方式任选（官方「打包与安装插件」教程推荐）：

```bash
# 方式 1：GitHub 直装（纯 JS 零依赖，无需构建授权）
dsh plugin --profile web add github:HubaKing/dsh-community-plugins

# 方式 2：tarball（从 Release 下载，离线可用）
curl -LO https://github.com/HubaKing/dsh-community-plugins/releases/download/v0.1.0/dsh-community-plugins-0.1.0.tgz
dsh plugin --profile web add ./dsh-community-plugins-0.1.0.tgz

# 方式 3：克隆源码 + link（开发模式，改文件即时生效）
git clone https://github.com/HubaKing/dsh-community-plugins.git "${DSH_HOME:-~/.dsh}/plugins/dsh-community-plugins"
node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add link:<克隆目录绝对路径>
```

> `dsh` CLI 不在 PATH 时，用 `node <dsh 安装根>/apps/cli/lib/bin.js plugin --profile web add <spec>`。
> 装完**重启 dsh**（bundle 层在启动时组合）。

安装后验证：`<available_skills>` 出现 `dsh-community-plugins`；`profiles/web/package.json` 的 `dsh.profile.bundles` 含包名。

## 更新 / Update

插件源码在克隆位置；编辑 `skills/dsh-community-plugins/SKILL.md` 即可更新指南内容——`index.js` 每次发现都从磁盘重读，**无需重启**（bundle 层本身已加载后）。

## 文件结构 / Layout

```
├── index.js              # ctx.skills provider 注册（零依赖，每次从磁盘重读）
├── cordis.patch.yml      # bundle 插入行
├── package.json          # dsh.bundle.patch 声明
└── skills/
    └── dsh-community-plugins/
        └── SKILL.md      # 指南本体（frontmatter: name + description）
```

## 许可 / License

MIT
