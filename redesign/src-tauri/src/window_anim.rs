//! 预创建装饰窗口（settings / records / update）的原生打开/关闭动效（Windows DWM）。
//!
//! 这些窗口为避开 WebView2 命令线程动态创建死锁而在启动时隐藏预创建，
//! 平时通过 `show()` / `hide()` 复用，因此系统 DWM 不会播放创建/销毁动画。
//! 本模块在启动隐藏态一次性挂上 `WS_EX_LAYERED`（LWA_ALPHA）并关闭系统默认 DWM 显隐过渡
//! （`DWMWA_TRANSITIONS_FORCEDISABLED`），后续全程不再增删 `WS_EX_LAYERED`，避免可见 WebView2
//! 窗口切换合成表面导致闪帧：
//! - 打开：220ms `cubic-bezier(0.23, 1, 0.32, 1)`，alpha 0→255、Y +12dp→0（最大化窗仅淡入）；
//!   `show()` 前保持 alpha=0 并等待至少 16ms 的 DWM 合成周期让 WebView2 提交首帧再淡入；
//! - 关闭：150ms `cubic-bezier(0.23, 1, 0.32, 1)`，alpha 255→0、Y 0→+8dp，结束后隐藏并还原静止坐标；
//! - 途中打断（关到一半重开 / 开到一半关闭）从当前 alpha 与位置无缝接力，保持静止坐标不漂移；
//! - 遵循 Windows 系统“动画效果”开关（`SPI_GETCLIENTAREAANIMATION`），关闭时直接显隐。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(windows)]
use std::time::{Duration, Instant};

/// 打开动效时长（ms），对齐 tokens.css `--al-t-med` 区间。
pub const OPEN_DURATION_MS: u64 = 220;
/// 关闭动效时长（ms），对齐 tokens.css `--al-t-out`。
pub const CLOSE_DURATION_MS: u64 = 150;
/// 打断接力时的最小时长（ms），避免近终点打断显得生硬或过慢。
const MIN_RESUME_DURATION_MS: u64 = 60;
/// 打开初始下移距离（逻辑像素，按窗口 DPI 缩放）。
pub const OPEN_OFFSET_LOGICAL_PX: f64 = 12.0;
/// 关闭结束下移距离（逻辑像素，按窗口 DPI 缩放）。
pub const CLOSE_OFFSET_LOGICAL_PX: f64 = 8.0;
/// DwmFlush 不可用时的退回步进周期。
#[cfg(windows)]
const FRAME_STEP: Duration = Duration::from_millis(8);
/// 冷打开在 alpha=0 下的最小等待时间：保证高刷屏上 WebView2 也有完整一帧完成首屏提交。
#[cfg(windows)]
const SHOW_SETTLE_MIN: Duration = Duration::from_millis(16);

