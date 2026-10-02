//! 桌宠伴侣聊天窗口：锁死在 pet 正下方的从属窗口，不是独立拖放的窗口。
//!
//! chat 窗口在 tauri.conf.json 声明、随启动预创建（visible:false）：
//! 一是打开零延迟、页面状态常驻；二是避开 Windows 下命令线程里 build()
//! 第二个 WebView2 窗口死锁的问题（已实测）。show/hide 只切换可见性。
//!
//! 几何契约（物理像素）：
//! - chat 永远吸附在 pet 正下方、水平居中，像萝莉斯桌宠那样是模型的延伸；
//!   尺寸按 pet 逻辑宽度推导（宽 = pet 宽 × 1.18，高 = 宽 × 0.62），
//!   pet 切换尺寸时 chat 跟随缩放；
//! - pet 贴近屏幕底边、下方放不下时翻到 pet 上方；
//! - chat 不提供独立拖动；pet 拖动/缩放时 chat 严格跟随（允许随之越出
//!   工作区——窗口越界规范只对 pet 生效，chat 是 pet 的影子）。
//!
//! 锚点来源：
//! - 前端 `sync_chat_anchor(x,y,w,h)` 显式上报 pet 窗口外接矩形（物理像素，
//!   与 update_hit_mask 携带的 win_* 同源同单位）；
//! - 未上报时回退为原生查询 pet 窗口 outer_position/outer_size；
//! - pet 窗口 Moved/Resized 事件（on_window_event 挂接）同步锚点并让已打开的 chat 跟随。

use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent};

/// pet 窗口外接矩形（物理像素），由前端显式上报。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PetAnchor {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// pet 锚点；None 表示前端尚未上报。
pub type ChatAnchorState = Arc<Mutex<Option<PetAnchor>>>;

