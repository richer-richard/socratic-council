//! The Socratic Council TUI — a terminal port of the desktop workstation.
//!
//! Three surfaces mirror the app: a **Home** landing with the animated council
//! mark + a topic composer, a collapsible **history** sidebar (the desktop
//! app's saved sessions), and the **Chat** debate chamber. A Settings/Models
//! overlay rounds it out. Everything shares the app's keys + config via the
//! desktop bridge, so the council convenes with one keypress.

mod chat;
mod home;
mod settings;
mod sidebar;
mod theme;

use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::{Config, KeySource};
use crate::engine::{default_agents, DebateEvent, Engine};
use crate::types::{Agent, ModeratorConclusion, Provider, Usage, VoteChoice};
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::{Frame, Terminal};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::task::JoinHandle;

/// Everything a debate needs to be spawned on demand from the Home view.
pub struct AppContext {
    pub http: reqwest::Client,
    pub config: Config,
    pub available: HashMap<Provider, Vec<DiscoveredModel>>,
    /// Providers a debate may use — configured ∩ `--providers` filter. The
    /// Home view's roster and any spawned debate are restricted to this set.
    pub providers: Vec<Provider>,
    /// Keys already resolved during a `--scan` pre-pass, so launching a debate
    /// in the same run reuses them.
    pub prefetched_keys: HashMap<Provider, String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Home,
    Chat,
    Settings,
}

/// One agent in a debate roster, with its resolved model + accent color.
pub struct RosterEntry {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub model: String,
    pub color: Color,
}

/// A rendered transcript turn (or a moderator/system note). Carries its own
/// reasoning trace so thinking can be shown collapsibly per message.
pub struct TurnView {
    pub agent_id: String,
    pub name: String,
    pub model: String,
    pub content: String,
    pub thinking: String,
    pub thinking_ms: u64,
}

impl TurnView {
    fn note(agent_id: &str, name: &str, content: String) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            name: name.to_string(),
            model: String::new(),
            content,
            thinking: String::new(),
            thinking_ms: 0,
        }
    }
}

/// A single end-vote round, accumulated from the vote events.
pub struct VoteBoard {
    pub proposer: String,
    pub threshold: u32,
    pub total: u32,
    pub votes: Vec<(String, VoteChoice, String)>,
    pub result: Option<VoteResult>,
}

/// The tally of a finished end-vote.
pub struct VoteResult {
    pub passed: bool,
    pub yes: u32,
    pub no: u32,
    pub abstain: u32,
}

/// One row in the history sidebar — a saved desktop session.
#[derive(Clone)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub turns: u32,
    pub archived: bool,
}

struct EngineHandle {
    rx: UnboundedReceiver<DebateEvent>,
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

/// In-progress API-key entry in the Settings panel. The buffer holds the secret
/// while it's typed/pasted; it is rendered masked and dropped once saved or
/// cancelled (never logged, never shown in plaintext).
pub struct KeyDraft {
    pub provider: Provider,
    pub buffer: String,
}

/// A live or historical debate being viewed in the Chat chamber.
pub struct Debate {
    pub topic: String,
    pub roster: Vec<RosterEntry>,
    pub turns: Vec<TurnView>,
    pub streaming: Option<TurnView>,
    pub active: Option<String>,
    pub usage: Usage,
    pub turn_count: u32,
    pub status: String,
    /// End-vote rounds, in the order they occurred.
    pub vote_boards: Vec<VoteBoard>,
    /// The moderator's final scored verdict, once published.
    pub conclusion: Option<ModeratorConclusion>,
    pub show_thinking: bool,
    pub follow: bool,
    pub scroll: u16,
    pub done: bool,
    pub read_only: bool,
    engine: Option<EngineHandle>,
}

impl Debate {
    fn apply(&mut self, ev: DebateEvent) {
        match ev {
            DebateEvent::Phase(p) => self.status = p,
            DebateEvent::Moderator(text) => {
                self.turns.push(TurnView::note("system", "Moderator", text))
            }
            DebateEvent::Conclusion(c) => {
                self.conclusion = Some(c);
                self.active = None;
            }
            DebateEvent::TurnStarted { agent_id, name, model, .. } => {
                self.turn_count += 1;
                self.active = Some(name.clone());
                self.streaming = Some(TurnView {
                    agent_id,
                    name,
                    model,
                    content: String::new(),
                    thinking: String::new(),
                    thinking_ms: 0,
                });
            }
            DebateEvent::Token(t) => {
                if let Some(s) = self.streaming.as_mut() {
                    s.content.push_str(&t);
                }
            }
            DebateEvent::Thinking(t) => {
                if let Some(s) = self.streaming.as_mut() {
                    s.thinking.push_str(&t);
                }
            }
            DebateEvent::TurnEnded { usage, thinking_ms } => {
                self.usage.input += usage.input;
                self.usage.output += usage.output;
                self.usage.reasoning += usage.reasoning;
                if let Some(mut s) = self.streaming.take() {
                    s.thinking_ms = thinking_ms;
                    // Keep a turn that produced reasoning even if its visible text
                    // was all directives — but drop fully-empty turns.
                    if !s.content.trim().is_empty() || !s.thinking.trim().is_empty() {
                        self.turns.push(s);
                    }
                }
                self.active = None;
            }
            DebateEvent::EndVoteStarted { proposer, threshold, total } => {
                self.vote_boards.push(VoteBoard {
                    proposer,
                    threshold,
                    total,
                    votes: Vec::new(),
                    result: None,
                });
            }
            DebateEvent::Vote { name, choice, reason, .. } => {
                if let Some(b) = self.vote_boards.last_mut() {
                    b.votes.push((name, choice, reason));
                }
            }
            DebateEvent::EndVoteResult { passed, yes, no, abstain } => {
                if let Some(b) = self.vote_boards.last_mut() {
                    b.result = Some(VoteResult { passed, yes, no, abstain });
                }
            }
            DebateEvent::Error(e) => self.turns.push(TurnView::note("error", "⚠ Error", e)),
            DebateEvent::Done => {
                self.done = true;
                self.status = "Adjourned".into();
                self.active = None;
            }
        }
    }

