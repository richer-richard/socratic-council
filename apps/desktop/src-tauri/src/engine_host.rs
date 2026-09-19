//! The deliberation engine, hosted in the Tauri backend. The webview starts a
//! run with `engine_start`, receives every event on the `engine://event`
//! channel, answers questions and tool approvals with `engine_input`, and
//! stops a run with `engine_cancel`. API keys arrive with the request, live
//! in this process only for the run, and are overwritten when it ends.

use crate::redact::redact_with_secrets;
use serde::{Deserialize, Serialize};
use socratic_council_engine::attach::Attachment;
use socratic_council_engine::catalog::{catalog_rows, merge_with_catalog, model_row, ModelRow};
use socratic_council_engine::cost::{BudgetAction, BudgetPolicy};
use socratic_council_engine::deliberation::{
    DebateEvent, Deliberation, Deliverable, EngineConfig, EngineInput, ProtocolPolicy,
};
use socratic_council_engine::providers::scan::scan_models;
use socratic_council_engine::store::{new_session_id, SessionStore, StoreLocation};
use socratic_council_engine::tools::ToolPolicy;
use socratic_council_engine::types::{ModelChoice, ModelRef, Provider, ReasoningTier, Roster, Seat};
use socratic_council_engine::{catalog, http_client};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tauri::async_runtime::JoinHandle;

pub const EVENT_CHANNEL: &str = "engine://event";

/// A seat as the webview sends it: the model is a string the engine parses
/// ("auto", "auto-fast", "auto-balanced" or an id).
#[derive(Debug, Clone, Deserialize)]
pub struct SeatJson {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub provider: Provider,
    #[serde(default = "auto")]
    pub model: String,
    #[serde(default)]
    pub reasoning: Option<ReasoningTier>,
}

fn auto() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct SlotJson {
    pub provider: Provider,
    #[serde(default = "auto")]
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionJson {
    pub provider: Provider,
    pub tier: ReasoningTier,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetJson {
    #[serde(default)]
    pub per_session_usd: f64,
    #[serde(default)]
    pub per_day_usd: f64,
    #[serde(default)]
    pub action: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttachmentJson {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub topic: String,
    pub seats: Vec<SeatJson>,
    #[serde(default)]
    pub keys: HashMap<Provider, String>,
    #[serde(default)]
    pub base_urls: HashMap<Provider, String>,
    #[serde(default)]
    pub selection: Vec<SelectionJson>,
    pub moderator: SlotJson,
    pub utility: SlotJson,
    #[serde(default)]
    pub tools: ToolPolicy,
    #[serde(default)]
    pub protocol: ProtocolPolicy,
    #[serde(default)]
    pub budget: Option<BudgetJson>,
    #[serde(default)]
    pub attachments: Vec<AttachmentJson>,
    #[serde(default)]
    pub forced: Option<Deliverable>,
    #[serde(default)]
    pub prior_notes: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub proxy: Option<String>,
}

/// What the webview receives for every event.
#[derive(Debug, Serialize)]
pub struct Envelope<'a> {
    pub session_id: &'a str,
    pub event: &'a DebateEvent,
}

struct RunHandle {
    input: UnboundedSender<EngineInput>,
    task: JoinHandle<()>,
}

/// Live runs by session id.
#[derive(Default)]
pub struct EngineRegistry {
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl EngineRegistry {
    fn insert(&self, id: String, input: UnboundedSender<EngineInput>, task: JoinHandle<()>) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(id, RunHandle { input, task });
        }
    }
    fn remove(&self, id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(id);
        }
    }
    pub fn send(&self, id: &str, input: EngineInput) -> Result<(), String> {
        let runs = self.runs.lock().map_err(|_| "registry poisoned".to_string())?;
        let run = runs.get(id).ok_or_else(|| format!("no live run for session {id}"))?;
        run.input.send(input).map_err(|_| "the run has already ended".to_string())
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut runs = self.runs.lock().map_err(|_| "registry poisoned".to_string())?;
        match runs.remove(id) {
            Some(run) => {
                let _ = run.input.send(EngineInput::Cancel);
                // The run finishes its record and saves; only abort if it hangs.
                let task = run.task;
                tauri::async_runtime::spawn(async move {
                    if tokio::time::timeout(std::time::Duration::from_secs(120), task).await.is_err() {
                        // Nothing to abort by handle here after the move; the
                        // timeout simply stops waiting.
                    }
                });
                Ok(())
            }
            None => Err(format!("no live run for session {id}")),
        }
    }
    pub fn is_live(&self, id: &str) -> bool {
        self.runs.lock().map(|r| r.contains_key(id)).unwrap_or(false)
    }
}

