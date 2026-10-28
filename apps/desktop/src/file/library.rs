//! The local library: a folder of `.desyn` files (any folder the user picks; `~/Documents/Desyn` by default) and
//! the list of recently opened files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::format::{self, Manifest};
use crate::paths::{unique_path, write_atomic};

/// A design in the library folder.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryItem {
    /// File path.
    pub path: PathBuf,
    /// Design name (from the manifest; the file name when unreadable).
    pub name: String,
    /// Design kind string.
    pub kind: String,
    /// Number of pages.
    pub pages: usize,
    /// Size of the first page (px).
    pub size: Option<(f64, f64)>,
    /// Last modification time.
    pub modified: SystemTime,
    /// Cover thumbnail PNG.
    pub cover: Option<std::sync::Arc<Vec<u8>>>,
    /// Problem reading the file (shown on the card; the file can still be revealed or removed).
    pub error: Option<String>,
}

/// Library scanner with a cache keyed by path + mtime, so rescans only read files that changed.
#[derive(Debug, Default)]
pub struct Library {
    cache: HashMap<PathBuf, (SystemTime, LibraryItem)>,
}

impl Library {
    /// Lists `.desyn` files directly inside `dir` and one level of subfolders, newest first.
    pub fn scan(&mut self, dir: &Path) -> Vec<LibraryItem> {
        let mut files = Vec::new();
        collect(dir, 1, &mut files);
        let mut items = Vec::with_capacity(files.len());
        for (path, modified) in files {
            if let Some((m, item)) = self.cache.get(&path)
                && *m == modified
            {
                items.push(item.clone());
                continue;
            }
            let item = read_item(&path, modified);
            self.cache.insert(path.clone(), (modified, item.clone()));
            items.push(item);
        }
        self.cache.retain(|p, _| items.iter().any(|i| &i.path == p));
        items.sort_by(|a, b| {
            b.modified
                .cmp(&a.modified)
                .then_with(|| a.name.cmp(&b.name))
        });
        items
    }

    /// Drops the cached entry of a file (after saving it).
    pub fn invalidate(&mut self, path: &Path) {
        self.cache.remove(path);
    }
}

fn collect(dir: &Path, depth: u32, out: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                collect(&p, depth - 1, out);
            }
        } else if p
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case(crate::deeplink::DOCUMENT_EXT))
        {
            out.push((p, meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
        }
    }
}

fn read_item(path: &Path, modified: SystemTime) -> LibraryItem {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match format::peek(path) {
        Ok((m, cover)) => item_from_manifest(path, modified, &m, cover),
        Err(e) => LibraryItem {
            path: path.to_path_buf(),
            name: stem,
            kind: String::new(),
            pages: 0,
            size: None,
            modified,
            cover: None,
            error: Some(e.to_string()),
        },
    }
}

fn item_from_manifest(
    path: &Path,
    modified: SystemTime,
    m: &Manifest,
    cover: Option<Vec<u8>>,
) -> LibraryItem {
    LibraryItem {
        path: path.to_path_buf(),
        name: if m.name.trim().is_empty() {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            m.name.clone()
        },
        kind: m.kind.clone(),
        pages: m.pages.len(),
        size: m.pages.first().map(|p| (p.width, p.height)),
        modified,
        cover: cover.map(std::sync::Arc::new),
        error: None,
    }
}

/// Path for a new design in the library (`<library>/<name>.desyn`, numbered when taken).
pub fn new_design_path(library: &Path, name: &str) -> PathBuf {
    unique_path(library, name, crate::deeplink::DOCUMENT_EXT)
}

/// One recently opened file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    /// File path.
    pub path: PathBuf,
    /// Name at the time it was opened.
    pub name: String,
    /// When it was last opened (ms epoch).
    pub opened_at: f64,
}

/// Recently opened files, newest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecentFiles {
    /// Entries.
    pub entries: Vec<RecentEntry>,
}

