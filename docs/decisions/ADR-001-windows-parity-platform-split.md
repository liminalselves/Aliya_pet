---
id: ADR-001
title: 以共享前端加平台原生壳对齐 Windows 能力
status: accepted
date: 2026-11-03
---

# ADR-001: 以共享前端加平台原生壳对齐 Windows 能力

## 1. 决策背景

`origin/master` 的 Windows 能力与当前 `mac` 分支存在较大差异。master 的部分实现
直接依赖 Windows 物理像素、WebView2 窗口行为和 Win32 API；当前 macOS 分支则增加了
Cocoa points、AppKit child window、菜单栏 accessory 和 LaunchAgent。直接以任一分支
覆盖另一分支都会破坏一个平台。

## 2. 决策

- 以当前 `mac` 分支作为保留 macOS 行为的基线，在 `feat/windows-parity` 上选择性移植
  master 的能力。
- 共享业务和 UI 继续放在 `redesign/ui/src`；窗口几何、穿透、托盘、更新窗口转交和
  自启等系统能力放在 Rust/Tauri 壳。
- Windows chat 使用 master 的固定外窗方案：外窗尺寸稳定，卡片宽度通过
  `chat-layout` 事件交给页面做 DOM 缩放，避免频繁 resize WebView2 产生残影。
- macOS chat 继续使用 points 坐标和 AppKit 原子 frame/child ordering；共享命令在
  平台条件分支中保持相同业务协议。
- updater 使用 Tauri 官方 updater 插件。客户端检查服务负责版本策略，插件负责
  Windows 包下载、minisign 验签和 NSIS passive 安装。

## 3. 备选方案与否决理由

- **直接合并 `origin/master`**：会删除 `macos.rs`、`geometry.rs`、macOS 配置和
  Universal workflow，违反保留 macOS 能力的目标。
- **为 macOS 和 Windows 复制两套完整前端**：会造成聊天、设置和消息协议分叉，增加
  回归成本，违背现有共享 Web 内核架构。
- **继续动态创建 chat/update WebView**：Windows 已验证命令线程中创建第二个 WebView2
  存在死锁风险，因此继续采用启动预创建、运行时 show/hide。
- **用第三方更新器替代 Tauri updater**：增加依赖和协议分叉；官方插件已覆盖签名、
  下载和安装模式，当前需求不需要额外抽象。

## 4. 后果与权衡

### 正面

- macOS 的原生窗口行为得到保留，Windows 能力可以接近 master 逐项恢复。
- 共享前端协议只维护一份，Android 继续复用聊天和设置业务。
- 固定外窗减少 Windows WebView2 重合成闪烁；平台几何差异集中在适配层。

### 代价

- `main.rs`、`chat_window.rs` 和共享前端需要较多条件编译与协议回归。
- updater 需要 CI 签名 Secret 和 Windows 实机验收，不能仅靠 macOS 本机构建证明。
- master 后续共享 UI 改动仍需审查 Android 与 macOS 的兼容性。

## 5. 约束

- 不提交任何签名私钥、账号令牌或本机路径。
- 不以删除测试、放宽类型检查或绕过平台构建来解决冲突。
- 每个阶段先跑最窄相关测试，再跑完整前端/Rust/打包检查。
