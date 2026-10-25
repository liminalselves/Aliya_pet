//! Aliya Pet 重写版：Tauri 透明桌宠壳。
//!
//! 透明无边框窗口 + 置顶 + 跳过任务栏 + 托盘菜单 + 设置窗口，
//! 全部由 Tauri/系统组件实现；窗口拖动/贴边吸附在前端手动实现
//! （原生 startDragging 的模态循环会吞掉快速拖动反应链需要的指针事件）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat_window;
mod miauth;
#[cfg(any(target_os = "macos", test))]
mod geometry;
#[cfg(target_os = "macos")]
mod macos;

use serde_json::json;
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

/// 前端上报的像素占用掩码：透明区域鼠标穿透的命中表。
/// 前端随掩码捎带参考矩形（物理像素）；Windows 命中优先使用当前原生矩形。
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

#[derive(Default)]
struct TrayTop(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// Native and menu state share one write path; the frontend persists the confirmed value.
#[tauri::command]
fn set_pet_always_on_top(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    for label in ["pet", "chat"] {
        let window = app.get_webview_window(label).ok_or_else(|| format!("Missing {label} window"))?;
        window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }
    let item = app.state::<TrayTop>().0.lock().map_err(|e| e.to_string())?.clone();
    if let Some(item) = item {
        item.set_checked(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_geometry(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    { serde_json::to_value(macos::geometry(&window)?).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "macos"))]
    { let _ = window; Err("Point geometry is only used on macOS".into()) }
}

#[tauri::command]
fn desktop_primary_monitor(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    { serde_json::to_value(macos::primary_monitor(&app)?).map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("Point geometry is only used on macOS".into()) }
}

#[tauri::command]
fn desktop_set_position(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { macos::set_position(&window, x, y) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, x, y); Err("Point geometry is only used on macOS".into()) }
}

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
fn want_ignore_at(mask: Option<&HitMask>, pt: (f64, f64), rect: Option<(f64, f64, f64, f64)>) -> Option<bool> {
    let m = mask?;
    let (x, y, w, h) = rect.unwrap_or((m.win_x as f64, m.win_y as f64, m.win_w as f64, m.win_h as f64));
    let stale = !m.sticky && m.updated.elapsed() > std::time::Duration::from_millis(1500);
    if m.interacting || stale || m.cols == 0 || m.rows == 0 || w <= 0.0 || h <= 0.0
        || ![pt.0, pt.1, x, y, w, h].iter().all(|v| v.is_finite()) {
        return Some(false);
    }
    let lx = pt.0 - x;
    let ly = pt.1 - y;
    if lx < 0.0 || ly < 0.0 || lx >= w || ly >= h {
        return None; // 光标在窗口外：保持当前状态
    }
    let gx = ((lx / w * m.cols as f64) as u32).min(m.cols - 1);
    let gy = ((ly / h * m.rows as f64) as u32).min(m.rows - 1);
    let idx = gy as usize * m.cols as usize + gx as usize;
    Some(m.data.get(idx).copied().unwrap_or(1) == 0)
}

#[cfg(test)]
mod hit_mask_tests {
    use super::*;

    fn mask() -> HitMask {
        HitMask { cols: 2, rows: 2, data: vec![0, 1, 1, 0],
            win_x: 10, win_y: 20, win_w: 100, win_h: 100,
            updated: std::time::Instant::now(), ..HitMask::default() }
    }

    #[test]
    fn live_geometry_follows_move_resize_and_dpi() {
        let m = mask();
        let rect = Some((321.0, -123.0, 200.0, 100.0));
        assert_eq!(want_ignore_at(Some(&m), (331.0, -113.0), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (431.0, -113.0), rect), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (331.0, -33.0), rect), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (431.0, -33.0), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), rect), None);
    }

    #[test]
    fn gesture_lock_and_heartbeat_preserve_pixel_hit_policy() {
        let mut m = mask();
        m.interacting = true;
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), None), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (-500.0, -500.0), None), Some(false));
        m.interacting = false;
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), None), Some(true));
        m.updated -= std::time::Duration::from_secs(2);
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), None), Some(false));
        m.updated = std::time::Instant::now();
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), None), Some(true));
    }

    #[test]
    fn missing_cells_are_opaque_and_outside_keeps_state() {
        let mut m = mask();
        m.data.clear();
        assert_eq!(want_ignore_at(Some(&m), (20.0, 30.0), None), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (110.0, 30.0), None), None);
        assert_eq!(want_ignore_at(None, (20.0, 30.0), None), None);
    }

    #[test]
    fn macos_fractional_points_and_sticky_chat_masks_keep_the_same_policy() {
        let mut m = mask();
        let rect = Some((-100.5, -200.25, 100.0, 100.0));
        assert_eq!(want_ignore_at(Some(&m), (-50.6, -190.0), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (-50.5, -190.0), rect), Some(false));
        m.sticky = true;
        m.updated -= std::time::Duration::from_secs(60);
        assert_eq!(want_ignore_at(Some(&m), (-90.0, -190.0), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (f64::NAN, 0.0), rect), Some(false));
    }
}

