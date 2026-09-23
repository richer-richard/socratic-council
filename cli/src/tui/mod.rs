//! The Socratic Council TUI — the terminal client of the deliberation engine.
//!
//! Three surfaces: a **Home** landing with the council mark, a topic composer
//! and the council preset; a collapsible **sessions** sidebar (the store the
//! desktop app shares); and the **Session** screen, which renders the engine's
//! event stream — rounds, the board, the convergence judgement and the
//! decision record — and answers the moderator's question and tool approvals.
//! A Settings screen edits keys, the roster and the policies.

mod analysis;
mod home;
mod session;
mod settings;
mod sidebar;
pub mod theme;
pub mod view;

use crate::attach::Attachment;
use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::{select_roster, Config, KeySource, Preset};
use crate::deliberation::{DebateEvent, Deliberation, Deliverable, EngineInput};
use crate::store::{self, SessionStore};
use crate::types::{ModelChoice, Provider, Roster};
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::{Frame, Terminal};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;
use view::SessionView;

/// Everything a run needs to be convened from the Home view.
pub struct AppContext {
    pub http: reqwest::Client,
    pub config: Config,
    pub available: HashMap<Provider, Vec<DiscoveredModel>>,
    /// Providers a run may use — the `--providers` filter, or all eight. The
    /// roster and any convened council are restricted to this set; key gating
    /// happens at launch time so a keyless first run can add a key and go.
    pub providers: Vec<Provider>,
    /// Keys already resolved during a `--scan` pre-pass, reused at launch.
    pub prefetched_keys: HashMap<Provider, String>,
    /// Files attached via `run --file …` (the seats search and read them).
    pub attachments: Vec<Attachment>,
    /// Explicit seats from `--seats`; overrides the preset.
    pub roster_override: Option<Roster>,
    /// The council preset from `--preset` (Home can change it).
    pub preset: Preset,
    /// A deliverable forced with `--deliverable` (Home can change it).
    pub forced: Option<Deliverable>,
    /// A stored session to open and reconvene at start (`--resume`).
    pub resume: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum View {
    Home,
    Session,
    Settings,
}

/// How the composer convenes the council: the preset and the deliverable.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LaunchOptions {
    pub preset: Preset,
    /// `None` lets the moderator decide.
    pub deliverable: Option<Deliverable>,
}

/// The deliverable choices in the order the composer cycles them.
pub const DELIVERABLE_CHOICES: [Option<Deliverable>; 5] = [
    None,
    Some(Deliverable::Decision),
    Some(Deliverable::Analysis),
    Some(Deliverable::Document),
    Some(Deliverable::Review),
];

pub fn deliverable_label(d: Option<Deliverable>) -> &'static str {
    match d {
        None => "auto",
        Some(d) => d.label(),
    }
}

fn next_deliverable(current: Option<Deliverable>) -> Option<Deliverable> {
    let i = DELIVERABLE_CHOICES
        .iter()
        .position(|d| *d == current)
        .unwrap_or(0);
    DELIVERABLE_CHOICES[(i + 1) % DELIVERABLE_CHOICES.len()]
}

/// One seat of a convened (or stored) council, with its resolved model.
#[derive(Clone, Debug)]
pub struct SeatCard {
    pub id: String,
    pub name: String,
    pub provider: Option<Provider>,
    pub model: String,
    pub color: Color,
}

/// The two pages of a session, as on the desktop: the report, and every turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPage {
    Summary,
    Transcript,
}

impl SessionPage {
    pub fn label(self) -> &'static str {
        match self {
            SessionPage::Summary => "Summary",
            SessionPage::Transcript => "Transcript",
        }
    }
}

/// View state for the Session screen that the engine never sees.
#[derive(Debug, Clone, Default)]
pub struct SessionUi {
    /// The page picked with `t`. `None` until one is picked, and then the page
    /// follows the run: the transcript while there is nothing to summarise,
    /// the summary once the record exists.
    pub page: Option<SessionPage>,
    /// The page last drawn, so a change of page can reset the scroll.
    pub drawn: Option<SessionPage>,
    pub analysis: analysis::AnalysisView,
    /// The seat the critique graph is focused on, stepped with `[` and `]`.
    pub focus: Option<usize>,
    pub help: bool,
}

/// The right-hand pane of the Session screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SideTab {
    #[default]
    Plan,
    Board,
    Convergence,
    Cost,
    Seats,
}

impl SideTab {
    pub const ALL: [SideTab; 5] = [
        SideTab::Plan,
        SideTab::Board,
        SideTab::Convergence,
        SideTab::Cost,
        SideTab::Seats,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SideTab::Plan => "Plan",
            SideTab::Board => "Board",
            SideTab::Convergence => "Converge",
            SideTab::Cost => "Cost",
            SideTab::Seats => "Seats",
        }
    }

    fn step(self, delta: isize) -> SideTab {
        let i = SideTab::ALL.iter().position(|t| *t == self).unwrap_or(0) as isize;
        let n = SideTab::ALL.len() as isize;
        SideTab::ALL[((i + delta).rem_euclid(n)) as usize]
    }
}

/// One row in the sessions sidebar.
#[derive(Clone, Debug)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub turns: u32,
    pub archived: bool,
    /// `"cli"` / `"app"` — which surface last wrote the session.
    pub origin: String,
    pub version: u8,
    pub deliverable: Option<String>,
    pub answer: String,
    pub total_usd: f64,
    pub stopped_early: Option<String>,
}

struct EngineHandle {
    rx: UnboundedReceiver<DebateEvent>,
    input: UnboundedSender<EngineInput>,
    handle: JoinHandle<()>,
}

/// A live or stored deliberation on the Session screen.
pub struct SessionScreen {
    pub topic: String,
    pub session_id: String,
    pub seats: Vec<SeatCard>,
    pub view: SessionView,
    pub side: SideTab,
    pub show_thinking: bool,
    pub follow: bool,
    pub scroll: u16,
    /// The answer being typed for the moderator's question.
    pub answer: String,
    /// A stored session (no engine behind it).
    pub read_only: bool,
    pub ui: SessionUi,
    engine: Option<EngineHandle>,
    /// Frame until which a second `Esc` stops a live council.
    confirm_stop_until: u64,
}

impl SessionScreen {
    pub fn is_live(&self) -> bool {
        self.engine.is_some() && !self.view.done
    }

    /// Seat id → display name, for the board and the record.
    pub fn names(&self) -> BTreeMap<String, String> {
        self.seats
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect()
    }

    pub fn seat(&self, id: &str) -> Option<&SeatCard> {
        self.seats.iter().find(|s| s.id == id)
    }

    /// The page to draw. When it changes, each page opens where it is read
    /// from: the summary at the top, a live transcript at the newest turn.
    pub fn page(&mut self) -> SessionPage {
        let page = self.ui.page.unwrap_or(if self.view.record.is_some() {
            SessionPage::Summary
        } else {
            SessionPage::Transcript
        });
        if self.ui.drawn != Some(page) {
            self.ui.drawn = Some(page);
            self.scroll = 0;
            self.follow = page == SessionPage::Transcript && self.is_live();
        }
        page
    }

    /// `running` / `completed` / `stopped` / `cancelled` / `failed` / `starting`.
    pub fn status(&self) -> (&'static str, Color) {
        if self.is_live() {
            return ("running", theme::GOLD);
        }
        match self.view.stopped_early.as_deref() {
            Some("cancelled") => ("cancelled", theme::MUTED),
            Some("failed") => ("failed", theme::ROSE),
            Some(_) => ("stopped", theme::ROSE),
            None if self.view.done => ("completed", theme::EMERALD),
            None => ("starting", theme::GOLD),
        }
    }
}

/// In-progress API-key entry in Settings. The buffer holds the secret while
/// it is typed or pasted; it renders masked and is dropped once saved or
/// cancelled (never logged, never shown in plaintext).
pub struct KeyDraft {
    pub provider: Provider,
    pub buffer: String,
}

