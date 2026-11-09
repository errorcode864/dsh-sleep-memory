---
id: sleep-memory.guides.package-updates
title: GitHub Packages 发布与远端更新
type: runbook
status: active
updated: 2026-11-09
source_of_truth: code-and-config-and-external
environment: GitHub Actions、本地发布账号与远端 DSH profile
verification: 本地回归与打包预演；首次发布和远端更新链路待部署验收
---

# GitHub Packages 发布与远端更新

插件通过 `@errorcode864/dsh-sleep-memory` 发布到 GitHub Packages。
远端必须使用同名 Registry 依赖，DSH 才会检查版本；旧 Git 安装不会自动迁移。
本指南和发布工作流已配置，首次发布、远端认证及真实更新提示仍需部署验收。

## 目录

- [首次发布](#首次发布)
- [远端认证](#远端认证)
- [旧安装迁移](#旧安装迁移)
- [后续发版与验收](#后续发版与验收)
- [排查更新失败](#排查更新失败)
- [依据](#依据)

## 首次发布

推荐在仓库的 Actions 页面手动运行「发布 GitHub Packages」工作流。
工作流使用仓库自动提供的 `GITHUB_TOKEN`，申请 `packages: write`，
先执行现有回归测试和打包预演，再发布，无需向仓库添加个人发布 Token。
工作流文件必须先进入远端默认分支；本地配置不会自动出现在 GitHub。

首次从 `main` 手动发布 `0.3.0` 即可。也可以创建 `v0.3.0` Release：
工作流会校验 Tag 与 `package.json` 版本一致。已发布的版本不能重复发布；
手动运行与 Release 触发二选一，同一版本不要重复触发。

GitHub Packages 首次发布默认可见性为私有。发布后在包设置中核对可见性、
关联仓库和读取权限；关联公开源码仓库不表示包必须公开，私有包也不会隐藏公开源码。

需要本地发布时，使用具有 `write:packages` 权限的
personal access token (classic) 登录：

```sh
npm login --scope=@errorcode864 --auth-type=legacy --registry=https://npm.pkg.github.com/
npm test
npm pack --dry-run --ignore-scripts
npm publish --registry=https://npm.pkg.github.com/ --ignore-scripts
```

登录提示中的密码填写 Token。GitHub Packages 的此认证路径需要 classic PAT，
不要使用 fine-grained PAT。`package.json` 不设置 `private: true`，
该字段会禁止发布；访问权限由 GitHub Packages 控制。

## 远端认证

在运行远端 DSH 的同一系统账号下，使用具有 `read:packages` 权限且能读取目标包的
classic PAT 执行登录：

```sh
npm login --scope=@errorcode864 --auth-type=legacy --registry=https://npm.pkg.github.com/
```

登录凭据保存在该账号的用户级 `.npmrc`，不要提交到仓库。
在实际使用的 profile 目录 `.npmrc` 中合并以下 scope 映射，保留其他配置：

```ini
@errorcode864:registry=https://npm.pkg.github.com/
```

若服务使用独立账号，应给该账号配置凭据。仅在终端设置 `NODE_AUTH_TOKEN`
或 `GITHUB_TOKEN` 不足以保证 GUI 可用：当前 DSH 的插件管理子进程会过滤
名称包含 `TOKEN`、`KEY`、`SECRET`、`PASSWORD` 的环境变量。
使用用户级 `.npmrc` 登录凭据可避免这一问题。

在 profile 目录验证：

```sh
pnpm view @errorcode864/dsh-sleep-memory version --registry=https://npm.pkg.github.com/
pnpm view @errorcode864/dsh-sleep-memory versions time dist-tags --json
```

第一条验证指定 Registry 的认证，第二条验证 DSH 默认查询所依赖的 scope 映射。
第二条也必须成功；不要只验证终端能从 GitHub 拉取源码。

## 旧安装迁移

迁移前导出记忆备份，并另存 profile 的 `package.json`、`pnpm-lock.yaml`、
`cordis.patch.yml` 和 `pnpm-workspace.yaml`。退出该 profile 的 DSH 后再修改，
避免运行时配置写回覆盖改动。

将原 `dsh-sleep-memory` 依赖键和 `dsh.profile.bundles` 中的对应元素改为新包名，
其他依赖和 bundle 保留。以下是要合并的片段，不是完整 profile：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@errorcode864/dsh-sleep-memory"]
    }
  },
  "dependencies": {
    "@errorcode864/dsh-sleep-memory": "^0.3.0"
  }
}
```

已有 profile 的 `cordis.patch.yml` 若包含旧行名，将该行的 `name` 同步改为
`'@errorcode864/dsh-sleep-memory'`。必须保留 `id: sleep-memory`、
原 `config` 和其他配置行；不要额外创建第二个记忆插件实例。

完成上述修改后，由用户在远端 profile 目录手动运行：

```sh
pnpm install
```

重新启动该 profile，刷新 GUI，检查记忆银行、原记录和插件配置。
本次包名迁移保留 `memory_bank`、`memory_runtime` 存储域、
`sleep-memory` 配置行 ID 以及备份格式 `dsh-sleep-memory`。
不要把旧安装先卸载再安装作为迁移的必要步骤。

本地源码开发使用相同包名，将依赖值换为
`link:E:/Project/AI/dsh-plugins/sleep-memory` 即可；本地 `link:` 安装不显示更新属于预期。
如果手动创建链接，目录也必须为 `node_modules/@errorcode864/dsh-sleep-memory`，
仅保留旧的 `node_modules/dsh-sleep-memory` 不能满足新包名解析。

## 后续发版与验收

1. 修改代码并运行 `npm test`。
2. 用 `npm version patch --no-git-tag-version` 升级版本，例如从 `0.3.0` 升至 `0.3.1`。
3. 用户提交并同步代码到 GitHub，再手动运行发布工作流，或创建匹配版本的 Release。
4. 在远端 profile 运行 `pnpm view @errorcode864/dsh-sleep-memory version`，
   确认 Registry 已提供新版本。
5. 打开 DSH 插件页或重新检查版本，确认出现版本列表和更新提示，再执行更新。
6. 核对安装版本、记忆记录数量、记忆银行和配置保存。

更新检查由插件页加载和手动检查触发，没有发版后的后台轮询或主动弹窗。
首次迁移必须完成后，后续发版才进入这条更新链路。

## 排查更新失败

| 现象 | 检查项 |
| --- | --- |
| 没有版本列表 | 依赖键、bundle 名、客户端注册和 Registry 包名是否一致；安装来源是否仍为 Git、`link:`、`file:` 或包别名 |
| `401` / `403` | DSH 运行账号的登录凭据、classic PAT 的 `read:packages` 权限和目标包读取权限 |
| `404` | 首次发布是否成功、包名是否正确、当前账号是否有权访问私有包 |
| 指定 Registry 成功，默认查询失败 | profile 或用户级 `.npmrc` 的 scope 映射以及插件管理器的 Registry 设置 |
| GUI 失败，终端成功 | DSH 的系统账号、profile 目录和子进程环境变量过滤是否导致认证差异 |
| 安装被发布冷却期阻止 | profile 的 `pnpm-workspace.yaml` 中 `minimumReleaseAge` 和排除项 |

若确实启用了发布冷却期，可在原 `minimumReleaseAgeExclude` 列表中追加
`'@errorcode864/dsh-sleep-memory'`，不要覆盖现有条目。
若插件管理器指定了 Registry，先在相同配置下验证查询是否仍命中 GitHub Packages；
为简化排查，建议保留默认 Registry 设置并使用 scope 映射。

## 依据

- 仓库 `package.json`、`cordis.patch.yml`、`client.js` 和发布工作流。
- DSH 的 `plugin-manager/src/index.ts` 中 `updateRefusal`、`listVersions`，
  `operations.ts` 中 `viewProfilePackage`，`dsh-subprocess` 中 `scrubbedParentEnv`；
  已于 2026-11-09 对照本机源码核实。
- [GitHub npm Registry 官方说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。
- [GitHub Actions 发布 Node.js 包官方说明](https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-nodejs-packages)。

[返回指南索引](README.md) · [返回插件说明](../../README.md)