/// 强缓出曲线 `cubic-bezier(0.23, 1, 0.32, 1)`：入场与退场均即时响应、干脆落定。
pub fn cubic_bezier_ease_out(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    const X1: f64 = 0.23;
    const Y1: f64 = 1.0;
    const X2: f64 = 0.32;
    const Y2: f64 = 1.0;

    let sample_x = |u: f64| -> f64 {
        let inv = 1.0 - u;
        3.0 * inv * inv * u * X1 + 3.0 * inv * u * u * X2 + u * u * u
    };
    let sample_y = |u: f64| -> f64 {
        let inv = 1.0 - u;
        3.0 * inv * inv * u * Y1 + 3.0 * inv * u * u * Y2 + u * u * u
    };

    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..14 {
        let mid = 0.5 * (lo + hi);
        if sample_x(mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    sample_y(0.5 * (lo + hi)).clamp(0.0, 1.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnimDirection {
    Show,
    Hide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimFrame {
    pub alpha: u8,
    pub y: i32,
}

/// 根据归一进度 `t ∈ [0, 1]` 与起止值计算当前帧（alpha + 纵坐标）。
pub fn compute_frame(
    t: f64,
    start_alpha: u8,
    end_alpha: u8,
    start_y: i32,
    end_y: i32,
) -> AnimFrame {
    let eased = cubic_bezier_ease_out(t);
    let alpha = (start_alpha as f64 + (end_alpha as f64 - start_alpha as f64) * eased)
        .round()
        .clamp(0.0, 255.0) as u8;
    let y = (start_y as f64 + (end_y as f64 - start_y as f64) * eased).round() as i32;
    AnimFrame { alpha, y }
}

/// 按 DPI 计算位移像素；最大化窗口不做位移，仅淡入淡出。
pub fn scaled_offset_px(logical_px: f64, scale_factor: f64, is_zoomed: bool) -> i32 {
    if is_zoomed {
        return 0;
    }
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    (logical_px * scale).round() as i32
}

/// 计算打断接力时的剩余时长：从半途折返时按未走比例缩放，并保底最小平滑时长。
pub fn remaining_duration_ms(full_ms: u64, start_alpha: u8, end_alpha: u8) -> u64 {
    let delta = (end_alpha as i32 - start_alpha as i32).abs() as f64;
    if delta <= 0.0 {
        return 0;
    }
    let ratio = (delta / 255.0).clamp(0.0, 1.0);
    let scaled = (full_ms as f64 * ratio).round() as u64;
    scaled.clamp(MIN_RESUME_DURATION_MS.min(full_ms), full_ms)
}

#[derive(Debug, Clone)]
struct ActiveAnim {
    generation: u64,
    direction: AnimDirection,
    rest_x: i32,
    rest_y: i32,
    current_alpha: u8,
    current_y: i32,
    is_zoomed: bool,
    position_detached: bool,
}

#[derive(Debug, Default)]
struct ManagerInner {
    next_gen: u64,
    active: HashMap<String, ActiveAnim>,
}

/// 全局窗口动效管理器，注册为 Tauri managed state。
#[derive(Clone, Default)]
pub struct WindowAnimManager {
    inner: Arc<Mutex<ManagerInner>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PlannedTransition {
    generation: u64,
    rest_x: i32,
    rest_y: i32,
    start_alpha: u8,
    end_alpha: u8,
    start_y: i32,
    end_y: i32,
    duration_ms: u64,
    is_zoomed: bool,
    was_active: bool,
}

impl WindowAnimManager {
    /// 规划一次打开动画；返回 `None` 表示窗口无需动画（已可见且空闲）。
    fn plan_show(
        &self,
        label: &str,
        already_visible: bool,
        rect_x: i32,
        rect_y: i32,
        scale_factor: f64,
        is_zoomed: bool,
    ) -> Option<PlannedTransition> {
        let mut inner = self.inner.lock().ok()?;
        let existing = inner.active.get(label).cloned();
        if let Some(cur) = &existing {
            if cur.direction == AnimDirection::Show {
                return None;
            }
        } else if already_visible {
            return None;
        }

        inner.next_gen = inner.next_gen.wrapping_add(1);
        let generation = inner.next_gen;

        let (rest_x, rest_y, start_alpha, start_y, zoomed, was_active) = match existing {
            Some(cur) => (
                cur.rest_x,
                cur.rest_y,
                cur.current_alpha,
                cur.current_y,
                cur.is_zoomed,
                true,
            ),
            None => {
                let offset = scaled_offset_px(OPEN_OFFSET_LOGICAL_PX, scale_factor, is_zoomed);
                (rect_x, rect_y, 0, rect_y + offset, is_zoomed, false)
            }
        };

        let duration_ms = remaining_duration_ms(OPEN_DURATION_MS, start_alpha, 255);
        inner.active.insert(
            label.to_string(),
            ActiveAnim {
                generation,
                direction: AnimDirection::Show,
                rest_x,
                rest_y,
                current_alpha: start_alpha,
                current_y: start_y,
                is_zoomed: zoomed,
                position_detached: false,
            },
        );

        Some(PlannedTransition {
            generation,
            rest_x,
            rest_y,
            start_alpha,
            end_alpha: 255,
            start_y,
            end_y: rest_y,
            duration_ms,
            is_zoomed: zoomed,
            was_active,
        })
    }

    /// 规划一次关闭动画；返回 `None` 表示已隐藏或已在关闭中。
    fn plan_hide(
        &self,
        label: &str,
        currently_visible: bool,
        rect_x: i32,
        rect_y: i32,
        scale_factor: f64,
        is_zoomed: bool,
    ) -> Option<PlannedTransition> {
        let mut inner = self.inner.lock().ok()?;
        let existing = inner.active.get(label).cloned();
        if let Some(cur) = &existing {
            if cur.direction == AnimDirection::Hide {
                return None;
            }
        } else if !currently_visible {
            return None;
        }

        inner.next_gen = inner.next_gen.wrapping_add(1);
        let generation = inner.next_gen;

        let (rest_x, rest_y, start_alpha, start_y, zoomed, was_active) = match existing {
            Some(cur) => {
                let (rx, ry) = if cur.position_detached {
                    (rect_x, rect_y)
                } else {
                    (cur.rest_x, cur.rest_y)
                };
                (rx, ry, cur.current_alpha, cur.current_y, cur.is_zoomed, true)
            }
            None => (rect_x, rect_y, 255, rect_y, is_zoomed, false),
        };

        let offset = scaled_offset_px(CLOSE_OFFSET_LOGICAL_PX, scale_factor, zoomed);
        let end_y = rest_y + offset;
        let duration_ms = remaining_duration_ms(CLOSE_DURATION_MS, start_alpha, 0);

        inner.active.insert(
            label.to_string(),
            ActiveAnim {
                generation,
                direction: AnimDirection::Hide,
                rest_x,
                rest_y,
                current_alpha: start_alpha,
                current_y: start_y,
                is_zoomed: zoomed,
                position_detached: false,
            },
        );

        Some(PlannedTransition {
            generation,
            rest_x,
            rest_y,
            start_alpha,
            end_alpha: 0,
            start_y,
            end_y,
            duration_ms,
            is_zoomed: zoomed,
            was_active,
        })
    }

    #[cfg(windows)]
    fn is_current(&self, label: &str, generation: u64) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.active.get(label).map(|a| a.generation == generation))
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn record_step(
        &self,
        label: &str,
        generation: u64,
        alpha: u8,
        y: i32,
        detached: bool,
    ) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let Some(entry) = inner.active.get_mut(label) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        entry.current_alpha = alpha;
        entry.current_y = y;
        if detached {
            entry.position_detached = true;
        }
        true
    }

    #[cfg(windows)]
    fn expected_pos(&self, label: &str, generation: u64) -> Option<(i32, i32, bool)> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.active.get(label)?;
        if entry.generation != generation {
            return None;
        }
        Some((entry.rest_x, entry.current_y, entry.position_detached))
    }

    /// 仅当代次仍匹配时取出并结束动画，供主线程收尾时做并发闸门。
    fn finish_if_current(&self, label: &str, generation: u64) -> Option<ActiveAnim> {
        let mut inner = self.inner.lock().ok()?;
        if inner.active.get(label)?.generation == generation {
            inner.active.remove(label)
        } else {
            None
        }
    }

    /// 取消进行中的动画（如系统关闭了动画效果时立即结算）。
    #[cfg(windows)]
    fn cancel(&self, label: &str) -> Option<ActiveAnim> {
        let mut inner = self.inner.lock().ok()?;
        inner.next_gen = inner.next_gen.wrapping_add(1);
        inner.active.remove(label)
    }
}

/// 预创建可复用装饰窗口的标签集合。
const ANIMATED_WINDOWS: &[&str] = &["settings", "records", "update"];

/// 允许走统一动画收起的可复用装饰窗口。
pub fn is_animated_window(label: &str) -> bool {
    ANIMATED_WINDOWS.contains(&label)
}

/// 启动期一次性初始化：在窗口尚处于隐藏态时配置 `WS_EX_LAYERED`（alpha=0）并禁用
/// 系统默认 DWM 显隐过渡，后续开关全程不再增删 `WS_EX_LAYERED`，彻底消除表面切换闪帧。
pub fn setup(app: &AppHandle) {
    #[cfg(windows)]
    {
        for &label in ANIMATED_WINDOWS {
            if let Some(win) = app.get_webview_window(label) {
                if let Ok(hwnd_raw) = win.hwnd() {
                    let hwnd = hwnd_raw.0 as windows_sys::Win32::Foundation::HWND;
                    unsafe {
                        prepare_layered_window(hwnd, 0);
                        disable_dwm_transitions(hwnd);
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// 带开窗动效地显示并聚焦预创建窗口。
pub fn show_window_animated(app: &AppHandle, win: &WebviewWindow) {
    #[cfg(windows)]
    {
        show_window_animated_win(app, win);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 带关窗动效地隐藏可复用窗口。
pub fn hide_window_animated(app: &AppHandle, win: &WebviewWindow) {
    #[cfg(windows)]
    {
        hide_window_animated_win(app, win);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = win.hide();
    }
}

#[cfg(windows)]
fn system_animations_enabled() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION,
    };
    let mut enabled: i32 = 1;
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    ok == 0 || enabled != 0
}

#[cfg(windows)]
unsafe fn get_ex_style(hwnd: windows_sys::Win32::Foundation::HWND) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE;
    #[cfg(target_pointer_width = "64")]
    {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    }
    #[cfg(target_pointer_width = "32")]
    {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongW(hwnd, GWL_EXSTYLE) as isize
    }
}

#[cfg(windows)]
unsafe fn set_ex_style(hwnd: windows_sys::Win32::Foundation::HWND, style: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE;
    #[cfg(target_pointer_width = "64")]
    {
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
    #[cfg(target_pointer_width = "32")]
    {
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            style as i32,
        );
    }
}

/// 幂等挂载 `WS_EX_LAYERED`；仅在尚未启用时写入样式，避免在可见窗口上触发 DWM 表面重建。
#[cfg(windows)]
unsafe fn prepare_layered_window(hwnd: windows_sys::Win32::Foundation::HWND, initial_alpha: u8) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetLayeredWindowAttributes, LWA_ALPHA, WS_EX_LAYERED,
    };
    let ex = get_ex_style(hwnd);
    if (ex & WS_EX_LAYERED as isize) == 0 {
        set_ex_style(hwnd, ex | WS_EX_LAYERED as isize);
    }
    SetLayeredWindowAttributes(hwnd, 0, initial_alpha, LWA_ALPHA);
}

/// 关闭系统默认 DWM 窗口过渡，避免与自定义 alpha/位移补间重叠导致双动画闪烁。
#[cfg(windows)]
unsafe fn disable_dwm_transitions(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };
    let disabled: u32 = 1;
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_TRANSITIONS_FORCEDISABLED as u32,
        (&disabled as *const u32).cast(),
        std::mem::size_of::<u32>() as u32,
    );
}

#[cfg(windows)]
fn wait_dwm_frame() {
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;
    let hr = unsafe { DwmFlush() };
    if hr != 0 {
        std::thread::sleep(FRAME_STEP);
    }
}

#[cfg(windows)]
fn show_window_animated_win(app: &AppHandle, win: &WebviewWindow) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsWindowVisible, IsZoomed, SetLayeredWindowAttributes, SetWindowPos,
        LWA_ALPHA, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };

    let label = win.label().to_string();
    let manager = app.state::<WindowAnimManager>().inner().clone();

    let Ok(hwnd_raw) = win.hwnd() else {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    };
    let hwnd = hwnd_raw.0 as windows_sys::Win32::Foundation::HWND;

    // 最小化窗口由系统自带还原动效接管，仅确保不透明。
    if win.is_minimized().unwrap_or(false) {
        let _ = manager.cancel(&label);
        unsafe { SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) };
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    if !system_animations_enabled() {
        if let Some(prev) = manager.cancel(&label) {
            unsafe {
                if !prev.is_zoomed && !prev.position_detached {
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        prev.rest_x,
                        prev.rest_y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    );
                }
            }
        }
        unsafe { SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) };
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        unsafe { SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) };
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let already_visible = unsafe { IsWindowVisible(hwnd) != 0 };
    let is_zoomed = unsafe { IsZoomed(hwnd) != 0 };
    let scale = win.scale_factor().unwrap_or(1.0);

    let Some(plan) = manager.plan_show(
        &label,
        already_visible,
        rect.left,
        rect.top,
        scale,
        is_zoomed,
    ) else {
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    };

    // 窗口在 setup 时已挂 WS_EX_LAYERED；此处仅在隐藏态置 alpha=0 与起点坐标，再 show()。
    unsafe {
        if !plan.was_active {
            prepare_layered_window(hwnd, plan.start_alpha);
            disable_dwm_transitions(hwnd);
            if !plan.is_zoomed && plan.start_y != plan.rest_y {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    plan.rest_x,
                    plan.start_y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                );
            }
        }
    }
    let _ = win.show();
    let _ = win.set_focus();

    spawn_anim_loop(app.clone(), label, hwnd as isize, plan, AnimDirection::Show);
}

