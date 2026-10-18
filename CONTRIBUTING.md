# 分支协作规范

本仓库多人协作，分支分三类：

| 分支 | 定位 | 更改方式 |
| --- | --- | --- |
| `master` | 稳定基线 | 仅接受 PR 合并，已开启分支保护，禁止直接 push |
| `develop` | 积极开发主线 | 建议走 PR 合并，也允许直接 push |
| 任务分支 | 单个开发任务 | 按需从 `master` 或 `develop` 拉出 |

## 任务分支

- 日常开发从 `develop` 拉出，命名 `feature/<主题>`、`fix/<问题>`、`docs/<主题>` 等
- 需要基于稳定版本的工作（如线上修复）从 `master` 拉出，合并回 `master` 后再同步进 `develop`
- 任务分支保持短生命周期，合并后删除远端和本地分支

## 拉取请求

- 合并进 `master` 或 `develop` 的 PR，无 CI 强制要求时由作者自行确认可合并
- PR 标题使用中文 Conventional Commit 前缀（`feat:`、`fix:`、`docs:` 等），与直接提交一致
