//! Settings — keys, the council roster, the moderator and utility slots,
//! the tool policy, the protocol, the budget and the proxy, on one
//! scrolling screen. Every change is validated, applied to the in-memory
//! config and saved to `config.toml` (keys go to `keys.enc`, 0600).
//!
//! Keys can be added right here in the terminal — no desktop app required.
//! The key buffer always renders masked; the plaintext never reaches the
//! screen or a log. A seat's explicit model id must exist in the provider's
//! catalog or live scan: the editor never lets a made-up id through.

use super::{redact_proxy, theme, App, Click, KeyDraft};
use crate::catalog::{catalog_models, model_row, resolve_model, DiscoveredModel};
use crate::config::{display_name_for, Config, KeySource, SeatConfig, SlotConfig};
use crate::tools::{Approval, ToolPolicy};
use crate::types::{ModelChoice, Provider, ReasoningTier};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use std::collections::HashMap;

/// One selectable row of the Settings screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SettingsRow {
    Key(Provider),
    Seat(usize),
    AddSeat,
    Moderator,
    Utility,
    ToolsLevel,
    ToolsApproval,
    Rounds,
    Interactive,
    Review,
    BudgetSession,
    BudgetDay,
    BudgetAction,
    Proxy,
}

/// What an edit buffer holds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DraftKind {
    /// `provider:model` for a seat or a slot.
    Spec,
    /// A seat's display name.
    Name,
    /// A number, or the proxy URL (masked).
    Text,
}

/// In-progress edit of a row (the proxy renders masked).
pub struct SettingsDraft {
    pub row: SettingsRow,
    pub kind: DraftKind,
    pub buffer: String,
}

impl SettingsDraft {
    fn masked(&self) -> bool {
        matches!(self.row, SettingsRow::Proxy)
    }
}

/// The rows in screen order for `config`.
pub fn settings_rows(config: &Config) -> Vec<SettingsRow> {
    let mut rows: Vec<SettingsRow> = theme::AGENTS
        .iter()
        .map(|a| SettingsRow::Key(a.provider))
        .collect();
    for i in 0..config.seats_or_default().len() {
        rows.push(SettingsRow::Seat(i));
    }
    rows.push(SettingsRow::AddSeat);
    rows.extend([
        SettingsRow::Moderator,
        SettingsRow::Utility,
        SettingsRow::ToolsLevel,
        SettingsRow::ToolsApproval,
        SettingsRow::Rounds,
        SettingsRow::Interactive,
        SettingsRow::Review,
        SettingsRow::BudgetSession,
        SettingsRow::BudgetDay,
        SettingsRow::BudgetAction,
        SettingsRow::Proxy,
    ]);
    rows
}

