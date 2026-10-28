//! Shared test harness: the worker on an ephemeral port, a mock asset / Google Fonts server, design builders.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::{Path as UrlPath, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use desyn_worker::{AppState, Config, serve};
use serde_json::{Value, json};
use tokio::sync::oneshot;

pub const SECRET: &str = "test-secret-0123456789abcdef";

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn temp_dir(tag: &str) -> PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let name: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let d = std::env::temp_dir().join(format!("desyn-worker-test-{tag}-{name}"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A running worker.
pub struct Worker {
    pub url: String,
    pub client: reqwest::Client,
    pub state: Arc<AppState>,
    shutdown: Option<oneshot::Sender<()>>,
    pub task: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
}

impl Worker {
    /// Starts a worker with test defaults overridden by `env`.
    pub async fn start(env: &[(&str, &str)]) -> Worker {
        let cache = temp_dir("fonts");
        let mut vars: HashMap<String, String> = [
            ("RENDER_WORKER_SECRET", SECRET),
            ("WORKER_CONCURRENCY", "2"),
            ("GOOGLE_FONTS", "off"),
            ("LOG_FORMAT", "pretty"),
            ("WORKER_SHUTDOWN_GRACE_MS", "5000"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        vars.insert("FONT_CACHE_DIR".into(), cache.display().to_string());
        for (k, v) in env {
            vars.insert(k.to_string(), v.to_string());
        }
        let config = Config::from_lookup(|k| vars.get(k).cloned()).expect("test config");
        let state = tokio::task::spawn_blocking(move || AppState::build(config))
            .await
            .unwrap()
            .expect("state");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = oneshot::channel::<()>();
        let task = tokio::spawn(serve(listener, state.clone(), async move {
            let _ = rx.await;
        }));
        Worker {
            url: format!("http://{addr}"),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            state,
            shutdown: Some(tx),
            task: Some(task),
        }
    }

    /// POST with the secret.
    pub async fn post(&self, path: &str, body: &Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.url))
            .header("x-desyn-secret", SECRET)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(body).unwrap())
            .send()
            .await
            .unwrap()
    }

    /// POST and parse a JSON answer, asserting the status.
    pub async fn post_json(&self, path: &str, body: &Value, status: u16) -> Value {
        let res = self.post(path, body).await;
        let got = res.status().as_u16();
        let text = res.text().await.unwrap();
        assert_eq!(got, status, "{path}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    pub async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.url))
            .send()
            .await
            .unwrap()
    }

    /// Triggers graceful shutdown.
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Counters of the mock server.
#[derive(Default)]
pub struct Hits {
    pub counts: std::sync::Mutex<HashMap<String, usize>>,
    pub total: AtomicUsize,
}

impl Hits {
    pub fn get(&self, key: &str) -> usize {
        *self.counts.lock().unwrap().get(key).unwrap_or(&0)
    }
    fn hit(&self, key: &str) {
        self.total.fetch_add(1, Ordering::SeqCst);
        *self
            .counts
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default() += 1;
    }
}

/// Mock asset server on 127.0.0.1 (assets, redirects, a Google Fonts CSS2 stand-in).
pub struct Assets {
    pub base: String,
    pub port: u16,
    pub hits: Arc<Hits>,
}

#[derive(Clone)]
struct MockState {
    hits: Arc<Hits>,
    base: String,
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

async fn asset(State(s): State<MockState>, UrlPath(name): UrlPath<String>) -> Response {
    s.hits.hit(&format!("asset:{name}"));
    let path = match name.as_str() {
        "brand.woff2" => repo().join("crates/desyn-text/tests/fonts/InstrumentSerif-ascii.woff2"),
        "sound.wav" => {
            return ([(header::CONTENT_TYPE, "audio/wav")], sine_wav(1.5)).into_response();
        }
        // Hostile "sounds": files that make a media framework open other resources (security tests).
        "manifest.mpd" => {
            return format!(
                "<?xml version=\"1.0\"?>\n<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" \
                 profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" type=\"static\" \
                 mediaPresentationDuration=\"PT2S\" minBufferTime=\"PT1S\"><Period><AdaptationSet \
                 mimeType=\"audio/mp4\"><Representation id=\"a\" bandwidth=\"1000\" codecs=\"mp4a.40.2\">\
                 <BaseURL>{}/leak/dash.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n",
                s.base
            )
            .into_response();
        }
        "session.sdp" => {
            return "v=0\no=- 0 0 IN IP4 127.0.0.1\ns=x\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio 9 RTP/AVP 0\n"
                .into_response();
        }
        "list.ffconcat" => {
            return format!(
                "ffconcat version 1.0\nfile '{}/leak/concat.wav'\nfile '/etc/hostname'\n",
                s.base
            )
            .into_response();
        }
        other => repo().join("spec/fixtures/render/assets").join(other),
    };
    if !path.exists() {
        return StatusCode::NOT_FOUND.into_response();
    }
    read(&path).into_response()
}

async fn redirect(RawQuery(q): RawQuery) -> Response {
    let to = q.unwrap_or_default().trim_start_matches("to=").to_string();
    let to = to.replace("%3A", ":").replace("%2F", "/");
    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
}

async fn big(State(s): State<MockState>) -> Response {
    s.hits.hit("big");
    vec![0u8; 3 * 1024 * 1024].into_response()
}

/// A DASH manifest whose only segment is the local file named by the query string.
async fn local_mpd(RawQuery(q): RawQuery) -> Response {
    format!(
        "<?xml version=\"1.0\"?>\n<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" \
         profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" type=\"static\" \
         mediaPresentationDuration=\"PT1S\" minBufferTime=\"PT1S\"><Period><AdaptationSet \
         mimeType=\"audio/mp4\"><Representation id=\"a\" bandwidth=\"1000\" codecs=\"mp4a.40.2\">\
         <BaseURL>file://{}</BaseURL></Representation></AdaptationSet></Period></MPD>\n",
        q.unwrap_or_default()
    )
    .into_response()
}

async fn leak(State(s): State<MockState>) -> Response {
    s.hits.hit("leak");
    sine_wav(0.5).into_response()
}

async fn css2(State(s): State<MockState>, RawQuery(q): RawQuery) -> Response {
    let q = q.unwrap_or_default();
    s.hits.hit(&format!("css:{q}"));
    if q.contains("family=Noto+Sans+SC") {
        let css = format!(
            "@font-face {{ font-family: 'Noto Sans SC'; src: url({}/gfont/sc.ttf) format('truetype'); }}",
            s.base
        );
        return ([(header::CONTENT_TYPE, "text/css")], css).into_response();
    }
    (StatusCode::BAD_REQUEST, "unknown family").into_response()
}

async fn gfont(State(s): State<MockState>) -> Response {
    s.hits.hit("gfont");
    read(&repo().join("crates/desyn-text/tests/fonts/NotoSansSC-subset.ttf")).into_response()
}

impl Assets {
    pub async fn start() -> Assets {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let hits = Arc::new(Hits::default());
        let state = MockState {
            hits: hits.clone(),
            base: base.clone(),
        };
        let app = Router::new()
            .route("/a/{name}", get(asset))
            .route("/redirect", get(redirect))
            .route("/big", get(big))
            .route("/leak/{*rest}", get(leak))
            .route("/local.mpd", get(local_mpd))
            .route("/css2", get(css2))
            .route("/gfont/sc.ttf", get(gfont))
            .with_state(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Assets { base, port, hits }
    }

    pub fn url(&self, name: &str) -> String {
        format!("{}/a/{name}", self.base)
    }
}

/// 16-bit mono 44.1 kHz sine WAV.
pub fn sine_wav(seconds: f64) -> Vec<u8> {
    let rate = 44_100u32;
    let n = (seconds * f64::from(rate)) as u32;
    let mut data = Vec::with_capacity(n as usize * 2);
    for i in 0..n {
        let v = ((f64::from(i) / f64::from(rate) * 440.0 * std::f64::consts::TAU).sin() * 12_000.0)
            as i16;
        data.extend_from_slice(&v.to_le_bytes());
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out
}

// ---------------------------------------------------------------------------------------------------------------
// designs

/// A render fixture with its pages parented to root (the contract; the fixture files leave it null).
pub fn fixture(name: &str) -> Value {
    let raw =
        std::fs::read_to_string(repo().join(format!("spec/fixtures/render/{name}.json"))).unwrap();
    let mut d: Value = serde_json::from_str(&raw).unwrap();
    let pages: Vec<String> = d["nodes"]["root"]["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    for p in pages {
        d["nodes"][&p]["parent"] = json!("root");
    }
    d
}

fn base(id: &str, ty: &str, parent: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
    json!({
        "id": id, "type": ty, "name": id, "parent": parent,
        "x": x, "y": y, "width": w, "height": h, "rotation": 0,
        "opacity": 1, "blend": "normal", "visible": true, "locked": false, "effects": []
    })
}

fn merge(mut a: Value, b: Value) -> Value {
    for (k, v) in b.as_object().unwrap() {
        a[k] = v.clone();
    }
    a
}

pub fn page(id: &str, w: f64, h: f64, bg: &str, children: &[&str]) -> Value {
    merge(
        base(id, "page", "root", 0.0, 0.0, w, h),
        json!({ "children": children, "clip": true, "unit": "px",
                "background": [{ "type": "solid", "color": bg }], "bleed": 0 }),
    )
}

pub fn rect(id: &str, parent: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Value {
    merge(
        base(id, "rect", parent, x, y, w, h),
        json!({ "fills": [{ "type": "solid", "color": color }], "strokes": [], "cornerRadius": 8 }),
    )
}

/// Auto-height text at `(x, y)` with width `w`.
pub fn text(
    id: &str,
    parent: &str,
    (x, y, w): (f64, f64, f64),
    content: &str,
    family: &str,
    size: f64,
) -> Value {
    merge(
        base(id, "text", parent, x, y, w, 10.0),
        json!({
            "runs": [{ "text": content }],
            "style": text_style(family, size),
            "paragraph": paragraph(),
            "autoResize": "height", "verticalAlign": "top"
        }),
    )
}

pub fn text_style(family: &str, size: f64) -> Value {
    json!({ "fontFamily": family, "fontWeight": 400, "fontStyle": "normal", "fontSize": size,
            "fills": [{ "type": "solid", "color": "#111111" }], "letterSpacing": 0, "textCase": "none",
            "decoration": "none" })
}

pub fn paragraph() -> Value {
    json!({ "align": "left", "direction": "auto", "lineHeight": { "unit": "percent", "value": 120 },
            "spacing": 0, "indent": 0, "list": "none" })
}

/// A design from pages and their nodes.
pub fn design(id: &str, pages: Vec<(Value, Vec<Value>)>) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut root_children = Vec::new();
    for (p, kids) in pages {
        root_children.push(p["id"].clone());
        nodes.insert(p["id"].as_str().unwrap().to_string(), p);
        for k in kids {
            nodes.insert(k["id"].as_str().unwrap().to_string(), k);
        }
    }
    nodes.insert(
        "root".into(),
        merge(
            base("root", "root", "", 0.0, 0.0, 0.0, 0.0),
            json!({ "parent": null, "children": root_children }),
        ),
    );
    json!({
        "schema": 1, "id": id, "name": "Test design", "kind": "presentation",
        "nodes": nodes, "assets": {},
        "styles": { "colors": {}, "text": {}, "effects": {}, "variables": {} },
        "meta": {}
    })
}

/// Two 320x180 pages with a fade transition (1 s each).
pub fn two_pages() -> Value {
    let mut p1 = page(
        "pageaaaa0001",
        320.0,
        180.0,
        "#0f0d1f",
        &["rectaaaa0001", "textaaaa0001"],
    );
    p1["durationMs"] = json!(1000);
    let mut p2 = page("pagebbbb0002", 320.0, 180.0, "#ffb02e", &["rectbbbb0002"]);
    p2["durationMs"] = json!(1000);
    p2["transition"] = json!({ "kind": "fade", "durationMs": 300 });
    design(
        "twopages0001",
        vec![
            (
                p1,
                vec![
                    rect(
                        "rectaaaa0001",
                        "pageaaaa0001",
                        20.0,
                        20.0,
                        120.0,
                        80.0,
                        "#ffb02e",
                    ),
                    text(
                        "textaaaa0001",
                        "pageaaaa0001",
                        (20.0, 110.0, 280.0),
                        "Hello from the sun",
                        "Inter",
                        24.0,
                    ),
                ],
            ),
            (
                p2,
                vec![rect(
                    "rectbbbb0002",
                    "pagebbbb0002",
                    100.0,
                    40.0,
                    120.0,
                    100.0,
                    "#0f0d1f",
                )],
            ),
        ],
    )
}

/// PNG width / height from the IHDR chunk.
pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "png signature");
    (
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    )
}

pub fn ffmpeg_available() -> bool {
    std::process::Command::new("ffprobe")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
        && std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
}

/// ffprobe summary of a media file.
pub fn ffprobe(bytes: &[u8], ext: &str) -> Value {
    let dir = temp_dir("probe");
    let path = dir.join(format!("media.{ext}"));
    std::fs::write(&path, bytes).unwrap();
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type,width,height,pix_fmt:format=duration,format_name",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        out.status.success(),
        "ffprobe: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
