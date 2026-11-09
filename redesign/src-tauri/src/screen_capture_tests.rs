use super::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, SetLayeredWindowAttributes, LWA_ALPHA, WDA_MONITOR, WDA_NONE,
    WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_POPUP,
};

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> HANDLE;
}
#[link(name = "user32")]
extern "system" {
    fn GetGuiResources(process: HANDLE, flags: u32) -> u32;
}

fn hwnd(value: usize) -> HWND {
    value as HWND
}

struct FakeAffinity {
    values: RefCell<HashMap<usize, u32>>,
    supported: bool,
    downgrade: bool,
    gets: Cell<usize>,
    fail_get: usize,
    fail_set: Cell<Option<(usize, u32)>>,
    sets: RefCell<Vec<(usize, u32)>>,
}

impl FakeAffinity {
    fn new() -> Self {
        Self {
            values: RefCell::new(HashMap::from([(1, WDA_NONE), (2, WDA_MONITOR)])),
            supported: true,
            downgrade: false,
            gets: Cell::new(0),
            fail_get: 0,
            fail_set: Cell::new(None),
            sets: RefCell::new(Vec::new()),
        }
    }
    fn assert_originals(&self) {
        assert_eq!(self.values.borrow()[&1], WDA_NONE);
        assert_eq!(self.values.borrow()[&2], WDA_MONITOR);
    }
}

impl AffinityApi for FakeAffinity {
    fn supports_exclusion(&self) -> Result<bool, String> {
        Ok(self.supported)
    }
    fn get(&self, window: HWND) -> Result<u32, String> {
        self.gets.set(self.gets.get() + 1);
        if self.gets.get() == self.fail_get {
            return Err("injected Get failure".into());
        }
        Ok(self.values.borrow()[&(window as usize)])
    }
    fn set(&self, window: HWND, value: u32) -> Result<(), String> {
        let key = window as usize;
        self.sets.borrow_mut().push((key, value));
        let stored = if self.downgrade && value == WDA_EXCLUDEFROMCAPTURE {
            WDA_MONITOR
        } else {
            value
        };
        // Deliberately mutate before failing: rollback must include the failing HWND.
        self.values.borrow_mut().insert(key, stored);
        if self.fail_set.get() == Some((key, value)) {
            self.fail_set.set(None);
            return Err("injected Set failure".into());
        }
        Ok(())
    }
}

#[test]
fn affinity_preserves_distinct_originals_and_deduplicates() {
    let api = FakeAffinity::new();
    let mut guard = AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2), hwnd(1)]).unwrap();
    assert!(api
        .values
        .borrow()
        .values()
        .all(|&v| v == WDA_EXCLUDEFROMCAPTURE));
    guard.restore().unwrap();
    api.assert_originals();
    assert_eq!(&*api.sets.borrow(), &[(1, 17), (2, 17), (2, 1), (1, 0)]);
}

#[test]
fn affinity_rejects_old_windows_before_any_mutation() {
    let mut api = FakeAffinity::new();
    api.supported = false;
    assert!(AffinityGuard::exclude(&api, &[hwnd(1)]).is_err());
    assert_eq!(api.gets.get(), 0);
    assert!(api.sets.borrow().is_empty());
    api.assert_originals();
}

#[test]
fn affinity_initial_get_failure_never_changes_windows() {
    let mut api = FakeAffinity::new();
    api.fail_get = 2;
    assert!(AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).is_err());
    assert!(api.sets.borrow().is_empty());
    api.assert_originals();
}

#[test]
fn affinity_partial_set_and_readback_failures_roll_back() {
    let api = FakeAffinity::new();
    api.fail_set.set(Some((2, WDA_EXCLUDEFROMCAPTURE)));
    assert!(AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).is_err());
    api.assert_originals();
    let mut api = FakeAffinity::new();
    api.fail_get = 4; // Two snapshots, first readback, then second readback fails.
    assert!(AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).is_err());
    api.assert_originals();
}

#[test]
fn affinity_silent_monitor_downgrade_rolls_back() {
    let mut api = FakeAffinity::new();
    api.downgrade = true;
    assert!(AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).is_err());
    api.assert_originals();
}

#[test]
fn affinity_cleanup_reports_errors_restores_others_and_drop_retries() {
    let api = FakeAffinity::new();
    let mut guard = AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).unwrap();
    api.fail_set.set(Some((2, WDA_MONITOR)));
    assert!(guard
        .restore()
        .unwrap_err()
        .contains("injected Set failure"));
    assert_eq!(api.values.borrow()[&1], WDA_NONE);
    drop(guard);
    api.assert_originals();
    assert_eq!(
        api.sets
            .borrow()
            .iter()
            .filter(|&&(w, v)| w == 2 && v == WDA_MONITOR)
            .count(),
        2
    );
}

