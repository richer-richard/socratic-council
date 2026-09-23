//! The Session screen, laid out like the desktop app's two session pages.
//!
//! **Summary** is the report: the decision record, how the debate went, and
//! the analysis panel (score matrix, vote, critique graph, argument map).
//! **Transcript** is every round and seat turn, with the thinking and tool
//! calls behind them. `t` switches between them. A live run opens on the
//! transcript, since there is nothing to summarise yet, and turns to the
//! summary once the record lands, unless you have picked a page yourself.
//!
//! The header carries the topic, the status and the spend; a rail on the
//! right keeps the plan, board, convergence, cost and seats. The main column
//! has no frame of its own: the terminal edge already frames it, and a border
//! there would be one more box around content that is already bounded.

use super::analysis::{self, AnalysisView};
use super::{
    find_drawn, footer_hits, push_hit, theme, App, Click, Hit, SeatCard, SessionPage,
    SessionScreen, SideTab,
};
use crate::deliberation::{Board, Convergence, DecisionRecord, Plan, Recommend, SeatRole};
use crate::store::StoredMessage;
use crate::text::sanitize_terminal as clean;
use crate::tui::view::{RoundView, SeatTurn, SessionView};
use crate::types::CostSnapshot;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use std::cell::RefCell;
use std::collections::BTreeMap;
use unicode_width::UnicodeWidthStr;

/// Below this the screen says so instead of drawing something unreadable.
/// Small enough for an 80-column terminal with the sessions sidebar open.
const MIN_W: u16 = 40;
const MIN_H: u16 = 14;
/// The rail only earns its column when the main one keeps a readable measure.
const RAIL_AT: u16 = 118;
/// The reading column is no wider than this, however wide the terminal, and
/// sits centred in the space it has: a paragraph set across 200 columns is not
/// a paragraph anyone reads.
const MEASURE: usize = 100;

pub fn render(f: &mut Frame, area: Rect, app: &mut App) {
    let frame = app.frame;
    let cmdline = app.cmdline.clone();
    let hits = &app.hits;
    let regions = &app.regions;
    let Some(s) = app.session.as_mut() else {
        return;
    };
    if area.width < MIN_W || area.height < MIN_H {
        let msg = format!("Terminal too small. The session needs {MIN_W}×{MIN_H}.");
        f.render_widget(
            Paragraph::new(msg)
                .style(Style::default().fg(theme::MUTED))
                .alignment(Alignment::Center),
            Rect {
                y: area.y + area.height / 2,
                height: 1,
                ..area
            },
        );
        return;
    }
    let rows = Layout::vertical([
        Constraint::Length(3), // header: topic, page tabs, rule
        Constraint::Min(0),    // body
        Constraint::Length(1), // footer
    ])
    .split(area);

    let page = s.page();
    render_header(f, rows[0], s, page, frame, hits);

    let wide = rows[1].width >= RAIL_AT;
    let body = if wide {
        Layout::horizontal([Constraint::Min(0), Constraint::Length(46)]).split(rows[1])
    } else {
        Layout::horizontal([Constraint::Percentage(100)]).split(rows[1])
    };
    // The reading column and the rail are text a drag can select, each on
    // its own and no wider than its text.
    let text = render_main(f, body[0], s, page, frame, hits);
    regions.borrow_mut().push(text);
    if wide {
        let rail = render_side(f, body[1], s, frame, hits);
        regions.borrow_mut().push(rail);
    }
    let asking = s.view.pending_question.is_some() || s.view.pending_approval.is_some();
    match cmdline.as_deref().filter(|_| !asking) {
        Some(typed) => render_cmdline(f, rows[2], typed, frame),
        None => render_footer(f, rows[2], s, page, hits),
    }

    if let Some(q) = s.view.pending_question.clone() {
        let rect = render_question(f, area, &q.question, &s.answer, frame);
        push_hit(hits, rect, Click::Nothing);
    } else if let Some(a) = s.view.pending_approval.clone() {
        let who = s
            .seat(&a.seat_id)
            .map(|c| c.name.clone())
            .unwrap_or(a.seat_id.clone());
        let rect = render_approval(f, area, &who, &a.call.name, &a.call.arguments.to_string());
        push_hit(hits, rect, Click::Nothing);
        for (needle, key) in [("y allow", 'y'), ("n deny", 'n')] {
            if let Some(at) = find_drawn(f.buffer_mut(), rect, needle) {
                push_hit(
                    hits,
                    at,
                    Click::Key(crossterm::event::KeyEvent::new(
                        crossterm::event::KeyCode::Char(key),
                        crossterm::event::KeyModifiers::NONE,
                    )),
                );
            }
        }
    }
    if cmdline.is_some() && !asking {
        // The list sits over the body, right above the command line.
        super::render_slash_menu(f, app, rows[2], rows[1]);
    }
}

/// The command line `/` opens, in place of the footer.
fn render_cmdline(f: &mut Frame, area: Rect, typed: &str, frame: u64) {
    let caret_on = frame % 16 < 8;
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::raw(" "),
            Span::styled(clean(typed), Style::default().fg(theme::TEXT)),
            Span::styled(
                if caret_on { "▌" } else { " " },
                Style::default().fg(theme::GOLD),
            ),
            Span::styled("   Esc closes", Style::default().fg(theme::DIM)),
        ])),
        area,
    );
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