/// A proxy URL shown in the UI: userinfo (user:password@) is redacted.
pub fn redact_proxy(url: &str) -> String {
    match (url.find("://"), url.find('@')) {
        (Some(scheme_end), Some(at)) if at > scheme_end + 3 => {
            format!("{}://•••@{}", &url[..scheme_end], &url[at + 1..])
        }
        _ => url.to_string(),
    }
}

/// Sidebar rows: the shared store first (newest first), then any app-index
/// session the store does not have. Ids are unique across both.
fn merge_session_rows(
    store: Option<&SessionStore>,
    bridge_rows: Vec<SessionRow>,
) -> Vec<SessionRow> {
    let mut rows: Vec<SessionRow> = store
        .map(|s| {
            s.list()
                .into_iter()
                .map(|s| SessionRow {
                    id: s.id,
                    title: if s.title.is_empty() { s.topic } else { s.title },
                    status: s.status,
                    turns: s.current_turn,
                    archived: false,
                    origin: s.origin,
                    version: s.version,
                    deliverable: s.deliverable,
                    answer: s.answer,
                    total_usd: s.total_usd,
                    stopped_early: s.stopped_early,
                })
                .collect()
        })
        .unwrap_or_default();
    for r in bridge_rows {
        if !rows.iter().any(|x| x.id == r.id) {
            rows.push(r);
        }
    }
    rows
}

fn bridge_row(s: &crate::bridge::DesktopSession) -> SessionRow {
    SessionRow {
        id: s.id.clone(),
        title: s.title.clone(),
        status: s.status.clone(),
        turns: s.current_turn,
        archived: s.archived,
        origin: "app".into(),
        version: 1,
        deliverable: None,
        answer: String::new(),
        total_usd: 0.0,
        stopped_early: None,
    }
}

pub struct App {
    ctx: AppContext,
    view: View,
    /// The view to return to when Settings closes, so `^P`/`Esc` out of
    /// Settings never strands a live session by jumping to Home.
    prev_view: View,
    frame: u64,
    sidebar_open: bool,
    composer: String,
    launch: LaunchOptions,
    sessions: Vec<SessionRow>,
    sessions_loaded: bool,
    sidebar_sel: usize,
    session: Option<SessionScreen>,
    toast: Option<String>,
    toast_expire: u64,
    key_cache: HashMap<Provider, String>,
    /// Cursor over the Settings rows: the eight providers, then the options.
    settings_sel: usize,
    key_draft: Option<KeyDraft>,
    settings_draft: Option<settings::SettingsDraft>,
    /// Write config changes to disk (off in tests).
    persist: bool,
    /// The shared session store (the app's data dir when installed, else the
    /// CLI's own). `None` only when neither location is usable.
    store: Option<SessionStore>,
}

/// Rewrite a stored session the engine could not finish as stopped.
fn mark_stopped(store: &SessionStore, id: &str) {
    let Some(mut doc) = store.load(id) else {
        return;
    };
    if doc["status"].as_str() != Some("active") {
        return;
    }
    doc["status"] = serde_json::Value::from("stopped");
    if doc["stoppedEarly"].is_null() {
        doc["stoppedEarly"] = serde_json::Value::from("cancelled");
    }
    let _ = store.save(&doc);
}

impl App {
    fn new(ctx: AppContext) -> Self {
        let store = crate::bridge::open_store(ctx.config.bridge());
        let bridge_rows = ctx
            .config
            .bridge()
            .sessions()
            .iter()
            .map(bridge_row)
            .collect::<Vec<_>>();
        let sessions = merge_session_rows(store.as_ref(), bridge_rows);
        Self {
            store,
            view: View::Home,
            prev_view: View::Home,
            frame: 0,
            sidebar_open: false,
            composer: String::new(),
            launch: LaunchOptions {
                preset: ctx.preset,
                deliverable: ctx.forced,
            },
            sessions_loaded: !sessions.is_empty(),
            sessions,
            sidebar_sel: 0,
            session: None,
            toast: None,
            toast_expire: 0,
            key_cache: ctx.prefetched_keys.clone(),
            settings_sel: 0,
            key_draft: None,
            settings_draft: None,
            persist: true,
            ctx,
        }
    }

    fn toast(&mut self, msg: impl Into<String>) {
        self.toast = Some(msg.into());
        self.toast_expire = self.frame + 45; // ~3s at 70ms/frame
    }

    fn configured_count(&self) -> usize {
        self.ctx.config.configured_providers().len()
    }

    /// The seats the current launch options convene: keyed seats of the
    /// allowed providers, in roster order, cut to the preset.
    fn convened_seats(&self) -> Roster {
        select_roster(
            &self.ctx.config,
            &self.ctx.providers,
            self.ctx.roster_override.as_ref(),
            self.launch.preset,
        )
    }

    /// Lazily load the sessions list the first time the sidebar opens.
    fn ensure_sessions(&mut self) {
        if self.sessions_loaded {
            return;
        }
        self.sessions_loaded = true;
        let bridge_rows: Vec<SessionRow> = if self.ctx.config.bridge().has_sessions_to_unlock() {
            self.ctx
                .config
                .bridge()
                .read_sessions()
                .iter()
                .map(bridge_row)
                .collect()
        } else {
            self.sessions
                .iter()
                .filter(|r| r.origin == "app" && r.version == 1)
                .cloned()
                .collect()
        };
        self.sessions = merge_session_rows(self.store.as_ref(), bridge_rows);
    }

    /// Re-read the store (a run just ended, or the app wrote something).
    fn refresh_sessions(&mut self) {
        self.sessions_loaded = false;
        self.ensure_sessions();
        self.sidebar_sel = self.sidebar_sel.min(self.sessions.len().saturating_sub(1));
    }

    fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
        if self.sidebar_open {
            self.ensure_sessions();
            self.sidebar_sel = self.sidebar_sel.min(self.sessions.len().saturating_sub(1));
        }
    }

    /// Convene the council on `topic`. `prior_notes` carries a reconvened
    /// session's record (or transcript tail) to the planner.
    fn launch(&mut self, topic: String, prior_notes: Option<String>) {
        let topic = topic.trim().to_string();
        if topic.is_empty() {
            return;
        }
        // Never orphan a running engine — it would keep spending quota.
        self.abort_engine();
        let config = self.ctx.config.clone();
        let roster = self.convened_seats();
        if roster.seats.is_empty() {
            // Keep the topic so the user can add a key and convene without
            // retyping it.
            self.composer = topic;
            let keyed_but_filtered = Provider::ALL
                .into_iter()
                .any(|p| config.is_configured(p) && !self.ctx.providers.contains(&p));
            if keyed_but_filtered {
                self.toast("Your keyed providers are excluded by --providers this run.");
            } else {
                self.toast("No API keys yet — press ^P to add one in Settings.");
            }
            return;
        }

        // Resolve each keyed provider's key once and cache it for the
        // session; the moderator may sit on a provider with no seat.
        let mut keys = HashMap::new();
        for provider in Provider::ALL {
            if !config.is_configured(provider) {
                continue;
            }
            if let Some(k) = self.key_cache.get(&provider) {
                keys.insert(provider, k.clone());
            } else if let Some(k) = config.resolve_api_key(provider) {
                self.key_cache.insert(provider, k.clone());
                keys.insert(provider, k);
            }
        }
        let roster = roster.with_keys(|p| keys.contains_key(&p));
        if roster.seats.is_empty() {
            self.toast("Couldn't read a stored key — add one here with ^P.");
            return;
        }

        let available = self.ctx.available.clone();
        let seats: Vec<SeatCard> = roster
            .seats
            .iter()
            .map(|s| {
                let empty = Vec::new();
                let avail = available.get(&s.provider).unwrap_or(&empty);
                let model = match &s.model {
                    ModelChoice::Id(id) => id.clone(),
                    ModelChoice::Auto(tier) => resolve_model(
                        s.provider,
                        *tier,
                        avail,
                        config.selection(s.provider, *tier).as_deref(),
                    ),
                };
                SeatCard {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    provider: Some(s.provider),
                    model,
                    color: theme::provider_color(s.provider),
                }
            })
            .collect();

        let session_id = store::new_session_id();
        let engine = Deliberation::new(
            self.ctx.http.clone(),
            config.engine_config(&session_id),
            topic.clone(),
            roster,
            keys,
            available,
        )
        .with_attachments(self.ctx.attachments.clone())
        .with_forced_deliverable(self.launch.deliverable)
        .with_store(crate::bridge::open_store(config.bridge()))
        .with_prior_notes(prior_notes);
        let (tx, rx) = unbounded_channel();
        let (input, input_rx) = unbounded_channel::<EngineInput>();
        let handle = tokio::spawn(async move {
            let _ = engine.run(tx, input_rx).await;
        });

        self.session = Some(SessionScreen {
            topic,
            session_id,
            seats,
            view: SessionView::default(),
            side: SideTab::Plan,
            show_thinking: false,
            follow: true,
            scroll: 0,
            answer: String::new(),
            read_only: false,
            engine: Some(EngineHandle { rx, input, handle }),
            confirm_stop_until: 0,
            ui: SessionUi::default(),
        });
        self.composer.clear();
        self.view = View::Session;
    }

    /// Cancel and abort the current engine task if one is live.
    fn abort_engine(&mut self) {
        let Some(s) = self.session.as_mut() else {
            return;
        };
        let Some(e) = &s.engine else {
            return;
        };
        let _ = e.input.send(EngineInput::Cancel);
        e.handle.abort();
        s.view.mark_cancelled();
        // The aborted task never reaches its own final save, which would
        // leave the stored session `active` for good: mark it stopped here.
        if let Some(store) = &self.store {
            mark_stopped(store, &s.session_id);
        }
    }

    /// Stop a running council (if any) and return to Home.
    fn stop_session(&mut self) {
        self.abort_engine();
        self.session = None;
        self.view = View::Home;
        self.refresh_sessions();
    }

    /// Reconvene the open session: its record (or transcript tail) becomes
    /// the planner's notes and a new session is written.
    fn reconvene(&mut self) {
        let Some(s) = self.session.as_ref() else {
            return;
        };
        if s.is_live() {
            return;
        }
        let names = s.names();
        let prior = s
            .view
            .record_markdown(&names)
            .or_else(|| s.view.transcript_tail(6));
        let topic = s.topic.clone();
        self.launch(topic, prior);
    }

    /// Write the open session's record and document (or its transcript) to
    /// a Markdown file in the Downloads folder (else the config dir).
    fn export(&mut self) {
        let Some(s) = self.session.as_ref() else {
            return;
        };
        let names = s.names();
        let body = s
            .view
            .record_markdown(&names)
            .or_else(|| s.view.document.clone())
            .or_else(|| {
                let lines: Vec<String> = s
                    .view
                    .legacy
                    .iter()
                    .map(|m| format!("**{}**: {}", m.display_name, m.content))
                    .collect();
                (!lines.is_empty()).then(|| format!("# {}\n\n{}\n", s.topic, lines.join("\n\n")))
            });
        let Some(body) = body else {
            self.toast("Nothing to export yet — the record arrives at the end.");
            return;
        };
        let dir = directories::UserDirs::new()
            .and_then(|u| u.download_dir().map(|p| p.to_path_buf()))
            .or_else(|| Config::config_dir().ok())
            .unwrap_or_else(std::env::temp_dir);
        let path = dir.join(format!("socratic-council-{}.md", s.session_id));
        match std::fs::write(&path, body) {
            Ok(()) => self.toast(format!("Exported to {}", path.display())),
            Err(e) => self.toast(format!("Couldn't export: {e}")),
        }
    }

    /// Open the highlighted stored session read-only.
    fn open_selected_session(&mut self) {
        let Some(row) = self.sessions.get(self.sidebar_sel).cloned() else {
            return;
        };
        self.open_session(&row.id, Some(&row.title));
    }

    /// Open a stored session by id. Returns false when it could not be read.
    fn open_session(&mut self, id: &str, title: Option<&str>) -> bool {
        let stored = self.store.as_ref().and_then(|s| s.load(id));
        let (view, topic, roster): (SessionView, String, Option<Roster>) = match &stored {
            Some(doc) => (
                SessionView::from_stored(doc),
                doc["topic"].as_str().or(title).unwrap_or("").to_string(),
                serde_json::from_value(doc["roster"].clone()).ok(),
            ),
            None => {
                // Fallback for a session the app never exported to the
                // shared store. Only pre-Sept-2026 app sessions are still
                // readable this way: newer blobs live in the app's IndexedDB
                // (see bridge.rs), so this yields nothing for them and the
                // empty-view check below reports it.
                let messages = self
                    .ctx
                    .config
                    .bridge()
                    .load_session_transcript(id)
                    .unwrap_or_default();
                let doc = serde_json::json!({
                    "messages": messages.iter().map(|m| serde_json::json!({
                        "agentId": m.agent_id, "displayName": m.name, "content": m.content,
                    })).collect::<Vec<_>>()
                });
                (
                    SessionView::from_stored(&doc),
                    title.unwrap_or("").to_string(),
                    None,
                )
            }
        };
        if view.rounds.is_empty() && view.legacy.is_empty() && view.record.is_none() {
            self.toast("Couldn't read that session (locked, empty, or needs the app's key).");
            return false;
        }
        self.abort_engine();

        // Seat cards: the stored roster, else the distinct speakers.
        let mut seats: Vec<SeatCard> = roster
            .map(|r| {
                r.seats
                    .into_iter()
                    .map(|s| SeatCard {
                        id: s.id,
                        name: s.name,
                        provider: Some(s.provider),
                        model: s.model.label(),
                        color: theme::provider_color(s.provider),
                    })
                    .collect()
            })
            .unwrap_or_default();
        for t in view.rounds.iter().flat_map(|r| r.entries.iter()) {
            if let Some(card) = seats.iter_mut().find(|c| c.id == t.seat_id) {
                if !t.model.is_empty() {
                    card.model = t.model.clone();
                }
            } else {
                seats.push(SeatCard {
                    id: t.seat_id.clone(),
                    name: t.name.clone(),
                    provider: t.provider,
                    model: t.model.clone(),
                    color: t
                        .provider
                        .map(theme::provider_color)
                        .unwrap_or_else(|| theme::speaker_color(&t.seat_id)),
                });
            }
        }
        for m in &view.legacy {
            if matches!(
                m.agent_id.as_str(),
                "user" | "system" | "tool" | "error" | "moderator"
            ) || seats.iter().any(|c| c.id == m.agent_id)
            {
                continue;
            }
            let provider = theme::AGENTS
                .iter()
                .find(|a| a.id == m.agent_id)
                .map(|a| a.provider);
            seats.push(SeatCard {
                id: m.agent_id.clone(),
                name: m.display_name.clone(),
                provider,
                model: m.model.clone(),
                color: theme::speaker_color(&m.agent_id),
            });
        }

        self.session = Some(SessionScreen {
            topic,
            session_id: id.to_string(),
            seats,
            view,
            side: SideTab::Plan,
            show_thinking: false,
            follow: false,
            scroll: 0,
            answer: String::new(),
            read_only: true,
            engine: None,
            confirm_stop_until: 0,
            ui: SessionUi::default(),
        });
        self.view = View::Session;
        true
    }

    /// Returns `true` to quit the app.
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Global: Ctrl-C quits from anywhere.
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        // Ctrl-P toggles Settings from anywhere and returns to wherever you
        // were (a live Session included), not unconditionally Home.
        if key.code == KeyCode::Char('p') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if self.view == View::Settings {
                self.view = self.prev_view;
            } else {
                self.prev_view = self.view;
                self.view = View::Settings;
            }
            return false;
        }
        match self.view {
            View::Home => self.handle_home_key(key),
            View::Session => self.handle_session_key(key),
            View::Settings => settings::handle_key(self, key),
        }
    }

    fn handle_home_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => return true,
            KeyCode::Tab => self.toggle_sidebar(),
            KeyCode::Enter => {
                // A non-empty composer convenes; otherwise open the
                // highlighted stored session from the sidebar.
                if !self.composer.trim().is_empty() {
                    let topic = self.composer.clone();
                    self.launch(topic, None);
                } else if self.sidebar_open && !self.sessions.is_empty() {
                    self.open_selected_session();
                }
            }
            KeyCode::Up if self.sidebar_open => {
                self.sidebar_sel = self.sidebar_sel.saturating_sub(1);
            }
            KeyCode::Down if self.sidebar_open => {
                let max = self.sessions.len().saturating_sub(1);
                self.sidebar_sel = (self.sidebar_sel + 1).min(max);
            }
            KeyCode::Left => self.launch.preset = self.launch.preset.prev(),
            KeyCode::Right => self.launch.preset = self.launch.preset.next(),
            KeyCode::Char('d') if ctrl => {
                self.launch.deliverable = next_deliverable(self.launch.deliverable);
            }
            KeyCode::Backspace => {
                self.composer.pop();
            }
            // Only insert printable input — a Ctrl+<letter> chord must not
            // land its bare letter in the composer.
            KeyCode::Char(c) if !ctrl => self.composer.push(c),
            _ => {}
        }
        false
    }

    fn handle_session_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let frame = self.frame;
        let Some(s) = self.session.as_mut() else {
            self.view = View::Home;
            return false;
        };

        // The moderator's question owns the keyboard while it is pending.
        if let Some(q) = s.view.pending_question.clone() {
            match key.code {
                KeyCode::Enter | KeyCode::Esc => {
                    let text = if key.code == KeyCode::Enter {
                        std::mem::take(&mut s.answer).trim().to_string()
                    } else {
                        s.answer.clear();
                        String::new()
                    };
                    if let Some(e) = &s.engine {
                        let _ = e.input.send(EngineInput::UserAnswer { id: q.id, text });
                    }
                    s.view.pending_question = None;
                }
                KeyCode::Backspace => {
                    s.answer.pop();
                }
                KeyCode::Char('u') if ctrl => s.answer.clear(),
                KeyCode::Char(c) if !ctrl => s.answer.push(c),
                _ => {}
            }
            return false;
        }
        // Then a tool approval.
        if let Some(a) = s.view.pending_approval.clone() {
            let decision = match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => Some(true),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(false),
                _ => None,
            };
            if let Some(allow) = decision {
                if let Some(e) = &s.engine {
                    let _ = e.input.send(EngineInput::ToolDecision { id: a.id, allow });
                }
                s.view.pending_approval = None;
                return false;
            }
        }

        // The help overlay closes on Esc or `?` and swallows nothing else.
        if s.ui.help && matches!(key.code, KeyCode::Esc | KeyCode::Char('?')) {
            s.ui.help = false;
            return false;
        }

        match key.code {
            KeyCode::Char('?') => s.ui.help = true,
            KeyCode::Esc | KeyCode::Char('q') if !ctrl => {
                if s.is_live() {
                    if frame < s.confirm_stop_until {
                        self.stop_session();
                    } else {
                        s.confirm_stop_until = frame + 30;
                        self.toast("Press Esc again to stop the council.");
                    }
                } else {
                    self.session = None;
                    self.view = View::Home;
                    self.refresh_sessions();
                }
            }
            KeyCode::Tab => self.toggle_sidebar(),
            KeyCode::Char('t') if !ctrl => {
                let now = s.page();
                s.ui.page = Some(match now {
                    SessionPage::Summary => SessionPage::Transcript,
                    SessionPage::Transcript => SessionPage::Summary,
                });
            }
            KeyCode::Char('T') if !ctrl => s.show_thinking = !s.show_thinking,
            KeyCode::Char(c @ '1'..='4') if !ctrl => {
                if let Some(v) = analysis::AnalysisView::from_digit(c) {
                    s.ui.analysis = v;
                    s.ui.page = Some(SessionPage::Summary);
                }
            }
            KeyCode::Char(c @ ('[' | ']')) if !ctrl => {
                // Step through the seats the critique graph draws, with "all
                // of them" as the stop between the last seat and the first.
                let n = s
                    .view
                    .peer_eval
                    .as_ref()
                    .map(|p| p.seats.len())
                    .unwrap_or(0);
                if n > 0 {
                    s.ui.focus = match (s.ui.focus, c) {
                        (None, ']') => Some(0),
                        (None, _) => Some(n - 1),
                        (Some(i), ']') if i + 1 < n => Some(i + 1),
                        (Some(i), '[') if i > 0 => Some(i - 1),
                        _ => None,
                    };
                }
            }
            KeyCode::Char('p') if !ctrl => s.side = SideTab::Plan,
            KeyCode::Char('b') if !ctrl => s.side = SideTab::Board,
            KeyCode::Char('v') if !ctrl => s.side = SideTab::Convergence,
            KeyCode::Char('$') if !ctrl => s.side = SideTab::Cost,
            KeyCode::Char('s') if !ctrl => s.side = SideTab::Seats,
            KeyCode::Left => s.side = s.side.step(-1),
            KeyCode::Right => s.side = s.side.step(1),
            KeyCode::Up => {
                s.follow = false;
                s.scroll = s.scroll.saturating_sub(1);
            }
            KeyCode::Down => s.scroll = s.scroll.saturating_add(1),
            KeyCode::PageUp => {
                s.follow = false;
                s.scroll = s.scroll.saturating_sub(10);
            }
            KeyCode::PageDown => s.scroll = s.scroll.saturating_add(10),
            KeyCode::Home => {
                s.follow = false;
                s.scroll = 0;
            }
            KeyCode::End | KeyCode::Char('g') => {
                // The transcript follows the newest turn; the summary has no
                // newest turn, so End there simply means the bottom.
                s.follow = true;
                s.scroll = u16::MAX;
            }
            KeyCode::Char('r') if !ctrl => self.reconvene(),
            KeyCode::Char('e') if !ctrl => self.export(),
            KeyCode::Enter if s.read_only => self.reconvene(),
            _ => {}
        }
        false
    }

    /// Persist a key typed in Settings to the encrypted `keys.enc` store,
    /// then prime the cache so the next run uses it immediately.
    fn save_key(&mut self, provider: Provider, key: String) {
        self.ctx.config.set_key(provider, key.clone());
        if let Err(e) = self.ctx.config.save_keys() {
            self.toast(format!("Couldn't save key: {e}"));
            return;
        }
        self.key_cache.insert(provider, key);
        self.toast(format!("Saved {} key.", provider.display_name()));
    }

    /// Remove a locally-stored key. A key shared from the desktop app or
    /// sourced from an env var is not this CLI's to delete.
    fn clear_key(&mut self, provider: Provider) {
        match self.ctx.config.key_source(provider) {
            KeySource::Local => {
                self.ctx.config.clear_key(provider);
                let _ = self.ctx.config.save_keys();
                self.key_cache.remove(&provider);
                self.toast(format!("Removed {} key.", provider.display_name()));
            }
            KeySource::Env => {
                self.toast("That key comes from an env var — unset it in your shell.")
            }
            KeySource::Shared => {
                self.toast("That key is shared from the desktop app — managed there.")
            }
            KeySource::None => self.toast("No key to remove."),
        }
    }

    /// Route pasted text to whatever input is focused. Control chars (incl.
    /// the trailing newline a bracketed paste carries) are stripped so a
    /// pasted key, topic or answer stays a single clean line.
    fn handle_paste(&mut self, text: String) {
        let clean: String = text.chars().filter(|c| !c.is_control()).collect();
        if clean.is_empty() {
            return;
        }
        match self.view {
            View::Settings => {
                if let Some(d) = self.key_draft.as_mut() {
                    d.buffer.push_str(&clean);
                } else if let Some(d) = self.settings_draft.as_mut() {
                    d.buffer.push_str(&clean);
                }
            }
            View::Home => self.composer.push_str(&clean),
            View::Session => {
                if let Some(s) = self
                    .session
                    .as_mut()
                    .filter(|s| s.view.pending_question.is_some())
                {
                    s.answer.push_str(&clean);
                }
            }
        }
    }

    /// Drain the live engine's events into the view. Returns true when
    /// anything arrived (or the engine went away).
    fn pump_engine(&mut self) -> bool {
        use tokio::sync::mpsc::error::TryRecvError;
        let mut pending = Vec::new();
        let mut disconnected = false;
        let Some(s) = self.session.as_mut() else {
            return false;
        };
        if let Some(e) = s.engine.as_mut() {
            loop {
                match e.rx.try_recv() {
                    Ok(ev) => pending.push(ev),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        let had_events = !pending.is_empty() || disconnected;
        let mut finished = false;
        for ev in pending {
            if matches!(ev, DebateEvent::Done { .. }) {
                finished = true;
            }
            s.view.apply(ev);
        }
        // The engine task ended (a panic, or an abort) without `Done`: never
        // leave the screen waiting for an event that will not come.
        if disconnected && !s.view.done {
            s.view
                .errors
                .push("The engine stopped before finishing.".into());
            s.view.stopped_early.get_or_insert_with(|| "failed".into());
            s.view.done = true;
            s.view.active.clear();
            finished = true;
        }
        if finished {
            s.engine = None;
            self.refresh_sessions();
        }
        had_events
    }
}

/// Restores the terminal (raw mode, bracketed paste, alternate screen,
/// cursor) on `Drop` — on a normal exit and if `run_loop` panics.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            crossterm::cursor::Show
        );
    }
}

