//! Settings / Models view — an interactive key manager plus the council/utility
//! tiers and each provider's resolved model.
//!
//! Keys can be **added right here in the terminal** (stored locally at
//! `keys.enc`, `0600`) — no desktop app required, so the council works the same
//! on a headless VPS as on a laptop. Keys the desktop app already holds are
//! shared automatically and shown as `shared`. The key buffer is always rendered
//! masked; the plaintext never reaches the screen or a log.

use super::{redact_proxy, theme, App, OptionRow};
use crate::catalog::resolve_model;
use crate::config::KeySource;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([
        Constraint::Length(2),  // header
        Constraint::Length(10), // providers (8 rows + borders)
        Constraint::Length(7),  // options (5 rows + borders)
        Constraint::Min(4),     // council
        Constraint::Length(1),  // footer
    ])
    .split(area);

    render_header(f, rows[0]);
    render_providers(f, rows[1], app);
    render_options(f, rows[2], app);
    render_council(f, rows[3], app);
    render_footer(f, rows[4], app);
}

fn render_header(f: &mut Frame, area: Rect) {
    let title = Line::from(vec![
        Span::styled("Settings", Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD)),
        Span::styled("  ·  Keys, models & providers", Style::default().fg(theme::MUTED)),
    ]);
    let sub = Line::from(Span::styled(
        "Add a key here on any machine — stored locally (0600). Desktop-app keys are shared automatically.",
        Style::default().fg(theme::DIM),
    ));
    f.render_widget(Paragraph::new(vec![title, sub]), area);
}

fn render_providers(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let council = config.council_tier;
    let editing = app.key_draft.as_ref().map(|d| d.provider);
    let mut lines: Vec<Line> = Vec::new();

    for (i, agent) in theme::AGENTS.iter().enumerate() {
        let provider = agent.provider;
        let selected = i == app.settings_sel;
        let cursor = if selected { "▸" } else { " " };

        // The provider being edited becomes a masked input line.
        if editing == Some(provider) {
            let n = app.key_draft.as_ref().map(|d| d.buffer.chars().count()).unwrap_or(0);
            let bullets = "•".repeat(n.min(40));
            lines.push(Line::from(vec![
                Span::styled(format!(" {cursor} "), Style::default().fg(theme::GOLD)),
                Span::styled("⌨ ", Style::default().fg(theme::GOLD)),
                Span::styled(format!("{:<10}", provider.display_name()), Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)),
                Span::styled("paste key ▶ ", Style::default().fg(theme::MUTED)),
                Span::styled(bullets, Style::default().fg(theme::GOLD)),
                Span::styled(format!(" ({n})"), Style::default().fg(theme::DIM)),
            ]));
            continue;
        }

        let source = config.key_source(provider);
        let configured = config.is_configured(provider);
        let (mark, mark_color) = if configured { ("✓", agent.color) } else { ("·", theme::DIM) };

        let empty = Vec::new();
        let avail = app.ctx.available.get(&provider).unwrap_or(&empty);
        let model = resolve_model(provider, council, avail, config.selection(provider, council).as_deref());

        let name_style = if selected {
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
        } else if configured {
            Style::default().fg(theme::TEXT)
        } else {
            Style::default().fg(theme::DIM)
        };

        lines.push(Line::from(vec![
            Span::styled(format!(" {cursor} "), Style::default().fg(theme::GOLD)),
            Span::styled(format!("{mark} "), Style::default().fg(mark_color)),
            Span::styled(format!("{:<10}", provider.display_name()), name_style),
            Span::styled(format!("{:<8}", agent.name), Style::default().fg(agent.color)),
            Span::styled(
                format!("{:<22}", if configured { model } else { "no key".to_string() }),
                Style::default().fg(if configured { theme::MUTED } else { theme::DIM }),
            ),
            Span::styled(source.label(), Style::default().fg(source_color(source))),
        ]));
    }

    let configured = app.configured_count();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(
            format!(" Providers · {configured}/8 ready "),
            Style::default().fg(theme::MUTED),
        ));
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn source_color(source: KeySource) -> Color {
    match source {
        KeySource::Local => Color::Rgb(0x34, 0xD3, 0x99), // local — you set it here
        KeySource::Env => theme::MUTED,
        KeySource::Shared => theme::GOLD, // inherited from the desktop app
        KeySource::None => theme::DIM,
    }
}