fn render_header(
    f: &mut Frame,
    area: Rect,
    s: &SessionScreen,
    page: SessionPage,
    frame: u64,
    hits: &RefCell<Vec<Hit>>,
) {
    let live = s.is_live();
    let rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(area);

    // Row one: the topic on the left, the facts on the right.
    let (status, status_color) = s.status();
    let dot = if live && frame % 12 >= 6 {
        "◉"
    } else {
        "●"
    };
    let status_spans = vec![
        Span::styled(format!("{dot} "), Style::default().fg(status_color)),
        Span::styled(
            status,
            Style::default()
                .fg(status_color)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    let deliverable = s.view.deliverable().map(|d| {
        vec![Span::styled(
            format!("   {}", d.label()),
            Style::default().fg(theme::MUTED),
        )]
    });
    let spend = s.view.cost.as_ref().map(|c| {
        let approx = if c.all_priced { "" } else { "≥" };
        vec![Span::styled(
            format!("   {approx}{}", theme::usd(c.total_usd)),
            Style::default()
                .fg(if live || c.note.is_some() {
                    theme::GOLD
                } else {
                    theme::TEXT
                })
                .add_modifier(Modifier::BOLD),
        )]
    });
    let estimate = match (&s.view.estimate, live) {
        (Some(e), true) => Some(vec![Span::styled(
            format!(" of {}–{}", theme::usd(e.usd_low), theme::usd(e.usd_high)),
            Style::default().fg(theme::DIM),
        )]),
        (Some(e), false) => Some(vec![Span::styled(
            format!(" · {} calls", e.calls),
            Style::default().fg(theme::DIM),
        )]),
        _ => None,
    };
    // The topic keeps some room: on a narrow terminal the facts give way
    // first, the estimate, then the deliverable, then the spend. The status
    // always stays.
    let width_of = |g: &Option<Vec<Span>>| -> usize {
        g.iter().flatten().map(|s| s.content.width()).sum::<usize>()
    };
    let room = (area.width as usize).saturating_sub(24);
    let (mut deliverable, mut spend, mut estimate) = (deliverable, spend, estimate);
    let status_w: usize = status_spans
        .iter()
        .map(|s| s.content.width())
        .sum::<usize>()
        + 1;
    let total = |d: &Option<Vec<Span>>, sp: &Option<Vec<Span>>, e: &Option<Vec<Span>>| {
        status_w + width_of(d) + width_of(sp) + width_of(e)
    };
    if total(&deliverable, &spend, &estimate) > room {
        estimate = None;
    }
    if total(&deliverable, &spend, &estimate) > room {
        deliverable = None;
    }
    if total(&deliverable, &spend, &estimate) > room {
        spend = None;
    }
    let mut facts = status_spans;
    for group in [deliverable, spend, estimate].into_iter().flatten() {
        facts.extend(group);
    }
    facts.push(Span::raw(" "));
    let facts_w: usize = facts.iter().map(|s| s.content.width()).sum();
    let top =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(facts_w as u16)]).split(rows[0]);
    let topic_room = top[0].width.saturating_sub(4) as usize;
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" ◆ ", Style::default().fg(theme::GOLD)),
            Span::styled(
                theme::truncate(&clean(&s.topic), topic_room),
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
        ])),
        top[0],
    );
    f.render_widget(
        Paragraph::new(Line::from(facts)).alignment(Alignment::Right),
        top[1],
    );

    // Row two: which page, and where the run is.
    let mut tabs = vec![Span::raw(" ")];
    let mut x = rows[1].x + 1;
    for p in [SessionPage::Summary, SessionPage::Transcript] {
        let on = p == page;
        let w = p.label().width() as u16 + 2;
        push_hit(
            hits,
            Rect {
                x,
                y: rows[1].y,
                width: w,
                height: 1,
            },
            Click::Page(p),
        );
        x += w + 1;
        tabs.push(Span::styled(
            format!(" {} ", p.label()),
            if on {
                Style::default()
                    .fg(theme::INK_ON_GOLD)
                    .bg(theme::GOLD)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ));
        tabs.push(Span::raw(" "));
    }
    tabs.push(Span::styled(" t", Style::default().fg(theme::DIM)));
    let mut trail = Vec::new();
    if live && !s.view.phases.is_empty() {
        let n = s.view.phases.len();
        // The last few phases only: the trail is a sense of progress, not
        // a log, and a long one would crowd the tabs on a narrow terminal.
        for (i, p) in s.view.phases.iter().enumerate().skip(n.saturating_sub(4)) {
            let last = i + 1 == n;
            trail.push(Span::styled(
                p.clone(),
                if last {
                    Style::default()
                        .fg(theme::GOLD)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::DIM)
                },
            ));
            if !last {
                trail.push(Span::styled(" ▸ ", Style::default().fg(theme::WEB)));
            }
        }
        trail.push(Span::raw(" "));
    }
    let trail_w: usize = trail.iter().map(|s| s.content.width()).sum();
    let mid =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(trail_w as u16)]).split(rows[1]);
    f.render_widget(Paragraph::new(Line::from(tabs)), mid[0]);
    f.render_widget(
        Paragraph::new(Line::from(trail)).alignment(Alignment::Right),
        mid[1],
    );

    // Row three: a rule, gold while the council is sitting.
    f.render_widget(
        Paragraph::new(Span::styled(
            "─".repeat(rows[2].width as usize),
            Style::default().fg(if live { theme::GOLD } else { theme::WEB }),
        )),
        rows[2],
    );
}

