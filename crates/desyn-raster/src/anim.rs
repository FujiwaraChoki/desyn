//! Timeline evaluation of `Animation` presets (entrance / exit / loop) with easing, used for animated exports
//! (GIF, frame sequences for MP4, presentation previews).
//!
//! Semantics per phase (times in ms, `p` = eased progress 0..1 of `startMs .. startMs + durationMs`):
//! * `in`: before the start the node rests in the preset's initial pose (e.g. transparent), then animates to its
//!   designed state and stays there.
//! * `out`: the node is in its designed state until the start, animates to the exit pose and stays hidden after.
//! * `loop`: from the start the preset repeats with period `durationMs` (emphasis presets pulse / float / shake /
//!   rotate have dedicated loops; other presets ping-pong their entrance).
//!
//! Several animations on one node compose (opacity and scale multiply, offsets / rotation / blur add, reveals take
//! the minimum). Without a time (static renders) every node shows its designed state.

use std::f64::consts::PI;

use desyn_core::geometry::{Affine, Point};
use desyn_core::model::{Animation, AnimationPhase, AnimationPreset, Design, Easing, Node};

/// Evaluated animation pose of a node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnimState {
    /// Opacity multiplier.
    pub opacity: f64,
    /// Horizontal offset (design px).
    pub dx: f64,
    /// Vertical offset.
    pub dy: f64,
    /// Scale about the node center.
    pub scale: f64,
    /// Extra rotation about the center (degrees, clockwise).
    pub rotate: f64,
    /// Extra layer blur radius (px).
    pub blur: f64,
    /// Visible fraction of the node from the left (wipe).
    pub wipe: Option<f64>,
    /// Visible fraction of text (typewriter).
    pub typewriter: Option<f64>,
}

impl Default for AnimState {
    fn default() -> Self {
        AnimState::IDENTITY
    }
}

impl AnimState {
    /// No change.
    pub const IDENTITY: AnimState = AnimState {
        opacity: 1.0,
        dx: 0.0,
        dy: 0.0,
        scale: 1.0,
        rotate: 0.0,
        blur: 0.0,
        wipe: None,
        typewriter: None,
    };

    /// True when the pose changes nothing.
    pub fn is_identity(&self) -> bool {
        *self == AnimState::IDENTITY
    }

    /// True when the node draws nothing in this pose.
    pub fn is_hidden(&self) -> bool {
        self.opacity <= 1e-4
            || self.scale.abs() <= 1e-6
            || self.wipe.is_some_and(|w| w <= 0.0)
            || self.typewriter.is_some_and(|t| t <= 0.0)
    }

    /// Transform applied in the node's parent space before its own local transform: offset, then rotation and
    /// scale about the box center (`w x h`) of a node whose local transform is `local`.
    pub fn transform(&self, local: &Affine, w: f64, h: f64) -> Affine {
        if self.dx == 0.0 && self.dy == 0.0 && self.scale == 1.0 && self.rotate == 0.0 {
            return Affine::IDENTITY;
        }
        let c = local.apply(Point::new(w / 2.0, h / 2.0));
        Affine::translate(self.dx, self.dy)
            * Affine::translate(c.x, c.y)
            * Affine::rotate_deg(self.rotate)
            * Affine::scale(self.scale, self.scale)
            * Affine::translate(-c.x, -c.y)
    }

    fn compose(&mut self, o: &AnimState) {
        self.opacity *= o.opacity;
        self.dx += o.dx;
        self.dy += o.dy;
        self.scale *= o.scale;
        self.rotate += o.rotate;
        self.blur += o.blur;
        self.wipe = min_opt(self.wipe, o.wipe);
        self.typewriter = min_opt(self.typewriter, o.typewriter);
    }
}

fn min_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

/// Sizes the presets scale their motion by.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnimContext {
    /// Page width.
    pub page_w: f64,
    /// Page height.
    pub page_h: f64,
}

impl AnimContext {
    fn travel(&self) -> f64 {
        (self.page_w.min(self.page_h) * 0.06).max(12.0)
    }

    fn slide(&self) -> f64 {
        (self.page_w * 0.12).max(24.0)
    }
}

fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    // Solve x(t) = x with Newton iterations, falling back to bisection.
    let bx =
        |t: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * x1 + 3.0 * (1.0 - t) * t * t * x2 + t * t * t;
    let by =
        |t: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * y1 + 3.0 * (1.0 - t) * t * t * y2 + t * t * t;
    let dx = |t: f64| {
        3.0 * (1.0 - t) * (1.0 - t) * x1
            + 6.0 * (1.0 - t) * t * (x2 - x1)
            + 3.0 * t * t * (1.0 - x2)
    };
    let mut t = x;
    for _ in 0..8 {
        let err = bx(t) - x;
        if err.abs() < 1e-7 {
            return by(t);
        }
        let d = dx(t);
        if d.abs() < 1e-6 {
            break;
        }
        t = (t - err / d).clamp(0.0, 1.0);
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    t = x;
    for _ in 0..40 {
        let v = bx(t);
        if (v - x).abs() < 1e-7 {
            break;
        }
        if v < x {
            lo = t;
        } else {
            hi = t;
        }
        t = (lo + hi) / 2.0;
    }
    by(t)
}

/// Applies an easing curve to linear progress `p` (0..1).
pub fn ease(e: Easing, p: f64) -> f64 {
    let p = p.clamp(0.0, 1.0);
    if p <= 0.0 || p >= 1.0 {
        return p;
    }
    match e {
        Easing::Linear => p,
        Easing::Ease => cubic_bezier(0.25, 0.1, 0.25, 1.0, p),
        Easing::EaseIn => cubic_bezier(0.42, 0.0, 1.0, 1.0, p),
        Easing::EaseOut => cubic_bezier(0.0, 0.0, 0.58, 1.0, p),
        Easing::EaseInOut => cubic_bezier(0.42, 0.0, 0.58, 1.0, p),
        Easing::Spring => 1.0 - (-6.0 * p).exp() * (9.0 * p).cos(),
    }
}

fn back_out(p: f64) -> f64 {
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    1.0 + c3 * (p - 1.0).powi(3) + c1 * (p - 1.0).powi(2)
}

fn entrance(preset: AnimationPreset, p: f64, cx: &AnimContext) -> AnimState {
    let mut s = AnimState::IDENTITY;
    let q = 1.0 - p;
    match preset {
        AnimationPreset::None => {}
        AnimationPreset::Fade => s.opacity = p,
        AnimationPreset::Rise => {
            s.dy = q * cx.travel();
            s.opacity = p;
        }
        AnimationPreset::Drop => {
            s.dy = -q * cx.travel();
            s.opacity = p;
        }
        AnimationPreset::SlideLeft => {
            s.dx = q * cx.slide();
            s.opacity = p;
        }
        AnimationPreset::SlideRight => {
            s.dx = -q * cx.slide();
            s.opacity = p;
        }
        AnimationPreset::ZoomIn => {
            s.scale = 0.6 + 0.4 * p;
            s.opacity = p;
        }
        AnimationPreset::ZoomOut => {
            s.scale = 1.4 - 0.4 * p;
            s.opacity = p;
        }
        AnimationPreset::Pop => {
            s.scale = back_out(p).max(0.0);
            s.opacity = (p * 3.0).min(1.0);
        }
        AnimationPreset::Rotate => {
            s.rotate = -90.0 * q;
            s.scale = 0.8 + 0.2 * p;
            s.opacity = p;
        }
        AnimationPreset::Wipe => s.wipe = Some(p),
        AnimationPreset::Typewriter => s.typewriter = Some(p),
        AnimationPreset::Pulse => {
            s.scale = back_out(p).max(0.0);
            s.opacity = p;
        }
        AnimationPreset::Float => {
            s.dy = q * cx.travel() * 0.5;
            s.opacity = p;
        }
        AnimationPreset::Shake => {
            s.dx = (p * PI * 6.0).sin() * q * cx.travel() * 0.3;
            s.opacity = (p * 4.0).min(1.0);
        }
        AnimationPreset::BlurIn => {
            s.blur = q * 24.0;
            s.opacity = p;
        }
    }
    s
}

