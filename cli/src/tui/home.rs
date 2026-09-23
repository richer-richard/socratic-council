//! Home, laid out like the desktop app's workstation: the council mark, the
//! composer and the launch options in the middle, and the Council Rack on the
//! right with the two chairs (moderator, utility) above the seats.
//!
//! On a narrow terminal the rack folds under the options as a compact grid,
//! and the mark shrinks first, since it is the one thing on the screen that
//! carries no information you cannot get elsewhere.

use super::{deliverable_label, theme, App, Click, DELIVERABLE_CHOICES};
use crate::config::Preset;
use crate::types::{ModelChoice, ModelRef, Provider, ReasoningTier};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
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
    render_footer(f, rows[1], app);

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
        // The folded rack is chairs and seats a row at a time; each row
        // opens Settings, where they are changed.
        let rows = center[4];
        for y in rows.y..rows.y + rows.height {
            app.hit(
                Rect {
                    y,
                    height: 1,
                    ..rows
                },
                settings_click(),
            );
        }
        f.render_widget(Paragraph::new(folded), center[4]);
    }
    // The command list opens over the mark, right above the composer.
    let room = Rect {
        height: center[2].y.saturating_sub(center[0].y),
        ..center[0]
    };
    super::render_slash_menu(f, app, center[2], room);
}

/// The council mark: the roster's seats on a slowly turning ring, joined by a
/// faint web between every pair, keyed seats glowing with a slow pulse. The
/// height spans the same units whatever the size, and the width follows the
/// area's shape, so braille's square dots keep the ring round.
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
    const HALF_H: f64 = 1.1;
    let half_w = HALF_H * (area.width as f64 * 2.0) / (area.height as f64 * 4.0);
    // On an area taller than it is wide the ring shrinks to fit across.
    let ring = 0.82 * (half_w / HALF_H).min(1.0);
    let turn = (app.frame % TURN_FRAMES) as f64 / TURN_FRAMES as f64 * std::f64::consts::TAU;
    // Six slow breaths a turn, so a full turn lands exactly where it began.
    let pulse = 1.0 + 0.22 * (turn * 6.0).sin();

    let canvas = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds([-half_w, half_w])
        .y_bounds([-HALF_H, HALF_H])
        .paint(move |ctx| {
            let n = nodes.len().max(1);
            // Seat one at the top, the rest clockwise, the ring turning
            // clockwise with the clock.
            let pts: Vec<(f64, f64)> = (0..n)
                .map(|i| {
                    let a = std::f64::consts::FRAC_PI_2
                        - (i as f64) * std::f64::consts::TAU / n as f64
                        - turn;
                    (ring * a.cos(), ring * a.sin())
                })
                .collect();
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
            for (&(x, y), (color, keyed)) in pts.iter().zip(nodes.iter()) {
                let color = if *keyed { *color } else { theme::DIM };
                if *keyed {
                    ctx.draw(&Circle {
                        x,
                        y,
                        radius: 0.16 * pulse,
                        color,
                    });
                }
                // A node reads as filled from three rings and a centre dot.
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
        // The caret sits where the first letter will go, at the start, and
        // the placeholder keeps its place while it blinks.
        Line::from(vec![
            Span::styled(
                if caret_on { "▌" } else { " " },
                Style::default().fg(theme::GOLD),
            ),
            Span::styled(
                "What should the council pressure-test next?",
                Style::default().fg(theme::DIM),
            ),
        ])
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
    // Each chip is clickable where it is drawn: the label column, then the
    // chips with a space after each.
    let mut x = area.x + 13;
    for p in Preset::ALL {
        let label = match p.size() {
            Some(n) => format!("{} · {n}", p.label()),
            None => p.label().to_string(),
        };
        let w = label.width() as u16 + 2;
        app.hit(
            Rect {
                x,
                y: area.y + 1,
                width: w,
                height: 1,
            },
            Click::Preset(p),
        );
        x += w + 1;
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
    let mut x = area.x + 13;
    for d in DELIVERABLE_CHOICES {
        let w = deliverable_label(d).width() as u16 + 2;
        app.hit(
            Rect {
                x,
                y: area.y + 2,
                width: w,
                height: 1,
            },
            Click::Deliverable(d),
        );
        x += w + 1;
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

/// A click on the rack opens Settings, where the chairs and seats change.
fn settings_click() -> Click {
    Click::Key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL))
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
    // The chairs sit on rows 2 and 3 and the seats from row 5: each row is
    // clickable on its own, so the pointer lights up one at a time.
    let row_hit = |i: usize| {
        let y = inner.y + i as u16;
        if y < inner.y + inner.height {
            app.hit(
                Rect {
                    x: inner.x,
                    y,
                    width: inner.width,
                    height: 1,
                },
                settings_click(),
            );
        }
    };
    row_hit(2);
    row_hit(3);
    for i in 0..roster.seats.len() {
        row_hit(5 + i);
    }
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

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let hints = [
        ("Enter", "convene"),
        ("/", "commands"),
        ("^P", "settings"),
        ("Tab", "sessions"),
        ("^C ^C", "quit"),
        ("←/→", "council"),
        ("^D", "deliverable"),
    ];
    let (line, spots) = theme::hint_bar_spots(&hints, area.width as usize);
    // Centred the way the paragraph centres it.
    let x = area.x + area.width.saturating_sub(line.width() as u16) / 2;
    app.footer_hits(x, area.y, &hints, &spots);
    f.render_widget(Paragraph::new(line).alignment(Alignment::Center), area);
}
