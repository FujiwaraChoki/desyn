//! Asset fetching policy (allowlist, SSRF guard, redirects, size caps) and fonts (custom font assets, Google Fonts
//! on demand with disk cache and remembered misses).

mod common;

use common::*;
use serde_json::{Value, json};

/// Renders the social fixture with the photo at `url`, strict, and returns the failure reason (or "ok").
async fn photo_result(w: &Worker, url: &str) -> String {
    let body = json!({
        "design": fixture("social"), "format": "png", "scale": 0.1, "strictAssets": true,
        "assetUrls": { "photo0000001": url, "icon00000001": url }
    });
    let res = w.post("/v1/render", &body).await;
    if res.status() == 200 {
        return "ok".into();
    }
    let status = res.status().as_u16();
    let e: Value = res.json().await.unwrap();
    assert_eq!(e["error"]["code"], "asset_fetch_failed", "{e}");
    let reason = e["error"]["details"]["failed"][0]["reason"]
        .as_str()
        .unwrap()
        .to_string();
    let message = e["error"]["details"]["failed"][0]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        !message.contains("X-Amz-Signature"),
        "signed query strings never appear in errors: {message}"
    );
    format!("{status}:{reason}")
}

#[tokio::test]
async fn ssrf_guard_blocks_private_targets() {
    let assets = Assets::start().await;
    let port = assets.port;
    // Allowlist that would match everything: the address checks must still refuse private targets.
    let w = Worker::start(&[("ASSET_HOST_ALLOWLIST", "*"), ("ASSET_ALLOW_HTTP", "true")]).await;
    for url in [
        format!("http://127.0.0.1:{port}/a/photo0000001.jpg"),
        format!("http://[::1]:{port}/a/photo0000001.jpg"),
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/".to_string(),
        "http://10.0.0.1/x.png".to_string(),
        "http://2130706433/x.png".to_string(),
        "http://[::ffff:127.0.0.1]/x.png".to_string(),
    ] {
        assert_eq!(photo_result(&w, &url).await, "422:blocked", "{url}");
    }
    // A public name resolving to loopback is refused at resolution time (no DNS-rebinding window).
    assert_eq!(
        photo_result(
            &w,
            &format!("http://localhost:{port}/a/photo0000001.jpg?X-Amz-Signature=secret")
        )
        .await,
        "422:blocked"
    );
    assert_eq!(
        assets.hits.total.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "nothing reached the server"
    );
    // Schemes other than http(s).
    for url in [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
    ] {
        assert_eq!(photo_result(&w, url).await, "422:blocked", "{url}");
    }
    assert_eq!(photo_result(&w, "not a url").await, "422:invalid_url");
}

#[tokio::test]
async fn allowlist_scheme_and_redirects() {
    let assets = Assets::start().await;
    let port = assets.port;
    let photo = format!("http://127.0.0.1:{port}/a/photo0000001.jpg");

    // Default policy: S3 hosts over https only.
    let w = Worker::start(&[]).await;
    assert_eq!(photo_result(&w, &photo).await, "422:blocked");
    assert_eq!(
        photo_result(&w, "https://example.com/photo.jpg").await,
        "422:blocked"
    );

    // A private host explicitly allowed (self-hosted MinIO on a compose network): plain http works.
    let w = Worker::start(&[
        ("ASSET_HOST_ALLOWLIST", "minio.internal"),
        ("ASSET_PRIVATE_HOSTS", "127.0.0.1"),
    ])
    .await;
    assert_eq!(photo_result(&w, &photo).await, "ok");

    // Redirects are re-checked: from the allowed private host to a host that is not allowed.
    let to = format!("http://localhost:{port}/a/photo0000001.jpg");
    let redirect = format!("http://127.0.0.1:{port}/redirect?to={to}");
    assert_eq!(photo_result(&w, &redirect).await, "422:blocked");
    // ...and redirects inside the allowed set are followed.
    let redirect = format!("http://127.0.0.1:{port}/redirect?to={photo}");
    assert_eq!(photo_result(&w, &redirect).await, "ok");

    // Per-asset size cap (the photo is ~40 KB).
    let w = Worker::start(&[
        ("ASSET_PRIVATE_HOSTS", "127.0.0.1"),
        ("ASSET_MAX_BYTES", "2048"),
    ])
    .await;
    assert_eq!(
        photo_result(&w, &format!("http://127.0.0.1:{port}/big")).await,
        "422:too_large"
    );
    // Upstream errors are retryable (502).
    let w = Worker::start(&[("ASSET_PRIVATE_HOSTS", "127.0.0.1")]).await;
    assert_eq!(
        photo_result(&w, &format!("http://127.0.0.1:{port}/a/missing.jpg")).await,
        "502:status"
    );
}

fn measure_body(family: &str, text: &str, assets: Value, urls: Value) -> Value {
    json!({
        "items": [{ "text": [{ "text": text }], "style": text_style(family, 40.0), "paragraph": paragraph() }],
        "assets": assets, "assetUrls": urls
    })
}

