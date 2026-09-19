//! Shared session store — one encrypted file per session, readable and
//! writable by BOTH surfaces.
//!
//! Location: when the desktop app is installed (its `vault.key` is readable),
//! sessions live in the app's own data directory
//! (`<app data>/sessions/<id>.json`) and are sealed with the app's DEK, so a
//! debate run in the terminal shows up in the app's history and vice versa.
//! Without the app, the CLI keeps the same layout under its own config dir,
//! sealed with its own DEK — the terminal is fully standalone.
//!
//! File format: the `ENC1:` envelope (see `crypto`) around the desktop app's
//! `DiscussionSession` JSON — exactly what `services/vault.ts` decrypts and
//! `normalizeDiscussionSession` accepts — so no translation layer is needed on
//! either side. Last writer wins by `updatedAt`; each surface only ever
//! overwrites a session it is itself running.

use crate::bridge::DesktopBridge;
use crate::config::Config;
use crate::crypto;
use crate::types::Usage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Where the store lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreLocation {
    /// The desktop app's data dir — history is shared with the app.
    SharedWithApp,
    /// The CLI's own config dir — no app installed (or its vault unreadable).
    CliOwn,
}

pub struct SessionStore {
    dir: PathBuf,
    dek: [u8; crypto::DEK_LEN],
    pub location: StoreLocation,
}

/// The sidebar-sized view of a stored session.
#[derive(Debug, Clone)]
pub struct StoredSessionSummary {
    pub id: String,
    pub title: String,
    pub topic: String,
    pub status: String,
    pub current_turn: u32,
    pub message_count: u32,
    pub updated_at: i64,
    /// `"cli"` or `"app"` — which surface last wrote it.
    pub origin: String,
}

/// One transcript message as the store serialises it.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    /// Council id (`george`…`zara`), or `moderator` / `system` / `tool` / `error`.
    pub agent_id: String,
    pub display_name: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    /// Unix milliseconds.
    pub at_ms: u64,
}

/// Ids are used as file names: keep them to a safe alphabet.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `sc-<unix ms>-<6 hex>` — sortable, unique enough, file-name safe.
pub fn new_session_id() -> String {
    let mut rand = [0u8; 3];
    let _ = getrandom::getrandom(&mut rand);
    format!("sc-{}-{:02x}{:02x}{:02x}", now_ms(), rand[0], rand[1], rand[2])
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl SessionStore {
    /// Open the store: the app's data dir + DEK when the bridge found them,
    /// else the CLI's own dir + DEK (created on first use).
    pub fn open(bridge: &DesktopBridge) -> Option<Self> {
        if let (Some(dir), Some(dek)) = (bridge.app_data_dir(), bridge.dek()) {
            return Some(Self {
                dir: dir.join("sessions"),
                dek,
                location: StoreLocation::SharedWithApp,
            });
        }
        let dir = Config::config_dir().ok()?.join("sessions");
        let dek = crypto::load_or_create_dek(&Config::cli_dek_path().ok()?).ok()?;
        Some(Self { dir, dek, location: StoreLocation::CliOwn })
    }

    /// A store at an explicit location (tests, or a custom `--sessions-dir`).
    pub fn at(dir: PathBuf, dek: [u8; crypto::DEK_LEN], location: StoreLocation) -> Self {
        Self { dir, dek, location }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, id: &str) -> Option<PathBuf> {
        valid_id(id).then(|| self.dir.join(format!("{id}.json")))
    }

    /// Seal + write `session` (the app-shaped JSON) atomically, owner-only.
    pub fn save(&self, session: &Value) -> Result<(), String> {
        let id = session["id"].as_str().ok_or("session has no id")?;
        let path = self.path_for(id).ok_or("invalid session id")?;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("create sessions dir: {e}"))?;
        owner_only_dir(&self.dir);
        let envelope = crypto::encrypt_str(&self.dek, &session.to_string())?;
        let tmp = self.dir.join(format!(".{id}.json.tmp"));
        write_owner_only(&tmp, &envelope).map_err(|e| format!("write session: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("install session file: {e}")
        })
    }

    /// Read + unseal one session. `None` when absent, unreadable, or sealed
    /// under a different key.
    pub fn load(&self, id: &str) -> Option<Value> {
        let path = self.path_for(id)?;
        let envelope = std::fs::read_to_string(path).ok()?;
        let json = crypto::decrypt_str(&self.dek, envelope.trim())?;
        serde_json::from_str(&json).ok()
    }

    pub fn delete(&self, id: &str) -> bool {
        self.path_for(id).map(|p| std::fs::remove_file(p).is_ok()).unwrap_or(false)
    }

    /// Every readable session, newest first. Files sealed under another key
    /// (or not ours) are skipped, never an error.
    pub fn list(&self) -> Vec<StoredSessionSummary> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<StoredSessionSummary> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let id = name.strip_suffix(".json")?;
                if !valid_id(id) {
                    return None;
                }
                let v = self.load(id)?;
                Some(StoredSessionSummary {
                    id: id.to_string(),
                    title: v["title"].as_str().unwrap_or("").to_string(),
                    topic: v["topic"].as_str().unwrap_or("").to_string(),
                    status: v["status"].as_str().unwrap_or("completed").to_string(),
                    current_turn: v["currentTurn"].as_u64().unwrap_or(0) as u32,
                    message_count: v["messages"].as_array().map(|m| m.len()).unwrap_or(0) as u32,
                    updated_at: v["updatedAt"].as_i64().unwrap_or(0),
                    origin: v["origin"].as_str().unwrap_or("app").to_string(),
                })
            })
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        out
    }
}

