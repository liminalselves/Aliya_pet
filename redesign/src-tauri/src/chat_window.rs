//! 桌宠伴侣聊天窗口：锁死在 pet 正下方的从属窗口，不是独立拖放的窗口。
//!
//! chat 窗口在 tauri.conf.json 声明、随启动预创建（visible:false）：
//! 一是打开零延迟、页面状态常驻；二是避开 Windows 下命令线程里 build()
//! 第二个 WebView2 窗口死锁的问题（已实测）。show/hide 只切换可见性。
//!
//! 几何契约（物理像素）：
//! - chat 永远吸附在 pet 正下方、水平居中，像萝莉斯桌宠那样是模型的延伸；
//!   宽度按 pet 逻辑宽度推导（宽 = pet 宽 × 1.18），高度固定 CHAT_HEIGHT_CSS；
//!   窗口窄于 CHAT_LAYOUT_MIN_W_CSS 时整页等比缩放（set_zoom），高度/脚底偏移同比，
//!   pet 切换尺寸时 chat 跟随缩放；
//! - 窗口底边恒定：底边 = pet 底边 + FOOT_OFFSET（贴住脚线），与布局态无关。
//!   输入框锚在窗口底部，面板出现/收起/换页只在 DOM 内向上伸缩，外窗不变；
//! - 外窗不随内容 resize：WebView2 resize 时位图滞后于窗框（残影/黑块/闪烁，
//!   单步也无法避免），透明区域由命中掩码穿透；
//!   平滑感由 DOM 内 CSS/WAAPI 动画承担（见 chat.css / view.ts）；
//! - pet 贴近屏幕底边、下方放不下时只向上移回工作区内；
//! - chat 不提供独立拖动；pet 拖动/缩放时 chat 严格跟随（允许随之越出
//!   工作区——窗口越界规范只对 pet 生效，chat 是 pet 的影子）。
//!
//! 锚点来源：
//! - 前端 `sync_chat_anchor(x,y,w,h,revision)` 上报相对客户区的比例矩形；
//!   Rust 保存最新局部锚点，使用当前原生窗口的单一几何快照还原物理坐标；
//! - 未上报时回退为原生查询 pet 窗口 outer_position/outer_size；
//! - pet 窗口 Moved/Resized 事件（on_window_event 挂接）同步锚点并让已打开的 chat 跟随。

use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
#[cfg(not(windows))]
use tauri::{PhysicalPosition, PhysicalSize};

/// 模型可见矩形（屏幕物理像素），由前端显式上报。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PetAnchor {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 保存局部矩形，避免 pet 移动时用外窗原点覆盖模型可见区域的偏移。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalPetAnchor {
    x: f64, y: f64, w: f64, h: f64,
    revision: u64,
}

impl LocalPetAnchor {
    /// 局部比例不包含前端屏幕原点或 DPI；全部转换使用接收端同一窗口快照。
    fn at_window(self, window: PetAnchor) -> PetAnchor {
        PetAnchor {
            x: window.x + (self.x * f64::from(window.w)).round() as i32,
            y: window.y + (self.y * f64::from(window.h)).round() as i32,
            w: (self.w * f64::from(window.w)).round() as i32,
            h: (self.h * f64::from(window.h)).round() as i32,
        }
    }

    fn store(self, slot: &mut Option<Self>) -> Result<bool, String> {
        if ![self.x, self.y, self.w, self.h].iter().all(|v| v.is_finite()) || self.w <= 0.0 || self.h <= 0.0 {
            return Err("invalid local chat anchor".into());
        }
        if slot.as_ref().is_some_and(|old| old.revision >= self.revision) { return Ok(false); }
        *slot = Some(self);
        Ok(true)
    }
}

/// pet 局部锚点；None 表示前端尚未上报。
pub type ChatAnchorState = Arc<Mutex<Option<LocalPetAnchor>>>;

