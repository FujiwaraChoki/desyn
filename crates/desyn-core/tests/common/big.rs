//! A 10k-node design for performance tests and benches.

use desyn_core::*;

pub const BIG_PAGE: &str = "page00000001";

/// 1 page, 100 frames (10 x 10 grid, 100 x 100 px, clipping) with 99 children each (rects, ellipses, texts,
/// rotated shapes) = 10,002 nodes including root and page. Half of the frames use auto-layout.
pub fn big_design() -> Design {
    let mut d = Design::with_page(
        "design000001",
        "Big",
        DesignKind::Poster,
        BIG_PAGE,
        2000.0,
        2000.0,
    );
    for f in 0..100u32 {
        let fid = format!("f{f:011}");
        let mut frame = Node::frame(
            &fid,
            "Frame",
            (f % 10) as f64 * 200.0,
            (f / 10) as f64 * 200.0,
            150.0,
            150.0,
        );
        if f % 2 == 0
            && let Node::Frame(fr) = &mut frame
        {
            fr.container.layout = Some(AutoLayout {
                mode: LayoutMode::Grid,
                gap: 2.0,
                row_gap: None,
                padding: [4.0, 4.0, 4.0, 4.0],
                main_align: MainAlign::Start,
                cross_align: CrossAlign::Start,
                wrap: None,
                columns: Some(11),
                reverse: None,
                extra: Default::default(),
            });
        }
        d.push_child(BIG_PAGE, frame);
        for c in 0..99u32 {
            let id = format!("c{f:05}{c:06}");
            let (x, y) = ((c % 11) as f64 * 13.0, (c / 11) as f64 * 13.0);
            let mut n = match c % 4 {
                0 => Node::rect(&id, "r", x, y, 10.0, 10.0),
                1 => Node::ellipse(&id, "e", x, y, 10.0, 10.0),
                2 => Node::text(&id, "Hi", x, y, Some(12.0)),
                _ => Node::star(&id, "s", 5, 0.4, x, y, 10.0, 10.0),
            };
            if c % 7 == 0 {
                n.base_mut().rotation = 30.0;
            }
            d.push_child(&fid, n);
        }
    }
    d
}

/// 10,000 shapes directly on one page (no containers): the worst case for linear hit testing.
pub fn flat_design() -> Design {
    let mut d = Design::with_page(
        "design000002",
        "Flat",
        DesignKind::Poster,
        BIG_PAGE,
        4000.0,
        4000.0,
    );
    for i in 0..10_000u32 {
        let id = format!("s{i:011}");
        let (x, y) = ((i % 100) as f64 * 40.0, (i / 100) as f64 * 40.0);
        let mut n = if i % 3 == 0 {
            Node::ellipse(&id, "e", x, y, 30.0, 30.0)
        } else {
            Node::rect(&id, "r", x, y, 30.0, 30.0)
        };
        if i % 11 == 0 {
            n.base_mut().rotation = 15.0;
        }
        d.push_child(BIG_PAGE, n);
    }
    d
}
