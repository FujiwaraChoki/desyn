//! CSS Fonts Level 4 font matching (§5.2) over the faces of one family.
//!
//! Faces are narrowed by `font-stretch`, then `font-style`, then `font-weight`. Variable faces take part with
//! their axis ranges: a request inside a range matches exactly at the requested value, otherwise the nearest end of
//! the range competes with the other faces using the CSS preference order.

use super::face::{FaceInfo, FaceStyle, FontId};

/// Requested font style.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StyleQuery {
    /// Upright.
    Normal,
    /// Italic.
    Italic,
    /// Oblique at an angle in degrees (positive leans right).
    Oblique(f32),
}

/// What the matcher looks for inside one family.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MatchRequest {
    /// CSS weight 1..1000.
    pub weight: f32,
    /// Style.
    pub style: StyleQuery,
    /// Width in percent (100 = normal).
    pub stretch: f32,
}

impl Default for MatchRequest {
    fn default() -> Self {
        MatchRequest {
            weight: 400.0,
            style: StyleQuery::Normal,
            stretch: 100.0,
        }
    }
}

/// Outcome of matching one family.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceMatch {
    /// Chosen face.
    pub face: FontId,
    /// Weight to render at (inside the face's range).
    pub weight: f32,
    /// Width to render at.
    pub stretch: f32,
    /// Render italic through the `ital` axis.
    pub use_ital_axis: bool,
    /// Render oblique through the `slnt` axis at this value.
    pub slnt: Option<f32>,
    /// The face is lighter than requested by a bold step: embolden synthetically.
    pub synthetic_bold: bool,
    /// The face is upright but italic / oblique was requested: slant synthetically.
    pub synthetic_italic: bool,
}

fn narrow<'a>(
    faces: Vec<&'a FaceInfo>,
    desired: f32,
    range: impl Fn(&FaceInfo) -> (f32, f32),
    order: &[Side],
) -> Vec<&'a FaceInfo> {
    if faces.len() <= 1 {
        return faces;
    }
    let exact: Vec<_> = faces
        .iter()
        .copied()
        .filter(|f| {
            let (lo, hi) = range(f);
            lo <= desired && desired <= hi
        })
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    for side in order {
        let best = match side {
            Side::Below(limit) => faces
                .iter()
                .map(|f| range(f).1)
                .filter(|hi| *hi < desired && *hi >= *limit)
                .fold(None, |acc: Option<f32>, v| {
                    Some(acc.map_or(v, |a| a.max(v)))
                }),
            Side::Above(limit) => faces
                .iter()
                .map(|f| range(f).0)
                .filter(|lo| *lo > desired && *lo <= *limit)
                .fold(None, |acc: Option<f32>, v| {
                    Some(acc.map_or(v, |a| a.min(v)))
                }),
        };
        if let Some(best) = best {
            return faces
                .iter()
                .copied()
                .filter(|f| match side {
                    Side::Below(_) => range(f).1 == best,
                    Side::Above(_) => range(f).0 == best,
                })
                .collect();
        }
    }
    faces
}

#[derive(Clone, Copy)]
enum Side {
    /// Values below the desired one, at least `limit`; nearest first.
    Below(f32),
    /// Values above the desired one, at most `limit`; nearest first.
    Above(f32),
}

const LOWEST: f32 = f32::NEG_INFINITY;
const HIGHEST: f32 = f32::INFINITY;

fn style_rank(face: &FaceInfo, style: StyleQuery) -> u8 {
    // Lower is better. CSS: italic -> italic, oblique, normal; oblique -> oblique, italic, normal;
    // normal -> normal, oblique, italic.
    let (italic, oblique, normal) = (
        face.can_be_italic(),
        face.can_be_oblique(),
        face.can_be_normal(),
    );
    let order: [bool; 3] = match style {
        StyleQuery::Italic => [italic, oblique, normal],
        StyleQuery::Oblique(_) => [oblique, italic, normal],
        StyleQuery::Normal => [normal, oblique, italic],
    };
    order.iter().position(|ok| *ok).map_or(3, |p| p as u8)
}

