# 发布与应用内更新

发布走 `.github/workflows/release.yml`：推送 `v<版本>` 标签（须指向 `master`）后，
校验 tag 与各包内版本一致 → 构建 Windows 安装包（NSIS + MSI + 更新器签名产物）
与 Android 签名 APK → Release 说明取自 `CHANGELOG.md` 对应版本小节 → 附到该
tag 的 GitHub Release（Release 已存在时补传产物并更新说明）。

## 版本说明（CHANGELOG）

Release 说明 = `CHANGELOG.md` 中 `## <版本号>` 开头的小节（到下一个 `## ` 为止）；找不到或小节为空时构建失败。书写规范与强制更新标记（`<!-- min-version: x.y.z -->`）见 [CHANGELOG-GUIDE.md](CHANGELOG-GUIDE.md)。客户端版本低于 `min-version` 时更新提示不可关闭（详见下文）。

## Windows 更新签名（应用内一键更新）

官方 updater 插件（`tauri-plugin-updater`）下载安装包后先校验 minisign 签名再以
NSIS passive 模式安装。密钥与配置位置：

| 内容 | 位置 |
| --- | --- |
| 公钥 | `redesign/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| 更新器端点 | 同文件 `plugins.updater.endpoints`（`…/api/tauri/{{target}}/{{arch}}/{{current_version}}/{{bundle_type}}`） |
| 私钥 | 仓库 Settings → Secrets → Actions：`TAURI_SIGNING_PRIVATE_KEY` |
| 私钥密码 | 同上：`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密钥未设密码时留空，CI 只强校验私钥本身） |

当前密钥对已生成（无密码），私钥已写入上述 Secrets，并在维护者本机 `~/.tauri/aliyapet.key` 留有备份。私钥丢失后，已安装的旧版本将无法校验新包，只能让用户手动重装。需要换密钥时在 `redesign/` 下执行：

```powershell
npx tauri signer generate -w ~/.tauri/aliyapet.key
```

然后同步更新 `pubkey` 与两个 Secrets。

`createUpdaterArtifacts` 只在 CI 开启：本地 `npm run build` 不出 `.sig`（无私钥会直接
失败），CI 用 `npm run build -- --config src-tauri/tauri.release.conf.json` 叠加
`redesign/src-tauri/tauri.release.conf.json`（仅含 `bundle.createUpdaterArtifacts: true`）。
Android 走应用商店/浏览器下载 APK，不涉及签名密钥（APK 签名密钥见 [BUILD.md](BUILD.md)）。

## 发布服务

客户端内置服务地址列表（唯一来源）：`redesign/ui/src/update/config.ts`
`UPDATE_SERVICE_BASES`，默认 `['https://aliyapet.liminalselves.top']`，按序回退
（单地址网络错误/非 2xx/6s 超时换下一个）。本地联调可覆盖：

```powershell
$env:VITE_UPDATE_BASES = "http://127.0.0.1:8787"   # 逗号分隔多个
npm run build
```

（ updater 插件端点在 `tauri.conf.json`，本地联调同样用
`tauri build --config <覆盖文件>` 替换 `plugins.updater.endpoints`。）

服务端接口约定（CORS 开放）：

- `GET {base}/api/check?platform=windows|android&version=0.1.0`
  - 有更新：`{ updateAvailable: true, mandatory, current, latest, publishedAt, notes(markdown), downloadUrl(apk/页面), size, releasePage }`
  - 无更新：`{ updateAvailable: false, mandatory: false, current, latest }`
  - `mandatory` 由服务端按 CHANGELOG 的 `min-version` 标记推导。
- `GET {base}/api/tauri/{{target}}/{{arch}}/{{current_version}}/{{bundle_type}}`
  - 204（无更新）或 Tauri updater 动态 JSON：`{ version, pub_date, url, signature, notes }`。
  - `{{bundle_type}}` 是当前安装用的安装包类型（`nsis` / `msi`），服务端据此返回同类安装包；
    用 MSI 装的会继续用 MSI 更新，不会被 NSIS 安装程序再装一份。
  - 不带 `{{bundle_type}}` 的旧路径按 NSIS 处理。

