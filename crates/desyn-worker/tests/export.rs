//! Every export format through `POST /v1/render`, multi-page exports, and video via ffmpeg (skipped with a message
//! when ffmpeg / ffprobe are not installed).

mod common;

use common::*;
use serde_json::{Value, json};

async fn render(w: &Worker, body: Value) -> (String, Vec<u8>, reqwest::header::HeaderMap) {
    let res = w.post("/v1/render", &body).await;
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.bytes().await.unwrap().to_vec();
    assert_eq!(
        status,
        200,
        "{}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(400)])
    );
    (
        headers["content-type"].to_str().unwrap().to_string(),
        bytes,
        headers,
    )
}

#[tokio::test]
async fn still_formats() {
    let w = Worker::start(&[]).await;
    let d = fixture("shapes");

    let (ct, b, _) = render(&w, json!({ "design": d, "format": "png", "scale": 0.5 })).await;
    assert_eq!(ct, "image/png");
    let (pw, ph) = png_size(&b);
    assert!(pw > 10 && ph > 10);

    let (ct, b, _) = render(
        &w,
        json!({ "design": d, "format": "jpeg", "quality": 70, "background": "#102030" }),
    )
    .await;
    assert_eq!(ct, "image/jpeg");
    assert_eq!(&b[..3], b"\xff\xd8\xff");

    let (ct, b, _) = render(&w, json!({ "design": d, "format": "webp", "quality": 80 })).await;
    assert_eq!(ct, "image/webp");
    assert_eq!(&b[8..12], b"WEBP");
    // Lossy WebP (libwebp) is smaller than lossless.
    let (_, lossless, _) =
        render(&w, json!({ "design": d, "format": "webp", "quality": 100 })).await;
    assert!(
        b.len() < lossless.len(),
        "lossy {} < lossless {}",
        b.len(),
        lossless.len()
    );

    let (ct, b, _) = render(&w, json!({ "design": d, "format": "svg" })).await;
    assert_eq!(ct, "image/svg+xml");
    let svg = String::from_utf8(b).unwrap();
    assert!(
        svg.starts_with("<svg") || svg.starts_with("<?xml"),
        "{}",
        &svg[..80]
    );
    let (_, outlines, _) = render(
        &w,
        json!({ "design": fixture("text"), "format": "svg", "svgText": "outlines" }),
    )
    .await;
    assert!(!String::from_utf8(outlines).unwrap().contains("<text"));

    // Region + transparent background.
    let (_, b, _) = render(
        &w,
        json!({ "design": d, "format": "png", "region": { "x": 10, "y": 20, "w": 100, "h": 50 }, "scale": 2, "background": "transparent" }),
    )
    .await;
    assert_eq!(png_size(&b), (200, 100));

    // Animation time of a still frame changes the picture.
    let a = fixture("anim");
    let (_, t0, _) = render(&w, json!({ "design": a, "format": "png", "timeMs": 0 })).await;
    let (_, t1, _) = render(&w, json!({ "design": a, "format": "png", "timeMs": 1500 })).await;
    assert_ne!(t0, t1);
}

