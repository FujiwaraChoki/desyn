//! Endpoints, auth, limits, health, metrics, request ids, compression and graceful shutdown against a real server on
//! an ephemeral port.

mod common;

use std::io::Write;
use std::time::Duration;

use common::*;
use serde_json::{Value, json};

#[tokio::test]
async fn health_ready_and_metrics() {
    let w = Worker::start(&[("DESYN_RELEASE", "test-release")]).await;
    let res = w.get("/healthz").await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["release"], "test-release");

    let ready: Value = w.get("/readyz").await.json().await.unwrap();
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["slots"]["total"], 2);

    // Metrics need the secret (unless METRICS_PUBLIC).
    assert_eq!(w.get("/metrics").await.status(), 401);
    let res = w
        .client
        .get(format!("{}/metrics", w.url))
        .header("x-desyn-secret", SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/plain")
    );
    let text = res.text().await.unwrap();
    assert!(text.contains("desyn_worker_build_info{release=\"test-release\"} 1"));
    assert!(text.contains("desyn_worker_requests_total{route=\"healthz\",status=\"200\"} 1"));
    assert!(text.contains("desyn_worker_rejections_total{reason=\"missing_secret\"} 1"));

    let public = Worker::start(&[("METRICS_PUBLIC", "true")]).await;
    assert_eq!(public.get("/metrics").await.status(), 200);
}

#[tokio::test]
async fn auth_is_checked_before_the_body() {
    let w = Worker::start(&[]).await;
    for path in [
        "/v1/render",
        "/v1/describe",
        "/v1/layout",
        "/v1/measure",
        "/v1/apply",
        "/v1/thumbnail",
        "/v1/nope",
    ] {
        let res = w
            .client
            .post(format!("{}{path}", w.url))
            .body("not json")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401, "{path} without secret");
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["error"]["code"], "unauthorized");
        let res = w
            .client
            .post(format!("{}{path}", w.url))
            .header("x-desyn-secret", "wrong-secret-0123456789abcdef")
            .body("not json")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 403, "{path} with a wrong secret");
        // A prefix of the right secret is wrong too.
        let res = w
            .client
            .post(format!("{}{path}", w.url))
            .header("x-desyn-secret", &SECRET[..SECRET.len() - 1])
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 403);
    }
    // With the secret, garbage is a 400 and unknown paths a 404.
    let res = w
        .client
        .post(format!("{}/v1/render", w.url))
        .header("x-desyn-secret", SECRET)
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let res = w
        .client
        .post(format!("{}/v1/nope", w.url))
        .header("x-desyn-secret", SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // Secret rotation: the previous secret keeps working.
    let rotated = Worker::start(&[
        ("RENDER_WORKER_SECRET", "new-secret-abcdefghijklmnop"),
        ("RENDER_WORKER_SECRET_PREVIOUS", SECRET),
    ])
    .await;
    let body = json!({ "items": [] });
    assert_eq!(rotated.post("/v1/measure", &body).await.status(), 200);
}

#[tokio::test]
async fn request_ids_are_echoed_or_generated() {
    let w = Worker::start(&[]).await;
    let res = w
        .client
        .get(format!("{}/healthz", w.url))
        .header("x-request-id", "convex-run-42")
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["x-request-id"], "convex-run-42");
    let res = w
        .client
        .get(format!("{}/healthz", w.url))
        .header("x-request-id", "bad id with spaces")
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["x-request-id"].len(), 24);
    let res = w
        .client
        .get(format!("{}/healthz", w.url))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["x-request-id"].len(), 24);
}