async fn width(w: &Worker, body: &Value) -> f64 {
    w.post_json("/v1/measure", body, 200).await["sizes"][0]["w"]
        .as_f64()
        .unwrap()
}

#[tokio::test]
async fn custom_font_assets_shape_text_per_request() {
    let assets = Assets::start().await;
    let w = Worker::start(&[("ASSET_PRIVATE_HOSTS", "127.0.0.1")]).await;
    let font_assets = json!({ "fntbrand0001": {
        "id": "fntbrand0001", "kind": "font", "mime": "font/woff2", "family": "Brand Face", "weight": 400, "style": "normal"
    }});
    let with = measure_body(
        "Brand Face",
        "Brand headline",
        font_assets.clone(),
        json!({ "fntbrand0001": assets.url("brand.woff2") }),
    );
    let without = measure_body("Brand Face", "Brand headline", json!({}), json!({}));
    let a = width(&w, &with).await;
    let b = width(&w, &without).await;
    assert!(
        (a - b).abs() > 1.0,
        "the custom font changes the measurement ({a} vs {b})"
    );
    // Fonts never leak into the next request (fresh engine per request).
    assert_eq!(width(&w, &without).await, b);
    assert_eq!(assets.hits.get("asset:brand.woff2"), 1);

    // The same font through a design: render + describe pick it up too.
    let mut d = two_pages();
    d["assets"] = font_assets;
    d["nodes"]["textaaaa0001"]["style"]["fontFamily"] = json!("Brand Face");
    let res = w
        .post("/v1/render", &json!({ "design": d, "format": "png", "assetUrls": { "fntbrand0001": assets.url("brand.woff2") } }))
        .await;
    assert_eq!(res.status(), 200);
    assert!(
        res.headers().get("x-desyn-missing-fonts").is_none(),
        "{:?}",
        res.headers()
    );
    let res = w
        .post("/v1/render", &json!({ "design": d, "format": "png" }))
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-desyn-missing-assets"], "fntbrand0001");
}

#[tokio::test]
async fn google_fonts_on_demand_with_cache() {
    let assets = Assets::start().await;
    let cache = temp_dir("gfonts");
    let endpoint = format!("{}/css2", assets.base);
    let env = [
        ("GOOGLE_FONTS", "on"),
        ("GOOGLE_FONTS_ENDPOINT", endpoint.as_str()),
        ("FONT_CACHE_DIR", cache.to_str().unwrap()),
    ];
    let w = Worker::start(&env).await;
    let cjk = measure_body("Noto Sans SC", "设计你的故事", json!({}), json!({}));
    let first = width(&w, &cjk).await;
    assert_eq!(assets.hits.get("gfont"), 1, "the family was downloaded");
    // Second request: served from the disk cache (no new download).
    let second = width(&w, &cjk).await;
    assert_eq!(first, second);
    assert_eq!(assets.hits.get("gfont"), 1);

    // Without Google Fonts the CJK text measures differently (fallback metrics).
    let off = Worker::start(&[("FONT_CACHE_DIR", cache.to_str().unwrap())]).await;
    assert!((width(&off, &cjk).await - first).abs() > 0.5);

    // Unknown families are asked for once, then remembered as missing.
    let unknown = measure_body("Definitely Not A Font", "abc", json!({}), json!({}));
    width(&w, &unknown).await;
    let asked = assets
        .hits
        .counts
        .lock()
        .unwrap()
        .keys()
        .filter(|k| k.contains("Definitely"))
        .count();
    assert!(asked >= 1);
    let before = assets.hits.total.load(std::sync::atomic::Ordering::SeqCst);
    width(&w, &unknown).await;
    assert_eq!(
        assets.hits.total.load(std::sync::atomic::Ordering::SeqCst),
        before,
        "misses are cached"
    );

    // A new worker in cache-only mode serves the cached family without touching the network.
    let cached = Worker::start(&[
        ("GOOGLE_FONTS", "cache"),
        ("GOOGLE_FONTS_ENDPOINT", endpoint.as_str()),
        ("FONT_CACHE_DIR", cache.to_str().unwrap()),
    ])
    .await;
    let before = assets.hits.total.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(width(&cached, &cjk).await, first);
    assert_eq!(
        assets.hits.total.load(std::sync::atomic::Ordering::SeqCst),
        before
    );
}

#[tokio::test]
async fn font_directories_are_indexed() {
    let fonts_dir = repo().join("crates/desyn-text/tests/fonts");
    let w = Worker::start(&[("FONTS_DIR", fonts_dir.to_str().unwrap())]).await;
    let ready: Value = w.get("/readyz").await.json().await.unwrap();
    assert!(ready["fonts"]["files"].as_u64().unwrap() >= 3);
    let off = Worker::start(&[]).await;
    let cjk = measure_body("Noto Sans SC", "设计你的故事", json!({}), json!({}));
    assert!(
        (width(&w, &cjk).await - width(&off, &cjk).await).abs() > 0.5,
        "the directory font is used"
    );
}
