//! Secret values: API keys, bot tokens, MCP credentials.
//!
//! The Electron app sealed these with `safeStorage` into files. Here they
//! go to the OS keychain under the service name "BOSS". Existing encrypted
//! files do not migrate; users re-enter keys.

use super::Result;
#[cfg(feature = "keyring")]
use super::StoreError;
use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name for every BOSS secret.
pub const SERVICE: &str = "BOSS";

/// A key/value store for secrets. Keys are dotted paths such as
/// `telegram.bot_token` or `mcp.<id>.auth_token`.
pub trait Secrets: Send + Sync {
    /// The value for `key`, or `None` when nothing is stored.
    fn get(&self, key: &str) -> Result<Option<String>>;
    /// Store `value` under `key`, replacing any previous value.
    fn set(&self, key: &str, value: &str) -> Result<()>;
    /// Remove `key`. Removing an absent key is not an error.
    fn delete(&self, key: &str) -> Result<()>;
}

/// In-memory secrets for tests and for machines with no keychain.
#[derive(Debug, Default)]
pub struct MemorySecrets {
    values: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.values.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.lock().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.lock().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.lock().remove(key);
        Ok(())
    }
}

/// Secrets in the OS keychain (macOS Keychain, Windows Credential Manager,
/// Secret Service on Linux), one entry per key under service [`SERVICE`].
#[cfg(feature = "keyring")]
#[derive(Debug, Clone)]
pub struct KeyringSecrets {
    service: String,
}

#[cfg(feature = "keyring")]
impl Default for KeyringSecrets {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "keyring")]
impl KeyringSecrets {
    /// The keychain under service "BOSS".
    pub fn new() -> Self {
        Self { service: SERVICE.to_owned() }
    }

    /// The keychain under another service name, for side-by-side installs.
    pub fn with_service(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, key).map_err(|e| StoreError::Secrets(e.to_string()))
    }
}

#[cfg(feature = "keyring")]
impl Secrets for KeyringSecrets {
    fn get(&self, key: &str) -> Result<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Secrets(e.to_string())),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.entry(key)?.set_password(value).map_err(|e| StoreError::Secrets(e.to_string()))
    }

    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(StoreError::Secrets(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_secrets_round_trip() {
        let secrets = MemorySecrets::new();
        assert_eq!(secrets.get("a").unwrap(), None);
        secrets.set("a", "1").unwrap();
        secrets.set("a", "2").unwrap();
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("2"));
        secrets.delete("a").unwrap();
        secrets.delete("a").unwrap();
        assert_eq!(secrets.get("a").unwrap(), None);
    }

    #[test]
    fn trait_object_is_usable() {
        let secrets: Box<dyn Secrets> = Box::new(MemorySecrets::new());
        secrets.set("k", "v").unwrap();
        assert_eq!(secrets.get("k").unwrap().as_deref(), Some("v"));
    }
}
