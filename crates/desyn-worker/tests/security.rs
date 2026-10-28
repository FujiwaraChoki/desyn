//! Hostile inputs from authenticated callers: malformed node graphs that would make tree walks explode, and media
//! files that try to make ffmpeg read other resources.

mod common;

use std::time::Duration;

use common::*;
use serde_json::{Value, json};

fn group(id: &str, parent: &str, children: &[&str]) -> Value {
    json!({
        "id": id, "type": "group", "name": id, "parent": parent,
        "x": 0, "y": 0, "width": 10, "height": 10, "rotation": 0,
        "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": [],
        "children": children, "clip": false
    })
}

/// A page whose groups list their only child twice, 48 levels deep: a walk that follows child lists without a
/// visited set makes 2^48 visits.
fn exploding_design() -> Value {
    let depth = 48;
    let ids: Vec<String> = (0..depth).map(|i| format!("grp{i:09}")).collect();
    let mut kids = Vec::new();
    for i in 0..depth {
        let parent = if i == 0 {
            "pageaaaa0001".to_string()
        } else {
            ids[i - 1].clone()
        };
        let children: Vec<&str> = if i + 1 < depth {
            vec![ids[i + 1].as_str(), ids[i + 1].as_str()]
        } else {
            vec!["rectaaaa0001"]
        };
        kids.push(group(&ids[i], &parent, &children));
    }
    kids.push(rect(
        "rectaaaa0001",
        &ids[depth - 1],
        10.0,
        10.0,
        50.0,
        50.0,
        "#ffb02e",
    ));
    let p = page("pageaaaa0001", 200.0, 120.0, "#0f0d1f", &[ids[0].as_str()]);
    design("explode00001", vec![(p, kids)])
}

#[tokio::test]
async fn shared_or_cyclic_child_lists_are_refused_quickly() {
    let w = Worker::start(&[]).await;
    let d = exploding_design();
    let started = std::time::Instant::now();
    for (path, body) in [
        ("/v1/render", json!({ "design": d, "format": "png" })),
        ("/v1/thumbnail", json!({ "design": d })),
        ("/v1/describe", json!({ "design": d })),
        ("/v1/layout", json!({ "design": d })),
        (
            "/v1/apply",
            json!({ "design": d, "tx": { "id": "txaaaaaa0001", "label": "x", "ops": [], "source": "user", "ts": 0 } }),
        ),
    ] {
        let res = tokio::time::timeout(Duration::from_secs(20), w.post(path, &body))
            .await
            .unwrap_or_else(|_| panic!("{path} did not answer: the walk exploded"));
        assert_eq!(res.status(), 422, "{path}");
        let e: Value = res.json().await.unwrap();
        assert_eq!(e["error"]["code"], "invalid_design", "{path}: {e}");
    }
    assert!(started.elapsed() < Duration::from_secs(20));

    // A child listed under two parents (diamond) and a cycle through a page's subtree.
    let mut diamond = two_pages();
    diamond["nodes"]["pagebbbb0002"]["children"] = json!(["rectbbbb0002", "rectaaaa0001"]);
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": diamond, "format": "png" }),
            422,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_design");
    let mut cycle = two_pages();
    cycle["nodes"]["grpcycle0001"] = group("grpcycle0001", "pageaaaa0001", &["pageaaaa0001"]);
    cycle["nodes"]["pageaaaa0001"]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("grpcycle0001"));
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": cycle, "format": "png" }),
            422,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_design");
    // A cycle detached from root is refused too (a describe selection could start a walk inside it).
    let mut detached = two_pages();
    detached["nodes"]["grpdetach001"] = group("grpdetach001", "grpdetach002", &["grpdetach002"]);
    detached["nodes"]["grpdetach002"] = group("grpdetach002", "grpdetach001", &["grpdetach001"]);
    let e = w
        .post_json(
            "/v1/describe",
            &json!({ "design": detached, "selection": ["grpdetach001"] }),
            422,
        )
        .await;
    assert!(
        e["error"]["message"].as_str().unwrap().contains("cycle"),
        "{e}"
    );

    // Minor inconsistencies still render (pages with parent null, as in the raster fixtures; a detached node).
    let mut loose = two_pages();
    loose["nodes"]["pageaaaa0001"]["parent"] = Value::Null;
    loose["nodes"]["rectdetach01"] = rect(
        "rectdetach01",
        "nosuchparent",
        0.0,
        0.0,
        10.0,
        10.0,
        "#ffffff",
    );
    let res = w
        .post("/v1/render", &json!({ "design": loose, "format": "png" }))
        .await;
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["x-desyn-warnings"].to_str().unwrap() != "0",
        "the inconsistency is reported"
    );
}