/// chat 运行态（busy/typing 由 chat 页面经 set_chat_state 汇报）。
#[derive(Debug, Default)]
pub struct ChatRuntime {
    pub busy: bool,
    pub typing: bool,
    /// pet 隐藏前 chat 是否打开；pet 恢复时据此带回 chat。
    pub open_before_pet_hide: bool,
    /// 最近一次下发给 chat WebView 的缩放（千分比），未变不重复设置。
    zoom_milli: Option<u32>,
}

pub type ChatRuntimeState = Arc<Mutex<ChatRuntime>>;

/// 预创建窗口只能在创建后设置 owner：Tauri 的 parent/owner 仅在 Builder 公开。
/// Windows owned top-level window 始终在 owner 上方，不依赖反复 set_focus 抢焦。
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
        use windows_sys::Win32::UI::WindowsAndMessaging::GWLP_HWNDPARENT;
        #[cfg(target_pointer_width = "64")]
        use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW;
        #[cfg(target_pointer_width = "32")]
        use windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongW as SetWindowLongPtrW;

        let pet = app.get_webview_window("pet").ok_or("pet 窗口未预创建")?;
        let chat = app.get_webview_window("chat").ok_or("chat 窗口未预创建")?;
        let pet_hwnd = pet.hwnd()?;
        let chat_hwnd = chat.hwnd()?;
        // GWLP_HWNDPARENT 对 top-level window 设置 owner，不是 SetParent/WS_CHILD；
        // chat 仍可越出 pet 外窗、独立接收输入，设置本身也不激活任一窗口。
        unsafe {
            SetLastError(0);
            let previous = SetWindowLongPtrW(chat_hwnd.0 as _, GWLP_HWNDPARENT, pet_hwnd.0 as _);
            if previous == 0 {
                let error = GetLastError();
                if error != 0 {
                    return Err(std::io::Error::from_raw_os_error(error as i32).into());
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

/// pet 隐藏：chat 若开着则记住并随之隐藏（不广播，状态原样保留，恢复时延续）。
pub fn on_pet_hidden(app: &AppHandle) {
    let open = chat_is_open(app);
    if let Ok(mut r) = app.state::<ChatRuntimeState>().lock() {
        r.open_before_pet_hide = open;
    }
    if open {
        if let Some(chat) = app.get_webview_window("chat") {
            let _ = chat.hide();
        }
    }
}

/// pet 恢复：带回 pet 隐藏前开着的 chat，并按最新锚点定位。
pub fn on_pet_shown(app: &AppHandle) {
    let restore = app
        .state::<ChatRuntimeState>()
        .lock()
        .map(|r| r.open_before_pet_hide)
        .unwrap_or(false);
    if !restore {
        return;
    }
    if let Some(chat) = app.get_webview_window("chat") {
        position_chat(app, app.state::<ChatAnchorState>().inner());
        let _ = chat.show();
    }
}

/// 显示器工作区（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// chat 逻辑宽度按 pet 逻辑宽度推导：宽 = pet 宽 × 1.18（钳 150–560）。
/// 模型多大对话框多大，视觉上是 pet 的延伸。
pub fn chat_width_for_pet(pet_w_css: f64) -> f64 {
    (pet_w_css * 1.18).clamp(150.0, 560.0)
}

/// 页面排版的最小逻辑宽度（CSS px）。窗口比它窄时不再挤压排版，而是整页等比缩小
/// （WebView 缩放 = 窗口宽 / 本值）：小模型旁的输入框、按钮、字号随模型一起变小，
/// 不会出现「人很小、输入框很大」。窗口高度与脚底偏移同比缩放。
pub const CHAT_LAYOUT_MIN_W_CSS: f64 = 380.0;

/// 窗口逻辑宽度对应的页面缩放（1 = 不缩放）。
pub fn chat_zoom_for_width(w_css: f64) -> f64 {
    (w_css / CHAT_LAYOUT_MIN_W_CSS).clamp(0.4, 1.0)
}

/// chat 窗口固定高度（CSS px），容纳最高的回复页/会话屏。内容伸缩全在 DOM 内补间，
/// 透明区经命中掩码穿透到 pet：随内容 resize 外窗会让 WebView2 位图滞后于窗框，
/// 每次收放输入框都闪一下（单步 resize 同样无法避免）。
pub const CHAT_HEIGHT_CSS: f64 = 330.0;

/// 由 Live2D 可见矩形计算 chat 左上角：水平居中，且窗口底边恒为
/// pet 底边 + `foot_offset`（面板盖住角色腿部、输入框压在脚线上，
/// 底边不随布局态漂移）。这是萝莉斯式布局的关键——对话框是角色的延伸，
/// 而不是在模型外窗下方另挂一个网页。水平方向：pet 中心在屏内时把 chat
/// 钳回工作区（chat 比 pet 宽，贴边时纯居中会把发送按钮切出屏幕）；
/// pet 中心出屏说明桌宠被拖出桌面，chat 作为影子跟随越界，不拉回。
/// 若窗口仍超出工作区底部，则只向上移动到工作区底边。
pub fn chat_position(
    pet: PetAnchor,
    chat_w: i32,
    chat_h: i32,
    foot_offset: i32,
    work: Option<WorkRect>,
) -> (i32, i32) {
    if pet.w <= 0 || pet.h <= 0 || chat_w <= 0 || chat_h <= 0 {
        return (pet.x, pet.y);
    }
    let mut x = pet.x + (pet.w - chat_w) / 2;
    let mut y = pet.y + pet.h + foot_offset - chat_h;
    if let Some(wa) = work {
        if wa.w > 0 && wa.h > 0 {
            let pet_cx = pet.x + pet.w / 2;
            if chat_w <= wa.w && pet_cx >= wa.x && pet_cx <= wa.x + wa.w {
                x = x.clamp(wa.x, wa.x + wa.w - chat_w);
            }
            if y + chat_h > wa.y + wa.h {
                y = wa.y + wa.h - chat_h;
            }
        }
    }
    (x, y)
}

/// 打开（或聚焦）chat 窗口，并按锚点定位；广播打开状态。
#[tauri::command]
pub fn show_chat(
    app: AppHandle,
    anchor: State<ChatAnchorState>,
    runtime: State<ChatRuntimeState>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("chat")
        .ok_or("chat 窗口未预创建")?;
    let _ = win.unminimize();
    position_chat(&app, &anchor);
    let _ = win.show();
    let _ = win.set_focus();
    broadcast_open(&app, &runtime, true);
    Ok(())
}

/// 隐藏 chat 窗口（保留页面状态）；广播关闭状态并复位 busy/typing。
#[tauri::command]
pub fn hide_chat(app: AppHandle, runtime: State<ChatRuntimeState>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.hide();
    }
    broadcast_open(&app, &runtime, false);
    Ok(())
}

/// 前端上报模型相对客户区的比例矩形（底边=脚底）；不使用异步 IPC 之前的屏幕原点。
#[tauri::command]
pub fn sync_chat_anchor(
    app: AppHandle,
    anchor: State<ChatAnchorState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    revision: u64,
) -> Result<(), String> {
    let changed = LocalPetAnchor { x, y, w, h, revision }
        .store(&mut *anchor.lock().map_err(|error| error.to_string())?)?;
    if changed { position_chat(&app, &anchor); }
    Ok(())
}

/// chat 页面汇报运行态；全量广播 chat-state {busy, typing, open}。
#[tauri::command]
pub fn set_chat_state(
    app: AppHandle,
    runtime: State<ChatRuntimeState>,
    busy: Option<bool>,
    typing: Option<bool>,
) -> Result<(), String> {
    let (busy_now, typing_now) = if let Ok(mut r) = runtime.lock() {
        if let Some(b) = busy {
            r.busy = b;
        }
        if let Some(t) = typing {
            r.typing = t;
        }
        (r.busy, r.typing)
    } else {
        (false, false)
    };
    let open = chat_is_open(&app);
    app.emit(
        "chat-state",
        json!({ "busy": busy_now, "typing": typing_now, "open": open }),
    )
    .map_err(|e| e.to_string())
}

/// 转发聊天表演提示：广播 chat-cue，payload 即 PerformanceCue 对象
/// `{ expression?: string, action?: string }`，由 pet 前端自行处理表演。
#[tauri::command]
pub fn send_chat_cue(app: AppHandle, cue: serde_json::Value) -> Result<(), String> {
    if !cue.is_object() {
        return Err("cue 必须是对象（PerformanceCue）".into());
    }
    app.emit("chat-cue", cue).map_err(|e| e.to_string())
}

/// 全局窗口事件入口（在 main 的 Builder::on_window_event 挂接）：
/// - pet Moved → 平移锚点并让已打开的 chat 跟随（只动 chat，绝不动 pet）；
/// - pet Resized → 只按现有锚点重排 chat：锚点是前端上报的模型可见矩形
///   （底边=脚底），窗口外接矩形含渲染余量，不能用事件尺寸覆盖；
///   前端在缩放落定后立即重报（applySettings 完成路径）。
/// - chat 销毁（关闭/退出）→ 广播关闭状态，pet 前端据此清理表演状态。
pub fn handle_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    match event {
        WindowEvent::Moved(_) if label == "pet" => {
            // 局部矩形不变；current_anchor 用当前外窗原点还原屏幕锚点。
            position_chat(app, app.state::<ChatAnchorState>().inner());
        }
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } if label == "pet" => {
            position_chat(app, app.state::<ChatAnchorState>().inner());
        }
        WindowEvent::Destroyed if label == "chat" => {
            broadcast_open(app, app.state::<ChatRuntimeState>().inner(), false);
        }
        _ => {}
    }
}