fn render_footer(
    f: &mut Frame,
    area: Rect,
    s: &SessionScreen,
    page: SessionPage,
    hits: &RefCell<Vec<Hit>>,
) {
    // A handful of keys for the page you are on, cut to fit; `?` has the rest.
    let live = s.is_live();
    let mut hints: Vec<(&str, &str)> = Vec::new();
    hints.push(("Esc", if live { "stop" } else { "home" }));
    match page {
        SessionPage::Summary => {
            hints.push(("t", "transcript"));
            hints.push(("1-4", "analysis"));
            if s.ui.analysis == AnalysisView::Critique {
                hints.push(("[ ]", "seat"));
            }
            if !live {
                hints.push(("e", "export"));
            }
        }
        SessionPage::Transcript => {
            hints.push(("t", "summary"));
            hints.push(("T", "thinking"));
            hints.push(("g", "follow"));
        }
    }
    hints.push(("/", "commands"));
    hints.push(("?", "keys"));
    let (mut line, spots) = theme::hint_bar_spots(
        &hints,
        area.width.saturating_sub(if live { 14 } else { 0 }) as usize,
    );
    footer_hits(hits, area.x, area.y, &hints, &spots);
    if live {
        line.spans.push(Span::styled(
            "deliberating…",
            Style::default().fg(theme::GOLD),
        ));
    }
    f.render_widget(Paragraph::new(line), area);
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------

fn render_main(
    f: &mut Frame,
    area: Rect,
    s: &mut SessionScreen,
    page: SessionPage,
    frame: u64,
    hits: &RefCell<Vec<Hit>>,
) -> Rect {
    // Two columns of margin each side instead of a frame, and the reading
    // column centred in what is left once it reaches the measure.
    let room = area.width.saturating_sub(4);
    let measure = room.min(MEASURE as u16);
    let inner = Rect {
        x: area.x + 2 + (room - measure) / 2,
        y: area.y + 1,
        width: measure,
        height: area.height.saturating_sub(1),
    };
    let width = inner.width as usize;
    let lines = match page {
        SessionPage::Summary => summary_lines(s, width),
        SessionPage::Transcript => transcript_lines(s, width, frame),
    };

    // Every line is wrapped to `width` here, so the row count is the line
    // count and the scroll clamp reaches the last row exactly.
    let lines = theme::fit(lines, width);
    let total = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    let max_off = total.saturating_sub(inner.height);
    let scroll = if s.follow && page == SessionPage::Transcript {
        s.scroll = max_off;
        max_off
    } else {
        s.scroll = s.scroll.min(max_off);
        s.scroll
    };
    f.render_widget(Paragraph::new(lines).scroll((scroll, 0)), inner);

    // What the page drew that a click can act on, wherever the scroll put it.
    if page == SessionPage::Summary {
        for v in AnalysisView::ALL {
            let tab = format!("{} {}", v.glyph(), v.label());
            if let Some(at) = find_drawn(f.buffer_mut(), inner, &tab) {
                push_hit(hits, at, Click::Analysis(v));
            }
        }
        for link in [
            "Read the full transcript",
            "Follow the debate as it happens",
        ] {
            if let Some(at) = find_drawn(f.buffer_mut(), inner, link) {
                push_hit(hits, at, Click::Page(SessionPage::Transcript));
            }
        }
    }
    inner
}

/// A section heading: the label in the accent, then a hairline to the edge.
/// The terminal version of the desktop's section rules.
fn rule(label: &str, meta: &str, color: Color, width: usize) -> Line<'static> {
    let label = label.to_uppercase();
    let used = label.width() + 1 + if meta.is_empty() { 0 } else { meta.width() + 2 };
    let mut spans = vec![
        Span::styled(
            label,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            "─".repeat(width.saturating_sub(used)),
            Style::default().fg(theme::WEB),
        ),
    ];
    if !meta.is_empty() {
        spans.push(Span::styled(
            format!("  {meta}"),
            Style::default().fg(theme::DIM),
        ));
    }
    Line::from(spans)
}

/// Paragraphs of prose, wrapped to the measure with blank lines kept.
fn prose(text: &str, style: Style, width: usize, indent: usize) -> Vec<Line<'static>> {
    let room = width.min(MEASURE).saturating_sub(indent).max(12);
    let mut out = Vec::new();
    for para in clean(text).split('\n') {
        if para.trim().is_empty() {
            out.push(Line::from(""));
            continue;
        }
        for row in textwrap::wrap(para, room) {
            out.push(Line::from(vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(row.to_string(), style),
            ]));
        }
    }
    out
}

/// A labelled value: the label in its own column, the value wrapping under
/// itself rather than back to the margin.
fn field(label: &str, value: &str, value_style: Style, width: usize) -> Vec<Line<'static>> {
    theme::hanging(
        vec![Span::styled(
            format!("{label:<14}"),
            Style::default().fg(theme::MUTED),
        )],
        value,
        value_style,
        width.min(MEASURE),
    )
}

/// A labelled list: the label on the first item's row, bullets under it.
fn field_list(label: &str, items: &[String], width: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let lead = vec![
            Span::styled(
                format!("{:<14}", if i == 0 { label } else { "" }),
                Style::default().fg(theme::MUTED),
            ),
            Span::styled("• ", Style::default().fg(theme::DIM)),
        ];
        out.extend(theme::hanging(
            lead,
            item,
            Style::default().fg(theme::TEXT),
            width.min(MEASURE),
        ));
    }
    out
}

fn summary_lines(s: &SessionScreen, width: usize) -> Vec<Line<'static>> {
    let names = s.names();
    let v = &s.view;
    let mut lines = error_lines(v, width);

    if let Some(r) = &v.record {
        push_record(&mut lines, r, &names, &s.seats, width);
        if !r.how_it_went.trim().is_empty() {
            lines.push(rule("How the debate went", "", theme::GOLD, width));
            lines.push(Line::from(""));
            lines.extend(prose(
                &r.how_it_went,
                Style::default().fg(theme::TEXT),
                width,
                0,
            ));
            lines.push(Line::from(""));
        }
    } else {
        // No record: say why, and point at the page that has something on it.
        lines.push(rule("Decision record", "", theme::GOLD, width));
        lines.push(Line::from(""));
        lines.extend(prose(
            &no_record(s),
            Style::default().fg(theme::MUTED),
            width,
            0,
        ));
        lines.push(Line::from(""));
    }

    // A draft arrives before the critique and the record, so it shows as soon
    // as it exists rather than waiting on either.
    if let Some(d) = &v.document {
        lines.push(rule("Document", "", theme::GOLD, width));
        lines.push(Line::from(""));
        lines.extend(prose(d, Style::default().fg(theme::TEXT), width, 0));
        lines.push(Line::from(""));
    }
    if v.record.is_none() {
        return lines;
    }

    // The analysis panel: one view at a time, picked from a numbered row.
    lines.push(rule("Analysis", "", theme::GOLD, width));
    lines.push(Line::from(""));
    lines.push(analysis::tab_row(s.ui.analysis));
    lines.push(Line::from(""));
    let ctx = analysis::Ctx::new(v, &s.seats, s.ui.focus);
    lines.extend(analysis::lines(s.ui.analysis, &ctx, width));
    lines.push(Line::from(""));

    if let Some((dir, files)) = &v.handoff {
        lines.push(rule(
            "Hand-off",
            &format!("{} files", files.len()),
            theme::MUTED,
            width,
        ));
        lines.extend(field(
            "folder",
            &clean(dir),
            Style::default().fg(theme::TEXT),
            width,
        ));
        lines.extend(field(
            "files",
            &files.join(", "),
            Style::default().fg(theme::MUTED),
            width,
        ));
        lines.push(Line::from(""));
    }

    push_transcript_link(&mut lines, s);
    lines
}

