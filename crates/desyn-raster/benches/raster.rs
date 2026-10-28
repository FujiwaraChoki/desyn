//! Criterion benches of the render paths: `cargo bench --bench raster`.
//! Budgets (asserted in `tests/perf.rs`): 1080x1080 social design < 8 ms, moved-rect damage redraw < 2 ms.

use std::path::Path;

use criterion::{Criterion, criterion_group, criterion_main};
use desyn_core::geometry::Affine;
use desyn_core::model::Design;
use desyn_raster::display::BuildOptions;
use desyn_raster::export::{self, ExportOptions, Format, SvgText};
use desyn_raster::tiny_skia::Pixmap;
use desyn_raster::{DirAssetStore, RasterOptions, Renderer};
use desyn_text::TextEngine;

fn fixture(name: &str) -> Design {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../spec/fixtures/render/{name}.json"));
    Design::from_json(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn renderer() -> Renderer {
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render/assets");
    Renderer::new(
        TextEngine::with_bundled_fonts(),
        Box::new(DirAssetStore::new(assets)),
    )
}

fn bench_render(c: &mut Criterion) {
    let mut r = renderer();
    for name in ["social", "charts", "effects", "text"] {
        let d = fixture(name);
        let opts = BuildOptions::default();
        let dl = r.build(&d, &opts).unwrap();
        let (w, h) = (dl.width.ceil() as u32, dl.height.ceil() as u32);
        let mut pix = Pixmap::new(w, h).unwrap();
        let ro = RasterOptions::new(Affine::IDENTITY);
        r.rasterize(&dl, &mut pix.as_mut(), &ro);
        r.rasterize(&dl, &mut pix.as_mut(), &ro);
        c.bench_function(&format!("build/{name}/warm"), |b| {
            b.iter(|| r.build(&d, &opts).unwrap())
        });
        c.bench_function(&format!("rasterize/{name}/warm"), |b| {
            b.iter(|| r.rasterize(&dl, &mut pix.as_mut(), &ro))
        });
        c.bench_function(&format!("rasterize/{name}/cold"), |b| {
            b.iter(|| desyn_raster::rasterize(&dl, &mut pix.as_mut(), &ro, None))
        });
    }
}

fn bench_export(c: &mut Criterion) {
    let mut r = renderer();
    let d = fixture("social");
    for (format, label) in [
        (Format::Png, "png"),
        (Format::Svg, "svg"),
        (Format::Pdf, "pdf"),
        (Format::Pptx, "pptx"),
    ] {
        let o = ExportOptions {
            format,
            svg_text: SvgText::Outlines,
            ..ExportOptions::default()
        };
        c.bench_function(&format!("export/social/{label}"), |b| {
            b.iter(|| export::export(&mut r, &d, &o).unwrap())
        });
    }
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20);
    targets = bench_render, bench_export
}
criterion_main!(benches);
