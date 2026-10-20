//! Aliya Pet 重写版：Tauri 透明桌宠壳。
//!
//! 透明无边框窗口 + 置顶 + 跳过任务栏 + 托盘菜单 + 设置窗口，
//! 全部由 Tauri/系统组件实现；窗口拖动/贴边吸附在前端手动实现
//! （原生 startDragging 的模态循环会吞掉快速拖动反应链需要的指针事件）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat_window;
mod miauth;

use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

/// 前端上报的像素占用掩码：透明区域鼠标穿透的命中表。
/// 窗口矩形由前端随掩码捎带（物理像素），避免后台线程查询窗口API。
/// pet 上报角色剪影；chat 上报面板/输入框矩形，各自独立判定。
struct HitMask {
    cols: u32,
    rows: u32,
    data: Vec<u8>,
    /// 指针按下期间（拖动/抚摸）强制可交互，防止穿透打断事件流。
    interacting: bool,
    /// 静态界面（chat）：掩码长期有效，不做陈旧回退；动态剪影（pet）陈旧即回退可交互。
    sticky: bool,
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
    updated: std::time::Instant,
}

impl Default for HitMask {
    fn default() -> Self {
        Self {
            cols: 0,
            rows: 0,
            data: Vec::new(),
            interacting: false,
            sticky: false,
            win_x: 0,
            win_y: 0,
            win_w: 0,
            win_h: 0,
            // 启动即视为陈旧：掩码到达前窗口正常接收事件
            updated: std::time::Instant::now() - std::time::Duration::from_secs(3600),
        }
    }
}

/// 按窗口标签区分的命中掩码表（pet / chat）。
type HitMaskState = Arc<Mutex<std::collections::HashMap<String, HitMask>>>;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_hit_mask(
    state: tauri::State<HitMaskState>,
    cols: u32,
    rows: u32,
    data: Vec<u8>,
    interacting: bool,
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
    label: Option<String>,
    sticky: Option<bool>,
) {
    if let Ok(mut map) = state.lock() {
        let m = map
            .entry(label.unwrap_or_else(|| "pet".to_string()))
            .or_default();
        m.cols = cols;
        m.rows = rows;
        m.data = data;
        m.interacting = interacting;
        m.sticky = sticky.unwrap_or(false);
        m.win_x = win_x;
        m.win_y = win_y;
        m.win_w = win_w;
        m.win_h = win_h;
        m.updated = std::time::Instant::now();
    }
}

/// 单个窗口在光标处的期望穿透状态；光标在窗口外返回 None（保持现状）。
#[cfg(windows)]
fn want_ignore_at(mask: Option<&HitMask>, pt: (i32, i32)) -> Option<bool> {
    let m = mask?;
    let stale = !m.sticky && m.updated.elapsed() > std::time::Duration::from_millis(1500);
    if m.interacting || stale || m.cols == 0 || m.rows == 0 || m.win_w <= 0 || m.win_h <= 0 {
        return Some(false);
    }
    let lx = pt.0 - m.win_x;
    let ly = pt.1 - m.win_y;
    if lx < 0 || ly < 0 || lx >= m.win_w || ly >= m.win_h {
        return None; // 光标在窗口外：保持当前状态
    }
    let gx = (lx as u32 * m.cols / m.win_w as u32).min(m.cols - 1);
    let gy = (ly as u32 * m.rows / m.win_h as u32).min(m.rows - 1);
    let idx = (gy * m.cols + gx) as usize;
    Some(m.data.get(idx).copied().unwrap_or(1) == 0)
}