// ---------- 内部 ----------

/// 窗口底边超出 pet 底边的距离（CSS px）：输入框贴住脚线又不没进屏幕底。
const FOOT_OFFSET_CSS: f64 = 56.0;

/// 按锚点定位并缩放 chat：位置与尺寸都实时从 pet 推导，无用户态偏移。
fn position_chat(app: &AppHandle, anchor: &ChatAnchorState) {
    let Some(chat) = app.get_webview_window("chat") else { return };
    let Some(pet) = current_anchor(app, anchor) else { return };
    let scale = app.get_webview_window("pet").and_then(|pet| pet.scale_factor().ok()).unwrap_or(1.0);
    let w_css = chat_width_for_pet(pet.w as f64 / scale);
    let zoom = chat_zoom_for_width(w_css);
    let w = (w_css * scale).round().max(1.0) as i32;
    let h = (CHAT_HEIGHT_CSS * zoom * scale).round().max(1.0) as i32;
    let foot = (FOOT_OFFSET_CSS * zoom * scale).round() as i32;
    // 先改缩放再改外窗：缩小时先缩内容，窗口随后收窄，不会出现一帧挤压排版。
    let zoom_milli = (zoom * 1000.0).round() as u32;
    let zoom_changed = app.state::<ChatRuntimeState>().lock()
        .map(|mut r| if r.zoom_milli == Some(zoom_milli) { false } else { r.zoom_milli = Some(zoom_milli); true })
        .unwrap_or(true);
    if zoom_changed {
        if let Err(error) = chat.set_zoom(f64::from(zoom_milli) / 1000.0) { eprintln!("[chat] set zoom failed: {error}"); }
    }
    let (x, y) = chat_position(pet, w, h, foot, pet_monitor_work_area(app));
    // 无变化不触碰窗口：每次 set_size/set_position 都会触发 webview 重合成，
    // 锚点同步、打开窗口大多带着未变的几何进来。chat 是无边框窗，
    // outer_size 与 set_size 的物理尺寸一致。
    let need_size = chat
        .outer_size()
        .map(|s| s.width != w as u32 || s.height != h as u32)
        .unwrap_or(true);
    let need_pos = chat
        .outer_position()
        .map(|p| p.x != x || p.y != y)
        .unwrap_or(true);
    if !need_size && !need_pos { return; }
    // 同一次调用提交大小和位置；先 resize 后 move 会短暂沿旧顶边扩张、遮住角色。
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER};
        match chat.hwnd() {
            Ok(hwnd) => unsafe {
                if SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), x, y, w, h,
                    SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER) == 0 {
                    eprintln!("[chat] set bounds failed: {}", std::io::Error::last_os_error());
                }
            },
            Err(error) => eprintln!("[chat] get window handle failed: {error}"),
        }
    }
    #[cfg(not(windows))]
    {
        if need_size { let _ = chat.set_size(PhysicalSize::new(w as u32, h as u32)); }
        if need_pos { let _ = chat.set_position(PhysicalPosition::new(x, y)); }
    }
}

