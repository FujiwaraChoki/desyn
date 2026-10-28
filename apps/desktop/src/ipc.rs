//! Single-instance handoff. The first process listens on a local endpoint (a Unix socket; a loopback TCP port
//! with a secret token on Windows); later launches (double-clicked files, `desyn://` links on Linux and Windows)
//! forward their arguments to it and exit, so every design opens as a tab or window of one running app.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One forwarded launch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Handoff {
    /// Working directory of the launching process (relative paths resolve against it).
    pub cwd: PathBuf,
    /// Arguments without the program name.
    pub args: Vec<String>,
    /// Shared secret (Windows loopback only).
    #[serde(default)]
    pub token: String,
}

/// Outcome of [`claim`].
pub enum Claim {
    /// This process is the primary instance; handoffs arrive through the callback given to `claim`.
    Primary,
    /// Another instance took the arguments; this process should exit.
    Forwarded,
}

/// Tries to hand `args` to a running instance; otherwise becomes the primary instance and calls `on_handoff` (on a
/// background thread) for every later launch. Failures to listen are logged and the app runs standalone.
pub fn claim(
    endpoint: &Path,
    args: &[String],
    on_handoff: impl Fn(Handoff) + Send + 'static,
) -> Claim {
    let cwd = std::env::current_dir().unwrap_or_default();
    if imp::forward(
        endpoint,
        &Handoff {
            cwd,
            args: args.to_vec(),
            token: String::new(),
        },
    ) {
        return Claim::Forwarded;
    }
    if let Err(e) = imp::listen(endpoint, Box::new(on_handoff)) {
        log::warn!(
            "single instance: cannot listen on {} ({e}); running standalone",
            endpoint.display()
        );
    }
    Claim::Primary
}

/// How long the primary instance waits for a connected launch to send its arguments.
const HANDOFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Largest handoff line accepted (arguments of one launch).
const MAX_HANDOFF_BYTES: u64 = 1 << 20;

fn read_handoffs(stream: impl std::io::Read, token: &str, f: &dyn Fn(Handoff)) {
    for line in BufReader::new(stream.take(MAX_HANDOFF_BYTES))
        .lines()
        .map_while(Result::ok)
        .take(16)
    {
        match serde_json::from_str::<Handoff>(&line) {
            Ok(h) if h.token == token => f(h),
            Ok(_) => log::warn!("single instance: rejected a handoff with a wrong token"),
            Err(e) => log::warn!("single instance: bad handoff ({e})"),
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub fn forward(endpoint: &Path, h: &Handoff) -> bool {
        let Ok(mut s) = UnixStream::connect(endpoint) else {
            return false;
        };
        let line = serde_json::to_string(h).unwrap_or_default();
        s.write_all(line.as_bytes())
            .and_then(|_| s.write_all(b"\n"))
            .and_then(|_| s.flush())
            .is_ok()
    }

    pub fn listen(endpoint: &Path, f: Box<dyn Fn(Handoff) + Send>) -> std::io::Result<()> {
        if let Some(dir) = endpoint.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // A socket file without a listener is stale (the previous primary crashed): connect failed above.
        let _ = std::fs::remove_file(endpoint);
        let listener = UnixListener::bind(endpoint)?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600));
        }
        std::thread::Builder::new()
            .name("desyn-ipc".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    // A client that connects and never writes must not block later launches.
                    let _ = stream.set_read_timeout(Some(HANDOFF_TIMEOUT));
                    read_handoffs(stream, "", &*f);
                }
            })?;
        Ok(())
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener, TcpStream};

    fn read_endpoint(endpoint: &Path) -> Option<(u16, String)> {
        let text = std::fs::read_to_string(endpoint).ok()?;
        let (port, token) = text.trim().split_once(' ')?;
        Some((port.parse().ok()?, token.to_string()))
    }

    pub fn forward(endpoint: &Path, h: &Handoff) -> bool {
        let Some((port, token)) = read_endpoint(endpoint) else {
            return false;
        };
        let Ok(mut s) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)) else {
            return false;
        };
        let h = Handoff { token, ..h.clone() };
        let line = serde_json::to_string(&h).unwrap_or_default();
        s.write_all(line.as_bytes())
            .and_then(|_| s.write_all(b"\n"))
            .and_then(|_| s.flush())
            .is_ok()
    }

    pub fn listen(endpoint: &Path, f: Box<dyn Fn(Handoff) + Send>) -> std::io::Result<()> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|e| std::io::Error::other(e.to_string()))?;
        let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        crate::paths::write_atomic(endpoint, format!("{port} {token}").as_bytes())?;
        std::thread::Builder::new()
            .name("desyn-ipc".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let _ = stream.set_read_timeout(Some(HANDOFF_TIMEOUT));
                    read_handoffs(stream, &token, &*f);
                }
            })?;
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::paths::test_dir::TempDir;
    use std::sync::mpsc;

    #[test]
    fn second_launch_forwards_to_the_first() {
        let t = TempDir::new("ipc");
        let ep = t.0.join("x.sock");
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        assert!(matches!(
            claim(&ep, &[], move |h| tx.lock().unwrap().send(h).unwrap()),
            Claim::Primary
        ));
        let args = vec!["/tmp/a.desyn".to_string(), "desyn://new".to_string()];
        assert!(matches!(
            claim(&ep, &args, |_| panic!("not primary")),
            Claim::Forwarded
        ));
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("handoff arrives");
        assert_eq!(got.args, args);
    }

    #[test]
    fn a_silent_client_does_not_block_later_launches() {
        let t = TempDir::new("ipc-silent");
        let ep = t.0.join("x.sock");
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        assert!(matches!(
            claim(&ep, &[], move |h| tx.lock().unwrap().send(h).unwrap()),
            Claim::Primary
        ));
        // Connects and stays silent (held open for the whole test).
        let _silent = std::os::unix::net::UnixStream::connect(&ep).unwrap();
        let args = vec!["desyn://settings".to_string()];
        assert!(matches!(
            claim(&ep, &args, |_| panic!("not primary")),
            Claim::Forwarded
        ));
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(8))
            .expect("the second launch still gets through");
        assert_eq!(got.args, args);
    }
}