impl RecentFiles {
    /// Maximum kept.
    pub const MAX: usize = 30;

    /// Loads the list (empty when missing or invalid).
    pub fn load(path: &Path) -> RecentFiles {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Saves atomically.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_atomic(
            path,
            &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?,
        )
    }

    /// Moves `path` to the front.
    pub fn touch(&mut self, path: &Path, name: &str, now_ms: f64) {
        self.entries.retain(|e| e.path != path);
        self.entries.insert(
            0,
            RecentEntry {
                path: path.to_path_buf(),
                name: name.to_string(),
                opened_at: now_ms,
            },
        );
        self.entries.truncate(Self::MAX);
    }

    /// Removes a path.
    pub fn remove(&mut self, path: &Path) {
        self.entries.retain(|e| e.path != path);
    }

    /// Updates the path after "Save As" / rename.
    pub fn rename(&mut self, from: &Path, to: &Path, name: &str) {
        for e in &mut self.entries {
            if e.path == from {
                e.path = to.to_path_buf();
                e.name = name.to_string();
            }
        }
    }

    /// Entries whose files still exist.
    pub fn existing(&self) -> Vec<RecentEntry> {
        self.entries
            .iter()
            .filter(|e| e.path.exists())
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::Document;
    use crate::file::format::{Thumbnails, write};
    use crate::paths::test_dir::TempDir;
    use desyn_core::model::DesignKind;

    #[test]
    fn scans_and_caches() {
        let t = TempDir::new("library");
        let a = Document::blank("Alpha", DesignKind::Poster, 100.0, 200.0);
        write(
            &t.0.join("a.desyn"),
            &a.design,
            &a.assets,
            &Thumbnails {
                cover: Some(vec![9]),
                pages: vec![],
            },
        )
        .unwrap();
        std::fs::create_dir_all(t.0.join("sub")).unwrap();
        let b = Document::blank("Beta", DesignKind::Flyer, 10.0, 20.0);
        write(
            &t.0.join("sub/b.desyn"),
            &b.design,
            &b.assets,
            &Thumbnails::default(),
        )
        .unwrap();
        std::fs::write(t.0.join("broken.desyn"), b"junk").unwrap();
        std::fs::write(t.0.join("notes.txt"), b"x").unwrap();
        let mut lib = Library::default();
        let items = lib.scan(&t.0);
        assert_eq!(items.len(), 3);
        let alpha = items.iter().find(|i| i.name == "Alpha").unwrap();
        assert_eq!(alpha.size, Some((100.0, 200.0)));
        assert_eq!(alpha.cover.as_deref(), Some(&vec![9]));
        assert!(
            items
                .iter()
                .any(|i| i.name == "broken" && i.error.is_some())
        );
        assert_eq!(lib.scan(&t.0), items);
        std::fs::remove_file(t.0.join("sub/b.desyn")).unwrap();
        assert_eq!(lib.scan(&t.0).len(), 2);
        assert_eq!(new_design_path(&t.0, "a").file_name().unwrap(), "a 2.desyn");
    }

    #[test]
    fn recent_files() {
        let t = TempDir::new("recent");
        let p = t.0.join("recent.json");
        let mut r = RecentFiles::default();
        for i in 0..40 {
            r.touch(Path::new(&format!("/x/{i}.desyn")), "n", i as f64);
        }
        r.touch(Path::new("/x/5.desyn"), "five", 99.0);
        assert_eq!(r.entries.len(), RecentFiles::MAX);
        assert_eq!(r.entries[0].name, "five");
        r.rename(Path::new("/x/5.desyn"), Path::new("/y/5.desyn"), "moved");
        r.save(&p).unwrap();
        let back = RecentFiles::load(&p);
        assert_eq!(back.entries[0].path, PathBuf::from("/y/5.desyn"));
        assert!(back.existing().is_empty());
    }
}