fn exit(preset: AnimationPreset, p: f64, cx: &AnimContext) -> AnimState {
    let mut s = AnimState::IDENTITY;
    let q = 1.0 - p;
    match preset {
        AnimationPreset::None => {}
        AnimationPreset::Rise => {
            s.dy = -p * cx.travel();
            s.opacity = q;
        }
        AnimationPreset::Drop => {
            s.dy = p * cx.travel();
            s.opacity = q;
        }
        AnimationPreset::SlideLeft => {
            s.dx = -p * cx.slide();
            s.opacity = q;
        }
        AnimationPreset::SlideRight => {
            s.dx = p * cx.slide();
            s.opacity = q;
        }
        AnimationPreset::ZoomIn => {
            s.scale = 1.0 + 0.4 * p;
            s.opacity = q;
        }
        AnimationPreset::ZoomOut => {
            s.scale = 1.0 - 0.4 * p;
            s.opacity = q;
        }
        AnimationPreset::Pop => {
            s.scale = if p < 0.2 {
                1.0 + 0.5 * p
            } else {
                1.1 * (1.0 - (p - 0.2) / 0.8)
            };
            s.opacity = q;
        }
        AnimationPreset::Rotate => {
            s.rotate = 90.0 * p;
            s.scale = 1.0 - 0.2 * p;
            s.opacity = q;
        }
        AnimationPreset::Wipe => s.wipe = Some(q),
        AnimationPreset::Typewriter => s.typewriter = Some(q),
        AnimationPreset::BlurIn => {
            s.blur = p * 24.0;
            s.opacity = q;
        }
        AnimationPreset::Fade
        | AnimationPreset::Pulse
        | AnimationPreset::Float
        | AnimationPreset::Shake => s.opacity = q,
    }
    s
}

fn looped(preset: AnimationPreset, phase: f64, easing: Easing, cx: &AnimContext) -> AnimState {
    let mut s = AnimState::IDENTITY;
    let wave = 0.5 - 0.5 * (2.0 * PI * phase).cos();
    match preset {
        AnimationPreset::None => {}
        AnimationPreset::Pulse => s.scale = 1.0 + 0.06 * wave,
        AnimationPreset::Float => s.dy = -cx.travel() * 0.25 * (2.0 * PI * phase).sin(),
        AnimationPreset::Shake => s.dx = (2.0 * PI * phase * 4.0).sin() * cx.travel() * 0.12,
        AnimationPreset::Rotate => s.rotate = 360.0 * ease(easing, phase),
        AnimationPreset::Fade => s.opacity = 1.0 - 0.6 * wave,
        other => {
            let p = 1.0 - (2.0 * phase - 1.0).abs();
            s = entrance(other, ease(easing, p), cx);
        }
    }
    s
}

/// Pose of one animation at `t_ms`.
pub fn evaluate_one(a: &Animation, t_ms: f64, cx: &AnimContext) -> AnimState {
    let dur = if a.duration_ms.is_finite() && a.duration_ms > 0.0 {
        a.duration_ms
    } else {
        1.0
    };
    let start = if a.start_ms.is_finite() {
        a.start_ms
    } else {
        0.0
    };
    let lin = ((t_ms - start) / dur).clamp(0.0, 1.0);
    match a.phase {
        AnimationPhase::In => entrance(a.preset, ease(a.easing, lin), cx),
        AnimationPhase::Out => {
            if t_ms < start {
                AnimState::IDENTITY
            } else {
                exit(a.preset, ease(a.easing, lin), cx)
            }
        }
        AnimationPhase::Loop => {
            if t_ms < start {
                AnimState::IDENTITY
            } else {
                let phase = ((t_ms - start) / dur).rem_euclid(1.0);
                looped(a.preset, phase, a.easing, cx)
            }
        }
    }
}

/// Combined pose of a node's animations at `t_ms` (`None` time = designed state).
pub fn evaluate(anims: &[Animation], t_ms: Option<f64>, cx: &AnimContext) -> AnimState {
    let Some(t) = t_ms else {
        return AnimState::IDENTITY;
    };
    let mut s = AnimState::IDENTITY;
    for a in anims {
        s.compose(&evaluate_one(a, t, cx));
    }
    s
}

/// Default page duration when neither the page nor its animations define one.
pub const DEFAULT_PAGE_MS: f64 = 5000.0;

