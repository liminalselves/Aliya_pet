---
id: PROPOSAL-001
title: 对齐 master 的 Windows 桌面能力并保留 macOS 壳层
status: accepted
author: Agent & User
date: 2026-11-03
branch: feat/windows-parity
worktree:
---

# PROPOSAL-001: 对齐 master 的 Windows 桌面能力并保留 macOS 壳层

## 1. 背景与问题

当前 `mac` 分支已经完成 macOS 原生窗口、菜单栏、聊天伴侣窗、透明区域穿透和
Universal 打包，但其代码基线落后于 `origin/master` 的 `v0.2.0`。master 继续演进了
Windows 聊天窗口体验、图片消息、聊天背景、应用内更新和发布流水线。

本提案将这些 Windows 用户可见能力移植到当前 macOS 基线，避免直接合并 master
导致 macOS 专用 AppKit 实现被删除。

## 2. 目标与非目标

### Goals

- 对齐 master 的 Windows Tauri 桌面能力：固定容量 chat 外窗、卡片缩放过渡、区域化
  透明穿透、DPI/拖动/边缘避让和跨窗口状态同步。
- 对齐 master 的聊天能力：图片上传与展示、生成配图开关、聊天背景及自定义背景。
- 接入 Windows 应用内更新：启动检查、手动检查、独立更新窗口、签名下载、NSIS
  passive 安装、强制更新策略。
- 保留并回归现有 macOS 能力：Cocoa points 几何、AppKit child window、菜单栏
  accessory 模式、LaunchAgent 自启、透明穿透和 Universal 构建。
- 保持 Windows NSIS/MSI、macOS Universal 和 Android 发布流水线可独立构建。

### Non-Goals

- 本轮不引入 master 中仅服务 Android 的新原生界面、启动遮罩、悬浮窗气泡和菜单重构。
- 本轮不引入网页嵌入构建及其专用页面。
- 不替换 Live2D 模型、动作、表情和现有 Misskey 协议。
- 不把 macOS 壳层降级为 Windows 通用实现，也不删除现有 macOS 专用测试和验收文档。

## 3. 核心 User Stories

- **Story 1：Windows 聊天窗口**：用户打开聊天时，聊天外窗立即出现并跟随桌宠；桌宠
  缩放、移动、贴边和 DPI 改变时，卡片仍保持正确居中和底边锚定，不出现 WebView2
  缩放闪烁。
- **Story 2：透明区域交互**：用户点击聊天卡片外的透明区域时，事件穿透到桌宠或桌面；
  点击卡片、输入框或桌宠可见像素时，窗口正常接收事件，拖动/抚摸手势不会被穿透打断。
- **Story 3：图片聊天**：用户在聊天输入框选择图片，图片上传到当前 Misskey 会话并
  随消息发送；回复和记录按设置显示或隐藏生成配图。
- **Story 4：聊天外观**：用户可以选择内置聊天背景、上传自定义背景并调整暗度；设置
  在 pet、chat 和 records 窗口之间同步。
- **Story 5：应用更新**：应用启动后静默检查更新；发现普通更新时用户可以稍后、跳过
  当前版本或立即更新；强制更新只能更新或退出。Windows 更新下载先验签，再启动
  NSIS passive 安装。
- **Story 6：macOS 回归**：macOS 用户继续使用菜单栏入口、普通 Spaces、原生 points
  定位、聊天伴侣窗、透明穿透和用户级开机自启，现有 Universal 打包检查继续通过。

## 4. 实现分层

1. **共享前端层**：移植 master 中与平台无关的聊天图片、背景、更新检查/对话框、
   records 展示和设置入口；平台能力继续通过 `platform.ts` 抽象。
2. **Tauri Windows 层**：移植固定 chat 外窗、布局协议、预告几何、命中掩码区域和
   更新窗口状态；Windows 继续使用物理像素和 Win32 API。
3. **Tauri macOS 层**：保留 `geometry.rs`、`macos.rs`、macOS 配置 overlay 和
   `desktop-window.ts` 的 points 适配；共享命令按 `cfg(target_os = "macos")` 分流。
4. **发布层**：保留 macOS workflow，恢复/扩展 Windows updater 配置和 release
   workflow；签名私钥只由 CI Secret 提供。

## 5. 验收基准

- [ ] `redesign/ui` 的 TypeScript 构建和回归测试通过。
- [ ] `redesign/src-tauri` 的 Windows/macOS 条件编译与 Rust 单元测试通过。
- [ ] Windows 可生成 NSIS 与 MSI 安装包，macOS 可生成并验证 Universal app/DMG。
- [ ] Windows 实机验证聊天跟随、透明穿透、DPI、拖动、图片发送和应用内更新。
- [ ] macOS 实机回归菜单栏、普通 Spaces、聊天、穿透、自启和窗口关闭复用。
- [ ] Android 现有构建与共享前端行为不因本轮桌面改动破坏。

## 6. 交付顺序

1. 共享前端能力与测试。
2. Windows 固定 chat 外窗及命中/几何协议。
3. updater 插件、更新窗口与发布配置。
4. 双端构建、回归测试和人工验收手册。
