//! QR codes (qrcode crate): background, square modules merged into runs, or rounded dots with rounded finder
//! patterns. A one-module quiet zone is kept inside the node box.

use std::sync::Arc;

use desyn_core::model::{BlendMode, QrErrorCorrection, QrNode};
use desyn_core::paths::kurbo::{self, BezPath, Shape as _};

use super::build::DisplayListBuilder;
use super::{FillItem, FillRule, Item};
use crate::geom::{bez_to_path, path_bounds};
use crate::paint::{Color4, Paint};

/// Largest payload encoded (QR version 40 holds at most 2953 bytes).
const MAX_QR_BYTES: usize = 2953;

fn fill(path: BezPath, color: Color4, rule: FillRule) -> Option<Item> {
    let p = bez_to_path(&path)?;
    Some(Item::Fill(FillItem {
        bounds: path_bounds(&p),
        path: Arc::new(p),
        rule,
        paint: Paint::Solid(color),
        opacity: 1.0,
        blend: BlendMode::Normal,
    }))
}

/// Dark-module matrix of `data` (row-major, `n x n`).
pub(super) fn qr_matrix(data: &str, ec: QrErrorCorrection) -> Result<(usize, Vec<bool>), String> {
    if data.len() > MAX_QR_BYTES {
        return Err("qr data too long".into());
    }
    let level = match ec {
        QrErrorCorrection::L => qrcode::EcLevel::L,
        QrErrorCorrection::M => qrcode::EcLevel::M,
        QrErrorCorrection::Q => qrcode::EcLevel::Q,
        QrErrorCorrection::H => qrcode::EcLevel::H,
    };
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), level)
        .map_err(|e| e.to_string())?;
    let n = code.width();
    let m = code
        .to_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Ok((n, m))
}

fn in_finder(n: usize, x: usize, y: usize) -> bool {
    (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
}

impl DisplayListBuilder<'_> {
    /// Items of a QR node.
    pub(super) fn qr_items(&mut self, q: &QrNode) -> Vec<Item> {
        let (w, h) = (q.base.width.max(0.0), q.base.height.max(0.0));
        if !(w > 0.0 && h > 0.0) {
            return Vec::new();
        }
        let fg = Color4::from_color(&q.fg);
        let bg = Color4::from_color(&q.bg);
        let mut out = Vec::new();
        out.extend(fill(
            kurbo::Rect::new(0.0, 0.0, w, h).to_path(0.1),
            bg,
            FillRule::Nonzero,
        ));
        let (n, m) = match qr_matrix(&q.data, q.error_correction) {
            Ok(v) => v,
            Err(e) => {
                self.warn(format!("qr: {e}"));
                return out;
            }
        };
        let side = w.min(h);
        let cell = side / (n as f64 + 2.0);
        let ox = (w - side) / 2.0 + cell;
        let oy = (h - side) / 2.0 + cell;
        let dark = |x: usize, y: usize| m[y * n + x];
        let mut modules = BezPath::new();
        if q.rounded && n >= 21 {
            for (fx, fy) in [(0, 0), (n - 7, 0), (0, n - 7)] {
                let (x0, y0) = (ox + fx as f64 * cell, oy + fy as f64 * cell);
                let ring_outer =
                    kurbo::RoundedRect::new(x0, y0, x0 + 7.0 * cell, y0 + 7.0 * cell, 2.2 * cell);
                let ring_inner = kurbo::RoundedRect::new(
                    x0 + cell,
                    y0 + cell,
                    x0 + 6.0 * cell,
                    y0 + 6.0 * cell,
                    1.5 * cell,
                );
                let mut ring = ring_outer.to_path(0.05);
                ring.extend(ring_inner.to_path(0.05));
                out.extend(fill(ring, fg, FillRule::EvenOdd));
                let eye = kurbo::RoundedRect::new(
                    x0 + 2.0 * cell,
                    y0 + 2.0 * cell,
                    x0 + 5.0 * cell,
                    y0 + 5.0 * cell,
                    1.0 * cell,
                );
                modules.extend(eye.to_path(0.05));
            }
            for y in 0..n {
                for x in 0..n {
                    if dark(x, y) && !in_finder(n, x, y) {
                        let c = kurbo::Circle::new(
                            (ox + (x as f64 + 0.5) * cell, oy + (y as f64 + 0.5) * cell),
                            cell * 0.46,
                        );
                        modules.extend(c.to_path(0.05));
                    }
                }
            }
        } else {
            for y in 0..n {
                let mut x = 0;
                while x < n {
                    if !dark(x, y) {
                        x += 1;
                        continue;
                    }
                    let start = x;
                    while x < n && dark(x, y) {
                        x += 1;
                    }
                    modules.extend(
                        kurbo::Rect::new(
                            ox + start as f64 * cell,
                            oy + y as f64 * cell,
                            ox + x as f64 * cell,
                            oy + (y + 1) as f64 * cell,
                        )
                        .to_path(0.1),
                    );
                }
            }
        }
        out.extend(fill(modules, fg, FillRule::Nonzero));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes() {
        let (n, m) = qr_matrix("https://desyn.app", QrErrorCorrection::M).unwrap();
        assert!(n >= 21);
        assert_eq!(m.len(), n * n);
        assert!(m[0], "finder corner is dark");
        assert!(qr_matrix(&"x".repeat(5000), QrErrorCorrection::H).is_err());
    }
}
