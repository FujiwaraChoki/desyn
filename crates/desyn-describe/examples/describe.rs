//! Describe a design file from the command line.
//!
//! ```sh
//! cargo run --example describe -- design.json              # compact text (2000 token budget)
//! cargo run --example describe -- design.json --json       # full Description JSON
//! cargo run --example describe -- design.json --tokens 800 --page <pageId>
//! ```
//! Accepts a `Design` or a fixture file (`{ "design": ..., "options": ... }`). Uses the bundled fonts.

use desyn_describe::{CompactOptions, DescribeOptions, compact_text, describe};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: describe <design.json> [--json] [--tokens N] [--page ID] [--summary]");
        std::process::exit(2);
    };
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON");
    let (design_v, opts_v) = match value.get("design") {
        Some(d) => (
            d.clone(),
            value
                .get("options")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        None => (value, serde_json::Value::Null),
    };
    let design: desyn_core::Design = serde_json::from_value(design_v).expect("design");
    let mut opts: DescribeOptions = if opts_v.is_null() {
        DescribeOptions::default()
    } else {
        serde_json::from_value(opts_v).expect("options")
    };
    let flag = |name: &str| args.iter().position(|a| a == name);
    if let Some(i) = flag("--page") {
        opts.page_id = args.get(i + 1).cloned();
    }
    if flag("--summary").is_some() {
        opts.detail = desyn_describe::Detail::Summary;
    }
    let tokens = flag("--tokens")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);
    let mut engine = desyn_text::TextEngine::with_bundled_fonts();
    let desc = describe(&design, &opts, &mut engine, None).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    if flag("--json").is_some() {
        println!("{}", serde_json::to_string_pretty(&desc).expect("json"));
    } else {
        println!(
            "{}",
            compact_text(
                &desc,
                &CompactOptions {
                    max_tokens: tokens,
                    ..Default::default()
                }
            )
        );
    }
}