#[tokio::test]
async fn sound_files_cannot_make_ffmpeg_open_other_resources() {
    if !ffmpeg_available() {
        eprintln!(
            "SKIPPED sound_files_cannot_make_ffmpeg_open_other_resources: ffmpeg is not installed"
        );
        return;
    }
    let assets = Assets::start().await;
    let w = Worker::start(&[("ASSET_PRIVATE_HOSTS", "127.0.0.1")]).await;
    let mut d = two_pages();
    d["assets"]["sndtone00001"] =
        json!({ "id": "sndtone00001", "kind": "audio", "mime": "audio/wav" });
    d["nodes"]["audioaaa0001"] = json!({
        "id": "audioaaa0001", "type": "audio", "name": "Tone", "parent": "pageaaaa0001",
        "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "opacity": 1, "blend": "normal",
        "visible": true, "locked": false, "effects": [], "assetId": "sndtone00001", "startMs": 0, "trimStartMs": 0, "volume": 1
    });
    d["nodes"]["pageaaaa0001"]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("audioaaa0001"));
    // A local media file that a manifest could name (ffmpeg's DASH demuxer reads absolute file:// segments by
    // default, so without confinement another file on the worker's disk would end up in the export's sound).
    let dir = temp_dir("local-media");
    let local = dir.join("private.m4a");
    let made = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=d=1",
            "-c:a",
            "aac",
            "-y",
        ])
        .arg(&local)
        .status()
        .unwrap();
    assert!(made.success());
    let local_mpd = format!("{}/local.mpd?{}", assets.base, local.display());
    // Manifests / session descriptions / concat lists that point ffmpeg at local files or other hosts are not
    // sounds.
    for url in [
        local_mpd,
        assets.url("manifest.mpd"),
        assets.url("session.sdp"),
        assets.url("list.ffconcat"),
    ] {
        let name = url.clone();
        let body = json!({
            "design": d, "pageId": "all", "format": "mp4", "scale": 0.25, "fps": 5,
            "assetUrls": { "sndtone00001": url }
        });
        let res = w.post("/v1/render", &body).await;
        let status = res.status();
        let mp4 = res.bytes().await.unwrap();
        assert_eq!(
            status,
            200,
            "{name}: {}",
            String::from_utf8_lossy(&mp4[..mp4.len().min(300)])
        );
        let probe = ffprobe(&mp4, "mp4");
        assert_eq!(
            probe["streams"].as_array().unwrap().len(),
            1,
            "{name} is skipped: {probe}"
        );
    }
    assert_eq!(
        assets.hits.get("leak"),
        0,
        "ffmpeg never followed a reference"
    );
    let _ = std::fs::remove_dir_all(&dir);
    // A real sound still mixes in.
    let body = json!({
        "design": d, "pageId": "all", "format": "mp4", "scale": 0.25, "fps": 5,
        "assetUrls": { "sndtone00001": assets.url("sound.wav") }
    });
    let res = w.post("/v1/render", &body).await;
    assert_eq!(res.status(), 200);
    let probe = ffprobe(&res.bytes().await.unwrap(), "mp4");
    assert_eq!(probe["streams"].as_array().unwrap().len(), 2, "{probe}");
}

#[tokio::test]
async fn tiny_video_frames_are_refused_up_front() {
    if !ffmpeg_available() {
        eprintln!("SKIPPED tiny_video_frames_are_refused_up_front: ffmpeg is not installed");
        return;
    }
    let w = Worker::start(&[]).await;
    let mut d = two_pages();
    d["nodes"]["pageaaaa0001"]["height"] = json!(1);
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": d, "format": "mp4", "scale": 1 }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_options");
}
