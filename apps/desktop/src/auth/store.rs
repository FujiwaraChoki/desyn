//! Where the native session lives: the OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service
//! on Linux) through the `keyring` crate. One entry per server, so switching between hosted and self-hosted keeps
//! both sign-ins. Nothing is ever written to disk in plain text.

use serde::{Deserialize, Serialize};

/// A stored sign-in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// Better Auth session token (bearer).
    pub session_token: String,
    /// Expiry (ms) reported by the server.
    pub expires_at: f64,
    /// User id.
    pub user_id: String,
    /// Email.
    pub email: String,
    /// Display name.
    pub name: String,
}

/// Storage backend.
pub trait TokenStore: Send + Sync {
    /// Reads the session (`Ok(None)` when there is none).
    fn load(&self) -> Result<Option<StoredSession>, String>;
    /// Writes the session.
    fn save(&self, s: &StoredSession) -> Result<(), String>;
    /// Deletes the session.
    fn clear(&self) -> Result<(), String>;
}

/// Keychain entry name.
pub const SERVICE: &str = "app.desyn.Desyn";

/// The OS keychain, keyed by server.
pub struct KeyringStore {
    account: String,
}

impl KeyringStore {
    /// Store for the server at `convex_url`.
    pub fn new(convex_url: &str) -> KeyringStore {
        KeyringStore {
            account: format!("session:{convex_url}"),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, &self.account).map_err(|e| describe(&e))
    }
}

fn describe(e: &keyring::Error) -> String {
    match e {
        keyring::Error::NoDefaultStore
        | keyring::Error::NoStorageAccess(_)
        | keyring::Error::PlatformFailure(_) => {
            format!(
                "The system keychain is not available ({e}). Your sign-in will last until Desyn closes."
            )
        }
        other => other.to_string(),
    }
}

impl TokenStore for KeyringStore {
    fn load(&self) -> Result<Option<StoredSession>, String> {
        match self.entry()?.get_password() {
            Ok(s) => Ok(serde_json::from_str(&s).ok()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(&e)),
        }
    }

    fn save(&self, s: &StoredSession) -> Result<(), String> {
        let json = serde_json::to_string(s).map_err(|e| e.to_string())?;
        self.entry()?.set_password(&json).map_err(|e| describe(&e))
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }
}

/// In-memory store (tests, and the fallback when no keychain exists).
#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<Option<StoredSession>>);

impl TokenStore for MemoryStore {
    fn load(&self) -> Result<Option<StoredSession>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.clone())
    }

    fn save(&self, s: &StoredSession) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = Some(s.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemoryStore::default();
        assert_eq!(s.load().unwrap(), None);
        let v = StoredSession {
            session_token: "tok".into(),
            expires_at: 1.0,
            user_id: "u".into(),
            email: "a@b.c".into(),
            name: "A".into(),
        };
        s.save(&v).unwrap();
        assert_eq!(s.load().unwrap(), Some(v.clone()));
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("sessionToken"));
        s.clear().unwrap();
        assert_eq!(s.load().unwrap(), None);
    }
}