#[cfg(windows)]
fn hide_window_animated_win(app: &AppHandle, win: &WebviewWindow) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsWindowVisible, IsZoomed, SetLayeredWindowAttributes, SetWindowPos,
        LWA_ALPHA, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };

    let label = win.label().to_string();
    let manager = app.state::<WindowAnimManager>().inner().clone();

    let Ok(hwnd_raw) = win.hwnd() else {
        let _ = win.hide();
        return;
    };
    let hwnd = hwnd_raw.0 as windows_sys::Win32::Foundation::HWND;

    if !system_animations_enabled() || win.is_minimized().unwrap_or(false) {
        let prev = manager.cancel(&label);
        let _ = win.hide();
        unsafe {
            if let Some(prev) = prev {
                if !prev.is_zoomed && !prev.position_detached {
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        prev.rest_x,
                        prev.rest_y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    );
                }
            }
            SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
        }
        return;
    }

    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        let _ = win.hide();
        return;
    }
    let currently_visible = unsafe { IsWindowVisible(hwnd) != 0 };
    let is_zoomed = unsafe { IsZoomed(hwnd) != 0 };
    let scale = win.scale_factor().unwrap_or(1.0);

    let Some(plan) = manager.plan_hide(
        &label,
        currently_visible,
        rect.left,
        rect.top,
        scale,
        is_zoomed,
    ) else {
        return;
    };

    if !plan.was_active {
        unsafe { prepare_layered_window(hwnd, plan.start_alpha) };
    }

    spawn_anim_loop(app.clone(), label, hwnd as isize, plan, AnimDirection::Hide);
}