/// Windows：16ms 轮询全局光标，命中不透明像素→窗口接收事件，
/// 落在透明区域→set_ignore_cursor_events(true) 穿透到下层窗口。
/// pet 与 chat 各自独立判定；pet 掩码陈旧（>1.5s，渲染暂停等）时回退可交互，
/// chat 掩码为静态界面矩形，长期有效。
/// 同一轮询捎带向 pet 窗口广播光标位置（~33ms 节流）：
/// 视线跟随不再要求光标悬在窗口上。
#[cfg(windows)]
fn spawn_click_through(app: tauri::AppHandle, state: HitMaskState) {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    std::thread::spawn(move || {
        let mut ignoring: std::collections::HashMap<&str, bool> = Default::default();
        let mut last_emit = (i32::MIN, i32::MIN);
        let mut last_emit_at = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut pt) } == 0 {
                continue;
            }
            for label in ["pet", "chat"] {
                let Some(win) = app.get_webview_window(label) else {
                    continue;
                };
                if !win.is_visible().unwrap_or(false) {
                    if ignoring.insert(label, false).unwrap_or(false) {
                        let _ = win.set_ignore_cursor_events(false);
                    }
                    continue;
                }
                if label == "pet" {
                    // 位置变化立即广播，静止时每秒补发，确保页面重载/恢复不会丢失目标。
                    if pt.x != last_emit.0 || pt.y != last_emit.1
                        || last_emit_at.elapsed() >= std::time::Duration::from_secs(1)
                    {
                        last_emit = (pt.x, pt.y);
                        last_emit_at = std::time::Instant::now();
                        let _ = win.emit("global-mouse", json!({ "x": pt.x, "y": pt.y }));
                    }
                }
                let want = {
                    let Ok(map) = state.lock() else { continue };
                    match want_ignore_at(map.get(label), (pt.x, pt.y)) {
                        Some(w) => w,
                        None => continue, // 光标在窗口外：保持当前状态
                    }
                };
                if ignoring.get(label).copied().unwrap_or(false) != want
                    && win.set_ignore_cursor_events(want).is_ok()
                {
                    ignoring.insert(label, want);
                    #[cfg(debug_assertions)]
                    println!("[{label}] click-through ignore = {want}");
                }
            }
        }
    });
}

/// 开机自启注册表键（与 Flutter 版一致：reg.exe 实现，零新依赖）。
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "AliyaPet";

#[tauri::command]
fn set_auto_start(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let status = std::process::Command::new("reg")
                .args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d"])
                .arg(format!("\"{}\"", exe.display()))
                .arg("/f")
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("reg add failed".into());
            }
        } else {
            let _ = std::process::Command::new("reg")
                .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
                .status();
        }
    }
    #[cfg(not(windows))]
    let _ = enabled;
    Ok(())
}

#[tauri::command]
fn get_auto_start() -> bool {
    #[cfg(windows)]
    {
        return std::process::Command::new("reg")
            .args(["query", RUN_KEY, "/v", RUN_VALUE])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    false
}

/// UTF-16 宽字符串（ShellExecuteW 入参）。
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) urls allowed".into());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb = to_wide("open");
        let file = to_wide(&url);
        // ShellExecuteW 直接经 shell 关联打开默认浏览器：
        // 不经 cmd /C start 的元字符解析（URL 含 & % 等会被截断/注入）。
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (result as isize) <= 32 {
            return Err("ShellExecuteW failed".into());
        }
    }
    #[cfg(not(windows))]
    let _ = url;
    Ok(())
}

/// 显示预创建的设置窗口，并按需通知页面打开指定区域。
fn show_settings_window(app: &tauri::AppHandle, target: Option<&str>) -> Result<(), String> {
    let win = app
        .get_webview_window("settings")
        .ok_or("settings 窗口未预创建")?;
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    let target = target.unwrap_or("main");
    let _ = app.emit_to("settings", "settings-open", json!({ "target": target }));
    Ok(())
}

#[tauri::command]
fn show_settings(app: tauri::AppHandle, target: Option<String>) -> Result<(), String> {
    show_settings_window(&app, target.as_deref())
}

#[tauri::command]
fn show_records(app: tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("records")
        .ok_or("records 窗口未预创建")?;
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("records", "records-open", ());
    Ok(())
}

