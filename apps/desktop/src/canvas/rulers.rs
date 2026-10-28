//! Ruler ticks: "nice" intervals (1 / 2 / 5 × 10ⁿ design px) so labels never crowd, in the page unit's numbers.

/// Thickness of the rulers in screen px.
pub const RULER: f64 = 20.0;

/// One tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tick {
    /// Screen position along the ruler (px from the canvas edge).
    pub screen: f64,
    /// Page coordinate.
    pub value: f64,
    /// Major ticks carry a label.
    pub major: bool,
}

/// Design px per display unit.
pub fn unit_factor(unit: &str) -> f64 {
    match unit {
        "mm" => 96.0 / 25.4,
        "in" => 96.0,
        "pt" => 96.0 / 72.0,
        _ => 1.0,
    }
}

/// Major tick spacing in design px for a zoom so majors are at least `min_px` apart on screen.
pub fn major_step(zoom: f64, unit: &str, min_px: f64) -> f64 {
    let f = unit_factor(unit);
    let mut step = 1e-3;
    for _ in 0..40 {
        for m in [1.0, 2.0, 5.0] {
            let s = step * m;
            if s * f * zoom >= min_px {
                return s * f;
            }
        }
        step *= 10.0;
    }
    1e6
}

/// Ticks along one axis. `origin` = page coordinate at screen 0, `length` = ruler length in screen px.
pub fn ticks(origin: f64, zoom: f64, length: f64, unit: &str) -> Vec<Tick> {
    let major = major_step(zoom, unit, 64.0);
    let minor = major / 5.0;
    let start = (origin / minor).floor() as i64;
    let end = ((origin + length / zoom) / minor).ceil() as i64;
    let mut out = Vec::with_capacity((end - start).max(0) as usize + 1);
    for i in start..=end {
        let value = i as f64 * minor;
        out.push(Tick {
            screen: (value - origin) * zoom,
            value,
            major: i.rem_euclid(5) == 0,
        });
    }
    out
}

/// Label for a ruler value in the page unit (no unit suffix, trimmed decimals).
pub fn label(value: f64, unit: &str) -> String {
    let v = value / unit_factor(unit);
    let r = (v * 100.0).round() / 100.0;
    if (r - r.round()).abs() < 1e-9 {
        format!("{}", r.round() as i64)
    } else {
        format!("{r}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_scale_with_zoom() {
        assert_eq!(major_step(1.0, "px", 64.0), 100.0);
        assert_eq!(major_step(2.0, "px", 64.0), 50.0);
        assert_eq!(major_step(0.1, "px", 64.0), 1000.0);
        assert_eq!(major_step(64.0, "px", 64.0), 1.0);
        assert!((major_step(1.0, "mm", 64.0) - 20.0 * 96.0 / 25.4).abs() < 1e-9);
    }

    #[test]
    fn tick_positions() {
        let t = ticks(-50.0, 1.0, 300.0, "px");
        let majors: Vec<f64> = t.iter().filter(|t| t.major).map(|t| t.value).collect();
        assert_eq!(majors, vec![0.0, 100.0, 200.0]);
        let zero = t.iter().find(|t| t.value == 0.0).unwrap();
        assert_eq!(zero.screen, 50.0);
        assert_eq!(label(96.0 * 2.5, "in"), "2.5");
        assert_eq!(label(-20.0, "px"), "-20");
    }
}
