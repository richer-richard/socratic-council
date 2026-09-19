//! Home view — the council mark, a topic composer, the council preset and
//! the deliverable, and the roster strip showing which seats will convene.

use super::{deliverable_label, theme, App, DELIVERABLE_CHOICES};
use crate::config::Preset;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::Marker;
use ratatui::text::{Line, Span};
use ratatui::widgets::canvas::{Canvas, Circle, Line as CanvasLine, Points};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([
        Constraint::Min(8),    // hero (council mark)
        Constraint::Length(3), // wordmark + tagline
        Constraint::Length(3), // composer
        Constraint::Length(2), // preset + deliverable chips
        Constraint::Length(5), // roster
        Constraint::Length(1), // footer
    ])
    .split(area);

    render_mark(f, rows[0], app);
    render_wordmark(f, rows[1]);
    render_composer(f, rows[2], app);
    render_chips(f, rows[3], app);
    render_roster(f, rows[4], app);
    render_footer(f, rows[5]);
}

/// The council mark — the roster's seats on a slowly rotating ring, joined
/// by a faint complete-graph web; keyed seats glow.
fn render_mark(f: &mut Frame, area: Rect, app: &App) {
    let frame = app.frame;
    let roster = app.ctx.config.roster(&app.ctx.providers);
    let nodes: Vec<(Color, bool)> = if roster.seats.is_empty() {
        theme::AGENTS
            .iter()
            .map(|a| (a.color, app.ctx.config.is_configured(a.provider)))
            .collect()
    } else {
        roster
            .seats
            .iter()
            .map(|s| {
                (
                    theme::provider_color(s.provider),
                    app.ctx.config.is_configured(s.provider),
                )
            })
            .collect()
    };
    // Aspect-correct bounds: terminal cells are ~2:1, so widen x.
    let canvas = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds([-1.7, 1.7])
        .y_bounds([-1.1, 1.1])
        .paint(move |ctx| {
            let phase = (frame as f64) * 0.012;
            let pts = theme::ring_positions(nodes.len(), 0.82, phase);

            for i in 0..pts.len() {
                for j in (i + 1)..pts.len() {
                    ctx.draw(&CanvasLine {
                        x1: pts[i].0,
                        y1: pts[i].1,
                        x2: pts[j].0,
                        y2: pts[j].1,
                        color: theme::WEB,
                    });
                }
            }
            ctx.layer();

            let pulse = 1.0 + 0.22 * ((frame as f64) * 0.07).sin();
            for (i, (color, configured)) in nodes.iter().enumerate() {
                let (x, y) = pts[i];
                let color = if *configured { *color } else { theme::DIM };
                if *configured {
                    ctx.draw(&Circle {
                        x,
                        y,
                        radius: 0.16 * pulse,
                        color,
                    });
                }
                for r in [0.02, 0.05, 0.08] {
                    ctx.draw(&Circle {
                        x,
                        y,
                        radius: r,
                        color,
                    });
                }
                ctx.draw(&Points {
                    coords: &[(x, y)],
                    color,
                });
            }
        });
    f.render_widget(canvas, area);
}

fn render_wordmark(f: &mut Frame, area: Rect) {
    let title = Line::from(Span::styled(
        "S O C R A T I C   C O U N C I L",
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    ))
    .alignment(Alignment::Center);
    let tagline = Line::from(Span::styled(
        "a council of models deliberates your question and leaves a decision record",
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::ITALIC),
    ))
    .alignment(Alignment::Center);
    f.render_widget(Paragraph::new(vec![title, tagline]), area);
}

fn render_composer(f: &mut Frame, area: Rect, app: &App) {
    let caret_on = app.frame % 16 < 8;
    let body: Line = if app.composer.is_empty() {
        let mut spans = vec![Span::styled(
            "What should the council settle? ",
            Style::default().fg(theme::DIM),
        )];
        if caret_on {
            spans.push(Span::styled("▌", Style::default().fg(theme::GOLD)));
        }
        Line::from(spans)
    } else {
        let mut spans = vec![Span::styled(
            app.composer.clone(),
            Style::default().fg(theme::TEXT),
        )];
        spans.push(Span::styled(
            if caret_on { "▌" } else { " " },
            Style::default().fg(theme::GOLD),
        ));
        Line::from(spans)
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::GOLD))
        .title(Span::styled(
            " Convene the council ",
            Style::default()
                .fg(theme::GOLD)
                .add_modifier(Modifier::BOLD),
        ));
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        area,
    );
}