/// Why the summary has no record: still being written, or never will be.
fn no_record(s: &SessionScreen) -> String {
    let v = &s.view;
    let turns: usize = v.rounds.iter().map(|r| r.entries.len()).sum();
    let read = if turns > 0 || !v.legacy.is_empty() {
        " Press t to read what was said."
    } else {
        ""
    };
    if s.is_live() {
        let phase = v.phase.as_deref().unwrap_or("Convening");
        return format!(
            "{phase}. The record is written once the council has debated and voted. Press t to follow the debate as it happens."
        );
    }
    if !v.legacy.is_empty() {
        return format!(
            "This session is from before the council wrote decision records, so there is only a transcript.{read}"
        );
    }
    let how = match s.status().0 {
        "failed" => "The run failed before the council wrote a record.",
        "cancelled" => "The run was cancelled before the council wrote a record.",
        "stopped" => "The run stopped before the council wrote a record.",
        "completed" => "The run finished without a decision record.",
        _ => "The run ended before the council wrote a record.",
    };
    format!("{how}{read}")
}

/// Errors from the run, first on either page: a seat that came back empty or
/// a provider that refused is never left for the reader to infer.
fn error_lines(v: &SessionView, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for e in &v.errors {
        lines.extend(theme::hanging(
            vec![Span::styled("⚠ ", Style::default().fg(theme::ROSE))],
            &clean(e),
            Style::default().fg(theme::ROSE),
            width,
        ));
    }
    if !lines.is_empty() {
        lines.push(Line::from(""));
    }
    lines
}

fn push_transcript_link(lines: &mut Vec<Line<'static>>, s: &SessionScreen) {
    let v = &s.view;
    let turns: usize = v.rounds.iter().map(|r| r.entries.len()).sum();
    if turns == 0 && v.legacy.is_empty() {
        return;
    }
    lines.push(Line::from(vec![
        key("t"),
        Span::styled(
            if s.is_live() {
                "  Follow the debate as it happens"
            } else {
                "  Read the full transcript"
            },
            Style::default().fg(theme::TEXT),
        ),
        Span::styled(
            format!("   {} rounds, {turns} turns", v.rounds.len()),
            Style::default().fg(theme::DIM),
        ),
    ]));
}

fn transcript_lines(s: &SessionScreen, width: usize, frame: u64) -> Vec<Line<'static>> {
    let v = &s.view;
    let mut lines = error_lines(v, width);
    for round in &v.rounds {
        push_round(&mut lines, round, s, frame, width);
    }
    if !v.moderator_notes.is_empty() {
        lines.push(rule("Moderator", "", theme::GOLD, width));
        lines.push(Line::from(""));
        for n in &v.moderator_notes {
            lines.extend(prose(
                n,
                Style::default()
                    .fg(theme::MUTED)
                    .add_modifier(Modifier::ITALIC),
                width,
                2,
            ));
        }
        lines.push(Line::from(""));
    }
    if !v.legacy.is_empty() {
        push_legacy(&mut lines, &v.legacy, s.show_thinking, width);
    }
    if v.rounds.is_empty() && v.moderator_notes.is_empty() && v.legacy.is_empty() {
        let text = if s.is_live() {
            let phase = v.phase.as_deref().unwrap_or("Convening");
            format!("{phase}{}", ".".repeat(((frame / 6) % 4) as usize))
        } else {
            "This session recorded no turns.".to_string()
        };
        lines.push(Line::from(Span::styled(
            text,
            Style::default().fg(theme::DIM),
        )));
    }
    lines
}

fn push_round(
    lines: &mut Vec<Line<'static>>,
    round: &RoundView,
    s: &SessionScreen,
    frame: u64,
    width: usize,
) {
    let seats = round.entries.len();
    let writing = round.entries.iter().filter(|t| !t.done).count();
    let meta = if writing > 0 {
        format!("{writing} of {seats} writing")
    } else {
        format!("{seats} {}", if seats == 1 { "seat" } else { "seats" })
    };
    lines.push(rule(
        &round.label(),
        &meta,
        if writing > 0 {
            theme::GOLD
        } else {
            theme::MUTED
        },
        width,
    ));
    lines.push(Line::from(""));
    for turn in &round.entries {
        push_turn(lines, turn, s, frame, width);
    }
    if round.entries.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No contributions.",
            Style::default().fg(theme::DIM),
        )));
        lines.push(Line::from(""));
    }
}

