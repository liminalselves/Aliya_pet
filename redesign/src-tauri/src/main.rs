//! Aliya Pet 重写版：Tauri 透明桌宠壳。
//!
//! 透明无边框窗口 + 置顶 + 跳过任务栏 + 托盘菜单 + 设置窗口，
//! 全部由 Tauri/系统组件实现；窗口拖动/贴边吸附在前端手动实现
//! （原生 startDragging 的模态循环会吞掉快速拖动反应链需要的指针事件）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat_window;
mod screen_capture;
mod miauth;

use serde_json::json;
use std::sync::{Arc, Mutex};
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
    /// 持久覆盖仅供 pet；不受动态掩码更新、手势锁或 TTL 影响。
    full_click_through: bool,
    /// 关闭覆盖后若没有新鲜剪影，安全穿透直到下一份真实 Alpha 掩码到达。
    awaiting_alpha: bool,
    /// 聊天入口的归一化客户区矩形，与人物 Alpha 分离；完全穿透时仅此按钮可点击。
    launcher_rect: Option<[f64; 4]>,
    /// 静态界面（chat）：掩码长期有效，不做陈旧回退；动态剪影（pet）陈旧即回退可交互。
    sticky: bool,
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
    /// 掩码覆盖的客户区内矩形（物理 px，(x, y, w, h)）；None = 整个窗口。
    /// 区域外一律穿透，掩码陈旧时也只把区域内回退为可交互，透明大窗不吞点击。
    region: Option<(i32, i32, i32, i32)>,
    updated: std::time::Instant,
}

