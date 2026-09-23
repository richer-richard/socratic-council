//! The Summary's analysis panel: the four views the desktop app shows under
//! the record (score matrix, vote, critique graph, argument map), drawn for a
//! terminal.
//!
//! Every view renders to plain `Line`s at a given width, including the
//! critique graph, which is drawn on a braille canvas into an off-screen
//! buffer and then read back cell by cell. That keeps the whole summary one
//! scrollable column, the way the desktop page is, instead of a fixed grid of
//! widgets that has nowhere to go when the terminal narrows.
//!
//! Nothing here calls a model. The views read the review pass when it ran and
//! fall back to what the protocol records anyway (turns, words, evidence,
//! tools, votes, convergence) when it did not, saying which of the two it is.

use super::theme::{hanging, truncate};
use super::{theme, SeatCard};
use crate::deliberation::review::{
    ArgGraph, ArgNode, ArgNodeKind, ArgRelation, PeerEval, PeerStance,
};
use crate::deliberation::Recommend;
use crate::text::sanitize_terminal as clean;
use crate::tui::view::SessionView;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::Marker;
use ratatui::text::{Line, Span};
use ratatui::widgets::canvas::{Canvas, Line as CanvasLine, Points};
use ratatui::widgets::Widget;
use std::collections::{BTreeMap, BTreeSet};
use unicode_width::UnicodeWidthStr;

// ---------------------------------------------------------------------------
// Which view, and where the review stands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AnalysisView {
    #[default]
    Scores,
    Vote,
    Critique,
    Map,
}

impl AnalysisView {
    pub const ALL: [AnalysisView; 4] = [
        AnalysisView::Scores,
        AnalysisView::Vote,
        AnalysisView::Critique,
        AnalysisView::Map,
    ];

    pub fn label(self) -> &'static str {
        match self {
            AnalysisView::Scores => "Scores",
            AnalysisView::Vote => "Vote",
            AnalysisView::Critique => "Critique",
            AnalysisView::Map => "Map",
        }
    }

    /// The terminal's stand-in for the desktop's drawn glyphs: a heat grid,
    /// two lines converging, a node, a branching tree.
    pub fn glyph(self) -> &'static str {
        match self {
            AnalysisView::Scores => "▦",
            AnalysisView::Vote => "≻",
            AnalysisView::Critique => "◈",
            AnalysisView::Map => "┳",
        }
    }

    /// `1`..`4` pick a view, in the order the tab row shows them.
    pub fn from_digit(c: char) -> Option<Self> {
        let i = c.to_digit(10)? as usize;
        Self::ALL.get(i.checked_sub(1)?).copied()
    }
}

/// Where the review pass stands, so a view with no peer data can say why:
/// switched off for this run, not finished yet, or finished with nothing
/// usable. Saying "off" for all three would be wrong twice over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewStatus {
    Off,
    Pending,
    Done,
}

pub fn review_status(v: &SessionView) -> ReviewStatus {
    match &v.estimate {
        Some(e) if !e.review => ReviewStatus::Off,
        _ if !v.done => ReviewStatus::Pending,
        _ => ReviewStatus::Done,
    }
}

// ---------------------------------------------------------------------------
// What the run says about each seat, for free
// ---------------------------------------------------------------------------

/// Per-seat numbers derived from the run itself. Mirrors the desktop's
/// `session/metrics.ts`, so both clients show the same counts.
#[derive(Debug, Clone, PartialEq)]
pub struct SeatMetric {
    pub id: String,
    pub name: String,
    pub color: Color,
    pub vote: Option<String>,
    /// The moderator judged this seat to have moved in at least one round.
    pub moved: bool,
    /// Its position is recorded as dissent that did not carry.
    pub dissented: bool,
    /// Sourced claims on the board or in the record credited to this seat.
    pub evidence: usize,
    pub tools: usize,
    pub turns: usize,
    pub words: usize,
}

pub fn seat_metrics(v: &SessionView, seats: &[SeatCard]) -> Vec<SeatMetric> {
    // Roster order when we have it, so rows match the rest of the screen.
    let mut order: Vec<(String, String, Color)> = seats
        .iter()
        .map(|s| (s.id.clone(), s.name.clone(), s.color))
        .collect();
    if order.is_empty() {
        for turn in v.rounds.iter().flat_map(|r| r.entries.iter()) {
            if !order.iter().any(|(id, _, _)| id == &turn.seat_id) {
                order.push((
                    turn.seat_id.clone(),
                    turn.name.clone(),
                    turn.provider
                        .map(theme::provider_color)
                        .unwrap_or(theme::MUTED),
                ));
            }
        }
    }
    let moved: BTreeSet<&str> = v
        .convergences
        .iter()
        .flat_map(|c| c.moved.iter().map(String::as_str))
        .collect();
    let dissent: BTreeSet<&str> = v
        .record
        .iter()
        .flat_map(|r| r.dissent.iter().map(|d| d.seat.as_str()))
        .collect();
    let evidence: Vec<&str> = v
        .board
        .iter()
        .flat_map(|b| b.evidence.iter().map(|e| e.by.as_str()))
        .chain(
            v.record
                .iter()
                .flat_map(|r| r.evidence.iter().map(|e| e.by.as_str())),
        )
        .collect();

    order
        .into_iter()
        .map(|(id, name, color)| {
            // The moderator names seats by id in some rounds and by display
            // name in others, so both spellings count as the same seat.
            let is = |s: &str| s == id || s == name;
            let turns: Vec<_> = v
                .rounds
                .iter()
                .flat_map(|r| r.entries.iter())
                .filter(|t| t.seat_id == id)
                .collect();
            SeatMetric {
                // A blank vote is no vote, as the desktop counts it.
                vote: v
                    .record
                    .as_ref()
                    .and_then(|r| r.votes.get(&id))
                    .map(|v| clean(v).trim().to_string())
                    .filter(|v| !v.is_empty()),
                moved: moved.iter().any(|m| is(m)),
                dissented: dissent.iter().any(|d| is(d)),
                evidence: evidence.iter().filter(|b| is(b)).count(),
                tools: turns.iter().map(|t| t.tool_uses.len()).sum(),
                words: turns
                    .iter()
                    .map(|t| t.text.split_whitespace().count())
                    .sum(),
                turns: turns.len(),
                id,
                name,
                color,
            }
        })
        .collect()
}

