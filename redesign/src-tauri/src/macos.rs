//! AppKit 操作集中在主线程。所有几何 IPC、穿透与聊天定位共用 Cocoa points 快照。
use crate::geometry::{nearest_rect, Rect};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSScreen, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(MainThreadMarker) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if let Some(mtm) = MainThreadMarker::new() { return action(mtm); }
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = MainThreadMarker::new().ok_or_else(|| "AppKit requires the main thread".into()).and_then(action);
        let _ = send.send(result);
    }).map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())?
}

/// SAFETY: caller holds a live Tauri window, and the marker confines the borrow to the main thread.
fn native(window: &WebviewWindow, _mtm: MainThreadMarker) -> Result<&NSWindow, String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    unsafe { (pointer as *const NSWindow).as_ref() }.ok_or_else(|| "NSWindow unavailable".into())
}

fn primary_top(mtm: MainThreadMarker) -> Result<f64, String> {
    let screen = NSScreen::screens(mtm).firstObject().ok_or("No desktop screen")?;
    let frame = screen.frame();
    Ok(frame.origin.y + frame.size.height)
}

fn rect(frame: NSRect, top: f64) -> Rect {
    Rect::from_cocoa(top, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    name: String,
    bounds: Rect,
    pub work_area: Rect,
}

fn monitor(screen: &NSScreen, top: f64) -> Monitor {
    Monitor { name: screen.localizedName().to_string(), bounds: rect(screen.frame(), top), work_area: rect(screen.visibleFrame(), top) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub outer: Rect,
    pub inner: Rect,
    pub backing_scale: f64,
    pub monitor: Option<Monitor>,
}

fn snapshot(window: &WebviewWindow, mtm: MainThreadMarker) -> Result<Geometry, String> {
    let win = native(window, mtm)?;
    let top = primary_top(mtm)?;
    let frame = win.frame();
    let outer = rect(frame, top);
    let screens = NSScreen::screens(mtm);
    let monitors: Vec<_> = screens.iter().map(|screen| monitor(&screen, top)).collect();
    let index = nearest_rect(&monitors.iter().map(|m| m.bounds).collect::<Vec<_>>(),
        outer.x + outer.width / 2.0, outer.y + outer.height / 2.0);
    Ok(Geometry {
        outer, inner: rect(win.contentRectForFrameRect(frame), top),
        backing_scale: win.backingScaleFactor(),
        monitor: index.and_then(|index| monitors.into_iter().nth(index)),
    })
}

pub fn geometry(window: &WebviewWindow) -> Result<Geometry, String> {
    let win = window.clone();
    on_main(window.app_handle(), move |mtm| snapshot(&win, mtm))
}

pub fn primary_monitor(app: &AppHandle) -> Result<Option<Monitor>, String> {
    on_main(app, |mtm| {
        let top = primary_top(mtm)?;
        Ok(NSScreen::screens(mtm).firstObject().map(|screen| monitor(&screen, top)))
    })
}

pub fn set_position(window: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() { return Err("Invalid desktop position".into()); }
    let win = window.clone();
    on_main(window.app_handle(), move |mtm| {
        native(&win, mtm)?.setFrameTopLeftPoint(NSPoint::new(x, primary_top(mtm)? - y));
        Ok(())
    })
}

/// 原子 frame 更新避免伴侣窗口先 resize 后 move；不会混用 pet/chat 的 backing scale。
pub fn set_frame(window: &WebviewWindow, frame: Rect) -> Result<(), String> {
    let win = window.clone();
    on_main(window.app_handle(), move |mtm| {
        let current = snapshot(&win, mtm)?.outer;
        if current != frame {
            native(&win, mtm)?.setFrame_display(NSRect::new(
                NSPoint::new(frame.x, frame.cocoa_y(primary_top(mtm)?)),
                NSSize::new(frame.width, frame.height)), true);
        }
        Ok(())
    })
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory).map_err(|e| e.to_string())?;
    app.set_dock_visibility(false).map_err(|e| e.to_string())?;
    let handle = app.clone();
    on_main(app, move |_mtm| {
        let pet = handle.get_webview_window("pet").ok_or("Missing pet window")?;
        let chat = handle.get_webview_window("chat").ok_or("Missing chat window")?;
        for window in [&pet, &chat] {
            window.set_visible_on_all_workspaces(true).map_err(|e| e.to_string())?;
        }
        chat.hide().map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Hidden chat must not remain an ordered child: showing pet must not reopen a user-closed chat.
pub fn parent_chat(app: &AppHandle, attached: bool) -> Result<(), String> {
    let handle = app.clone();
    on_main(app, move |mtm| {
        let pet = handle.get_webview_window("pet").ok_or("Missing pet window")?;
        let chat = handle.get_webview_window("chat").ok_or("Missing chat window")?;
        let (parent, child) = (native(&pet, mtm)?, native(&chat, mtm)?);
        if attached {
            // Both NSWindows live throughout the main-thread operation; no pointer escapes.
            unsafe { parent.addChildWindow_ordered(child, NSWindowOrderingMode::Above); }
        } else { parent.removeChildWindow(child); }
        Ok(())
    })
}

struct PollState {
    ignoring: std::collections::HashMap<&'static str, bool>,
    last_mouse: Option<(f64, f64)>,
    last_emit: std::time::Instant,
}

pub fn spawn_click_through(app: AppHandle, masks: crate::HitMaskState) {
    std::thread::spawn(move || {
        let mut state = PollState { ignoring: Default::default(), last_mouse: None, last_emit: std::time::Instant::now() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let handle = app.clone();
            let masks = masks.clone();
            // Wait for each main-thread sample: never accumulate queued ticks while a menu is open.
            match on_main(&app, move |mtm| {
                let Ok(top) = primary_top(mtm) else { return Ok(state) };
                let mouse = NSEvent::mouseLocation();
                let point = (mouse.x, top - mouse.y);
                for label in ["pet", "chat"] {
                    let Some(window) = handle.get_webview_window(label) else { continue };
                    let Ok(native) = native(&window, mtm) else { continue };
                    if !native.isVisible() {
                        if state.ignoring.get(label) == Some(&true) && window.set_ignore_cursor_events(false).is_ok() {
                            state.ignoring.insert(label, false);
                        }
                        continue;
                    }
                    if label == "pet" && (state.last_mouse != Some(point) || state.last_emit.elapsed().as_secs_f64() >= 1.0) {
                        if window.emit("global-mouse", serde_json::json!({ "x": point.0, "y": point.1 })).is_ok() {
                            state.last_mouse = Some(point);
                            state.last_emit = std::time::Instant::now();
                        }
                    }
                    let frame = rect(native.frame(), top);
                    let wanted = masks.lock().ok().and_then(|map| crate::want_ignore_at(map.get(label), point,
                        Some((frame.x, frame.y, frame.width, frame.height))));
                    if let Some(ignore) = wanted {
                        if state.ignoring.get(label).copied().unwrap_or(false) != ignore && window.set_ignore_cursor_events(ignore).is_ok() {
                            state.ignoring.insert(label, ignore);
                        }
                    }
                }
                Ok(state)
            }) {
                Ok(next) => state = next,
                Err(error) => { eprintln!("[macOS] mouse polling stopped: {error}"); break; }
            }
        }
    });
}