## 客户端行为

- 启动：pet 页模型就绪后延迟 3s 静默检查；失败不打扰。Windows 经 Rust `show_update`
  唤起独立 `update` 窗口（pet 窗口透明穿透，不能画 UI）；Android 仅在 App 内全屏
  主界面弹页内模态（悬浮窗形态不打扰）。代码在 `redesign/ui/src/update/`。
- 设置 → 关于 → 「检查更新」：手动入口不受「跳过此版本 / 稍后」抑制；
  就地展示「已是最新版本 v… / 检查失败，请稍后重试」。
- 非强制提示：「稍后」= 本次启动内不再提醒；「跳过此版本」= 记住直到出现更新的版本
  （localStorage `aliya_pet_update_skip`）。失败时主按钮变为「重试」，并提供「改为手动下载」
  （打开发布页）。
- 强制更新（`mandatory`）：不显示「稍后 / 跳过此版本」，并展示说明行
  「当前版本已停止支持，需要更新后继续使用」。Windows 更新窗口关闭按钮 =
  退出应用；Android 返回键被模态拦截，无法绕过。

## 发布流程（两段式）

分支模型：日常开发在 `develop`（功能分支合入它），`master` 只保存已发布版本。**两段命令各自独立，只有用户明确下达才执行对应段。**

### 第一段：发布前准备（用户明确要求「发布前准备」，且当前在 `develop`）

1. 更新版本号（必须一致，`release.yml` 会逐项校验）：`redesign/package.json`、`redesign/package-lock.json`、`redesign/ui/package.json`、`redesign/ui/package-lock.json`、`redesign/src-tauri/tauri.conf.json`、`redesign/src-tauri/Cargo.toml`、`redesign/src-tauri/Cargo.lock`、`redesign/android/app/build.gradle.kts`（`versionName` 与递增的 `versionCode`），以及 README 版本徽章；按 [CHANGELOG-GUIDE.md](CHANGELOG-GUIDE.md) 在 `CHANGELOG.md` 顶部新增 `## <版本>` 小节。
2. 校对文档：`README.md`、`docs/*.md` 与代码现状一致（数值、设置项、流程）。
3. 清理仓库中无用或临时开发文件（`git status` 无多余未跟踪文件，无调试残留）。
4. 本地跑 `npm test`、`npm run build`（`redesign/ui`）及 `cargo test`（`redesign/src-tauri`）。
5. 从 `develop` 切 `release/v<版本>` 分支，提交并推送，向 `master` 创建 PR；若仓库有 CI，等待全部检查通过（没有 CI 则跳过）。
6. 审查 PR 内容与 CI，确认可发布后**停止**：PR 保持 open，不合并、不打 tag。

### 第二段：正式发布（用户明确下达「发布」）

1. 合并上述 PR 到 `master`（`gh pr merge <号> --merge`）。
2. 在 `master` 最新提交上打并推送 tag：`git checkout master && git pull && git tag v<版本> && git push origin v<版本>`。
3. 推送 tag 会自动触发 `release.yml`，它构建 Windows 与 Android 产物并执行 `gh release create`（已存在则补传并更新说明）。该 Release 即为 GitHub 上的「Latest」——**GitHub 把创建时间最新、且非 pre-release/draft 的 Release 标为 Latest，无需手动设置**。用 `gh run watch` 观察工作流，`gh release view v<版本>` 确认产物齐全（`.exe`、`.msi`、各 `.sig`、`AliyaPet_v<版本>.apk`）。
4. 把 `master` 合回 `develop` 并推送，保证基线一致：`git checkout develop && git pull && git merge master && git push origin develop`；删除已合并的 `release/v<版本>` 分支。