#[test]
fn affinity_drop_restores_during_unwind() {
    let api = FakeAffinity::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = AffinityGuard::exclude(&api, &[hwnd(1), hwnd(2)]).unwrap();
        panic!("injected capture panic");
    }));
    assert!(result.is_err());
    api.assert_originals();
}

struct TestWindow(HWND);
impl TestWindow {
    fn new() -> Self {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let window = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                16,
                16,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!window.is_null(), "{}", last_error("CreateWindowExW"));
        assert_ne!(
            unsafe { SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA) },
            0
        );
        Self(window)
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        assert_ne!(unsafe { DestroyWindow(self.0) }, 0);
    }
}

#[test]
fn native_affinity_excludes_and_restores_real_layered_windows() {
    let _lock = capture_lock().unwrap();
    assert!(
        NativeAffinity.supports_exclusion().unwrap(),
        "native test requires Windows 10 2004+"
    );
    let first = TestWindow::new();
    let second = TestWindow::new();
    NativeAffinity.set(second.0, WDA_MONITOR).unwrap();
    assert_eq!(NativeAffinity.get(first.0).unwrap(), WDA_NONE);
    {
        let _guard = AffinityGuard::exclude(&NativeAffinity, &[first.0, second.0]).unwrap();
        assert_eq!(NativeAffinity.get(first.0).unwrap(), WDA_EXCLUDEFROMCAPTURE);
        assert_eq!(
            NativeAffinity.get(second.0).unwrap(),
            WDA_EXCLUDEFROMCAPTURE
        );
        assert!(unsafe { DwmFlush() } >= 0);
    }
    assert_eq!(NativeAffinity.get(first.0).unwrap(), WDA_NONE);
    assert_eq!(NativeAffinity.get(second.0).unwrap(), WDA_MONITOR);
}

#[test]
fn native_affinity_partial_failure_rolls_back_real_windows() {
    let _lock = capture_lock().unwrap();
    struct FailSecond {
        second: HWND,
        failed: Cell<bool>,
    }
    impl AffinityApi for FailSecond {
        fn supports_exclusion(&self) -> Result<bool, String> {
            NativeAffinity.supports_exclusion()
        }
        fn get(&self, window: HWND) -> Result<u32, String> {
            NativeAffinity.get(window)
        }
        fn set(&self, window: HWND, value: u32) -> Result<(), String> {
            if window == self.second
                && value == WDA_EXCLUDEFROMCAPTURE
                && !self.failed.replace(true)
            {
                return Err("injected second HWND failure".into());
            }
            NativeAffinity.set(window, value)
        }
    }
    let first = TestWindow::new();
    let second = TestWindow::new();
    NativeAffinity.set(first.0, WDA_MONITOR).unwrap();
    let api = FailSecond {
        second: second.0,
        failed: Cell::new(false),
    };
    assert!(AffinityGuard::exclude(&api, &[first.0, second.0]).is_err());
    assert_eq!(NativeAffinity.get(first.0).unwrap(), WDA_MONITOR);
    assert_eq!(NativeAffinity.get(second.0).unwrap(), WDA_NONE);
}

struct FaultGdi {
    fail: RefCell<Vec<&'static str>>,
    always_restore_failure: bool,
    panic_at: Option<&'static str>,
    calls: RefCell<Vec<String>>,
}
impl FaultGdi {
    fn once(operation: &'static str) -> Self {
        Self {
            fail: RefCell::new(vec![operation]),
            always_restore_failure: false,
            panic_at: None,
            calls: RefCell::new(Vec::new()),
        }
    }
}
impl GdiApi for FaultGdi {
    fn before(&self, operation: &str) -> Result<(), String> {
        self.calls.borrow_mut().push(operation.into());
        assert_ne!(self.panic_at, Some(operation), "injected GDI panic");
        let index = self
            .fail
            .borrow()
            .iter()
            .position(|&name| name == operation);
        if let Some(index) = index {
            self.fail.borrow_mut().remove(index);
            return Err(format!("injected {operation} failure"));
        }
        if self.always_restore_failure && operation == "SelectObject(restore)" {
            return Err("injected persistent deselection failure".into());
        }
        Ok(())
    }
}

fn region() -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: 8,
        bottom: 6,
    }
}
fn gdi_count() -> u32 {
    // A leak-free standalone test process can have zero GDI objects. Keep a real
    // DC alive while measuring so zero cannot be confused with API failure.
    let probe = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
    assert!(
        !probe.is_null(),
        "{}",
        last_error("CreateCompatibleDC(probe)")
    );
    let count = unsafe { GetGuiResources(GetCurrentProcess(), 0) };
    assert_ne!(unsafe { DeleteDC(probe) }, 0);
    assert!(count > 0, "GetGuiResources must see the live probe DC");
    count
}

