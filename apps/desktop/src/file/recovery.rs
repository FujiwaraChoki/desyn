//! Crash recovery. Each running app owns a session folder `recovery/<session>/` holding an exclusively locked
//! `lock` file. While a design has unsaved changes the editor writes a snapshot (`<key>.desyn` + `<key>.json`)
//! every few seconds; a clean save or close removes it. On start, folders whose lock can be taken belong to
//! sessions that ended without cleaning up (a crash, a killed process, power loss): their snapshots are offered
//! for recovery.

use std::fs::File;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::write_atomic;

/// Metadata stored next to a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    /// File the design belongs to (`None` = never saved).
    pub origin: Option<PathBuf>,
    /// Design name.
    pub name: String,
    /// Snapshot time (ms epoch).
    pub saved_at: f64,
}

/// A snapshot left behind by an ended session.
#[derive(Debug, Clone, PartialEq)]
pub struct Orphan {
    /// Archive with the recovered design.
    pub file: PathBuf,
    /// Metadata.
    pub info: SnapshotInfo,
    /// Session folder it lives in.
    pub session_dir: PathBuf,
}

/// This process's recovery session.
pub struct RecoverySession {
    dir: PathBuf,
    _lock: Option<File>,
}

fn session_name() -> String {
    let mut raw = [0u8; 6];
    let _ = getrandom::fill(&mut raw);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!(
        "{ts}-{}-{}",
        std::process::id(),
        raw.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

impl RecoverySession {
    /// Creates and locks a new session folder under `root`.
    pub fn start(root: &Path) -> std::io::Result<RecoverySession> {
        let dir = root.join(session_name());
        std::fs::create_dir_all(&dir)?;
        let lock = File::create(dir.join("lock"))?;
        // Held until the process exits (the OS releases it on a crash too).
        lock.try_lock()
            .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
        Ok(RecoverySession {
            dir,
            _lock: Some(lock),
        })
    }

    /// Session folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn files(&self, key: &str) -> (PathBuf, PathBuf) {
        let safe: String = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        (
            self.dir.join(format!("{safe}.desyn")),
            self.dir.join(format!("{safe}.json")),
        )
    }

    /// Writes (replaces) the snapshot of one open design. `key` identifies the editor (stable while it is open).
    pub fn write(&self, key: &str, archive: &[u8], info: &SnapshotInfo) -> std::io::Result<()> {
        let (a, j) = self.files(key);
        write_atomic(&a, archive)?;
        write_atomic(
            &j,
            &serde_json::to_vec(info).map_err(std::io::Error::other)?,
        )
    }

    /// Removes a snapshot (after a successful save, or when the design closes without unsaved changes).
    pub fn discard(&self, key: &str) {
        let (a, j) = self.files(key);
        let _ = std::fs::remove_file(a);
        let _ = std::fs::remove_file(j);
    }

    /// Removes the whole session (clean shutdown).
    pub fn finish(mut self) {
        self._lock = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Snapshots of sessions that ended without cleaning up. `own` is skipped.
pub fn find_orphans(root: &Path, own: Option<&Path>) -> Vec<Orphan> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() || own.is_some_and(|o| o == dir) {
            continue;
        }
        let alive = match File::options()
            .read(true)
            .write(true)
            .open(dir.join("lock"))
        {
            Ok(f) => match f.try_lock() {
                Ok(()) => {
                    let _ = f.unlock();
                    false
                }
                Err(_) => true,
            },
            Err(_) => false,
        };
        if alive {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut found = false;
        for f in files.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|x| x == "json") {
                let archive = p.with_extension("desyn");
                let info = std::fs::read(&p)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<SnapshotInfo>(&b).ok());
                if let Some(info) = info
                    && archive.exists()
                {
                    found = true;
                    out.push(Orphan {
                        file: archive,
                        info,
                        session_dir: dir.clone(),
                    });
                }
            }
        }
        if !found {
            // Nothing to recover: tidy the dead session away.
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    out.sort_by(|a, b| b.info.saved_at.total_cmp(&a.info.saved_at));
    out
}

/// Deletes a recovered snapshot (after it was reopened or dismissed); removes the session folder once empty.
pub fn remove_orphan(o: &Orphan) {
    let _ = std::fs::remove_file(&o.file);
    let _ = std::fs::remove_file(o.file.with_extension("json"));
    let remaining = std::fs::read_dir(&o.session_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "desyn"))
                .count()
        })
        .unwrap_or(0);
    if remaining == 0 {
        let _ = std::fs::remove_dir_all(&o.session_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::test_dir::TempDir;

    #[test]
    fn live_sessions_are_not_orphans_and_dead_ones_are() {
        let t = TempDir::new("recovery");
        let mine = RecoverySession::start(&t.0).unwrap();
        let info = SnapshotInfo {
            origin: None,
            name: "Poster".into(),
            saved_at: 5.0,
        };
        mine.write("ed/1", b"zip", &info).unwrap();
        assert!(
            find_orphans(&t.0, None).is_empty(),
            "our own locked session is alive"
        );
        // Simulate a crashed session: a folder with an unlocked lock file and a snapshot.
        let dead = t.0.join("123-dead");
        std::fs::create_dir_all(&dead).unwrap();
        std::fs::write(dead.join("lock"), b"").unwrap();
        std::fs::write(dead.join("k.desyn"), b"zip").unwrap();
        std::fs::write(dead.join("k.json"), serde_json::to_vec(&info).unwrap()).unwrap();
        let empty = t.0.join("456-empty");
        std::fs::create_dir_all(&empty).unwrap();
        let orphans = find_orphans(&t.0, Some(mine.dir()));
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].info.name, "Poster");
        assert!(!empty.exists(), "empty dead sessions are removed");
        remove_orphan(&orphans[0]);
        assert!(!dead.exists());
        mine.discard("ed/1");
        let dir = mine.dir().to_path_buf();
        mine.finish();
        assert!(!dir.exists());
    }
}
