//! 聊天窗口「截取当前屏幕」（仅 Windows）：用户手动点击时截取桌宠所在显示器。
//! 截图期间 pet/chat 设为 WDA_EXCLUDEFROMCAPTURE，画面里不出现桌宠自己。
//! 返回 `[width u32 LE][height u32 LE][RGBA…]` 原始字节，由前端压缩后作为聊天附件
//! 预览，用户确认发送才会上传。

#[tauri::command]
pub async fn capture_screen(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        win::capture_screen(&app).map(tauri::ipc::Response::new)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("当前平台不支持截屏".into())
    }
}

#[cfg(windows)]
mod win {
    use tauri::Manager;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

    fn own_windows(app: &tauri::AppHandle) -> Vec<HWND> {
        ["pet", "chat"]
            .iter()
            .filter_map(|label| app.get_webview_window(label))
            .filter_map(|w| w.hwnd().ok())
            .map(|h| h.0 as HWND)
            .collect()
    }

    pub fn capture_screen(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
        let pet = app
            .get_webview_window("pet")
            .ok_or("pet 窗口不存在")?
            .hwnd()
            .map_err(|e| e.to_string())?
            .0 as HWND;
        let own = own_windows(app);
        unsafe {
            for &h in &own {
                SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
            }
        }
        // 显示亲和性由 DWM 在下一帧合成时生效。
        std::thread::sleep(std::time::Duration::from_millis(80));
        let result = unsafe { grab_monitor_of(pet) };
        unsafe {
            for &h in &own {
                SetWindowDisplayAffinity(h, WDA_NONE);
            }
        }
        result
    }

    unsafe fn grab_monitor_of(hwnd: HWND) -> Result<Vec<u8>, String> {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err("读取显示器信息失败".into());
        }
        let RECT { left, top, right, bottom } = info.rcMonitor;
        let (w, h) = (right - left, bottom - top);
        if w <= 0 || h <= 0 {
            return Err("显示器尺寸无效".into());
        }

        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("GetDC 失败".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let mut out = Err("截屏失败".to_string());
        if !mem.is_null() && !bitmap.is_null() {
            let old = SelectObject(mem, bitmap);
            if BitBlt(mem, 0, 0, w, h, screen, left, top, SRCCOPY | CAPTUREBLT) != 0 {
                let mut bmi: BITMAPINFO = std::mem::zeroed();
                bmi.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 自上而下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                };
                let mut buf = vec![0u8; 8 + (w as usize) * (h as usize) * 4];
                let pixels = &mut buf[8..];
                SelectObject(mem, old);
                let lines = GetDIBits(mem, bitmap, 0, h as u32, pixels.as_mut_ptr().cast(), &mut bmi, DIB_RGB_COLORS);
                if lines == h {
                    for px in pixels.chunks_exact_mut(4) {
                        px.swap(0, 2); // BGRA -> RGBA
                        px[3] = 255;
                    }
                    buf[0..4].copy_from_slice(&(w as u32).to_le_bytes());
                    buf[4..8].copy_from_slice(&(h as u32).to_le_bytes());
                    out = Ok(buf);
                }
            } else {
                SelectObject(mem, old);
            }
        }
        if !bitmap.is_null() {
            DeleteObject(bitmap);
        }
        if !mem.is_null() {
            DeleteDC(mem);
        }
        ReleaseDC(std::ptr::null_mut(), screen);
        out
    }
}