/// Enter the alternate screen and run the TUI to completion. `initial_topic`
/// (from `run <topic>`) convenes straight away; `ctx.resume` reconvenes a
/// stored session.
pub async fn run(ctx: AppContext, initial_topic: Option<String>) -> anyhow::Result<()> {
    enable_raw_mode()?;
    // From here on, any early return or panic restores the terminal via Drop.
    let _guard = TerminalGuard;
    let mut stdout = io::stdout();
    // Bracketed paste lets a pasted API key arrive as one `Event::Paste`
    // instead of a burst of key events.
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(ctx);
    if let Some(id) = app.ctx.resume.clone() {
        if app.open_session(&id, None) {
            if let Some(topic) = initial_topic.as_deref().filter(|t| !t.trim().is_empty()) {
                if let Some(s) = app.session.as_mut() {
                    s.topic = topic.to_string();
                }
            }
            app.reconvene();
        } else {
            app.toast(format!(
                "Session {id} could not be read; convene a fresh one."
            ));
        }
    } else if let Some(topic) = initial_topic {
        if !topic.trim().is_empty() {
            app.launch(topic, None);
        }
    }

    let result = run_loop(&mut terminal, &mut app).await;

    // Tear the engine down before the guard leaves raw mode.
    app.abort_engine();
    result
}

async fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> anyhow::Result<()> {
    // Redraw only when something changed, or while an animation is live.
    let mut dirty = true;
    loop {
        if app.pump_engine() {
            dirty = true;
        }
        if app.toast.is_some() && app.frame >= app.toast_expire {
            app.toast = None;
            dirty = true;
        }
        let animating = app.view == View::Home || app.session.as_ref().is_some_and(|s| s.is_live());
        if dirty || animating {
            terminal.draw(|f| render(f, app))?;
        }
        dirty = false;

        // Block up to one frame for animation cadence, then drain everything
        // queued this tick so a char-by-char paste still registers instantly.
        if event::poll(Duration::from_millis(70))? {
            loop {
                let mut quit = false;
                match event::read()? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        quit = app.handle_key(key);
                        dirty = true;
                    }
                    Event::Paste(text) => {
                        app.handle_paste(text);
                        dirty = true;
                    }
                    // A static screen (a saved session, Settings) only
                    // redraws when something marks it dirty, so without this
                    // a resize left the old layout clipped until a key press.
                    Event::Resize(_, _) => dirty = true,
                    _ => {}
                }
                if quit {
                    return Ok(());
                }
                if !event::poll(Duration::from_secs(0))? {
                    break;
                }
            }
        }
        app.frame = app.frame.wrapping_add(1);
    }
}

fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let main_area = if app.sidebar_open && area.width >= 60 {
        let cols = Layout::horizontal([Constraint::Length(32), Constraint::Min(0)]).split(area);
        sidebar::render(f, cols[0], app);
        cols[1]
    } else {
        area
    };

    match app.view {
        View::Home => home::render(f, main_area, app),
        View::Session => session::render(f, main_area, app),
        View::Settings => settings::render(f, main_area, app),
    }

    render_toast(f, area, app);
}

