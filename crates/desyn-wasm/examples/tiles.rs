//! Times progressive rendering of a fixture: `cargo run --release --example tiles -- social 0.68 2`.
use desyn_wasm::EngineCore;
use desyn_wasm::protocol::{RenderRequest, ViewportSpec};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).map_or("social", String::as_str);
    let zoom: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.68);
    let dpr: f64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/fixtures/render");
    let mut e = EngineCore::new(&[1; 32]);
    for f in desyn_text::font::bundled::fonts() {
        e.set_font(f.bytes, Some(f.family)).unwrap();
    }
    e.load(&std::fs::read_to_string(format!("{dir}/{name}.json")).unwrap())
        .unwrap();
    for entry in std::fs::read_dir(format!("{dir}/assets")).unwrap() {
        let p = entry.unwrap().path();
        let id = p.file_stem().unwrap().to_str().unwrap().to_string();
        if e.design().assets.contains_key(&id) {
            e.set_asset(&id, &std::fs::read(&p).unwrap()).unwrap();
        }
    }
    for (label, budget) in [("cold full", None), ("tiles", Some(0.001))] {
        let req = RenderRequest {
            viewport: Some(ViewportSpec {
                x: 0.0,
                y: 0.0,
                zoom,
                width: 2880,
                height: 1800,
                dpr,
            }),
            background: Some("#0e0e0e".into()),
            page_shadow: true,
            budget_ms: budget,
            hidden: std::env::var("HIDE")
                .map(|h| h.split(',').map(String::from).collect())
                .unwrap_or_default(),
            force: true,
            ..Default::default()
        };
        let mut calls = Vec::new();
        loop {
            let t = std::time::Instant::now();
            let info = e
                .render(&RenderRequest {
                    force: calls.is_empty(),
                    ..req.clone()
                })
                .unwrap();
            calls.push(t.elapsed().as_secs_f64() * 1000.0);
            if info.pending == 0 {
                break;
            }
        }
        let total: f64 = calls.iter().sum();
        println!(
            "{label}: {} calls, total {total:.1} ms, first {:.1} ms, rest {:?}",
            calls.len(),
            calls[0],
            calls
                .iter()
                .skip(1)
                .take(8)
                .map(|c| (c * 10.0).round() / 10.0)
                .collect::<Vec<_>>()
        );
    }
}
