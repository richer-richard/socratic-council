//! The deliberation protocol: framing, prep, independent positions, parallel
//! cross-examination with tools, a board and a convergence check between
//! rounds, a revision round that carries the vote, and a decision record (plus
//! a document or a findings list when the deliverable asks for one).
//!
//! The runner emits `DebateEvent`s on one channel and takes `EngineInput`s
//! (tool approvals, answers, cancel) on another, so any surface can drive it.

pub mod board;
pub mod estimate;
pub mod parse;
pub mod plan;
pub mod prompts;
pub mod record;
pub mod seat_turn;

pub use board::{Board, Disagreement, Evidence};
pub use estimate::Estimate;
pub use plan::{Deliverable, Participant, Plan, ProtocolPolicy, RoundTiers, SeatRole, Subtask};
pub use record::{DecisionRecord, Dissent, OptionConsidered};
pub use seat_turn::{SeatSpec, ToolUseRecord};

use crate::attach::{context_summary, Attachment};
use crate::catalog::{model_row, resolve_model, DiscoveredModel, ModelClass, Pricing};
use crate::cost::{evaluate_budget, BudgetPolicy, BudgetVerdict, CostLedger, DailyLedger};
use crate::providers::stream_completion;
use crate::store::{build_session_json, new_session_id, now_ms, SessionStore, StoredMessage};
use crate::tools::{self, ToolContext, ToolPolicy};
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, CostLane, CostSnapshot, ModelChoice, ModelRef,
    Provider, ReasoningTier, Roster, Seat, ToolCall, Usage,
};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, Semaphore};