/// The final vote grouped by option, biggest bloc first, ties alphabetical so
/// the order is stable between renders. Each bloc lists seat indices.
pub fn vote_split(metrics: &[SeatMetric]) -> Vec<(String, Vec<usize>)> {
    let mut blocs: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, m) in metrics.iter().enumerate() {
        if let Some(vote) = &m.vote {
            blocs.entry(vote.clone()).or_default().push(i);
        }
    }
    let mut out: Vec<_> = blocs.into_iter().collect();
    out.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
    out
}

/// Scale a column to 0..100 against its largest value. A column where every
/// seat did the same reads flat instead of inventing a leader.
fn normalize(values: &[usize]) -> Vec<u8> {
    let top = values.iter().copied().max().unwrap_or(0);
    values
        .iter()
        .map(|v| {
            if top == 0 {
                0
            } else {
                ((*v as f32 / top as f32) * 100.0).round() as u8
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/// Everything a view needs, gathered once per frame.
pub struct Ctx<'a> {
    pub view: &'a SessionView,
    pub metrics: Vec<SeatMetric>,
    pub status: ReviewStatus,
    /// The seat the critique graph is focused on, by index into `metrics`.
    pub focus: Option<usize>,
}

impl<'a> Ctx<'a> {
    pub fn new(view: &'a SessionView, seats: &[SeatCard], focus: Option<usize>) -> Self {
        Ctx {
            metrics: seat_metrics(view, seats),
            status: review_status(view),
            view,
            focus,
        }
    }

    fn name(&self, id: &str) -> String {
        self.metrics
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    fn color(&self, id: &str) -> Color {
        self.metrics
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.color)
            .unwrap_or(theme::MUTED)
    }
}

fn style(color: Color) -> Style {
    Style::default().fg(color)
}

fn pad(n: usize) -> Span<'static> {
    Span::raw(" ".repeat(n))
}

/// A quiet note: muted prose, wrapped with a two-space margin.
fn note(text: &str, width: usize) -> Vec<Line<'static>> {
    hanging(vec![pad(2)], text, style(theme::MUTED), width)
}

/// Read a rendered buffer back as styled lines, merging runs of equal style.
fn buffer_lines(buf: &Buffer, left: usize) -> Vec<Line<'static>> {
    let area = buf.area;
    (area.top()..area.bottom())
        .map(|y| {
            let mut spans = vec![pad(left)];
            let mut run = String::new();
            let mut run_style = Style::default();
            // The cell after a wide glyph is blanked by the buffer and hidden
            // on screen. Reading it back would push the rest of the row right.
            let mut hidden = 0;
            for x in area.left()..area.right() {
                if hidden > 0 {
                    hidden -= 1;
                    continue;
                }
                let cell = &buf[(x, y)];
                hidden = cell.symbol().width().saturating_sub(1);
                let st = Style::default()
                    .fg(cell.fg)
                    .bg(cell.bg)
                    .add_modifier(cell.modifier);
                if st != run_style && !run.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut run), run_style));
                }
                run_style = st;
                run.push_str(cell.symbol());
            }
            if !run.is_empty() {
                spans.push(Span::styled(run, run_style));
            }
            Line::from(spans)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The tab row
// ---------------------------------------------------------------------------

pub fn tab_row(current: AnalysisView) -> Line<'static> {
    let mut spans = vec![pad(2)];
    for (i, v) in AnalysisView::ALL.into_iter().enumerate() {
        let on = v == current;
        spans.push(Span::styled(
            format!("{} ", i + 1),
            style(if on { theme::GOLD } else { theme::DIM }),
        ));
        spans.push(Span::styled(
            format!(" {} {} ", v.glyph(), v.label()),
            if on {
                Style::default()
                    .fg(theme::INK_ON_GOLD)
                    .bg(theme::GOLD)
                    .add_modifier(Modifier::BOLD)
            } else {
                style(theme::MUTED)
            },
        ));
        spans.push(pad(3));
    }
    Line::from(spans)
}

pub fn lines(view: AnalysisView, ctx: &Ctx, width: usize) -> Vec<Line<'static>> {
    match view {
        AnalysisView::Scores => scores(ctx, width),
        AnalysisView::Vote => vote(ctx, width),
        AnalysisView::Critique => critique(ctx, width),
        AnalysisView::Map => map(ctx, width),
    }
}

// ---------------------------------------------------------------------------
// 1. Scores
// ---------------------------------------------------------------------------

fn counts_caption(status: ReviewStatus, peer: Option<&PeerEval>) -> String {
    let counts = "these are counts from the run itself, shaded against the busiest seat.";
    match (status, peer) {
        (ReviewStatus::Off, _) => {
            format!("Peer scoring was off for this session, so {counts} It is under Settings (^P), Tools & protocol.")
        }
        (ReviewStatus::Pending, _) => {
            format!("Peer scores replace this once the review finishes. Until then {counts}")
        }
        (ReviewStatus::Done, Some(_)) => {
            format!("The review ran but no evaluator returned a usable score, so {counts}")
        }
        (ReviewStatus::Done, None) => {
            format!("No peer scores came back for this session, so {counts}")
        }
    }
}

struct Column {
    label: &'static str,
    /// (shown number, 0..100 heat) per row.
    cells: Vec<(String, u8)>,
}

/// A heat grid: one row per seat, a tile per column, gold weight for value.
/// Columns drop from the right when the terminal is too narrow for them, so
/// the first column (the one that matters most) always survives.
fn grid(
    rows: &[(Option<u32>, String, Color)],
    columns: &[Column],
    width: usize,
) -> Vec<Line<'static>> {
    let name_w = rows
        .iter()
        .map(|(_, n, _)| n.width())
        .max()
        .unwrap_or(4)
        .max(4)
        + 2;
    let rank_w = 5;
    let col_w = columns
        .iter()
        .map(|c| c.label.width() + 2)
        .max()
        .unwrap_or(8)
        .max(8);
    let room = width.saturating_sub(rank_w + name_w);
    // Tiles widen to share the room when every column fits. Capped: past 18
    // cells a tile stops reading as a tile.
    let col_w = if room / columns.len() > col_w {
        (room / columns.len()).min(18)
    } else {
        col_w
    };
    let shown = (room / col_w).clamp(1, columns.len());
    let columns = &columns[..shown];

    let mut out = Vec::new();
    let mut head = vec![
        pad(rank_w),
        Span::styled(format!("{:<name_w$}", "Seat"), style(theme::DIM)),
    ];
    for c in columns {
        head.push(Span::styled(
            format!("{:>w$}", c.label, w = col_w - 1),
            style(theme::DIM),
        ));
        head.push(pad(1));
    }
    out.push(Line::from(head));
    for (i, (rank, name, color)) in rows.iter().enumerate() {
        let mut spans = vec![Span::styled(
            match rank {
                Some(r) => format!("  {r:<3}"),
                None => pad(rank_w).content.to_string(),
            },
            style(theme::GOLD),
        )];
        spans.push(Span::styled(
            format!("{name:<name_w$}"),
            Style::default().fg(*color).add_modifier(Modifier::BOLD),
        ));
        for c in columns {
            let (shown, heat) = &c.cells[i];
            let (bg, fg) = theme::heat(*heat);
            // One unshaded cell between tiles reads as a hairline, so a row
            // is a strip of tiles rather than one block of colour.
            spans.push(Span::styled(
                format!("{shown:>w$} ", w = col_w - 2),
                Style::default().fg(fg).bg(bg),
            ));
            spans.push(pad(1));
        }
        out.push(Line::from(spans));
    }
    out
}

