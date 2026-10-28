//! The app icon: the Desyn sun drawn by the app's own renderer (a Desyn design rendered with desyn-raster), so
//! the X11 window icon and the packaged icon sizes (`desyn --write-icons <dir>`) need no image files.

use std::path::Path;

use desyn_core::model::Design;
use desyn_raster::{PageRenderOptions, Renderer};

/// The icon as a Desyn design (512 × 512 page, transparent): a sun disc with the brand gradient on a dark
/// rounded tile.
pub fn icon_design() -> Design {
    let json = r##"{
      "schema": 1, "id": "desynappicon", "name": "Desyn", "kind": "logo",
      "assets": {}, "meta": {},
      "styles": {"colors": {}, "text": {}, "effects": {}, "variables": {}},
      "nodes": {
        "root": {"id": "root", "type": "root", "name": "root", "parent": null, "x": 0, "y": 0, "width": 0, "height": 0,
                 "rotation": 0, "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [],
                 "children": ["iconpage0001"]},
        "iconpage0001": {"id": "iconpage0001", "type": "page", "name": "Icon", "parent": "root", "x": 0, "y": 0,
                 "width": 512, "height": 512, "rotation": 0, "opacity": 1, "blend": "normal", "visible": true,
                 "locked": false, "effects": [], "children": ["icontile0001", "iconsun00001"], "clip": true,
                 "unit": "px", "background": [], "bleed": 0},
        "icontile0001": {"id": "icontile0001", "type": "rect", "name": "Tile", "parent": "iconpage0001",
                 "x": 32, "y": 32, "width": 448, "height": 448, "rotation": 0, "opacity": 1, "blend": "normal",
                 "visible": true, "locked": false, "effects": [],
                 "fills": [{"type": "linear", "angle": 160, "stops": [{"pos": 0, "color": "#1c1712"}, {"pos": 1, "color": "#0a0a0a"}]}],
                 "strokes": [{"fills": [{"type": "solid", "color": "#ffb02e", "opacity": 0.18}], "width": 4, "align": "inside", "cap": "butt", "join": "miter"}],
                 "cornerRadius": 104, "cornerSmoothing": 0.6},
        "iconsun00001": {"id": "iconsun00001", "type": "ellipse", "name": "Sun", "parent": "iconpage0001",
                 "x": 140, "y": 140, "width": 232, "height": 232, "rotation": 0, "opacity": 1, "blend": "normal",
                 "visible": true, "locked": false,
                 "effects": [{"type": "glow", "radius": 56, "strength": 0.9, "color": "#ffb02e"}],
                 "fills": [{"type": "linear", "angle": 135, "stops": [{"pos": 0, "color": "#ffd66b"}, {"pos": 0.5, "color": "#ffb02e"}, {"pos": 1, "color": "#ff6a1f"}]}],
                 "strokes": [], "cornerRadius": 0}
      }
    }"##;
    Design::from_json(json).expect("icon design is valid")
}

/// Renders the icon at `size` px (straight-alpha RGBA).
pub fn render(size: u32) -> Option<image::RgbaImage> {
    let mut r = Renderer::empty();
    let opts = PageRenderOptions {
        page: Some("iconpage0001".into()),
        scale: size as f64 / 512.0,
        transparent: true,
        ..Default::default()
    };
    let page = r.render_page(&icon_design(), &opts).ok()?;
    let rgba = desyn_raster::export::bitmap::pixmap_rgba(&page.pixmap);
    image::RgbaImage::from_raw(page.pixmap.width(), page.pixmap.height(), rgba)
}

/// Writes `desyn-<size>.png` for the usual desktop icon sizes (packaging).
pub fn write_icons(dir: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    std::fs::create_dir_all(dir)?;
    let mut out = Vec::new();
    for size in [16u32, 24, 32, 48, 64, 128, 256, 512, 1024] {
        let img = render(size).ok_or_else(|| std::io::Error::other("render failed"))?;
        let p = dir.join(format!("desyn-{size}.png"));
        img.save(&p).map_err(std::io::Error::other)?;
        out.push(p);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_sun() {
        let img = render(64).expect("icon");
        assert_eq!(img.dimensions(), (64, 64));
        assert_eq!(img.get_pixel(0, 0)[3], 0, "transparent corner");
        let c = img.get_pixel(32, 32);
        assert!(
            c[0] > 200 && c[1] > 120 && c[3] == 255,
            "sun at the center: {c:?}"
        );
        assert!(desyn_core::model::validate_design(&icon_design()).is_empty());
    }
}