fn push_turn(
    lines: &mut Vec<Line<'static>>,
    t: &SeatTurn,
    s: &SessionScreen,
    frame: u64,
    width: usize,
) {
    let color = s
        .seat(&t.seat_id)
        .map(|c| c.color)
        .or_else(|| t.provider.map(theme::provider_color))
        .unwrap_or_else(|| theme::speaker_color(&t.seat_id));
    let live = !t.done;
    // The seat's colour as a bar, its name in capitals, the model quiet
    // beside it and the token count off to the right.
    let mut left = vec![
        Span::styled(
            if live && frame % 12 < 6 {
                "▌ "
            } else {
                "▎ "
            },
            Style::default().fg(color),
        ),
        Span::styled(
            t.name.to_uppercase(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
    ];
    if !t.model.is_empty() {
        left.push(Span::styled(
            format!("  {}", t.model),
            Style::default().fg(theme::DIM),
        ));
    }
    let right = match &t.usage {
        Some(u) => format!("{} tok", compact(u.input + u.output + u.reasoning)),
        None if live => "writing".to_string(),
        None => String::new(),
    };
    let left_w: usize = left.iter().map(|s| s.content.width()).sum();
    let gap = width.saturating_sub(left_w + right.width()).max(2);
    left.push(Span::raw(" ".repeat(gap)));
    left.push(Span::styled(
        right,
        Style::default().fg(if live { theme::GOLD } else { theme::DIM }),
    ));
    lines.push(Line::from(left));

    // The reasoning trace, folded behind `T`.
    if !t.thinking.trim().is_empty() {
        let caret = if s.show_thinking { "▾" } else { "▸" };
        lines.push(Line::from(Span::styled(
            format!(
                "  {caret} thinking, {} characters",
                t.thinking.chars().count()
            ),
            Style::default().fg(theme::MUTED),
        )));
        if s.show_thinking {
            lines.extend(prose(
                &t.thinking,
                Style::default()
                    .fg(theme::DIM)
                    .add_modifier(Modifier::ITALIC),
                width,
                4,
            ));
        }
    }
    for u in &t.tool_uses {
        let args = compact_args(&u.call.arguments);
        let (tail, tail_color) = match &u.error {
            Some(e) => (
                format!("failed: {}", theme::truncate(&clean(e), 60)),
                theme::ROSE,
            ),
            None => (
                theme::truncate(&clean(&u.output.replace('\n', " ")), 60),
                theme::DIM,
            ),
        };
        lines.extend(theme::hanging(
            vec![
                Span::raw("  "),
                Span::styled(
                    format!(" {} ", u.call.name),
                    Style::default().fg(theme::INK_ON_GOLD).bg(theme::blend(
                        theme::BG,
                        theme::CYAN,
                        0.75,
                    )),
                ),
                Span::raw(" "),
            ],
            &format!("{args}  →  {tail}"),
            Style::default().fg(tail_color),
            width,
        ));
    }
    let body = if t.text.trim().is_empty() && live {
        "…".to_string()
    } else {
        t.text.clone()
    };
    lines.extend(prose(&body, Style::default().fg(theme::TEXT), width, 2));
    lines.push(Line::from(""));
}

/// `{"query":"x"}` → `query="x"` (values only, truncated) for tool chips.
fn compact_args(args: &serde_json::Value) -> String {
    match args.as_object() {
        Some(o) => o
            .iter()
            .map(|(k, v)| {
                let shown = match v.as_str() {
                    Some(s) => s.to_string(),
                    None => v.to_string(),
                };
                format!("{k}={}", theme::truncate(&clean(&shown), 40))
            })
            .collect::<Vec<_>>()
            .join(" "),
        None => theme::truncate(&clean(&args.to_string()), 60),
    }
}

/// The record, laid out as the desktop lays it out: the question quiet, the
/// answer as the thing you came for, then confidence, the votes seat by seat,
/// dissent, and the supporting lists in a label column with hanging values.
fn push_record(
    lines: &mut Vec<Line<'static>>,
    r: &DecisionRecord,
    names: &Names,
    seats: &[SeatCard],
    width: usize,
) {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let color = |id: &str| {
        seats
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.color)
            .unwrap_or(theme::MUTED)
    };
    lines.push(rule(
        &format!("{} record", r.deliverable.label()),
        "",
        theme::GOLD,
        width,
    ));
    lines.push(Line::from(""));
    if !r.question.trim().is_empty() {
        lines.extend(prose(
            &r.question,
            Style::default().fg(theme::MUTED),
            width,
            0,
        ));
        lines.push(Line::from(""));
    }
    lines.extend(prose(
        &r.answer,
        Style::default()
            .fg(theme::TEXT)
            .add_modifier(Modifier::BOLD),
        width,
        0,
    ));
    lines.push(Line::from(""));

    let pct = (r.confidence.clamp(0.0, 1.0) * 100.0).round() as u32;
    let cells = 20usize;
    let filled = ((r.confidence.clamp(0.0, 1.0) * cells as f32).round() as usize).min(cells);
    lines.push(Line::from(vec![
        Span::styled(
            format!("{:<14}", "Confidence"),
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(
            "━".repeat(filled),
            Style::default().fg(confidence_color(r.confidence)),
        ),
        Span::styled("─".repeat(cells - filled), Style::default().fg(theme::WEB)),
        Span::styled(
            format!("  {pct}%"),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
    ]));

    // One seat per row, the seat's own colour on its name.
    let name_w = r.votes.keys().map(|id| name(id).width()).max().unwrap_or(4) + 2;
    for (i, (id, vote)) in r.votes.iter().enumerate() {
        let lead = vec![
            Span::styled(
                format!("{:<14}", if i == 0 { "Votes" } else { "" }),
                Style::default().fg(theme::MUTED),
            ),
            Span::styled("● ", Style::default().fg(color(id))),
            Span::styled(
                format!("{:<name_w$}", name(id)),
                Style::default().fg(color(id)).add_modifier(Modifier::BOLD),
            ),
        ];
        lines.extend(theme::hanging(
            lead,
            &clean(vote),
            Style::default().fg(theme::TEXT),
            width.min(MEASURE),
        ));
    }
    for d in &r.dissent {
        let lead = vec![
            Span::styled(
                format!("{:<14}", "Dissent"),
                Style::default().fg(theme::ROSE),
            ),
            Span::styled(
                format!("{}  ", name(&d.seat)),
                Style::default()
                    .fg(color(&d.seat))
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        lines.extend(theme::hanging(
            lead,
            &format!(
                "{}. Not carried because {}",
                clean(&d.position).trim_end_matches('.'),
                clean(&d.why_not_carried)
            ),
            Style::default().fg(theme::TEXT),
            width.min(MEASURE),
        ));
    }
    lines.push(Line::from(""));

    if !r.what_changed.trim().is_empty() {
        lines.extend(field(
            "What changed",
            &clean(&r.what_changed),
            Style::default().fg(theme::TEXT),
            width,
        ));
        lines.push(Line::from(""));
    }
    let blocks: [(&str, Vec<String>); 5] = [
        (
            "Options",
            r.options_considered
                .iter()
                .map(|o| format!("{}: {}", clean(&o.option), clean(&o.why_not)))
                .collect(),
        ),
        (
            "Assumptions",
            r.assumptions.iter().map(|a| clean(a)).collect(),
        ),
        (
            "Evidence",
            r.evidence
                .iter()
                .map(|e| evidence_line(&e.claim, &e.source, &name(&e.by)))
                .collect(),
        ),
        ("Open", r.open_questions.iter().map(|q| clean(q)).collect()),
        ("Next", r.next_actions.iter().map(|n| clean(n)).collect()),
    ];
    for (label, items) in blocks {
        if !items.is_empty() {
            lines.extend(field_list(label, &items, width));
            lines.push(Line::from(""));
        }
    }
}

type Names = BTreeMap<String, String>;

fn push_legacy(
    lines: &mut Vec<Line<'static>>,
    legacy: &[StoredMessage],
    show_thinking: bool,
    width: usize,
) {
    lines.push(rule("Transcript", "from before v3", theme::MUTED, width));
    lines.push(Line::from(""));
    for m in legacy {
        let color = theme::speaker_color(&m.agent_id);
        let mut header = vec![
            Span::styled("▎ ", Style::default().fg(color)),
            Span::styled(
                m.display_name.to_uppercase(),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
        ];
        if !m.model.is_empty() {
            header.push(Span::styled(
                format!("  {}", m.model),
                Style::default().fg(theme::DIM),
            ));
        }
        lines.push(Line::from(header));
        if show_thinking && !m.thinking.trim().is_empty() {
            lines.extend(prose(
                &m.thinking,
                Style::default()
                    .fg(theme::DIM)
                    .add_modifier(Modifier::ITALIC),
                width,
                4,
            ));
        }
        lines.extend(prose(
            &m.content,
            Style::default().fg(theme::TEXT),
            width,
            2,
        ));
        lines.push(Line::from(""));
    }
}

// ---------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------

fn render_side(
    f: &mut Frame,
    area: Rect,
    s: &SessionScreen,
    frame: u64,
    hits: &RefCell<Vec<Hit>>,
) -> Rect {
    // A single rule on its left is the only border: the tab strip names what
    // is showing, so a titled box around it would say the same thing twice.
    let block = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::default().fg(theme::DIM));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let inner = Rect {
        x: inner.x + 1,
        width: inner.width.saturating_sub(1),
        ..inner
    };
    let rows = Layout::vertical([Constraint::Length(2), Constraint::Min(0)]).split(inner);
    let mut spans = Vec::new();
    let mut x = rows[0].x;
    for tab in SideTab::ALL {
        let on = tab == s.side;
        let w = tab.label().width() as u16 + 2;
        push_hit(
            hits,
            Rect {
                x,
                y: rows[0].y,
                width: w,
                height: 1,
            },
            Click::Side(tab),
        );
        x += w;
        spans.push(Span::styled(
            format!(" {} ", tab.label()),
            if on {
                Style::default()
                    .fg(theme::INK_ON_GOLD)
                    .bg(theme::GOLD)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), rows[0]);

    let names = s.names();
    let width = rows[1].width as usize;
    let lines = match s.side {
        SideTab::Plan => plan_lines(s.view.plan.as_ref(), &s.view.corrections, &names, width),
        SideTab::Board => board_lines(s.view.board.as_ref(), &names, width),
        SideTab::Convergence => convergence_lines(&s.view.convergences, &names, width),
        SideTab::Cost => cost_lines(s.view.cost.as_ref(), &s.view, width),
        SideTab::Seats => seat_lines(&s.seats, &s.view, frame),
    };
    f.render_widget(Paragraph::new(theme::fit(lines, width)), rows[1]);
    rows[1]
}

fn plan_lines(
    plan: Option<&Plan>,
    corrections: &[String],
    names: &Names,
    width: usize,
) -> Vec<Line<'static>> {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let Some(p) = plan else {
        return vec![Line::from(Span::styled(
            " the moderator is framing…",
            Style::default().fg(theme::DIM),
        ))];
    };
    let mut lines = kv("deliverable", p.deliverable.label(), theme::GOLD, width);
    lines.extend(kv("rounds", &p.rounds.to_string(), theme::TEXT, width));
    if !p.question.trim().is_empty() {
        lines.extend(kv("question", &clean(&p.question), theme::TEXT, width));
    }
    if !p.settles.trim().is_empty() {
        lines.extend(kv("settles", &clean(&p.settles), theme::MUTED, width));
    }
    if !p.options.is_empty() {
        lines.push(heading("options"));
        for o in &p.options {
            lines.extend(bullet(&clean(o), theme::TEXT, width));
        }
    }
    if !p.participants.is_empty() {
        lines.push(heading("participants"));
        for part in &p.participants {
            let role = match part.role {
                SeatRole::Principal => "principal",
                SeatRole::Support => "support",
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {} ", name(&part.seat)),
                    Style::default()
                        .fg(theme::speaker_color(&part.seat))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(role.to_string(), Style::default().fg(theme::DIM)),
            ]));
            if !part.reason.trim().is_empty() {
                lines.extend(theme::hanging(
                    vec![Span::raw("   ")],
                    &clean(&part.reason),
                    Style::default().fg(theme::MUTED),
                    width,
                ));
            }
        }
    }
    if !p.lenses.is_empty() {
        lines.push(heading("lenses"));
        for (seat, lens) in &p.lenses {
            lines.extend(bullet(
                &format!("{}: {}", name(seat), clean(lens)),
                theme::MUTED,
                width,
            ));
        }
    }
    if !p.subtasks.is_empty() {
        lines.push(heading("prep subtasks"));
        for t in &p.subtasks {
            lines.extend(bullet(
                &format!("{}: {}", name(&t.seat), clean(&t.task)),
                theme::MUTED,
                width,
            ));
        }
    }
    if let Some(q) = p.ask_user.as_deref().filter(|q| !q.trim().is_empty()) {
        lines.extend(kv("asked you", &clean(q), theme::MUTED, width));
    }
    if !corrections.is_empty() {
        lines.push(heading("corrections"));
        for c in corrections {
            lines.extend(bullet(c, theme::DIM, width));
        }
    }
    lines
}

fn board_lines(board: Option<&Board>, names: &Names, width: usize) -> Vec<Line<'static>> {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let Some(b) = board else {
        return vec![Line::from(Span::styled(
            " the board is written after the first round…",
            Style::default().fg(theme::DIM),
        ))];
    };
    let mut lines = Vec::new();
    lines.push(heading(&format!("settled · {}", b.settled.len())));
    for s in &b.settled {
        lines.extend(bullet(&clean(s), theme::EMERALD, width));
    }
    lines.push(heading(&format!(
        "disagreements · {}",
        b.disagreements.len()
    )));
    for d in &b.disagreements {
        let who: Vec<String> = d.between.iter().map(|id| name(id)).collect();
        lines.extend(bullet(
            &format!("{}: {}", who.join(" ↔ "), clean(&d.about)),
            theme::ROSE,
            width,
        ));
    }
    if !b.evidence.is_empty() {
        lines.push(heading(&format!("evidence · {}", b.evidence.len())));
        for e in &b.evidence {
            lines.extend(bullet(
                &evidence_line(&e.claim, &e.source, &name(&e.by)),
                theme::MUTED,
                width,
            ));
        }
    }
    if !b.open_questions.is_empty() {
        lines.push(heading("open questions"));
        for q in &b.open_questions {
            lines.extend(bullet(&clean(q), theme::TEXT, width));
        }
    }
    if !b.positions.is_empty() {
        lines.push(heading("positions"));
        for (seat, pos) in &b.positions {
            lines.extend(theme::hanging(
                vec![Span::styled(
                    format!(" {} ", name(seat)),
                    Style::default()
                        .fg(theme::speaker_color(seat))
                        .add_modifier(Modifier::BOLD),
                )],
                &clean(pos),
                Style::default().fg(theme::MUTED),
                width,
            ));
        }
    }
    lines
}

fn convergence_lines(list: &[Convergence], names: &Names, width: usize) -> Vec<Line<'static>> {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    if list.is_empty() {
        return vec![Line::from(Span::styled(
            " judged after each cross-examination…",
            Style::default().fg(theme::DIM),
        ))];
    }
    let mut lines = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let (verdict, color) = match c.recommend {
            Recommend::Close => ("close", theme::EMERALD),
            Recommend::AnotherRound => ("another round", theme::GOLD),
            Recommend::Revise => ("revise", theme::ROSE),
        };
        lines.push(Line::from(vec![
            Span::styled(format!(" #{} ", i + 1), Style::default().fg(theme::DIM)),
            Span::styled(
                verdict.to_string(),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" · {} open", c.open_disagreements),
                Style::default().fg(theme::MUTED),
            ),
        ]));
        let moved = if c.moved.is_empty() {
            "nobody moved".to_string()
        } else {
            format!(
                "moved: {}",
                c.moved
                    .iter()
                    .map(|id| name(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        lines.extend(bullet(&moved, theme::MUTED, width));
        if !c.why.trim().is_empty() {
            lines.extend(bullet(&clean(&c.why), theme::DIM, width));
        }
    }
    lines
}

fn cost_lines(cost: Option<&CostSnapshot>, v: &SessionView, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if let Some(e) = &v.estimate {
        lines.extend(kv(
            "estimate",
            &format!(
                "{}–{} over {} calls",
                theme::usd(e.usd_low),
                theme::usd(e.usd_high),
                e.calls
            ),
            theme::MUTED,
            width,
        ));
        if !e.unpriced_seats.is_empty() {
            lines.extend(kv(
                "unpriced",
                &e.unpriced_seats.join(", "),
                theme::DIM,
                width,
            ));
        }
    }
    let Some(snap) = cost else {
        lines.push(Line::from(Span::styled(
            " no usage yet…",
            Style::default().fg(theme::DIM),
        )));
        return lines;
    };
    for row in snap.rows.iter().take(12) {
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {:<9}", theme::truncate(&row.name, 9)),
                Style::default().fg(theme::speaker_color(&row.agent_id)),
            ),
            Span::styled(
                format!("{}${:.4}", if row.priced { "" } else { "≥" }, row.usd),
                Style::default().fg(theme::TEXT),
            ),
            Span::styled(
                format!(
                    "  {} in · {} out",
                    compact(row.input),
                    compact(row.output + row.reasoning)
                ),
                Style::default().fg(theme::DIM),
            ),
        ]));
    }
    lines.push(Line::from(Span::styled(
        format!(" {}", "─".repeat(width.saturating_sub(4))),
        Style::default().fg(theme::DIM),
    )));
    for (lane, usd) in &snap.lane_usd {
        lines.push(Line::from(Span::styled(
            format!(" {:<10} ${usd:.4}", lane.label()),
            Style::default().fg(theme::MUTED),
        )));
    }
    lines.push(Line::from(vec![
        Span::styled(
            " total      ",
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "{}${:.4}",
                if snap.all_priced { "" } else { "≥" },
                snap.total_usd
            ),
            Style::default()
                .fg(theme::GOLD)
                .add_modifier(Modifier::BOLD),
        ),
    ]));
    lines.push(Line::from(Span::styled(
        format!(
            " tokens     {} in · {} out · {} reasoning",
            compact(snap.total_input),
            compact(snap.total_output),
            compact(snap.total_reasoning)
        ),
        Style::default().fg(theme::DIM),
    )));
    if snap.session_cap > 0.0 {
        lines.push(Line::from(Span::styled(
            format!(" cap        ${:.2}/session", snap.session_cap),
            Style::default().fg(theme::MUTED),
        )));
    }
    if snap.daily_cap > 0.0 {
        lines.push(Line::from(Span::styled(
            format!(
                " today      ${:.2} of ${:.2}",
                snap.daily_usd, snap.daily_cap
            ),
            Style::default().fg(theme::MUTED),
        )));
    }
    if let Some(note) = &snap.note {
        lines.push(Line::from(Span::styled(
            format!(" ⚠ {}", clean(note)),
            Style::default().fg(theme::GOLD),
        )));
    }
    lines
}

