//! Launch requests: command-line arguments, files handed over by the OS (file associations, drag onto the dock
//! icon) and `desyn://` deep links. Setup per OS is documented in `apps/desktop/README.md` ("File associations and
//! deep links").
//!
//! Deep links:
//! * `desyn://open?path=<absolute path>` — open a `.desyn` file (or import an SVG / image / JSON into a new design).
//! * `desyn://new` — new design; optional `preset=<id>` or `w=<px>&h=<px>`, `kind=<DesignKind>`, `name=<text>`.
//! * `desyn://design/<id>` — open a cloud design (handled by the sync module through [`LaunchRequest::Cloud`]).
//! * `desyn://auth/callback?code=..&state=..` — native sign-in redirect (handled by the account module).
//! * `desyn://settings` — open Settings.

use std::path::{Path, PathBuf};

/// Something the app was asked to do at launch or while running.
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchRequest {
    /// Open a `.desyn` document.
    Open(PathBuf),
    /// Create a design from an importable file (SVG, image, design JSON).
    Import(PathBuf),
    /// New blank design.
    New(NewDesign),
    /// Cloud design id (`desyn://design/<id>`).
    Cloud {
        /// Convex design id.
        design_id: String,
    },
    /// Native auth redirect (`desyn://auth/callback`), with every query parameter.
    AuthCallback {
        /// Query parameters in order.
        params: Vec<(String, String)>,
    },
    /// Open Settings.
    Settings,
    /// Just bring the app forward (no arguments).
    Focus,
}

/// Parameters of a new design.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NewDesign {
    /// Preset id.
    pub preset: Option<String>,
    /// Custom width in px.
    pub width: Option<f64>,
    /// Custom height in px.
    pub height: Option<f64>,
    /// Design kind string.
    pub kind: Option<String>,
    /// Document name.
    pub name: Option<String>,
}

/// Errors are user-facing strings (shown in a toast).
pub type ParseError = String;

/// Extensions the app opens directly.
pub const DOCUMENT_EXT: &str = "desyn";

/// Extensions imported into a new design.
pub const IMPORT_EXTS: [&str; 8] = ["svg", "png", "jpg", "jpeg", "webp", "gif", "bmp", "json"];

/// Classifies one command-line argument (path or URL). Relative paths resolve against `cwd`.
pub fn parse_arg(arg: &str, cwd: &Path) -> Result<LaunchRequest, ParseError> {
    if arg.starts_with("desyn:") {
        return parse_url(arg);
    }
    if let Some(rest) = arg.strip_prefix("file://") {
        return classify_path(PathBuf::from(percent_decode(rest)));
    }
    let p = PathBuf::from(arg);
    classify_path(if p.is_absolute() { p } else { cwd.join(p) })
}

/// Parses launch arguments (skipping flags such as `--new-window`).
pub fn parse_args(args: &[String], cwd: &Path) -> (Vec<LaunchRequest>, Vec<ParseError>) {
    let mut ok = Vec::new();
    let mut errors = Vec::new();
    for a in args.iter().filter(|a| !a.starts_with("--")) {
        match parse_arg(a, cwd) {
            Ok(r) => ok.push(r),
            Err(e) => errors.push(e),
        }
    }
    (ok, errors)
}

fn classify_path(p: PathBuf) -> Result<LaunchRequest, ParseError> {
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == DOCUMENT_EXT {
        Ok(LaunchRequest::Open(p))
    } else if IMPORT_EXTS.contains(&ext.as_str()) {
        Ok(LaunchRequest::Import(p))
    } else {
        Err(format!(
            "Desyn can't open “{}”. Open a .desyn file, or import SVG, PNG, JPEG, WebP or JSON.",
            p.display()
        ))
    }
}

