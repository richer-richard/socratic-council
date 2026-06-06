//! Chat view — the debate chamber: a streaming transcript, the live roster,
//! a header with running usage, and a keybinding footer.

use super::{theme, App, Debate};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

pub fn render(f: &mut Frame, area: Rect, app: &mut App) {
    let frame = app.frame;
    let Some(debate) = app.debate.as_mut() else {
        return;
    };

    let rows = Layout::vertical([
        Constraint::Length(3), // header
        Constraint::Min(0),    // body
        Constraint::Length(1), // footer
    ])
    .split(area);

    render_header(f, rows[0], debate);

    let body = Layout::horizontal([Constraint::Percentage(72), Constraint::Percentage(28)])
        .split(rows[1]);
    render_transcript(f, body[0], debate);
    render_roster(f, body[1], debate, frame);
    render_footer(f, rows[2], debate);
}

fn render_header(f: &mut Frame, area: Rect, d: &Debate) {
    let chip = Span::styled(
        "  Socratic Council  ",
        Style::default().fg(ratatui::style::Color::Black).bg(theme::GOLD).add_modifier(Modifier::BOLD),
    );
    let topic = Span::styled(
        format!("  {}", truncate(&d.topic, area.width.saturating_sub(24) as usize)),
        Style::default().fg(theme::TEXT),
    );
    let meta = Line::from(Span::styled(
        format!(
            "turn {} · {} in / {} out tok · {}",
            d.turn_count, d.usage.input, d.usage.output, d.status
        ),
        Style::default().fg(theme::MUTED),
    ));
    let para = Paragraph::new(vec![Line::from(vec![chip, topic]), meta]).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::GOLD)),
    );
    f.render_widget(para, area);
}

fn render_transcript(f: &mut Frame, area: Rect, d: &mut Debate) {
    let mut lines: Vec<Line> = Vec::new();
    for turn in &d.turns {
        push_turn(&mut lines, &turn.agent_id, &turn.name, &turn.model, &turn.content);
    }
    if d.show_thinking && !d.thinking.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("  ⋯ {}", truncate(&d.thinking, 400)),
            Style::default().fg(theme::DIM).add_modifier(Modifier::ITALIC),
        )));
        lines.push(Line::from(""));
    }
    if let Some(s) = &d.streaming {
        push_turn(&mut lines, &s.agent_id, &format!("{} ▌", s.name), &s.model, &s.content);
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "  the council is gathering…",
            Style::default().fg(theme::DIM),
        )));
    }

    let inner_h = area.height.saturating_sub(2);
    let total = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    let max_off = total.saturating_sub(inner_h);
    // While following, pin to the bottom so a first scroll-up starts from there.
    let scroll = if d.follow {
        d.scroll = max_off;
        max_off
    } else {
        d.scroll = d.scroll.min(max_off);
        d.scroll
    };

    let title = if d.read_only { " Transcript · read-only " } else { " Transcript " };
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::DIM))
                .title(Span::styled(title, Style::default().fg(theme::MUTED))),
        );
    f.render_widget(para, area);
}

fn push_turn(lines: &mut Vec<Line>, agent_id: &str, name: &str, model: &str, content: &str) {
    let color = theme::speaker_color(agent_id);
    let mut header =
        vec![Span::styled(name.to_string(), Style::default().fg(color).add_modifier(Modifier::BOLD))];
    if !model.is_empty() {
        header.push(Span::styled(format!("  {model}"), Style::default().fg(theme::DIM)));
    }
    lines.push(Line::from(header));
    for line in content.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default().fg(theme::TEXT),
        )));
    }
    lines.push(Line::from(""));
}

fn render_roster(f: &mut Frame, area: Rect, d: &Debate, frame: u64) {
    let pulse_on = frame % 12 < 6;
    let items: Vec<ListItem> = d
        .roster
        .iter()
        .map(|a| {
            let active = d.active.as_deref() == Some(a.name.as_str());
            let marker = if active {
                if pulse_on {
                    "● "
                } else {
                    "◉ "
                }
            } else {
                "○ "
            };
            let name_style = if active {
                Style::default().fg(a.color).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            let mut spans = vec![
                Span::styled(marker, Style::default().fg(a.color)),
                Span::styled(format!("{:<8}", a.name), name_style),
            ];
            if !a.model.is_empty() {
                spans.push(Span::styled(
                    truncate(&a.model, 14),
                    Style::default().fg(theme::DIM),
                ));
            } else {
                spans.push(Span::styled(a.provider.slug(), Style::default().fg(theme::DIM)));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::DIM))
            .title(Span::styled(" Council ", Style::default().fg(theme::MUTED))),
    );
    f.render_widget(list, area);
}

fn render_footer(f: &mut Frame, area: Rect, d: &Debate) {
    let mut spans = vec![
        key("Esc"),
        Span::styled(" home   ", Style::default().fg(theme::MUTED)),
        key("Tab"),
        Span::styled(" history   ", Style::default().fg(theme::MUTED)),
        key("t"),
        Span::styled(" thinking   ", Style::default().fg(theme::MUTED)),
        key("↑/↓"),
        Span::styled(" scroll   ", Style::default().fg(theme::MUTED)),
        key("g"),
        Span::styled(" follow", Style::default().fg(theme::MUTED)),
    ];
    if d.is_live() {
        spans.push(Span::styled("   · debating…", Style::default().fg(theme::GOLD)));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn key(label: &str) -> Span<'_> {
    Span::styled(label, Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