fn seat_lines(seats: &[SeatCard], v: &SessionView, frame: u64) -> Vec<Line<'static>> {
    if seats.is_empty() {
        return vec![Line::from(Span::styled(
            " no seats",
            Style::default().fg(theme::DIM),
        ))];
    }
    let pulse_on = frame % 12 < 6;
    seats
        .iter()
        .map(|c| {
            let active = v.active.contains(&c.id);
            let marker = if active {
                if pulse_on {
                    "● "
                } else {
                    "◉ "
                }
            } else {
                "○ "
            };
            let role = v.plan.as_ref().and_then(|p| {
                p.participants
                    .iter()
                    .find(|x| x.seat == c.id)
                    .map(|x| match x.role {
                        SeatRole::Principal => "principal",
                        SeatRole::Support => "support",
                    })
            });
            let mut spans = vec![
                Span::styled(marker, Style::default().fg(c.color)),
                Span::styled(
                    format!("{:<9}", theme::truncate(&c.name, 9)),
                    if active {
                        Style::default().fg(c.color).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::TEXT)
                    },
                ),
                Span::styled(
                    theme::truncate(
                        if c.model.is_empty() {
                            c.provider.map(|p| p.slug()).unwrap_or("")
                        } else {
                            &c.model
                        },
                        22,
                    ),
                    Style::default().fg(theme::DIM),
                ),
            ];
            if let Some(role) = role {
                spans.push(Span::styled(
                    format!(" {role}"),
                    Style::default().fg(theme::GOLD),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

fn overlay_rect(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(2)).max(1);
    let height = height.min(area.height.saturating_sub(1)).max(1);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    }
}

/// The moderator's question box, returning where it was drawn.
fn render_question(f: &mut Frame, area: Rect, question: &str, answer: &str, frame: u64) -> Rect {
    if area.width < 12 || area.height < 6 {
        return Rect::default();
    }
    let rect = overlay_rect(area, 72, 9);
    f.render_widget(Clear, rect);
    let caret = if frame % 16 < 8 { "▌" } else { " " };
    let lines = vec![
        Line::from(Span::styled(
            "The moderator asks:",
            Style::default().fg(theme::MUTED),
        )),
        Line::from(Span::styled(
            question.to_string(),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("› ", Style::default().fg(theme::GOLD)),
            Span::styled(answer.to_string(), Style::default().fg(theme::TEXT)),
            Span::styled(caret, Style::default().fg(theme::GOLD)),
        ]),
        Line::from(""),
        Line::from(vec![
            key("Enter"),
            Span::styled(" answer   ", Style::default().fg(theme::MUTED)),
            key("Esc"),
            Span::styled(
                " skip (plan without it)   ",
                Style::default().fg(theme::MUTED),
            ),
            key("^U"),
            Span::styled(" clear", Style::default().fg(theme::MUTED)),
        ]),
    ];
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::GOLD))
            .title(Span::styled(
                " Question ",
                Style::default()
                    .fg(theme::GOLD)
                    .add_modifier(Modifier::BOLD),
            )),
    );
    f.render_widget(para, rect);
    rect
}