/// chat 运行态（busy/typing 由 chat 页面经 set_chat_state 汇报）。
#[derive(Debug, Default)]
pub struct ChatRuntime {
    pub busy: bool,
    pub typing: bool,
    /// pet 隐藏前 chat 是否打开；pet 恢复时据此带回 chat。
    pub open_before_pet_hide: bool,
    /// 前端布局态：setup/reply/composer，决定从属窗口实际高度。
    pub layout: ChatLayout,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum ChatLayout {
    #[default]
    Setup,
    Reply,
    Composer,
}

pub type ChatRuntimeState = Arc<Mutex<ChatRuntime>>;

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

/// chat 逻辑尺寸按 pet 逻辑宽度推导：宽 = pet 宽 × 1.18（钳 260–560），
/// 高 = 宽 × 0.62（钳 170–330）。模型多大对话框多大，视觉上是 pet 的延伸。
pub fn chat_size_for_pet(pet_w_css: f64) -> (f64, f64) {
    let w = (pet_w_css * 1.18).clamp(260.0, 560.0);
    let h = (w * 0.62).clamp(170.0, 330.0);
    (w, h)
}

/// 由 Live2D 可见矩形计算 chat 左上角：水平居中并覆盖模型底部 `overlap`。
/// 这是萝莉斯式布局的关键——面板盖住角色腿部，输入框压在脚线上，而不是
/// 在模型外窗下方另挂一个网页。水平方向：pet 中心在屏内时把 chat 钳回工作区
/// （chat 比 pet 宽，贴边时纯居中会把发送按钮切出屏幕）；pet 中心出屏说明
/// 桌宠被拖出桌面，chat 作为影子跟随越界，不拉回。
/// 若覆盖后的窗口仍超出工作区底部，则只向上移动到工作区底边（仍保持覆盖）。
pub fn chat_position(
    pet: PetAnchor,
    chat_w: i32,
    chat_h: i32,
    overlap: i32,
    work: Option<WorkRect>,
) -> (i32, i32) {
    if pet.w <= 0 || pet.h <= 0 || chat_w <= 0 || chat_h <= 0 {
        return (pet.x, pet.y);
    }
    let mut x = pet.x + (pet.w - chat_w) / 2;
    let mut y = pet.y + pet.h - overlap.clamp(0, chat_h);
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

/// 前端显式上报 pet 窗口外接矩形（物理像素）；chat 已打开时立即跟随。
#[tauri::command]
pub fn sync_chat_anchor(
    app: AppHandle,
    anchor: State<ChatAnchorState>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    if let Ok(mut slot) = anchor.lock() {
        *slot = Some(PetAnchor { x, y, w, h });
    }
    position_chat(&app, &anchor);
    Ok(())
}

/// 前端报告当前布局态；壳立即按内容态改变外窗高度并重新贴紧 pet。
#[tauri::command]
pub fn set_chat_layout(
    app: AppHandle,
    anchor: State<ChatAnchorState>,
    runtime: State<ChatRuntimeState>,
    mode: String,
    content_height: Option<u32>,
) -> Result<(), String> {
    let layout = match mode.as_str() {
        "composer" => ChatLayout::Composer,
        "reply" => ChatLayout::Reply,
        _ => ChatLayout::Setup,
    };
    if let Ok(mut r) = runtime.lock() {
        r.layout = layout;
    }
    position_chat_with_content(&app, &anchor, content_height);
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
/// - pet Moved/Resized → 更新锚点并让已打开的 chat 跟随（只动 chat，绝不动 pet）；
/// - chat 销毁（关闭/退出）→ 广播关闭状态，pet 前端据此清理表演状态。
pub fn handle_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    match event {
        WindowEvent::Moved(pos) if label == "pet" => {
            update_anchor(app, |pet| {
                pet.x = pos.x;
                pet.y = pos.y;
            });
            position_chat(app, app.state::<ChatAnchorState>().inner());
        }
        WindowEvent::Resized(size) if label == "pet" => {
            update_anchor(app, |pet| {
                pet.w = size.width as i32;
                pet.h = size.height as i32;
            });
            position_chat(app, app.state::<ChatAnchorState>().inner());
        }
        WindowEvent::Destroyed if label == "chat" => {
            broadcast_open(app, app.state::<ChatRuntimeState>().inner(), false);
        }
        _ => {}
    }
}

/// 更新已上报的 pet 锚点（未上报过则忽略，保持回退逻辑用原生查询）。
fn update_anchor(app: &AppHandle, f: impl FnOnce(&mut PetAnchor)) {
    let state = app.state::<ChatAnchorState>();
    let Ok(mut slot) = state.lock() else {
        return;
    };
    if let Some(pet) = slot.as_mut() {
        f(pet);
    }
}

// ---------- 内部 ----------

/// 按锚点定位并缩放 chat：位置与尺寸都实时从 pet 推导，无用户态偏移。
fn position_chat(app: &AppHandle, anchor: &ChatAnchorState) {
    position_chat_with_content(app, anchor, None);
}

fn position_chat_with_content(app: &AppHandle, anchor: &ChatAnchorState, content_height: Option<u32>) {
    let Some(chat) = app.get_webview_window("chat") else { return };
    let Some(pet) = current_anchor(app, anchor) else { return };
    let scale = chat.scale_factor().unwrap_or(1.0);
    let (w_css, default_h_css) = chat_size_for_pet(pet.w as f64 / scale);
    let layout = app
        .state::<ChatRuntimeState>()
        .lock()
        .map(|r| r.layout)
        .unwrap_or_default();
    let requested_css = content_height.map(|h| h as f64).unwrap_or(default_h_css);
    let h_css = match layout {
        ChatLayout::Composer => requested_css.clamp(62.0, 88.0),
        // 回复页按当前页内容量高：一行短句也该是窄条，不为未来页预留空白。
        ChatLayout::Reply => requested_css.clamp(118.0, default_h_css),
        // 授权/会话页必须给足高度，不以尚未完成布局的一次测量把内容裁掉。
        ChatLayout::Setup => default_h_css.max(300.0),
    };
    let w = (w_css * scale).round().max(1.0) as i32;
    let h = (h_css * scale).round().max(1.0) as i32;
    // composer 压住脚线；回复/连接面板更深地覆盖腿部，形成角色对话框而非下挂网页。
    let overlap_css = match layout {
        ChatLayout::Composer => 16.0,
        ChatLayout::Reply => (h_css * 0.38).max(72.0),
        ChatLayout::Setup => (h_css * 0.52).max(120.0),
    };
    let overlap = (overlap_css * scale).round() as i32;
    let _ = chat.set_size(PhysicalSize::new(w as u32, h as u32));
    let (x, y) = chat_position(pet, w, h, overlap, pet_monitor_work_area(app));
    let _ = chat.set_position(PhysicalPosition::new(x, y));
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
    if let Ok(slot) = anchor.lock() {
        if let Some(pet) = *slot {
            return Some(pet);
        }
    }
    let pet = app.get_webview_window("pet")?;
    let pos = pet.outer_position().ok()?;
    let size = pet.outer_size().ok()?;
    Some(PetAnchor {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    })
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
    fn chat_overlaps_pet_bottom_centered() {
        let (x, y) = chat_position(PET, 600, 372, 120, None);
        assert_eq!(x, PET.x + (PET.w - 600) / 2);
        assert_eq!(y, PET.y + PET.h - 120);
    }

    #[test]
    fn bottom_overflow_moves_window_up_but_keeps_overlap() {
        let wa = WorkRect { x: 0, y: 0, w: 3840, h: PET.y + PET.h };
        let (x, y) = chat_position(PET, 600, 372, 120, Some(wa));
        assert_eq!(y + 372, wa.y + wa.h);
        assert_eq!(x, PET.x + (PET.w - 600) / 2);
    }

    #[test]
    fn chat_follows_pet_offscreen_without_clamping() {
        // pet 拖出桌面（负坐标）：chat 严格跟随，不拉回工作区
        let off = PetAnchor { x: -4000, y: -1000, ..PET };
        let (x, y) = chat_position(off, 600, 372, 120, Some(ROOM));
        assert_eq!(x, -4000 + (PET.w - 600) / 2);
        assert_eq!(y, -1000 + PET.h - 120);
        // 平移多少跟随多少
        let moved = PetAnchor { x: PET.x + 250, y: PET.y - 130, ..PET };
        let (x1, y1) = chat_position(PET, 600, 372, 120, Some(ROOM));
        let (x2, y2) = chat_position(moved, 600, 372, 120, Some(ROOM));
        assert_eq!((x2 - x1, y2 - y1), (250, -130));
    }

    #[test]
    fn chat_size_scales_with_pet_width() {
        // 模型越大对话框越大；超出区间钳住
        let (w, h) = chat_size_for_pet(400.0);
        assert!((w - 472.0).abs() < 1e-9 && (h - 472.0 * 0.62).abs() < 1e-9);
        assert_eq!(chat_size_for_pet(100.0), (260.0, 170.0));
        assert_eq!(chat_size_for_pet(900.0), (560.0, 330.0));
    }

    #[test]
    fn chat_clamps_into_work_area_when_pet_near_edge() {
        // pet 贴右边缘但中心在屏内：chat 比 pet 宽，纯居中会把右半切出屏幕，钳回工作区
        let edge = PetAnchor { x: ROOM.w - 300, ..PET };
        let (x, _) = chat_position(edge, 600, 372, 12, Some(ROOM));
        assert_eq!(x, ROOM.x + ROOM.w - 600);
        // pet 中心已出屏（被拖出桌面）：不钳制，影子跟随
        let out = PetAnchor { x: ROOM.w + 300, ..PET };
        let (x2, _) = chat_position(out, 600, 372, 12, Some(ROOM));
        assert_eq!(x2, out.x + (out.w - 600) / 2);
    }

    #[test]
    fn degenerate_anchor_falls_back_to_anchor_origin() {
        let degenerate = PetAnchor { w: 0, h: 100, ..PET };
        assert_eq!(chat_position(degenerate, 600, 372, 12, None), (degenerate.x, degenerate.y));
        let degenerate2 = PetAnchor { w: 100, h: -1, ..PET };
        assert_eq!(chat_position(degenerate2, 600, 372, 12, None), (degenerate2.x, degenerate2.y));
        assert_eq!(chat_position(PET, 0, 372, 12, None), (PET.x, PET.y));
    }
}