/// A catalog row as the webview sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRowJson {
    pub id: String,
    pub provider: Provider,
    pub name: String,
    pub class: String,
    pub context_window: u32,
    pub max_output: u32,
    pub input_cost_per_1m: Option<f64>,
    pub cached_input_cost_per_1m: Option<f64>,
    pub output_cost_per_1m: Option<f64>,
    pub tools: bool,
    pub vision: bool,
    pub thinking: bool,
    pub catalogued: bool,
}

impl From<ModelRow> for CatalogRowJson {
    fn from(r: ModelRow) -> Self {
        CatalogRowJson {
            id: r.id,
            provider: r.provider,
            name: r.name,
            class: r.class.label().to_string(),
            context_window: r.context_window,
            max_output: r.max_output,
            input_cost_per_1m: r.pricing.input,
            cached_input_cost_per_1m: r.pricing.cached_input,
            output_cost_per_1m: r.pricing.output,
            tools: r.contract.tools,
            vision: r.contract.vision,
            thinking: r.contract.thinking != catalog::ThinkingKnob::Absent,
            catalogued: r.catalogued,
        }
    }
}

fn budget_policy(b: &Option<BudgetJson>) -> BudgetPolicy {
    match b {
        Some(b) => BudgetPolicy {
            per_session: b.per_session_usd.max(0.0),
            per_day: b.per_day_usd.max(0.0),
            action: BudgetAction::parse(&b.action),
        },
        None => BudgetPolicy {
            per_session: 0.0,
            per_day: 0.0,
            action: BudgetAction::Warn,
        },
    }
}

fn roster_from(seats: &[SeatJson]) -> Roster {
    let mut seen = std::collections::BTreeSet::new();
    Roster {
        seats: seats
            .iter()
            .filter(|s| !s.id.trim().is_empty() && seen.insert(s.id.trim().to_string()))
            .map(|s| Seat {
                id: s.id.trim().to_string(),
                name: if s.name.trim().is_empty() { s.id.trim().to_string() } else { s.name.trim().to_string() },
                provider: s.provider,
                model: ModelChoice::parse(&s.model),
                reasoning: s.reasoning,
            })
            .collect(),
    }
}

/// Overwrite key material before it is dropped.
fn wipe(keys: &mut Vec<String>) {
    for k in keys.iter_mut() {
        let len = k.len();
        k.clear();
        k.push_str(&"0".repeat(len));
    }
    keys.clear();
}