/// pet 所在显示器的工作区（物理像素）；取不到时返回 None（不做上下翻转避让）。
fn pet_monitor_work_area(app: &AppHandle) -> Option<WorkRect> {
    let pet = app.get_webview_window("pet")?;
    let monitor = pet.current_monitor().ok().flatten()?;
    let wa = monitor.work_area();
    Some(WorkRect {
        x: wa.position.x,
        y: wa.position.y,
        w: wa.size.width as i32,
        h: wa.size.height as i32,
    })
}

/// 优先用前端显式上报的锚点；从未上报时回退为原生查询 pet 窗口外接矩形。
fn current_anchor(app: &AppHandle, anchor: &ChatAnchorState) -> Option<PetAnchor> {
    let local = anchor.lock().ok().and_then(|slot| *slot);
    let pet = app.get_webview_window("pet")?;
    // pet 是无边框窗口，Win32 GetWindowRect 一次取得原点和尺寸，避免混合两次查询。
    #[cfg(windows)]
    let result = pet.hwnd().map_err(|e| e.to_string()).and_then(|hwnd| read_window_rect(hwnd.0 as _));
    #[cfg(not(windows))]
    let result = (|| -> Result<PetAnchor, String> {
        let pos = pet.outer_position().map_err(|e| e.to_string())?;
        let size = pet.inner_size().map_err(|e| e.to_string())?;
        Ok(PetAnchor { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 })
    })();
    match result {
        Ok(window) => Some(local.map(|local| local.at_window(window)).unwrap_or(window)),
        Err(error) => { eprintln!("[chat] pet geometry snapshot failed: {error}"); None }
    }
}