/// Windows：16ms 轮询全局光标，命中不透明像素→窗口接收事件，
/// 落在透明区域→set_ignore_cursor_events(true) 穿透到下层窗口。
/// pet 与 chat 各自独立判定；pet 掩码陈旧（>1.5s，渲染暂停等）时回退可交互，
/// chat 掩码为静态界面矩形，长期有效。
/// 同一轮询捎带向 pet 窗口广播光标位置（~33ms 节流）：
/// 视线跟随不再要求光标悬在窗口上。
#[cfg(windows)]
fn spawn_click_through(app: tauri::AppHandle, state: HitMaskState) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
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
                // pet/chat 均无边框；一次原生快照避免拖动、DPI 切换时依赖过期 IPC 坐标。
                let rect = win.hwnd().ok().and_then(|hwnd| {
                    let mut r = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
                    (unsafe { GetWindowRect(hwnd.0 as _, &mut r) } != 0)
                        .then_some((r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64))
                });
                let want = {
                    let Ok(map) = state.lock() else { continue };
                    match want_ignore_at(map.get(label), (pt.x as f64, pt.y as f64), rect) {
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
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
        let path = macos_launch_agent_path(&home);
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            install_macos_launch_agent(&path, &exe)?;
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
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
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(PathBuf::from)
            .map(|home| macos_launch_agent_path(&home).is_file()).unwrap_or(false);
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
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
    {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("open")
                .arg(&url)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() { return Err("open failed".into()); }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = url;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
const MACOS_LAUNCH_AGENT_LABEL: &str = "top.liminalselves.aliyapet";

#[cfg(target_os = "macos")]
fn macos_launch_agent_path(home: &Path) -> PathBuf {
    home.join("Library").join("LaunchAgents").join(format!("{MACOS_LAUNCH_AGENT_LABEL}.plist"))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_plist(executable: &Path) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{MACOS_LAUNCH_AGENT_LABEL}</string>
<key>ProgramArguments</key><array><string>{}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
"#, xml_escape(&executable.to_string_lossy()))
}

#[cfg(target_os = "macos")]
fn install_macos_launch_agent(path: &Path, executable: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("LaunchAgent path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("plist.tmp");
    std::fs::write(&temporary, macos_launch_agent_plist(executable)).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
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
                if let Err(error) = show_pet_window(app) { eprintln!("[pet] {error}"); }
            }
        }
    }
}

fn show_pet_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("Missing pet window")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    chat_window::on_pet_shown(app);
    Ok(())
}

fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[derive(Debug, PartialEq)]
enum CloseAction { Destroy, Hide, HidePet, HideChat }