/// The editable option rows: discussion cap, advisors, budget, proxy.
fn render_options(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let editing = app.option_draft.as_ref();
    let mut lines: Vec<Line> = Vec::new();

    for (i, row) in OptionRow::ALL.into_iter().enumerate() {
        let sel_index = theme::AGENTS.len() + i;
        let selected = sel_index == app.settings_sel;
        let cursor = if selected { "▸" } else { " " };

        // The row being edited becomes an input line (masked for the proxy).
        if let Some(draft) = editing.filter(|d| d.row == row) {
            let shown = if row.masked() {
                "•".repeat(draft.buffer.chars().count().min(40))
            } else {
                draft.buffer.clone()
            };
            lines.push(Line::from(vec![
                Span::styled(format!(" {cursor} "), Style::default().fg(theme::GOLD)),
                Span::styled("⌨ ", Style::default().fg(theme::GOLD)),
                Span::styled(
                    format!("{:<17}", row.label()),
                    Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
                ),
                Span::styled("▶ ", Style::default().fg(theme::MUTED)),
                Span::styled(shown, Style::default().fg(theme::GOLD)),
            ]));
            continue;
        }

        let value = match row {
            OptionRow::MaxTurns => match config.max_turns {
                0 => "no cap".to_string(),
                n => format!("{n} turns"),
            },
            OptionRow::ObserverInterval => {
                if !config.observers_enabled || config.observer_interval == 0 {
                    "off".to_string()
                } else {
                    format!("every {} turns", config.observer_interval)
                }
            }
            OptionRow::BudgetSession => {
                if config.budget_per_session_usd > 0.0 {
                    format!("${:.2} / session", config.budget_per_session_usd)
                } else {
                    "unlimited".to_string()
                }
            }
            OptionRow::BudgetAction => config.budget_action.clone(),
            OptionRow::Proxy => match config.proxy.as_deref() {
                Some(url) => redact_proxy(url),
                None => "none".to_string(),
            },
        };
        let name_style = if selected {
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::TEXT)
        };
        lines.push(Line::from(vec![
            Span::styled(format!(" {cursor} "), Style::default().fg(theme::GOLD)),
            Span::styled(format!("{:<19}", row.label()), name_style),
            Span::styled(value, Style::default().fg(theme::MUTED)),
        ]));
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(" Options ", Style::default().fg(theme::MUTED)));
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_council(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let lines = vec![
        kv("Council tier", config.council_tier.label(), Color::Rgb(0x34, 0xD3, 0x99)),
        kv("Utility tier", config.utility_tier.label(), theme::MUTED),
        Line::from(Span::styled(
            "  Models auto-resolve per provider; run `models --scan` to refresh from the API.",
            Style::default().fg(theme::DIM),
        )),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(" Council ", Style::default().fg(theme::MUTED)));
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn kv(label: &str, value: &str, value_color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {label:<16}"), Style::default().fg(theme::MUTED)),
        Span::styled(value.to_string(), Style::default().fg(value_color).add_modifier(Modifier::BOLD)),
    ])
}

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let hint = if app.key_draft.is_some() {
        Line::from(vec![
            key("Enter"),
            Span::styled(" save   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" cancel   ", Style::default().fg(theme::MUTED)),
            key("^U"),
            Span::styled(" clear   ·   key is masked & stored 0600", Style::default().fg(theme::DIM)),
        ])
    } else if app.option_draft.is_some() {
        Line::from(vec![
            key("Enter"),
            Span::styled(" save   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" cancel   ", Style::default().fg(theme::MUTED)),
            key("^U"),
            Span::styled(" clear", Style::default().fg(theme::MUTED)),
        ])
    } else {
        Line::from(vec![
            key("↑↓"),
            Span::styled(" select   ", Style::default().fg(theme::MUTED)),
            key("Enter"),
            Span::styled(" edit / set key   ", Style::default().fg(theme::MUTED)),
            key("d"),
            Span::styled(" remove / reset   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(" back", Style::default().fg(theme::MUTED)),
        ])
    };
    f.render_widget(Paragraph::new(hint), area);
}

fn key(label: &str) -> Span<'_> {
    Span::styled(label, Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD))
}
