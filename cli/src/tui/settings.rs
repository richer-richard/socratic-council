//! Settings / Models view — providers configured via the shared keys, the
//! council/utility tiers, and each provider's resolved model. Read-focused:
//! keys are inherited from the desktop app, not re-entered here.

use super::{theme, App};
use crate::catalog::resolve_model;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([
        Constraint::Length(2), // header
        Constraint::Min(0),    // providers
        Constraint::Length(6), // council
        Constraint::Length(1), // footer
    ])
    .split(area);

    render_header(f, rows[0]);
    render_providers(f, rows[1], app);
    render_council(f, rows[2], app);
    render_footer(f, rows[3]);
}

fn render_header(f: &mut Frame, area: Rect) {
    let title = Line::from(vec![
        Span::styled("Settings", Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD)),
        Span::styled("  ·  Models & providers", Style::default().fg(theme::MUTED)),
    ]);
    let sub = Line::from(Span::styled(
        "Keys are shared from the desktop app — no need to re-enter them here.",
        Style::default().fg(theme::DIM),
    ));
    f.render_widget(Paragraph::new(vec![title, sub]), area);
}

fn render_providers(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let council = config.council_tier;
    let mut lines: Vec<Line> = Vec::new();
    for agent in theme::AGENTS.iter() {
        let provider = agent.provider;
        let configured = config.is_configured(provider);
        let (mark, mark_color) =
            if configured { ("✓", agent.color) } else { ("·", theme::DIM) };

        let empty = Vec::new();
        let avail = app.ctx.available.get(&provider).unwrap_or(&empty);
        let model = resolve_model(provider, council, avail, config.selection(provider, council).as_deref());

        let name_style = if configured {
            Style::default().fg(theme::TEXT)
        } else {
            Style::default().fg(theme::DIM)
        };
        lines.push(Line::from(vec![
            Span::styled(format!(" {mark} "), Style::default().fg(mark_color)),
            Span::styled(format!("{:<10}", provider.display_name()), name_style),
            Span::styled(format!("{:<8}", agent.name), Style::default().fg(agent.color)),
            Span::styled(
                if configured { model } else { "no key".to_string() },
                Style::default().fg(if configured { theme::MUTED } else { theme::DIM }),
            ),
        ]));
    }

    let configured = app.configured_count();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(
            format!(" Providers · {configured}/8 keys shared "),
            Style::default().fg(theme::MUTED),
        ));
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn render_council(f: &mut Frame, area: Rect, app: &App) {
    let config = &app.ctx.config;
    let cap = match config.max_turns {
        0 => "no cap".to_string(),
        n => format!("{n} turns"),
    };
    let lines = vec![
        kv("Council tier", config.council_tier.label(), Color::Rgb(0x34, 0xD3, 0x99)),
        kv("Utility tier", config.utility_tier.label(), theme::MUTED),
        kv("Discussion cap", &cap, theme::MUTED),
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

fn render_footer(f: &mut Frame, area: Rect) {
    let hint = Line::from(vec![
        Span::styled("Esc", Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD)),
        Span::styled(" back to home", Style::default().fg(theme::MUTED)),
    ]);
    f.render_widget(Paragraph::new(hint), area);
}