#[cfg(windows)]
fn read_window_rect(hwnd: windows_sys::Win32::Foundation::HWND) -> Result<PetAnchor, String> {
    let mut rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(PetAnchor { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top })
}

/// 广播开关状态：chat-state 全局广播（pet 与 chat 都监听）；
/// chat-window-state 定向发给 pet（pet 据此清理表演状态）。
fn broadcast_open(app: &AppHandle, runtime: &ChatRuntimeState, open: bool) {
    let (busy, typing) = if open {
        runtime
            .lock()
            .map(|r| (r.busy, r.typing))
            .unwrap_or((false, false))
    } else {
        if let Ok(mut r) = runtime.lock() {
            r.busy = false;
            r.typing = false;
        }
        (false, false)
    };
    let _ = app.emit(
        "chat-state",
        json!({ "busy": busy, "typing": typing, "open": open }),
    );
    let _ = app.emit_to("pet", "chat-window-state", json!({ "open": open }));
}

fn chat_is_open(app: &AppHandle) -> bool {
    app.get_webview_window("chat")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟 pet 窗口：512x768 物理。
    const PET: PetAnchor = PetAnchor {
        x: 1000,
        y: 2000,
        w: 512,
        h: 768,
    };

    /// 足够大的工作区：不产生翻转，等价于无避让。
    const ROOM: WorkRect = WorkRect {
        x: 0,
        y: 0,
        w: 3840,
        h: 4320,
    };

    #[test]
    fn local_anchor_preserves_visible_offset_across_window_moves() {
        let window = PetAnchor { x: 970, y: 1940, w: 600, h: 1000 };
        let local = LocalPetAnchor { x: 30.0/600.0, y: 60.0/1000.0, w: 512.0/600.0, h: 768.0/1000.0, revision: 1 };
        assert_eq!(local.at_window(window), PET);
        // 在前端采样与接收之间移动：不减去新的原点，局部偏移不会持久污染。
        for (x, y) in [(1220, 1810), (-900, -400)] {
            let moved = local.at_window(PetAnchor { x, y, ..window });
            assert_eq!((moved.x - x, moved.y - y), (30, 60));
            assert_eq!((moved.w, moved.h), (PET.w, PET.h));
            let before = chat_position(PET, 600, 146, 56, None);
            let after = chat_position(moved, 600, 146, 56, None);
            assert_eq!((after.0 - before.0, after.1 - before.1), (x-window.x, y-window.y));
        }
        let dpi = local.at_window(PetAnchor { w: 1200, h: 2000, ..window });
        assert_eq!((dpi.x-window.x, dpi.y-window.y, dpi.w, dpi.h), (60,120,1024,1536));
        assert_eq!(local.at_window(window), PET);
    }

    #[test]
    fn older_anchor_requests_never_replace_newer_geometry() {
        let mut slot = None;
        let latest = LocalPetAnchor { x: 0.0, y: 0.1, w: 1.0, h: 0.8, revision: 10 };
        assert!(latest.store(&mut slot).unwrap());
        assert!(!LocalPetAnchor { y: 0.3, revision: 9, ..latest }.store(&mut slot).unwrap());
        assert_eq!(slot, Some(latest));
        assert!(LocalPetAnchor { w: f64::NAN, revision: 11, ..latest }.store(&mut slot).is_err());
        assert_eq!(slot, Some(latest));
    }

    #[cfg(windows)]
    #[test]
    fn real_win32_snapshot_tracks_move_resize_and_invalid_handles() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SetWindowPos, WS_POPUP, SWP_NOACTIVATE, SWP_NOZORDER};
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        unsafe {
            let hwnd = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP, -900, -400, 600, 1000,
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
            assert!(!hwnd.is_null(), "{}", std::io::Error::last_os_error());
            let check = || {
                let old = read_window_rect(hwnd).unwrap();
                assert_ne!(SetWindowPos(hwnd, std::ptr::null_mut(), -700, -200, 1200, 2000, SWP_NOACTIVATE | SWP_NOZORDER), 0);
                let current = read_window_rect(hwnd).unwrap();
                let local = LocalPetAnchor { x: 0.05, y: 0.06, w: 0.8, h: 0.7, revision: 1 };
                let anchor = local.at_window(current);
                assert_eq!((anchor.x-current.x, anchor.y-current.y), ((0.05*f64::from(current.w)).round() as i32, (0.06*f64::from(current.h)).round() as i32));
                assert_ne!(old, current);
            };
            let result = std::panic::catch_unwind(check);
            assert_ne!(DestroyWindow(hwnd), 0);
            if let Err(error) = result { std::panic::resume_unwind(error); }
            assert!(read_window_rect(std::ptr::null_mut()).is_err());
        }
    }

    #[test]
    fn chat_bottom_edge_constant_regardless_of_height() {
        // 底边锚定：pet 底 + foot_offset，与窗口高度无关——输入框不随面板伸缩漂移
        let (x, y) = chat_position(PET, 600, 372, 56, None);
        assert_eq!(x, PET.x + (PET.w - 600) / 2);
        assert_eq!(y + 372, PET.y + PET.h + 56);
        let (_, y2) = chat_position(PET, 600, 118, 56, None);
        assert_eq!(y2 + 118, PET.y + PET.h + 56);
    }

    #[test]
    fn bottom_overflow_moves_window_up_but_keeps_bottom_inside() {
        let wa = WorkRect { x: 0, y: 0, w: 3840, h: PET.y + PET.h };
        let (x, y) = chat_position(PET, 600, 372, 56, Some(wa));
        assert_eq!(y + 372, wa.y + wa.h);
        assert_eq!(x, PET.x + (PET.w - 600) / 2);
    }

    #[test]
    fn chat_follows_pet_offscreen_without_clamping() {
        // pet 拖出桌面（负坐标）：chat 严格跟随，不拉回工作区
        let off = PetAnchor { x: -4000, y: -1000, ..PET };
        let (x, y) = chat_position(off, 600, 372, 56, Some(ROOM));
        assert_eq!(x, -4000 + (PET.w - 600) / 2);
        assert_eq!(y, -1000 + PET.h + 56 - 372);
        // 平移多少跟随多少
        let moved = PetAnchor { x: PET.x + 250, y: PET.y - 130, ..PET };
        let (x1, y1) = chat_position(PET, 600, 372, 56, Some(ROOM));
        let (x2, y2) = chat_position(moved, 600, 372, 56, Some(ROOM));
        assert_eq!((x2 - x1, y2 - y1), (250, -130));
    }

    #[test]
    fn chat_size_scales_with_pet_width() {
        // 模型越大对话框越大；超出区间钳住
        assert!((chat_width_for_pet(400.0) - 472.0).abs() < 1e-9);
        assert_eq!(chat_width_for_pet(100.0), 150.0);
        assert_eq!(chat_width_for_pet(900.0), 560.0);
    }

    #[test]
    fn small_chat_scales_page_instead_of_squeezing_layout() {
        assert_eq!(chat_zoom_for_width(472.0), 1.0);
        assert_eq!(chat_zoom_for_width(CHAT_LAYOUT_MIN_W_CSS), 1.0);
        assert!((chat_zoom_for_width(190.0) - 0.5).abs() < 1e-9);
        // 页面逻辑宽 = 窗口宽 / 缩放，窄窗下恒等于最小排版宽。
        let w = chat_width_for_pet(180.0);
        assert!((w / chat_zoom_for_width(w) - CHAT_LAYOUT_MIN_W_CSS).abs() < 1e-9);
    }

    #[test]
    fn chat_clamps_into_work_area_when_pet_near_edge() {
        // pet 贴右边缘但中心在屏内：chat 比 pet 宽，纯居中会把右半切出屏幕，钳回工作区
        let edge = PetAnchor { x: ROOM.w - 300, ..PET };
        let (x, _) = chat_position(edge, 600, 372, 56, Some(ROOM));
        assert_eq!(x, ROOM.x + ROOM.w - 600);
        // pet 中心已出屏（被拖出桌面）：不钳制，影子跟随
        let out = PetAnchor { x: ROOM.w + 300, ..PET };
        let (x2, _) = chat_position(out, 600, 372, 56, Some(ROOM));
        assert_eq!(x2, out.x + (out.w - 600) / 2);
    }

    #[test]
    fn degenerate_anchor_falls_back_to_anchor_origin() {
        let degenerate = PetAnchor { w: 0, h: 100, ..PET };
        assert_eq!(chat_position(degenerate, 600, 372, 56, None), (degenerate.x, degenerate.y));
        let degenerate2 = PetAnchor { w: 100, h: -1, ..PET };
        assert_eq!(chat_position(degenerate2, 600, 372, 56, None), (degenerate2.x, degenerate2.y));
        assert_eq!(chat_position(PET, 0, 372, 56, None), (PET.x, PET.y));
    }
}