/// Duration of a page on the timeline: `durationMs`, else the end of its last entrance / exit animation (at
/// least 1 s), else [`DEFAULT_PAGE_MS`].
pub fn page_duration(design: &Design, page: &str) -> f64 {
    if let Some(Node::Page(p)) = design.node(page)
        && let Some(d) = p.duration_ms
        && d.is_finite()
        && d > 0.0
    {
        return d;
    }
    let mut end: f64 = 0.0;
    let mut any = false;
    design.walk(page, &mut |n, _| {
        for a in n.base().anim.iter().flatten() {
            if a.phase != AnimationPhase::Loop
                && a.start_ms.is_finite()
                && a.duration_ms.is_finite()
            {
                end = end.max(a.start_ms + a.duration_ms);
                any = true;
            }
        }
        true
    });
    if any {
        (end + 500.0).max(1000.0)
    } else {
        DEFAULT_PAGE_MS
    }
}

/// True when any node of the page has animations.
pub fn page_is_animated(design: &Design, page: &str) -> bool {
    let mut any = false;
    design.walk(page, &mut |n, _| {
        if n.base().anim.as_ref().is_some_and(|a| !a.is_empty()) {
            any = true;
            return false;
        }
        true
    });
    any
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anim(preset: &str, phase: &str, start: f64, dur: f64, easing: &str) -> Animation {
        serde_json::from_value(serde_json::json!({
            "id": "a00000000001", "preset": preset, "phase": phase, "startMs": start, "durationMs": dur, "easing": easing
        }))
        .unwrap()
    }

    const CX: AnimContext = AnimContext {
        page_w: 1000.0,
        page_h: 1000.0,
    };

    #[test]
    fn easing_curves() {
        for e in Easing::ALL {
            assert_eq!(ease(*e, 0.0), 0.0);
            assert_eq!(ease(*e, 1.0), 1.0);
        }
        assert!((ease(Easing::Linear, 0.3) - 0.3).abs() < 1e-12);
        assert!(ease(Easing::EaseIn, 0.3) < 0.3);
        assert!(ease(Easing::EaseOut, 0.3) > 0.3);
        assert!((ease(Easing::EaseInOut, 0.5) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn phases() {
        let fade_in = [anim("fade", "in", 1000.0, 1000.0, "linear")];
        assert_eq!(evaluate(&fade_in, Some(0.0), &CX).opacity, 0.0);
        assert!((evaluate(&fade_in, Some(1500.0), &CX).opacity - 0.5).abs() < 1e-9);
        assert_eq!(evaluate(&fade_in, Some(5000.0), &CX), AnimState::IDENTITY);
        assert_eq!(evaluate(&fade_in, None, &CX), AnimState::IDENTITY);
        let out = [anim("slide-left", "out", 0.0, 1000.0, "linear")];
        assert_eq!(evaluate(&out, Some(-1.0), &CX), AnimState::IDENTITY);
        let s = evaluate(&out, Some(1000.0), &CX);
        assert!(s.is_hidden() && s.dx < 0.0);
        let lp = [anim("rotate", "loop", 0.0, 1000.0, "linear")];
        assert!((evaluate(&lp, Some(250.0), &CX).rotate - 90.0).abs() < 1e-9);
        assert!((evaluate(&lp, Some(1250.0), &CX).rotate - 90.0).abs() < 1e-9);
        let both = [
            anim("fade", "in", 0.0, 1000.0, "linear"),
            anim("rise", "in", 0.0, 1000.0, "linear"),
        ];
        let s = evaluate(&both, Some(500.0), &CX);
        assert!((s.opacity - 0.25).abs() < 1e-9 && s.dy > 0.0);
        let tw = [anim("typewriter", "in", 0.0, 1000.0, "linear")];
        assert_eq!(evaluate(&tw, Some(400.0), &CX).typewriter, Some(0.4));
    }

    #[test]
    fn transform_about_center() {
        let s = AnimState {
            scale: 2.0,
            ..AnimState::IDENTITY
        };
        let t = s.transform(&Affine::translate(10.0, 10.0), 20.0, 20.0);
        let p = t.apply(Point::new(20.0, 20.0));
        assert!((p.x - 20.0).abs() < 1e-9 && (p.y - 20.0).abs() < 1e-9);
    }
}