/// Parses a `desyn://` URL.
pub fn parse_url(url: &str) -> Result<LaunchRequest, ParseError> {
    let rest = url
        .strip_prefix("desyn://")
        .or_else(|| url.strip_prefix("desyn:"))
        .ok_or_else(|| format!("Not a Desyn link: {url}"))?;
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, q),
        None => (rest, ""),
    };
    let path = path.split('#').next().unwrap_or("").trim_matches('/');
    let params = parse_query(query);
    let get = |k: &str| {
        params
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    match (segs.next(), segs.next()) {
        (None, _) => Ok(LaunchRequest::Focus),
        (Some("open"), None) => {
            let p = get("path").ok_or("This link has no file path.")?;
            let pb = PathBuf::from(&p);
            if !pb.is_absolute() {
                return Err("Desyn links must use an absolute file path.".into());
            }
            classify_path(pb)
        }
        (Some("new"), None) => {
            let num = |k: &str| -> Result<Option<f64>, ParseError> {
                match get(k) {
                    None => Ok(None),
                    Some(v) => v
                        .parse::<f64>()
                        .ok()
                        .filter(|n| n.is_finite() && *n >= 1.0 && *n <= 100_000.0)
                        .map(Some)
                        .ok_or_else(|| format!("“{k}={v}” is not a size between 1 and 100000 px.")),
                }
            };
            Ok(LaunchRequest::New(NewDesign {
                preset: get("preset"),
                width: num("w")?,
                height: num("h")?,
                kind: get("kind"),
                name: get("name").map(|n| n.chars().take(200).collect()),
            }))
        }
        (Some("design"), Some(id)) if segs.next().is_none() && valid_cloud_id(id) => {
            Ok(LaunchRequest::Cloud {
                design_id: id.to_string(),
            })
        }
        (Some("auth"), Some("callback")) if segs.next().is_none() => {
            Ok(LaunchRequest::AuthCallback { params })
        }
        (Some("settings"), None) => Ok(LaunchRequest::Settings),
        _ => Err(format!("Desyn doesn't know the link “{url}”.")),
    }
}

fn valid_cloud_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `a=1&b=x%20y` -> pairs (`+` is a space, as in form encoding).
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (
                percent_decode(&k.replace('+', " ")),
                percent_decode(&v.replace('+', " ")),
            )
        })
        .collect()
}

/// Decodes `%XX` escapes (invalid escapes are kept verbatim; invalid UTF-8 is replaced).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Percent-encodes a query value (RFC 3986 unreserved characters stay).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `desyn://open?path=...` for a file (used by "Copy link to file").
pub fn open_url_for(path: &Path) -> String {
    format!(
        "desyn://open?path={}",
        percent_encode(&path.to_string_lossy())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args() {
        let cwd = Path::new("/home/u");
        assert_eq!(
            parse_arg("a.desyn", cwd),
            Ok(LaunchRequest::Open("/home/u/a.desyn".into()))
        );
        assert_eq!(
            parse_arg("/x/Logo.SVG", cwd),
            Ok(LaunchRequest::Import("/x/Logo.SVG".into()))
        );
        assert_eq!(
            parse_arg("file:///x/My%20Poster.desyn", cwd),
            Ok(LaunchRequest::Open("/x/My Poster.desyn".into()))
        );
        assert!(parse_arg("notes.txt", cwd).is_err());
        let (ok, err) = parse_args(
            &["--new-window".into(), "b.png".into(), "c.doc".into()],
            cwd,
        );
        assert_eq!(ok, vec![LaunchRequest::Import("/home/u/b.png".into())]);
        assert_eq!(err.len(), 1);
    }

    #[test]
    fn urls() {
        assert_eq!(parse_url("desyn://"), Ok(LaunchRequest::Focus));
        assert_eq!(
            parse_url("desyn://open?path=%2Ftmp%2FMy%20Poster.desyn"),
            Ok(LaunchRequest::Open("/tmp/My Poster.desyn".into()))
        );
        assert!(parse_url("desyn://open?path=relative.desyn").is_err());
        assert_eq!(
            parse_url("desyn://new?preset=instagram-post&name=Launch+day"),
            Ok(LaunchRequest::New(NewDesign {
                preset: Some("instagram-post".into()),
                name: Some("Launch day".into()),
                ..Default::default()
            }))
        );
        assert_eq!(
            parse_url("desyn://new?w=800&h=600&kind=poster"),
            Ok(LaunchRequest::New(NewDesign {
                width: Some(800.0),
                height: Some(600.0),
                kind: Some("poster".into()),
                ..Default::default()
            }))
        );
        assert!(parse_url("desyn://new?w=-3").is_err());
        assert_eq!(
            parse_url("desyn://design/jd7abc_12"),
            Ok(LaunchRequest::Cloud {
                design_id: "jd7abc_12".into()
            })
        );
        assert!(parse_url("desyn://design/../../etc").is_err());
        assert_eq!(
            parse_url("desyn://auth/callback?code=abc&state=s1"),
            Ok(LaunchRequest::AuthCallback {
                params: vec![("code".into(), "abc".into()), ("state".into(), "s1".into())]
            })
        );
        assert_eq!(parse_url("desyn://settings"), Ok(LaunchRequest::Settings));
        assert!(parse_url("desyn://nope").is_err());
    }

    #[test]
    fn percent_round_trip() {
        let p = Path::new("/home/me/Designs/Fête & co.desyn");
        let url = open_url_for(p);
        assert!(url.starts_with("desyn://open?path=/home/me/Designs/F%C3%AAte%20%26%20co.desyn"));
        assert_eq!(parse_url(&url), Ok(LaunchRequest::Open(p.into())));
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
    }
}
