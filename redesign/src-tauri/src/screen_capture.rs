//! 聊天窗口「截取当前屏幕」（仅 Windows）：用户手动点击时截取桌宠所在显示器。
//! 截图期间 pet/chat 设为 WDA_EXCLUDEFROMCAPTURE，结束后恢复各自原始亲和性。
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
    use std::sync::{Mutex, MutexGuard};
    use tauri::Manager;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };

    static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

    // These APIs need no additional windows-sys features. RtlGetVersion is not affected
    // by the application manifest (unlike GetVersionEx/VerifyVersionInfo).
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version: *mut OsVersionInfo) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmFlush() -> i32;
    }

    fn last_error(operation: &str) -> String {
        format!("{operation} 失败: {}", std::io::Error::last_os_error())
    }

    fn finish<T>(result: Result<T, String>, cleanup: Result<(), String>) -> Result<T, String> {
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(format!("{error}; 清理失败: {cleanup}")),
        }
    }

    fn capture_lock() -> Result<MutexGuard<'static, ()>, String> {
        // A panic may mean affinity restoration failed. Do not silently clear poison.
        CAPTURE_LOCK
            .lock()
            .map_err(|_| "截屏锁已中毒，请重启应用后重试".into())
    }

    trait AffinityApi {
        fn supports_exclusion(&self) -> Result<bool, String>;
        fn get(&self, hwnd: HWND) -> Result<u32, String>;
        fn set(&self, hwnd: HWND, affinity: u32) -> Result<(), String>;
    }

    struct NativeAffinity;

    impl AffinityApi for NativeAffinity {
        fn supports_exclusion(&self) -> Result<bool, String> {
            let mut version: OsVersionInfo = unsafe { std::mem::zeroed() };
            version.size = std::mem::size_of::<OsVersionInfo>() as u32;
            let status = unsafe { RtlGetVersion(&mut version) };
            if status < 0 {
                return Err(format!("RtlGetVersion 失败: NTSTATUS {status:#x}"));
            }
            // Before Windows 10 2004, EXCLUDEFROMCAPTURE can succeed but act as
            // WDA_MONITOR (a black rectangle), even if Get returns the requested value.
            Ok(version.major > 10 || (version.major == 10 && version.build >= 19041))
        }

        fn get(&self, hwnd: HWND) -> Result<u32, String> {
            let mut affinity = 0;
            if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) } == 0 {
                Err(last_error("GetWindowDisplayAffinity"))
            } else {
                Ok(affinity)
            }
        }

        fn set(&self, hwnd: HWND, affinity: u32) -> Result<(), String> {
            if unsafe { SetWindowDisplayAffinity(hwnd, affinity) } == 0 {
                Err(last_error("SetWindowDisplayAffinity"))
            } else {
                Ok(())
            }
        }
    }

    struct AffinityGuard<'a, A: AffinityApi> {
        api: &'a A,
        originals: Vec<(HWND, u32)>,
    }

    impl<'a, A: AffinityApi> AffinityGuard<'a, A> {
        fn exclude(api: &'a A, windows: &[HWND]) -> Result<Self, String> {
            if !api.supports_exclusion()? {
                return Err(
                    "当前 Windows 不支持排除窗口截屏（需要 Windows 10 2004 或更新版本）".into(),
                );
            }
            // Read every original before changing anything. A failed Get must never
            // turn an unknown original into WDA_NONE. Deduplicate HWNDs as well.
            let mut originals = Vec::new();
            for &hwnd in windows {
                if !originals.iter().any(|&(existing, _)| existing == hwnd) {
                    originals.push((hwnd, api.get(hwnd)?));
                }
            }
            let mut guard = Self {
                api,
                originals: Vec::new(),
            };
            for (hwnd, original) in originals {
                // Record before Set: even an attempted/partially failing change is
                // included in rollback. Restoration happens in reverse order.
                guard.originals.push((hwnd, original));
                let result = api.set(hwnd, WDA_EXCLUDEFROMCAPTURE).and_then(|()| {
                    if api.get(hwnd)? != WDA_EXCLUDEFROMCAPTURE {
                        Err("窗口截屏排除未生效（可能退化为 WDA_MONITOR）".into())
                    } else {
                        Ok(())
                    }
                });
                if let Err(error) = result {
                    return finish(Err(error), guard.restore());
                }
            }
            Ok(guard)
        }

        fn restore(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            let mut retry = Vec::new();
            while let Some((hwnd, original)) = self.originals.pop() {
                let result = self.api.set(hwnd, original).and_then(|()| {
                    if self.api.get(hwnd)? == original {
                        Ok(())
                    } else {
                        Err("恢复原窗口截屏亲和性校验失败".into())
                    }
                });
                if let Err(error) = result {
                    errors.push(format!("HWND {hwnd:p}: {error}"));
                    retry.push((hwnd, original));
                }
            }
            // Keep failed entries for one more best-effort attempt in Drop.
            self.originals = retry.into_iter().rev().collect();
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }
    }

    impl<A: AffinityApi> Drop for AffinityGuard<'_, A> {
        fn drop(&mut self) {
            if let Err(error) = self.restore() {
                eprintln!("截屏窗口亲和性恢复失败: {error}");
            }
        }
    }

    fn own_windows(app: &tauri::AppHandle) -> Result<Vec<HWND>, String> {
        ["pet", "chat"]
            .iter()
            .filter_map(|label| app.get_webview_window(label))
            .map(|window| {
                window
                    .hwnd()
                    .map(|hwnd| hwnd.0 as HWND)
                    .map_err(|e| e.to_string())
            })
            .collect()
    }

    pub fn capture_screen(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
        // Declare the lock first: it outlives both explicit restore and Drop retries.
        let _lock = capture_lock()?;
        let pet = app
            .get_webview_window("pet")
            .ok_or("pet 窗口不存在")?
            .hwnd()
            .map_err(|e| e.to_string())?
            .0 as HWND;
        let own = own_windows(app)?;
        let mut affinity = AffinityGuard::exclude(&NativeAffinity, &own)?;
        let result = (|| {
            let status = unsafe { DwmFlush() };
            if status < 0 {
                return Err(format!("DwmFlush 失败: HRESULT {status:#x}"));
            }
            grab_monitor_of(pet)
        })();
        finish(result, affinity.restore())
    }

    // A small fault boundary lets tests fail individual native acquisition, drawing,
    // readback and cleanup calls while still allocating real Windows GDI resources.
    trait GdiApi {
        fn before(&self, _operation: &str) -> Result<(), String> {
            Ok(())
        }
    }
    struct NativeGdi;
    impl GdiApi for NativeGdi {}

    struct GdiResources<'a, A: GdiApi> {
        api: &'a A,
        screen: HDC,
        mem: HDC,
        bitmap: HBITMAP,
        old: HGDIOBJ,
    }

    fn invalid_object(object: HGDIOBJ) -> bool {
        object.is_null() || object as isize == -1 // HGDI_ERROR is not exported by windows-sys 0.59.
    }

    impl<'a, A: GdiApi> GdiResources<'a, A> {
        fn new(api: &'a A) -> Self {
            Self {
                api,
                screen: std::ptr::null_mut(),
                mem: std::ptr::null_mut(),
                bitmap: std::ptr::null_mut(),
                old: std::ptr::null_mut(),
            }
        }

        fn deselect(&mut self) -> Result<(), String> {
            if !self.old.is_null() {
                self.api.before("SelectObject(restore)")?;
                if invalid_object(unsafe { SelectObject(self.mem, self.old) }) {
                    return Err(last_error("SelectObject(restore)"));
                }
                self.old = std::ptr::null_mut();
            }
            Ok(())
        }

        fn cleanup(&mut self) -> Result<(), String> {
            let mut errors = Vec::new();
            if let Err(error) = self.deselect() {
                errors.push(error);
            }
            // Destroy the DC first if deselection failed: DeleteObject must not be
            // called on a bitmap still selected into a live DC.
            if !self.mem.is_null() {
                let result = self.api.before("DeleteDC").and_then(|()| {
                    if unsafe { DeleteDC(self.mem) } == 0 {
                        Err(last_error("DeleteDC"))
                    } else {
                        Ok(())
                    }
                });
                match result {
                    Ok(()) => {
                        self.mem = std::ptr::null_mut();
                        self.old = std::ptr::null_mut();
                    }
                    Err(error) => errors.push(error),
                }
            }
            if !self.bitmap.is_null() && self.old.is_null() {
                let result = self.api.before("DeleteObject").and_then(|()| {
                    if unsafe { DeleteObject(self.bitmap) } == 0 {
                        Err(last_error("DeleteObject"))
                    } else {
                        Ok(())
                    }
                });
                match result {
                    Ok(()) => self.bitmap = std::ptr::null_mut(),
                    Err(error) => errors.push(error),
                }
            }
            if !self.screen.is_null() {
                let result = self.api.before("ReleaseDC").and_then(|()| {
                    if unsafe { ReleaseDC(std::ptr::null_mut(), self.screen) } == 0 {
                        Err(last_error("ReleaseDC"))
                    } else {
                        Ok(())
                    }
                });
                match result {
                    Ok(()) => self.screen = std::ptr::null_mut(),
                    Err(error) => errors.push(error),
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("; "))
            }
        }
    }

    impl<A: GdiApi> Drop for GdiResources<'_, A> {
        fn drop(&mut self) {
            if let Err(error) = self.cleanup() {
                eprintln!("截屏 GDI 资源释放失败: {error}");
            }
        }
    }

    fn grab_monitor_of(hwnd: HWND) -> Result<Vec<u8>, String> {
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return Err(last_error("GetMonitorInfoW"));
        }
        grab_region(&NativeGdi, info.rcMonitor)
    }

    fn grab_region(api: &impl GdiApi, rect: RECT) -> Result<Vec<u8>, String> {
        let w = rect
            .right
            .checked_sub(rect.left)
            .filter(|&w| w > 0)
            .ok_or("显示器宽度无效")?;
        let h = rect
            .bottom
            .checked_sub(rect.top)
            .filter(|&h| h > 0)
            .ok_or("显示器高度无效")?;
        let size = (w as usize)
            .checked_mul(h as usize)
            .and_then(|n| n.checked_mul(4))
            .and_then(|n| n.checked_add(8))
            .ok_or("截屏数据长度溢出")?;
        let mut buf = Vec::new();
        buf.try_reserve_exact(size)
            .map_err(|e| format!("分配截屏缓冲区失败: {e}"))?;
        buf.resize(size, 0);
        let mut resources = GdiResources::new(api);
        let result = (|| {
            api.before("GetDC")?;
            resources.screen = unsafe { GetDC(std::ptr::null_mut()) };
            if resources.screen.is_null() {
                return Err(last_error("GetDC"));
            }
            api.before("CreateCompatibleDC")?;
            resources.mem = unsafe { CreateCompatibleDC(resources.screen) };
            if resources.mem.is_null() {
                return Err(last_error("CreateCompatibleDC"));
            }
            // Use the screen DC, not the memory DC's default monochrome bitmap.
            api.before("CreateCompatibleBitmap")?;
            resources.bitmap = unsafe { CreateCompatibleBitmap(resources.screen, w, h) };
            if resources.bitmap.is_null() {
                return Err(last_error("CreateCompatibleBitmap"));
            }
            api.before("SelectObject")?;
            let old = unsafe { SelectObject(resources.mem, resources.bitmap) };
            if invalid_object(old) {
                return Err(last_error("SelectObject"));
            }
            resources.old = old;
            api.before("BitBlt")?;
            if unsafe {
                BitBlt(
                    resources.mem,
                    0,
                    0,
                    w,
                    h,
                    resources.screen,
                    rect.left,
                    rect.top,
                    SRCCOPY | CAPTUREBLT,
                )
            } == 0
            {
                return Err(last_error("BitBlt"));
            }
            // GetDIBits requires the bitmap not to be selected into any DC.
            resources.deselect()?;
            let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..unsafe { std::mem::zeroed() }
            };
            api.before("GetDIBits")?;
            let lines = unsafe {
                GetDIBits(
                    resources.screen,
                    resources.bitmap,
                    0,
                    h as u32,
                    buf[8..].as_mut_ptr().cast(),
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            };
            if lines != h {
                return Err(format!("GetDIBits 返回 {lines}/{h} 行"));
            }
            for px in buf[8..].chunks_exact_mut(4) {
                px.swap(0, 2); // BGRA -> RGBA
                px[3] = 255;
            }
            buf[0..4].copy_from_slice(&(w as u32).to_le_bytes());
            buf[4..8].copy_from_slice(&(h as u32).to_le_bytes());
            Ok(buf)
        })();
        finish(result, resources.cleanup())
    }

    #[cfg(test)]
    mod tests {
        include!("screen_capture_tests.rs");
    }
}