#[tokio::test]
async fn multi_page_documents() {
    let w = Worker::start(&[]).await;
    let d = two_pages();

    let (ct, pdf, headers) =
        render(&w, json!({ "design": d, "pageId": "all", "format": "pdf" })).await;
    assert_eq!(ct, "application/pdf");
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(headers["x-desyn-pages"], "2");
    let pages = pdf
        .windows(b"/Type /Page".len())
        .filter(|w| *w == b"/Type /Page")
        .count()
        + pdf
            .windows(b"/Type/Page".len())
            .filter(|w| *w == b"/Type/Page")
            .count();
    assert!(pages >= 2, "two page objects ({pages})");

    // Print options.
    let (_, print, _) = render(
        &w,
        json!({ "design": d, "pageId": "all", "format": "pdf", "pdf": { "bleed": true, "cropMarks": true, "cmyk": true } }),
    )
    .await;
    assert!(print.starts_with(b"%PDF-"));
    assert_ne!(print, pdf);

    // One page by id.
    let (_, one, headers) = render(
        &w,
        json!({ "design": d, "pageId": "pagebbbb0002", "format": "pdf" }),
    )
    .await;
    assert_eq!(headers["x-desyn-pages"], "1");
    assert!(one.len() < pdf.len());

    let (ct, pptx, _) = render(
        &w,
        json!({ "design": d, "pageId": "all", "format": "pptx" }),
    )
    .await;
    assert_eq!(
        ct,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    assert_eq!(&pptx[..2], b"PK");
    let text = String::from_utf8_lossy(&pptx);
    assert!(text.contains("ppt/slides/slide2.xml"), "two slides");

    // Raster formats export one page per call.
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": d, "pageId": "all", "format": "png" }),
        )
        .await;
    assert_eq!(res.status(), 400);
    let e: Value = res.json().await.unwrap();
    assert_eq!(e["error"]["code"], "multi_page_unsupported");
    // ...but "all" on a one-page design is fine.
    let (ct, _, _) = render(
        &w,
        json!({ "design": fixture("shapes"), "pageId": "all", "format": "png" }),
    )
    .await;
    assert_eq!(ct, "image/png");
}

fn gif_frames(b: &[u8]) -> usize {
    let mut dec = gif::DecodeOptions::new();
    dec.set_color_output(gif::ColorOutput::RGBA);
    let mut d = dec.read_info(b).unwrap();
    let mut n = 0;
    while d.read_next_frame().unwrap().is_some() {
        n += 1;
    }
    n
}

#[tokio::test]
async fn animated_gif_single_and_multi_page() {
    let w = Worker::start(&[]).await;
    let (ct, b, _) = render(
        &w,
        json!({ "design": fixture("anim"), "format": "gif", "scale": 0.25, "fps": 10 }),
    )
    .await;
    assert_eq!(ct, "image/gif");
    assert_eq!(&b[..6], b"GIF89a");
    assert_eq!(gif_frames(&b), 24, "2.4 s at 10 fps");

    let (_, b, _) = render(
        &w,
        json!({ "design": two_pages(), "pageId": "all", "format": "gif", "fps": 5 }),
    )
    .await;
    assert_eq!(gif_frames(&b), 10, "two 1 s pages at 5 fps");

    // Frame budget.
    let w = Worker::start(&[("WORKER_MAX_FRAME_PIXELS", "100000")]).await;
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": fixture("anim"), "format": "gif" }),
        )
        .await;
    assert_eq!(res.status(), 413);
}

