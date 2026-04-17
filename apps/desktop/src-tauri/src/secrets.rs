//! OS keychain integration for secret storage.
//!
//! Stores API keys and other secrets in the platform credential store
//! (macOS Keychain, Windows Credential Manager, Linux secret-service).
//! Keeps secrets off disk in plaintext — localStorage holds only a
//! `hasKey` marker; the actual secret lives here.
//!
//! Service string is pinned to SERVICE_NAME; account names are caller-supplied
//! (e.g., "apiKey:openai", "apiKey:anthropic", "proxy:password").

use keyring::Entry;

const SERVICE_NAME: &str = "socratic-council";

fn open_entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account).map_err(|e| format!("Keychain open failed: {}", e))
}

/// Store a secret under `account`. Overwrites any existing value.
#[tauri::command]
pub fn secrets_put(account: String, value: String) -> Result<(), String> {
    if account.trim().is_empty() {
        return Err("secrets_put: account must not be empty".to_string());
    }
    if value.is_empty() {
        return Err("secrets_put: value must not be empty".to_string());
    }
    let entry = open_entry(&account)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Keychain write failed: {}", e))
}

/// Retrieve a secret by `account`. Returns `None` if no entry exists.
#[tauri::command]
pub fn secrets_get(account: String) -> Result<Option<String>, String> {
    if account.trim().is_empty() {
        return Err("secrets_get: account must not be empty".to_string());
    }
    let entry = open_entry(&account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain read failed: {}", e)),
    }
}

/// Delete the entry for `account`. Returns true if something was removed,
/// false if there was no entry to remove.
#[tauri::command]
pub fn secrets_delete(account: String) -> Result<bool, String> {
    if account.trim().is_empty() {
        return Err("secrets_delete: account must not be empty".to_string());
    }
    let entry = open_entry(&account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Keychain delete failed: {}", e)),
    }
}
