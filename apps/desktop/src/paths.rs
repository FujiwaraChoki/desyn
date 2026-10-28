//! Where the app keeps its files. Everything can be relocated with `DESYN_HOME` (portable installs, tests and
//! smoke runs never touch the real profile): `$DESYN_HOME/config`, `$DESYN_HOME/data`, `$DESYN_HOME/Library`.

use std::path::{Path, PathBuf};

/// Resolved application directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// Settings, recent files (`~/.config/desyn` on Linux).
    pub config_dir: PathBuf,
    /// Recovery snapshots, caches (`~/.local/share/desyn` on Linux).
    pub data_dir: PathBuf,
    /// Default library folder for new designs (`~/Documents/Desyn`).
    pub default_library: PathBuf,
}

impl AppPaths {
    /// Paths for this machine, honoring `DESYN_HOME`.
    pub fn detect() -> AppPaths {
        if let Some(home) = std::env::var_os("DESYN_HOME").filter(|v| !v.is_empty()) {
            return AppPaths::rooted(Path::new(&home));
        }
        let name = if cfg!(target_os = "linux") {
            "desyn"
        } else {
            "Desyn"
        };
        let fallback = std::env::temp_dir().join("desyn");
        let config_dir = dirs::config_dir()
            .map(|d| d.join(name))
            .unwrap_or_else(|| fallback.join("config"));
        let data_dir = dirs::data_dir()
            .map(|d| d.join(name))
            .unwrap_or_else(|| fallback.join("data"));
        let default_library = dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|d| d.join("Desyn"))
            .unwrap_or_else(|| fallback.join("Library"));
        AppPaths {
            config_dir,
            data_dir,
            default_library,
        }
    }

    /// All paths below one root directory.
    pub fn rooted(root: &Path) -> AppPaths {
        AppPaths {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            default_library: root.join("Library"),
        }
    }

    /// `settings.json`.
    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    /// `recent.json` (recently opened files).
    pub fn recent_file(&self) -> PathBuf {
        self.config_dir.join("recent.json")
    }

    /// Crash-recovery sessions.
    pub fn recovery_dir(&self) -> PathBuf {
        self.data_dir.join("recovery")
    }

    /// Library thumbnail / metadata cache.
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    /// Endpoint of the single-instance channel (a Unix socket path, or a file holding the loopback port on
    /// Windows).
    pub fn instance_endpoint(&self) -> PathBuf {
        let preferred = match dirs::runtime_dir() {
            Some(rt) if std::env::var_os("DESYN_HOME").is_none() => rt.join("desyn.sock"),
            _ => self.data_dir.join("instance.sock"),
        };
        // Unix socket paths are limited to ~104 bytes: deep folders fall back to a stable name in the temp dir.
        if preferred.as_os_str().len() <= 100 {
            return preferred;
        }
        let digest = desyn_core::canonical::sha256_hex(preferred.as_os_str().as_encoded_bytes());
        std::env::temp_dir().join(format!("desyn-{}.sock", &digest[..16]))
    }
}

/// Writes `bytes` to `path` atomically: a sibling temp file is written, flushed and renamed over the target, so a
/// crash never leaves a half-written document or settings file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// A file name that does not exist yet in `dir`: `stem.ext`, then `stem 2.ext`, `stem 3.ext`, ...
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let clean = sanitize_file_stem(stem);
    let first = dir.join(format!("{clean}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{clean} {n}.{ext}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

/// Replaces characters that are invalid in file names on any desktop OS and trims the result.
pub fn sanitize_file_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(120).collect();
    if out.is_empty() {
        out = "Untitled design".into();
    }
    out
}

#[cfg(test)]
pub(crate) mod test_dir {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh directory under the system temp dir, removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> TempDir {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "desyn-desktop-test-{tag}-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).expect("temp dir");
            TempDir(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_endpoints_fall_back_to_temp() {
        let p = AppPaths::rooted(Path::new(&"/very/deep/folder".repeat(10)));
        let e = p.instance_endpoint();
        assert!(e.as_os_str().len() <= 100 || e.starts_with(std::env::temp_dir()));
        assert_eq!(e, p.instance_endpoint(), "stable");
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_stem("a/b:c?"), "a-b-c-");
        assert_eq!(sanitize_file_stem("  ...  "), "Untitled design");
        assert_eq!(sanitize_file_stem("Poster\n2026"), "Poster 2026");
    }

    #[test]
    fn unique_and_atomic() {
        let t = test_dir::TempDir::new("paths");
        let a = unique_path(&t.0, "Poster", "desyn");
        write_atomic(&a, b"one").unwrap();
        let b = unique_path(&t.0, "Poster", "desyn");
        assert_eq!(b.file_name().unwrap(), "Poster 2.desyn");
        write_atomic(&a, b"two").unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(&t.0).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "no temp files left behind");
    }
}
