//! History sidebar — the desktop app's saved sessions, collapsible via `Tab`.

use super::{theme, App, SessionRow};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph};
use ratatui::Frame;

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([Constraint::Length(2), Constraint::Min(0)]).split(area);
    render_brand(f, rows[0]);
    render_list(f, rows[1], app);
}

fn render_brand(f: &mut Frame, area: Rect) {
    let line = Line::from(vec![
        Span::styled("◆ ", Style::default().fg(theme::GOLD)),
        Span::styled(
            "socratic council",
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
    ]);
    let sub = Line::from(Span::styled(
        "council workstation",
        Style::default().fg(theme::DIM),
    ));
    f.render_widget(Paragraph::new(vec![line, sub]), area);
}

fn render_list(f: &mut Frame, area: Rect, app: &App) {
    let sessions = &app.sessions;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(
            format!(" History · {} ", sessions.len()),
            Style::default().fg(theme::MUTED),
        ));

    if sessions.is_empty() {
        let para = Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(
                "  No saved sessions yet.",
                Style::default().fg(theme::DIM),
            )),
            Line::from(Span::styled(
                "  Desktop-app history, if",
                Style::default().fg(theme::DIM),
            )),
            Line::from(Span::styled(
                "  any, is listed here.",
                Style::default().fg(theme::DIM),
            )),
        ])
        .block(block);
        f.render_widget(para, area);
        return;
    }

    let items: Vec<ListItem> = sessions
        .iter()
        .enumerate()
        .map(|(i, s)| session_item(s, i == app.sidebar_sel))
        .collect();
    f.render_widget(List::new(items).block(block), area);
}

fn session_item(s: &SessionRow, selected: bool) -> ListItem<'static> {
    let status_color = match s.status.as_str() {
        "completed" => Color::Rgb(0x34, 0xD3, 0x99),
        "running" => theme::GOLD,
        "paused" => theme::MUTED,
        _ => theme::DIM,
    };
    let title_style = if selected {
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD)
    } else if s.archived {
        Style::default().fg(theme::DIM)
    } else {
        Style::default().fg(theme::TEXT)
    };

    let marker = if selected { "▸ " } else { "  " };
    let title_line = Line::from(vec![
        Span::styled(marker, Style::default().fg(theme::GOLD)),
        Span::styled(truncate(&s.title, 24), title_style),
    ]);

    let mut meta_spans = vec![
        Span::styled("    ", Style::default()),
        Span::styled(status_label(&s.status), Style::default().fg(status_color)),
        Span::styled(format!(" · {} turns", s.turns), Style::default().fg(theme::DIM)),
    ];
    if s.archived {
        meta_spans.push(Span::styled(" · archived", Style::default().fg(theme::DIM)));
    }

    ListItem::new(vec![title_line, Line::from(meta_spans)])
}

fn status_label(status: &str) -> String {
    match status {
        "completed" => "Complete",
        "running" => "Running",
        "paused" => "Paused",
        _ => "Draft",
    }
    .to_string()
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