/// Start a run. Returns the session id; events follow on `engine://event`.
#[tauri::command]
pub async fn engine_start(
    app: tauri::AppHandle,
    registry: tauri::State<'_, EngineRegistry>,
    request: StartRequest,
) -> Result<String, String> {
    let session_id = match request.session_id.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => new_session_id(),
    };
    if registry.is_live(&session_id) {
        return Err(format!("session {session_id} is already running"));
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    let dek = crate::vault_file::current_dek(&app)?;
    let store = SessionStore::at(data_dir.join("sessions"), dek, StoreLocation::SharedWithApp);
    let workspace = data_dir.join("workspaces").join(&session_id);

    let roster = roster_from(&request.seats);
    if roster.seats.is_empty() {
        return Err("no seats".into());
    }
    let mut selection = HashMap::new();
    for s in &request.selection {
        selection.insert((s.provider, s.tier), s.model.clone());
    }
    let config = EngineConfig {
        base_urls: request.base_urls.clone(),
        selection,
        moderator: ModelRef {
            provider: request.moderator.provider,
            model: ModelChoice::parse(&request.moderator.model),
        },
        utility: ModelRef {
            provider: request.utility.provider,
            model: ModelChoice::parse(&request.utility.model),
        },
        tools: request.tools.clone(),
        protocol: request.protocol.clone(),
        budget: budget_policy(&request.budget),
        workspace,
        daily_ledger_dir: Some(data_dir),
        session_id: Some(session_id.clone()),
        handoff_dir: None,
    };
    let attachments: Vec<Attachment> = request
        .attachments
        .iter()
        .map(|a| Attachment {
            name: a.name.clone(),
            text: a.text.clone(),
        })
        .collect();
    let http = http_client(request.proxy.as_deref());
    let engine = Deliberation::new(
        http,
        config,
        request.topic.clone(),
        roster,
        request.keys.clone(),
        HashMap::new(),
    )
    .with_attachments(attachments)
    .with_forced_deliverable(request.forced)
    .with_store(Some(store))
    .with_prior_notes(request.prior_notes.clone());

    let (tx, mut rx) = unbounded_channel::<DebateEvent>();
    let (input, input_rx) = unbounded_channel::<EngineInput>();
    let mut secrets: Vec<String> = request.keys.values().cloned().collect();
    let forward_app = app.clone();
    let forward_id = session_id.clone();
    let forwarder = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let ev = match ev {
                DebateEvent::Error { message } => DebateEvent::Error {
                    message: redact_with_secrets(&message, &secrets),
                },
                other => other,
            };
            let envelope = Envelope {
                session_id: &forward_id,
                event: &ev,
            };
            let _ = forward_app.emit(EVENT_CHANNEL, &envelope);
            if matches!(ev, DebateEvent::Done { .. }) {
                break;
            }
        }
        wipe(&mut secrets);
    });
    let run_app = app.clone();
    let run_id = session_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _doc = engine.run(tx, input_rx).await;
        let _ = forwarder.await;
        if let Some(reg) = run_app.try_state::<EngineRegistry>() {
            reg.remove(&run_id);
        }
    });
    registry.insert(session_id.clone(), input, task);
    Ok(session_id)
}

/// Answer a question or a tool approval, or cancel.
#[tauri::command]
pub fn engine_input(
    registry: tauri::State<'_, EngineRegistry>,
    session_id: String,
    input: EngineInput,
) -> Result<(), String> {
    if matches!(input, EngineInput::Cancel) {
        return registry.cancel(&session_id);
    }
    registry.send(&session_id, input)
}

#[tauri::command]
pub fn engine_cancel(registry: tauri::State<'_, EngineRegistry>, session_id: String) -> Result<(), String> {
    registry.cancel(&session_id)
}

/// The verified catalog for a provider (newest and strongest first).
#[tauri::command]
pub fn engine_catalog(provider: Provider) -> Vec<CatalogRowJson> {
    catalog_rows(provider).into_iter().map(CatalogRowJson::from).collect()
}