/// Build the desktop-app-shaped `DiscussionSession` JSON for a CLI debate.
/// Only the fields `normalizeDiscussionSession` needs are set; the rest take
/// the app's defaults on import.
pub fn build_session_json(
    id: &str,
    topic: &str,
    created_at_ms: u64,
    messages: &[StoredMessage],
    status: &str,
    current_turn: u32,
    usage: Usage,
) -> Value {
    let title: String = topic.chars().take(80).collect();
    let msgs: Vec<Value> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| !m.content.trim().is_empty() && m.agent_id != "error")
        .map(|(i, m)| {
            // The app knows the eight council ids plus system/tool; the
            // moderator and CLI notes ride as `system` with a display name.
            let (agent_id, display) = match m.agent_id.as_str() {
                "moderator" => ("system", "Moderator"),
                "tool" => ("tool", "Tool"),
                "user" => ("user", "You"),
                id if crate::tui::theme::AGENTS.iter().any(|a| a.id == id) => (id, m.display_name.as_str()),
                _ => ("system", m.display_name.as_str()),
            };
            let mut v = json!({
                "id": format!("{id}-m{i}"),
                "agentId": agent_id,
                "displayName": display,
                "content": m.content,
                "timestamp": m.at_ms.max(created_at_ms + i as u64),
            });
            if !m.thinking.trim().is_empty() {
                v["thinking"] = json!(m.thinking);
            }
            if !m.model.is_empty() {
                v["metadata"] = json!({ "model": m.model, "latencyMs": 0 });
            }
            v
        })
        .collect();
    let now = now_ms();
    json!({
        "id": id,
        "topic": topic,
        "title": title,
        "createdAt": created_at_ms,
        "updatedAt": now,
        "lastOpenedAt": now,
        "archivedAt": null,
        "projectId": null,
        "status": status,
        "currentTurn": current_turn,
        "totalTokens": { "input": usage.input, "output": usage.output + usage.reasoning },
        "messages": msgs,
        "errors": [],
        "attachments": [],
        "duoLogue": null,
        "origin": "cli",
    })
}

/// Turn a stored session's `messages` back into the transcript shape.
pub fn messages_from_json(session: &Value) -> Vec<StoredMessage> {
    let Some(arr) = session["messages"].as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| {
            let content = m["content"].as_str()?.to_string();
            if content.trim().is_empty() {
                return None;
            }
            let agent_id = m["agentId"].as_str().unwrap_or("system").to_string();
            let display_name = m["displayName"]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    crate::tui::theme::AGENTS
                        .iter()
                        .find(|a| a.id == agent_id)
                        .map(|a| a.name.to_string())
                        .unwrap_or_else(|| "System".to_string())
                });
            Some(StoredMessage {
                agent_id: if display_name == "Moderator" { "moderator".into() } else { agent_id },
                display_name,
                content,
                thinking: m["thinking"].as_str().unwrap_or("").to_string(),
                model: m["metadata"]["model"].as_str().unwrap_or("").to_string(),
                at_ms: m["timestamp"].as_u64().unwrap_or(0),
            })
        })
        .collect()
}

