//! macOS 桌面坐标用 points，而不是随窗口 backing scale 改变的“全局物理像素”。
//! 原点是主屏左上角，允许位于主屏左侧/上方的负坐标；渲染 DPR 另行处理。

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// Cocoa 原点在主屏左下角，y 向上；窗口与屏幕必须使用同一主屏顶边。
    pub fn from_cocoa(primary_top: f64, x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y: primary_top - y - height, width, height }
    }

    pub fn cocoa_y(self, primary_top: f64) -> f64 {
        primary_top - self.y - self.height
    }

    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    fn distance_squared(self, x: f64, y: f64) -> f64 {
        if self.contains(x, y) { return 0.0; }
        let dx = (self.x - x).max(0.0).max(x - self.x - self.width);
        let dy = (self.y - y).max(0.0).max(y - self.y - self.height);
        dx * dx + dy * dy
    }
}

/// 窗口完全出屏时仍可选最近屏幕工作区，不把副屏窗口直接拉回主屏。
pub fn nearest_rect(rects: &[Rect], x: f64, y: f64) -> Option<usize> {
    rects.iter().enumerate().min_by(|(_, a), (_, b)| {
        a.distance_squared(x, y).total_cmp(&b.distance_squared(x, y))
    }).map(|(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cocoa_round_trip_handles_retina_negative_and_fractional_positions() {
        // backing scale 根本不参与世界坐标：同一窗口换成 1x / 2x 屏不会改变 points。
        for primary_top in [900.0, 1080.0] {
            for (x, y, w, h) in [(20.5, 100.25, 400.0, 600.0), (-1900.0, 900.0, 300.0, 200.0)] {
                let rect = Rect::from_cocoa(primary_top, x, y, w, h);
                assert_eq!(rect.x, x);
                assert_eq!(rect.cocoa_y(primary_top), y);
                assert_eq!((rect.width, rect.height), (w, h));
                assert!(rect.contains(x, rect.y));
                assert!(!rect.contains(x + w, rect.y));
                assert!(!rect.contains(x, rect.y + h));
            }
        }
    }

    #[test]
    fn offscreen_recovery_uses_nearest_display_including_displays_above_and_left() {
        let screens = [
            Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 },
            Rect { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 },
            Rect { x: 0.0, y: -1080.0, width: 1920.0, height: 1080.0 },
        ];
        assert_eq!(nearest_rect(&screens, 500.0, 500.0), Some(0));
        assert_eq!(nearest_rect(&screens, -2200.0, 300.0), Some(1));
        assert_eq!(nearest_rect(&screens, 300.0, -1400.0), Some(2));
        assert_eq!(nearest_rect(&screens[..1], -2200.0, 300.0), Some(0));
        assert_eq!(nearest_rect(&[], 0.0, 0.0), None);
    }
}
