//! Aliya Pet 重写版：Tauri 透明桌宠壳。
//!
//! 透明无边框窗口 + 置顶 + 跳过任务栏 + 托盘菜单 + 设置窗口，
//! 全部由 Tauri/系统组件实现；窗口拖动/贴边吸附在前端手动实现
//! （原生 startDragging 的模态循环会吞掉快速拖动反应链需要的指针事件）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 前端上报的角色像素占用掩码：透明区域鼠标穿透的命中表。
/// 窗口矩形由前端随掩码捎带（物理像素），避免后台线程查询窗口API。
struct HitMask {
    cols: u32,
    rows: u32,
    data: Vec<u8>,
    /// 指针按下期间（拖动/抚摸）强制可交互，防止穿透打断事件流。
    interacting: bool,
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
            win_x: 0,
            win_y: 0,
            win_w: 0,
            win_h: 0,
            // 启动即视为陈旧：掩码到达前窗口正常接收事件
            updated: std::time::Instant::now() - std::time::Duration::from_secs(3600),
        }
    }
}

type HitMaskState = Arc<Mutex<HitMask>>;

#[tauri::command]
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
) {
    if let Ok(mut m) = state.lock() {
        m.cols = cols;
        m.rows = rows;
        m.data = data;
        m.interacting = interacting;
        m.win_x = win_x;
        m.win_y = win_y;
        m.win_w = win_w;
        m.win_h = win_h;
        m.updated = std::time::Instant::now();
    }
}

/// Windows：16ms 轮询全局光标，命中角色像素→窗口接收事件，
/// 落在透明区域→set_ignore_cursor_events(true) 穿透到下层窗口。
/// 掩码陈旧（>1.5s，渲染暂停等）时回退为可交互。
/// 同一轮询捎带向 pet 窗口广播光标位置（~33ms 节流）：
/// 视线跟随不再要求光标悬在窗口上。
#[cfg(windows)]
fn spawn_click_through(app: tauri::AppHandle, state: HitMaskState) {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    std::thread::spawn(move || {
        let mut ignoring = false;
        let mut last_emit = (i32::MIN, i32::MIN);
        let mut last_emit_at = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let Some(win) = app.get_webview_window("pet") else {
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            };
            if !win.is_visible().unwrap_or(false) {
                if ignoring {
                    let _ = win.set_ignore_cursor_events(false);
                    ignoring = false;
                }
                continue;
            }
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut pt) } == 0 {
                continue;
            }
            // 位置变化立即广播，静止时每秒补发，确保页面重载/恢复不会丢失目标。
            if pt.x != last_emit.0 || pt.y != last_emit.1
                || last_emit_at.elapsed() >= std::time::Duration::from_secs(1)
            {
                last_emit = (pt.x, pt.y);
                last_emit_at = std::time::Instant::now();
                let _ = win.emit("global-mouse", json!({ "x": pt.x, "y": pt.y }));
            }
            let want_ignore = {
                let Ok(m) = state.lock() else { continue };
                if m.interacting
                    || m.cols == 0
                    || m.rows == 0
                    || m.win_w <= 0
                    || m.win_h <= 0
                    || m.updated.elapsed() > std::time::Duration::from_millis(1500)
                {
                    false
                } else {
                    let lx = pt.x - m.win_x;
                    let ly = pt.y - m.win_y;
                    if lx < 0 || ly < 0 || lx >= m.win_w || ly >= m.win_h {
                        continue; // 光标在窗口外：保持当前状态
                    }
                    let gx = (lx as u32 * m.cols / m.win_w as u32).min(m.cols - 1);
                    let gy = (ly as u32 * m.rows / m.win_h as u32).min(m.rows - 1);
                    let idx = (gy * m.cols + gx) as usize;
                    m.data.get(idx).copied().unwrap_or(1) == 0
                }
            };
            if want_ignore != ignoring {
                if win.set_ignore_cursor_events(want_ignore).is_ok() {
                    ignoring = want_ignore;
                    #[cfg(debug_assertions)]
                    println!("[pet] click-through ignore = {want_ignore}");
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

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) urls allowed".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 打开（或聚焦）设置窗口。anchor=about 时定位到关于区。
fn open_settings_window(app: &tauri::AppHandle, anchor: Option<&str>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = match anchor {
        Some(a) => format!("settings.html#{}", a),
        None => "settings.html".to_string(),
    };
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("Aliya 设置")
        .inner_size(380.0, 620.0)
        .resizable(false)
        .always_on_top(true)
        .build();
}

/// 切换桌宠窗口显隐（托盘左键单击与菜单「显示 / 隐藏桌宠」共用）。
fn toggle_pet_visibility(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        match w.is_visible() {
            Ok(true) => {
                let _ = w.hide();
            }
            _ => {
                let _ = w.show();
                let _ = w.unminimize();
            }
        }
    }
}

fn main() {
    let hit_mask: HitMaskState = Arc::new(Mutex::new(HitMask::default()));
    let hit_mask_for_setup = hit_mask.clone();

    tauri::Builder::default()
        .manage(hit_mask)
        .invoke_handler(tauri::generate_handler![
            set_auto_start,
            get_auto_start,
            open_url,
            update_hit_mask
        ])
        .setup(move |app| {
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
                // 菜单只在右键时弹出；左键切换桌宠显隐
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_pet_visibility(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "menu" => open_settings_window(app, None),
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
                    "about" => open_settings_window(app, Some("about")),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
