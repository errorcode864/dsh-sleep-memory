---
id: sleep-memory.guides.package-updates
title: npm 发布与远端更新
type: runbook
status: active
owner: maintainer
updated: 2026-11-10
source_of_truth: code-and-config-and-external
environment: GitHub Actions、npm 账号与远端 DSH profile
verification: 正式版 0.4.0 已完成公共 Registry 安装验证；新版工作流通过本地验证后仍需远端运行验收
---

# npm 发布与远端更新

插件以无 scope 包名 `dsh-sleep-memory` 发布到 npm 公共 Registry。
公共 registry 无需认证即可查询版本，任何 DSH 安装（npm 方式）都会自动获得
更新提示；旧的 GitHub Packages 安装与 Git 安装不会自动迁移。

## 目录

- [发布流程](#发布流程)
- [前置准备](#前置准备)
- [补建 0.4.0 的发布链路](#补建-040-的发布链路)
- [安装方式](#安装方式)
- [旧安装迁移](#旧安装迁移)
- [后续发版](#后续发版)
- [排查更新失败](#排查更新失败)
- [依据](#依据)

## 发布流程

发布工作流为 `.github/workflows/publish.yml`，支持两种入口：

- 推送 `v<version>` Tag 自动发版。
- 在默认分支通过 `workflow_dispatch` 指定已有 Tag，补建该版本的缺失产物。

工作流使用自身版本的发布工具，单独检出目标 Tag 的插件源码，按以下顺序运行：

1. **一致性校验**：只接受 `v主版本.次版本.修订版本`；包名与 Tag 版本必须匹配。
2. **回归验证**：运行发布工具测试、插件 `npm test` 和 `npm run eval`，失败不发布。
3. **独立查询状态**：分别判断正式版与 `<version>-dev.<run号>` 是否存在，
   Registry 认证、限流、服务故障和网络错误直接失败，只有 `404` 表示尚未发布。
4. **制品核对**：已有版本逐文件比对 Tag 打包结果；不一致直接失败，不覆盖版本。
   正式版已存在时，后续产物使用 Registry 中的原始 tarball。
5. **npm 通道**：先补齐 dev 版和 `dev` tag，再补齐正式版和 `latest` tag。
   dev 版仅改写 `package.json` 的版本号，不重新生成插件内容。
6. **dist 分支**：同步正式版制品，保留原有提交历史，内容一致时不重复提交。
7. **GitHub Release**：缺失时创建；已存在时保留人工编辑的说明。
8. **结果核验**：检查 npm 两个版本与通道、dist 分支和 Release。npm 接受发布后可能
   提示后台处理，工作流每 10 秒刷新查询，最多等待 5 分钟；每次查询使用独立缓存键。
   认证和网络异常仍立即失败，超时不把尚未公开的版本误报为成功。

正式版已存在不会阻止补建 dev、dist 或 Release。重跑同一次 Actions 运行复用原来的
dev 版本；重新发起一次手动运行使用新的运行编号，生成新的 dev 版本。
同一仓库的发布串行执行；目标版本比当前 `latest` 更旧时拒绝执行，防止回退通道和 dist。

npm 发布及通道管理使用 **Trusted Publisher（OIDC）**，工作流不读取 `NPM_TOKEN`。
仅配置 `id-token: write` 还不够，npm 侧必须授予对应工作流所需的操作权限。

## 前置准备

在 npm 的 `dsh-sleep-memory` 包设置中配置 Trusted Publisher：

| 配置项 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `errorcode864` |
| Repository | `dsh-sleep-memory` |
| Workflow filename | `publish.yml`，只填文件名 |
| Environment name | 留空，当前工作流未声明 environment |
| Allowed actions | 允许 `npm publish` 和 `npm dist-tag` |

仅允许 `npm stage publish` 的配置仍需人工审批，不能满足这条自动发布链路。
新建 Trusted Publisher 后，按 npm 当前规则需在 2 天内完成首次发布以验证配置。
工作流使用 GitHub 托管 Runner、Node 24 与 npm 11；无需额外的长期 npm Token。

工作流和 `.github/scripts/` 必须一起提交到默认分支，才能使用新版手动入口。
用户明确禁止代理执行 `git push`；文档中的推送命令均由维护者手动执行。

## 补建 0.4.0 的发布链路

`dsh-sleep-memory@0.4.0` 已于 2026-11-09 正式发布并完成隔离安装验证。
此前 CI 停在仅暂存 Token 的认证错误；新版工作流的远端执行结果仍需验收。

1. 按上节配置 npm Trusted Publisher。
2. 将本次工作流、发布工具和文档提交到 `main`，维护者手动推送：

   ```sh
   git push origin main
   ```

3. 在 `main` 上发起补建，保留现有 `v0.4.0` Tag：

   ```sh
   gh workflow run publish.yml --repo errorcode864/dsh-sleep-memory --ref main -f tag=v0.4.0
   ```

4. 在 Actions 中观察本次运行，并核对发布结果：

   ```sh
   gh run list --repo errorcode864/dsh-sleep-memory --workflow publish.yml --limit 3
   npm view dsh-sleep-memory dist-tags --json --registry=https://registry.npmjs.org/
   gh api repos/errorcode864/dsh-sleep-memory/git/ref/heads/dist --jq '.object.sha'
   gh release view v0.4.0 --repo errorcode864/dsh-sleep-memory
   ```

验收应看到 `latest: 0.4.0`、本次运行的 `dev: 0.4.0-dev.<run号>`、`dist` 分支和
`v0.4.0` Release。无需重推、覆盖或重建旧 Tag，也无需重复发布正式版。

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
`link:/path/to/sleep-memory` 即可；本地 `link:` 安装不显示更新属于预期。
如果手动创建链接，目录也必须为 `node_modules/dsh-sleep-memory`。

## 后续发版

1. 修改代码并运行 `npm test`、`npm run eval` 和 `node --test .github/scripts/release.test.mjs`。
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
| 发布失败 `403` / `ENEEDAUTH` | Trusted Publisher 的仓库、workflow 文件名、environment 是否完全匹配；是否允许直接 `npm publish` |
| 通道管理失败 `403` | Trusted Publisher 是否允许 `npm dist-tag`，该权限独立于发布权限 |
| 正式版存在但缺少 dev / dist / Release | 使用默认分支的新版手动入口指定已有 Tag，不重跑仍携带旧工作流的历史运行 |
| dev 版本装了但 latest 没变 | 工作流是否停在正式版发布或通道管理步骤，查看 Actions 日志 |
| 提示制品内容不一致 | 检查目标 Tag 是否对应已发布源码，禁止覆盖版本或移动旧 Tag 来绕过检查 |
| 发布成功但核验暂时查不到版本 | 查看 npm 是否提示后台处理；等待公开可查询后重跑原运行，复用相同 dev 版本 |
| 安装被发布冷却期阻止 | profile 的 `pnpm-workspace.yaml` 中 `minimumReleaseAge` 和排除项 |

若确实启用了发布冷却期，可在 `minimumReleaseAgeExclude` 列表中追加
`'dsh-sleep-memory'`，不要覆盖现有条目。

## 依据

- 仓库 `package.json`、`cordis.patch.yml`、`client.js`、发布工作流和 `.github/scripts/release.mjs`。
- 发布链路设计对照 [Nwflower/dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)
  的 `.github/workflows/release.yml`（tag 触发、dev tag 先行、同一 tarball 升 latest、dist 分支、trusted publishing）。
- [npm Trusted Publisher 官方说明](https://docs.npmjs.com/trusted-publishers/)。

[返回指南索引](README.md) · [返回插件说明](../../README.md)