#[tokio::test]
async fn render_png_with_assets_and_reporting_headers() {
    let assets = Assets::start().await;
    let w = Worker::start(&[("ASSET_PRIVATE_HOSTS", "127.0.0.1")]).await;
    let mut d = fixture("social");
    // One asset by assetUrls, one by AssetRef.url (both forms are used by the Convex callers).
    d["assets"]["icon00000001"]["url"] = json!(assets.url("icon00000001.svg"));
    let body = json!({
        "design": d, "format": "png", "scale": 0.5,
        "assetUrls": { "photo0000001": assets.url("photo0000001.jpg") }
    });
    let res = w.post("/v1/render", &body).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert_eq!(res.headers()["x-desyn-pages"], "1");
    assert!(
        res.headers().get("x-desyn-missing-assets").is_none(),
        "{:?}",
        res.headers()
    );
    assert!(res.headers().get("x-desyn-failed-assets").is_none());
    let png = res.bytes().await.unwrap();
    assert_eq!(png_size(&png), (540, 540));
    assert_eq!(assets.hits.get("asset:photo0000001.jpg"), 1);
    assert_eq!(assets.hits.get("asset:icon00000001.svg"), 1);

    // The second render is served from the URL cache.
    let res = w.post("/v1/render", &body).await;
    assert_eq!(res.status(), 200);
    assert_eq!(assets.hits.get("asset:photo0000001.jpg"), 1);

    // Without URLs the render still succeeds and reports the missing asset.
    let mut bare = fixture("social");
    bare["assets"]["icon00000001"]["url"] = json!(assets.url("icon00000001.svg"));
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": bare, "format": "png", "scale": 0.25 }),
        )
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-desyn-missing-assets"], "photo0000001");
    // ...unless strictAssets is set.
    let res = w
        .post(
            "/v1/render",
            &json!({ "design": bare, "format": "png", "scale": 0.25, "strictAssets": true }),
        )
        .await;
    assert_eq!(res.status(), 422);
    let e: Value = res.json().await.unwrap();
    assert_eq!(e["error"]["code"], "asset_fetch_failed");
    assert_eq!(e["error"]["details"]["unresolved"][0], "photo0000001");
}

#[tokio::test]
async fn gzip_bodies_and_json_compression() {
    let w = Worker::start(&[]).await;
    let body = serde_json::to_vec(&json!({ "design": fixture("text"), "pageId": null })).unwrap();
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&body).unwrap();
    let gz = enc.finish().unwrap();
    let res = w
        .client
        .post(format!("{}/v1/describe", w.url))
        .header("x-desyn-secret", SECRET)
        .header("content-encoding", "gzip")
        .header("accept-encoding", "gzip")
        .body(gz)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["content-encoding"],
        "gzip",
        "large JSON answers are compressed"
    );
    let raw = res.bytes().await.unwrap();
    let mut json = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&raw[..]), &mut json).unwrap();
    let desc: Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(desc["design"]["id"], fixture("text")["id"]);

    let res = w
        .client
        .post(format!("{}/v1/describe", w.url))
        .header("x-desyn-secret", SECRET)
        .header("content-encoding", "br")
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 415);
}

