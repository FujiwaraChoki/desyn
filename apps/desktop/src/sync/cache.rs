//! Offline cache of cloud designs: `<data>/cloud/<server>/<designId>/` holds the confirmed design, the pending
//! transactions and the seq (`state.json`), and the bytes of the design's assets, so a cloud design opens and edits
//! without a connection and its changes are sent when the app reconnects. A small `links.json` per server maps local
//! `.desyn` files that were uploaded to their cloud design.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use desyn_core::model::Design;
use serde::{Deserialize, Serialize};

use super::engine::EngineState;
use crate::doc::AssetBytes;
use crate::paths::write_atomic;

/// Cached metadata next to the design.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheMeta {
    /// Convex design id.
    pub design_id: String,
    /// Workspace.
    pub workspace_id: String,
    /// Name (for offline listings).
    pub name: String,
    /// Caller's permission.
    pub permission: String,
    /// Last time it was synced (ms).
    pub synced_at: f64,
}

/// Everything in the cache for one design.
#[derive(Debug, Clone)]
pub struct Cached {
    /// Confirmed design.
    pub confirmed: Design,
    /// Seq + pending.
    pub state: EngineState,
    /// Metadata.
    pub meta: CacheMeta,
}

#[derive(Serialize, Deserialize)]
struct StateFile {
    meta: CacheMeta,
    engine: EngineState,
}

/// A server's cache folder (`<data>/cloud/<host>`).
pub fn server_dir(data_dir: &Path, convex_url: &str) -> PathBuf {
    let host: String = convex_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    data_dir.join("cloud").join(host)
}

fn safe_id(id: &str) -> Option<&str> {
    (!id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

/// The folder of one design.
pub fn design_dir(server: &Path, design_id: &str) -> Option<PathBuf> {
    safe_id(design_id).map(|id| server.join(id))
}

/// Writes the confirmed design and state (atomic).
pub fn save(
    dir: &Path,
    confirmed: &Design,
    state: &EngineState,
    meta: &CacheMeta,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    write_atomic(
        &dir.join("design.json"),
        confirmed.canonical_json().as_bytes(),
    )?;
    let file = StateFile {
        meta: meta.clone(),
        engine: state.clone(),
    };
    let json = serde_json::to_vec(&file).map_err(std::io::Error::other)?;
    write_atomic(&dir.join("state.json"), &json)
}

/// Reads a cached design.
pub fn load(dir: &Path) -> Option<Cached> {
    let design = std::fs::read_to_string(dir.join("design.json")).ok()?;
    let confirmed = Design::from_json(&design).ok()?;
    let state: StateFile =
        serde_json::from_slice(&std::fs::read(dir.join("state.json")).ok()?).ok()?;
    Some(Cached {
        confirmed,
        state: state.engine,
        meta: state.meta,
    })
}

/// Stores asset bytes.
pub fn save_asset(dir: &Path, id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let Some(id) = safe_id(id) else { return Ok(()) };
    let d = dir.join("assets");
    std::fs::create_dir_all(&d)?;
    let p = d.join(id);
    if p.exists() {
        return Ok(());
    }
    write_atomic(&p, bytes)
}

/// Loads the cached bytes of the design's assets.
pub fn load_assets(dir: &Path, design: &Design) -> AssetBytes {
    let mut out = BTreeMap::new();
    for id in design.assets.keys() {
        if let Some(sid) = safe_id(id)
            && let Ok(b) = std::fs::read(dir.join("assets").join(sid))
        {
            out.insert(id.clone(), Arc::from(b));
        }
    }
    out
}

/// Cached designs of a server (offline library), newest first.
pub fn list(server: &Path) -> Vec<CacheMeta> {
    let mut out: Vec<CacheMeta> = std::fs::read_dir(server)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let s: StateFile =
                serde_json::from_slice(&std::fs::read(e.path().join("state.json")).ok()?).ok()?;
            Some(s.meta)
        })
        .collect();
    out.sort_by(|a, b| b.synced_at.total_cmp(&a.synced_at));
    out
}

/// Removes a design's cache.
pub fn remove(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// Local files linked to cloud designs (`links.json`: path -> design id).
pub fn read_links(server: &Path) -> BTreeMap<PathBuf, String> {
    std::fs::read(server.join("links.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Records a link.
pub fn write_link(server: &Path, file: &Path, design_id: Option<&str>) -> std::io::Result<()> {
    let mut links = read_links(server);
    match design_id {
        Some(id) => {
            links.insert(file.to_path_buf(), id.to_string());
        }
        None => {
            links.remove(file);
        }
    }
    std::fs::create_dir_all(server)?;
    write_atomic(
        &server.join("links.json"),
        &serde_json::to_vec_pretty(&links).map_err(std::io::Error::other)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::test_dir::TempDir;
    use desyn_core::model::DesignKind;

    #[test]
    fn roundtrip_and_listing() {
        let tmp = TempDir::new("cloud-cache");
        let server = server_dir(&tmp.0, "https://x-1.eu-west-1.convex.cloud");
        assert!(server.ends_with("cloud/x-1.eu-west-1.convex.cloud"));
        let dir = design_dir(&server, "k57abc").unwrap();
        assert!(design_dir(&server, "../etc").is_none());
        let d = Design::with_page(
            "design000001",
            "Hello",
            DesignKind::Poster,
            "page00000001",
            10.0,
            10.0,
        );
        let state = EngineState {
            seq: 4,
            pending: vec![],
        };
        let meta = CacheMeta {
            design_id: "k57abc".into(),
            name: "Hello".into(),
            synced_at: 5.0,
            ..Default::default()
        };
        save(&dir, &d, &state, &meta).unwrap();
        save_asset(&dir, "asset0000001", b"bytes").unwrap();
        let c = load(&dir).unwrap();
        assert_eq!(c.state.seq, 4);
        assert_eq!(c.meta, meta);
        assert_eq!(c.confirmed.canonical_json(), d.canonical_json());
        assert_eq!(list(&server).len(), 1);
        let file = tmp.0.join("a.desyn");
        write_link(&server, &file, Some("k57abc")).unwrap();
        assert_eq!(
            read_links(&server).get(&file).map(String::as_str),
            Some("k57abc")
        );
        write_link(&server, &file, None).unwrap();
        assert!(read_links(&server).is_empty());
        remove(&dir);
        assert!(load(&dir).is_none());
    }
}
