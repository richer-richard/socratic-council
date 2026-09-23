//! Home, laid out like the desktop app's workstation: the council mark, the
//! composer and the launch options in the middle, and the Council Rack on the
//! right with the two chairs (moderator, utility) above the seats.
//!
//! On a narrow terminal the rack folds under the options as a compact grid,
//! and the mark shrinks first, since it is the one thing on the screen that
//! carries no information you cannot get elsewhere.

use super::{deliverable_label, theme, App, DELIVERABLE_CHOICES};
use crate::config::Preset;
use crate::types::{ModelChoice, ModelRef, Provider, ReasoningTier};
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::Marker;
use ratatui::text::{Line, Span};
use ratatui::widgets::canvas::{Canvas, Circle, Line as CanvasLine, Points};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

/// Frames for one full turn of the council mark: about 36 seconds at the
/// 70 ms frame, the same pace as the desktop's hero.
pub(super) const TURN_FRAMES: u64 = 512;

/// Wide enough for the rack to take its own column.
const RACK_AT: u16 = 110;
const RACK_W: u16 = 36;

pub fn render(f: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(area);
    render_footer(f, rows[1]);

    let wide = area.width >= RACK_AT;
    let cols = if wide {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(RACK_W)]).split(rows[0])
    } else {
        Layout::horizontal([Constraint::Percentage(100)]).split(rows[0])
    };
    let folded = if wide {
        Vec::new()
    } else {
        folded_rack_lines(app, cols[0].width.saturating_sub(4) as usize)
    };
    let rack_rows = folded.len() as u16;
    let center = Layout::vertical([
        Constraint::Min(4),            // the mark takes what is left
        Constraint::Length(3),         // wordmark + tagline
        Constraint::Length(3),         // composer
        Constraint::Length(3),         // council and deliverable options
        Constraint::Length(rack_rows), // the rack, folded, when narrow
    ])
    .split(Rect {
        x: cols[0].x + 2,
        width: cols[0].width.saturating_sub(4),
        ..cols[0]
    });

    render_mark(f, center[0], app);
    render_wordmark(f, center[1]);
    render_composer(f, center[2], app);
    render_chips(f, center[3], app);
    if wide {
        render_rack(f, cols[1], app);
    } else {
        f.render_widget(Paragraph::new(folded), center[4]);
    }
}

/// The council mark as the desktop draws its hero: seats on an inner ring as
/// solid dots in their provider colour with a soft halo, spokes out to a
/// faint outer ring of satellites, turning slowly clockwise. Drawn in braille
/// dots, which are square, so the rings come out round at any terminal size.
fn render_mark(f: &mut Frame, area: Rect, app: &App) {
    // A mark squeezed into a few rows is a knot of overlapping dots. Below
    // this it is left out: the wordmark underneath carries the identity.
    if area.height < 10 {
        return;
    }
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
    // Keep the mark modest: it is a mark, not the page.
    let rows = area.height.saturating_sub(1).min(26);
    let cols = (rows as u32 * 4 / 2 * 12 / 10) as u16; // ring fits with a little air
    let cols = cols.min(area.width);
    let rect = Rect {
        x: area.x + (area.width.saturating_sub(cols)) / 2,
        y: area.y + (area.height.saturating_sub(rows)) / 2,
        width: cols,
        height: rows,
    };
    let (dw, dh) = (cols as f64 * 2.0, rows as f64 * 4.0);
    let (cx, cy) = (dw / 2.0, dh / 2.0);
    let outer = (dw.min(dh) / 2.0) - 3.0;
    let inner = outer * 0.56;
    let turn = (app.frame % TURN_FRAMES) as f64 / TURN_FRAMES as f64 * std::f64::consts::TAU;

    let canvas = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds([0.0, dw])
        .y_bounds([0.0, dh])
        .paint(move |ctx| {
            let n = nodes.len().max(1);
            let at = |r: f64, i: usize| {
                let a = -std::f64::consts::FRAC_PI_2
                    + (i as f64) * std::f64::consts::TAU / n as f64
                    + turn;
                (cx + r * a.cos(), cy - r * a.sin())
            };
            // The faint structure first: two rings and the spokes.
            for r in [inner, outer] {
                ctx.draw(&Circle {
                    x: cx,
                    y: cy,
                    radius: r,
                    color: theme::WEB,
                });
            }
            for i in 0..n {
                let (x1, y1) = at(inner, i);
                let (x2, y2) = at(outer, i);
                ctx.draw(&CanvasLine {
                    x1,
                    y1,
                    x2,
                    y2,
                    color: theme::WEB,
                });
            }
            ctx.layer();
            for (i, (color, keyed)) in nodes.iter().enumerate() {
                let (x, y) = at(inner, i);
                let (ox, oy) = at(outer, i);
                let hue = if *keyed { *color } else { theme::DIM };
                // A satellite: a small dim dot of the seat's colour.
                ctx.draw(&Points {
                    coords: &[
                        (ox, oy),
                        (ox + 1.0, oy),
                        (ox, oy + 1.0),
                        (ox + 1.0, oy + 1.0),
                    ],
                    color: theme::blend(theme::BG, hue, 0.55),
                });
                // The node: a solid disc, larger than a satellite. A seat with
                // no key keeps its place on the ring but not its colour.
                // Sized to the gap between neighbours on the ring, so a
                // small mark gets small dots instead of overlapping ones.
                let gap = std::f64::consts::TAU * inner / n as f64;
                let full = (gap * 0.26).clamp(1.0, 4.0).round() as i32;
                let r = if *keyed { full } else { (full - 1).max(1) };
                let mut disc = Vec::new();
                for dx in -r..=r {
                    for dy in -r..=r {
                        if dx * dx + dy * dy <= r * r + 1 {
                            disc.push((x + dx as f64, y + dy as f64));
                        }
                    }
                }
                ctx.draw(&Points {
                    coords: &disc,
                    color: hue,
                });
            }
        });
    f.render_widget(canvas, rect);
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
            "What should the council pressure-test next? ",
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
    let mut council = vec![Span::styled(
        "COUNCIL      ",
        Style::default().fg(theme::DIM),
    )];
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
        "DELIVERABLE  ",
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
        Paragraph::new(vec![
            Line::from(""),
            Line::from(council),
            Line::from(deliverable),
        ]),
        area,
    );
}

