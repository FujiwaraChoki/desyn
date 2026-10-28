//! Embeds `assets/icons/*.svg` into the binary (the GPUI asset source serves them as `icons/<name>.svg`).

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("icons");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("assets/icons exists")
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".svg"))
        .collect();
    names.sort();
    let mut out = String::from(
        "/// Embedded icons: (`icons/<file>`, bytes).\npub static ICONS: &[(&str, &[u8])] = &[\n",
    );
    for n in &names {
        let path = dir.join(n);
        writeln!(
            out,
            "    (\"icons/{n}\", include_bytes!({:?})),",
            path.display().to_string()
        )
        .expect("write");
    }
    out.push_str("];\n");
    let dest = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("icons.rs");
    std::fs::write(dest, out).expect("write icons.rs");
}
