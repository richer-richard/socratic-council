//! Home view — the animated council mark, a topic composer, and the roster.

use super::{theme, App};
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
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
        Constraint::Length(4), // roster
        Constraint::Length(1), // footer
    ])
    .split(area);

    render_mark(f, rows[0], app);
    render_wordmark(f, rows[1]);
    render_composer(f, rows[2], app);
    render_roster(f, rows[3], app);
    render_footer(f, rows[4]);
}

/// The council mark — eight provider-colored nodes on a slowly rotating ring,
/// joined by a faint complete-graph web; configured providers glow.
fn render_mark(f: &mut Frame, area: Rect, app: &App) {
    let frame = app.frame;
    // Aspect-correct bounds: terminal cells are ~2:1, so widen x.
    let canvas = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds([-1.7, 1.7])
        .y_bounds([-1.1, 1.1])
        .paint(move |ctx| {
            let phase = (frame as f64) * 0.012;
            let pts = theme::ring_positions(0.82, phase);

            // Faint web between every pair of nodes.
            for i in 0..8 {
                for j in (i + 1)..8 {
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

            // Nodes: glow when the provider has a key, dim otherwise.
            let pulse = 1.0 + 0.22 * ((frame as f64) * 0.07).sin();
            for (i, agent) in theme::AGENTS.iter().enumerate() {
                let (x, y) = pts[i];
                let configured = app.ctx.config.is_configured(agent.provider);
                let color = if configured { agent.color } else { theme::DIM };
                if configured {
                    ctx.draw(&Circle { x, y, radius: 0.16 * pulse, color });
                }
                // Filled-looking node from concentric discs.
                for r in [0.02, 0.05, 0.08] {
                    ctx.draw(&Circle { x, y, radius: r, color });
                }
                ctx.draw(&Points { coords: &[(x, y)], color });
            }
        });
    f.render_widget(canvas, area);
}

fn render_wordmark(f: &mut Frame, area: Rect) {
    let title = Line::from(Span::styled(
        "S O C R A T I C   C O U N C I L",
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
    ))
    .alignment(Alignment::Center);
    let tagline = Line::from(Span::styled(
        "eight minds, one table — pressure-test any idea",
        Style::default().fg(theme::MUTED).add_modifier(Modifier::ITALIC),
    ))
    .alignment(Alignment::Center);
    f.render_widget(Paragraph::new(vec![title, tagline]), area);
}

fn render_composer(f: &mut Frame, area: Rect, app: &App) {
    let caret_on = app.frame % 16 < 8;
    let body: Line = if app.composer.is_empty() {
        let mut spans = vec![Span::styled(
            "What should the council pressure-test? ",
            Style::default().fg(theme::DIM),
        )];
        if caret_on {
            spans.push(Span::styled("▌", Style::default().fg(theme::GOLD)));
        }
        Line::from(spans)
    } else {
        let mut spans =
            vec![Span::styled(app.composer.clone(), Style::default().fg(theme::TEXT))];
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
            " Convene a debate ",
            Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
        ));
    f.render_widget(Paragraph::new(body).block(block).wrap(Wrap { trim: false }), area);
}

fn render_roster(f: &mut Frame, area: Rect, app: &App) {
    let configured = app.configured_count();
    let mut spans: Vec<Span> = Vec::new();
    for agent in theme::AGENTS.iter() {
        let on = app.ctx.config.is_configured(agent.provider);
        let dot_style = if on {
            Style::default().fg(agent.color)
        } else {
            Style::default().fg(theme::DIM)
        };
        let name_style = if on {
            Style::default().fg(theme::TEXT)
        } else {
            Style::default().fg(theme::DIM)
        };
        spans.push(Span::styled(if on { "● " } else { "○ " }, dot_style));
        spans.push(Span::styled(format!("{} ", agent.name), name_style));
        spans.push(Span::styled(
            format!("{}  ", agent.provider.slug()),
            Style::default().fg(theme::MUTED),
        ));
    }
    let title = format!(" Council · {configured}/8 keys shared ");
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::DIM))
        .title(Span::styled(title, Style::default().fg(theme::MUTED)));
    f.render_widget(
        Paragraph::new(Line::from(spans)).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

fn render_footer(f: &mut Frame, area: Rect) {
    let hint = Line::from(vec![
        key("Enter"),
        Span::styled(" convene   ", Style::default().fg(theme::MUTED)),
        key("Tab"),
        Span::styled(" history   ", Style::default().fg(theme::MUTED)),
        key("^P"),
        Span::styled(" settings   ", Style::default().fg(theme::MUTED)),
        key("Esc"),
        Span::styled(" quit", Style::default().fg(theme::MUTED)),
    ])
    .alignment(Alignment::Center);
    f.render_widget(Paragraph::new(hint), area);
}

fn key(label: &str) -> Span<'_> {
    Span::styled(label, Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD))
}
