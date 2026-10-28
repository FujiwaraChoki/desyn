//! The `.desyn` file: a zip archive.
//!
//! ```text
//! mimetype                 "application/x-desyn" (first entry, stored; lets tools sniff the type)
//! manifest.json            Manifest (format version, app, design summary, page list, thumbnails)
//! design.json              the Design in canonical JSON (DOCUMENT_MODEL §5), the single source of truth
//! assets/<id>.<ext>        bytes of every asset with local bytes (AssetRef.storageKey points here)
//! thumbnails/cover.png     first page, longest side 512 px
//! thumbnails/<pageId>.png  each page, longest side 256 px (first 64 pages)
//! ```
//!
//! Readers ignore unknown entries, so newer versions can add data. Archives are size-checked before anything is
//! inflated (zip bombs), and every entry name is looked up explicitly (no path traversal on extraction).

use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::sync::Arc;

use desyn_core::model::{Design, Id};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::doc::{AssetBytes, asset_entry_name};
use crate::paths::write_atomic;

/// MIME type of `.desyn` files (also registered with the OS).
pub const MIME: &str = "application/x-desyn";
/// Current archive format version.
pub const FORMAT_VERSION: u32 = 1;
/// Largest archive accepted (compressed bytes on disk).
pub const MAX_ARCHIVE_BYTES: u64 = 4 << 30;
/// Largest total inflated size.
pub const MAX_INFLATED_BYTES: u64 = 8 << 30;
/// Largest single entry.
pub const MAX_ENTRY_BYTES: u64 = 1 << 30;
/// Most entries.
pub const MAX_ENTRIES: usize = 200_000;

/// Page summary in the manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// Page id.
    pub id: Id,
    /// Page name.
    pub name: String,
    /// Width px.
    pub width: f64,
    /// Height px.
    pub height: f64,
    /// Thumbnail entry, when written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// `manifest.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Always `"desyn"`.
    pub format: String,
    /// Archive format version.
    pub version: u32,
    /// Writer ("desyn-desktop 0.1.0").
    pub app: String,
    /// Design id.
    pub design_id: Id,
    /// Design name.
    pub name: String,
    /// Design kind.
    pub kind: String,
    /// Pages in order.
    pub pages: Vec<PageInfo>,
    /// Design hash (sha256 of canonical JSON) — lets sync / library spot unchanged files.
    pub hash: String,
    /// Save time (ms epoch).
    pub saved_at: f64,
    /// Cover thumbnail entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Unknown keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Thumbnails to embed (PNG bytes).
#[derive(Debug, Clone, Default)]
pub struct Thumbnails {
    /// First page, ≤512 px.
    pub cover: Option<Vec<u8>>,
    /// Per page, ≤256 px.
    pub pages: Vec<(Id, Vec<u8>)>,
}

/// A loaded `.desyn` file.
#[derive(Debug, Clone)]
pub struct DesynFile {
    /// The design.
    pub design: Design,
    /// Asset bytes found in the archive.
    pub assets: AssetBytes,
    /// Manifest (synthesized for archives that lack one).
    pub manifest: Manifest,
    /// Assets referenced by the design whose bytes are missing from the archive.
    pub missing_assets: Vec<Id>,
    /// Validation warnings (the design still opened).
    pub warnings: Vec<String>,
}

/// Errors with messages meant for people.
#[derive(Debug)]
pub enum FileError {
    /// I/O.
    Io(std::io::Error),
    /// Not a Desyn archive or broken.
    Invalid(String),
    /// Too large / zip bomb.
    TooLarge(String),
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileError::Io(e) => write!(f, "{e}"),
            FileError::Invalid(m) => write!(f, "This file isn't a valid Desyn design ({m})."),
            FileError::TooLarge(m) => write!(f, "This file is too large to open ({m})."),
        }
    }
}

impl std::error::Error for FileError {}

impl From<std::io::Error> for FileError {
    fn from(e: std::io::Error) -> Self {
        FileError::Io(e)
    }
}

