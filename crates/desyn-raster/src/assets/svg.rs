//! Sanitized SVG parsing (usvg).
//!
//! usvg never runs scripts, ignores `foreignObject` and event attributes, and only produces a render tree. On top
//! of that the parser here refuses every external reference: `href`s that are not `data:` URLs resolve to nothing
//! (no file or network access), there is no resources directory, and inputs are size-limited.

use std::sync::Arc;

/// Largest accepted SVG document (bytes, before decompression).
pub const MAX_SVG_BYTES: usize = 8 << 20;

/// Parses SVG bytes (or gzip-compressed SVGZ) into a usvg tree, resolving `<text>` with `fontdb`.
pub fn parse_svg(data: &[u8], fontdb: Arc<usvg::fontdb::Database>) -> Result<usvg::Tree, String> {
    if data.len() > MAX_SVG_BYTES {
        return Err("svg too large".into());
    }
    let opt = usvg::Options {
        resources_dir: None,
        fontdb,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            // Plain strings would be file paths: never resolve them.
            resolve_string: Box::new(|_href: &str, _opts: &usvg::Options| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_data(data, &opt).map_err(|e| e.to_string())?;
    let size = tree.size();
    if !(size.width() > 0.0 && size.height() > 0.0) {
        return Err("svg has no size".into());
    }
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_references_are_dropped() {
        let db = Arc::new(usvg::fontdb::Database::new());
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">
            <script>alert(1)</script>
            <image xlink:href="/etc/passwd" width="10" height="10"/>
            <image xlink:href="https://example.com/x.png" width="10" height="10"/>
            <rect width="10" height="10" fill="#ff0000" onclick="alert(1)"/>
        </svg>"##;
        let tree = parse_svg(svg, db.clone()).unwrap();
        assert_eq!(tree.root().children().len(), 1);
        assert!(matches!(tree.root().children()[0], usvg::Node::Path(_)));
        assert!(parse_svg(b"<not svg", db.clone()).is_err());
        let huge = vec![b' '; MAX_SVG_BYTES + 1];
        assert!(parse_svg(&huge, db).is_err());
    }
}