#[tokio::test]
async fn video_exports() {
    if !ffmpeg_available() {
        eprintln!("SKIPPED video_exports: ffmpeg / ffprobe are not installed");
        return;
    }
    let assets = Assets::start().await;
    let w = Worker::start(&[("ASSET_PRIVATE_HOSTS", "127.0.0.1")]).await;

    // MP4 of a two-page timeline (odd frame size: 161 px wide at scale 0.5 -> cropped to even).
    let mut d = two_pages();
    d["nodes"]["pageaaaa0001"]["width"] = json!(322);
    d["nodes"]["pagebbbb0002"]["width"] = json!(322);
    let (ct, mp4, _) = render(
        &w,
        json!({ "design": d, "pageId": "all", "format": "mp4", "scale": 0.5, "fps": 12 }),
    )
    .await;
    assert_eq!(ct, "video/mp4");
    let probe = ffprobe(&mp4, "mp4");
    let streams = probe["streams"].as_array().unwrap();
    assert_eq!(
        streams.len(),
        1,
        "no audio stream without sound nodes: {probe}"
    );
    assert_eq!(streams[0]["codec_name"], "h264");
    assert_eq!(streams[0]["width"], 160);
    assert_eq!(streams[0]["height"], 90);
    assert_eq!(streams[0]["pix_fmt"], "yuv420p");
    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((dur - 2.0).abs() < 0.15, "duration {dur}");

    // Audio node: mixed into AAC.
    let mut d = two_pages();
    d["assets"]["sndtone00001"] =
        json!({ "id": "sndtone00001", "kind": "audio", "mime": "audio/wav" });
    d["nodes"]["audioaaa0001"] = json!({
        "id": "audioaaa0001", "type": "audio", "name": "Tone", "parent": "pageaaaa0001",
        "x": 0, "y": 0, "width": 0, "height": 0, "rotation": 0, "opacity": 1, "blend": "normal",
        "visible": true, "locked": false, "effects": [],
        "assetId": "sndtone00001", "startMs": 200, "trimStartMs": 100, "volume": 0.8, "fadeInMs": 100, "fadeOutMs": 200
    });
    d["nodes"]["pageaaaa0001"]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("audioaaa0001"));
    let body = json!({
        "design": d, "pageId": "all", "format": "mp4", "scale": 0.5, "fps": 10,
        "assetUrls": { "sndtone00001": assets.url("sound.wav") }
    });
    let (_, mp4, _) = render(&w, body.clone()).await;
    let probe = ffprobe(&mp4, "mp4");
    let types: Vec<&str> = probe["streams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["codec_type"].as_str().unwrap())
        .collect();
    assert_eq!(types.len(), 2, "{probe}");
    assert!(types.contains(&"audio"));
    assert!(
        probe["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["codec_name"] == "aac")
    );
    let dur: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (dur - 2.0).abs() < 0.2,
        "audio is padded / cut to the timeline ({dur})"
    );
    // audio: false leaves it out.
    let mut silent = body.clone();
    silent["audio"] = json!(false);
    let (_, mp4, _) = render(&w, silent).await;
    assert_eq!(ffprobe(&mp4, "mp4")["streams"].as_array().unwrap().len(), 1);
    // A broken sound file is skipped instead of failing the export.
    let mut broken = body.clone();
    broken["assetUrls"]["sndtone00001"] = json!(assets.url("photo0000001.jpg"));
    let (_, mp4, _) = render(&w, broken).await;
    assert_eq!(ffprobe(&mp4, "mp4")["streams"].as_array().unwrap().len(), 1);

    // WebM with alpha (transparent background) for one animated page.
    let (ct, webm, _) = render(
        &w,
        json!({ "design": fixture("anim"), "format": "webm", "scale": 0.25, "fps": 10, "background": "transparent", "durationMs": 1000 }),
    )
    .await;
    assert_eq!(ct, "video/webm");
    let probe = ffprobe(&webm, "webm");
    assert_eq!(probe["streams"][0]["codec_name"], "vp9");
    assert!(
        probe["format"]["format_name"]
            .as_str()
            .unwrap()
            .contains("webm")
    );

    // Limits: duration and frame size.
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": fixture("anim"), "format": "mp4", "durationMs": 400000 }),
        )
        .await;
    assert_eq!(
        res.status(),
        400,
        "durationMs above WORKER_MAX_VIDEO_SECONDS"
    );
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": fixture("anim"), "format": "mp4", "scale": 10 }),
        )
        .await;
    assert_eq!(res.status(), 413);
}

#[tokio::test]
async fn video_unavailable_without_ffmpeg() {
    let w = Worker::start(&[("FFMPEG_PATH", "/nonexistent/ffmpeg")]).await;
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": fixture("anim"), "format": "mp4" }),
        )
        .await;
    assert_eq!(res.status(), 501);
    let e: Value = res.json().await.unwrap();
    assert_eq!(e["error"]["code"], "video_unavailable");
    let ready: Value = w.get("/readyz").await.json().await.unwrap();
    assert!(ready["video"].is_null());
}