/// A slot's model as the desktop names it: the auto choices by name, since
/// the engine resolves them per run and a pinned id here would go stale.
fn slot_model(model: &ModelChoice) -> String {
    match model {
        ModelChoice::Auto(ReasoningTier::High) => "Auto".into(),
        ModelChoice::Auto(ReasoningTier::Medium) => "Auto, balanced".into(),
        ModelChoice::Auto(ReasoningTier::Low) => "Auto, fast".into(),
        ModelChoice::Id(id) => id.clone(),
    }
}

fn chairs(app: &App) -> [(&'static str, ModelRef); 2] {
    [
        ("Moderator", app.ctx.config.moderator_ref()),
        ("Utility", app.ctx.config.utility_ref()),
    ]
}

/// The Council Rack in its own column: the two chairs nobody sits in, a rule,
/// then every seat with its model. The chairs were invisible before, which
/// meant the only way to find them was to already know they lived in Settings.
fn render_rack(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::default().fg(theme::DIM));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let inner = Rect {
        x: inner.x + 2,
        width: inner.width.saturating_sub(3),
        y: inner.y + 1,
        height: inner.height.saturating_sub(1),
    };
    let w = inner.width as usize;

    let mut lines = vec![
        Line::from(Span::styled(
            "COUNCIL RACK",
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    for (label, slot) in chairs(app) {
        let hue = theme::provider_color(slot.provider);
        lines.push(Line::from(vec![
            Span::styled("◆ ", Style::default().fg(hue)),
            Span::styled(
                format!("{label:<11}"),
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                theme::truncate(
                    &format!("{} · {}", slot.provider.slug(), slot_model(&slot.model)),
                    w.saturating_sub(13),
                ),
                Style::default().fg(theme::DIM),
            ),
        ]));
    }
    lines.push(Line::from(Span::styled(
        "─".repeat(w),
        Style::default().fg(theme::WEB),
    )));

    let roster = app.ctx.config.roster(&app.ctx.providers);
    let convened = app.convened_seats();
    for seat in &roster.seats {
        let keyed = app.ctx.config.is_configured(seat.provider);
        let sitting = convened.seats.iter().any(|s| s.id == seat.id);
        let hue = theme::provider_color(seat.provider);
        lines.push(Line::from(vec![
            Span::styled(
                if sitting {
                    "● "
                } else if keyed {
                    "○ "
                } else {
                    "· "
                },
                Style::default().fg(if keyed { hue } else { theme::DIM }),
            ),
            Span::styled(
                format!("{:<11}", theme::truncate(&seat.name, 10)),
                if sitting {
                    Style::default().fg(hue).add_modifier(Modifier::BOLD)
                } else if keyed {
                    Style::default().fg(theme::TEXT)
                } else {
                    Style::default().fg(theme::DIM)
                },
            ),
            Span::styled(
                theme::truncate(
                    &format!("{} · {}", seat.provider.slug(), seat.model.label()),
                    w.saturating_sub(13),
                ),
                Style::default().fg(theme::DIM),
            ),
        ]));
    }
    lines.push(Line::from(""));
    let configured = app.configured_count();
    lines.push(Line::from(vec![
        Span::styled(
            format!("{configured}/{} keyed", Provider::ALL.len()),
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(
            format!(" · {} sit", convened.seats.len()),
            Style::default().fg(theme::DIM),
        ),
    ]));
    if configured == 0 {
        lines.push(Line::from(""));
        lines.extend(theme::hanging(
            vec![],
            "No keys yet. Press ^P to add one here, no desktop app needed.",
            Style::default().fg(theme::GOLD),
            w,
        ));
    } else {
        lines.push(Line::from(Span::styled(
            "^P to change a chair or a seat",
            Style::default().fg(theme::DIM),
        )));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

/// The rack on a narrow terminal: the chairs on one row, the seats in as many
/// columns as fit, each cell a fixed width so nothing wraps mid-seat, then the
/// count, and how to add a key when there is none. A long roster stops after
/// a few rows and says how many seats it left out.
fn folded_rack_lines(app: &App, width: usize) -> Vec<Line<'static>> {
    const SEAT_ROWS: usize = 3;
    let mut lines = Vec::new();
    let mut chair_spans = Vec::new();
    for (label, slot) in chairs(app) {
        chair_spans.push(Span::styled(
            "◆ ",
            Style::default().fg(theme::provider_color(slot.provider)),
        ));
        chair_spans.push(Span::styled(
            format!("{label} "),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ));
        chair_spans.push(Span::styled(
            format!("{}   ", slot_model(&slot.model)),
            Style::default().fg(theme::DIM),
        ));
    }
    lines.push(Line::from(chair_spans));
    let roster = app.ctx.config.roster(&app.ctx.providers);
    let convened = app.convened_seats();
    let cell = roster
        .seats
        .iter()
        .map(|s| s.name.width() + 4)
        .max()
        .unwrap_or(10)
        .max(12);
    let per_row = (width / cell).max(1);
    let rows: Vec<_> = roster.seats.chunks(per_row).collect();
    // When the roster runs long, the last row it has room for says so.
    let shown = if rows.len() > SEAT_ROWS {
        SEAT_ROWS - 1
    } else {
        rows.len()
    };
    for chunk in &rows[..shown] {
        let mut spans = Vec::new();
        for seat in *chunk {
            let keyed = app.ctx.config.is_configured(seat.provider);
            let sitting = convened.seats.iter().any(|s| s.id == seat.id);
            let hue = theme::provider_color(seat.provider);
            spans.push(Span::styled(
                if sitting {
                    "● "
                } else if keyed {
                    "○ "
                } else {
                    "· "
                },
                Style::default().fg(if keyed { hue } else { theme::DIM }),
            ));
            spans.push(Span::styled(
                format!("{:<w$}", seat.name, w = cell - 2),
                if sitting {
                    Style::default().fg(hue).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::MUTED)
                },
            ));
        }
        lines.push(Line::from(spans));
    }
    let left_out: usize = rows[shown..].iter().map(|c| c.len()).sum();
    if left_out > 0 {
        lines.push(Line::from(Span::styled(
            format!("  and {left_out} more seats, all of them in Settings (^P)"),
            Style::default().fg(theme::DIM),
        )));
    }
    let configured = app.configured_count();
    lines.push(Line::from(vec![
        Span::styled(
            format!("{configured}/{} keyed", Provider::ALL.len()),
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(
            format!(" · {} sit", convened.seats.len()),
            Style::default().fg(theme::DIM),
        ),
    ]));
    if configured == 0 {
        lines.extend(theme::hanging(
            vec![],
            "No keys yet. Press ^P to add one here, no desktop app needed.",
            Style::default().fg(theme::GOLD),
            width,
        ));
    }
    theme::fit(lines, width)
}

fn render_footer(f: &mut Frame, area: Rect) {
    let hints = [
        ("Enter", "convene"),
        ("^P", "settings"),
        ("Tab", "sessions"),
        ("Esc", "quit"),
        ("←/→", "council"),
        ("^D", "deliverable"),
    ];
    f.render_widget(
        Paragraph::new(theme::hint_bar(&hints, area.width as usize)).alignment(Alignment::Center),
        area,
    );
}
