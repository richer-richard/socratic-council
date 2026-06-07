//! Chat view — the debate chamber: a streaming transcript, the live roster,
//! a header with running usage, and a keybinding footer.

use super::{theme, App, Debate, TurnView, VoteBoard};
use crate::types::{
    ConclusionStatus, Confidence, DeepResearchReport, ModeratorConclusion, PeerEvalRound, VoteChoice,
};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
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
        push_turn(&mut lines, turn, d.show_thinking, false);
    }
    if let Some(s) = &d.streaming {
        push_turn(&mut lines, s, d.show_thinking, true);
    }
    for board in &d.vote_boards {
        push_vote_board(&mut lines, board);
    }
    if let Some(round) = &d.peer_eval {
        push_scorecard(&mut lines, round);
    }
    if let Some(c) = &d.conclusion {
        push_conclusion(&mut lines, c);
    }
    if let Some(r) = &d.deep_research {
        push_research(&mut lines, r);
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

fn push_turn(lines: &mut Vec<Line<'static>>, t: &TurnView, show_thinking: bool, streaming: bool) {
    let color = theme::speaker_color(&t.agent_id);
    let name = if streaming { format!("{} ▌", t.name) } else { t.name.clone() };
    let mut header =
        vec![Span::styled(name, Style::default().fg(color).add_modifier(Modifier::BOLD))];
    if !t.model.is_empty() {
        header.push(Span::styled(format!("  {}", t.model), Style::default().fg(theme::DIM)));
    }
    lines.push(Line::from(header));

    // Collapsible reasoning panel — quarantined above the spoken text, like the
    // app. A dim one-line summary is always visible; the body shows when `t` is on.
    if !t.thinking.trim().is_empty() {
        let caret = if show_thinking { "⌃" } else { "⌄" };
        let summary = if streaming && t.content.trim().is_empty() {
            "  ⌄ thinking…".to_string()
        } else if t.thinking_ms > 0 {
            format!("  {caret} Thought for {:.1}s", t.thinking_ms as f64 / 1000.0)
        } else {
            format!("  {caret} reasoning")
        };
        lines.push(Line::from(Span::styled(summary, Style::default().fg(theme::MUTED))));
        if show_thinking {
            for line in t.thinking.lines() {
                lines.push(Line::from(Span::styled(
                    format!("    {line}"),
                    Style::default().fg(theme::DIM).add_modifier(Modifier::ITALIC),
                )));
            }
        }
    }

    // Committed turns are already directive-stripped; scrub the *live* stream
    // each frame so a half-typed @canvas/@end or a <think> span never flashes.
    let body = if streaming {
        crate::engine::strip_directives(&t.content).0
    } else {
        t.content.clone()
    };
    for line in body.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default().fg(theme::TEXT),
        )));
    }

    // Collapsible private canvas (the agent's own scratchpad), keyed by its color.
    if !t.canvas.is_empty() {
        let color = theme::speaker_color(&t.agent_id);
        let caret = if show_thinking { "⌃" } else { "⌄" };
        let n = t.canvas.len();
        lines.push(Line::from(Span::styled(
            format!("  {caret} ⌗ canvas · {n} section{}", if n == 1 { "" } else { "s" }),
            Style::default().fg(color),
        )));
        if show_thinking {
            for sec in &t.canvas {
                lines.push(Line::from(Span::styled(
                    format!("    {}", sec.label),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                )));
                for line in sec.text.lines() {
                    lines.push(Line::from(Span::styled(
                        format!("      {line}"),
                        Style::default().fg(theme::DIM),
                    )));
                }
            }
        }
    }

    lines.push(Line::from(""));
}

/// The moderator's final scored verdict, rendered as a gold-accented card.
fn push_conclusion(lines: &mut Vec<Line<'static>>, c: &ModeratorConclusion) {
    let status_color = match c.status {
        ConclusionStatus::Consensus => Color::Rgb(0x34, 0xD3, 0x99),
        ConclusionStatus::Majority => theme::GOLD,
        ConclusionStatus::Unresolved => Color::Rgb(0xFB, 0x71, 0x85),
    };
    lines.push(Line::from(Span::styled(
        "  ── Council Verdict ──────────────────────────────",
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(vec![
        Span::styled(
            format!("  {} {}", c.status.glyph(), c.status.label()),
            Style::default().fg(status_color).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("    Score {}/10", c.score),
            Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
        ),
    ]));
    for line in c.summary.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        )));
    }
    if !c.reason.trim().is_empty() {
        lines.push(labelled("  Reason  ", &c.reason));
    }
    if let Some(next) = c.next.as_deref().filter(|n| !n.trim().is_empty()) {
        lines.push(labelled("  Next    ", next));
    }
    lines.push(Line::from(""));
}