    fn is_live(&self) -> bool {
        self.engine.is_some() && !self.done
    }
}

pub struct App {
    ctx: AppContext,
    view: View,
    frame: u64,
    sidebar_open: bool,
    composer: String,
    sessions: Vec<SessionRow>,
    sessions_loaded: bool,
    sidebar_sel: usize,
    debate: Option<Debate>,
    toast: Option<String>,
    toast_expire: u64,
    key_cache: HashMap<Provider, String>,
    /// Cursor over the eight providers in the Settings panel.
    settings_sel: usize,
    /// Active API-key entry, if the user is editing a key in Settings.
    key_draft: Option<KeyDraft>,
}

impl App {
    fn new(ctx: AppContext) -> Self {
        let sessions = ctx
            .config
            .bridge()
            .sessions()
            .iter()
            .map(|s| SessionRow {
                id: s.id.clone(),
                title: s.title.clone(),
                status: s.status.clone(),
                turns: s.current_turn,
                archived: s.archived,
            })
            .collect::<Vec<_>>();
        Self {
            view: View::Home,
            frame: 0,
            sidebar_open: false,
            composer: String::new(),
            sessions_loaded: !sessions.is_empty(),
            sessions,
            sidebar_sel: 0,
            debate: None,
            toast: None,
            toast_expire: 0,
            key_cache: ctx.prefetched_keys.clone(),
            settings_sel: 0,
            key_draft: None,
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

    /// Lazily load the desktop app's saved sessions the first time the history
    /// sidebar opens. Sessions are decrypted from the app's file vault at bridge
    /// load, so this is usually already populated — the re-read just covers an
    /// index that wasn't decrypted on the first pass.
    fn ensure_sessions(&mut self) {
        if self.sessions_loaded {
            return;
        }
        self.sessions_loaded = true;
        if !self.ctx.config.bridge().has_sessions_to_unlock() {
            return;
        }
        let loaded = self.ctx.config.bridge().read_sessions();
        if loaded.is_empty() {
            self.toast("No readable history (the app's vault couldn't be opened).");
            return;
        }
        self.sessions = loaded
            .into_iter()
            .map(|s| SessionRow {
                id: s.id,
                title: s.title,
                status: s.status,
                turns: s.current_turn,
                archived: s.archived,
            })
            .collect();
    }

    fn toggle_sidebar(&mut self) {
        self.sidebar_open = !self.sidebar_open;
        if self.sidebar_open {
            self.ensure_sessions();
            self.sidebar_sel = self.sidebar_sel.min(self.sessions.len().saturating_sub(1));
        }
    }

    /// Resolve keys (caching them for the session) and spawn the debate engine
    /// on a background task.
    fn start_debate(&mut self, topic: String) {
        let topic = topic.trim().to_string();
        if topic.is_empty() {
            return;
        }
        // Never orphan a previously-running engine — it would keep streaming
        // completions (and spending quota) in the background.
        self.abort_engine();
        let config = self.ctx.config.clone();
        let allowed = self.ctx.providers.clone();
        let mut agents: Vec<Agent> = default_agents(config.council_tier)
            .into_iter()
            .filter(|a| config.is_configured(a.provider) && allowed.contains(&a.provider))
            .collect();
        agents.sort_by(|a, b| a.name.cmp(&b.name));
        if agents.is_empty() {
            // Keep the topic (e.g. `run "topic"` on a keyless first run) so the
            // user can add a key and convene without retyping it.
            self.composer = topic;
            // Distinguish "no keys at all" from "keys exist but --providers
            // excludes them" so the hint is actionable.
            let keyed_but_filtered =
                Provider::ALL.into_iter().any(|p| config.is_configured(p) && !allowed.contains(&p));
            if keyed_but_filtered {
                self.toast("Your keyed providers are excluded by --providers this run.");
            } else {
                self.toast("No API keys yet — press ^P to add one in Settings.");
            }
            return;
        }

        // Resolve each provider's key once, then cache it for the session.
        let mut keys = HashMap::new();
        for agent in &agents {
            if let Some(k) = self.key_cache.get(&agent.provider) {
                keys.insert(agent.provider, k.clone());
            } else if let Some(k) = config.resolve_api_key(agent.provider) {
                self.key_cache.insert(agent.provider, k.clone());
                keys.insert(agent.provider, k);
            }
        }
        agents.retain(|a| keys.contains_key(&a.provider));
        if agents.is_empty() {
            self.toast("Couldn't read a stored key — add one here with ^P.");
            return;
        }

        let available = self.ctx.available.clone();
        let roster = agents
            .iter()
            .map(|a| {
                let empty = Vec::new();
                let avail = available.get(&a.provider).unwrap_or(&empty);
                let model = resolve_model(
                    a.provider,
                    a.tier,
                    avail,
                    config.selection(a.provider, a.tier).as_deref(),
                );
                RosterEntry {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    provider: a.provider,
                    model,
                    color: theme::provider_color(a.provider),
                }
            })
            .collect();

        let max_turns = match config.max_turns {
            0 => 1000,
            n => n,
        };
        let http = self.ctx.http.clone();
        let engine = Engine::new(http, config, topic.clone(), agents, available, keys, max_turns);
        let (tx, rx) = unbounded_channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let engine_cancel = cancel.clone();
        let handle = tokio::spawn(async move { engine.run(tx, engine_cancel).await });

        self.debate = Some(Debate {
            topic,
            roster,
            turns: Vec::new(),
            streaming: None,
            active: None,
            usage: Usage::default(),
            turn_count: 0,
            status: "Convening…".into(),
            vote_boards: Vec::new(),
            conclusion: None,
            show_thinking: false,
            follow: true,
            scroll: 0,
            done: false,
            read_only: false,
            engine: Some(EngineHandle { rx, cancel, handle }),
        });
        self.composer.clear();
        self.view = View::Chat;
    }

    /// Cancel + abort the current debate's engine task if one is live. Safe to
    /// call when there is no debate or it's a read-only saved session.
    fn abort_engine(&self) {
        if let Some(d) = &self.debate {
            if let Some(e) = &d.engine {
                e.cancel.store(true, Ordering::Relaxed);
                e.handle.abort();
            }
        }
    }

    /// Stop a running debate (if any) and return to Home.
    fn stop_debate(&mut self) {
        self.abort_engine();
        self.debate = None;
        self.view = View::Home;
    }

    /// Open the highlighted saved session read-only (decrypts its transcript).
    fn open_selected_session(&mut self) {
        let Some(row) = self.sessions.get(self.sidebar_sel).cloned() else {
            return;
        };
        let messages =
            self.ctx.config.bridge().load_session_transcript(&row.id).unwrap_or_default();
        if messages.is_empty() {
            self.toast("Couldn't read that session (locked, empty, or needs the app's key).");
            return;
        }
        // Stop any live debate before replacing it with the saved transcript.
        self.abort_engine();

        // Derive a roster from the distinct speakers in the transcript.
        let mut roster: Vec<RosterEntry> = Vec::new();
        for m in &messages {
            if matches!(m.agent_id.as_str(), "user" | "system" | "tool" | "error") {
                continue;
            }
            if roster.iter().any(|r| r.id == m.agent_id) {
                continue;
            }
            let provider = theme::AGENTS
                .iter()
                .find(|a| a.id == m.agent_id)
                .map(|a| a.provider)
                .unwrap_or(Provider::OpenAI);
            roster.push(RosterEntry {
                id: m.agent_id.clone(),
                name: m.name.clone(),
                provider,
                model: String::new(),
                color: theme::speaker_color(&m.agent_id),
            });
        }

        let turns = messages
            .into_iter()
            .map(|m| TurnView::note(&m.agent_id, &m.name, m.content))
            .collect();

        self.debate = Some(Debate {
            topic: row.title,
            roster,
            turns,
            streaming: None,
            active: None,
            usage: Usage::default(),
            turn_count: row.turns,
            status: "Saved session · read-only".into(),
            vote_boards: Vec::new(),
            conclusion: None,
            show_thinking: false,
            follow: false,
            scroll: 0,
            done: true,
            read_only: true,
            engine: None,
        });
        self.view = View::Chat;
    }

    /// Returns `true` to quit the app.
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Global: Ctrl-C quits from anywhere.
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        // Ctrl-P toggles Settings from anywhere.
        if key.code == KeyCode::Char('p') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.view = if self.view == View::Settings { View::Home } else { View::Settings };
            return false;
        }
        match self.view {
            View::Home => self.handle_home_key(key),
            View::Chat => self.handle_chat_key(key),
            View::Settings => self.handle_settings_key(key),
        }
    }

