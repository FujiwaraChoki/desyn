//! `desyn-render` command line tests (built with the `cli` feature).
#![cfg(feature = "cli")]

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/fixtures/render")
}

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_desyn-render"))
}

/// A scratch directory per test (tests in one binary run in parallel).
fn scratch(test: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("desyn-render-test-{}-{test}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn renders_every_format() {
    let dir = scratch("formats");
    let input = fixtures().join("social.json");
    let assets = fixtures().join("assets");
    for (ext, magic) in [
        ("png", &b"\x89PNG"[..]),
        ("jpg", &[0xff, 0xd8, 0xff][..]),
        ("webp", &b"RIFF"[..]),
        ("svg", &b"<svg"[..]),
        ("pdf", &b"%PDF"[..]),
        ("pptx", &b"PK"[..]),
    ] {
        let out = dir.join(format!("social.{ext}"));
        let st = bin()
            .args([
                input.to_str().unwrap(),
                "--assets",
                assets.to_str().unwrap(),
                "--scale",
                "0.5",
                "-o",
            ])
            .arg(&out)
            .arg("--info")
            .output()
            .unwrap();
        assert!(
            st.status.success(),
            "{ext}: {}",
            String::from_utf8_lossy(&st.stderr)
        );
        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.starts_with(magic), "{ext}");
        let info: serde_json::Value = serde_json::from_slice(st.stderr.trim_ascii()).unwrap();
        assert_eq!(info["missingAssets"].as_array().unwrap().len(), 0, "{ext}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn frames_gif_stdin_and_errors() {
    let input = fixtures().join("anim.json");
    let root = scratch("frames");
    let dir = root.join("frames");
    let st = bin()
        .args([
            input.to_str().unwrap(),
            "--format",
            "frames",
            "--fps",
            "5",
            "--scale",
            "0.25",
            "-o",
        ])
        .arg(&dir)
        .status()
        .unwrap();
    assert!(st.success());
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("frames.json")).unwrap()).unwrap();
    assert_eq!(manifest["frames"].as_array().unwrap().len(), 12);
    assert!(dir.join("frame-00001.png").exists());

    let gif = root.join("anim.gif");
    assert!(
        bin()
            .args([
                input.to_str().unwrap(),
                "--fps",
                "4",
                "--scale",
                "0.25",
                "-o"
            ])
            .arg(&gif)
            .status()
            .unwrap()
            .success()
    );
    assert!(std::fs::read(&gif).unwrap().starts_with(b"GIF89a"));

    // Design from stdin (worker request body shape), PNG to stdout.
    let body = format!(
        r#"{{"design": {}}}"#,
        std::fs::read_to_string(fixtures().join("shapes.json")).unwrap()
    );
    let mut child = bin()
        .args(["-", "--format", "png"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.starts_with(b"\x89PNG"));

    let bad = bin()
        .args([input.to_str().unwrap(), "--scale", "nope"])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
    let missing = bin().args(["/definitely/not/here.json"]).output().unwrap();
    assert_eq!(missing.status.code(), Some(1));
    let page = bin()
        .args([input.to_str().unwrap(), "--page", "nosuchpage00", "-o"])
        .arg(root.join("x.png"))
        .output()
        .unwrap();
    assert_eq!(page.status.code(), Some(3));
    let _ = std::fs::remove_dir_all(root);
}
