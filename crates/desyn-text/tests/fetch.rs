//! Google Fonts provider against a local CSS2-compatible server (offline; feature `fetch`).
#![cfg(feature = "fetch")]

mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::*;
use desyn_text::font::GoogleFontsProvider;
use desyn_text::{LayoutOptions, TextEngine};

fn serve(log: Arc<Mutex<Vec<String>>>, hits: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            // Drain headers.
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            hits.fetch_add(1, Ordering::SeqCst);
            log.lock().unwrap().push(path.clone());
            let (status, body): (&str, Vec<u8>) = if path
                == "/css2?family=Instrument+Serif:ital,wght@0,400"
            {
                let css = format!(
                    "@font-face {{\n  font-family: 'Instrument Serif';\n  font-style: normal;\n  font-weight: 400;\n  src: url(http://127.0.0.1:{port}/s/instrumentserif/v1/regular.ttf) format('truetype');\n}}\n"
                );
                ("200 OK", css.into_bytes())
            } else if path == "/s/instrumentserif/v1/regular.ttf" {
                ("200 OK", SERIF.to_vec())
            } else if path.starts_with("/css2") {
                ("400 Bad Request", b"bad".to_vec())
            } else {
                ("404 Not Found", b"missing".to_vec())
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(&body);
        }
    });
    port
}

#[test]
fn fetches_falls_back_across_queries_and_caches_on_disk() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let hits = Arc::new(AtomicUsize::new(0));
    let port = serve(log.clone(), hits.clone());
    let cache = std::env::temp_dir().join(format!("desyn-text-fetch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);

    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(GoogleFontsProvider::with_endpoint(
        format!("http://127.0.0.1:{port}/css2"),
        &cache,
    ))));
    let mut c = plain("Hello", "Instrument Serif", 30.0);
    c.spans[0].style.weight = 700.0;
    let l = e.layout(&c, &LayoutOptions::default());
    assert_eq!(
        e.db().face(l.runs[0].face).unwrap().family,
        "Instrument Serif"
    );
    assert!(
        l.runs[0].synthetic_bold > 0.0,
        "only the regular exists upstream"
    );
    let paths = log.lock().unwrap().clone();
    assert_eq!(
        paths,
        vec![
            "/css2?family=Instrument+Serif:ital,wght@0,700",
            "/css2?family=Instrument+Serif:ital,wght@0,400",
            "/s/instrumentserif/v1/regular.ttf",
        ]
    );
    assert!(e.take_provider_errors().is_empty());

    // A new engine with an offline provider serves the family from the disk cache.
    let before = hits.load(Ordering::SeqCst);
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(
        GoogleFontsProvider::with_endpoint(format!("http://127.0.0.1:{port}/css2"), &cache)
            .offline(true),
    )));
    let l = e.layout(&c, &LayoutOptions::default());
    assert_eq!(
        e.db().face(l.runs[0].face).unwrap().family,
        "Instrument Serif"
    );
    assert_eq!(hits.load(Ordering::SeqCst), before, "no network");

    // Hostile family names from documents never reach the network.
    let mut e = TextEngine::new();
    e.db_mut().add_static_font(INTER).unwrap();
    e.set_provider(Some(Box::new(GoogleFontsProvider::with_endpoint(
        format!("http://127.0.0.1:{port}/css2"),
        &cache,
    ))));
    for family in ["x".repeat(5000), "Evil\nFamily".to_string()] {
        let l = e.layout(&plain("Hello", &family, 30.0), &LayoutOptions::default());
        assert_eq!(e.db().face(l.runs[0].face).unwrap().family, "Inter");
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        before,
        "rejected before any request"
    );
    std::fs::remove_dir_all(&cache).unwrap();
}
