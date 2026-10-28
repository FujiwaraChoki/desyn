//! The canvas camera: which page point sits at the viewport's top-left and how many screen px one design px
//! covers. Screen coordinates are logical px relative to the canvas element (the UI multiplies by the window's
//! scale factor for device px).

use desyn_core::geometry::{Point, Rect};

/// Smallest zoom (2 %).
pub const MIN_ZOOM: f64 = 0.02;
/// Largest zoom (25 600 %).
pub const MAX_ZOOM: f64 = 256.0;
/// Zoom stops used by zoom in / out.
pub const STOPS: [f64; 23] = [
    0.02,
    0.05,
    0.1,
    0.125,
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    1.0,
    1.5,
    2.0,
    3.0,
    4.0,
    6.0,
    8.0,
    12.0,
    16.0,
    24.0,
    32.0,
    48.0,
    64.0,
    128.0,
    256.0,
];

/// Camera state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    /// Page x at the viewport's left edge.
    pub x: f64,
    /// Page y at the viewport's top edge.
    pub y: f64,
    /// Screen px per design px.
    pub zoom: f64,
    /// Viewport width in screen px.
    pub width: f64,
    /// Viewport height in screen px.
    pub height: f64,
    /// Screen px at the bottom covered by floating chrome (the tool dock); fitting keeps content above it.
    pub bottom_inset: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Camera {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
            width: 800.0,
            height: 600.0,
            bottom_inset: 0.0,
        }
    }
}

impl Camera {
    /// Screen point -> page point.
    pub fn to_page(&self, s: Point) -> Point {
        Point::new(s.x / self.zoom + self.x, s.y / self.zoom + self.y)
    }

    /// Page point -> screen point.
    pub fn to_screen(&self, p: Point) -> Point {
        Point::new((p.x - self.x) * self.zoom, (p.y - self.y) * self.zoom)
    }

    /// Page rect -> screen rect.
    pub fn rect_to_screen(&self, r: &Rect) -> Rect {
        let a = self.to_screen(Point::new(r.x, r.y));
        Rect {
            x: a.x,
            y: a.y,
            w: r.w * self.zoom,
            h: r.h * self.zoom,
        }
    }

    /// Visible page rect.
    pub fn visible(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            w: self.width / self.zoom,
            h: self.height / self.zoom,
        }
    }

    /// Sets the viewport size keeping the center fixed (window resizes keep the design centered).
    pub fn resize(&mut self, width: f64, height: f64) {
        let (width, height) = (width.max(1.0), height.max(1.0));
        if (width - self.width).abs() < 1e-9 && (height - self.height).abs() < 1e-9 {
            return;
        }
        let c = self.to_page(Point::new(self.width / 2.0, self.height / 2.0));
        self.width = width;
        self.height = height;
        self.center_on(c);
    }

    /// Centers the viewport on a page point.
    pub fn center_on(&mut self, p: Point) {
        self.x = p.x - self.width / 2.0 / self.zoom;
        self.y = p.y - self.height / 2.0 / self.zoom;
    }

    /// Pans by a screen-space delta (content follows the pointer).
    pub fn pan_by(&mut self, dx: f64, dy: f64) {
        self.x -= dx / self.zoom;
        self.y -= dy / self.zoom;
    }

    /// Zooms to `zoom` keeping the page point under screen point `anchor` fixed.
    pub fn zoom_at(&mut self, zoom: f64, anchor: Point) {
        let z = clamp_zoom(zoom);
        let p = self.to_page(anchor);
        self.zoom = z;
        self.x = p.x - anchor.x / z;
        self.y = p.y - anchor.y / z;
    }

    /// Zooms by a factor about a screen point (wheel / pinch).
    pub fn zoom_by(&mut self, factor: f64, anchor: Point) {
        if factor.is_finite() && factor > 0.0 {
            self.zoom_at(self.zoom * factor, anchor);
        }
    }

    /// Next zoom stop in (`dir` > 0) or out, about the viewport center.
    pub fn step(&mut self, dir: i32) {
        let z = next_stop(self.zoom, dir);
        self.zoom_at(z, Point::new(self.width / 2.0, self.height / 2.0));
    }

    /// Fits a page rect into the viewport with `padding` screen px on each side (never above `max_zoom`).
    pub fn fit(&mut self, r: &Rect, padding: f64, max_zoom: f64) {
        if !(r.w > 0.0 || r.h > 0.0) {
            self.center_on(r.center());
            return;
        }
        // The floating dock is only avoided while the viewport is tall enough to spare the room.
        let inset = if self.height - self.bottom_inset >= 400.0 {
            self.bottom_inset.max(0.0)
        } else {
            0.0
        };
        let aw = (self.width - padding * 2.0).max(40.0);
        let ah = (self.height - inset - padding * 2.0).max(40.0);
        let z = (aw / r.w.max(1e-6)).min(ah / r.h.max(1e-6)).min(max_zoom);
        self.zoom = clamp_zoom(z);
        let c = r.center();
        self.x = c.x - self.width / 2.0 / self.zoom;
        self.y = c.y - (self.height - inset) / 2.0 / self.zoom;
    }

    /// Display percentage ("100%").
    pub fn percent_label(&self) -> String {
        format_zoom(self.zoom)
    }
}