fn chip(label: String, on: bool) -> Span<'static> {
    Span::styled(
        format!(" {label} "),
        if on {
            Style::default()
                .fg(Color::Black)
                .bg(theme::GOLD)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        },
    )
}

/// `Council  Quick · 3  Standard · 4  Full   ·   Deliverable  auto decision …`
fn render_chips(f: &mut Frame, area: Rect, app: &App) {
    let keyed = app.convened_seats().seats.len();
    let mut council = vec![Span::styled(" Council ", Style::default().fg(theme::DIM))];
    for p in Preset::ALL {
        let label = match p.size() {
            Some(n) => format!("{} · {n}", p.label()),
            None => p.label().to_string(),
        };
        council.push(chip(label, p == app.launch.preset));
        council.push(Span::styled(" ", Style::default()));
    }
    council.push(Span::styled(
        format!(
            "→ {keyed} seat{} convene",
            if keyed == 1 { "" } else { "s" }
        ),
        Style::default().fg(theme::DIM),
    ));
    let mut deliverable = vec![Span::styled(
        " Deliverable ",
        Style::default().fg(theme::DIM),
    )];
    for d in DELIVERABLE_CHOICES {
        deliverable.push(chip(
            deliverable_label(d).to_string(),
            d == app.launch.deliverable,
        ));
        deliverable.push(Span::styled(" ", Style::default()));
    }
    f.render_widget(
        Paragraph::new(vec![Line::from(council), Line::from(deliverable)]),
        area,
    );
}

fn render_roster(f: &mut Frame, area: Rect, app: &App) {
    let roster = app.ctx.config.roster(&app.ctx.providers);
    let convened = app.convened_seats();
    let configured = app.configured_count();
    let mut spans: Vec<Span> = Vec::new();
    for seat in &roster.seats {
        let keyed = app.ctx.config.is_configured(seat.provider);
        let in_council = convened.seats.iter().any(|s| s.id == seat.id);
        let color = theme::provider_color(seat.provider);
        let dot = if in_council {
            "◆ "
        } else if keyed {
            "● "
        } else {
            "○ "
        };
        spans.push(Span::styled(
            dot,
            Style::default().fg(if keyed { color } else { theme::DIM }),
        ));
        spans.push(Span::styled(
            format!("{} ", seat.name),
            if in_council {
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD)
            } else if keyed {
                Style::default().fg(theme::TEXT)
            } else {
                Style::default().fg(theme::DIM)
            },
        ));
        spans.push(Span::styled(
            format!("{}:{}  ", seat.provider.slug(), seat.model.label()),
            Style::default().fg(theme::DIM),
        ));
    }
    let mut body: Vec<Line> = vec![Line::from(spans)];
    if configured == 0 {
        body.push(Line::from(Span::styled(
            "No keys yet — press ^P to add one in the terminal (no desktop app needed).",
            Style::default().fg(theme::GOLD),
        )));
    } else {
        body.push(Line::from(Span::styled(
            "◆ convenes with this preset   ● keyed   ○ no key   ·   edit the roster in Settings (^P)",
            Style::default().fg(theme::DIM),
        )));
    }
    let title = format!(" Roster · {configured}/{} keyed ", Provider::ALL.len());
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(title, Style::default().fg(theme::MUTED)));
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

use crate::types::Provider;

fn render_footer(f: &mut Frame, area: Rect) {
    let hint = Line::from(vec![
        key("Enter"),
        Span::styled(" convene   ", Style::default().fg(theme::MUTED)),
        key("←/→"),
        Span::styled(" council   ", Style::default().fg(theme::MUTED)),
        key("^D"),
        Span::styled(" deliverable   ", Style::default().fg(theme::MUTED)),
        key("Tab"),
        Span::styled(" sessions   ", Style::default().fg(theme::MUTED)),
        key("^P"),
        Span::styled(" settings   ", Style::default().fg(theme::MUTED)),
        key("Esc"),
        Span::styled(" quit", Style::default().fg(theme::MUTED)),
    ])
    .alignment(Alignment::Center);
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