/// 由托盘菜单「显示 / 隐藏桌宠」切换桌宠窗口显隐。
/// chat 伴侣窗跟随 pet：pet 藏则 chat 藏，pet 现则带回之前开着的 chat。
fn toggle_pet_visibility(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        match w.is_visible() {
            Ok(true) => {
                chat_window::on_pet_hidden(app);
                let _ = w.hide();
            }
            _ => {
                let _ = w.show();
                let _ = w.unminimize();
                chat_window::on_pet_shown(app);
            }
        }
    }
}

fn main() {
    let hit_mask: HitMaskState = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let hit_mask_for_setup = hit_mask.clone();

    tauri::Builder::default()
        .manage(hit_mask)
        .manage(chat_window::ChatAnchorState::default())
        .manage(chat_window::ChatRuntimeState::default())
        .manage(miauth::MiauthState::default())
        .invoke_handler(tauri::generate_handler![
            set_auto_start,
            get_auto_start,
            open_url,
            update_hit_mask,
            show_settings,
            show_records,
            chat_window::show_chat,
            chat_window::hide_chat,
            chat_window::sync_chat_anchor,
            chat_window::set_chat_layout,
            chat_window::set_chat_state,
            chat_window::send_chat_cue,
            miauth::miauth_begin,
            miauth::miauth_end
        ])
        // pet 移动/缩放时让已打开的 chat 跟随；settings/records 关闭时隐藏复用。
        .on_window_event(|window, event| {
            if matches!(window.label(), "settings" | "records") {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
            }
            chat_window::handle_window_event(window.app_handle(), window.label(), event);
        })
        .setup(move |app| {
            chat_window::setup(app.handle())?;
            #[cfg(windows)]
            spawn_click_through(app.handle().clone(), hit_mask_for_setup);
            // 托盘菜单（对齐 Flutter 版：主菜单/显示隐藏/切换尺寸/置顶/重置位置/关于/退出）
            let menu_main = MenuItem::with_id(app, "menu", "主菜单", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示 / 隐藏桌宠", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let cycle = MenuItem::with_id(app, "cycle_size", "切换尺寸", true, None::<&str>)?;
            // 默认勾选（与 tauri.conf.json alwaysOnTop:true 一致）
            let top =
                CheckMenuItem::with_id(app, "top", "置顶显示", true, true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset_pos", "重置位置", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出桌宠", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &menu_main, &show, &sep1, &cycle, &top, &reset, &sep2, &about, &quit,
                ],
            )?;

            let icon = app
                .default_window_icon()
                .expect("bundle.icon 必须配置托盘图标")
                .clone();

            let top_item = top.clone();
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Aliya Pet")
                .menu(&menu)
                // 左右键都显示系统托盘菜单；桌宠显隐只由菜单项控制。
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "menu" => {
                        let _ = show_settings_window(app, None);
                    },
                    "show" => toggle_pet_visibility(app),
                    "cycle_size" => {
                        let _ = app.emit_to(
                            "pet",
                            "tray-action",
                            json!({ "action": "cycle-size" }),
                        );
                    }
                    "top" => {
                        if let Some(w) = app.get_webview_window("pet") {
                            let new_val = !top_item.is_checked().unwrap_or(true);
                            let _ = w.set_always_on_top(new_val);
                            let _ = top_item.set_checked(new_val);
                            // 同步给前端更新 localStorage 与设置窗口控件
                            let _ = app.emit_to(
                                "pet",
                                "tray-action",
                                json!({ "action": "always-on-top", "value": new_val }),
                            );
                        }
                    }
                    "reset_pos" => {
                        let _ = app.emit_to(
                            "pet",
                            "tray-action",
                            json!({ "action": "reset-position" }),
                        );
                    }
                    "about" => {
                        let _ = show_settings_window(app, Some("about"));
                    },
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