// ---------------------------------------------------------------------------
// Structured outputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub position: String,
    pub key_reason: String,
    pub strongest_objection: String,
    pub would_change_mind: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Attack {
    pub target: String,
    pub claim_challenged: String,
    pub argument: String,
    pub evidence: String,
    pub concession: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Revision {
    pub position: String,
    pub changed: String,
    pub final_confidence: f32,
    pub vote: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recommend {
    Revise,
    AnotherRound,
    Close,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Convergence {
    pub moved: Vec<String>,
    pub open_disagreements: u32,
    pub recommend: Recommend,
    pub why: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CritiqueIssue {
    pub location: String,
    pub problem: String,
    pub fix: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Critique {
    pub issues: Vec<CritiqueIssue>,
    pub endorse: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoundKind {
    Prep,
    Positions,
    Cross(u8),
    Revision,
    Critique,
}

impl RoundKind {
    pub fn label(self) -> String {
        match self {
            RoundKind::Prep => "Prep".into(),
            RoundKind::Positions => "Positions".into(),
            RoundKind::Cross(n) => format!("Cross-examination {n}"),
            RoundKind::Revision => "Revision".into(),
            RoundKind::Critique => "Critique".into(),
        }
    }
}

/// One seat's contribution in one round, as persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundEntry {
    pub seat: String,
    pub name: String,
    pub model: String,
    /// The rendered, human-readable text.
    pub content: String,
    /// The parsed object (position, attack, revision, report, critique).
    pub structured: Value,
    pub tool_uses: Vec<ToolUseRecord>,
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundLog {
    pub kind: RoundKind,
    pub entries: Vec<RoundEntry>,
}

// ---------------------------------------------------------------------------
// Events in, events out
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DebateEvent {
    Phase {
        name: String,
    },
    Plan {
        plan: Plan,
        corrections: Vec<String>,
    },
    Estimate {
        estimate: Estimate,
    },
    UserQuestion {
        id: String,
        question: String,
    },
    SeatStarted {
        seat_id: String,
        name: String,
        provider: Provider,
        model: String,
        round: RoundKind,
    },
    Token {
        seat_id: String,
        text: String,
    },
    Thinking {
        seat_id: String,
        text: String,
    },
    ToolApproval {
        id: String,
        seat_id: String,
        call: ToolCall,
    },
    ToolCall {
        seat_id: String,
        call: ToolCall,
        output: String,
        error: Option<String>,
    },
    SeatFinished {
        seat_id: String,
        name: String,
        round: RoundKind,
        usage: Usage,
        content: String,
        structured: Value,
    },
    Board {
        board: Board,
    },
    Convergence {
        convergence: Convergence,
    },
    Moderator {
        text: String,
    },
    Record {
        record: DecisionRecord,
    },
    Document {
        markdown: String,
    },
    Cost {
        snapshot: CostSnapshot,
    },
    Error {
        message: String,
    },
    Done {
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "input", rename_all = "snake_case")]
pub enum EngineInput {
    ToolDecision { id: String, allow: bool },
    UserAnswer { id: String, text: String },
    Cancel,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Allow(bool),
    Answer(String),
}

/// Routes `EngineInput`s to whoever is waiting on them, and holds the cancel
/// and budget-stop flags every phase checks.
#[derive(Default)]
pub struct InputHub {
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    cancelled: AtomicBool,
    stopped: AtomicBool,
}

impl InputHub {
    pub fn spawn(mut rx: UnboundedReceiver<EngineInput>) -> Arc<InputHub> {
        let hub = Arc::new(InputHub::default());
        let h = hub.clone();
        tokio::spawn(async move {
            while let Some(input) = rx.recv().await {
                match input {
                    EngineInput::ToolDecision { id, allow } => h.deliver(&id, Reply::Allow(allow)),
                    EngineInput::UserAnswer { id, text } => h.deliver(&id, Reply::Answer(text)),
                    EngineInput::Cancel => {
                        h.cancelled.store(true, Ordering::Relaxed);
                        if let Ok(mut p) = h.pending.lock() {
                            p.clear();
                        }
                    }
                }
            }
        });
        hub
    }

    fn deliver(&self, id: &str, reply: Reply) {
        let sender = self.pending.lock().ok().and_then(|mut p| p.remove(id));
        if let Some(s) = sender {
            let _ = s.send(reply);
        }
    }

    /// Wait for the reply to `id`; `None` on cancel.
    pub async fn wait(&self, id: String) -> Option<Reply> {
        if self.is_cancelled() {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        rx.await.ok()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed) || self.is_cancelled()
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub base_urls: HashMap<Provider, String>,
    /// Model selections from settings, per provider and tier ("auto" or an id).
    pub selection: HashMap<(Provider, ReasoningTier), String>,
    pub moderator: ModelRef,
    pub utility: ModelRef,
    pub tools: ToolPolicy,
    pub protocol: ProtocolPolicy,
    pub budget: BudgetPolicy,
    pub workspace: PathBuf,
    pub daily_ledger_dir: Option<PathBuf>,
    pub session_id: Option<String>,
}

impl EngineConfig {
    pub fn base_url(&self, provider: Provider) -> String {
        self.base_urls
            .get(&provider)
            .cloned()
            .unwrap_or_else(|| crate::config::default_base_url(provider).to_string())
    }
}

/// A resolved moderator or utility slot.
#[derive(Debug, Clone)]
struct ModeratorSpec {
    provider: Provider,
    model: String,
    base_url: String,
    api_key: String,
}

const MODERATOR_ORDER: [Provider; 8] = [
    Provider::Google,
    Provider::Anthropic,
    Provider::OpenAI,
    Provider::DeepSeek,
    Provider::Qwen,
    Provider::Kimi,
    Provider::Zhipu,
    Provider::MiniMax,
];

/// Wall-clock bound on one moderator or utility call.
const MODERATOR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

pub struct Deliberation {
    http: reqwest::Client,
    config: EngineConfig,
    topic: String,
    roster: Roster,
    keys: HashMap<Provider, String>,
    available: HashMap<Provider, Vec<DiscoveredModel>>,
    attachments: Vec<Attachment>,
    forced: Option<Deliverable>,
    store: Option<SessionStore>,
    prior_notes: Option<String>,
}

/// Everything a run accumulates.
#[derive(Default)]
struct RunState {
    plan: Option<Plan>,
    corrections: Vec<String>,
    estimate: Option<Estimate>,
    board: Board,
    positions: BTreeMap<String, Position>,
    attacks: Vec<(u8, String, Attack)>,
    revisions: BTreeMap<String, Revision>,
    convergences: Vec<Convergence>,
    rounds: Vec<RoundLog>,
    record: Option<DecisionRecord>,
    document: Option<String>,
    messages: Vec<StoredMessage>,
    stopped_early: Option<String>,
}

impl Deliberation {
    pub fn new(
        http: reqwest::Client,
        config: EngineConfig,
        topic: String,
        roster: Roster,
        keys: HashMap<Provider, String>,
        available: HashMap<Provider, Vec<DiscoveredModel>>,
    ) -> Self {
        Self {
            http,
            config,
            topic,
            roster,
            keys,
            available,
            attachments: Vec::new(),
            forced: None,
            store: None,
            prior_notes: None,
        }
    }

    pub fn with_attachments(mut self, attachments: Vec<Attachment>) -> Self {
        self.attachments = attachments;
        self
    }
    pub fn with_forced_deliverable(mut self, d: Option<Deliverable>) -> Self {
        self.forced = d;
        self
    }
    pub fn with_store(mut self, store: Option<SessionStore>) -> Self {
        self.store = store;
        self
    }
    /// Notes from an earlier session (its record), given to the planner.
    pub fn with_prior_notes(mut self, notes: Option<String>) -> Self {
        self.prior_notes = notes;
        self
    }

    fn resolve_model(&self, provider: Provider, choice: &ModelChoice) -> String {
        match choice {
            ModelChoice::Id(id) => id.clone(),
            ModelChoice::Auto(tier) => {
                let empty = Vec::new();
                let avail = self.available.get(&provider).unwrap_or(&empty);
                let selection = self
                    .config
                    .selection
                    .get(&(provider, *tier))
                    .map(String::as_str);
                resolve_model(provider, *tier, avail, selection)
            }
        }
    }

    fn resolve_seat(&self, seat: &Seat) -> Option<SeatSpec> {
        let api_key = self.keys.get(&seat.provider)?.clone();
        Some(SeatSpec {
            id: seat.id.clone(),
            name: seat.name.clone(),
            provider: seat.provider,
            model: self.resolve_model(seat.provider, &seat.model),
            base_url: self.config.base_url(seat.provider),
            api_key,
        })
    }

    fn pick_slot(&self, slot: &ModelRef, fallback_tier: ReasoningTier) -> Option<ModeratorSpec> {
        let provider = if self.keys.contains_key(&slot.provider) {
            slot.provider
        } else {
            *MODERATOR_ORDER.iter().find(|p| self.keys.contains_key(p))?
        };
        let choice = if provider == slot.provider {
            slot.model.clone()
        } else {
            ModelChoice::Auto(fallback_tier)
        };
        Some(ModeratorSpec {
            provider,
            model: self.resolve_model(provider, &choice),
            base_url: self.config.base_url(provider),
            api_key: self.keys.get(&provider)?.clone(),
        })
    }

    /// Drive the whole protocol. Returns the session document (format v2).
    pub async fn run(
        self,
        tx: UnboundedSender<DebateEvent>,
        rx: UnboundedReceiver<EngineInput>,
    ) -> Value {
        let this = &self;
        let hub = InputHub::spawn(rx);
        let session_id = this
            .config
            .session_id
            .clone()
            .unwrap_or_else(new_session_id);
        let created_at = now_ms();
        let ledger = Mutex::new(CostLedger::new());
        let mut daily = this
            .config
            .daily_ledger_dir
            .as_ref()
            .map(|d| DailyLedger::load(d));
        let mut last_session_usd = 0.0f64;
        let mut state = RunState::default();
        let names: BTreeMap<String, String> = this
            .roster
            .seats
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect();
        let send = |e: DebateEvent| {
            let _ = tx.send(e);
        };

        let seats: Vec<SeatSpec> = this
            .roster
            .seats
            .iter()
            .filter_map(|s| this.resolve_seat(s))
            .collect();
        if seats.is_empty() {
            send(DebateEvent::Error {
                message: "No seat has an API key. Add a key (see `socratic-council config`)."
                    .into(),
            });
            send(DebateEvent::Done {
                session_id: session_id.clone(),
            });
            return this.session_json(&session_id, created_at, &state, &ledger, "failed");
        }
        let roster = Roster {
            seats: this
                .roster
                .seats
                .iter()
                .filter(|s| seats.iter().any(|r| r.id == s.id))
                .cloned()
                .collect(),
        };
        let moderator = this.pick_slot(&this.config.moderator, ReasoningTier::High);
        let utility = self
            .pick_slot(&this.config.utility, ReasoningTier::Low)
            .or_else(|| moderator.clone());
        let attachments_summary = context_summary(&this.attachments);
        let has_attachments = !this.attachments.is_empty();
        let tool_names: Vec<String> = tools::specs_for(&this.config.tools, has_attachments)
            .into_iter()
            .map(|s| s.name)
            .collect();
        let _ = std::fs::create_dir_all(&this.config.workspace);
        let tiers = this.config.protocol.tiers;

        // A cost snapshot plus the budget check, after anything billable.
        let mut settle = |ledger: &Mutex<CostLedger>, state: &mut RunState, hub: &InputHub| {
            let session_usd = ledger.lock().map(|l| l.total_usd()).unwrap_or(0.0);
            if let Some(d) = daily.as_mut() {
                d.add(session_usd - last_session_usd);
            }
            last_session_usd = session_usd;
            let daily_usd = daily.as_ref().map(|d| d.total_usd).unwrap_or(0.0);
            let mut snap = ledger.lock().map(|l| l.snapshot()).unwrap_or_default();
            snap.daily_usd = daily_usd;
            snap.session_cap = this.config.budget.per_session;
            snap.daily_cap = this.config.budget.per_day;
            match evaluate_budget(session_usd, daily_usd, this.config.budget) {
                BudgetVerdict::Stop(msg) => {
                    snap.note = Some(msg.clone());
                    send(DebateEvent::Cost { snapshot: snap });
                    send(DebateEvent::Moderator {
                        text: format!("⚠ {msg}"),
                    });
                    hub.stop();
                    if state.stopped_early.is_none() {
                        state.stopped_early = Some("budget cap".into());
                    }
                }
                BudgetVerdict::Warn(msg) => {
                    snap.note = Some(msg.clone());
                    send(DebateEvent::Cost { snapshot: snap });
                }
                BudgetVerdict::Ok => send(DebateEvent::Cost { snapshot: snap }),
            }
        };

        // ---- Framing -------------------------------------------------------
        send(DebateEvent::Phase {
            name: "Framing".into(),
        });
        let roster_table = this.roster_table(&seats);
        let mut user_answer: Option<String> = None;
        let mut plan: Option<Plan> = None;
        for attempt in 0..2 {
            let Some(m) = &moderator else { break };
            let mut topic = this.topic.clone();
            if let Some(notes) = &this.prior_notes {
                topic.push_str("\n\nNotes from the earlier session on this topic:\n");
                topic.push_str(notes);
            }
            let user = prompts::planner_user(
                &topic,
                &roster_table,
                &attachments_summary,
                this.forced,
                user_answer.as_deref(),
                this.config.protocol.max_principals,
                this.config.protocol.max_rounds,
                &tool_names,
                this.config.protocol.interactive,
            );
            let parsed = self
                .moderator_call(
                    m,
                    &prompts::moderator_system(),
                    &user,
                    tiers.utility,
                    1500,
                    &ledger,
                    "moderator",
                )
                .await
                .and_then(|text| parse::parse_plan(&text));
            settle(&ledger, &mut state, &hub);
            match parsed {
                Some(p) => {
                    let (p, notes) = p.validate(&roster, &this.config.protocol);
                    if let (Some(q), None, true) =
                        (&p.ask_user, &user_answer, this.config.protocol.interactive)
                    {
                        let id = format!("q-{attempt}");
                        send(DebateEvent::UserQuestion {
                            id: id.clone(),
                            question: q.clone(),
                        });
                        match hub.wait(id).await {
                            Some(Reply::Answer(a)) => {
                                user_answer = Some(a);
                                continue;
                            }
                            _ => {
                                state.corrections.push(
                                    "no answer to the clarifying question; planned without it"
                                        .into(),
                                );
                            }
                        }
                    }
                    state.corrections.extend(notes);
                    plan = Some(p);
                    break;
                }
                None => {
                    if attempt == 1 || hub.is_stopped() {
                        break;
                    }
                }
            }
        }
        let plan = match plan {
            Some(p) => p,
            None => {
                state.corrections.push(
                    "the moderator produced no usable plan; every seat reasons for one round"
                        .into(),
                );
                let (p, notes) = Plan::default_for(&this.topic, &roster, this.forced)
                    .validate(&roster, &this.config.protocol);
                state.corrections.extend(notes);
                p
            }
        };
        send(DebateEvent::Plan {
            plan: plan.clone(),
            corrections: state.corrections.clone(),
        });
        send(DebateEvent::Moderator {
            text: this.framing_text(&plan, &names),
        });

        // ---- Estimate ------------------------------------------------------
        let priced: Vec<estimate::PricedSeat> = plan
            .participants
            .iter()
            .filter_map(|p| {
                let s = seats.iter().find(|s| s.id == p.seat)?;
                Some(estimate::PricedSeat {
                    id: s.id.clone(),
                    role: p.role,
                    pricing: model_row(s.provider, &s.model).pricing,
                })
            })
            .collect();
        let mod_price = moderator
            .as_ref()
            .map(|m| model_row(m.provider, &m.model).pricing)
            .unwrap_or_default();
        let util_price = utility
            .as_ref()
            .map(|u| model_row(u.provider, &u.model).pricing)
            .unwrap_or(mod_price);
        let est = estimate::estimate(&plan, &priced, &mod_price, &util_price, &tiers);
        send(DebateEvent::Estimate {
            estimate: est.clone(),
        });
        state.estimate = Some(est);
        state.plan = Some(plan.clone());
        state.messages.push(StoredMessage {
            agent_id: "moderator".into(),
            display_name: "Moderator".into(),
            content: this.framing_text(&plan, &names),
            thinking: String::new(),
            model: moderator
                .as_ref()
                .map(|m| m.model.clone())
                .unwrap_or_default(),
            at_ms: now_ms(),
        });
        this.persist(&session_id, created_at, &state, &ledger, "active");

        let principals: Vec<SeatSpec> = plan
            .principals()
            .iter()
            .filter_map(|id| seats.iter().find(|s| s.id == *id).cloned())
            .collect();
        let sem = Arc::new(Semaphore::new(this.config.protocol.concurrency.max(1)));
        let cache_key = Some(session_id.clone());

        // ---- Prep ----------------------------------------------------------
        if !plan.subtasks.is_empty() && !hub.is_stopped() {
            send(DebateEvent::Phase {
                name: "Prep".into(),
            });
            let board_text = state.board.to_prompt_text(&names);
            let jobs: Vec<(SeatSpec, Subtask)> = plan
                .subtasks
                .iter()
                .filter_map(|t| {
                    seats
                        .iter()
                        .find(|s| s.id == t.seat)
                        .map(|s| (s.clone(), t.clone()))
                })
                .collect();
            let all_specs = tools::specs_for(&this.config.tools, has_attachments);
            let results = join_all(jobs.iter().map(|(seat, task)| {
                let sem = sem.clone();
                let system = prompts::seat_system(&seat.name, &plan.question, None);
                let user = prompts::subtask_user(&task.task, task.word_cap, &board_text);
                let specs: Vec<_> = all_specs
                    .iter()
                    .filter(|s| task.tools.is_empty() || task.tools.iter().any(|t| t == &s.name))
                    .cloned()
                    .collect();
                let ctx = this.turn_ctx(&ledger, &hub, &tx, cache_key.clone());
                let tier = seat_tier(&roster, &seat.id, tiers.subtask);
                async move {
                    let _permit = sem.acquire().await;
                    this.seat(
                        &ctx,
                        seat,
                        &system,
                        &user,
                        tier,
                        specs,
                        RoundKind::Prep,
                        false,
                    )
                    .await
                }
            }))
            .await;
            let mut log = RoundLog {
                kind: RoundKind::Prep,
                entries: Vec::new(),
            };
            for ((seat, task), result) in jobs.iter().zip(results) {
                let Some(out) = result else { continue };
                let obj = parse::extract_json(&out.text)
                    .and_then(|j| serde_json::from_str::<Value>(j).ok());
                let report = obj
                    .as_ref()
                    .and_then(|o| o["report"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| out.text.clone());
                let mut evidence: Vec<Evidence> = obj
                    .as_ref()
                    .and_then(|o| o["evidence"].as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| {
                                let claim = e["claim"].as_str()?.trim().to_string();
                                Some(Evidence {
                                    claim,
                                    source: e["source"].as_str().unwrap_or("").into(),
                                    by: seat.id.clone(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if evidence.is_empty() && !report.trim().is_empty() {
                    evidence.push(Evidence {
                        claim: truncate(&report, 300),
                        source: format!("subtask: {}", task.task),
                        by: seat.id.clone(),
                    });
                }
                state.board.merge_evidence(evidence);
                let content = format!("Subtask ({}): {}", task.task, report);
                send(DebateEvent::SeatFinished {
                    seat_id: seat.id.clone(),
                    name: seat.name.clone(),
                    round: RoundKind::Prep,
                    usage: out.usage,
                    content: content.clone(),
                    structured: obj.clone().unwrap_or(json!({ "report": report })),
                });
                this.push_message(&mut state, seat, &content, &out.thinking);
                log.entries.push(RoundEntry {
                    seat: seat.id.clone(),
                    name: seat.name.clone(),
                    model: seat.model.clone(),
                    content,
                    structured: obj.unwrap_or(json!({})),
                    tool_uses: out.tool_uses,
                    usage: out.usage,
                });
            }
            state.rounds.push(log);
            settle(&ledger, &mut state, &hub);
            send(DebateEvent::Board {
                board: state.board.clone(),
            });
            this.persist(&session_id, created_at, &state, &ledger, "active");
        }

        // ---- Positions -----------------------------------------------------
        if !hub.is_stopped() {
            send(DebateEvent::Phase {
                name: "Positions".into(),
            });
            let board_text = state.board.to_prompt_text(&names);
            let results = join_all(principals.iter().map(|seat| {
                let sem = sem.clone();
                let system = prompts::seat_system(
                    &seat.name,
                    &plan.question,
                    plan.lenses.get(&seat.id).map(String::as_str),
                );
                let user = prompts::position_user(&plan, &board_text, &attachments_summary);
                let ctx = this.turn_ctx(&ledger, &hub, &tx, cache_key.clone());
                let tier = seat_tier(&roster, &seat.id, tiers.positions);
                async move {
                    let _permit = sem.acquire().await;
                    this.seat(
                        &ctx,
                        seat,
                        &system,
                        &user,
                        tier,
                        Vec::new(),
                        RoundKind::Positions,
                        false,
                    )
                    .await
                }
            }))
            .await;
            let mut log = RoundLog {
                kind: RoundKind::Positions,
                entries: Vec::new(),
            };
            for (seat, result) in principals.iter().zip(results) {
                let Some(out) = result else { continue };
                let pos = parse::parse_position(&out.text).unwrap_or_else(|| Position {
                    position: truncate(&out.text, 1200),
                    confidence: 0.5,
                    ..Position::default()
                });
                let content = render_position(&pos);
                send(DebateEvent::SeatFinished {
                    seat_id: seat.id.clone(),
                    name: seat.name.clone(),
                    round: RoundKind::Positions,
                    usage: out.usage,
                    content: content.clone(),
                    structured: serde_json::to_value(&pos).unwrap_or(json!({})),
                });
                this.push_message(&mut state, seat, &content, &out.thinking);
                state
                    .board
                    .positions
                    .insert(seat.id.clone(), truncate(&pos.position, 240));
                log.entries.push(RoundEntry {
                    seat: seat.id.clone(),
                    name: seat.name.clone(),
                    model: seat.model.clone(),
                    content,
                    structured: serde_json::to_value(&pos).unwrap_or(json!({})),
                    tool_uses: out.tool_uses,
                    usage: out.usage,
                });
                state.positions.insert(seat.id.clone(), pos);
            }
            state.rounds.push(log);
            settle(&ledger, &mut state, &hub);
            send(DebateEvent::Board {
                board: state.board.clone(),
            });
            this.persist(&session_id, created_at, &state, &ledger, "active");
        }
        let first_positions_text = prompts::positions_text(&state.positions, &names, None);

        // ---- Cross-examination rounds ---------------------------------------
        let mut round = 0u8;
        let all_specs = tools::specs_for(&this.config.tools, has_attachments);
        while round < plan.rounds && !hub.is_stopped() && state.positions.len() > 1 {
            round += 1;
            send(DebateEvent::Phase {
                name: format!("Cross-examination {round}"),
            });
            let board_text = state.board.to_prompt_text(&names);
            let active: Vec<SeatSpec> = principals
                .iter()
                .filter(|s| state.positions.contains_key(&s.id))
                .cloned()
                .collect();
            let results = join_all(active.iter().map(|seat| {
                let sem = sem.clone();
                let system = prompts::seat_system(
                    &seat.name,
                    &plan.question,
                    plan.lenses.get(&seat.id).map(String::as_str),
                );
                let others = prompts::positions_text(&state.positions, &names, Some(&seat.id));
                let own = state.positions.get(&seat.id).cloned().unwrap_or_default();
                let user = prompts::attack_user(&plan, &board_text, &others, &own, round);
                let ctx = this.turn_ctx(&ledger, &hub, &tx, cache_key.clone());
                let tier = seat_tier(&roster, &seat.id, tiers.cross);
                let specs = all_specs.clone();
                async move {
                    let _permit = sem.acquire().await;
                    this.seat(
                        &ctx,
                        seat,
                        &system,
                        &user,
                        tier,
                        specs,
                        RoundKind::Cross(round),
                        false,
                    )
                    .await
                }
            }))
            .await;
            let mut log = RoundLog {
                kind: RoundKind::Cross(round),
                entries: Vec::new(),
            };
            let mut round_attacks: Vec<(String, Attack)> = Vec::new();
            for (seat, result) in active.iter().zip(results) {
                let Some(out) = result else { continue };
                let attack = parse::parse_attack(&out.text).unwrap_or_else(|| Attack {
                    argument: truncate(&out.text, 1200),
                    ..Attack::default()
                });
                let content = render_attack(&attack, &names);
                send(DebateEvent::SeatFinished {
                    seat_id: seat.id.clone(),
                    name: seat.name.clone(),
                    round: RoundKind::Cross(round),
                    usage: out.usage,
                    content: content.clone(),
                    structured: serde_json::to_value(&attack).unwrap_or(json!({})),
                });
                this.push_message(&mut state, seat, &content, &out.thinking);
                for t in &out.tool_uses {
                    if t.error.is_none() && !t.output.trim().is_empty() {
                        let claim = format!(
                            "{}({}) → {}",
                            t.call.name,
                            compact_args(&t.call.arguments),
                            truncate(&t.output, 240)
                        );
                        state.board.merge_evidence(vec![Evidence {
                            claim,
                            source: t.call.name.clone(),
                            by: seat.id.clone(),
                        }]);
                    }
                }
                log.entries.push(RoundEntry {
                    seat: seat.id.clone(),
                    name: seat.name.clone(),
                    model: seat.model.clone(),
                    content,
                    structured: serde_json::to_value(&attack).unwrap_or(json!({})),
                    tool_uses: out.tool_uses,
                    usage: out.usage,
                });
                round_attacks.push((seat.id.clone(), attack.clone()));
                state.attacks.push((round, seat.id.clone(), attack));
            }
            state.rounds.push(log);
            settle(&ledger, &mut state, &hub);
            if hub.is_stopped() {
                break;
            }

            // Board, then convergence, on the utility model.
            let round_text = prompts::attacks_text(&round_attacks, &names, None);
            if let Some(u) = &utility {
                let user = prompts::board_user(&plan.question, &state.board, &round_text);
                if let Some(b) = self
                    .moderator_call(
                        u,
                        &prompts::moderator_system(),
                        &user,
                        tiers.utility,
                        1800,
                        &ledger,
                        "utility",
                    )
                    .await
                    .and_then(|t| parse::parse_board(&t))
                {
                    let mut merged = b;
                    let prior = std::mem::take(&mut state.board.evidence);
                    merged.merge_evidence(prior);
                    if merged.positions.is_empty() {
                        merged.positions = state.board.positions.clone();
                    }
                    state.board = merged;
                }
                send(DebateEvent::Board {
                    board: state.board.clone(),
                });
                let board_msg = state.board.to_prompt_text(&names);
                this.push_system_message(&mut state, "Board", &board_msg);
                let user = prompts::convergence_user(
                    &first_positions_text,
                    &round_text,
                    &state.board.to_prompt_text(&names),
                    plan.rounds - round,
                );
                let conv = self
                    .moderator_call(
                        u,
                        &prompts::moderator_system(),
                        &user,
                        tiers.utility,
                        400,
                        &ledger,
                        "utility",
                    )
                    .await
                    .and_then(|t| parse::parse_convergence(&t))
                    .unwrap_or(Convergence {
                        moved: Vec::new(),
                        open_disagreements: 0,
                        recommend: Recommend::Revise,
                        why: "no convergence judgement; moving to revision".into(),
                    });
                send(DebateEvent::Convergence {
                    convergence: conv.clone(),
                });
                let rec = conv.recommend;
                state.convergences.push(conv);
                settle(&ledger, &mut state, &hub);
                this.persist(&session_id, created_at, &state, &ledger, "active");
                match rec {
                    Recommend::Close | Recommend::Revise => break,
                    Recommend::AnotherRound => continue,
                }
            } else {
                this.persist(&session_id, created_at, &state, &ledger, "active");
                break;
            }
        }

        // ---- Revision ------------------------------------------------------
        let skip_revision = state
            .convergences
            .last()
            .map(|c| c.recommend == Recommend::Close)
            .unwrap_or(false)
            && state.attacks.is_empty();
        if !hub.is_stopped() && !state.positions.is_empty() && !skip_revision {
            send(DebateEvent::Phase {
                name: "Revision".into(),
            });
            let board_text = state.board.to_prompt_text(&names);
            let active: Vec<SeatSpec> = principals
                .iter()
                .filter(|s| state.positions.contains_key(&s.id))
                .cloned()
                .collect();
            let results = join_all(active.iter().map(|seat| {
                let sem = sem.clone();
                let system = prompts::seat_system(
                    &seat.name,
                    &plan.question,
                    plan.lenses.get(&seat.id).map(String::as_str),
                );
                let others = prompts::positions_text(&state.positions, &names, Some(&seat.id));
                let all: Vec<(String, Attack)> = state
                    .attacks
                    .iter()
                    .map(|(_, by, a)| (by.clone(), a.clone()))
                    .collect();
                let on_me = prompts::attacks_text(&all, &names, Some(&seat.id));
                let own = state.positions.get(&seat.id).cloned().unwrap_or_default();
                let user = prompts::revision_user(&plan, &board_text, &others, &on_me, &own);
                let ctx = this.turn_ctx(&ledger, &hub, &tx, cache_key.clone());
                let tier = seat_tier(&roster, &seat.id, tiers.revision);
                async move {
                    let _permit = sem.acquire().await;
                    this.seat(
                        &ctx,
                        seat,
                        &system,
                        &user,
                        tier,
                        Vec::new(),
                        RoundKind::Revision,
                        false,
                    )
                    .await
                }
            }))
            .await;
            let mut log = RoundLog {
                kind: RoundKind::Revision,
                entries: Vec::new(),
            };
            for (seat, result) in active.iter().zip(results) {
                let Some(out) = result else { continue };
                let rev = parse::parse_revision(&out.text).unwrap_or_else(|| Revision {
                    position: truncate(&out.text, 1200),
                    changed: String::new(),
                    final_confidence: state
                        .positions
                        .get(&seat.id)
                        .map(|p| p.confidence)
                        .unwrap_or(0.5),
                    vote: String::new(),
                });
                let content = render_revision(&rev);
                send(DebateEvent::SeatFinished {
                    seat_id: seat.id.clone(),
                    name: seat.name.clone(),
                    round: RoundKind::Revision,
                    usage: out.usage,
                    content: content.clone(),
                    structured: serde_json::to_value(&rev).unwrap_or(json!({})),
                });
                this.push_message(&mut state, seat, &content, &out.thinking);
                state
                    .board
                    .positions
                    .insert(seat.id.clone(), truncate(&rev.position, 240));
                log.entries.push(RoundEntry {
                    seat: seat.id.clone(),
                    name: seat.name.clone(),
                    model: seat.model.clone(),
                    content,
                    structured: serde_json::to_value(&rev).unwrap_or(json!({})),
                    tool_uses: out.tool_uses,
                    usage: out.usage,
                });
                state.revisions.insert(seat.id.clone(), rev);
            }
            state.rounds.push(log);
            settle(&ledger, &mut state, &hub);
            this.persist(&session_id, created_at, &state, &ledger, "active");
        }

        // ---- Record ----------------------------------------------------------
        send(DebateEvent::Phase {
            name: "Record".into(),
        });
        if hub.is_cancelled() && state.stopped_early.is_none() {
            state.stopped_early = Some("cancelled".into());
        }
        let revisions_text = if state.revisions.is_empty() {
            prompts::positions_text(&state.positions, &names, None)
        } else {
            prompts::revisions_text(&state.revisions, &names)
        };
        let mut record: Option<DecisionRecord> = None;
        if let Some(m) = &moderator {
            if !state.positions.is_empty() && !hub.is_cancelled() {
                let user = prompts::record_user(
                    &plan,
                    &first_positions_text,
                    &revisions_text,
                    &state.board.to_prompt_text(&names),
                    state.stopped_early.as_deref(),
                );
                record = self
                    .moderator_call(
                        m,
                        &prompts::moderator_system(),
                        &user,
                        tiers.record,
                        3000,
                        &ledger,
                        "moderator",
                    )
                    .await
                    .and_then(|t| parse::parse_record(&t));
                settle(&ledger, &mut state, &hub);
            }
        }
        let mut record = record.unwrap_or_else(|| this.fallback_record(&state, &plan));
        record.deliverable = plan.deliverable;
        record.question = plan.question.clone();
        for (id, r) in &state.revisions {
            if !r.vote.trim().is_empty() {
                record.votes.insert(id.clone(), r.vote.trim().to_string());
            }
        }
        if let Some(why) = &state.stopped_early {
            if !record.answer.to_ascii_lowercase().contains("stopped") {
                record.answer = format!("Stopped at {why}. {}", record.answer);
            }
        }

        // ---- Document (drafted, critiqued once, revised) --------------------
        if plan.deliverable == Deliverable::Document && !hub.is_stopped() {
            if let Some(m) = &moderator {
                send(DebateEvent::Phase {
                    name: "Document".into(),
                });
                let user = prompts::document_user(
                    &plan,
                    &state.board.to_prompt_text(&names),
                    &revisions_text,
                    &attachments_summary,
                );
                if let Some(draft) = self
                    .moderator_call(
                        m,
                        &prompts::moderator_system_document(),
                        &user,
                        tiers.record,
                        6000,
                        &ledger,
                        "moderator",
                    )
                    .await
                {
                    send(DebateEvent::Document {
                        markdown: draft.clone(),
                    });
                    state.document = Some(draft.clone());
                    settle(&ledger, &mut state, &hub);
                    if !hub.is_stopped() {
                        send(DebateEvent::Phase {
                            name: "Critique".into(),
                        });
                        let results = join_all(principals.iter().map(|seat| {
                            let sem = sem.clone();
                            let system = prompts::seat_system(&seat.name, &plan.question, None);
                            let user = prompts::critique_user(&draft);
                            let ctx = this.turn_ctx(&ledger, &hub, &tx, cache_key.clone());
                            let tier = seat_tier(&roster, &seat.id, tiers.cross);
                            async move {
                                let _permit = sem.acquire().await;
                                this.seat(
                                    &ctx,
                                    seat,
                                    &system,
                                    &user,
                                    tier,
                                    Vec::new(),
                                    RoundKind::Critique,
                                    false,
                                )
                                .await
                            }
                        }))
                        .await;
                        let mut log = RoundLog {
                            kind: RoundKind::Critique,
                            entries: Vec::new(),
                        };
                        let mut critiques = String::new();
                        for (seat, result) in principals.iter().zip(results) {
                            let Some(out) = result else { continue };
                            let c = parse::parse_critique(&out.text).unwrap_or(Critique {
                                issues: Vec::new(),
                                endorse: true,
                            });
                            let content = render_critique(&c);
                            critiques.push_str(&format!("[{}]\n{content}\n\n", seat.name));
                            send(DebateEvent::SeatFinished {
                                seat_id: seat.id.clone(),
                                name: seat.name.clone(),
                                round: RoundKind::Critique,
                                usage: out.usage,
                                content: content.clone(),
                                structured: serde_json::to_value(&c).unwrap_or(json!({})),
                            });
                            this.push_message(&mut state, seat, &content, &out.thinking);
                            log.entries.push(RoundEntry {
                                seat: seat.id.clone(),
                                name: seat.name.clone(),
                                model: seat.model.clone(),
                                content,
                                structured: serde_json::to_value(&c).unwrap_or(json!({})),
                                tool_uses: out.tool_uses,
                                usage: out.usage,
                            });
                        }
                        state.rounds.push(log);
                        settle(&ledger, &mut state, &hub);
                        if !critiques.trim().is_empty() && !hub.is_stopped() {
                            let user = prompts::document_revise_user(&draft, &critiques);
                            if let Some(revised) = self
                                .moderator_call(
                                    m,
                                    &prompts::moderator_system_document(),
                                    &user,
                                    tiers.record,
                                    6000,
                                    &ledger,
                                    "moderator",
                                )
                                .await
                            {
                                send(DebateEvent::Document {
                                    markdown: revised.clone(),
                                });
                                state.document = Some(revised);
                                settle(&ledger, &mut state, &hub);
                            }
                        }
                    }
                }
            }
        }

        // ---- Close -----------------------------------------------------------
        record.cost = ledger.lock().ok().map(|l| l.snapshot());
        send(DebateEvent::Record {
            record: record.clone(),
        });
        let md = record::to_markdown(&record, &names, state.document.as_deref());
        this.push_system_message(&mut state, "Moderator", &md);
        state.record = Some(record);
        let status = if state.stopped_early.is_some() {
            "stopped"
        } else {
            "completed"
        };
        let doc = this.session_json(&session_id, created_at, &state, &ledger, status);
        if let Some(store) = &this.store {
            if let Err(e) = store.save(&doc) {
                send(DebateEvent::Error {
                    message: format!("could not save the session: {e}"),
                });
            }
        }
        if let Some(snap) = ledger.lock().ok().map(|l| l.snapshot()) {
            send(DebateEvent::Cost { snapshot: snap });
        }
        send(DebateEvent::Done { session_id });
        doc
    }

    // ---- helpers ----------------------------------------------------------

    fn turn_ctx<'a>(
        &'a self,
        ledger: &'a Mutex<CostLedger>,
        hub: &'a InputHub,
        tx: &'a UnboundedSender<DebateEvent>,
        cache_key: Option<String>,
    ) -> seat_turn::TurnCtx<'a> {
        seat_turn::TurnCtx {
            http: &self.http,
            policy: &self.config.tools,
            tools: ToolContext {
                workspace: &self.config.workspace,
                attachments: &self.attachments,
                http: &self.http,
            },
            tx,
            hub,
            ledger,
            cache_key,
        }
    }

    /// One seat turn with the start event and error reporting around it.
    #[allow(clippy::too_many_arguments)]
    async fn seat(
        &self,
        ctx: &seat_turn::TurnCtx<'_>,
        seat: &SeatSpec,
        system: &str,
        user: &str,
        tier: ReasoningTier,
        specs: Vec<crate::types::ToolSpec>,
        round: RoundKind,
        live: bool,
    ) -> Option<seat_turn::TurnOutcome> {
        if ctx.hub.is_stopped() {
            return None;
        }
        let _ = ctx.tx.send(DebateEvent::SeatStarted {
            seat_id: seat.id.clone(),
            name: seat.name.clone(),
            provider: seat.provider,
            model: seat.model.clone(),
            round,
        });
        match seat_turn::run_seat_turn(
            ctx,
            seat,
            system,
            user,
            tier,
            specs,
            round,
            CostLane::Council,
            live,
        )
        .await
        {
            Ok(out) if !out.text.is_empty() => Some(out),
            Ok(_) => {
                let _ = ctx.tx.send(DebateEvent::Error {
                    message: format!("{} produced no answer this round", seat.name),
                });
                None
            }
            Err(e) => {
                let _ = ctx.tx.send(DebateEvent::Error {
                    message: format!("{} failed: {e}", seat.name),
                });
                None
            }
        }
    }

    /// A moderator or utility call: bounded, billed, text returned.
    #[allow(clippy::too_many_arguments)]
    async fn moderator_call(
        &self,
        m: &ModeratorSpec,
        system: &str,
        user: &str,
        tier: ReasoningTier,
        max_tokens: u32,
        ledger: &Mutex<CostLedger>,
        lane_id: &str,
    ) -> Option<String> {
        let mut text = String::new();
        let outcome = {
            let req = CompletionRequest {
                model: m.model.clone(),
                system: Some(system.to_string()),
                messages: vec![ChatMessage::user(user)],
                max_tokens,
                temperature: 0.7,
                tier,
                tools: Vec::new(),
                cache_key: None,
            };
            let mut on_chunk = |c: &CompletionChunk| text.push_str(&c.content);
            let fut = stream_completion(
                &self.http,
                m.provider,
                &m.base_url,
                &m.api_key,
                &req,
                &mut on_chunk,
            );
            tokio::time::timeout(MODERATOR_TIMEOUT, fut)
                .await
                .ok()?
                .ok()?
        };
        let (lane, name) = if lane_id == "utility" {
            (CostLane::Utility, "Utility")
        } else {
            (CostLane::Moderator, "Moderator")
        };
        if let Ok(mut l) = ledger.lock() {
            l.record(lane_id, name, lane, &m.model, outcome.usage);
        }
        let text = outcome.text.trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn roster_table(&self, seats: &[SeatSpec]) -> String {
        seats
            .iter()
            .map(|s| {
                let row = model_row(s.provider, &s.model);
                let price = match (row.pricing.input, row.pricing.output) {
                    (Some(i), Some(o)) => format!("${i:.2}/${o:.2}"),
                    _ => "unpriced".into(),
                };
                format!(
                    "{} | {} | {} | {} | {} | {} | {}",
                    s.id,
                    s.name,
                    s.provider.slug(),
                    s.model,
                    row.class.label(),
                    price,
                    if row.contract.tools { "yes" } else { "no" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn framing_text(&self, plan: &Plan, names: &BTreeMap<String, String>) -> String {
        let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
        let mut out = format!(
            "Deliverable: {}\nQuestion: {}\n",
            plan.deliverable.label(),
            plan.question
        );
        if !plan.options.is_empty() {
            out.push_str(&format!("Options: {}\n", plan.options.join(" | ")));
        }
        if !plan.settles.is_empty() {
            out.push_str(&format!("Settled by: {}\n", plan.settles));
        }
        out.push_str("Seats:\n");
        for p in &plan.participants {
            let lens = plan
                .lenses
                .get(&p.seat)
                .map(|l| format!("; lens: {l}"))
                .unwrap_or_default();
            out.push_str(&format!(
                "- {} as {}: {}{lens}\n",
                name(&p.seat),
                match p.role {
                    SeatRole::Principal => "principal",
                    SeatRole::Support => "support",
                },
                p.reason
            ));
        }
        for t in &plan.subtasks {
            out.push_str(&format!("- subtask for {}: {}\n", name(&t.seat), t.task));
        }
        out.push_str(&format!("Rounds allowed: {}", plan.rounds));
        out
    }

    fn fallback_record(&self, state: &RunState, plan: &Plan) -> DecisionRecord {
        let mut answer = String::new();
        for (id, r) in &state.revisions {
            answer.push_str(&format!("{}: {}\n", id, r.position));
        }
        if answer.is_empty() {
            for (id, p) in &state.positions {
                answer.push_str(&format!("{}: {}\n", id, p.position));
            }
        }
        if answer.is_empty() {
            answer = "The council produced no positions.".into();
        } else {
            answer = format!(
                "No record could be written by the moderator; the final positions were:\n{answer}"
            );
        }
        DecisionRecord {
            deliverable: plan.deliverable,
            question: plan.question.clone(),
            answer,
            confidence: 0.0,
            options_considered: Vec::new(),
            dissent: Vec::new(),
            assumptions: Vec::new(),
            evidence: state.board.evidence.clone(),
            open_questions: state.board.open_questions.clone(),
            next_actions: Vec::new(),
            what_changed: String::new(),
            votes: BTreeMap::new(),
            cost: None,
        }
    }

    fn push_message(&self, state: &mut RunState, seat: &SeatSpec, content: &str, thinking: &str) {
        state.messages.push(StoredMessage {
            agent_id: seat.id.clone(),
            display_name: seat.name.clone(),
            content: content.to_string(),
            thinking: thinking.to_string(),
            model: seat.model.clone(),
            at_ms: now_ms(),
        });
    }

    fn push_system_message(&self, state: &mut RunState, who: &str, content: &str) {
        state.messages.push(StoredMessage {
            agent_id: if who == "Moderator" {
                "moderator".into()
            } else {
                "system".into()
            },
            display_name: who.to_string(),
            content: content.to_string(),
            thinking: String::new(),
            model: String::new(),
            at_ms: now_ms(),
        });
    }

    fn persist(
        &self,
        id: &str,
        created_at: u64,
        state: &RunState,
        ledger: &Mutex<CostLedger>,
        status: &str,
    ) {
        if let Some(store) = &self.store {
            let doc = self.session_json(id, created_at, state, ledger, status);
            let _ = store.save(&doc);
        }
    }

    /// The session document, format v2: the flat `messages` every v1 reader
    /// lists and opens, plus the plan, board, rounds, record and costs.
    fn session_json(
        &self,
        id: &str,
        created_at: u64,
        state: &RunState,
        ledger: &Mutex<CostLedger>,
        status: &str,
    ) -> Value {
        let snapshot = ledger.lock().ok().map(|l| l.snapshot()).unwrap_or_default();
        let usage = Usage {
            input: snapshot.total_input,
            output: snapshot.total_output,
            reasoning: snapshot.total_reasoning,
            ..Default::default()
        };
        let turns = state
            .rounds
            .iter()
            .map(|r| r.entries.len() as u32)
            .sum::<u32>();
        let mut doc = build_session_json(
            id,
            &self.topic,
            created_at,
            &state.messages,
            status,
            turns,
            usage,
        );
        doc["version"] = json!(2);
        doc["protocol"] = json!("rounds");
        doc["roster"] = serde_json::to_value(&self.roster).unwrap_or(json!({}));
        doc["plan"] = serde_json::to_value(&state.plan).unwrap_or(Value::Null);
        doc["corrections"] = json!(state.corrections);
        doc["estimate"] = serde_json::to_value(&state.estimate).unwrap_or(Value::Null);
        doc["board"] = serde_json::to_value(&state.board).unwrap_or(json!({}));
        doc["rounds"] = serde_json::to_value(&state.rounds).unwrap_or(json!([]));
        doc["convergences"] = serde_json::to_value(&state.convergences).unwrap_or(json!([]));
        doc["record"] = serde_json::to_value(&state.record).unwrap_or(Value::Null);
        doc["document"] = serde_json::to_value(&state.document).unwrap_or(Value::Null);
        doc["costs"] = serde_json::to_value(&snapshot).unwrap_or(json!({}));
        doc["stoppedEarly"] = json!(state.stopped_early);
        doc["workspace"] = json!(self.config.workspace.display().to_string());
        doc
    }
}

fn seat_tier(roster: &Roster, id: &str, round_tier: ReasoningTier) -> ReasoningTier {
    roster
        .seat(id)
        .and_then(|s| s.reasoning)
        .unwrap_or(round_tier)
}

fn truncate(s: &str, chars: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= chars {
        return t.to_string();
    }
    let mut out: String = t.chars().take(chars).collect();
    out.push('…');
    out
}

fn compact_args(v: &Value) -> String {
    match v.as_object() {
        Some(o) => o
            .iter()
            .map(|(k, val)| {
                format!(
                    "{k}={}",
                    truncate(
                        &val.as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| val.to_string()),
                        60
                    )
                )
            })
            .collect::<Vec<_>>()
            .join(", "),
        None => String::new(),
    }
}

pub fn render_position(p: &Position) -> String {
    let mut out = p.position.clone();
    if !p.key_reason.is_empty() {
        out.push_str(&format!("\nReason: {}", p.key_reason));
    }
    if !p.strongest_objection.is_empty() {
        out.push_str(&format!("\nStrongest objection: {}", p.strongest_objection));
    }
    if !p.would_change_mind.is_empty() {
        out.push_str(&format!("\nWould change my mind: {}", p.would_change_mind));
    }
    out.push_str(&format!("\nConfidence: {:.0}%", p.confidence * 100.0));
    out
}

pub fn render_attack(a: &Attack, names: &BTreeMap<String, String>) -> String {
    let target = names
        .get(&a.target)
        .cloned()
        .unwrap_or_else(|| a.target.clone());
    let mut out = if a.target.is_empty() {
        String::new()
    } else {
        format!("To {target}")
    };
    if !a.claim_challenged.is_empty() {
        out.push_str(&format!(" on \"{}\"", a.claim_challenged));
    }
    if !out.is_empty() {
        out.push_str(": ");
    }
    out.push_str(&a.argument);
    if !a.evidence.is_empty() {
        out.push_str(&format!("\nEvidence: {}", a.evidence));
    }
    if !a.concession.is_empty() {
        out.push_str(&format!("\nConcession: {}", a.concession));
    }
    out
}

pub fn render_revision(r: &Revision) -> String {
    let mut out = r.position.clone();
    if !r.changed.is_empty() {
        out.push_str(&format!("\nChanged: {}", r.changed));
    }
    out.push_str(&format!("\nConfidence: {:.0}%", r.final_confidence * 100.0));
    if !r.vote.is_empty() {
        out.push_str(&format!("\nVote: {}", r.vote));
    }
    out
}

pub fn render_critique(c: &Critique) -> String {
    let mut out = String::new();
    for i in &c.issues {
        out.push_str(&format!("- {}: {} → {}\n", i.location, i.problem, i.fix));
    }
    out.push_str(if c.endorse {
        "Verdict: endorse"
    } else {
        "Verdict: revise"
    });
    out
}

/// The class label for a model, for surfaces that list the roster.
pub fn class_of(provider: Provider, model: &str) -> ModelClass {
    model_row(provider, model).class
}

/// Pricing lookup for surfaces (estimate previews).
pub fn pricing_of(provider: Provider, model: &str) -> Pricing {
    model_row(provider, model).pricing
}