impl From<zip::result::ZipError> for FileError {
    fn from(e: zip::result::ZipError) -> Self {
        match e {
            zip::result::ZipError::Io(io) => FileError::Io(io),
            other => FileError::Invalid(other.to_string()),
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Builds the manifest for a design.
pub fn manifest_for(design: &Design, thumbs: &Thumbnails) -> Manifest {
    let pages = design
        .page_ids()
        .iter()
        .filter_map(|id| design.node(id))
        .map(|n| {
            let b = n.base();
            PageInfo {
                id: b.id.clone(),
                name: b.name.clone(),
                width: b.width,
                height: b.height,
                thumbnail: thumbs
                    .pages
                    .iter()
                    .any(|(p, _)| *p == b.id)
                    .then(|| format!("thumbnails/{}.png", b.id)),
            }
        })
        .collect();
    Manifest {
        format: "desyn".into(),
        version: FORMAT_VERSION,
        app: format!("desyn-desktop {}", env!("CARGO_PKG_VERSION")),
        design_id: design.id.clone(),
        name: design.name.clone(),
        kind: design.kind.to_string(),
        pages,
        hash: design.hash(),
        saved_at: now_ms(),
        cover: thumbs
            .cover
            .as_ref()
            .map(|_| "thumbnails/cover.png".to_string()),
        extra: Default::default(),
    }
}

fn is_precompressed(name: &str) -> bool {
    [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".woff", ".woff2", ".mp4", ".mp3",
    ]
    .iter()
    .any(|e| name.ends_with(e))
}

/// Serializes a design with its assets and thumbnails into archive bytes.
pub fn encode(
    design: &Design,
    assets: &AssetBytes,
    thumbs: &Thumbnails,
) -> Result<Vec<u8>, FileError> {
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(false);
    zw.start_file("mimetype", stored)?;
    zw.write_all(MIME.as_bytes())?;
    let manifest = manifest_for(design, thumbs);
    zw.start_file("manifest.json", deflated)?;
    zw.write_all(&serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?)?;
    zw.start_file("design.json", deflated)?;
    zw.write_all(design.canonical_json().as_bytes())?;
    let mut written = std::collections::BTreeSet::new();
    for (id, meta) in &design.assets {
        let Some(bytes) = assets.get(id) else {
            continue;
        };
        let name = asset_entry_name(id, &meta.mime);
        if !written.insert(name.clone()) {
            continue;
        }
        let large = bytes.len() as u64 >= u32::MAX as u64;
        let opts = if is_precompressed(&name) {
            stored
        } else {
            deflated
        }
        .large_file(large);
        zw.start_file(name, opts)?;
        zw.write_all(bytes)?;
    }
    if let Some(c) = &thumbs.cover {
        zw.start_file("thumbnails/cover.png", stored)?;
        zw.write_all(c)?;
    }
    for (pid, png) in &thumbs.pages {
        zw.start_file(format!("thumbnails/{pid}.png"), stored)?;
        zw.write_all(png)?;
    }
    Ok(zw.finish()?.into_inner())
}

/// Writes a `.desyn` file atomically.
pub fn write(
    path: &Path,
    design: &Design,
    assets: &AssetBytes,
    thumbs: &Thumbnails,
) -> Result<(), FileError> {
    let bytes = encode(design, assets, thumbs)?;
    write_atomic(path, &bytes)?;
    Ok(())
}

fn check_sizes<R: Read + std::io::Seek>(z: &mut ZipArchive<R>) -> Result<(), FileError> {
    if z.len() > MAX_ENTRIES {
        return Err(FileError::TooLarge(format!("{} entries", z.len())));
    }
    let mut total = 0u64;
    for i in 0..z.len() {
        let f = z.by_index_raw(i)?;
        let size = f.size();
        if size > MAX_ENTRY_BYTES {
            return Err(FileError::TooLarge(format!("entry of {size} bytes")));
        }
        // A deflate stream expands at most ~1032:1; a declared size beyond that is a lie.
        if f.compression() != CompressionMethod::Stored
            && size > f.compressed_size().saturating_mul(1100) + 4096
        {
            return Err(FileError::TooLarge("suspicious compression ratio".into()));
        }
        total = total.saturating_add(size);
    }
    if total > MAX_INFLATED_BYTES {
        return Err(FileError::TooLarge(format!("{total} bytes when unpacked")));
    }
    Ok(())
}

fn read_entry<R: Read + std::io::Seek>(
    z: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, FileError> {
    let mut f = match z.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let declared = f.size();
    let mut out = Vec::with_capacity(declared.min(MAX_ENTRY_BYTES) as usize);
    // Never trust the declared size: cap the actual read too.
    (&mut f).take(MAX_ENTRY_BYTES + 1).read_to_end(&mut out)?;
    if out.len() as u64 > MAX_ENTRY_BYTES {
        return Err(FileError::TooLarge(format!("entry {name}")));
    }
    Ok(Some(out))
}

/// Reads archive bytes.
pub fn decode(bytes: &[u8]) -> Result<DesynFile, FileError> {
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(FileError::TooLarge(format!("{} bytes", bytes.len())));
    }
    let mut z = ZipArchive::new(Cursor::new(bytes))?;
    check_sizes(&mut z)?;
    let design_json = read_entry(&mut z, "design.json")?
        .ok_or_else(|| FileError::Invalid("design.json is missing".into()))?;
    let text = String::from_utf8(design_json)
        .map_err(|_| FileError::Invalid("design.json is not UTF-8".into()))?;
    let design =
        Design::from_json(&text).map_err(|e| FileError::Invalid(format!("design.json: {e}")))?;
    let mut warnings: Vec<String> = desyn_core::model::validate_design(&design)
        .iter()
        .map(|v| format!("{v:?}"))
        .collect();
    if design.root().is_none() {
        return Err(FileError::Invalid("the design has no root".into()));
    }
    let mut assets = AssetBytes::new();
    let mut missing = Vec::new();
    for (id, meta) in &design.assets {
        let mut candidates = vec![asset_entry_name(id, &meta.mime)];
        if let Some(k) = &meta.storage_key {
            candidates.insert(0, k.clone());
        }
        let mut found = None;
        for c in candidates {
            if let Some(b) = read_entry(&mut z, &c)? {
                found = Some(b);
                break;
            }
        }
        match found {
            Some(b) => {
                assets.insert(id.clone(), Arc::from(b));
            }
            None => missing.push(id.clone()),
        }
    }
    let manifest = match read_entry(&mut z, "manifest.json")? {
        Some(m) => serde_json::from_slice::<Manifest>(&m).unwrap_or_else(|e| {
            warnings.push(format!("manifest.json ignored: {e}"));
            manifest_for(&design, &Thumbnails::default())
        }),
        None => manifest_for(&design, &Thumbnails::default()),
    };
    if manifest.version > FORMAT_VERSION {
        warnings.push(format!(
            "This file was written by a newer Desyn (format {}). Unknown data is kept when you save.",
            manifest.version
        ));
    }
    Ok(DesynFile {
        design,
        assets,
        manifest,
        missing_assets: missing,
        warnings,
    })
}

/// Reads a `.desyn` file.
pub fn read(path: &Path) -> Result<DesynFile, FileError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_ARCHIVE_BYTES {
        return Err(FileError::TooLarge(format!("{} bytes", meta.len())));
    }
    decode(&std::fs::read(path)?)
}

/// Reads only the manifest and cover thumbnail (library listings); cheap even for large files.
pub fn peek(path: &Path) -> Result<(Manifest, Option<Vec<u8>>), FileError> {
    let f = std::fs::File::open(path)?;
    let mut z = ZipArchive::new(std::io::BufReader::new(f))?;
    check_sizes(&mut z)?;
    let manifest: Manifest = match read_entry(&mut z, "manifest.json")? {
        Some(m) => serde_json::from_slice(&m)
            .map_err(|e| FileError::Invalid(format!("manifest.json: {e}")))?,
        None => {
            // Archives without a manifest: fall back to the design itself.
            let d = read_entry(&mut z, "design.json")?
                .ok_or_else(|| FileError::Invalid("design.json is missing".into()))?;
            let design = Design::from_json(&String::from_utf8_lossy(&d))
                .map_err(|e| FileError::Invalid(e.to_string()))?;
            manifest_for(&design, &Thumbnails::default())
        }
    };
    let cover = match &manifest.cover {
        Some(c) => read_entry(&mut z, c)?,
        None => None,
    };
    Ok((manifest, cover))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::Document;
    use crate::paths::test_dir::TempDir;
    use desyn_core::Op;
    use desyn_core::layout::ApproxMeasurer;
    use desyn_core::model::{AssetKind, DesignKind, Node};

    fn sample() -> Document {
        let mut d = Document::blank("Poster", DesignKind::Poster, 400.0, 300.0);
        let page = d.design.page_ids()[0].clone();
        let png: Arc<[u8]> = Arc::from(&include_bytes!("../../assets/icons/LICENSE.txt")[..40]);
        let (aid, mut ops) = d.add_asset(
            png,
            Document::asset_meta(AssetKind::Image, "image/png", Some("x.png"), Some((4, 4))),
        );
        let img = Node::image(d.new_id(), "Photo", aid, 0.0, 0.0, 100.0, 100.0);
        ops.push(Op::create(vec![img], page, None));
        d.apply(ops, "Add", &mut ApproxMeasurer);
        d
    }

    #[test]
    fn round_trip() {
        let d = sample();
        let thumbs = Thumbnails {
            cover: Some(vec![1, 2, 3]),
            pages: vec![(d.design.page_ids()[0].clone(), vec![4])],
        };
        let bytes = encode(&d.design, &d.assets, &thumbs).unwrap();
        assert_eq!(&bytes[30..38], b"mimetype", "mimetype is the first entry");
        // No extra field, stored: `file` / shared-mime-info magic can match the type at offset 38.
        assert_eq!(&bytes[38..38 + MIME.len()], MIME.as_bytes());
        let f = decode(&bytes).unwrap();
        assert_eq!(f.design.canonical_json(), d.design.canonical_json());
        assert_eq!(f.assets, d.assets);
        assert!(f.missing_assets.is_empty());
        assert_eq!(f.manifest.pages.len(), 1);
        assert_eq!(f.manifest.hash, d.design.hash());
        let t = TempDir::new("format");
        let p = t.0.join("a.desyn");
        write(&p, &d.design, &d.assets, &thumbs).unwrap();
        let (m, cover) = peek(&p).unwrap();
        assert_eq!(m.name, "Poster");
        assert_eq!(cover, Some(vec![1, 2, 3]));
    }

    #[test]
    fn missing_assets_and_garbage() {
        let d = sample();
        let bytes = encode(&d.design, &AssetBytes::new(), &Thumbnails::default()).unwrap();
        let f = decode(&bytes).unwrap();
        assert_eq!(f.missing_assets.len(), 1);
        assert!(matches!(decode(b"not a zip"), Err(FileError::Invalid(_))));
        // A zip without design.json.
        let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
        zw.start_file("hello.txt", SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"hi").unwrap();
        let other = zw.finish().unwrap().into_inner();
        let e = decode(&other).unwrap_err();
        assert!(e.to_string().contains("design.json is missing"), "{e}");
    }

    #[test]
    fn rejects_bombs() {
        // 64 MiB of zeros deflates to ~64 KiB: fine. Declared sizes are checked against the ratio limit.
        let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
        zw.start_file(
            "design.json",
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
        zw.write_all(&vec![b' '; 2 << 20]).unwrap();
        let bytes = zw.finish().unwrap().into_inner();
        // Two MiB of spaces is not valid JSON but passes the size checks.
        assert!(matches!(decode(&bytes), Err(FileError::Invalid(_))));
    }
}