/// An end-vote round, rendered as a tally card.
fn push_vote_board(lines: &mut Vec<Line<'static>>, b: &VoteBoard) {
    lines.push(Line::from(Span::styled(
        format!(
            "  ── End Vote · moved by {} ──  (needs {}/{} YES)",
            b.proposer, b.threshold, b.total
        ),
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
    )));
    for (name, choice, reason) in &b.votes {
        let mut spans = vec![
            Span::styled(format!("  {:<9}", name), Style::default().fg(theme::TEXT)),
            Span::styled(
                format!("{:<8}", choice.label()),
                Style::default().fg(vote_color(*choice)).add_modifier(Modifier::BOLD),
            ),
        ];
        if !reason.trim().is_empty() {
            spans.push(Span::styled(truncate(reason, 56), Style::default().fg(theme::DIM)));
        }
        lines.push(Line::from(spans));
    }
    if let Some(r) = &b.result {
        let (label, color) = if r.passed {
            ("PASSED", Color::Rgb(0x34, 0xD3, 0x99))
        } else {
            ("FAILED", Color::Rgb(0xFB, 0x71, 0x85))
        };
        lines.push(Line::from(vec![
            Span::styled("  Result: ", Style::default().fg(theme::MUTED)),
            Span::styled(label, Style::default().fg(color).add_modifier(Modifier::BOLD)),
            Span::styled(
                format!("  — YES {} · NO {} · ABSTAIN {}", r.yes, r.no, r.abstain),
                Style::default().fg(theme::MUTED),
            ),
        ]));
    }
    lines.push(Line::from(""));
}

/// The closing peer-evaluation scorecard: a ranked heatmap + sharpest critiques.
fn push_scorecard(lines: &mut Vec<Line<'static>>, round: &PeerEvalRound) {
    lines.push(Line::from(Span::styled(
        format!("  ── Peer Review Scorecard · {} critiques ──", round.critiques.len()),
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        "   #  Agent       rig  evi  nov  civ  top    avg",
        Style::default().fg(theme::MUTED),
    )));
    for s in &round.summaries {
        let mut spans = vec![
            Span::styled(format!("  #{} ", s.rank), Style::default().fg(theme::GOLD)),
            Span::styled(
                format!("{:<9} ", s.name),
                Style::default().fg(theme::speaker_color(&s.agent_id)).add_modifier(Modifier::BOLD),
            ),
        ];
        for v in [s.avg.rigor, s.avg.evidence, s.avg.novelty, s.avg.civility, s.avg.on_topic] {
            spans.push(Span::styled(format!("{v:>3}  "), Style::default().fg(score_color(v))));
        }
        spans.push(Span::styled(
            format!("  {:>3}", s.overall),
            Style::default().fg(score_color(s.overall)).add_modifier(Modifier::BOLD),
        ));
        lines.push(Line::from(spans));
    }
    if round.summaries.iter().any(|s| s.standout.is_some()) {
        lines.push(Line::from(Span::styled(
            "  Sharpest critiques:",
            Style::default().fg(theme::MUTED),
        )));
        for s in &round.summaries {
            if let Some(c) = &s.standout {
                lines.push(Line::from(Span::styled(
                    format!("   {} ← {}", s.name, truncate(c, 78)),
                    Style::default().fg(theme::DIM),
                )));
            }
        }
    }
    lines.push(Line::from(""));
}

/// The deep-research report — title, abstract, and confidence-tagged sections.
fn push_research(lines: &mut Vec<Line<'static>>, r: &DeepResearchReport) {
    lines.push(Line::from(Span::styled(
        "  ══ Deep Research Report ══",
        Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
    )));
    if !r.title.is_empty() {
        lines.push(Line::from(vec![
            Span::styled(
                format!("  {}", r.title),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("   [{}]", r.confidence.label()),
                Style::default().fg(conf_color(r.confidence)),
            ),
        ]));
    }
    for line in r.abstract_text.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default().fg(theme::MUTED),
        )));
    }
    for sec in &r.sections {
        lines.push(Line::from(vec![
            Span::styled(
                format!("  ▸ {}", sec.heading),
                Style::default().fg(theme::GOLD).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  [{}]", sec.confidence.label()),
                Style::default().fg(conf_color(sec.confidence)),
            ),
        ]));
        for line in sec.body.lines() {
            lines.push(Line::from(Span::styled(
                format!("    {line}"),
                Style::default().fg(theme::TEXT),
            )));
        }
    }
    lines.push(Line::from(""));
}

fn conf_color(c: Confidence) -> Color {
    match c {
        Confidence::High => Color::Rgb(0x34, 0xD3, 0x99),
        Confidence::Medium => theme::GOLD,
        Confidence::Low => Color::Rgb(0xFB, 0x71, 0x85),
    }
}

fn score_color(v: u8) -> Color {
    if v >= 75 {
        Color::Rgb(0x34, 0xD3, 0x99) // emerald — gilds as scores climb
    } else if v >= 45 {
        theme::MUTED
    } else {
        Color::Rgb(0xFB, 0x71, 0x85) // terracotta — reddens as scores drop
    }
}

fn vote_color(c: VoteChoice) -> Color {
    match c {
        VoteChoice::Yes => Color::Rgb(0x34, 0xD3, 0x99),
        VoteChoice::No => Color::Rgb(0xFB, 0x71, 0x85),
        VoteChoice::Abstain => theme::MUTED,
    }
}

fn labelled(label: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(label.to_string(), Style::default().fg(theme::MUTED).add_modifier(Modifier::BOLD)),
        Span::styled(value.to_string(), Style::default().fg(theme::MUTED)),
    ])
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
