//! Resize constraints (left / right / center / stretch / scale).

use crate::model::{Constraints, HConstraint, VConstraint};

/// New `(x, y, width, height)` of a child box with `constraints` when its parent is resized from `old` to `new`
/// (`(width, height)` pairs). Sizes never go below zero.
pub fn constrain_box(
    c: &Constraints,
    child: (f64, f64, f64, f64),
    old: (f64, f64),
    new: (f64, f64),
) -> (f64, f64, f64, f64) {
    let (x, w) = axis(
        match c.h {
            HConstraint::Left => Mode::Start,
            HConstraint::Right => Mode::End,
            HConstraint::Center => Mode::Center,
            HConstraint::Stretch => Mode::Stretch,
            HConstraint::Scale => Mode::Scale,
        },
        child.0,
        child.2,
        old.0,
        new.0,
    );
    let (y, h) = axis(
        match c.v {
            VConstraint::Top => Mode::Start,
            VConstraint::Bottom => Mode::End,
            VConstraint::Center => Mode::Center,
            VConstraint::Stretch => Mode::Stretch,
            VConstraint::Scale => Mode::Scale,
        },
        child.1,
        child.3,
        old.1,
        new.1,
    );
    (x, y, w, h)
}

enum Mode {
    Start,
    End,
    Center,
    Stretch,
    Scale,
}

fn axis(mode: Mode, pos: f64, size: f64, old: f64, new: f64) -> (f64, f64) {
    let delta = new - old;
    match mode {
        Mode::Start => (pos, size),
        Mode::End => (pos + delta, size),
        Mode::Center => (pos + delta / 2.0, size),
        Mode::Stretch => {
            let s = size + delta;
            if s >= 0.0 { (pos, s) } else { (pos, 0.0) }
        }
        Mode::Scale => {
            if old > 0.0 {
                let k = new / old;
                (pos * k, (size * k).max(0.0))
            } else {
                (pos, size)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_modes() {
        let c = |h, v| Constraints {
            h,
            v,
            extra: Default::default(),
        };
        let child = (10.0, 20.0, 30.0, 40.0);
        let old = (100.0, 100.0);
        let new = (200.0, 50.0);
        assert_eq!(
            constrain_box(&c(HConstraint::Left, VConstraint::Top), child, old, new),
            (10.0, 20.0, 30.0, 40.0)
        );
        assert_eq!(
            constrain_box(&c(HConstraint::Right, VConstraint::Bottom), child, old, new),
            (110.0, -30.0, 30.0, 40.0)
        );
        assert_eq!(
            constrain_box(
                &c(HConstraint::Center, VConstraint::Center),
                child,
                old,
                new
            ),
            (60.0, -5.0, 30.0, 40.0)
        );
        assert_eq!(
            constrain_box(
                &c(HConstraint::Stretch, VConstraint::Stretch),
                child,
                old,
                new
            ),
            (10.0, 20.0, 130.0, 0.0)
        );
        assert_eq!(
            constrain_box(&c(HConstraint::Scale, VConstraint::Scale), child, old, new),
            (20.0, 10.0, 60.0, 20.0)
        );
    }
}