fn scores(ctx: &Ctx, width: usize) -> Vec<Line<'static>> {
    let peer = ctx.view.peer_eval.as_ref();
    if let Some(pe) = peer.filter(|p| !p.critiques.is_empty()) {
        let mut ranked: Vec<&String> = pe
            .seats
            .iter()
            .filter(|id| pe.per_seat.get(*id).is_some_and(|s| s.reviews_received > 0))
            .collect();
        ranked.sort_by_key(|id| pe.per_seat[*id].rank);
        let summary = |id: &String| &pe.per_seat[id];
        let rows: Vec<(Option<u32>, String, Color)> = ranked
            .iter()
            .map(|id| (Some(summary(id).rank), ctx.name(id), ctx.color(id)))
            .collect();
        let col = |label: &'static str, f: &dyn Fn(&String) -> u8| Column {
            label,
            cells: ranked.iter().map(|id| (f(id).to_string(), f(id))).collect(),
        };
        let columns = vec![
            col("Overall", &|id| summary(id).overall_average.round() as u8),
            col("Rigor", &|id| summary(id).average.rigor),
            col("Evidence", &|id| summary(id).average.evidence),
            col("Novelty", &|id| summary(id).average.novelty),
            col("Civility", &|id| summary(id).average.civility),
            col("On topic", &|id| summary(id).average.on_topic),
        ];
        let mut out = note(
            "Every seat scored every other seat once the debate closed. 0 to 100, where an unremarkable contribution is 50.",
            width,
        );
        out.push(Line::from(""));
        out.extend(grid(&rows, &columns, width));
        // The harshest line each seat received, under the grid rather than
        // crammed into it, so the tiles stay one row per seat.
        let notes: Vec<_> = ranked
            .iter()
            .filter_map(|id| summary(id).standout.as_ref().map(|s| (*id, s)))
            .collect();
        if !notes.is_empty() {
            out.push(Line::from(""));
            let name_w = ranked
                .iter()
                .map(|id| ctx.name(id).width())
                .max()
                .unwrap_or(4)
                + 2;
            for (id, text) in notes {
                out.extend(hanging(
                    vec![
                        pad(5),
                        Span::styled(format!("{:<name_w$}", ctx.name(id)), style(ctx.color(id))),
                    ],
                    &clean(text),
                    style(theme::MUTED),
                    width,
                ));
            }
        }
        if !pe.failed.is_empty() {
            out.push(Line::from(""));
            let who: Vec<String> = pe.failed.iter().map(|id| ctx.name(id)).collect();
            out.extend(note(
                &format!(
                    "No usable review came back from {}, so they graded nobody.",
                    who.join(", ")
                ),
                width,
            ));
        }
        return out;
    }

    // No peer scores: the same grid, filled from what the run recorded.
    let seats: Vec<&SeatMetric> = ctx.metrics.iter().filter(|m| m.turns > 0).collect();
    if seats.is_empty() {
        return note("Nothing to score yet: no seat has finished a turn.", width);
    }
    let rows: Vec<(Option<u32>, String, Color)> = seats
        .iter()
        .map(|m| (None, m.name.clone(), m.color))
        .collect();
    let counted = |label: &'static str, f: &dyn Fn(&SeatMetric) -> usize| {
        let values: Vec<usize> = seats.iter().map(|m| f(m)).collect();
        let heat = normalize(&values);
        Column {
            label,
            cells: values
                .iter()
                .zip(heat)
                .map(|(v, h)| (v.to_string(), h))
                .collect(),
        }
    };
    let columns = vec![
        counted("Turns", &|m| m.turns),
        counted("Words", &|m| m.words),
        counted("Evidence", &|m| m.evidence),
        counted("Tools", &|m| m.tools),
    ];
    let mut out = note(
        &format!("What each seat did. {}", counts_caption(ctx.status, peer)),
        width,
    );
    out.push(Line::from(""));
    out.extend(grid(&rows, &columns, width));
    if let Some(pe) = peer.filter(|p| !p.failed.is_empty()) {
        out.push(Line::from(""));
        let who: Vec<String> = pe.failed.iter().map(|id| ctx.name(id)).collect();
        out.extend(note(
            &format!("No usable review came back from {}.", who.join(", ")),
            width,
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// 2. Vote
// ---------------------------------------------------------------------------

fn vote(ctx: &Ctx, width: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let blocs = vote_split(&ctx.metrics);
    let total: usize = blocs.iter().map(|(_, s)| s.len()).sum();
    let bar_w = width.saturating_sub(4).max(10);
    if total == 0 {
        out.extend(note("No seat cast a final vote in this session.", width));
    } else {
        // The winning bloc in gold, the rest stepping down, so the bar reads
        // as one decision rather than a stack of peers.
        let mut spans = vec![pad(2)];
        let sizes: Vec<usize> = blocs.iter().map(|(_, s)| s.len()).collect();
        for (i, len) in segment_widths(&sizes, bar_w).into_iter().enumerate() {
            // Floored, so a sixth or seventh bloc is still a visible segment
            // rather than a bar drawn in the background colour.
            let color = if i == 0 {
                theme::GOLD
            } else {
                theme::blend(
                    theme::BG,
                    theme::MUTED,
                    (0.55 - (i as f32) * 0.12).max(0.22),
                )
            };
            spans.push(Span::styled(
                "█".repeat(len.saturating_sub(1)),
                style(color),
            ));
            spans.push(pad(1));
        }
        out.push(Line::from(spans));
        out.push(Line::from(""));
        for (vote, seats) in &blocs {
            let names: Vec<String> = seats.iter().map(|i| ctx.metrics[*i].name.clone()).collect();
            out.extend(hanging(
                vec![Span::styled(
                    format!("  {:>2}  ", seats.len()),
                    style(theme::GOLD).add_modifier(Modifier::BOLD),
                )],
                &format!("{vote}   {}", names.join(", ")),
                style(theme::TEXT),
                width,
            ));
        }
    }

    let rounds = &ctx.view.convergences;
    if !rounds.is_empty() {
        out.push(Line::from(""));
        out.push(Line::from(vec![
            pad(2),
            Span::styled("─".repeat(bar_w), style(theme::WEB)),
        ]));
        let moved_w = rounds
            .iter()
            .map(|c| moved_label(c).width())
            .max()
            .unwrap_or(10)
            .clamp(10, 28);
        // Label, open count, who moved and the verdict are fixed width. The
        // track takes whatever is left.
        let fixed = 2 + 10 + 2 + 12 + moved_w + 2 + 13;
        let track = width.saturating_sub(fixed).max(6);
        for (i, c) in rounds.iter().enumerate() {
            let open = c.open_disagreements as usize;
            let fill = ((open.min(5) as f32 / 5.0) * track as f32).round() as usize;
            out.push(Line::from(vec![
                Span::styled(
                    format!("  {:<10}", format!("Round {}", i + 1)),
                    style(theme::MUTED),
                ),
                Span::styled("━".repeat(fill), style(theme::GOLD)),
                Span::styled("─".repeat(track - fill), style(theme::WEB)),
                pad(2),
                Span::styled(
                    format!(
                        "{:<12}",
                        if open == 0 {
                            "nothing open".to_string()
                        } else {
                            format!("{open} open")
                        }
                    ),
                    style(theme::MUTED),
                ),
                Span::styled(
                    format!("{:<moved_w$}", truncate(&moved_label(c), moved_w)),
                    style(theme::DIM),
                ),
                pad(2),
                Span::styled(
                    format!("{:>13}", verdict(c.recommend)),
                    style(theme::blend(theme::BG, theme::GOLD, 0.7)),
                ),
            ]));
        }
    }
    out
}

/// The vote bar's segment widths: in proportion to each bloc, summing to
/// exactly `bar_w`, and at least two cells each (one of bar, one of gap) when
/// there is room, so a single seat's bloc never rounds away to nothing.
fn segment_widths(sizes: &[usize], bar_w: usize) -> Vec<usize> {
    let total: usize = sizes.iter().sum();
    if total == 0 {
        return vec![0; sizes.len()];
    }
    let floor = if bar_w >= 2 * sizes.len() { 2 } else { 0 };
    let spare = bar_w - floor * sizes.len();
    let mut out = Vec::with_capacity(sizes.len());
    let (mut acc, mut placed) = (0, 0);
    for size in sizes {
        acc += size;
        // Rounding the running total, not each share, keeps the sum exact.
        let end = ((acc as f64 / total as f64) * spare as f64).round() as usize;
        out.push(floor + end - placed);
        placed = end;
    }
    out
}

fn moved_label(c: &crate::deliberation::Convergence) -> String {
    if c.moved.is_empty() {
        "no one moved".into()
    } else {
        format!(
            "{} moved",
            c.moved
                .iter()
                .map(|m| clean(m))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

fn verdict(r: Recommend) -> &'static str {
    match r {
        Recommend::Close => "close",
        Recommend::AnotherRound => "another round",
        Recommend::Revise => "revise",
    }
}

// ---------------------------------------------------------------------------
// 3. Critique graph
// ---------------------------------------------------------------------------

fn stance_color(s: PeerStance) -> Color {
    match s {
        PeerStance::Agree => theme::AGREE,
        PeerStance::Disagree => theme::DISAGREE,
        PeerStance::Mixed => theme::MIXED,
    }
}

fn no_critiques(status: ReviewStatus, peer: Option<&PeerEval>) -> &'static str {
    match (status, peer) {
        (ReviewStatus::Off, _) => "Peer scoring was off for this session, so no seat rated another. Switch it on under Settings (^P), Tools & protocol to get this graph on the next run.",
        (ReviewStatus::Pending, _) => "Each seat rates the others once the record is written. The graph fills in when that finishes.",
        (ReviewStatus::Done, Some(_)) => "The review ran but no evaluator returned a usable score, so there is nothing to draw.",
        (ReviewStatus::Done, None) => "No seat rated another in this session.",
    }
}

fn critique(ctx: &Ctx, width: usize) -> Vec<Line<'static>> {
    let Some(pe) = ctx
        .view
        .peer_eval
        .as_ref()
        .filter(|p| !p.critiques.is_empty())
    else {
        return note(no_critiques(ctx.status, ctx.view.peer_eval.as_ref()), width);
    };
    let focus = ctx.focus.and_then(|i| pe.seats.get(i)).cloned();

    // The canvas works in braille dots: two across and four down per cell,
    // which makes a dot square and the ring round without any aspect fudge.
    let cols = (width.saturating_sub(4)).clamp(30, 72) as u16;
    let rows: u16 = (cols / 3).clamp(12, 20);
    let (dw, dh) = (cols as f64 * 2.0, rows as f64 * 4.0);
    let (cx, cy) = (dw / 2.0, dh / 2.0);
    // Leave room for a label row above and below the ring.
    let radius = (cy - 9.0).min(cx - 18.0).max(8.0);
    let n = pe.seats.len().max(1);
    let at = |i: usize| {
        let a = -std::f64::consts::FRAC_PI_2 + (i as f64) * std::f64::consts::TAU / n as f64;
        (cx + radius * a.cos(), cy - radius * a.sin())
    };
    let index: BTreeMap<&str, usize> = pe
        .seats
        .iter()
        .enumerate()
        .map(|(i, s)| (s.as_str(), i))
        .collect();

    let edges: Vec<(f64, f64, f64, f64, Color)> = pe
        .critiques
        .iter()
        .filter_map(|c| {
            let (a, b) = (
                index.get(c.evaluator.as_str())?,
                index.get(c.target.as_str())?,
            );
            let (x1, y1) = at(*a);
            let (x2, y2) = at(*b);
            let lit = focus
                .as_ref()
                .is_none_or(|f| f == &c.evaluator || f == &c.target);
            let color = if lit {
                stance_color(c.stance)
            } else {
                theme::WEB
            };
            Some((x1, y1, x2, y2, color))
        })
        .collect();
    let nodes: Vec<(f64, f64, Color, bool, String)> = pe
        .seats
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let (x, y) = at(i);
            let summary = pe.per_seat.get(id);
            let rated = summary.is_some_and(|s| s.reviews_received > 0);
            let lit = focus.as_ref().is_none_or(|f| f == id);
            let color = if lit {
                theme::GOLD
            } else {
                theme::blend(theme::BG, theme::GOLD, 0.35)
            };
            // A seat nobody managed to rate is drawn hollow and says so.
            // Drawn as 0 it read as the council's harshest verdict.
            let label = match summary.filter(|_| rated) {
                Some(s) => format!("{} {}", ctx.name(id), s.overall_average.round() as u32),
                None => format!("{} not rated", ctx.name(id)),
            };
            // A label never runs past the canvas, however long the name.
            let label = truncate(&label, cols as usize - 2);
            (x, y, color, rated, label)
        })
        .collect();
    let node_colors: Vec<Color> = pe.seats.iter().map(|id| ctx.color(id)).collect();

    let canvas = Canvas::default()
        .marker(Marker::Braille)
        .x_bounds([0.0, dw])
        .y_bounds([0.0, dh])
        .paint(move |c| {
            // Dim edges first, lit ones over them, then nodes, then labels.
            for (x1, y1, x2, y2, color) in edges.iter().filter(|e| e.4 == theme::WEB) {
                c.draw(&CanvasLine {
                    x1: *x1,
                    y1: *y1,
                    x2: *x2,
                    y2: *y2,
                    color: *color,
                });
            }
            for (x1, y1, x2, y2, color) in edges.iter().filter(|e| e.4 != theme::WEB) {
                c.draw(&CanvasLine {
                    x1: *x1,
                    y1: *y1,
                    x2: *x2,
                    y2: *y2,
                    color: *color,
                });
            }
            c.layer();
            for (x, y, color, rated, _) in &nodes {
                let mut dots = Vec::new();
                for dx in -3..=3 {
                    for dy in -3..=3 {
                        let edge = dx == -3 || dx == 3 || dy == -3 || dy == 3;
                        if *rated || edge {
                            dots.push((x + dx as f64, y + dy as f64));
                        }
                    }
                }
                c.draw(&Points {
                    coords: &dots,
                    color: *color,
                });
            }
            c.layer();
            for (i, (x, y, _, _, label)) in nodes.iter().enumerate() {
                let label_w = label.width() as f64 * 2.0;
                // Above the ring's middle the label sits above its node, below
                // it underneath; either way it is centred on the node.
                let ly = if *y > cy { y + 8.0 } else { y - 7.0 };
                let lx = (x - label_w / 2.0).min(dw - label_w).max(0.0);
                c.print(
                    lx,
                    ly,
                    Line::from(Span::styled(
                        label.clone(),
                        Style::default()
                            .fg(node_colors[i])
                            .add_modifier(Modifier::BOLD),
                    )),
                );
            }
        });
    let mut buf = Buffer::empty(Rect::new(0, 0, cols, rows));
    canvas.render(buf.area, &mut buf);
    let left = (width.saturating_sub(cols as usize)) / 2;
    let mut out = buffer_lines(&buf, left);

    out.push(Line::from(""));
    let mut key = vec![pad(2)];
    for (label, color) in [
        ("agree", theme::AGREE),
        ("disagree", theme::DISAGREE),
        ("mixed", theme::MIXED),
    ] {
        key.push(Span::styled("■ ", style(color)));
        key.push(Span::styled(format!("{label}   "), style(theme::MUTED)));
    }
    key.push(Span::styled(
        match &focus {
            Some(id) => format!("[ ] step through seats · showing {}", ctx.name(id)),
            None => "[ ] step through seats to read what each received".to_string(),
        },
        style(theme::DIM),
    ));
    out.push(Line::from(key));

    if let Some(id) = &focus {
        out.push(Line::from(""));
        let received: Vec<_> = pe.critiques.iter().filter(|c| &c.target == id).collect();
        if received.is_empty() {
            out.extend(note(
                &format!("Nobody managed to rate {}.", ctx.name(id)),
                width,
            ));
        }
        let who_w = received
            .iter()
            .map(|c| ctx.name(&c.evaluator).width())
            .max()
            .unwrap_or(4)
            + 7;
        for c in received {
            out.extend(hanging(
                vec![
                    pad(2),
                    Span::styled(
                        format!(
                            "{:<who_w$}",
                            format!("{} · {}", ctx.name(&c.evaluator), c.overall)
                        ),
                        style(stance_color(c.stance)),
                    ),
                ],
                &clean(&c.critique),
                style(theme::TEXT),
                width,
            ));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 4. Argument map
// ---------------------------------------------------------------------------

fn no_map(status: ReviewStatus, graph: Option<&ArgGraph>) -> &'static str {
    if graph.is_some() {
        return "The argument map could not be built: the extractor returned nothing usable for any round.";
    }
    match status {
        ReviewStatus::Off => "No argument map: the review that builds it was off for this session. It is under Settings (^P), Tools & protocol.",
        ReviewStatus::Pending => "The argument map is built after the record, once the peer scores are in.",
        ReviewStatus::Done => "No argument map for this session.",
    }
}

fn relation_color(r: ArgRelation) -> Color {
    match r {
        ArgRelation::Rebuts | ArgRelation::Contradicts => theme::DISAGREE,
        ArgRelation::DependsOn | ArgRelation::Addresses => theme::CYAN,
        _ => theme::AGREE,
    }
}

fn relation_label(r: ArgRelation) -> &'static str {
    match r {
        ArgRelation::Supports => "supports",
        ArgRelation::Rebuts => "rebuts",
        ArgRelation::Concedes => "concedes",
        ArgRelation::Restates => "restates",
        ArgRelation::Refines => "refines",
        ArgRelation::Agrees => "agrees",
        ArgRelation::Contradicts => "contradicts",
        ArgRelation::DependsOn => "depends on",
        ArgRelation::Answers => "answers",
        ArgRelation::Addresses => "addresses",
    }
}

fn kind_label(k: ArgNodeKind) -> &'static str {
    match k {
        ArgNodeKind::Claim => "claim",
        ArgNodeKind::Premise => "premise",
        ArgNodeKind::Evidence => "evidence",
        ArgNodeKind::Rebuttal => "rebuttal",
        ArgNodeKind::Concession => "concession",
        ArgNodeKind::Question => "question",
        ArgNodeKind::Assumption => "assumption",
        ArgNodeKind::Definition => "definition",
        ArgNodeKind::Proposal => "proposal",
    }
}

/// The map as a tree: each point the debate opened with, and under it what
/// answered it, and what answered that. The desktop lays the same graph out in
/// columns by round; in a terminal a tree with connectors reads better than
/// boxes, and it narrows without falling apart.
fn map(ctx: &Ctx, width: usize) -> Vec<Line<'static>> {
    let Some(graph) = ctx.view.arg_graph.as_ref().filter(|g| !g.nodes.is_empty()) else {
        return note(no_map(ctx.status, ctx.view.arg_graph.as_ref()), width);
    };
    let by_id: BTreeMap<&str, &ArgNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // What answers a node: the edges pointing at it.
    let mut answers: BTreeMap<&str, Vec<(&str, ArgRelation)>> = BTreeMap::new();
    let mut answering: BTreeSet<&str> = BTreeSet::new();
    for e in &graph.edges {
        if by_id.contains_key(e.from.as_str()) && by_id.contains_key(e.to.as_str()) {
            answers
                .entry(e.to.as_str())
                .or_default()
                .push((e.from.as_str(), e.relation));
            answering.insert(e.from.as_str());
        }
    }
    let mut out = Vec::new();
    let mut placed: BTreeSet<&str> = BTreeSet::new();

    let speakers = |n: &ArgNode| {
        n.by.iter()
            .map(|b| ctx.name(b))
            .collect::<Vec<_>>()
            .join(", ")
    };

    #[allow(clippy::too_many_arguments)]
    fn branch<'g>(
        ctx: &Ctx,
        id: &'g str,
        prefix: String,
        last: bool,
        relation: ArgRelation,
        depth: usize,
        by_id: &BTreeMap<&'g str, &'g ArgNode>,
        answers: &BTreeMap<&'g str, Vec<(&'g str, ArgRelation)>>,
        placed: &mut BTreeSet<&'g str>,
        width: usize,
        out: &mut Vec<Line<'static>>,
    ) {
        let node = by_id[id];
        let seen = !placed.insert(id);
        let who = node
            .by
            .iter()
            .map(|b| ctx.name(b))
            .collect::<Vec<_>>()
            .join(", ");
        let rel = relation_label(relation);
        let lead = vec![
            Span::styled(
                format!("{prefix}{}", if last { "└─ " } else { "├─ " }),
                style(theme::WEB),
            ),
            Span::styled(format!("{rel:<11}"), style(relation_color(relation))),
            Span::styled(
                format!("{who}  "),
                style(
                    node.by
                        .first()
                        .map(|b| ctx.color(b))
                        .unwrap_or(theme::MUTED),
                ),
            ),
        ];
        let text = if seen {
            format!("{} (above)", clean(&node.text))
        } else {
            clean(&node.text)
        };
        let text_style = if seen {
            style(theme::DIM)
        } else {
            style(theme::TEXT)
        };
        // Continuation rows keep the tree's rail running beside them.
        let mut rows = hanging(lead, &text, text_style, width);
        let rail = format!("{prefix}{}", if last { "   " } else { "│  " });
        for row in rows.iter_mut().skip(1) {
            if let Some(first) = row.spans.first_mut() {
                let indent = first.content.width();
                *first = Span::styled(
                    format!("{rail}{}", " ".repeat(indent.saturating_sub(rail.width()))),
                    style(theme::WEB),
                );
            }
        }
        out.extend(rows);
        if seen || depth >= 8 {
            return;
        }
        if let Some(kids) = answers.get(id) {
            let next = format!("{prefix}{}", if last { "   " } else { "│  " });
            for (i, (kid, rel)) in kids.iter().enumerate() {
                branch(
                    ctx,
                    kid,
                    next.clone(),
                    i + 1 == kids.len(),
                    *rel,
                    depth + 1,
                    by_id,
                    answers,
                    placed,
                    width,
                    out,
                );
            }
        }
    }

    // Roots are the points that answer nothing: what the debate opened with.
    // Anything left over after them sits in a cycle and gets a root of its own.
    let mut roots: Vec<&ArgNode> = graph
        .nodes
        .iter()
        .filter(|n| !answering.contains(n.id.as_str()))
        .collect();
    roots.sort_by_key(|n| n.round);
    let leftovers: Vec<&ArgNode> = graph.nodes.iter().collect();
    for root in roots.into_iter().chain(leftovers) {
        if placed.contains(root.id.as_str()) {
            continue;
        }
        placed.insert(root.id.as_str());
        let kind_color = if root.kind == ArgNodeKind::Rebuttal {
            theme::DISAGREE
        } else {
            theme::GOLD
        };
        out.push(Line::from(vec![
            Span::styled("  ● ", style(kind_color)),
            Span::styled(
                kind_label(root.kind),
                style(kind_color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {}", speakers(root)),
                style(
                    root.by
                        .first()
                        .map(|b| ctx.color(b))
                        .unwrap_or(theme::MUTED),
                ),
            ),
        ]));
        out.extend(hanging(
            vec![pad(4)],
            &clean(&root.text),
            style(theme::TEXT).add_modifier(Modifier::BOLD),
            width,
        ));
        if let Some(kids) = answers.get(root.id.as_str()) {
            for (i, (kid, rel)) in kids.iter().enumerate() {
                branch(
                    ctx,
                    kid,
                    "    ".into(),
                    i + 1 == kids.len(),
                    *rel,
                    1,
                    &by_id,
                    &answers,
                    &mut placed,
                    width,
                    &mut out,
                );
            }
        }
        out.push(Line::from(""));
    }
    let mut foot = format!(
        "{} points, {} links. Green answers, red pushes back, cyan depends on or addresses.",
        graph.nodes.len(),
        graph.edges.len()
    );
    if !graph.missing.is_empty() {
        foot.push_str(&format!(
            " Not mapped, because the extractor returned nothing usable: {}.",
            graph.missing.join(", ")
        ));
    }
    out.extend(note(&foot, width));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deliberation::review::{ArgEdge, PeerCritique, PeerScores, PeerSummary};
    use crate::deliberation::RoundKind;
    use crate::deliberation::{Convergence, DecisionRecord, Deliverable, Dissent, Estimate};
    use crate::tui::view::{RoundView, SeatTurn};

    fn seat(id: &str, name: &str) -> SeatCard {
        SeatCard {
            id: id.into(),
            name: name.into(),
            provider: None,
            model: String::new(),
            color: theme::MUTED,
        }
    }

    fn turn(id: &str, text: &str) -> SeatTurn {
        SeatTurn {
            seat_id: id.into(),
            name: id.into(),
            provider: None,
            model: String::new(),
            text: text.into(),
            thinking: String::new(),
            tool_uses: Vec::new(),
            usage: None,
            structured: serde_json::Value::Null,
            done: true,
        }
    }

    fn record(votes: &[(&str, &str)]) -> DecisionRecord {
        DecisionRecord {
            deliverable: Deliverable::Decision,
            question: "q".into(),
            answer: "a".into(),
            confidence: 0.5,
            options_considered: vec![],
            dissent: vec![Dissent {
                seat: "c".into(),
                position: "p".into(),
                why_not_carried: "w".into(),
            }],
            assumptions: vec![],
            evidence: vec![],
            open_questions: vec![],
            next_actions: vec![],
            what_changed: String::new(),
            how_it_went: String::new(),
            votes: votes
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cost: None,
        }
    }

    fn base() -> (SessionView, Vec<SeatCard>) {
        let v = SessionView {
            rounds: vec![RoundView {
                kind: RoundKind::Positions,
                entries: vec![turn("a", "one two three"), turn("b", "one two")],
            }],
            convergences: vec![Convergence {
                moved: vec!["Ben".into()],
                open_disagreements: 2,
                recommend: Recommend::AnotherRound,
                why: String::new(),
            }],
            record: Some(record(&[("a", "yes"), ("b", "no"), ("c", "yes")])),
            done: true,
            ..SessionView::default()
        };
        (
            v,
            vec![seat("a", "Anna"), seat("b", "Ben"), seat("c", "Cara")],
        )
    }

    fn text(lines: &[Line]) -> String {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn metrics_count_turns_words_and_credit_a_mover_named_by_display_name() {
        let (v, seats) = base();
        let m = seat_metrics(&v, &seats);
        assert_eq!((m[0].turns, m[0].words), (1, 3));
        assert!(m[1].moved, "Ben was named by display name");
        assert!(!m[0].moved);
        assert!(m[2].dissented);
        assert_eq!(m[2].turns, 0);
    }

    #[test]
    fn the_vote_split_puts_the_biggest_bloc_first() {
        let (v, seats) = base();
        let split = vote_split(&seat_metrics(&v, &seats));
        assert_eq!(split[0], ("yes".to_string(), vec![0, 2]));
        assert_eq!(split[1], ("no".to_string(), vec![1]));
    }

    #[test]
    fn review_status_tells_off_pending_and_done_apart() {
        let (mut v, _) = base();
        assert_eq!(review_status(&v), ReviewStatus::Done);
        v.done = false;
        assert_eq!(review_status(&v), ReviewStatus::Pending);
        v.estimate = Some(Estimate {
            review: false,
            ..Estimate::default()
        });
        assert_eq!(review_status(&v), ReviewStatus::Off);
    }

    #[test]
    fn without_peer_scores_the_matrix_says_why_and_counts_instead() {
        let (mut v, seats) = base();
        v.estimate = Some(Estimate {
            review: false,
            ..Estimate::default()
        });
        let ctx = Ctx::new(&v, &seats, None);
        let out = text(&lines(AnalysisView::Scores, &ctx, 100));
        assert!(out.contains("Peer scoring was off"), "{out}");
        assert!(out.contains("Turns"));
        // Cara never spoke, so she has no row to count.
        assert!(!out.contains("Cara"));
    }

    fn peer() -> PeerEval {
        let crit = |e: &str, t: &str, o: u8, stance| PeerCritique {
            evaluator: e.into(),
            target: t.into(),
            scores: PeerScores {
                rigor: o,
                evidence: o,
                novelty: o,
                civility: o,
                on_topic: o,
            },
            overall: o,
            stance,
            critique: "Thin on evidence. Worth another look.".into(),
        };
        let summary = |o: f32, rank, n| PeerSummary {
            average: PeerScores {
                rigor: o as u8,
                evidence: o as u8,
                novelty: o as u8,
                civility: o as u8,
                on_topic: o as u8,
            },
            overall_average: o,
            rank,
            reviews_received: n,
            standout: Some("Thin on evidence.".into()),
        };
        PeerEval {
            seats: vec!["a".into(), "b".into(), "c".into()],
            critiques: vec![
                crit("b", "a", 80, PeerStance::Agree),
                crit("a", "b", 60, PeerStance::Disagree),
            ],
            per_seat: [
                ("a".to_string(), summary(80.0, 1, 1)),
                ("b".to_string(), summary(60.0, 2, 1)),
                ("c".to_string(), PeerSummary::default()),
            ]
            .into_iter()
            .collect(),
            failed: vec!["c".into()],
        }
    }

    #[test]
    fn the_peer_matrix_ranks_and_names_the_evaluators_that_failed() {
        let (mut v, seats) = base();
        v.peer_eval = Some(peer());
        let ctx = Ctx::new(&v, &seats, None);
        let out = text(&lines(AnalysisView::Scores, &ctx, 110));
        let anna = out.find("Anna").unwrap();
        let ben = out.find("Ben").unwrap();
        assert!(anna < ben, "ranked: Anna first\n{out}");
        assert!(out.contains("Overall") && out.contains("On topic"));
        assert!(out.contains("No usable review came back from Cara"));
    }

    #[test]
    fn a_narrow_terminal_drops_matrix_columns_from_the_right() {
        let (mut v, seats) = base();
        v.peer_eval = Some(peer());
        let ctx = Ctx::new(&v, &seats, None);
        let out = text(&lines(AnalysisView::Scores, &ctx, 40));
        assert!(out.contains("Overall"));
        assert!(!out.contains("On topic"));
    }

    #[test]
    fn the_critique_graph_labels_an_unrated_seat_as_unrated() {
        let (mut v, seats) = base();
        v.peer_eval = Some(peer());
        let ctx = Ctx::new(&v, &seats, Some(0));
        let out = text(&lines(AnalysisView::Critique, &ctx, 90));
        assert!(out.contains("Cara not rated"), "{out}");
        assert!(out.contains("Anna 80"));
        // Focused on Anna: the critiques she received are listed.
        assert!(out.contains("Ben · 80"));
    }

    #[test]
    fn the_map_hangs_answers_under_what_they_answer() {
        let (mut v, seats) = base();
        v.arg_graph = Some(ArgGraph {
            nodes: vec![
                ArgNode {
                    id: "n1".into(),
                    kind: ArgNodeKind::Claim,
                    text: "Ranked choice removes spoilers".into(),
                    by: vec!["a".into()],
                    round: 0,
                },
                ArgNode {
                    id: "n2".into(),
                    kind: ArgNodeKind::Rebuttal,
                    text: "Exhaustion brings them back".into(),
                    by: vec!["b".into()],
                    round: 1,
                },
                ArgNode {
                    id: "n3".into(),
                    kind: ArgNodeKind::Question,
                    text: "Has anyone measured it".into(),
                    by: vec!["c".into()],
                    round: 1,
                },
            ],
            edges: vec![
                ArgEdge {
                    id: "e1".into(),
                    from: "n2".into(),
                    to: "n1".into(),
                    relation: ArgRelation::Rebuts,
                    rationale: String::new(),
                },
                ArgEdge {
                    id: "e2".into(),
                    from: "n3".into(),
                    to: "n2".into(),
                    relation: ArgRelation::Addresses,
                    rationale: String::new(),
                },
            ],
            missing: vec!["Revision".into()],
        });
        let ctx = Ctx::new(&v, &seats, None);
        let out = text(&lines(AnalysisView::Map, &ctx, 100));
        let root = out.find("Ranked choice removes spoilers").unwrap();
        let rebut = out.find("rebuts").unwrap();
        let question = out.find("addresses").unwrap();
        assert!(root < rebut && rebut < question, "{out}");
        assert!(out.contains("└─"));
        assert!(out.contains("Not mapped") && out.contains("Revision"));
    }

    #[test]
    fn a_cycle_in_the_map_terminates() {
        let (mut v, seats) = base();
        v.arg_graph = Some(ArgGraph {
            nodes: vec![
                ArgNode {
                    id: "n1".into(),
                    kind: ArgNodeKind::Claim,
                    text: "X".into(),
                    by: vec!["a".into()],
                    round: 0,
                },
                ArgNode {
                    id: "n2".into(),
                    kind: ArgNodeKind::Claim,
                    text: "Y".into(),
                    by: vec!["b".into()],
                    round: 0,
                },
            ],
            edges: vec![
                ArgEdge {
                    id: "e1".into(),
                    from: "n1".into(),
                    to: "n2".into(),
                    relation: ArgRelation::Rebuts,
                    rationale: String::new(),
                },
                ArgEdge {
                    id: "e2".into(),
                    from: "n2".into(),
                    to: "n1".into(),
                    relation: ArgRelation::Rebuts,
                    rationale: String::new(),
                },
            ],
            missing: vec![],
        });
        let ctx = Ctx::new(&v, &seats, None);
        let out = text(&lines(AnalysisView::Map, &ctx, 80));
        assert!(out.contains("(above)"), "{out}");
    }

    #[test]
    fn a_seat_name_wider_than_the_canvas_is_cut_and_wide_glyphs_read_back_true() {
        let (mut v, _) = base();
        v.peer_eval = Some(peer());
        let seats = vec![
            seat("a", "Extraordinarily Long Seat Name, the Third"),
            seat("b", "精神分析学者の席精神分析学者の席精神分析学"),
            seat("c", "Cara"),
        ];
        let ctx = Ctx::new(&v, &seats, None);
        for width in 34..=80 {
            let out = lines(AnalysisView::Critique, &ctx, width);
            let cols = width.saturating_sub(4).clamp(30, 72);
            let rows = (cols / 3).clamp(12, 20);
            let left = width.saturating_sub(cols) / 2;
            // Every canvas row is exactly the canvas wide: a wide glyph is
            // read back once, not with the blank cell it hides.
            for line in &out[..rows] {
                assert_eq!(line.width(), left + cols, "at {width}: {line:?}");
            }
        }
    }

    #[test]
    fn the_vote_bar_splits_exactly_however_many_blocs() {
        for (n, bar) in [(12, 42), (16, 72), (3, 10), (7, 5), (1, 42)] {
            let widths = segment_widths(&vec![1; n], bar);
            assert_eq!(widths.iter().sum::<usize>(), bar, "{n} blocs in {bar}");
            if bar >= 2 * n {
                assert!(widths.iter().all(|w| *w >= 2), "{widths:?}");
            }
        }
        assert_eq!(segment_widths(&[3, 1], 40), vec![29, 11]);
    }

    #[test]
    fn many_distinct_votes_draw_every_bloc_visibly() {
        let (mut v, _) = base();
        let ids: Vec<String> = (0..12).map(|i| format!("s{i}")).collect();
        let seats: Vec<SeatCard> = ids.iter().map(|id| seat(id, id)).collect();
        let votes: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), id.as_str())).collect();
        v.record = Some(record(&votes));
        let ctx = Ctx::new(&v, &seats, None);
        // The reported case: twelve blocs on a 50-column terminal.
        let _ = lines(AnalysisView::Vote, &ctx, 46);
        let out = lines(AnalysisView::Vote, &ctx, 80);
        let segments: Vec<_> = out[0]
            .spans
            .iter()
            .filter(|s| s.content.contains('█'))
            .collect();
        assert_eq!(segments.len(), 12);
        assert!(segments.iter().all(|s| s.style.fg != Some(theme::BG)));
    }

    #[test]
    fn a_blank_vote_is_no_vote() {
        let (mut v, seats) = base();
        v.record = Some(record(&[("a", "yes "), ("b", "  "), ("c", "")]));
        let m = seat_metrics(&v, &seats);
        assert_eq!(m[1].vote, None);
        assert_eq!(vote_split(&m), vec![("yes".to_string(), vec![0])]);
    }

    #[test]
    fn every_view_survives_a_very_narrow_terminal() {
        let (mut v, seats) = base();
        v.peer_eval = Some(peer());
        let ctx = Ctx::new(&v, &seats, Some(2));
        for view in AnalysisView::ALL {
            let _ = lines(view, &ctx, 20);
        }
    }
}