/// The approval box, returning where it was drawn so its keys can be clicked.
fn render_approval(f: &mut Frame, area: Rect, who: &str, tool: &str, args: &str) -> Rect {
    if area.width < 12 || area.height < 6 {
        return Rect::default();
    }
    let rect = overlay_rect(area, 72, 8);
    f.render_widget(Clear, rect);
    let lines = vec![
        Line::from(vec![
            Span::styled(
                who.to_string(),
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" wants to run", Style::default().fg(theme::MUTED)),
        ]),
        Line::from(vec![
            Span::styled(
                format!("  {tool} "),
                Style::default()
                    .fg(theme::CYAN)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                theme::truncate(&clean(args), 200),
                Style::default().fg(theme::MUTED),
            ),
        ]),
        Line::from(""),
        Line::from(vec![
            key("y"),
            Span::styled(" allow   ", Style::default().fg(theme::MUTED)),
            key("n"),
            Span::styled(" deny", Style::default().fg(theme::MUTED)),
        ]),
    ];
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::GOLD))
            .title(Span::styled(
                " Tool approval ",
                Style::default()
                    .fg(theme::GOLD)
                    .add_modifier(Modifier::BOLD),
            )),
    );
    f.render_widget(para, rect);
    rect
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// `claim (source, by)` with the empty parts left out.
fn evidence_line(claim: &str, source: &str, by: &str) -> String {
    let tail: Vec<String> = [source, by]
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(|s| clean(s))
        .collect();
    if tail.is_empty() {
        clean(claim)
    } else {
        format!("{} ({})", clean(claim), tail.join(", "))
    }
}

fn confidence_color(c: f32) -> Color {
    if c >= 0.75 {
        theme::EMERALD
    } else if c >= 0.45 {
        theme::GOLD
    } else {
        theme::ROSE
    }
}

fn heading(text: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!(" {text}"),
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    ))
}

/// A bullet whose wrapped rows hang under its text, not under the dot.
fn bullet(text: &str, color: Color, width: usize) -> Vec<Line<'static>> {
    theme::hanging(
        vec![Span::styled("  • ", Style::default().fg(theme::DIM))],
        text,
        Style::default().fg(color),
        width,
    )
}

/// A label and a value in the rail, the value hanging in its own column.
fn kv(label: &str, value: &str, color: Color, width: usize) -> Vec<Line<'static>> {
    theme::hanging(
        vec![Span::styled(
            format!(" {label:<12}"),
            Style::default().fg(theme::MUTED),
        )],
        value,
        Style::default().fg(color),
        width,
    )
}

fn key(label: &str) -> Span<'static> {
    Span::styled(
        label.to_string(),
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    )
}

/// `12.3k` token formatting.
fn compact(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}