#[cfg(windows)]
fn spawn_anim_loop(
    app: AppHandle,
    label: String,
    hwnd_val: isize,
    plan: PlannedTransition,
    direction: AnimDirection,
) {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetLayeredWindowAttributes, SetWindowPos, LWA_ALPHA, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };

    let manager = app.state::<WindowAnimManager>().inner().clone();
    std::thread::spawn(move || {
        let hwnd = hwnd_val as HWND;
        // 冷打开时先在 alpha=0 下等待至少 16ms 的 DWM 合成帧，让 WebView2 从隐藏态唤醒
        // 并提交首屏内容（含目标页签切换），避免首帧还未上屏就被抬高透明度造成闪烁。
        if direction == AnimDirection::Show && !plan.was_active {
            let settle_start = Instant::now();
            loop {
                wait_dwm_frame();
                if !manager.is_current(&label, plan.generation) {
                    return;
                }
                if settle_start.elapsed() >= SHOW_SETTLE_MIN {
                    break;
                }
            }
        }

        let started = Instant::now();
        let total_ms = plan.duration_ms.max(1) as f64;
        let mut last_alpha = plan.start_alpha;
        let mut last_y = plan.start_y;

        loop {
            wait_dwm_frame();
            if !manager.is_current(&label, plan.generation) {
                return;
            }
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            let t = (elapsed_ms / total_ms).min(1.0);
            let frame = compute_frame(t, plan.start_alpha, plan.end_alpha, plan.start_y, plan.end_y);

            // 若用户在动画途中主动拖动或贴靠了窗口，立刻放弃位置覆写，只把透明渐变播完。
            let mut detached = false;
            if !plan.is_zoomed && plan.start_y != plan.end_y {
                if let Some((exp_x, exp_y, already_detached)) =
                    manager.expected_pos(&label, plan.generation)
                {
                    if already_detached {
                        detached = true;
                    } else {
                        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                        if unsafe { GetWindowRect(hwnd, &mut rect) } != 0
                            && ((rect.left - exp_x).abs() > 2 || (rect.top - exp_y).abs() > 2)
                        {
                            detached = true;
                        }
                    }
                }
            }

            if !manager.record_step(&label, plan.generation, frame.alpha, frame.y, detached) {
                return;
            }

            unsafe {
                if frame.alpha != last_alpha {
                    SetLayeredWindowAttributes(hwnd, 0, frame.alpha, LWA_ALPHA);
                    last_alpha = frame.alpha;
                }
                if !detached && !plan.is_zoomed && frame.y != last_y {
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        plan.rest_x,
                        frame.y,
                        0,
                        0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    );
                    last_y = frame.y;
                }
            }

            if t >= 1.0 {
                break;
            }
        }

        // 收尾交回主线程并再次校验代次：保持 WS_EX_LAYERED 不移除，杜绝结束瞬间表面切换闪烁。
        let finish_app = app.clone();
        let finish_label = label.clone();
        let _ = app.run_on_main_thread(move || {
            let manager = finish_app.state::<WindowAnimManager>();
            let Some(done) = manager.finish_if_current(&finish_label, plan.generation) else {
                return;
            };
            let Some(win) = finish_app.get_webview_window(&finish_label) else {
                return;
            };
            let Ok(hwnd_raw) = win.hwnd() else {
                if direction == AnimDirection::Hide {
                    let _ = win.hide();
                }
                return;
            };
            let hwnd = hwnd_raw.0 as HWND;
            unsafe {
                match direction {
                    AnimDirection::Show => {
                        if !done.is_zoomed && !done.position_detached {
                            SetWindowPos(
                                hwnd,
                                std::ptr::null_mut(),
                                done.rest_x,
                                done.rest_y,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                            );
                        }
                        SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                    }
                    AnimDirection::Hide => {
                        SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
                        let _ = win.hide();
                        if !done.is_zoomed && !done.position_detached {
                            SetWindowPos(
                                hwnd,
                                std::ptr::null_mut(),
                                done.rest_x,
                                done.rest_y,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                            );
                        }
                    }
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ease_out_endpoints_monotonic_and_snappy() {
        assert_eq!(cubic_bezier_ease_out(0.0), 0.0);
        assert_eq!(cubic_bezier_ease_out(1.0), 1.0);
        let mut prev = 0.0;
        for step in 1..=20 {
            let t = step as f64 / 20.0;
            let v = cubic_bezier_ease_out(t);
            assert!(v >= prev, "曲线应单调不减: t={t} v={v} prev={prev}");
            prev = v;
        }
        assert!(
            cubic_bezier_ease_out(0.25) > 0.5,
            "强缓出曲线在前 25% 时间内应越过半程"
        );
    }

    #[test]
    fn compute_frame_and_dpi_scaling_bounds() {
        assert_eq!(scaled_offset_px(12.0, 1.5, false), 18);
        assert_eq!(scaled_offset_px(12.0, 1.5, true), 0);
        assert_eq!(scaled_offset_px(12.0, f64::NAN, false), 12);

        let start = compute_frame(0.0, 0, 255, 212, 200);
        let end = compute_frame(1.0, 0, 255, 212, 200);
        assert_eq!(start, AnimFrame { alpha: 0, y: 212 });
        assert_eq!(end, AnimFrame { alpha: 255, y: 200 });

        let mid = compute_frame(0.5, 255, 0, 200, 208);
        assert!(mid.alpha < 128 && mid.y > 204);
    }

    #[test]
    fn remaining_duration_scales_proportionally_with_floor() {
        assert_eq!(remaining_duration_ms(220, 0, 255), 220);
        assert_eq!(remaining_duration_ms(150, 255, 0), 150);
        assert_eq!(remaining_duration_ms(220, 128, 255), 110);
        assert_eq!(remaining_duration_ms(220, 250, 255), MIN_RESUME_DURATION_MS);
        assert_eq!(remaining_duration_ms(220, 255, 255), 0);
    }

    #[test]
    fn interrupt_preserves_rest_position_and_prevents_drift() {
        let mgr = WindowAnimManager::default();
        assert!(mgr.plan_show("settings", true, 100, 200, 1.0, false).is_none());

        let hide_plan = mgr
            .plan_hide("settings", true, 100, 200, 1.0, false)
            .expect("应启动关闭动画");
        assert_eq!(hide_plan.start_alpha, 255);
        assert_eq!(hide_plan.end_alpha, 0);
        assert_eq!(hide_plan.start_y, 200);
        assert_eq!(hide_plan.end_y, 208);

        assert!(mgr.plan_hide("settings", true, 100, 204, 1.0, false).is_none());

        {
            let mut inner = mgr.inner.lock().unwrap();
            let entry = inner.active.get_mut("settings").unwrap();
            entry.current_alpha = 120;
            entry.current_y = 204;
        }
        let show_plan = mgr
            .plan_show("settings", true, 100, 204, 1.0, false)
            .expect("关闭途中重开应打断接力");
        assert!(show_plan.was_active);
        assert_eq!(show_plan.rest_y, 200);
        assert_eq!(show_plan.start_alpha, 120);
        assert_eq!(show_plan.start_y, 204);
        assert_eq!(show_plan.end_alpha, 255);
        assert_eq!(show_plan.end_y, 200);

        assert!(mgr.finish_if_current("settings", hide_plan.generation).is_none());
        let done = mgr
            .finish_if_current("settings", show_plan.generation)
            .expect("新打开动画代次匹配应正常收尾");
        assert_eq!(done.rest_y, 200);
    }

    #[test]
    fn hidden_window_hide_is_noop() {
        let mgr = WindowAnimManager::default();
        assert!(mgr.plan_hide("records", false, 0, 0, 1.0, false).is_none());
    }
}