/// Parse `provider:model` and check the model: `auto`, `auto-balanced`,
/// `auto-fast`, or an id the provider's catalog or live scan lists.
pub fn parse_spec(
    spec: &str,
    available: &HashMap<Provider, Vec<DiscoveredModel>>,
) -> Result<(Provider, ModelChoice), String> {
    let spec = spec.trim();
    let (slug, model) = spec.split_once(':').unwrap_or((spec, "auto"));
    let provider = Provider::from_slug(slug.trim()).ok_or_else(|| {
        format!(
            "Unknown provider {:?}; use one of {}.",
            slug.trim(),
            Provider::ALL
                .iter()
                .map(|p| p.slug())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let choice = ModelChoice::parse(model);
    if let ModelChoice::Id(id) = &choice {
        let mut ids: Vec<String> = catalog_models(provider).into_iter().map(|m| m.id).collect();
        if let Some(live) = available.get(&provider) {
            ids.extend(live.iter().map(|m| m.id.clone()));
        }
        if !ids.iter().any(|known| known == id) {
            let needle = id.to_ascii_lowercase();
            let mut similar: Vec<&String> = ids
                .iter()
                .filter(|k| {
                    let k = k.to_ascii_lowercase();
                    k.contains(&needle)
                        || needle
                            .split(['-', '.'])
                            .any(|t| t.len() > 2 && k.contains(t))
                })
                .collect();
            similar.dedup();
            let hint = if similar.is_empty() {
                "run `models --scan` to refresh the list".to_string()
            } else {
                format!(
                    "did you mean {}?",
                    similar
                        .iter()
                        .take(3)
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            return Err(format!(
                "{} has no model {:?} in the catalog or the last scan — {hint}",
                provider.display_name(),
                id
            ));
        }
    }
    Ok((provider, choice))
}

/// `2.82`, `0.30`, `10` — a per-million price without float noise.
fn usd(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.2}")
    }
}

fn cycle_reasoning(current: Option<ReasoningTier>) -> Option<ReasoningTier> {
    match current {
        None => Some(ReasoningTier::Low),
        Some(ReasoningTier::Low) => Some(ReasoningTier::Medium),
        Some(ReasoningTier::Medium) => Some(ReasoningTier::High),
        Some(ReasoningTier::High) => None,
    }
}

fn tools_level(policy: &ToolPolicy) -> &'static str {
    if policy.shell.enabled {
        "all"
    } else if policy.any_enabled() {
        "safe"
    } else {
        "none"
    }
}

impl App {
    fn settings_rows(&self) -> Vec<SettingsRow> {
        settings_rows(&self.ctx.config)
    }

    pub(super) fn settings_row(&self) -> SettingsRow {
        let rows = self.settings_rows();
        rows[self.settings_sel.min(rows.len() - 1)]
    }

    /// A click on a Settings row. A switch (tools, approval, the question,
    /// review, the cap, add seat) flips at once, the way a toggle should. A
    /// row that opens an editor is picked by the first click and opened by
    /// a second. An edit in progress is dropped, as Esc would.
    pub(super) fn click_settings_row(&mut self, pos: usize) {
        self.key_draft = None;
        self.settings_draft = None;
        let rows = self.settings_rows();
        let Some(&row) = rows.get(pos) else {
            return;
        };
        let switch = matches!(
            row,
            SettingsRow::ToolsLevel
                | SettingsRow::ToolsApproval
                | SettingsRow::Interactive
                | SettingsRow::Review
                | SettingsRow::BudgetAction
                | SettingsRow::AddSeat
        );
        let again = self.settings_sel == pos;
        self.settings_sel = pos;
        if switch || again {
            self.begin_edit();
        }
    }

    /// Save the config (unless persistence is off) and toast `note`.
    pub(super) fn persist_config(&mut self, note: impl Into<String>) {
        if !self.persist {
            self.toast(note);
            return;
        }
        match self.ctx.config.save() {
            Ok(()) => self.toast(note),
            Err(e) => self.toast(format!("Couldn't save settings: {e}")),
        }
    }

    /// The resolved model for a choice, with its class and prices.
    fn describe_choice(&self, provider: Provider, choice: &ModelChoice) -> String {
        let empty = Vec::new();
        let avail = self.ctx.available.get(&provider).unwrap_or(&empty);
        let id = match choice {
            ModelChoice::Id(id) => id.clone(),
            ModelChoice::Auto(tier) => resolve_model(
                provider,
                *tier,
                avail,
                self.ctx.config.selection(provider, *tier).as_deref(),
            ),
        };
        let row = model_row(provider, &id);
        let price = match (row.pricing.input, row.pricing.output) {
            (Some(i), Some(o)) => format!(" · ${}/{} per 1M", usd(i), usd(o)),
            _ => " · unpriced".to_string(),
        };
        let arrow = if matches!(choice, ModelChoice::Auto(_)) {
            format!(" → {id}")
        } else {
            String::new()
        };
        format!("{arrow} · {}{price}", row.class.label())
    }

    /// Start editing the current row (or toggle it).
    fn begin_edit(&mut self) {
        let row = self.settings_row();
        let config = &self.ctx.config;
        let draft = |kind: DraftKind, buffer: String| SettingsDraft { row, kind, buffer };
        match row {
            SettingsRow::Key(provider) => {
                self.key_draft = Some(KeyDraft {
                    provider,
                    buffer: String::new(),
                });
            }
            SettingsRow::Seat(i) => {
                let seats = config.seats_or_default();
                if let Some(seat) = seats.get(i) {
                    let buffer = format!("{}:{}", seat.provider, seat.model);
                    self.settings_draft = Some(draft(DraftKind::Spec, buffer));
                }
            }
            SettingsRow::AddSeat => self.add_seat(),
            SettingsRow::Moderator => {
                let m = config.moderator_ref();
                self.settings_draft = Some(draft(
                    DraftKind::Spec,
                    format!("{}:{}", m.provider.slug(), m.model.label()),
                ));
            }
            SettingsRow::Utility => {
                let u = config.utility_ref();
                self.settings_draft = Some(draft(
                    DraftKind::Spec,
                    format!("{}:{}", u.provider.slug(), u.model.label()),
                ));
            }
            SettingsRow::ToolsLevel => {
                let next = match tools_level(&config.tools) {
                    "none" => ToolPolicy::safe(),
                    "safe" => ToolPolicy::all(),
                    _ => ToolPolicy::none(),
                };
                let approval = config.tools.approval;
                self.ctx.config.tools = next;
                self.ctx.config.tools.approval = approval;
                let level = tools_level(&self.ctx.config.tools).to_string();
                self.persist_config(format!("Tools: {level}."));
            }
            SettingsRow::ToolsApproval => {
                self.ctx.config.tools.approval = match config.tools.approval {
                    Approval::Auto => Approval::Ask,
                    Approval::Ask => Approval::Auto,
                };
                let note = match self.ctx.config.tools.approval {
                    Approval::Auto => "Tools run without asking.",
                    Approval::Ask => "Every tool call asks first.",
                };
                self.persist_config(note);
            }
            SettingsRow::Rounds => {
                self.settings_draft = Some(draft(
                    DraftKind::Text,
                    config.protocol.max_rounds.to_string(),
                ));
            }
            SettingsRow::Interactive => {
                self.ctx.config.protocol.interactive = !config.protocol.interactive;
                let note = if self.ctx.config.protocol.interactive {
                    "The moderator may ask one clarifying question."
                } else {
                    "The moderator plans without asking."
                };
                self.persist_config(note);
            }
            SettingsRow::Review => {
                self.ctx.config.protocol.review = !config.protocol.review;
                let note = if self.ctx.config.protocol.review {
                    "Seats score each other and the argument gets mapped after the record."
                } else {
                    "No review: the summary shows counts from the run instead."
                };
                self.persist_config(note);
            }
            SettingsRow::BudgetSession => {
                self.settings_draft = Some(draft(
                    DraftKind::Text,
                    format!("{}", config.budget_per_session_usd),
                ));
            }
            SettingsRow::BudgetDay => {
                self.settings_draft = Some(draft(
                    DraftKind::Text,
                    format!("{}", config.budget_per_day_usd),
                ));
            }
            SettingsRow::BudgetAction => {
                self.ctx.config.budget_action = if config.budget_action == "stop" {
                    "warn".into()
                } else {
                    "stop".into()
                };
                let note = format!("At the cap: {}.", self.ctx.config.budget_action);
                self.persist_config(note);
            }
            // Never prefill a proxy URL into a visible buffer — it may carry
            // credentials.
            SettingsRow::Proxy => {
                self.settings_draft = Some(draft(DraftKind::Text, String::new()));
            }
        }
    }

    /// Apply a finished edit buffer. Invalid input toasts and keeps the
    /// previous value.
    fn commit_draft(&mut self, draft: SettingsDraft) {
        let value = draft.buffer.trim().to_string();
        match (draft.row, draft.kind) {
            (SettingsRow::Seat(i), DraftKind::Spec) => {
                let (provider, choice) = match parse_spec(&value, &self.ctx.available) {
                    Ok(x) => x,
                    Err(e) => {
                        self.toast(e);
                        return;
                    }
                };
                let mut seats = self.ctx.config.seats_or_default();
                let Some(seat) = seats.get_mut(i) else {
                    return;
                };
                seat.provider = provider.slug().to_string();
                seat.model = choice.label();
                let name = seat.name.clone();
                self.ctx.config.seats = seats;
                self.persist_config(format!("{name}: {}:{}.", provider.slug(), choice.label()));
            }
            (SettingsRow::Seat(i), DraftKind::Name) => {
                if value.is_empty() {
                    self.toast("A seat needs a name.");
                    return;
                }
                let mut seats = self.ctx.config.seats_or_default();
                if let Some(seat) = seats.get_mut(i) {
                    seat.name = value.chars().take(24).collect();
                }
                self.ctx.config.seats = seats;
                self.persist_config("Renamed the seat.");
            }
            (SettingsRow::Moderator, _) | (SettingsRow::Utility, _) => {
                let (provider, choice) = match parse_spec(&value, &self.ctx.available) {
                    Ok(x) => x,
                    Err(e) => {
                        self.toast(e);
                        return;
                    }
                };
                let slot = SlotConfig {
                    provider: provider.slug().to_string(),
                    model: choice.label(),
                };
                let label = if draft.row == SettingsRow::Moderator {
                    self.ctx.config.moderator = Some(slot);
                    "Moderator"
                } else {
                    self.ctx.config.utility = Some(slot);
                    "Utility"
                };
                self.persist_config(format!("{label}: {}:{}.", provider.slug(), choice.label()));
            }
            (SettingsRow::Rounds, _) => match value.parse::<u8>() {
                Ok(n) if (1..=6).contains(&n) => {
                    self.ctx.config.protocol.max_rounds = n;
                    self.persist_config(format!("Up to {n} cross-examination round(s)."));
                }
                _ => self.toast("Cross-examination rounds: 1 to 6."),
            },
            (SettingsRow::BudgetSession, _) | (SettingsRow::BudgetDay, _) => {
                match value.parse::<f64>() {
                    Ok(usd) if usd.is_finite() && (0.0..=100_000.0).contains(&usd) => {
                        if draft.row == SettingsRow::BudgetSession {
                            self.ctx.config.budget_per_session_usd = usd;
                        } else {
                            self.ctx.config.budget_per_day_usd = usd;
                        }
                        let note = if usd > 0.0 {
                            format!("Budget cap ${usd:.2}.")
                        } else {
                            "Budget cap removed.".to_string()
                        };
                        self.persist_config(note);
                    }
                    _ => self.toast("Budget must be a USD amount (0 = unlimited)."),
                }
            }
            (SettingsRow::Proxy, _) => {
                if value.is_empty() {
                    self.ctx.config.proxy = None;
                    self.persist_config("Proxy removed; applies to the next run.");
                } else if value.contains("://") {
                    self.ctx.config.proxy = Some(value);
                    self.persist_config("Proxy saved; applies to the next run of the CLI.");
                } else {
                    self.toast("Proxy needs a full URL (http://, https://, socks5://…).");
                }
            }
            _ => {}
        }
    }

    /// `d`: remove a key or a seat, or reset a row to its default.
    fn reset_row(&mut self) {
        match self.settings_row() {
            SettingsRow::Key(provider) => self.clear_key(provider),
            SettingsRow::Seat(i) => {
                let mut seats = self.ctx.config.seats_or_default();
                if seats.len() <= 1 {
                    self.toast("The council needs at least one seat.");
                    return;
                }
                if i < seats.len() {
                    let removed = seats.remove(i);
                    self.ctx.config.seats = seats;
                    self.settings_sel = self.settings_sel.min(self.settings_rows().len() - 1);
                    self.persist_config(format!("Removed {}.", removed.name));
                }
            }
            SettingsRow::AddSeat => {}
            SettingsRow::Moderator => {
                self.ctx.config.moderator = None;
                self.persist_config("Moderator back to the default (Google on Auto).");
            }
            SettingsRow::Utility => {
                self.ctx.config.utility = None;
                self.persist_config(
                    "Utility back to the default (the moderator's provider, Auto-fast).",
                );
            }
            SettingsRow::ToolsLevel => {
                let approval = self.ctx.config.tools.approval;
                self.ctx.config.tools = ToolPolicy::safe();
                self.ctx.config.tools.approval = approval;
                self.persist_config("Tools: safe.");
            }
            SettingsRow::ToolsApproval => {
                self.ctx.config.tools.approval = Approval::Auto;
                self.persist_config("Tools run without asking.");
            }
            SettingsRow::Rounds => {
                self.ctx.config.protocol.max_rounds = 3;
                self.persist_config("Up to 3 cross-examination rounds.");
            }
            SettingsRow::Interactive => {
                self.ctx.config.protocol.interactive = true;
                self.persist_config("The moderator may ask one clarifying question.");
            }
            SettingsRow::Review => {
                self.ctx.config.protocol.review = true;
                self.persist_config(
                    "Seats score each other and the argument gets mapped after the record.",
                );
            }
            SettingsRow::BudgetSession => {
                self.ctx.config.budget_per_session_usd = 0.0;
                self.persist_config("Session budget cap removed.");
            }
            SettingsRow::BudgetDay => {
                self.ctx.config.budget_per_day_usd = 0.0;
                self.persist_config("Daily budget cap removed.");
            }
            SettingsRow::BudgetAction => {
                self.ctx.config.budget_action = "warn".into();
                self.persist_config("At the cap: warn.");
            }
            SettingsRow::Proxy => {
                self.ctx.config.proxy = None;
                self.persist_config("Proxy removed; applies to the next run.");
            }
        }
    }

    /// `a`: add a seat on the first provider without one (else OpenAI), on
    /// Auto, and move the cursor onto it.
    fn add_seat(&mut self) {
        let mut seats = self.ctx.config.seats_or_default();
        if seats.len() >= 16 {
            self.toast("Sixteen seats is the most a council takes.");
            return;
        }
        let provider = Provider::ALL
            .into_iter()
            .find(|p| !seats.iter().any(|s| s.provider == p.slug()))
            .unwrap_or(Provider::OpenAI);
        let n = seats
            .iter()
            .filter(|s| s.provider == provider.slug())
            .count()
            + 1;
        let base_id = provider.slug().to_string();
        let mut id = if n == 1 {
            base_id.clone()
        } else {
            format!("{base_id}-{n}")
        };
        let mut k = n;
        while seats.iter().any(|s| s.id == id) {
            k += 1;
            id = format!("{base_id}-{k}");
        }
        let base_name = display_name_for(provider.slug());
        let name = if n == 1 {
            base_name
        } else {
            format!("{base_name} {n}")
        };
        seats.push(SeatConfig {
            id,
            name: name.clone(),
            provider: provider.slug().to_string(),
            model: "auto".into(),
            reasoning: None,
        });
        let index = seats.len() - 1;
        self.ctx.config.seats = seats;
        self.settings_sel = self
            .settings_rows()
            .iter()
            .position(|r| *r == SettingsRow::Seat(index))
            .unwrap_or(self.settings_sel);
        self.persist_config(format!("Added {name} on {}.", provider.display_name()));
    }

    /// `r` on a seat: cycle its reasoning override.
    fn cycle_seat_reasoning(&mut self) {
        let SettingsRow::Seat(i) = self.settings_row() else {
            return;
        };
        let mut seats = self.ctx.config.seats_or_default();
        let Some(seat) = seats.get_mut(i) else {
            return;
        };
        seat.reasoning = cycle_reasoning(seat.reasoning);
        let note = match seat.reasoning {
            Some(t) => format!("{}: {} reasoning in every round.", seat.name, t.label()),
            None => format!("{}: the round's reasoning tier.", seat.name),
        };
        self.ctx.config.seats = seats;
        self.persist_config(note);
    }

    /// `R`: back to the eight named seats on Auto.
    fn reset_roster(&mut self) {
        self.ctx.config.seats.clear();
        self.settings_sel = self.settings_sel.min(self.settings_rows().len() - 1);
        self.persist_config("Roster reset to the eight named seats.");
    }
}

/// Returns `true` to quit (never, from Settings).
pub fn handle_key(app: &mut App, key: KeyEvent) -> bool {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    // Editing a provider's key: capture printable input (masked on screen),
    // Enter saves, Esc cancels, ^U clears the buffer.
    if app.key_draft.is_some() {
        match key.code {
            KeyCode::Esc => app.key_draft = None,
            KeyCode::Enter => {
                if let Some(draft) = app.key_draft.take() {
                    let value = draft.buffer.trim().to_string();
                    if value.is_empty() {
                        app.toast("No key entered — paste a key or press Esc.");
                    } else {
                        app.save_key(draft.provider, value);
                    }
                }
            }
            KeyCode::Backspace => {
                if let Some(d) = app.key_draft.as_mut() {
                    d.buffer.pop();
                }
            }
            KeyCode::Char('u') if ctrl => {
                if let Some(d) = app.key_draft.as_mut() {
                    d.buffer.clear();
                }
            }
            KeyCode::Char(c) if !ctrl => {
                if let Some(d) = app.key_draft.as_mut() {
                    d.buffer.push(c);
                }
            }
            _ => {}
        }
        return false;
    }
    // Editing a row.
    if app.settings_draft.is_some() {
        match key.code {
            KeyCode::Esc => app.settings_draft = None,
            KeyCode::Enter => {
                if let Some(draft) = app.settings_draft.take() {
                    app.commit_draft(draft);
                }
            }
            KeyCode::Backspace => {
                if let Some(d) = app.settings_draft.as_mut() {
                    d.buffer.pop();
                }
            }
            KeyCode::Char('u') if ctrl => {
                if let Some(d) = app.settings_draft.as_mut() {
                    d.buffer.clear();
                }
            }
            KeyCode::Char(c) if !ctrl => {
                if let Some(d) = app.settings_draft.as_mut() {
                    d.buffer.push(c);
                }
            }
            _ => {}
        }
        return false;
    }

    let last = app.settings_rows().len() - 1;
    match key.code {
        KeyCode::Esc => app.view = app.prev_view,
        KeyCode::Up => app.settings_sel = app.settings_sel.saturating_sub(1),
        KeyCode::Down => app.settings_sel = (app.settings_sel + 1).min(last),
        KeyCode::PageUp => app.settings_sel = app.settings_sel.saturating_sub(8),
        KeyCode::PageDown => app.settings_sel = (app.settings_sel + 8).min(last),
        KeyCode::Home => app.settings_sel = 0,
        KeyCode::End => app.settings_sel = last,
        KeyCode::Enter | KeyCode::Char('e') => app.begin_edit(),
        KeyCode::Char('d') => app.reset_row(),
        KeyCode::Char('a') => app.add_seat(),
        KeyCode::Char('r') => app.cycle_seat_reasoning(),
        KeyCode::Char('R') => app.reset_roster(),
        KeyCode::Char('n') => {
            if let SettingsRow::Seat(i) = app.settings_row() {
                let name = app
                    .ctx
                    .config
                    .seats_or_default()
                    .get(i)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                app.settings_draft = Some(SettingsDraft {
                    row: SettingsRow::Seat(i),
                    kind: DraftKind::Name,
                    buffer: name,
                });
            }
        }
        _ => {}
    }
    false
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([
        Constraint::Length(2), // header
        Constraint::Min(3),    // the list
        Constraint::Length(1), // footer
    ])
    .split(area);
    render_header(f, rows[0]);
    render_rows(f, rows[1], app);
    render_footer(f, rows[2], app);
}

fn render_header(f: &mut Frame, area: Rect) {
    let title = Line::from(vec![
        Span::styled(
            "Settings",
            Style::default()
                .fg(theme::GOLD)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "  ·  keys, council, tools, protocol, budget",
            Style::default().fg(theme::MUTED),
        ),
    ]);
    let sub = Line::from(Span::styled(
        "Keys are stored locally (0600); desktop-app keys are shared automatically. Changes save as you make them.",
        Style::default().fg(theme::DIM),
    ));
    f.render_widget(Paragraph::new(vec![title, sub]), area);
}

/// A list line, tagged with the row it belongs to (headers have none).
struct Entry {
    row: Option<SettingsRow>,
    line: Line<'static>,
}

fn section(title: &str) -> Entry {
    Entry {
        row: None,
        line: Line::from(Span::styled(
            format!(" {title}"),
            Style::default()
                .fg(theme::GOLD)
                .add_modifier(Modifier::BOLD),
        )),
    }
}

fn blank() -> Entry {
    Entry {
        row: None,
        line: Line::from(""),
    }
}

fn source_color(source: KeySource) -> Color {
    match source {
        KeySource::Local => theme::EMERALD,
        KeySource::Env => theme::MUTED,
        KeySource::Shared => theme::GOLD,
        KeySource::None => theme::DIM,
    }
}

fn render_rows(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let selected = app.settings_row();
    let editing_key = app.key_draft.as_ref().map(|d| d.provider);
    let draft = app.settings_draft.as_ref();
    let seats = config.seats_or_default();
    let mut entries: Vec<Entry> = Vec::new();

    let cursor = |row: SettingsRow| if row == selected { "▸" } else { " " };
    let name_style = |row: SettingsRow| {
        if row == selected {
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        }
    };
    let edit_line = |row: SettingsRow, label: &str, d: &SettingsDraft| {
        let shown = if d.masked() {
            "•".repeat(d.buffer.chars().count().min(40))
        } else {
            d.buffer.clone()
        };
        Line::from(vec![
            Span::styled(
                format!(" {} ", cursor(row)),
                Style::default().fg(theme::GOLD),
            ),
            Span::styled("⌨ ", Style::default().fg(theme::GOLD)),
            Span::styled(
                format!("{label:<12}"),
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("▶ ", Style::default().fg(theme::MUTED)),
            Span::styled(shown, Style::default().fg(theme::GOLD)),
            Span::styled("▌", Style::default().fg(theme::GOLD)),
        ])
    };

    // ---- Keys -------------------------------------------------------------
    let configured = app.configured_count();
    entries.push(section(&format!("Keys · {configured}/8 providers")));
    for agent in theme::AGENTS.iter() {
        let provider = agent.provider;
        let row = SettingsRow::Key(provider);
        if editing_key == Some(provider) {
            let n = app
                .key_draft
                .as_ref()
                .map(|d| d.buffer.chars().count())
                .unwrap_or(0);
            let bullets = "•".repeat(n.min(40));
            entries.push(Entry {
                row: Some(row),
                line: Line::from(vec![
                    Span::styled(
                        format!(" {} ", cursor(row)),
                        Style::default().fg(theme::GOLD),
                    ),
                    Span::styled("⌨ ", Style::default().fg(theme::GOLD)),
                    Span::styled(
                        format!("{:<12}", provider.display_name()),
                        Style::default()
                            .fg(theme::TEXT)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled("paste key ▶ ", Style::default().fg(theme::MUTED)),
                    Span::styled(bullets, Style::default().fg(theme::GOLD)),
                    Span::styled(format!(" ({n})"), Style::default().fg(theme::DIM)),
                ]),
            });
            continue;
        }
        let source = config.key_source(provider);
        let keyed = config.is_configured(provider);
        let (mark, mark_color) = if keyed {
            ("✓", agent.color)
        } else {
            ("·", theme::DIM)
        };
        let seat_names: Vec<&str> = seats
            .iter()
            .filter(|s| s.provider == provider.slug())
            .map(|s| s.name.as_str())
            .collect();
        entries.push(Entry {
            row: Some(row),
            line: Line::from(vec![
                Span::styled(
                    format!(" {} ", cursor(row)),
                    Style::default().fg(theme::GOLD),
                ),
                Span::styled(format!("{mark} "), Style::default().fg(mark_color)),
                Span::styled(
                    format!("{:<12}", provider.display_name()),
                    if keyed {
                        name_style(row)
                    } else {
                        Style::default().fg(theme::DIM)
                    },
                ),
                Span::styled(
                    format!("{:<8}", source.label()),
                    Style::default().fg(source_color(source)),
                ),
                Span::styled(
                    if seat_names.is_empty() {
                        "no seat".to_string()
                    } else {
                        seat_names.join(", ")
                    },
                    Style::default().fg(theme::DIM),
                ),
            ]),
        });
    }
    entries.push(blank());

    // ---- Council ----------------------------------------------------------
    entries.push(section(&format!("Council · {} seats", seats.len())));
    for (i, seat) in seats.iter().enumerate() {
        let row = SettingsRow::Seat(i);
        if let Some(d) = draft.filter(|d| d.row == row) {
            let label = match d.kind {
                DraftKind::Name => "name",
                _ => "provider:model",
            };
            entries.push(Entry {
                row: Some(row),
                line: edit_line(row, label, d),
            });
            continue;
        }
        let provider = Provider::from_slug(&seat.provider);
        let color = provider.map(theme::provider_color).unwrap_or(theme::DIM);
        let keyed = provider.is_some_and(|p| config.is_configured(p));
        let choice = ModelChoice::parse(&seat.model);
        let detail = provider
            .map(|p| app.describe_choice(p, &choice))
            .unwrap_or_else(|| " · unknown provider".to_string());
        let reasoning = match seat.reasoning {
            Some(t) => format!(" · {} reasoning", t.label()),
            None => String::new(),
        };
        entries.push(Entry {
            row: Some(row),
            line: Line::from(vec![
                Span::styled(
                    format!(" {} ", cursor(row)),
                    Style::default().fg(theme::GOLD),
                ),
                Span::styled(
                    if keyed { "● " } else { "○ " },
                    Style::default().fg(if keyed { color } else { theme::DIM }),
                ),
                Span::styled(
                    format!("{:<10}", theme::truncate(&seat.name, 10)),
                    name_style(row),
                ),
                Span::styled(
                    format!("{}:{}", seat.provider, seat.model),
                    Style::default().fg(theme::MUTED),
                ),
                Span::styled(detail, Style::default().fg(theme::DIM)),
                Span::styled(reasoning, Style::default().fg(theme::DIM)),
            ]),
        });
    }
    let row = SettingsRow::AddSeat;
    entries.push(Entry {
        row: Some(row),
        line: Line::from(vec![
            Span::styled(
                format!(" {} ", cursor(row)),
                Style::default().fg(theme::GOLD),
            ),
            Span::styled(
                "+ add a seat",
                if row == selected {
                    Style::default()
                        .fg(theme::GOLD)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::MUTED)
                },
            ),
            Span::styled(
                "   (a add · n rename · r reasoning · d remove · R reset the eight)",
                Style::default().fg(theme::DIM),
            ),
        ]),
    });
    entries.push(blank());

    // ---- Slots ------------------------------------------------------------
    entries.push(section("Moderator & utility"));
    let m = config.moderator_ref();
    let u = config.utility_ref();
    for (row, label, provider, choice, custom) in [
        (
            SettingsRow::Moderator,
            "Moderator",
            m.provider,
            m.model.clone(),
            config.moderator.is_some(),
        ),
        (
            SettingsRow::Utility,
            "Utility",
            u.provider,
            u.model.clone(),
            config.utility.is_some(),
        ),
    ] {
        if let Some(d) = draft.filter(|d| d.row == row) {
            entries.push(Entry {
                row: Some(row),
                line: edit_line(row, "provider:model", d),
            });
            continue;
        }
        let keyed = config.is_configured(provider);
        entries.push(Entry {
            row: Some(row),
            line: Line::from(vec![
                Span::styled(
                    format!(" {} ", cursor(row)),
                    Style::default().fg(theme::GOLD),
                ),
                Span::styled(format!("{label:<12}"), name_style(row)),
                Span::styled(
                    format!("{}:{}", provider.slug(), choice.label()),
                    Style::default().fg(theme::MUTED),
                ),
                Span::styled(
                    app.describe_choice(provider, &choice),
                    Style::default().fg(theme::DIM),
                ),
                Span::styled(
                    if !keyed {
                        " · no key: the first keyed provider stands in"
                    } else if custom {
                        ""
                    } else {
                        " · default"
                    },
                    Style::default().fg(theme::DIM),
                ),
            ]),
        });
    }
    entries.push(blank());

    // ---- Tools, protocol, budget, proxy ----------------------------------
    entries.push(section("Tools & protocol"));
    let plain = |row: SettingsRow, label: &str, value: String, hint: &str| Entry {
        row: Some(row),
        line: Line::from(vec![
            Span::styled(
                format!(" {} ", cursor(row)),
                Style::default().fg(theme::GOLD),
            ),
            Span::styled(format!("{label:<22}"), name_style(row)),
            Span::styled(value, Style::default().fg(theme::MUTED)),
            Span::styled(format!("  {hint}"), Style::default().fg(theme::DIM)),
        ]),
    };
    let level = tools_level(&config.tools);
    entries.push(plain(
        SettingsRow::ToolsLevel,
        "Tools",
        level.to_string(),
        match level {
            "none" => "seats reason without tools",
            "safe" => "attachments, web search, claim checks, workspace files",
            _ => "safe tools plus the sandboxed shell",
        },
    ));
    entries.push(plain(
        SettingsRow::ToolsApproval,
        "Tool approval",
        match config.tools.approval {
            Approval::Auto => "auto".into(),
            Approval::Ask => "ask".into(),
        },
        "ask = every call waits for y/n on the Session screen",
    ));
    let rounds_value = config.protocol.max_rounds.to_string();
    match draft.filter(|d| d.row == SettingsRow::Rounds) {
        Some(d) => entries.push(Entry {
            row: Some(SettingsRow::Rounds),
            line: edit_line(SettingsRow::Rounds, "rounds", d),
        }),
        None => entries.push(plain(
            SettingsRow::Rounds,
            "Cross-examination",
            format!("up to {rounds_value} round(s)"),
            "the moderator may use fewer",
        )),
    }
    entries.push(plain(
        SettingsRow::Interactive,
        "Clarifying question",
        if config.protocol.interactive {
            "on".into()
        } else {
            "off".into()
        },
        "the moderator may ask you one question before planning",
    ));
    entries.push(plain(
        SettingsRow::Review,
        "Review afterwards",
        if config.protocol.review {
            "on".into()
        } else {
            "off".into()
        },
        "peer scores and the argument map, on the utility model: one call per seat plus one per round",
    ));
    entries.push(blank());

    entries.push(section("Budget & network"));
    for (row, label, value, hint) in [
        (
            SettingsRow::BudgetSession,
            "Budget / session",
            if config.budget_per_session_usd > 0.0 {
                format!("${:.2}", config.budget_per_session_usd)
            } else {
                "unlimited".into()
            },
            "USD; 0 = unlimited",
        ),
        (
            SettingsRow::BudgetDay,
            "Budget / day",
            if config.budget_per_day_usd > 0.0 {
                format!("${:.2}", config.budget_per_day_usd)
            } else {
                "unlimited".into()
            },
            "across sessions, UTC day",
        ),
        (
            SettingsRow::BudgetAction,
            "At the cap",
            config.budget_action.clone(),
            "warn keeps going; stop closes with a record",
        ),
        (
            SettingsRow::Proxy,
            "Proxy",
            match config.proxy.as_deref() {
                Some(url) => redact_proxy(url),
                None => "none".into(),
            },
            "http://, https://, socks5://; applies to the next run",
        ),
    ] {
        match draft.filter(|d| d.row == row) {
            Some(d) => entries.push(Entry {
                row: Some(row),
                line: edit_line(row, label, d),
            }),
            None => entries.push(plain(row, label, value, hint)),
        }
    }

    // Keep the selected row in view.
    let inner_h = area.height.saturating_sub(2) as usize;
    let sel_index = entries
        .iter()
        .position(|e| e.row == Some(selected))
        .unwrap_or(0);
    let offset = if inner_h == 0 {
        0
    } else {
        // Show a header line above the row when scrolling down.
        sel_index.saturating_sub(inner_h.saturating_sub(2))
    };
    // Each row on screen is clickable, by its place in the row order.
    let order = app.settings_rows();
    for (i, e) in entries.iter().enumerate().skip(offset).take(inner_h) {
        let Some(row) = e.row else { continue };
        if let Some(pos) = order.iter().position(|r| *r == row) {
            app.hit(
                Rect {
                    x: area.x + 1,
                    y: area.y + 1 + (i - offset) as u16,
                    width: area.width.saturating_sub(2),
                    height: 1,
                },
                Click::SettingsRow(pos),
            );
        }
    }
    let lines: Vec<Line<'static>> = entries.into_iter().map(|e| e.line).collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM));
    f.render_widget(
        Paragraph::new(lines)
            .scroll((offset as u16, 0))
            .block(block),
        area,
    );
}

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let hint = if app.key_draft.is_some() {
        Line::from(vec![
            key("Enter"),
            Span::styled(" save   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" cancel   ", Style::default().fg(theme::MUTED)),
            key("^U"),
            Span::styled(
                " clear   ·   key is masked & stored 0600",
                Style::default().fg(theme::DIM),
            ),
        ])
    } else if let Some(d) = &app.settings_draft {
        let what = match d.kind {
            DraftKind::Spec => "provider:model — auto, auto-balanced, auto-fast or a catalog id",
            DraftKind::Name => "a display name",
            DraftKind::Text => "a value",
        };
        Line::from(vec![
            key("Enter"),
            Span::styled(" save   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" cancel   ", Style::default().fg(theme::MUTED)),
            key("^U"),
            Span::styled(
                format!(" clear   ·   {what}"),
                Style::default().fg(theme::DIM),
            ),
        ])
    } else {
        Line::from(vec![
            key("↑↓"),
            Span::styled(" select   ", Style::default().fg(theme::MUTED)),
            key("Enter"),
            Span::styled(" edit / toggle   ", Style::default().fg(theme::MUTED)),
            key("d"),
            Span::styled(" remove / reset   ", Style::default().fg(theme::MUTED)),
            key("a"),
            Span::styled(" add seat   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" back", Style::default().fg(theme::MUTED)),
        ])
    };
    f.render_widget(Paragraph::new(hint), area);
}

fn key(label: &str) -> Span<'_> {
    Span::styled(
        label,
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_rows_cover_every_section() {
        let mut config = Config::default();
        let rows = settings_rows(&config);
        // keys, seats, add-seat, then the ten fixed rows plus review afterwards.
        assert_eq!(rows.len(), 8 + 8 + 1 + 11);
        assert_eq!(rows[0], SettingsRow::Key(Provider::OpenAI));
        assert_eq!(rows[8], SettingsRow::Seat(0));
        assert_eq!(rows[16], SettingsRow::AddSeat);
        assert_eq!(*rows.last().unwrap(), SettingsRow::Proxy);
        config.seats = vec![SeatConfig {
            id: "solo".into(),
            name: "Solo".into(),
            provider: "openai".into(),
            model: "auto".into(),
            reasoning: None,
        }];
        assert_eq!(settings_rows(&config).len(), 8 + 1 + 1 + 11);
    }

    #[test]
    fn seat_spec_parses_and_validates_against_the_catalog() {
        let available = HashMap::new();
        assert_eq!(
            parse_spec("anthropic:auto", &available).unwrap(),
            (Provider::Anthropic, ModelChoice::Auto(ReasoningTier::High))
        );
        assert_eq!(
            parse_spec(" google : auto-fast ", &available).unwrap(),
            (Provider::Google, ModelChoice::Auto(ReasoningTier::Low))
        );
        assert_eq!(
            parse_spec("kimi", &available).unwrap().1,
            ModelChoice::Auto(ReasoningTier::High)
        );
        assert!(parse_spec("nope:auto", &available)
            .unwrap_err()
            .contains("Unknown provider"));
        // A made-up id is refused, with a hint.
        let err = parse_spec("openai:gpt-99-hypothetical", &available).unwrap_err();
        assert!(err.contains("has no model"), "{err}");
        // A catalog id is accepted as is.
        let real = catalog_models(Provider::OpenAI)[0].id.clone();
        assert_eq!(
            parse_spec(&format!("openai:{real}"), &available).unwrap().1,
            ModelChoice::Id(real)
        );
        // A scanned id the catalog lacks is accepted too.
        let scanned = DiscoveredModel {
            id: "gpt-99-hypothetical".into(),
            provider: Provider::OpenAI,
            display_name: None,
            source: crate::catalog::ModelSource::Scanned,
            context_window: None,
            supports_thinking: None,
            output_price: None,
        };
        let available: HashMap<Provider, Vec<DiscoveredModel>> =
            [(Provider::OpenAI, vec![scanned])].into_iter().collect();
        assert!(parse_spec("openai:gpt-99-hypothetical", &available).is_ok());
        assert_eq!(usd(2.8169014084507045), "2.82");
        assert_eq!(usd(10.0), "10");
        assert_eq!(usd(0.3), "0.30");
        assert_eq!(cycle_reasoning(None), Some(ReasoningTier::Low));
        assert_eq!(cycle_reasoning(Some(ReasoningTier::High)), None);
    }
}