fn render_toast(f: &mut Frame, area: Rect, app: &App) {
    let Some(msg) = &app.toast else {
        return;
    };
    let width = (msg.chars().count() as u16 + 4).min(area.width.saturating_sub(2));
    if width == 0 || area.height < 4 {
        return;
    }
    let rect = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + area.height.saturating_sub(3),
        width,
        height: 3,
    };
    f.render_widget(Clear, rect);
    let para = Paragraph::new(Line::from(Span::styled(
        msg.clone(),
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
    )))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::GOLD)),
    )
    .alignment(ratatui::layout::Alignment::Center);
    f.render_widget(para, rect);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deliberation::{
        Board, Convergence, DecisionRecord, Disagreement, Dissent, Estimate, Evidence,
        ModeratorNoteKind, OptionConsidered, Participant, Plan, Recommend, RoundKind, SeatRole,
    };
    use crate::types::{CostSnapshot, ToolCall, Usage};
    use ratatui::backend::TestBackend;
    use serde_json::json;

    fn test_app() -> App {
        let ctx = AppContext {
            http: reqwest::Client::new(),
            config: Config::default(),
            available: HashMap::new(),
            providers: Provider::ALL.to_vec(),
            prefetched_keys: HashMap::new(),
            attachments: Vec::new(),
            roster_override: None,
            preset: Preset::Standard,
            forced: None,
            resume: None,
        };
        let mut app = App::new(ctx);
        app.persist = false;
        app
    }

    fn card(id: &str, name: &str, provider: Provider) -> SeatCard {
        SeatCard {
            id: id.into(),
            name: name.into(),
            provider: Some(provider),
            model: format!("{}-model", provider.slug()),
            color: theme::provider_color(provider),
        }
    }

    /// A session mid cross-examination with a record already in (so every
    /// card renders at once), one seat still streaming, and a tool use.
    pub(super) fn sample_screen() -> SessionScreen {
        let mut view = SessionView::default();
        for p in ["Framing", "Prep", "Positions", "Cross-examination 1"] {
            view.apply(DebateEvent::Phase { name: p.into() });
        }
        view.apply(DebateEvent::Plan {
            plan: Plan {
                deliverable: Deliverable::Decision,
                question: "Should we colonize Mars?".into(),
                options: vec!["Yes".into(), "Later".into()],
                settles: "a go/no-go".into(),
                participants: vec![
                    Participant {
                        seat: "george".into(),
                        role: SeatRole::Principal,
                        reason: "frontier".into(),
                    },
                    Participant {
                        seat: "cathy".into(),
                        role: SeatRole::Support,
                        reason: "fast chores".into(),
                    },
                ],
                lenses: [("george".to_string(), "cost".to_string())]
                    .into_iter()
                    .collect(),
                subtasks: vec![],
                rounds: 2,
                ask_user: None,
            },
            corrections: vec!["rounds capped to 2".into()],
        });
        view.apply(DebateEvent::Estimate {
            estimate: Estimate {
                calls: 9,
                usd_low: 0.2,
                usd_high: 0.6,
                unpriced_seats: vec!["mary".into()],
                review: true,
            },
        });
        for (id, name) in [("george", "George"), ("cathy", "Cathy")] {
            view.apply(DebateEvent::SeatStarted {
                seat_id: id.into(),
                name: name.into(),
                provider: Provider::OpenAI,
                model: "gpt-x".into(),
                round: RoundKind::Positions,
            });
            view.apply(DebateEvent::SeatFinished {
                seat_id: id.into(),
                name: name.into(),
                round: RoundKind::Positions,
                usage: Usage {
                    input: 1200,
                    output: 300,
                    reasoning: 100,
                    ..Default::default()
                },
                content: format!("{name} takes a position.\n- point one\n- point two"),
                structured: json!({}),
            });
        }
        view.apply(DebateEvent::SeatStarted {
            seat_id: "george".into(),
            name: "George".into(),
            provider: Provider::OpenAI,
            model: "gpt-x".into(),
            round: RoundKind::Cross(1),
        });
        view.apply(DebateEvent::Thinking {
            seat_id: "george".into(),
            text: "weighing the objection".into(),
        });
        view.apply(DebateEvent::ToolCall {
            seat_id: "george".into(),
            call: ToolCall {
                id: "c1".into(),
                name: "web_search".into(),
                arguments: json!({"query": "mars colony cost"}),
                signature: None,
            },
            output: "1. Example — https://e.com".into(),
            error: None,
        });
        view.apply(DebateEvent::Token {
            seat_id: "george".into(),
            text: "streaming a rebuttal…".into(),
        });
        view.apply(DebateEvent::Board {
            board: Board {
                settled: vec!["it is expensive".into()],
                disagreements: vec![Disagreement {
                    between: vec!["george".into(), "cathy".into()],
                    about: "timing".into(),
                }],
                evidence: vec![Evidence {
                    claim: "costs 1T".into(),
                    source: "https://e.com".into(),
                    by: "george".into(),
                }],
                open_questions: vec!["who pays".into()],
                positions: [("george".to_string(), "yes".to_string())]
                    .into_iter()
                    .collect(),
            },
        });
        view.apply(DebateEvent::Convergence {
            convergence: Convergence {
                moved: vec!["cathy".into()],
                open_disagreements: 1,
                recommend: Recommend::AnotherRound,
                why: "timing is open".into(),
            },
        });
        view.apply(DebateEvent::Moderator {
            kind: ModeratorNoteKind::Note,
            text: "Keep to the question.".into(),
        });
        view.apply(DebateEvent::Record {
            record: Box::new(DecisionRecord {
                deliverable: Deliverable::Decision,
                question: "Should we colonize Mars?".into(),
                answer: "Later, after a cheaper launch cadence.".into(),
                confidence: 0.72,
                options_considered: vec![OptionConsidered {
                    option: "Yes now".into(),
                    why_not: "too costly".into(),
                }],
                dissent: vec![Dissent {
                    seat: "george".into(),
                    position: "go now".into(),
                    why_not_carried: "cost".into(),
                }],
                assumptions: vec!["launch costs fall".into()],
                evidence: vec![Evidence {
                    claim: "costs 1T".into(),
                    source: "https://e.com".into(),
                    by: "george".into(),
                }],
                open_questions: vec!["who pays".into()],
                next_actions: vec!["price a cadence".into()],
                what_changed: "Cathy moved.".into(),
                how_it_went: "George pushed cost, Cathy conceded the cadence point.".into(),
                votes: [("cathy".to_string(), "Later".to_string())]
                    .into_iter()
                    .collect(),
                cost: None,
            }),
        });
        view.apply(DebateEvent::Cost {
            snapshot: CostSnapshot {
                total_usd: 0.4321,
                all_priced: false,
                session_cap: 5.0,
                note: Some("80% of the session budget used.".into()),
                ..Default::default()
            },
        });
        view.apply(DebateEvent::Error {
            message: "Kate came back empty.".into(),
        });
        SessionScreen {
            topic: "Should we colonize Mars?".into(),
            session_id: "sc-test".into(),
            seats: vec![
                card("george", "George", Provider::OpenAI),
                card("cathy", "Cathy", Provider::Anthropic),
            ],
            view,
            side: SideTab::Plan,
            show_thinking: true,
            follow: true,
            scroll: 0,
            answer: String::new(),
            read_only: false,
            engine: None,
            confirm_stop_until: 0,
            ui: SessionUi::default(),
        }
    }

    fn render_at(app: &mut App, w: u16, h: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| render(f, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    fn press(app: &mut App, code: KeyCode) {
        app.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    #[test]
    fn renders_every_view_and_side_tab_without_panic() {
        let mut app = test_app();
        for view in [View::Home, View::Settings] {
            app.view = view;
            render_at(&mut app, 120, 40);
        }
        app.view = View::Session;
        app.session = Some(sample_screen());
        // A session with a record opens on the summary: the record, the
        // errors and the analysis panel, but not the turns themselves.
        let text = render_at(&mut app, 140, 50);
        assert!(text.contains("DECISION RECORD"), "{text}");
        assert!(text.contains("Later, after a cheaper launch cadence."));
        assert!(text.contains("Kate came back empty."));
        assert!(text.contains("ANALYSIS"));
        assert!(
            !text.contains("web_search"),
            "tool calls live on the transcript"
        );
        app.session.as_mut().unwrap().ui.page = Some(SessionPage::Transcript);
        let text = render_at(&mut app, 140, 50);
        assert!(text.contains("web_search"));
        // Every analysis view renders, at full width and cramped.
        for view in analysis::AnalysisView::ALL {
            let s = app.session.as_mut().unwrap();
            s.ui.page = Some(SessionPage::Summary);
            s.ui.analysis = view;
            render_at(&mut app, 140, 50);
            render_at(&mut app, 60, 20);
        }
        app.session.as_mut().unwrap().ui.page = Some(SessionPage::Transcript);
        for tab in SideTab::ALL {
            app.session.as_mut().unwrap().side = tab;
            let text = render_at(&mut app, 140, 50);
            assert!(text.contains(tab.label()), "{tab:?} tab renders its label");
            render_at(&mut app, 60, 20);
            render_at(&mut app, 9, 4);
        }
        // The thinking toggle hides and shows the trace.
        app.session.as_mut().unwrap().show_thinking = false;
        assert!(!render_at(&mut app, 140, 50).contains("weighing the objection"));
        app.session.as_mut().unwrap().show_thinking = true;
        assert!(render_at(&mut app, 140, 50).contains("weighing the objection"));
    }

    #[test]
    fn overlays_render_and_take_the_keyboard() {
        let mut app = test_app();
        app.view = View::Session;
        let mut screen = sample_screen();
        let (tx, mut input_rx) = unbounded_channel::<EngineInput>();
        let (_ev_tx, ev_rx) = unbounded_channel::<DebateEvent>();
        let rt = tokio::runtime::Runtime::new().unwrap();
        screen.engine = Some(EngineHandle {
            rx: ev_rx,
            input: tx,
            handle: rt.spawn(async {}),
        });
        screen.view.apply(DebateEvent::UserQuestion {
            id: "q1".into(),
            question: "Which budget?".into(),
        });
        screen.view.apply(DebateEvent::ToolApproval {
            id: "a1".into(),
            seat_id: "george".into(),
            call: ToolCall {
                id: "c2".into(),
                name: "run_command".into(),
                arguments: json!({"command": "ls"}),
                signature: None,
            },
        });
        app.session = Some(screen);
        let text = render_at(&mut app, 120, 40);
        assert!(text.contains("Which budget?"));
        assert!(!text.contains("run_command"), "the question comes first");

        // Typing goes to the answer; `t` must not toggle thinking meanwhile.
        for c in "10k".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        press(&mut app, KeyCode::Char('t'));
        assert_eq!(app.session.as_ref().unwrap().answer, "10kt");
        assert!(app.session.as_ref().unwrap().show_thinking);
        press(&mut app, KeyCode::Backspace);
        press(&mut app, KeyCode::Enter);
        assert_eq!(
            input_rx.try_recv().unwrap(),
            EngineInput::UserAnswer {
                id: "q1".into(),
                text: "10k".into()
            }
        );
        assert!(app
            .session
            .as_ref()
            .unwrap()
            .view
            .pending_question
            .is_none());

        // Now the approval shows; `n` denies it.
        let text = render_at(&mut app, 120, 40);
        assert!(text.contains("run_command"));
        press(&mut app, KeyCode::Char('n'));
        assert_eq!(
            input_rx.try_recv().unwrap(),
            EngineInput::ToolDecision {
                id: "a1".into(),
                allow: false
            }
        );
        assert!(app
            .session
            .as_ref()
            .unwrap()
            .view
            .pending_approval
            .is_none());

        // Esc while live asks for a second press; the second one stops.
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.view, View::Session);
        assert!(app.toast.as_deref().unwrap().contains("again"));
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.view, View::Home);
        assert!(app.session.is_none());
        assert_eq!(input_rx.try_recv().unwrap(), EngineInput::Cancel);
    }

    #[test]
    fn session_keys_switch_tabs_and_scroll() {
        let mut app = test_app();
        app.view = View::Session;
        app.session = Some(sample_screen());
        let tab = |app: &App| app.session.as_ref().unwrap().side;
        press(&mut app, KeyCode::Char('b'));
        assert_eq!(tab(&app), SideTab::Board);
        press(&mut app, KeyCode::Right);
        assert_eq!(tab(&app), SideTab::Convergence);
        press(&mut app, KeyCode::Left);
        press(&mut app, KeyCode::Left);
        assert_eq!(tab(&app), SideTab::Plan);
        press(&mut app, KeyCode::Left);
        assert_eq!(tab(&app), SideTab::Seats);
        press(&mut app, KeyCode::Char('$'));
        assert_eq!(tab(&app), SideTab::Cost);
        press(&mut app, KeyCode::Up);
        assert!(!app.session.as_ref().unwrap().follow);
        press(&mut app, KeyCode::Char('g'));
        assert!(app.session.as_ref().unwrap().follow);
        let page = |app: &mut App| app.session.as_mut().unwrap().page();
        let before = page(&mut app);
        press(&mut app, KeyCode::Char('t'));
        assert_ne!(
            page(&mut app),
            before,
            "t switches between summary and transcript"
        );
        press(&mut app, KeyCode::Char('T'));
        assert!(!app.session.as_ref().unwrap().show_thinking);
        // A digit picks an analysis view and lands on the summary to show it.
        press(&mut app, KeyCode::Char('3'));
        assert_eq!(
            app.session.as_ref().unwrap().ui.analysis,
            analysis::AnalysisView::Critique
        );
        assert_eq!(page(&mut app), SessionPage::Summary);
        // `?` opens the key list and Esc closes it without leaving the session.
        press(&mut app, KeyCode::Char('?'));
        assert!(app.session.as_ref().unwrap().ui.help);
        press(&mut app, KeyCode::Esc);
        assert!(!app.session.as_ref().unwrap().ui.help);
        assert_eq!(app.view, View::Session);
        // A finished session leaves on one Esc.
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.view, View::Home);
    }

    #[test]
    fn home_keys_cycle_preset_and_deliverable() {
        let mut app = test_app();
        assert_eq!(app.launch.preset, Preset::Standard);
        press(&mut app, KeyCode::Right);
        assert_eq!(app.launch.preset, Preset::Full);
        press(&mut app, KeyCode::Right);
        assert_eq!(app.launch.preset, Preset::Quick);
        press(&mut app, KeyCode::Left);
        assert_eq!(app.launch.preset, Preset::Full);
        app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert_eq!(app.launch.deliverable, Some(Deliverable::Decision));
        for _ in 0..4 {
            app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        }
        assert_eq!(app.launch.deliverable, None);
        // A plain `d` is typed into the composer.
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(app.composer, "d");
        // The chips and the roster strip render the choice.
        app.launch.preset = Preset::Quick;
        app.launch.deliverable = Some(Deliverable::Review);
        let text = render_at(&mut app, 120, 40);
        assert!(text.contains("Quick · 3"));
        assert!(text.contains("review"));
        assert!(text.contains("0 seats convene"));
        assert!(text.contains("COUNCIL RACK"));
        assert!(text.contains("Moderator") && text.contains("Utility"));
        assert!(text.contains("0/8 keyed"));
        // Folded under the options on a narrow terminal, chairs still first.
        let narrow = render_at(&mut app, 80, 24);
        assert!(narrow.contains("Moderator"));
    }

    #[test]
    fn stored_sessions_open_from_the_sidebar() {
        let mut app = test_app();
        app.sessions = vec![
            SessionRow {
                id: "a".into(),
                title: "A deliberation".into(),
                status: "completed".into(),
                turns: 6,
                archived: false,
                origin: "cli".into(),
                version: 2,
                deliverable: Some("decision".into()),
                answer: "Later.".into(),
                total_usd: 0.42,
                stopped_early: None,
            },
            SessionRow {
                id: "b".into(),
                title: "An old chat".into(),
                status: "paused".into(),
                turns: 3,
                archived: true,
                origin: "app".into(),
                version: 1,
                deliverable: None,
                answer: String::new(),
                total_usd: 0.0,
                stopped_early: Some("budget".into()),
            },
        ];
        app.sidebar_open = true;
        app.toast = Some("hello".into());
        let text = render_at(&mut app, 110, 30);
        assert!(text.contains("A deliberation"));
        assert!(text.contains("Later."));
        // No store in the test app: opening toasts instead of panicking.
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.view, View::Home);
        assert!(app.toast.as_deref().unwrap().contains("Couldn't read"));
    }

    #[test]
    fn a_stored_v2_session_renders_read_only_and_reconvenes_with_notes() {
        let mut app = test_app();
        let mut doc = json!({
            "id": "sc-x", "topic": "Stored topic", "version": 2,
            "roster": {"seats": [{"id": "cathy", "name": "Cathy", "provider": "anthropic", "model": "auto"}]},
            "rounds": [{"kind": "positions", "entries": [{"seat": "cathy", "name": "Cathy", "model": "claude-x",
                       "content": "stored point", "structured": {}, "tool_uses": [],
                       "usage": {"input": 1, "output": 1, "reasoning": 0, "cached_input": 0, "cache_write": 0}}]}],
            "record": null, "board": {}, "costs": {}, "messages": []
        });
        let view = SessionView::from_stored(&doc);
        assert_eq!(view.rounds[0].entries[0].text, "stored point");
        doc["record"] = json!({"deliverable": "analysis", "question": "Q", "answer": "A", "confidence": 0.5,
            "options_considered": [], "dissent": [], "assumptions": [], "evidence": [], "open_questions": [],
            "next_actions": [], "what_changed": "", "votes": {}, "cost": null});
        let view = SessionView::from_stored(&doc);
        app.session = Some(SessionScreen {
            topic: "Stored topic".into(),
            session_id: "sc-x".into(),
            seats: vec![card("cathy", "Cathy", Provider::Anthropic)],
            view,
            side: SideTab::Plan,
            show_thinking: false,
            follow: false,
            scroll: 0,
            answer: String::new(),
            read_only: true,
            engine: None,
            confirm_stop_until: 0,
            ui: SessionUi::default(),
        });
        app.view = View::Session;
        let text = render_at(&mut app, 120, 40);
        assert!(text.contains("completed"));
        assert!(
            text.contains("Esc home"),
            "a stored session offers home, not stop"
        );
        press(&mut app, KeyCode::Char('t'));
        let text = render_at(&mut app, 120, 40);
        assert!(text.contains("stored point"));
        let s = app.session.as_ref().unwrap();
        assert_eq!(s.status().0, "completed");
        let notes = s
            .view
            .record_markdown(&s.names())
            .or_else(|| s.view.transcript_tail(6))
            .unwrap();
        assert!(notes.starts_with("# Q"));
        // Reconvening without keys keeps the topic in the composer.
        press(&mut app, KeyCode::Char('r'));
        assert_eq!(app.composer, "Stored topic");
        assert!(app.toast.as_deref().unwrap().contains("No API keys"));
    }

    #[test]
    fn engine_disconnect_marks_the_session_failed() {
        let mut app = test_app();
        let mut screen = sample_screen();
        let (tx, _input_rx) = unbounded_channel::<EngineInput>();
        let (ev_tx, ev_rx) = unbounded_channel::<DebateEvent>();
        let rt = tokio::runtime::Runtime::new().unwrap();
        screen.engine = Some(EngineHandle {
            rx: ev_rx,
            input: tx,
            handle: rt.spawn(async {}),
        });
        app.session = Some(screen);
        app.view = View::Session;
        ev_tx
            .send(DebateEvent::Moderator {
                kind: ModeratorNoteKind::Note,
                text: "last word".into(),
            })
            .unwrap();
        drop(ev_tx);
        assert!(app.pump_engine());
        let s = app.session.as_ref().unwrap();
        assert!(s.view.done);
        assert_eq!(s.view.stopped_early.as_deref(), Some("failed"));
        assert!(s.view.moderator_notes.contains(&"last word".to_string()));
        assert!(!s.is_live());
        assert_eq!(s.status().0, "failed");
    }

    #[test]
    fn renders_at_tiny_sizes_without_panic() {
        let mut app = test_app();
        app.sidebar_open = true;
        app.session = Some(sample_screen());
        app.key_draft = Some(KeyDraft {
            provider: theme::AGENTS[0].provider,
            buffer: "sk-xxxxxxxx".into(),
        });
        for view in [View::Home, View::Session, View::Settings] {
            app.view = view;
            for (w, h) in [(1, 1), (4, 3), (10, 6), (20, 8), (59, 12)] {
                render_at(&mut app, w, h);
            }
        }
    }

    #[test]
    fn settings_edit_mode_masks_the_key() {
        let mut app = test_app();
        app.view = View::Settings;
        app.settings_sel = 0;
        let provider = theme::AGENTS[0].provider;
        app.key_draft = Some(KeyDraft {
            provider,
            buffer: "sk-secret-value-123".into(),
        });
        let rendered = render_at(&mut app, 120, 40);
        assert!(
            !rendered.contains("sk-secret-value-123"),
            "plaintext key must never render"
        );
        assert!(
            rendered.contains('•'),
            "the key buffer should render as masked bullets"
        );
        assert_eq!(
            redact_proxy("socks5://user:hunter2@proxy.example:1080"),
            "socks5://•••@proxy.example:1080"
        );
    }

    #[test]
    fn settings_keys_edit_toggle_add_and_reset_without_touching_disk() {
        use settings::{DraftKind, SettingsDraft, SettingsRow};
        let mut app = test_app();
        app.view = View::Settings;
        let rows = settings::settings_rows(&app.ctx.config);
        let goto = |app: &mut App, row: SettingsRow| {
            app.settings_sel = rows.iter().position(|r| *r == row).unwrap();
        };
        // Tools cycle safe → all → none → safe; approval toggles.
        goto(&mut app, SettingsRow::ToolsLevel);
        press(&mut app, KeyCode::Enter);
        assert!(app.ctx.config.tools.shell.enabled);
        press(&mut app, KeyCode::Enter);
        assert!(!app.ctx.config.tools.any_enabled());
        press(&mut app, KeyCode::Char('d'));
        assert!(app.ctx.config.tools.any_enabled() && !app.ctx.config.tools.shell.enabled);
        goto(&mut app, SettingsRow::ToolsApproval);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.tools.approval, crate::tools::Approval::Ask);
        // Rounds: an invalid value toasts and keeps the old one.
        goto(&mut app, SettingsRow::Rounds);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.settings_draft.as_ref().unwrap().buffer, "3");
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        press(&mut app, KeyCode::Char('9'));
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.protocol.max_rounds, 3);
        assert!(app.toast.as_deref().unwrap().contains("1 to 6"));
        press(&mut app, KeyCode::Enter);
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        press(&mut app, KeyCode::Char('2'));
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.protocol.max_rounds, 2);
        // A seat: edit its spec (a bad id is refused), rename, cycle
        // reasoning, add one, remove one, reset the roster.
        goto(&mut app, SettingsRow::Seat(1));
        press(&mut app, KeyCode::Enter);
        assert_eq!(
            app.settings_draft.as_ref().unwrap().buffer,
            "anthropic:auto"
        );
        app.settings_draft = Some(SettingsDraft {
            row: SettingsRow::Seat(1),
            kind: DraftKind::Spec,
            buffer: "anthropic:claude-99-hypothetical".into(),
        });
        press(&mut app, KeyCode::Enter);
        assert!(app.toast.as_deref().unwrap().contains("has no model"));
        assert!(app.ctx.config.seats.is_empty(), "nothing was written");
        app.settings_draft = Some(SettingsDraft {
            row: SettingsRow::Seat(1),
            kind: DraftKind::Spec,
            buffer: "google:auto-fast".into(),
        });
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.seats[1].provider, "google");
        assert_eq!(app.ctx.config.seats[1].model, "auto-fast");
        assert_eq!(app.ctx.config.seats[1].name, "Cathy");
        press(&mut app, KeyCode::Char('n'));
        app.handle_paste("Critic".into());
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.seats[1].name, "CathyCritic");
        press(&mut app, KeyCode::Char('r'));
        assert_eq!(
            app.ctx.config.seats[1].reasoning,
            Some(crate::types::ReasoningTier::Low)
        );
        press(&mut app, KeyCode::Char('a'));
        assert_eq!(app.ctx.config.seats.len(), 9);
        // Seat 1 moved to Google, so Anthropic is the first provider
        // without a seat.
        let added = app.ctx.config.seats.last().unwrap().clone();
        assert_eq!(added.provider, "anthropic");
        assert_eq!(
            (added.id.as_str(), added.name.as_str()),
            ("anthropic", "Cathy")
        );
        assert_eq!(app.settings_row(), SettingsRow::Seat(8));
        press(&mut app, KeyCode::Char('d'));
        assert_eq!(app.ctx.config.seats.len(), 8);
        press(&mut app, KeyCode::Char('R'));
        assert!(app.ctx.config.seats.is_empty());
        // Slots and budget.
        goto(&mut app, SettingsRow::Moderator);
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.settings_draft.as_ref().unwrap().buffer, "google:auto");
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        app.handle_paste("anthropic:auto".into());
        press(&mut app, KeyCode::Enter);
        assert_eq!(
            app.ctx.config.moderator.as_ref().unwrap().provider,
            "anthropic"
        );
        press(&mut app, KeyCode::Char('d'));
        assert!(app.ctx.config.moderator.is_none());
        goto(&mut app, SettingsRow::BudgetDay);
        press(&mut app, KeyCode::Enter);
        app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        app.handle_paste("12.5".into());
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.budget_per_day_usd, 12.5);
        goto(&mut app, SettingsRow::Proxy);
        press(&mut app, KeyCode::Enter);
        app.handle_paste("socks5://u:p@h:1080".into());
        let text = render_at(&mut app, 120, 50);
        assert!(!text.contains("u:p@h"), "the proxy draft renders masked");
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.ctx.config.proxy.as_deref(), Some("socks5://u:p@h:1080"));
        let text = render_at(&mut app, 120, 50);
        assert!(text.contains("socks5://•••@h:1080"));
        assert!(!text.contains("u:p@h"));
        // Every row renders at a short height with the cursor kept in view.
        for i in 0..rows.len() {
            app.settings_sel = i;
            render_at(&mut app, 100, 12);
        }
        press(&mut app, KeyCode::Esc);
        assert_eq!(app.view, View::Home);
    }

    #[test]
    fn paste_routes_to_the_focused_input_and_strips_control_chars() {
        let mut app = test_app();
        app.view = View::Settings;
        app.key_draft = Some(KeyDraft {
            provider: theme::AGENTS[0].provider,
            buffer: String::new(),
        });
        app.handle_paste("sk-abc\n".into());
        assert_eq!(app.key_draft.as_ref().unwrap().buffer, "sk-abc");

        let mut app = test_app();
        app.view = View::Home;
        app.handle_paste("hello\nworld".into());
        assert_eq!(app.composer, "helloworld");

        // Into a pending answer on the Session screen, and nowhere otherwise.
        let mut app = test_app();
        app.view = View::Session;
        let mut screen = sample_screen();
        screen.view.apply(DebateEvent::UserQuestion {
            id: "q".into(),
            question: "?".into(),
        });
        app.session = Some(screen);
        app.handle_paste("an answer\n".into());
        assert_eq!(app.session.as_ref().unwrap().answer, "an answer");
        app.session.as_mut().unwrap().view.pending_question = None;
        app.handle_paste("more".into());
        assert_eq!(app.session.as_ref().unwrap().answer, "an answer");
    }
}