    fn handle_home_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc => return true,
            KeyCode::Tab => self.toggle_sidebar(),
            KeyCode::Enter => {
                // A non-empty composer launches; otherwise open the highlighted
                // saved session from the sidebar.
                if !self.composer.trim().is_empty() {
                    let topic = self.composer.clone();
                    self.start_debate(topic);
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
            KeyCode::Backspace => {
                self.composer.pop();
            }
            KeyCode::Char(c) => {
                self.composer.push(c);
            }
            _ => {}
        }
        false
    }

    fn handle_chat_key(&mut self, key: KeyEvent) -> bool {
        // Keys that touch `self` (not the debate) are handled first so we don't
        // hold a borrow of `self.debate` across them.
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.stop_debate();
                return false;
            }
            KeyCode::Tab => {
                self.toggle_sidebar();
                return false;
            }
            _ => {}
        }

        let Some(d) = self.debate.as_mut() else {
            self.view = View::Home;
            return false;
        };
        match key.code {
            KeyCode::Char('t') => d.show_thinking = !d.show_thinking,
            KeyCode::Up => {
                d.follow = false;
                d.scroll = d.scroll.saturating_sub(1);
            }
            KeyCode::Down => d.scroll = d.scroll.saturating_add(1),
            KeyCode::PageUp => {
                d.follow = false;
                d.scroll = d.scroll.saturating_sub(10);
            }
            KeyCode::PageDown => d.scroll = d.scroll.saturating_add(10),
            KeyCode::Char('g') => d.follow = true,
            _ => {}
        }
        false
    }

    fn handle_settings_key(&mut self, key: KeyEvent) -> bool {
        // Editing a provider's key: capture printable input (masked on screen),
        // Enter saves, Esc cancels, ^U clears the buffer. Each arm scopes its own
        // borrow of `key_draft` so save/toast can re-borrow `self`.
        if self.key_draft.is_some() {
            match key.code {
                KeyCode::Esc => self.key_draft = None,
                KeyCode::Enter => {
                    if let Some(draft) = self.key_draft.take() {
                        let value = draft.buffer.trim().to_string();
                        if value.is_empty() {
                            self.toast("No key entered — paste a key or press Esc.");
                        } else {
                            self.save_key(draft.provider, value);
                        }
                    }
                }
                KeyCode::Backspace => {
                    if let Some(d) = self.key_draft.as_mut() {
                        d.buffer.pop();
                    }
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(d) = self.key_draft.as_mut() {
                        d.buffer.clear();
                    }
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(d) = self.key_draft.as_mut() {
                        d.buffer.push(c);
                    }
                }
                _ => {}
            }
            return false;
        }

        // Normal Settings navigation.
        match key.code {
            KeyCode::Esc => self.view = View::Home,
            KeyCode::Up => self.settings_sel = self.settings_sel.saturating_sub(1),
            KeyCode::Down => {
                self.settings_sel = (self.settings_sel + 1).min(theme::AGENTS.len() - 1);
            }
            KeyCode::Enter | KeyCode::Char('e') => {
                let provider = theme::AGENTS[self.settings_sel].provider;
                self.key_draft = Some(KeyDraft { provider, buffer: String::new() });
            }
            KeyCode::Char('d') => {
                let provider = theme::AGENTS[self.settings_sel].provider;
                self.clear_key(provider);
            }
            _ => {}
        }
        false
    }

    /// Persist a key typed in Settings to the encrypted `keys.enc` store, then
    /// prime the cache so the next debate uses it immediately. The plaintext is
    /// moved into the config/cache and never logged.
    fn save_key(&mut self, provider: Provider, key: String) {
        self.ctx.config.set_key(provider, key.clone());
        // Only keys.enc changes — keys never live in config.toml, so there's no
        // need to write (and thereby create) config.toml here.
        if let Err(e) = self.ctx.config.save_keys() {
            self.toast(format!("Couldn't save key: {e}"));
            return;
        }
        self.key_cache.insert(provider, key);
        self.toast(format!("Saved {} key.", provider.display_name()));
    }

    /// Remove a locally-stored key. A key shared from the desktop app or sourced
    /// from an env var isn't this CLI's to delete — say so instead.
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

    /// Route pasted text to whatever input is focused. Control chars (incl. the
    /// trailing newline a bracketed paste carries) are stripped so a pasted key
    /// or topic stays a single clean line.
    fn handle_paste(&mut self, text: String) {
        let clean: String = text.chars().filter(|c| !c.is_control()).collect();
        if clean.is_empty() {
            return;
        }
        match self.view {
            View::Settings => {
                if let Some(d) = self.key_draft.as_mut() {
                    d.buffer.push_str(&clean);
                }
            }
            View::Home => self.composer.push_str(&clean),
            View::Chat => {}
        }
    }
}