/// Clamps a zoom value.
pub fn clamp_zoom(z: f64) -> f64 {
    if z.is_finite() {
        z.clamp(MIN_ZOOM, MAX_ZOOM)
    } else {
        1.0
    }
}

/// The next stop strictly above (dir > 0) or below the current zoom.
pub fn next_stop(zoom: f64, dir: i32) -> f64 {
    if dir > 0 {
        STOPS
            .iter()
            .copied()
            .find(|s| *s > zoom * 1.0001)
            .unwrap_or(MAX_ZOOM)
    } else {
        STOPS
            .iter()
            .rev()
            .copied()
            .find(|s| *s < zoom / 1.0001)
            .unwrap_or(MIN_ZOOM)
    }
}

/// "100%", "33%", "2%", "1,600%".
pub fn format_zoom(z: f64) -> String {
    let p = (z * 100.0).round() as i64;
    let s = p.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out + "%"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_and_zoom_anchor() {
        let mut c = Camera {
            x: 100.0,
            y: 50.0,
            zoom: 2.0,
            width: 800.0,
            height: 600.0,
            bottom_inset: 0.0,
        };
        let s = Point::new(40.0, 20.0);
        let p = c.to_page(s);
        assert_eq!(p, Point::new(120.0, 60.0));
        assert_eq!(c.to_screen(p), s);
        c.zoom_at(4.0, s);
        assert_eq!(c.to_page(s), p, "anchor stays put");
        c.pan_by(10.0, 0.0);
        assert_eq!(c.x, 120.0 - 10.0 / 4.0 - 40.0 / 4.0);
    }

    #[test]
    fn stops_fit_and_labels() {
        assert_eq!(next_stop(1.0, 1), 1.5);
        assert_eq!(next_stop(1.0, -1), 2.0 / 3.0);
        assert_eq!(next_stop(0.9, 1), 1.0);
        assert_eq!(next_stop(256.0, 1), 256.0);
        let mut c = Camera {
            width: 1000.0,
            height: 500.0,
            ..Default::default()
        };
        c.fit(
            &Rect {
                x: 0.0,
                y: 0.0,
                w: 1080.0,
                h: 1080.0,
            },
            50.0,
            1.0,
        );
        assert!((c.zoom - 400.0 / 1080.0).abs() < 1e-12);
        assert_eq!(
            c.to_screen(Point::new(540.0, 540.0)),
            Point::new(500.0, 250.0)
        );
        assert_eq!(format_zoom(16.0), "1,600%");
        assert_eq!(format_zoom(1.0 / 3.0), "33%");
        c.resize(2000.0, 500.0);
        assert_eq!(
            c.to_screen(Point::new(540.0, 540.0)),
            Point::new(1000.0, 250.0)
        );
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        // Fitting keeps the page clear of the floating tool dock.
        let mut d = Camera {
            width: 1000.0,
            height: 800.0,
            bottom_inset: 100.0,
            ..Default::default()
        };
        let page = Rect {
            x: 0.0,
            y: 0.0,
            w: 1000.0,
            h: 1000.0,
        };
        d.fit(&page, 50.0, 1.0);
        assert!((d.zoom - 0.6).abs() < 1e-12);
        let bottom = d.to_screen(Point::new(0.0, 1000.0)).y;
        assert!((bottom - 650.0).abs() < 1e-9, "{bottom}");
    }
}