#[cfg(unix)]
fn write_owner_only(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_owner_only(path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
}

#[cfg(unix)]
fn owner_only_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(dir) {
        let mut perms = meta.permissions();
        perms.set_mode(0o700);
        let _ = std::fs::set_permissions(dir, perms);
    }
}

#[cfg(not(unix))]
fn owner_only_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> SessionStore {
        // Tests run in parallel: a ms clock alone collided (one test's cleanup
        // removed the other's directory), so add a process-wide counter.
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sc-store-{}-{}-{n}", std::process::id(), now_ms()));
        let mut dek = [0u8; crypto::DEK_LEN];
        getrandom::getrandom(&mut dek).unwrap();
        SessionStore::at(dir, dek, StoreLocation::CliOwn)
    }

    fn msg(agent: &str, name: &str, text: &str) -> StoredMessage {
        StoredMessage {
            agent_id: agent.into(),
            display_name: name.into(),
            content: text.into(),
            thinking: String::new(),
            model: "m".into(),
            at_ms: 0,
        }
    }

    #[test]
    fn round_trips_an_app_shaped_session() {
        let store = temp_store();
        let id = new_session_id();
        assert!(valid_id(&id));
        let msgs = vec![
            msg("moderator", "Moderator", "The council convenes on: X"),
            msg("george", "George", "First point."),
            msg("error", "⚠ Error", "dropped"),
            msg("tool", "Tool", "Tool result (oracle.web_search): 1. …"),
        ];
        let usage = Usage { input: 10, output: 5, reasoning: 2 };
        let session = build_session_json(&id, "Should we X?", 1_700_000_000_000, &msgs, "completed", 2, usage);
        store.save(&session).unwrap();

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].origin, "cli");
        assert_eq!(list[0].message_count, 3, "error rows are not persisted");

        let back = store.load(&id).unwrap();
        assert_eq!(back["topic"], "Should we X?");
        assert_eq!(back["messages"][0]["agentId"], "system");
        assert_eq!(back["messages"][0]["displayName"], "Moderator");
        assert_eq!(back["messages"][1]["agentId"], "george");
        assert!(back["messages"][1]["timestamp"].as_u64().unwrap() >= 1_700_000_000_000);
        assert_eq!(back["totalTokens"]["output"], 7);

        let restored = messages_from_json(&back);
        assert_eq!(restored.len(), 3);
        assert_eq!(restored[0].agent_id, "moderator");
        assert_eq!(restored[1].display_name, "George");

        // Files are sealed: the raw bytes are an ENC1 envelope, not JSON.
        let raw = std::fs::read_to_string(store.dir().join(format!("{id}.json"))).unwrap();
        assert!(raw.starts_with("ENC1:"));
        assert!(!raw.contains("First point"));

        assert!(store.delete(&id));
        assert!(store.list().is_empty());
        let _ = std::fs::remove_dir_all(store.dir());
    }

    #[test]
    fn rejects_unsafe_ids_and_foreign_keys() {
        let store = temp_store();
        assert!(!valid_id("../etc/passwd"));
        assert!(!valid_id(""));
        assert!(store.load("../x").is_none());
        let bad = json!({ "id": "a/b", "topic": "t" });
        assert!(store.save(&bad).is_err());
        // A file sealed under another key is skipped, not an error.
        let other = temp_store();
        let ok = build_session_json("sc-1-abc", "t", 1, &[], "completed", 0, Usage::default());
        std::fs::create_dir_all(store.dir()).unwrap();
        other.save(&ok).unwrap();
        std::fs::copy(other.dir().join("sc-1-abc.json"), store.dir().join("sc-1-abc.json")).unwrap();
        assert!(store.list().is_empty());
        let _ = std::fs::remove_dir_all(store.dir());
        let _ = std::fs::remove_dir_all(other.dir());
    }
}