#[tokio::test]
async fn describe_layout_measure_apply() {
    let w = Worker::start(&[]).await;
    let d = two_pages();

    // describe: section 7 shape for the requested page.
    let desc = w
        .post_json(
            "/v1/describe",
            &json!({ "design": d, "pageId": "pagebbbb0002", "maxDepth": 2 }),
            200,
        )
        .await;
    assert_eq!(desc["design"]["pageCount"], 2);
    assert_eq!(desc["page"]["id"], "pagebbbb0002");
    assert_eq!(desc["page"]["index"], 1);
    assert_eq!(desc["tree"][0]["id"], "rectbbbb0002");
    assert!(desc["palette"].as_array().is_some_and(|p| !p.is_empty()));
    let e = w
        .post_json(
            "/v1/describe",
            &json!({ "design": d, "pageId": "nosuchpage01" }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "page_not_found");

    // layout: the auto-resize text gets its real height.
    let out = w
        .post_json("/v1/layout", &json!({ "design": d }), 200)
        .await;
    let h = out["design"]["nodes"]["textaaaa0001"]["height"]
        .as_f64()
        .unwrap();
    assert!((25.0..40.0).contains(&h), "text height {h}");
    assert!(
        out["changed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "textaaaa0001")
    );

    // measure: narrower boxes wrap into more lines.
    let item = |width: Option<f64>| {
        let mut it = json!({
            "text": [{ "text": "The quick brown fox jumps over the lazy dog" }],
            "style": text_style("Inter", 20.0),
            "paragraph": paragraph(),
        });
        if let Some(w) = width {
            it["width"] = json!(w);
        }
        it
    };
    let sizes = w
        .post_json(
            "/v1/measure",
            &json!({ "items": [item(None), item(Some(120.0))] }),
            200,
        )
        .await;
    let s = sizes["sizes"].as_array().unwrap();
    assert_eq!(s[0]["lines"], 1);
    assert!(s[0]["w"].as_f64().unwrap() > 300.0);
    assert!(s[1]["lines"].as_u64().unwrap() >= 3);
    assert!(s[1]["w"].as_f64().unwrap() <= 120.0);
    assert!(s[1]["h"].as_f64().unwrap() > s[0]["h"].as_f64().unwrap());
    let e = w.post_json("/v1/measure", &json!({ "items": [{ "text": [], "style": text_style("Inter", 12.0), "paragraph": paragraph(), "width": -1 }] }), 400).await;
    assert_eq!(e["error"]["code"], "invalid_options");

    // apply: core semantics with layout normalization, drops and an exact inverse.
    let tx = json!({
        "id": "txaaaaaa0001", "label": "Edit", "source": "user", "ts": 1,
        "ops": [
            { "op": "update", "id": "textaaaa0001", "set": { "runs": [{ "text": "A much longer headline that now wraps onto several lines" }] } },
            { "op": "delete", "id": "nonexistent1" },
            { "op": "move", "id": "rectaaaa0001", "parent": "pagebbbb0002" }
        ]
    });
    let out = w
        .post_json("/v1/apply", &json!({ "design": d, "tx": tx }), 200)
        .await;
    assert_eq!(
        out["dropped"],
        json!([{ "index": 1, "reason": "missing-node" }])
    );
    let new_h = out["design"]["nodes"]["textaaaa0001"]["height"]
        .as_f64()
        .unwrap();
    assert!(
        new_h > h,
        "normalization grew the text box ({h} -> {new_h})"
    );
    assert!(
        out["applied"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["op"] == "update"
                && op["id"] == "textaaaa0001"
                && op["set"]["height"].is_number())
    );
    assert_eq!(
        out["design"]["nodes"]["rectaaaa0001"]["parent"],
        "pagebbbb0002"
    );
    assert_eq!(
        out["inverse"]["ops"].as_array().unwrap().len(),
        out["applied"].as_array().unwrap().len()
    );

    // Undo through the worker restores the original design.
    let undo = w
        .post_json(
            "/v1/apply",
            &json!({ "design": out["design"], "tx": out["inverse"], "normalize": false }),
            200,
        )
        .await;
    assert_eq!(
        desyn_core::canonical::canonical_json(&undo["design"]),
        desyn_core::canonical::canonical_json(&d),
        "the inverse restores the design exactly, derived geometry included"
    );

    // layout / apply refuse designs that break the invariants.
    let mut broken = d.clone();
    broken["nodes"]["rectaaaa0001"]["opacity"] = json!(3);
    let e = w
        .post_json("/v1/apply", &json!({ "design": broken, "tx": tx }), 422)
        .await;
    assert_eq!(e["error"]["code"], "invalid_design");
    assert!(
        e["error"]["details"]["violations"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
    );
}

#[tokio::test]
async fn thumbnails() {
    let w = Worker::start(&[]).await;
    let res = w
        .post(
            "/v1/thumbnail",
            &json!({ "design": fixture("shapes"), "width": 320 }),
        )
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/webp");
    let b = res.bytes().await.unwrap();
    assert_eq!(&b[..4], b"RIFF");
    assert_eq!(&b[8..12], b"WEBP");
    let res = w
        .post("/v1/thumbnail", &json!({ "design": two_pages(), "pageId": "pagebbbb0002", "width": 160, "format": "png" }))
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(png_size(&res.bytes().await.unwrap()), (160, 90));
    let e = w
        .post_json(
            "/v1/thumbnail",
            &json!({ "design": two_pages(), "width": 99999 }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_options");
}

#[tokio::test]
async fn request_limits() {
    let w = Worker::start(&[
        ("WORKER_MAX_BODY_BYTES", "20000"),
        ("WORKER_MAX_JSON_BYTES", "200000"),
        ("WORKER_MAX_NODES", "5"),
        ("WORKER_MAX_PIXELS", "1000000"),
        ("WORKER_MAX_MEASURE_ITEMS", "3"),
    ])
    .await;
    // Body on the wire.
    let res = w
        .client
        .post(format!("{}/v1/render", w.url))
        .header("x-desyn-secret", SECRET)
        .body(vec![b' '; 30_000])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);
    // Decompressed size (gzip bomb).
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(&vec![b' '; 1_000_000]).unwrap();
    let res = w
        .client
        .post(format!("{}/v1/render", w.url))
        .header("x-desyn-secret", SECRET)
        .header("content-encoding", "gzip")
        .body(enc.finish().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);
    let e: Value = res.json().await.unwrap();
    assert_eq!(e["error"]["code"], "json_too_large");
    // Node count.
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": two_pages(), "format": "png" }),
            413,
        )
        .await;
    assert_eq!(e["error"]["code"], "too_many_nodes");
    // Pixel budget.
    let small = design(
        "smalldsg0001",
        vec![(page("pagesmal0001", 400.0, 400.0, "#ffffff", &[]), vec![])],
    );
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "png", "scale": 3 }),
            413,
        )
        .await;
    assert_eq!(e["error"]["code"], "too_many_pixels");
    assert_eq!(
        w.post(
            "/v1/render",
            &json!({ "design": small, "format": "png", "scale": 2 })
        )
        .await
        .status(),
        200
    );
    // Measure items.
    let item = json!({ "text": [{ "text": "x" }], "style": text_style("Inter", 12.0), "paragraph": paragraph() });
    let e = w
        .post_json(
            "/v1/measure",
            &json!({ "items": [item, item, item, item] }),
            413,
        )
        .await;
    assert_eq!(e["error"]["code"], "too_many_items");
    // Options.
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "bmp" }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "unsupported_format");
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "png", "scale": -1 }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_options");
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "jpeg", "quality": 101 }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_options");
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "png", "pageId": "nosuchpage01" }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "page_not_found");
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": small, "format": "png", "background": "red" }),
            400,
        )
        .await;
    assert_eq!(e["error"]["code"], "invalid_options");
    let e = w
        .post_json("/v1/render", &json!({ "format": "png" }), 400)
        .await;
    assert_eq!(e["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn overload_and_timeouts() {
    // One slot, nobody may wait: concurrent heavy renders are turned away with 503 + Retry-After.
    let w = Worker::start(&[("WORKER_CONCURRENCY", "1"), ("WORKER_QUEUE_LIMIT", "0")]).await;
    let body = json!({ "design": fixture("effects"), "format": "png", "scale": 4 });
    let (a, b, c) = tokio::join!(
        w.post("/v1/render", &body),
        w.post("/v1/render", &body),
        w.post("/v1/render", &body)
    );
    let statuses = [
        a.status().as_u16(),
        b.status().as_u16(),
        c.status().as_u16(),
    ];
    assert!(statuses.contains(&200), "{statuses:?}");
    assert!(statuses.contains(&503), "{statuses:?}");
    for r in [a, b, c] {
        if r.status() == 503 {
            assert!(r.headers().contains_key("retry-after"));
            let e: Value = r.json().await.unwrap();
            assert_eq!(e["error"]["code"], "overloaded");
        }
    }

    // A deadline shorter than the render: 504.
    let w = Worker::start(&[("WORKER_REQUEST_TIMEOUT_MS", "150")]).await;
    let e = w
        .post_json(
            "/v1/render",
            &json!({ "design": fixture("effects"), "format": "png", "scale": 6 }),
            504,
        )
        .await;
    assert_eq!(e["error"]["code"], "timeout");
}

#[tokio::test]
async fn graceful_shutdown_finishes_in_flight_requests() {
    let mut w = Worker::start(&[]).await;
    let client = w.client.clone();
    let url = format!("{}/v1/render", w.url);
    let body =
        serde_json::to_vec(&json!({ "design": fixture("effects"), "format": "png", "scale": 3 }))
            .unwrap();
    let inflight = tokio::spawn(async move {
        client
            .post(url)
            .header("x-desyn-secret", SECRET)
            .body(body)
            .send()
            .await
            .map(|r| r.status().as_u16())
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    w.shutdown();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(w.state.draining.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        inflight.await.unwrap().unwrap(),
        200,
        "the in-flight render completes"
    );
    let task = w.task.take().unwrap();
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        w.client
            .get(format!("{}/healthz", w.url))
            .send()
            .await
            .is_err(),
        "the listener is closed"
    );
}