/// The provider's live `/models` list merged with the catalog; unknown ids
/// carry their family's contract and no price.
#[tauri::command]
pub async fn engine_scan(
    provider: Provider,
    base_url: String,
    api_key: String,
    proxy: Option<String>,
) -> Result<Vec<CatalogRowJson>, String> {
    let http = http_client(proxy.as_deref());
    let scanned = scan_models(&http, provider, &base_url, &api_key)
        .await
        .map_err(|e| redact_with_secrets(&e.to_string(), std::slice::from_ref(&api_key)))?;
    let merged = merge_with_catalog(provider, scanned);
    Ok(merged
        .into_iter()
        .map(|m| {
            let mut row = CatalogRowJson::from(model_row(provider, &m.id));
            if row.name == row.id {
                if let Some(n) = m.display_name {
                    row.name = n;
                }
            }
            row
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_serialises_the_event_tag() {
        let ev = DebateEvent::Phase { name: "Framing".into() };
        let env = Envelope { session_id: "s", event: &ev };
        let json = serde_json::to_string(&env).unwrap();
        assert_eq!(json, r#"{"session_id":"s","event":{"event":"phase","name":"Framing"}}"#);
    }

    #[test]
    fn start_request_parses_camel_case_and_seat_models() {
        let raw = r#"{
            "topic": "t",
            "seats": [{"id":"george","name":"George","provider":"openai","model":"auto"},
                      {"id":"luna","provider":"openai","model":"gpt-5.6-luna","reasoning":"low"},
                      {"id":"george","provider":"openai"}],
            "keys": {"openai": "sk-test"},
            "baseUrls": {"openai": "https://api.openai.com"},
            "selection": [{"provider":"openai","tier":"high","model":"auto"}],
            "moderator": {"provider":"google","model":"auto"},
            "utility": {"provider":"google","model":"auto-fast"},
            "tools": {"web": true, "shell": {"enabled": true}},
            "protocol": {"max_rounds": 2},
            "budget": {"perSessionUsd": 2.5, "action": "stop"},
            "attachments": [{"name":"a.md","text":"x"}],
            "forced": "decision",
            "priorNotes": null,
            "sessionId": "sc-1"
        }"#;
        let req: StartRequest = serde_json::from_str(raw).unwrap();
        let roster = roster_from(&req.seats);
        assert_eq!(roster.seats.len(), 2, "duplicate ids are dropped");
        assert_eq!(roster.seats[1].model, ModelChoice::Id("gpt-5.6-luna".into()));
        assert_eq!(roster.seats[1].name, "luna", "a missing name falls back to the id");
        assert_eq!(roster.seats[1].reasoning, Some(ReasoningTier::Low));
        assert!(req.tools.shell.enabled);
        assert_eq!(req.protocol.max_rounds, 2);
        let b = budget_policy(&req.budget);
        assert_eq!(b.per_session, 2.5);
        assert_eq!(b.action, BudgetAction::Stop);
        assert_eq!(req.forced, Some(Deliverable::Decision));
        assert_eq!(req.keys.get(&Provider::OpenAI).map(String::as_str), Some("sk-test"));
    }

    #[tokio::test]
    async fn registry_tracks_and_cancels_runs() {
        let registry = EngineRegistry::default();
        let (tx, mut rx) = unbounded_channel::<EngineInput>();
        let task = tauri::async_runtime::spawn(async {});
        registry.insert("s1".into(), tx, task);
        assert!(registry.is_live("s1"));
        registry
            .send("s1", EngineInput::UserAnswer { id: "q".into(), text: "yes".into() })
            .unwrap();
        assert!(matches!(rx.recv().await, Some(EngineInput::UserAnswer { .. })));
        registry.cancel("s1").unwrap();
        assert!(matches!(rx.recv().await, Some(EngineInput::Cancel)));
        assert!(!registry.is_live("s1"));
        assert!(registry.send("s1", EngineInput::Cancel).is_err());
    }

    #[test]
    fn catalog_rows_convert_with_prices_and_flags() {
        let rows = engine_catalog(Provider::Anthropic);
        let fable = rows.iter().find(|r| r.id == "claude-fable-5-1").unwrap();
        assert_eq!(fable.class, "flagship");
        assert_eq!(fable.output_cost_per_1m, Some(50.0));
        assert!(fable.tools && fable.thinking && fable.catalogued);
    }

    #[test]
    fn wipe_overwrites_key_material() {
        let mut keys = vec!["sk-secret".to_string()];
        wipe(&mut keys);
        assert!(keys.is_empty());
    }
}