/// Restores the terminal (raw mode, bracketed paste, alternate screen, cursor)
/// on `Drop` — so it runs on a normal exit *and* if `run_loop` panics and
/// unwinds. Without this, a panic would leave the shell unusable (no echo,
/// bracketed-paste markers around pasted text) until `reset`.
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
/// (from `run <topic>`) jumps straight into a debate.
pub async fn run(ctx: AppContext, initial_topic: Option<String>) -> anyhow::Result<()> {
    enable_raw_mode()?;
    // From here on, any early return *or panic* restores the terminal via Drop.
    let _guard = TerminalGuard;
    let mut stdout = io::stdout();
    // Bracketed paste lets a pasted API key arrive as one `Event::Paste` instead
    // of a burst of key events (and keeps a trailing newline from auto-submitting).
    execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(ctx);
    if let Some(topic) = initial_topic {
        if !topic.trim().is_empty() {
            app.start_debate(topic);
        }
    }

    let result = run_loop(&mut terminal, &mut app).await;

    // Tear the engine down before the guard leaves raw mode so quitting never blocks.
    if let Some(d) = &app.debate {
        if let Some(e) = &d.engine {
            e.cancel.store(true, Ordering::Relaxed);
            e.handle.abort();
        }
    }
    // Terminal teardown (incl. on panic) is handled by `_guard`'s Drop.
    result
}

async fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> anyhow::Result<()> {
    loop {
        // Drain any pending debate events.
        let mut pending = Vec::new();
        if let Some(d) = app.debate.as_mut() {
            if let Some(e) = d.engine.as_mut() {
                while let Ok(ev) = e.rx.try_recv() {
                    pending.push(ev);
                }
            }
        }
        if let Some(d) = app.debate.as_mut() {
            for ev in pending {
                d.apply(ev);
            }
        }

        if app.toast.is_some() && app.frame >= app.toast_expire {
            app.toast = None;
        }

        terminal.draw(|f| render(f, app))?;

        // Block up to one frame for animation cadence, then drain everything
        // queued this tick — so a char-by-char paste (terminals without
        // bracketed-paste support) still registers instantly.
        if event::poll(Duration::from_millis(70))? {
            loop {
                let mut quit = false;
                match event::read()? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        quit = app.handle_key(key);
                    }
                    Event::Paste(text) => app.handle_paste(text),
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
    let main_area = if app.sidebar_open {
        let cols = Layout::horizontal([Constraint::Length(30), Constraint::Min(0)]).split(area);
        sidebar::render(f, cols[0], app);
        cols[1]
    } else {
        area
    };

    match app.view {
        View::Home => home::render(f, main_area, app),
        View::Chat => chat::render(f, main_area, app),
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
        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
    )))
    .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(theme::GOLD)))
    .alignment(ratatui::layout::Alignment::Center);
    f.render_widget(para, rect);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn test_app() -> App {
        let ctx = AppContext {
            http: reqwest::Client::new(),
            config: Config::default(),
            available: HashMap::new(),
            providers: Provider::ALL.to_vec(),
            prefetched_keys: HashMap::new(),
        };
        App::new(ctx)
    }

    fn sample_debate() -> Debate {
        Debate {
            topic: "Should we colonize Mars?".into(),
            roster: vec![RosterEntry {
                id: "george".into(),
                name: "George".into(),
                provider: Provider::OpenAI,
                model: "gpt-x".into(),
                color: theme::provider_color(Provider::OpenAI),
            }],
            turns: vec![TurnView {
                agent_id: "george".into(),
                name: "George".into(),
                model: "gpt-x".into(),
                content: "First line.\nSecond line.".into(),
                thinking: "weighing the trade-offs".into(),
                thinking_ms: 1234,
            }],
            streaming: Some(TurnView {
                agent_id: "cathy".into(),
                name: "Cathy".into(),
                model: "claude-x".into(),
                content: "streaming…".into(),
                thinking: String::new(),
                thinking_ms: 0,
            }),
            active: Some("Cathy".into()),
            usage: Usage::default(),
            turn_count: 2,
            status: "Discussion".into(),
            vote_boards: Vec::new(),
            conclusion: Some(ModeratorConclusion {
                status: crate::types::ConclusionStatus::Majority,
                summary: "Leaning yes with reservations.".into(),
                score: 6,
                reason: "Decent reasoning, thin evidence.".into(),
                next: Some("Run a small test.".into()),
            }),
            show_thinking: true,
            follow: true,
            scroll: 0,
            done: false,
            read_only: false,
            engine: None,
        }
    }

    fn render_at(app: &mut App, w: u16, h: u16) {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| render(f, app)).unwrap();
    }

    #[test]
    fn renders_every_view_without_panic() {
        let mut app = test_app();
        for view in [View::Home, View::Settings] {
            app.view = view;
            render_at(&mut app, 120, 40);
        }
        app.view = View::Chat;
        app.debate = Some(sample_debate());
        render_at(&mut app, 120, 40);
    }

    #[test]
    fn renders_with_sidebar_open() {
        let mut app = test_app();
        app.sessions = vec![
            SessionRow { id: "a".into(), title: "A debate".into(), status: "completed".into(), turns: 12, archived: false },
            SessionRow { id: "b".into(), title: "Archived one".into(), status: "paused".into(), turns: 3, archived: true },
        ];
        app.sidebar_open = true;
        app.toast = Some("hello".into());
        render_at(&mut app, 100, 30);
    }

    #[test]
    fn renders_at_tiny_sizes_without_panic() {
        let mut app = test_app();
        app.sidebar_open = true;
        app.debate = Some(sample_debate());
        // Also exercise the Settings key-editor overlay at every size.
        app.key_draft =
            Some(KeyDraft { provider: theme::AGENTS[0].provider, buffer: "sk-xxxxxxxx".into() });
        for view in [View::Home, View::Chat, View::Settings] {
            app.view = view;
            for (w, h) in [(1, 1), (4, 3), (10, 6), (20, 8)] {
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
        app.key_draft = Some(KeyDraft { provider, buffer: "sk-secret-value-123".into() });

        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        terminal.draw(|f| render(f, &mut app)).unwrap();
        let rendered: String =
            terminal.backend().buffer().content().iter().map(|c| c.symbol()).collect();

        assert!(!rendered.contains("sk-secret-value-123"), "plaintext key must never render");
        assert!(rendered.contains('•'), "the key buffer should render as masked bullets");
    }

    #[test]
    fn paste_routes_to_the_focused_input_and_strips_control_chars() {
        // Into a Settings key draft.
        let mut app = test_app();
        app.view = View::Settings;
        app.key_draft =
            Some(KeyDraft { provider: theme::AGENTS[0].provider, buffer: String::new() });
        app.handle_paste("sk-abc\n".into());
        assert_eq!(app.key_draft.as_ref().unwrap().buffer, "sk-abc");

        // Into the Home composer.
        let mut app = test_app();
        app.view = View::Home;
        app.handle_paste("hello\nworld".into());
        assert_eq!(app.composer, "helloworld");
    }
}
