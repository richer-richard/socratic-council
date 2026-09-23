//! Sessions sidebar — the shared store's sessions (and the desktop app's
//! chat-era index), collapsible via `Tab`. Each row shows the title, the
//! status, the deliverable and cost when the run reached a record, and the
//! record's answer.

use super::{theme, App, Click, SessionRow};
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
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    let sub = Line::from(Span::styled(
        "deliberation workstation",
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
            format!(" Sessions · {} ", sessions.len()),
            Style::default().fg(theme::MUTED),
        ));

    if sessions.is_empty() {
        let para = Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(
                "  No sessions yet.",
                Style::default().fg(theme::DIM),
            )),
            Line::from(Span::styled(
                "  Every council you convene",
                Style::default().fg(theme::DIM),
            )),
            Line::from(Span::styled(
                "  is listed here, shared",
                Style::default().fg(theme::DIM),
            )),
            Line::from(Span::styled(
                "  with the desktop app.",
                Style::default().fg(theme::DIM),
            )),
        ])
        .block(block);
        f.render_widget(para, area);
        return;
    }

    // Keep the selection in view: three rows per item.
    let inner_h = area.height.saturating_sub(2) as usize;
    let per_item = 3;
    let visible = (inner_h / per_item).max(1);
    let first = app.sidebar_sel.saturating_sub(visible.saturating_sub(1));
    let width = area.width.saturating_sub(4) as usize;
    let items: Vec<ListItem> = sessions
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .map(|(i, s)| session_item(s, i == app.sidebar_sel, width))
        .collect();
    // A click on an item opens it, as Enter does.
    for k in 0..items.len() {
        let y = area.y + 1 + (k * per_item) as u16;
        let height = (per_item as u16).min((area.y + area.height).saturating_sub(y + 1));
        app.hit(
            Rect {
                x: area.x + 1,
                y,
                width: area.width.saturating_sub(2),
                height,
            },
            Click::Session(first + k),
        );
    }
    f.render_widget(List::new(items).block(block), area);
}

fn session_item(s: &SessionRow, selected: bool, width: usize) -> ListItem<'static> {
    let (status_label, status_color) = status_of(s);
    let title_style = if selected {
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD)
    } else if s.archived {
        Style::default().fg(theme::DIM)
    } else {
        Style::default().fg(theme::TEXT)
    };

    let marker = if selected { "▸ " } else { "  " };
    let title_line = Line::from(vec![
        Span::styled(marker, Style::default().fg(theme::GOLD)),
        Span::styled(
            theme::truncate(&s.title, width.saturating_sub(2)),
            title_style,
        ),
    ]);

    let mut meta = vec![
        Span::styled("  ", Style::default()),
        Span::styled(status_label, Style::default().fg(status_color)),
    ];
    if let Some(d) = &s.deliverable {
        meta.push(Span::styled(
            format!(" · {d}"),
            Style::default().fg(theme::MUTED),
        ));
    } else if s.version == 1 {
        meta.push(Span::styled(
            format!(" · {} turns", s.turns),
            Style::default().fg(theme::DIM),
        ));
    }
    if s.total_usd > 0.0 {
        meta.push(Span::styled(
            format!(" · ${:.2}", s.total_usd),
            Style::default().fg(theme::DIM),
        ));
    }
    if s.archived {
        meta.push(Span::styled(" · archived", Style::default().fg(theme::DIM)));
    }

    let detail = if s.answer.trim().is_empty() {
        match s.origin.as_str() {
            "app" => "from the desktop app".to_string(),
            _ => "no record".to_string(),
        }
    } else {
        s.answer.replace('\n', " ")
    };
    let detail_line = Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(
            theme::truncate(&detail, width.saturating_sub(2)),
            Style::default()
                .fg(theme::DIM)
                .add_modifier(Modifier::ITALIC),
        ),
    ]);

    ListItem::new(vec![title_line, Line::from(meta), detail_line])
}

fn status_of(s: &SessionRow) -> (&'static str, Color) {
    match (s.stopped_early.as_deref(), s.status.as_str()) {
        (Some("cancelled"), _) => ("Cancelled", theme::MUTED),
        (Some("failed"), _) | (_, "failed") => ("Failed", theme::ROSE),
        (Some(_), _) | (_, "stopped") => ("Stopped", theme::ROSE),
        (_, "completed") => ("Completed", theme::EMERALD),
        (_, "running") | (_, "active") => ("Running", theme::GOLD),
        (_, "paused") => ("Paused", theme::MUTED),
        _ => ("Draft", theme::DIM),
    }
}