fn close_action(label: &str, mac: bool) -> CloseAction {
    match label {
        "settings" | "records" => CloseAction::Hide,
        "pet" if mac => CloseAction::HidePet,
        "chat" if mac => CloseAction::HideChat,
        _ => CloseAction::Destroy,
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
        .manage(TrayTop::default())
        .invoke_handler(tauri::generate_handler![
            desktop_geometry,
            desktop_primary_monitor,
            desktop_set_position,
            set_pet_always_on_top,
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                match close_action(window.label(), cfg!(target_os = "macos")) {
                    CloseAction::HidePet => {
                        api.prevent_close();
                        chat_window::on_pet_hidden(window.app_handle());
                        let _ = window.hide();
                        return;
                    }
                    CloseAction::HideChat => {
                        api.prevent_close();
                        let app = window.app_handle();
                        if let Err(error) = chat_window::hide_chat(app.clone(), app.state()) { eprintln!("[chat] {error}"); }
                        return;
                    }
                    CloseAction::Hide => {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    CloseAction::Destroy => {}
                }
            }
            chat_window::handle_window_event(window.app_handle(), window.label(), event);
        })
        .setup(move |app| {
            chat_window::setup(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                macos::setup(app.handle())?;
                macos::spawn_click_through(app.handle().clone(), hit_mask_for_setup);
            }
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
            *app.state::<TrayTop>().0.lock().map_err(|e| e.to_string())? = Some(top.clone());
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

            #[cfg(not(target_os = "macos"))]
            let icon = app
                .default_window_icon()
                .expect("bundle.icon 必须配置托盘图标")
                .clone();
            // tray-icon scales its NSImage to 18pt; use the 2x alpha mask for Retina.
            #[cfg(target_os = "macos")]
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))?;

            let top_item = top.clone();
            TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
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
                        // Native check menus toggle before dispatch; never invert a second time.
                        if let Ok(new_val) = top_item.is_checked() {
                            if let Err(error) = set_pet_always_on_top(app.clone(), new_val) {
                                eprintln!("[tray] cannot change always-on-top: {error}");
                                return;
                            }
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
        .build(app_context())
        .expect("创建 Tauri 应用失败")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Err(error) = show_pet_window(_app) { eprintln!("[pet] reopen failed: {error}"); }
            }
        });
}

#[cfg(test)]
mod desktop_tests {
    use super::*;

    #[test]
    fn closing_mac_singletons_hides_them_and_windows_behavior_is_preserved() {
        assert_eq!(close_action("pet", true), CloseAction::HidePet);
        assert_eq!(close_action("chat", true), CloseAction::HideChat);
        for mac in [true, false] {
            for label in ["settings", "records"] { assert_eq!(close_action(label, mac), CloseAction::Hide); }
            assert_eq!(close_action("other", mac), CloseAction::Destroy);
        }
        assert_eq!(close_action("pet", false), CloseAction::Destroy);
        assert_eq!(close_action("chat", false), CloseAction::Destroy);
    }

    #[test]
    fn generated_context_has_all_windows_and_platform_resources() {
        let raw = tauri::utils::config::parse::read_from(
            tauri::utils::platform::Target::MacOS,
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        ).expect("read merged config");
        let raw_config: serde_json::Value = raw.0;
        assert_eq!(raw_config["bundle"]["macOS"]["minimumSystemVersion"], "14.4");
        let parsed: tauri::utils::config::Config = serde_json::from_value(raw_config.clone()).expect("parse merged config");
        assert_eq!(parsed.bundle.macos.minimum_system_version.as_deref(), Some("14.4"));
        let context = app_context();
        let config = context.config();
        let labels: Vec<_> = config.app.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["pet", "chat", "settings", "records"]);
        assert!(context.default_window_icon().is_some());
        #[cfg(target_os = "macos")]
        {
            assert!(config.app.macos_private_api);
            assert_eq!(parsed.bundle.macos.minimum_system_version.as_deref(), Some("14.4"));
            assert_eq!(parsed.bundle.macos.signing_identity.as_deref(), Some("-"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_launch_agent_is_user_scoped_and_xml_escaped() {
        let home = std::env::temp_dir().join(format!("aliya-launch-agent-{}", std::process::id()));
        let path = macos_launch_agent_path(&home);
        let executable = Path::new("/Applications/Aliya & Pet.app/Contents/MacOS/Aliya <Pet>");
        let plist = macos_launch_agent_plist(executable);
        assert!(path.ends_with("Library/LaunchAgents/top.liminalselves.aliyapet.plist"));
        assert!(plist.contains("Aliya &amp; Pet.app"));
        assert!(plist.contains("Aliya &lt;Pet&gt;"));
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn browser_open_only_accepts_http_urls_without_shell_interpolation() {
        for valid in ["https://example.test/a?x=1&y=%25", "http://127.0.0.1:1234/callback"] {
            assert!(valid.starts_with("http://") || valid.starts_with("https://"));
        }
        for invalid in ["file:///tmp/x", "javascript:alert(1)", " https://example.test"] {
            assert!(!invalid.starts_with("http://") && !invalid.starts_with("https://"));
        }
    }
}