impl Default for HitMask {
    fn default() -> Self {
        Self {
            cols: 0,
            rows: 0,
            data: Vec::new(),
            interacting: false,
            full_click_through: false,
            awaiting_alpha: false,
            launcher_rect: None,
            sticky: false,
            win_x: 0,
            win_y: 0,
            win_w: 0,
            win_h: 0,
            region: None,
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
    region_x: Option<i32>,
    region_y: Option<i32>,
    region_w: Option<i32>,
    region_h: Option<i32>,
    launcher_rect: Option<[f64; 4]>,
) {
    if let Ok(mut map) = state.lock() {
        let m = map
            .entry(label.unwrap_or_else(|| "pet".to_string()))
            .or_default();
        m.cols = cols;
        m.rows = rows;
        m.data = data;
        m.interacting = interacting;
        m.launcher_rect = launcher_rect.filter(|r| r.iter().all(|v| v.is_finite()) && r[2] > 0.0 && r[3] > 0.0);
        m.sticky = sticky.unwrap_or(false);
        m.win_x = win_x;
        m.win_y = win_y;
        m.win_w = win_w;
        m.win_h = win_h;
        m.region = match (region_x, region_y, region_w, region_h) {
            (Some(x), Some(y), Some(w), Some(h)) if w > 0 && h > 0 => Some((x, y, w, h)),
            _ => None,
        };
        m.updated = std::time::Instant::now();
        if m.cols > 0 && m.rows > 0 && m.data.len() == (m.cols as usize) * (m.rows as usize) {
            m.awaiting_alpha = false;
        }
    }
}

/// 仅人物窗口的持久覆盖。关闭时不调用 set_ignore_cursor_events(false)：
/// 由原来的 Alpha 命中线程决定光标处状态，绝不恢复为整个 Canvas 矩形命中。
#[tauri::command]
fn set_pet_click_through(state: tauri::State<HitMaskState>, enabled: bool) -> Result<(), String> {
    let mut map = state.lock().map_err(|e| e.to_string())?;
    let pet = map.entry("pet".to_string()).or_default();
    pet.set_full_click_through(enabled);
    Ok(())
}

impl HitMask {
    fn set_full_click_through(&mut self, enabled: bool) {
        if !enabled && self.full_click_through {
            self.awaiting_alpha = self.cols == 0 || self.rows == 0
                || self.updated.elapsed() > std::time::Duration::from_millis(1500);
        }
        self.full_click_through = enabled;
        if enabled { self.interacting = false; }
    }
}

/// 单个窗口在光标处的期望穿透状态；光标在窗口外返回 None（保持现状）。
#[cfg(windows)]
fn want_ignore_at(mask: Option<&HitMask>, pt: (i32, i32), rect: Option<(i32, i32, i32, i32)>) -> Option<bool> {
    let m = mask?;
    let (x, y, w, h) = rect.unwrap_or((m.win_x, m.win_y, m.win_w, m.win_h));
    if m.full_click_through || m.awaiting_alpha {
        // 原生仍仅放行聊天按钮，绝不把人物剪影或 Canvas 矩形恢复为命中区。
        // 归一化边界跟随当前原生窗口移动、缩放和 DPI，不依赖旧 IPC 屏幕坐标。
        let lx = (pt.0 - x) as f64;
        let ly = (pt.1 - y) as f64;
        let over_launcher = w > 0 && h > 0 && lx >= 0.0 && ly >= 0.0
            && lx < w as f64 && ly < h as f64
            && m.launcher_rect.is_some_and(|[rx, ry, rw, rh]| {
                let (bw, bh) = (rw * w as f64, rh * h as f64);
                let (px, py) = (lx - rx * w as f64, ly - ry * h as f64);
                if px < 0.0 || py < 0.0 || px >= bw || py >= bh { return false; }
                // chat-launcher 是胶囊按钮；透明圆角也不拦截后方应用。
                let radius = bw.min(bh) / 2.0;
                let dx = px - px.clamp(radius, bw - radius);
                let dy = py - py.clamp(radius, bh - radius);
                dx * dx + dy * dy <= radius * radius
            });
        return Some(!over_launcher);
    }
    let stale = !m.sticky && m.updated.elapsed() > std::time::Duration::from_millis(1500);
    // 指针按下期间整窗接收，拖动/抚摸的事件流不被穿透打断。
    if m.interacting { return Some(false); }
    if w <= 0 || h <= 0 { return Some(false); }
    let lx = pt.0 - x;
    let ly = pt.1 - y;
    if lx < 0 || ly < 0 || lx >= w || ly >= h {
        return None; // 光标在窗口外：保持当前状态
    }
    // 掩码区域外（固定容量外窗的透明部分）一律穿透，陈旧时也不回退。
    let (rx, ry, rw, rh) = m.region.unwrap_or((0, 0, w, h));
    let (lx, ly) = (lx - rx, ly - ry);
    if lx < 0 || ly < 0 || lx >= rw || ly >= rh {
        return Some(true);
    }
    if stale || m.cols == 0 || m.rows == 0 {
        return Some(false);
    }
    let gx = (lx as u32 * m.cols / rw as u32).min(m.cols - 1);
    let gy = (ly as u32 * m.rows / rh as u32).min(m.rows - 1);
    let idx = (gy * m.cols + gx) as usize;
    Some(m.data.get(idx).copied().unwrap_or(1) == 0)
}

#[cfg(all(test, windows))]
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
        let rect = Some((321, -123, 200, 100));
        assert_eq!(want_ignore_at(Some(&m), (331, -113), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (431, -113), rect), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (331, -33), rect), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (431, -33), rect), Some(true));
        assert_eq!(want_ignore_at(Some(&m), (20, 30), rect), None);
    }

    #[test]
    fn gesture_lock_and_heartbeat_preserve_pixel_hit_policy() {
        let mut m = mask();
        m.interacting = true;
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (-500, -500), None), Some(false));
        m.interacting = false;
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(true));
        m.updated -= std::time::Duration::from_secs(2);
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(false));
        m.updated = std::time::Instant::now();
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(true));
    }

    #[test]
    fn region_limits_mask_and_stale_fallback() {
        let mut m = mask();
        // 区域 = 客户区 (50,50) 起 50x50；掩码 2x2 铺在区域内。
        m.region = Some((50, 50, 50, 50));
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(true), "区域外穿透");
        assert_eq!(want_ignore_at(Some(&m), (60, 70), None), Some(true), "区域内透明格");
        assert_eq!(want_ignore_at(Some(&m), (90, 70), None), Some(false), "区域内不透明格");
        m.updated -= std::time::Duration::from_secs(2);
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(true), "陈旧时区域外仍穿透");
        assert_eq!(want_ignore_at(Some(&m), (60, 70), None), Some(false), "陈旧时区域内回退可交互");
        m.interacting = true;
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(false), "按下期间整窗接收");
    }

    #[test]
    fn full_override_survives_stale_gesture_and_restores_same_alpha() {
        let mut pet = mask();
        let chat = mask();
        pet.updated -= std::time::Duration::from_secs(20);
        pet.interacting = true;
        pet.set_full_click_through(true);
        assert_eq!(want_ignore_at(Some(&pet), (70, 30), None), Some(true));
        assert_eq!(want_ignore_at(Some(&pet), (-500, -500), None), Some(true));
        assert_eq!(want_ignore_at(Some(&chat), (70, 30), None), Some(false));
        assert!(!pet.interacting);
        pet.set_full_click_through(false);
        pet.set_full_click_through(false);
        assert_eq!(want_ignore_at(Some(&pet), (70, 30), None), Some(true), "陈旧剪影不得恢复矩形拦截");
        pet.updated = std::time::Instant::now();
        pet.awaiting_alpha = false; // update_hit_mask 收到有效真实剪影后解除等待
        assert_eq!(want_ignore_at(Some(&pet), (20, 30), None), Some(true));
        assert_eq!(want_ignore_at(Some(&pet), (70, 30), None), Some(false));
    }

    #[test]
    fn full_override_keeps_only_chat_launcher_clickable_across_dpi_and_restore() {
        let mut pet = mask();
        pet.launcher_rect = Some([0.2, 0.6, 0.6, 0.2]);
        pet.set_full_click_through(true);
        for (x, y, size) in [(10, 20, 100), (321, -123, 200)] {
            let rect = Some((x, y, size, size));
            assert_eq!(want_ignore_at(Some(&pet), (x + size / 2, y + size * 7 / 10), rect), Some(false), "按钮中心可点击");
            assert_eq!(want_ignore_at(Some(&pet), (x + size / 5, y + size * 6 / 10), rect), Some(true), "按钮透明圆角穿透");
            assert_eq!(want_ignore_at(Some(&pet), (x + size * 7 / 10, y + size / 10), rect), Some(true), "人物本体仍穿透");
            assert_eq!(want_ignore_at(Some(&pet), (x + size / 10, y + size / 10), rect), Some(true), "原透明区仍穿透");
        }
        pet.updated -= std::time::Duration::from_secs(20);
        pet.set_full_click_through(false);
        assert!(pet.awaiting_alpha);
        assert_eq!(want_ignore_at(Some(&pet), (60, 90), None), Some(false), "等候真实剪影时按钮不失效");
        assert_eq!(want_ignore_at(Some(&pet), (80, 30), None), Some(true));
        pet.launcher_rect = None;
        assert_eq!(want_ignore_at(Some(&pet), (60, 90), None), Some(true), "隐藏后不保留不可见命中区");
    }

    #[test]
    fn full_override_before_first_mask_stays_safe_on_restore() {
        let mut pet = HitMask::default();
        pet.set_full_click_through(true);
        assert_eq!(want_ignore_at(Some(&pet), (0, 0), None), Some(true));
        pet.set_full_click_through(false);
        assert!(pet.awaiting_alpha);
        assert_eq!(want_ignore_at(Some(&pet), (0, 0), None), Some(true));
    }

    #[test]
    fn missing_cells_are_opaque_and_outside_keeps_state() {
        let mut m = mask();
        m.data.clear();
        assert_eq!(want_ignore_at(Some(&m), (20, 30), None), Some(false));
        assert_eq!(want_ignore_at(Some(&m), (110, 30), None), None);
        assert_eq!(want_ignore_at(None, (20, 30), None), None);
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
                        .then_some((r.left, r.top, r.right - r.left, r.bottom - r.top))
                });
                let want = {
                    let Ok(map) = state.lock() else { continue };
                    match want_ignore_at(map.get(label), (pt.x, pt.y), rect) {
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

/// 缩放时一次性提交 pet 窗口的位置与尺寸（物理像素）。分开 set_size + set_position
/// 时窗口先沿左上角伸缩一帧，角色会先跳走再被补偿拉回。
#[tauri::command]
/// chat 按同一几何同步就位（模型局部锚点与窗口尺寸无关，缩放不需要前端重报）。
fn set_pet_bounds(app: tauri::AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    let pet = app.get_webview_window("pet").ok_or("pet 窗口不存在")?;
    if w == 0 || h == 0 { return Err("invalid pet bounds".into()); }
    chat_window::begin_pet_bounds(&app, chat_window::PetAnchor { x, y, w: w as i32, h: h as i32 });
    let result = apply_pet_bounds(&pet, x, y, w, h);
    chat_window::end_pet_bounds(&app);
    result
}

fn apply_pet_bounds(pet: &tauri::WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER};
        let hwnd = pet.hwnd().map_err(|e| e.to_string())?;
        if unsafe { SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), x, y, w as i32, h as i32,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(windows))]
    {
        pet.set_size(tauri::PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
        pet.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
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

/// pet 前端回写用户的「人物完全穿透」开关；0% 的安全兜底不改变勾选。
/// CheckMenuItem 注册进 managed state，命令只同步展示值，不反向改设置。
#[tauri::command]
fn sync_click_through_menu(
    app: tauri::AppHandle,
    checked: bool,
) -> Result<(), String> {
    if let Some(item) = app.try_state::<tauri::menu::CheckMenuItem<tauri::Wry>>() {
        item.inner().set_checked(checked).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// 更新窗口状态：最近一次检查结果 + 强制更新标记（关窗行为分叉依据）。
#[derive(Default)]
struct UpdateWindowState {
    payload: Mutex<Option<serde_json::Value>>,
    mandatory: std::sync::atomic::AtomicBool,
}

/// 显示预创建的更新窗口并转交 /api/check 结果：
/// `update-open` 事件即时渲染 + 暂存一份供页面（重）加载后兜底拉取。
#[tauri::command]
fn show_update(
    app: tauri::AppHandle,
    state: tauri::State<UpdateWindowState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mandatory = payload
        .get("mandatory")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    *state.payload.lock().map_err(|e| e.to_string())? = Some(payload.clone());
    state
        .mandatory
        .store(mandatory, std::sync::atomic::Ordering::Relaxed);
    let win = app
        .get_webview_window("update")
        .ok_or("update 窗口未预创建")?;
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("update", "update-open", payload);
    Ok(())
}

/// 更新页面加载时兜底拉取最近一次检查结果（覆盖事件早于监听安装的时序）。
#[tauri::command]
fn current_update_payload(state: tauri::State<UpdateWindowState>) -> Option<serde_json::Value> {
    state.payload.lock().ok().and_then(|p| p.clone())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(hit_mask)
        .manage(chat_window::ChatAnchorState::default())
        .manage(chat_window::ChatRuntimeState::default())
        .manage(miauth::MiauthState::default())
        .manage(UpdateWindowState::default())
        .invoke_handler(tauri::generate_handler![
            set_auto_start,
            get_auto_start,
            open_url,
            update_hit_mask,
            set_pet_click_through,
            set_pet_bounds,
            show_settings,
            sync_click_through_menu,
            show_records,
            show_update,
            current_update_payload,
            chat_window::show_chat,
            chat_window::hide_chat,
            chat_window::sync_chat_anchor,
            chat_window::set_chat_state,
            chat_window::send_chat_cue,
            chat_window::chat_layout,
            chat_window::set_chat_layout,
            miauth::miauth_begin,
            miauth::miauth_end,
            screen_capture::capture_screen
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
            // 更新窗口：非强制更新关闭即隐藏（与 settings/records 一致复用）；
            // 强制更新不可隐藏，关闭按钮视作退出应用（更新是唯一继续使用的途径）。
            if window.label() == "update" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let state = window.app_handle().state::<UpdateWindowState>();
                    if state
                        .mandatory
                        .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        window.app_handle().exit(0);
                    } else {
                        api.prevent_close();
                        let _ = window.hide();
                    }
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
            // 托盘不依赖人物命中，可切换穿透、恢复可见度或打开设置。
            let click_through =
                CheckMenuItem::with_id(app, "click_through", "人物完全穿透", true, false, None::<&str>)?;
            let reset_opacity =
                MenuItem::with_id(app, "reset_opacity", "恢复人物不透明度", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出桌宠", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &menu_main, &show, &sep1, &cycle, &top, &reset, &click_through,
                    &reset_opacity, &sep2, &about, &quit,
                ],
            )?;
            app.manage(click_through.clone());

            let icon = app
                .default_window_icon()
                .expect("bundle.icon 必须配置托盘图标")
                .clone();

            let top_item = top.clone();
            let click_through_item = click_through.clone();
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
                    "click_through" => {
                        // muda 在派发事件前已切换勾选；转发目标值给 pet 保存和应用，
                        // 再由 pet 同步菜单。不能再次反转，否则每次点击都会被撤销。
                        let new_val = click_through_item.is_checked().unwrap_or(false);
                        let _ = app.emit_to(
                            "pet",
                            "tray-action",
                            json!({ "action": "full-click-through", "value": new_val }),
                        );
                    }
                    "reset_opacity" => {
                        let _ = app.emit_to(
                            "pet",
                            "tray-action",
                            json!({ "action": "reset-opacity" }),
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
