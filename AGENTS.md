# 仓库协作规则（AI 代理必读）

## 分支

- 开发在从 `develop` 拉出的功能分支上完成，合入 `develop`；`master` 只保存已发布版本。
- 提交信息用中文，前缀 `feat:` `fix:` `docs:` `chore:` `test:` `perf:`。

## 发布流程

完整步骤见 [docs/RELEASE.md](docs/RELEASE.md)「发布流程（两段式）」。硬性规则：

1. **「发布前准备」**（仅在 `develop` 上、用户明确要求时）：更新所有版本号 + `CHANGELOG.md` → 校对文档 → 清理无用/临时文件 → 本地测试 → 提交、推送、开 PR（`release/v<版本>` → `master`）→ 若有 CI 则等其全部通过 → 审查后**停止**，PR 保持 open。不得合并、不得打 tag。
2. **「发布」**（仅用户明确下达时）：合并 PR → 在 `master` 打 `v<版本>` tag 并推送（触发 `release.yml` 构建并创建 GitHub Release，即 Latest）→ 确认 Release 产物 → 把 `master` 合回 `develop` 并推送。
3. 用户没有明确说出对应指令时，不得自行进入这两段流程。

## 验证

改动前后在 `redesign/ui` 运行 `npm test` 与 `npx tsc --noEmit`；改 Rust 则在 `redesign/src-tauri` 运行 `cargo test`。性能优化不得改变画面、动作与命中判定。
