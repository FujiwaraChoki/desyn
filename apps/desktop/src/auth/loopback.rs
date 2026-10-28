//! Loopback redirect (RFC 8252 §7.3) for when the `desyn://` scheme is not registered with the OS (development
//! builds, portable installs): a one-shot HTTP listener on `127.0.0.1:<random port>/callback` that hands the
//! query parameters back to the app and shows a short "return to Desyn" page.

use std::time::Duration;

use futures::channel::oneshot;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::cloud::runtime::{TaskGuard, runtime};

const PAGE: &str = "<!doctype html><html><head><meta charset=utf-8><title>Desyn</title><style>\
body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#ededed;\
font:16px/1.6 system-ui,sans-serif}h1{font:400 44px/1.1 Georgia,serif;margin:0 0 8px}em{color:#ffb02e}\
.sun{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#ffd66b,#ff6a1f);\
box-shadow:0 0 40px #ffb02e66;margin:0 auto 24px}</style></head><body><main style=text-align:center>\
<div class=sun></div><h1>you're <em>in</em>.</h1><p>Return to Desyn. You can close this tab.</p></main></body></html>";

/// A running listener.
pub struct Loopback {
    /// `http://127.0.0.1:<port>/callback`.
    pub redirect_uri: String,
    /// Resolves with the callback's query parameters.
    pub params: oneshot::Receiver<Vec<(String, String)>>,
    /// Keeps the listener alive (dropping it stops listening).
    pub task: TaskGuard,
}

/// Parses the request line of an HTTP request (`GET /callback?code=..&state=.. HTTP/1.1`).
pub fn parse_request(head: &str) -> Option<Vec<(String, String)>> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    Some(
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
    )
}

/// Starts listening (gives up after `timeout`).
pub fn start(timeout: Duration) -> std::io::Result<Loopback> {
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    std_listener.set_nonblocking(true)?;
    let port = std_listener.local_addr()?.port();
    let (tx, rx) = oneshot::channel();
    let _rt = runtime().enter();
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    let task = TaskGuard::spawn(async move {
        let serve = async {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    continue;
                };
                let mut buf = vec![0u8; 8192];
                let n =
                    match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
                        Ok(Ok(n)) => n,
                        _ => continue,
                    };
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                match parse_request(&head) {
                    Some(params) => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{PAGE}",
                            PAGE.len()
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                        let _ = sock.shutdown().await;
                        return Some(params);
                    }
                    None => {
                        let _ = sock
                            .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                            .await;
                    }
                }
            }
        };
        if let Ok(Some(params)) = tokio::time::timeout(timeout, serve).await {
            let _ = tx.send(params);
        }
    });
    Ok(Loopback {
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
        params: rx,
        task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_callback() {
        let p =
            parse_request("GET /callback?code=abc&state=x%2By HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .unwrap();
        assert_eq!(
            p,
            vec![
                ("code".into(), "abc".into()),
                ("state".into(), "x+y".into())
            ]
        );
        assert!(parse_request("GET /favicon.ico HTTP/1.1\r\n").is_none());
        assert!(parse_request("POST /callback HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn serves_one_callback() {
        let lb = start(Duration::from_secs(5)).unwrap();
        let port: u16 = lb
            .redirect_uri
            .split(':')
            .nth(2)
            .unwrap()
            .trim_end_matches("/callback")
            .parse()
            .unwrap();
        let res = futures::executor::block_on(crate::cloud::runtime::spawn(async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            s.write_all(b"GET /callback?code=c1&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        }))
        .unwrap();
        assert!(res.starts_with("HTTP/1.1 200"));
        assert!(res.contains("Return to Desyn"));
        let params = futures::executor::block_on(lb.params).unwrap();
        assert_eq!(params[0], ("code".to_string(), "c1".to_string()));
    }
}