/// Picks the best face for `req` among `faces` (all of one family). Returns `None` for an empty slice.
pub fn match_faces(faces: &[&FaceInfo], req: &MatchRequest) -> Option<FaceMatch> {
    if faces.is_empty() {
        return None;
    }
    let stretch = if req.stretch.is_finite() {
        req.stretch.clamp(50.0, 200.0)
    } else {
        100.0
    };
    let weight = if req.weight.is_finite() {
        req.weight.clamp(1.0, 1000.0)
    } else {
        400.0
    };
    let mut set: Vec<&FaceInfo> = faces.to_vec();

    // 1. font-stretch.
    let stretch_order = if stretch <= 100.0 {
        [Side::Below(LOWEST), Side::Above(HIGHEST)]
    } else {
        [Side::Above(HIGHEST), Side::Below(LOWEST)]
    };
    set = narrow(set, stretch, |f| f.stretch_range, &stretch_order);

    // 2. font-style.
    let best_rank = set
        .iter()
        .map(|f| style_rank(f, req.style))
        .min()
        .unwrap_or(3);
    set.retain(|f| style_rank(f, req.style) == best_rank);

    // 3. font-weight.
    let weight_order: Vec<Side> = if (400.0..=500.0).contains(&weight) {
        vec![
            Side::Above(500.0),
            Side::Below(LOWEST),
            Side::Above(HIGHEST),
        ]
    } else if weight < 400.0 {
        vec![Side::Below(LOWEST), Side::Above(HIGHEST)]
    } else {
        vec![Side::Above(HIGHEST), Side::Below(LOWEST)]
    };
    set = narrow(set, weight, |f| f.weight_range, &weight_order);

    // Ties (duplicate registrations): the earliest registered face wins.
    let face = set.into_iter().min_by_key(|f| f.id)?;
    let render_weight = weight.clamp(face.weight_range.0, face.weight_range.1);
    let render_stretch = stretch.clamp(face.stretch_range.0, face.stretch_range.1);
    let wants_slant = !matches!(req.style, StyleQuery::Normal);
    let static_slanted = matches!(face.style, FaceStyle::Italic | FaceStyle::Oblique(_));
    let use_ital_axis = matches!(req.style, StyleQuery::Italic | StyleQuery::Oblique(_))
        && face.ital_range.is_some_and(|(_, hi)| hi >= 1.0)
        && !static_slanted;
    let slnt = match (req.style, face.slnt_range) {
        (StyleQuery::Oblique(angle), Some((lo, hi))) if !use_ital_axis => {
            Some((-angle).clamp(lo, hi))
        }
        (StyleQuery::Italic, Some((lo, hi))) if !use_ital_axis && !static_slanted && lo < 0.0 => {
            Some((-14.0f32).clamp(lo, hi))
        }
        _ => None,
    };
    let synthetic_italic = wants_slant && !static_slanted && !use_ital_axis && slnt.is_none();
    // CSS font-synthesis-weight: synthesize when bold (>= 600) is requested and the face renders <= 500.
    let synthetic_bold = weight >= 600.0 && render_weight <= 500.0;
    Some(FaceMatch {
        face: face.id,
        weight: render_weight,
        stretch: render_stretch,
        use_ital_axis,
        slnt,
        synthetic_bold,
        synthetic_italic,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::font::face::ColorSupport;

    fn face(id: u32, weight: (f32, f32), style: FaceStyle, stretch: f32) -> FaceInfo {
        FaceInfo {
            id: FontId(id),
            family: "Test".into(),
            aliases: vec![],
            subfamily: String::new(),
            full_name: String::new(),
            postscript_name: None,
            weight: weight.0,
            weight_range: weight,
            stretch,
            stretch_range: (stretch, stretch),
            style,
            ital_range: None,
            slnt_range: None,
            opsz_range: None,
            axes: vec![],
            named_instances: vec![],
            units_per_em: 1000,
            ascent: 800.0,
            descent: 200.0,
            line_gap: 0.0,
            x_height: None,
            cap_height: None,
            monospace: false,
            color: ColorSupport::default(),
            glyph_count: 1,
            collection_index: 0,
        }
    }

    fn pick(faces: &[FaceInfo], weight: f32, style: StyleQuery) -> (u32, FaceMatch) {
        let refs: Vec<&FaceInfo> = faces.iter().collect();
        let m = match_faces(
            &refs,
            &MatchRequest {
                weight,
                style,
                stretch: 100.0,
            },
        )
        .unwrap();
        (m.face.0, m)
    }

    #[test]
    fn weight_rules_follow_css() {
        let faces: Vec<FaceInfo> = [100.0, 300.0, 600.0, 900.0]
            .iter()
            .enumerate()
            .map(|(i, w)| face(i as u32, (*w, *w), FaceStyle::Normal, 100.0))
            .collect();
        // 400 (in 400..=500): no face up to 500 above, so lighter first -> 300.
        assert_eq!(pick(&faces, 400.0, StyleQuery::Normal).0, 1);
        // 500: same -> 300.
        assert_eq!(pick(&faces, 500.0, StyleQuery::Normal).0, 1);
        // 700 (> 500): heavier first -> 900.
        assert_eq!(pick(&faces, 700.0, StyleQuery::Normal).0, 3);
        // 950: nothing heavier -> 900.
        assert_eq!(pick(&faces, 950.0, StyleQuery::Normal).0, 3);
        // 200 (< 400): lighter first -> 100.
        assert_eq!(pick(&faces, 200.0, StyleQuery::Normal).0, 0);
        // 50: nothing lighter -> 100.
        assert_eq!(pick(&faces, 50.0, StyleQuery::Normal).0, 0);
        // 450 with a 500 face present: heavier up to 500 wins.
        let mut f2 = faces.clone();
        f2.push(face(4, (500.0, 500.0), FaceStyle::Normal, 100.0));
        assert_eq!(pick(&f2, 450.0, StyleQuery::Normal).0, 4);
    }

    #[test]
    fn style_and_synthesis() {
        let faces = vec![
            face(0, (400.0, 400.0), FaceStyle::Normal, 100.0),
            face(1, (700.0, 700.0), FaceStyle::Normal, 100.0),
            face(2, (400.0, 400.0), FaceStyle::Italic, 100.0),
        ];
        let (id, m) = pick(&faces, 700.0, StyleQuery::Italic);
        // Style narrows first: only the italic face remains, and it is lighter -> synthetic bold.
        assert_eq!(id, 2);
        assert!(m.synthetic_bold && !m.synthetic_italic);
        let (id, m) = pick(&faces[..2], 400.0, StyleQuery::Italic);
        assert_eq!(id, 0);
        assert!(m.synthetic_italic);
        let (id, m) = pick(&faces, 700.0, StyleQuery::Normal);
        assert_eq!(id, 1);
        assert!(!m.synthetic_bold);
    }

    #[test]
    fn variable_ranges_match_exactly() {
        let mut vf = face(0, (100.0, 900.0), FaceStyle::Normal, 100.0);
        vf.ital_range = Some((0.0, 1.0));
        let faces = vec![vf];
        let (_, m) = pick(&faces, 650.0, StyleQuery::Italic);
        assert_eq!(m.weight, 650.0);
        assert!(m.use_ital_axis && !m.synthetic_italic && !m.synthetic_bold);
        let (_, m) = pick(&faces, 1000.0, StyleQuery::Normal);
        assert_eq!(m.weight, 900.0);
    }

    #[test]
    fn stretch_prefers_narrower_for_normal_and_below() {
        let faces = [
            face(0, (400.0, 400.0), FaceStyle::Normal, 75.0),
            face(1, (400.0, 400.0), FaceStyle::Normal, 125.0),
        ];
        let refs: Vec<&FaceInfo> = faces.iter().collect();
        let m = match_faces(
            &refs,
            &MatchRequest {
                stretch: 100.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(m.face, FontId(0));
        let m = match_faces(
            &refs,
            &MatchRequest {
                stretch: 110.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(m.face, FontId(1));
    }
}