#[test]
fn native_gdi_capture_preserves_wire_format_and_releases_resources() {
    let _lock = capture_lock().unwrap();
    let warmup = grab_region(&NativeGdi, region()).unwrap();
    assert_eq!(&warmup[..8], &[8, 0, 0, 0, 6, 0, 0, 0]);
    assert_eq!(warmup.len(), 8 + 8 * 6 * 4);
    assert!(warmup[8..].chunks_exact(4).all(|pixel| pixel[3] == 255));
    let before = gdi_count();
    for _ in 0..32 {
        grab_region(&NativeGdi, region()).unwrap();
    }
    assert_eq!(gdi_count(), before);
    let capture = grab_monitor_of(std::ptr::null_mut()).unwrap();
    let width = u32::from_le_bytes(capture[0..4].try_into().unwrap()) as usize;
    let height = u32::from_le_bytes(capture[4..8].try_into().unwrap()) as usize;
    assert!(width > 0 && height > 0);
    assert_eq!(capture.len(), 8 + width * height * 4);
    assert_eq!(gdi_count(), before);
}

#[test]
fn native_gdi_each_failure_rolls_back_real_resources() {
    let _lock = capture_lock().unwrap();
    grab_region(&NativeGdi, region()).unwrap();
    let before = gdi_count();
    for operation in [
        "GetDC",
        "CreateCompatibleDC",
        "CreateCompatibleBitmap",
        "SelectObject",
        "BitBlt",
        "SelectObject(restore)",
        "GetDIBits",
        "DeleteDC",
        "DeleteObject",
        "ReleaseDC",
    ] {
        for _ in 0..8 {
            let api = FaultGdi::once(operation);
            let error = grab_region(&api, region()).unwrap_err();
            assert!(error.contains(operation), "{operation}: {error}");
            assert!(
                api.fail.borrow().is_empty(),
                "injection must actually execute: {operation}"
            );
            assert_eq!(gdi_count(), before, "resource leak after {operation}");
        }
    }
}

#[test]
fn native_gdi_failed_deselection_destroys_dc_before_bitmap() {
    let _lock = capture_lock().unwrap();
    grab_region(&NativeGdi, region()).unwrap();
    let before = gdi_count();
    let mut api = FaultGdi::once("DeleteDC");
    api.always_restore_failure = true;
    assert!(grab_region(&api, region()).is_err());
    let calls = api.calls.borrow();
    let deletes: Vec<_> = calls
        .iter()
        .enumerate()
        .filter(|(_, name)| name.as_str() == "DeleteDC")
        .collect();
    assert_eq!(deletes.len(), 2, "explicit cleanup fails; Drop retries");
    let bitmap_delete = calls
        .iter()
        .position(|name| name == "DeleteObject")
        .unwrap();
    assert!(
        bitmap_delete > deletes[1].0,
        "never delete a bitmap selected in a live DC"
    );
    assert!(!calls.iter().any(|name| name == "GetDIBits"));
    assert_eq!(gdi_count(), before);
}

#[test]
fn native_gdi_drop_releases_resources_during_unwind() {
    let _lock = capture_lock().unwrap();
    grab_region(&NativeGdi, region()).unwrap();
    let before = gdi_count();
    let mut api = FaultGdi::once("unused");
    api.panic_at = Some("BitBlt");
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| grab_region(&api, region())));
    assert!(result.is_err());
    assert_eq!(gdi_count(), before);
}

#[test]
fn capture_lock_serializes_competing_threads() {
    let lock = capture_lock().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        assert!(matches!(
            CAPTURE_LOCK.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        sender.send(false).unwrap();
        let _lock = capture_lock().unwrap();
        sender.send(true).unwrap();
    });
    assert!(!receiver.recv().unwrap());
    assert!(receiver.try_recv().is_err());
    drop(lock);
    assert!(receiver.recv().unwrap());
    thread.join().unwrap();
}

#[test]
fn invalid_region_fails_without_acquiring_resources() {
    let api = FaultGdi::once("GetDC");
    assert!(grab_region(
        &api,
        RECT {
            left: i32::MIN,
            right: i32::MAX,
            top: 0,
            bottom: 1
        }
    )
    .is_err());
    assert!(grab_region(
        &api,
        RECT {
            left: 0,
            right: 1,
            top: 1,
            bottom: 0
        }
    )
    .is_err());
    assert!(api.calls.borrow().is_empty());
}

#[test]
fn select_object_rejects_null_and_hgdi_error() {
    assert!(invalid_object(std::ptr::null_mut()));
    assert!(invalid_object((-1isize) as HGDIOBJ));
    assert!(!invalid_object(1usize as HGDIOBJ));
}
