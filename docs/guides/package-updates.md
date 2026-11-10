---
id: sleep-memory.guides.package-updates
title: npm 发布与远端更新
type: runbook
status: active
updated: 2026-11-09
source_of_truth: code-and-config-and-external
environment: GitHub Actions、npm 账号与远端 DSH profile
verification: 工作流发布链路对照 dsh-claude-style 的 release.yml 设计；首次真实发布待部署验收
---

# npm 发布与远端更新

插件以无 scope 包名 `dsh-sleep-memory` 发布到 npm 公共 Registry。
公共 registry 无需认证即可查询版本，任何 DSH 安装（npm 方式）都会自动获得
更新提示；旧的 GitHub Packages 安装与 Git 安装不会自动迁移。

## 目录

- [发布流程](#发布流程)
- [前置准备](#前置准备)
- [安装方式](#安装方式)
- [旧安装迁移](#旧安装迁移)
- [后续发版](#后续发版)
- [排查更新失败](#排查更新失败)
- [依据](#依据)

## 发布流程

发布由 tag 触发（`.github/workflows/publish.yml`）：维护者把
`package.json` 升版并推送 `v<version>` tag，工作流自动完成：

1. **一致性校验**：tag 名必须等于 `package.json` 的 `version`，不匹配直接失败。
2. **回归测试**：跑 `npm test`，失败不发布。
3. **一次构建、两次发布**：
   - 同一份内容先以 `<version>-dev.<run号>` 发布到 npm 的 **`dev` tag**，
     可立即安装试用；
   - 随后把 `<version>` 以 **`latest`** 发布。同一 tarball，同一棵树。
4. **dist 分支**：发布内容同步推送到 `dist` 分支，支持
   `errorcode864/dsh-sleep-memory#dist` 的免构建 git 安装。
5. **GitHub Release**：自动创建 `v<version>` Release。

npm 发布使用 **trusted publishing**（OIDC）：工作流持有 `id-token: write`
权限即可换取一次性发布 token，仓库不需要存任何 npm 密钥。
已发布的版本不能重复发布；重复运行工作流会因 npm 拒绝同名版本而跳过。

## 前置准备

首次发布前，在 npm 完成一次性配置：

1. 在 [npmjs.com](https://www.npmjs.com) 注册/登录 `errorcode864` 账号，
   确认包名 `dsh-sleep-memory` 可用。
2. 在包所在 GitHub 仓库 → Settings → Environments 创建名为 `npm-publish`
   的 environment（或在包发布后于 npm 包设置页），把 GitHub 仓库
   `errorcode864/dsh-sleep-memory` 配置为 trusted publisher：
   workflow 文件名 `publish.yml`。首次发布需账号登录 npm 手动确认第一条
   provenance 或预先配置好 publisher。
3. 工作流文件必须先进入远端默认分支，tag 推送才会触发。

如果 npm 侧尚未配置 trusted publisher，也可以改用传统
`NODE_AUTH_TOKEN` secret（npm Automation token）发布：把工作流中的
`--provenance` 去掉，并在发布步骤加
`env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }`。

## 安装方式

```sh
dsh plugin --profile <profile> add dsh-sleep-memory                    # npm 包（推荐）
dsh plugin --profile <profile> add errorcode864/dsh-sleep-memory#dist  # dist 分支，免构建
```

也可以在 DSH 的「插件 → 添加插件 → 安装第三方插件」输入 `dsh-sleep-memory`。

需要远端更新提示时选择 npm 包安装；`github:`、Git URL、`link:`、`file:`
安装不参与版本更新检查。更新提示在打开插件页或手动检查时刷新。

## 旧安装迁移

迁移前导出记忆备份，并另存 profile 的 `package.json`、`pnpm-lock.yaml`、
`cordis.patch.yml` 和 `pnpm-workspace.yaml`。退出该 profile 的 DSH 后再修改，
避免运行时配置写回覆盖改动。

把依赖键和 `dsh.profile.bundles` 中的元素从 `@errorcode864/dsh-sleep-memory`
改为 `dsh-sleep-memory`，其他依赖和 bundle 保留：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-sleep-memory"]
    }
  },
  "dependencies": {
    "dsh-sleep-memory": "^0.4.0"
  }
}
```

已有 profile 的 `cordis.patch.yml` 若包含旧行名，把该行的 `name` 同步改为
`'dsh-sleep-memory'`。必须保留 `id: sleep-memory`、原 `config` 和其他配置行；
不要额外创建第二个记忆插件实例。同时删除用户级或 profile 级 `.npmrc` 里的
`@errorcode864:registry` 映射（不再需要）。

完成后在远端 profile 目录手动运行：

```sh
pnpm install
```

重新启动该 profile，刷新 GUI，检查记忆银行、原记录和插件配置。
包名迁移保留 `memory_bank`、`memory_runtime` 存储域、`sleep-memory`
配置行 ID 以及备份格式 `dsh-sleep-memory`。不要把旧安装先卸载再安装作为迁移的必要步骤。

本地源码开发使用相同包名，将依赖值换为
`link:E:/Project/AI/dsh-plugins/sleep-memory` 即可；本地 `link:` 安装不显示更新属于预期。
如果手动创建链接，目录也必须为 `node_modules/dsh-sleep-memory`。

## 后续发版

1. 修改代码并运行 `npm test`。
2. 用 `npm version patch --no-git-tag-version` 升级版本。
3. 提交并推送，再打 tag：`git tag v<version> && git push origin v<version>`。
4. 工作流自动发布 dev 与 latest；在 npm 包页确认 dist-tags。
5. 打开 DSH 插件页或重新检查版本，确认更新提示，再执行更新。
6. 核对安装版本、记忆记录数量、记忆银行和配置保存。

更新检查由插件页加载和手动检查触发，没有发版后的后台轮询或主动弹窗。
想尝鲜未升 latest 的版本，可在 profile 依赖里固定 `<version>-dev.<run号>`。

## 排查更新失败

| 现象 | 检查项 |
| --- | --- |
| 没有版本列表 | 依赖键、bundle 名、客户端注册和 npm 包名是否一致；安装来源是否仍为 Git、`link:`、`file:` 或包别名 |
| `404` | npm 包页是否存在该包与版本；首次发布是否成功 |
| tag 推送后工作流没跑 | 工作流文件是否在远端默认分支；tag 是否匹配 `v*` |
| 发布失败 `403` | trusted publisher 配置（仓库、workflow 文件名）是否与实际一致；或 `NPM_TOKEN` 是否有效 |
| dev 版本装了但 latest 没变 | 工作流在 dev 发布后的检查步骤是否失败，查看 Actions 日志 |
| 安装被发布冷却期阻止 | profile 的 `pnpm-workspace.yaml` 中 `minimumReleaseAge` 和排除项 |

若确实启用了发布冷却期，可在 `minimumReleaseAgeExclude` 列表中追加
`'dsh-sleep-memory'`，不要覆盖现有条目。

## 依据

- 仓库 `package.json`、`cordis.patch.yml`、`client.js` 和发布工作流。
- 发布链路设计对照 [Nwflower/dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)
  的 `.github/workflows/release.yml`（tag 触发、dev tag 先行、同一 tarball 升 latest、dist 分支、trusted publishing）。
- [npm trusted publishing 官方说明](https://docs.npmjs.com/generating-provenance-statements)。

[返回指南索引](README.md) · [返回插件说明](../../README.md)
