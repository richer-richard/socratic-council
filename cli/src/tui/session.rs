//! The Session screen — the deliberation as the engine runs it: a header
//! with the phase trail and the cost, a main column with the decision record
//! first, then the document, the rounds (seat cards with tool chips), the
//! moderator's notes; a side column with the plan, the board, the
//! convergence judgements, the cost ledger or the seats; and two overlays
//! that answer the moderator's question and approve a tool call.

use super::{theme, App, SeatCard, SessionScreen, SideTab};
use crate::deliberation::{Board, Convergence, DecisionRecord, Plan, Recommend, SeatRole};
use crate::store::StoredMessage;
use crate::text::sanitize_terminal as clean;
use crate::tui::view::{RoundView, SeatTurn, SessionView};
use crate::types::CostSnapshot;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use std::collections::BTreeMap;

pub fn render(f: &mut Frame, area: Rect, app: &mut App) {
    let frame = app.frame;
    let Some(s) = app.session.as_mut() else {
        return;
    };
    let rows = Layout::vertical([
        Constraint::Length(3), // header
        Constraint::Min(0),    // body
        Constraint::Length(1), // footer
    ])
    .split(area);

    render_header(f, rows[0], s);

    let wide = rows[1].width >= 90;
    let body = if wide {
        Layout::horizontal([Constraint::Percentage(64), Constraint::Percentage(36)]).split(rows[1])
    } else {
        Layout::horizontal([Constraint::Percentage(100)]).split(rows[1])
    };
    render_main(f, body[0], s, frame);
    if wide {
        render_side(f, body[1], s, frame);
    }
    render_footer(f, rows[2], s);

    if let Some(q) = s.view.pending_question.clone() {
        render_question(f, area, &q.question, &s.answer, frame);
    } else if let Some(a) = s.view.pending_approval.clone() {
        let who = s
            .seat(&a.seat_id)
            .map(|c| c.name.clone())
            .unwrap_or(a.seat_id.clone());
        render_approval(f, area, &who, &a.call.name, &a.call.arguments.to_string());
    }
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

fn render_header(f: &mut Frame, area: Rect, s: &SessionScreen) {
    let chip = Span::styled(
        "  Socratic Council  ",
        Style::default()
            .fg(Color::Black)
            .bg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    );
    let topic = Span::styled(
        format!(
            "  {}",
            truncate(&s.topic, area.width.saturating_sub(24) as usize)
        ),
        Style::default().fg(theme::TEXT),
    );

    let (status, status_color) = s.status();
    let mut meta = vec![Span::styled(
        format!(" {status} "),
        Style::default()
            .fg(Color::Black)
            .bg(status_color)
            .add_modifier(Modifier::BOLD),
    )];
    if let Some(d) = s.view.deliverable() {
        meta.push(Span::styled(
            format!("  {}", d.label()),
            Style::default().fg(theme::MUTED),
        ));
    }
    if !s.view.phases.is_empty() {
        meta.push(Span::styled("  ", Style::default()));
        let n = s.view.phases.len();
        for (i, p) in s.view.phases.iter().enumerate() {
            let last = i + 1 == n;
            meta.push(Span::styled(
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
                meta.push(Span::styled(" ▸ ", Style::default().fg(theme::DIM)));
            }
        }
    }
    if let Some(e) = &s.view.estimate {
        meta.push(Span::styled(
            format!("  ≈ ${:.2}–${:.2}", e.usd_low, e.usd_high),
            Style::default().fg(theme::DIM),
        ));
    }
    if let Some(c) = &s.view.cost {
        let approx = if c.all_priced { "" } else { "≥" };
        let style = if c.note.is_some() {
            Style::default()
                .fg(theme::GOLD)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme::MUTED)
        };
        meta.push(Span::styled(
            format!("  {approx}${:.4}", c.total_usd),
            style,
        ));
    }
    let para = Paragraph::new(vec![Line::from(vec![chip, topic]), Line::from(meta)]).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::GOLD)),
    );
    f.render_widget(para, area);
}

fn render_footer(f: &mut Frame, area: Rect, s: &SessionScreen) {
    let mut spans = Vec::new();
    let hint = |spans: &mut Vec<Span<'static>>, k: &str, what: &str| {
        spans.push(key(k));
        spans.push(Span::styled(
            format!(" {what}  "),
            Style::default().fg(theme::MUTED),
        ));
    };
    if s.is_live() {
        hint(&mut spans, "Esc", "stop");
    } else {
        hint(&mut spans, "Esc", "home");
        hint(&mut spans, "r", "reconvene");
        hint(&mut spans, "e", "export");
    }
    hint(&mut spans, "Tab", "sessions");
    hint(&mut spans, "t", "thinking");
    hint(&mut spans, "p b v $ s", "panes");
    hint(&mut spans, "↑↓", "scroll");
    hint(&mut spans, "g", "follow");
    if s.is_live() {
        spans.push(Span::styled(
            "· deliberating…",
            Style::default().fg(theme::GOLD),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------

fn render_main(f: &mut Frame, area: Rect, s: &mut SessionScreen, frame: u64) {
    let names = s.names();
    let mut lines: Vec<Line<'static>> = Vec::new();
    let v = &s.view;

    for e in &v.errors {
        lines.push(Line::from(Span::styled(
            format!("⚠ {e}"),
            Style::default().fg(theme::ROSE),
        )));
    }
    if !v.errors.is_empty() {
        lines.push(Line::from(""));
    }
    if let Some(r) = &v.record {
        push_record(&mut lines, r, &names);
    }
    if let Some((dir, files)) = &v.handoff {
        push_section(&mut lines, "Hand-off");
        lines.push(Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(dir.clone(), Style::default().fg(theme::TEXT)),
        ]));
        lines.push(Line::from(Span::styled(
            format!("  {}", files.join(" · ")),
            Style::default().fg(theme::DIM),
        )));
        lines.push(Line::from(""));
    }
    if let Some(d) = &v.document {
        push_section(&mut lines, "Document");
        for line in d.lines() {
            lines.push(Line::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(theme::TEXT),
            )));
        }
        lines.push(Line::from(""));
    }
    for round in &v.rounds {
        push_round(&mut lines, round, s, frame);
    }
    if !v.moderator_notes.is_empty() {
        push_section(&mut lines, "Moderator");
        for n in &v.moderator_notes {
            for line in n.lines() {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default()
                        .fg(theme::MUTED)
                        .add_modifier(Modifier::ITALIC),
                )));
            }
        }
        lines.push(Line::from(""));
    }
    if !v.legacy.is_empty() {
        push_legacy(&mut lines, &v.legacy, s.show_thinking);
    }
    if lines.is_empty() {
        let phase = v.phase.as_deref().unwrap_or("Convening");
        let dots = ".".repeat(((frame / 6) % 4) as usize);
        lines.push(Line::from(Span::styled(
            format!("  {phase}{dots}"),
            Style::default().fg(theme::DIM),
        )));
    }

    let inner_h = area.height.saturating_sub(2);
    let inner_w = area.width.saturating_sub(2);
    // Count post-wrap rows so the scroll clamp reaches the newest row.
    let total = u16::try_from(wrapped_row_count(&lines, inner_w)).unwrap_or(u16::MAX);
    let max_off = total.saturating_sub(inner_h);
    let scroll = if s.follow {
        s.scroll = max_off;
        max_off
    } else {
        s.scroll = s.scroll.min(max_off);
        s.scroll
    };

    let title = if s.read_only {
        " Deliberation · saved "
    } else {
        " Deliberation "
    };
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

/// Total post-wrap rows `lines` occupy at `width` (matching ratatui's `Wrap`).
fn wrapped_row_count(lines: &[Line<'_>], width: u16) -> usize {
    let w = width.max(1) as usize;
    lines
        .iter()
        .map(|line| {
            let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
            if text.trim().is_empty() {
                1
            } else {
                textwrap::wrap(&text, w).len().max(1)
            }
        })
        .sum()
}

fn push_section(lines: &mut Vec<Line<'static>>, title: &str) {
    lines.push(Line::from(Span::styled(
        format!("── {title} ──"),
        Style::default()
            .fg(theme::GOLD)
            .add_modifier(Modifier::BOLD),
    )));
}

fn push_round(lines: &mut Vec<Line<'static>>, round: &RoundView, s: &SessionScreen, frame: u64) {
    push_section(lines, &round.label());
    for turn in &round.entries {
        push_turn(lines, turn, s, frame);
    }
    if round.entries.is_empty() {
        lines.push(Line::from(Span::styled(
            "  (no contributions)",
            Style::default().fg(theme::DIM),
        )));
        lines.push(Line::from(""));
    }
}

fn push_turn(lines: &mut Vec<Line<'static>>, t: &SeatTurn, s: &SessionScreen, frame: u64) {
    let color = s
        .seat(&t.seat_id)
        .map(|c| c.color)
        .or_else(|| t.provider.map(theme::provider_color))
        .unwrap_or_else(|| theme::speaker_color(&t.seat_id));
    let live = !t.done;
    let marker = if live {
        if frame % 12 < 6 {
            "● "
        } else {
            "◉ "
        }
    } else {
        "○ "
    };
    let mut header = vec![
        Span::styled(marker, Style::default().fg(color)),
        Span::styled(
            t.name.clone(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
    ];
    if !t.model.is_empty() {
        header.push(Span::styled(
            format!(" · {}", t.model),
            Style::default().fg(theme::DIM),
        ));
    }
    if let Some(u) = &t.usage {
        header.push(Span::styled(
            format!(
                " · {} in / {} out{}",
                compact(u.input),
                compact(u.output),
                if u.reasoning > 0 {
                    format!(" / {} reasoning", compact(u.reasoning))
                } else {
                    String::new()
                }
            ),
            Style::default().fg(theme::DIM),
        ));
    }
    if live {
        header.push(Span::styled(" ▌", Style::default().fg(color)));
    }
    lines.push(Line::from(header));

    // The reasoning trace, collapsed behind `t`.
    if !t.thinking.trim().is_empty() {
        let caret = if s.show_thinking { "⌃" } else { "⌄" };
        lines.push(Line::from(Span::styled(
            format!("  {caret} thinking · {} chars", t.thinking.chars().count()),
            Style::default().fg(theme::MUTED),
        )));
        if s.show_thinking {
            for line in t.thinking.lines() {
                lines.push(Line::from(Span::styled(
                    format!("    {line}"),
                    Style::default()
                        .fg(theme::DIM)
                        .add_modifier(Modifier::ITALIC),
                )));
            }
        }
    }
    for u in &t.tool_uses {
        let args = compact_args(&u.call.arguments);
        let (tail, tail_color) = match &u.error {
            Some(e) => (format!("→ ERROR {}", truncate(e, 60)), theme::ROSE),
            None => (
                format!("→ {}", truncate(&u.output.replace('\n', " "), 60)),
                theme::DIM,
            ),
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("  ⚙ {}", u.call.name),
                Style::default().fg(theme::CYAN),
            ),
            Span::styled(format!(" {args} "), Style::default().fg(theme::MUTED)),
            Span::styled(tail, Style::default().fg(tail_color)),
        ]));
    }
    let body = if t.text.trim().is_empty() && live {
        "…".to_string()
    } else {
        t.text.clone()
    };
    for line in body.lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default().fg(theme::TEXT),
        )));
    }
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
                format!("{k}={}", truncate(&clean(&shown), 40))
            })
            .collect::<Vec<_>>()
            .join(" "),
        None => truncate(&clean(&args.to_string()), 60),
    }
}

fn push_record(lines: &mut Vec<Line<'static>>, r: &DecisionRecord, names: &Names) {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    push_section(lines, "Decision record");
    if !r.question.trim().is_empty() {
        lines.push(Line::from(Span::styled(
            format!("  {}", clean(&r.question)),
            Style::default().fg(theme::MUTED),
        )));
    }
    for line in clean(&r.answer).lines() {
        lines.push(Line::from(Span::styled(
            format!("  {line}"),
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        )));
    }
    let pct = (r.confidence.clamp(0.0, 1.0) * 100.0).round() as u32;
    let filled = ((r.confidence.clamp(0.0, 1.0) * 10.0).round() as usize).min(10);
    let bar: String = "▰".repeat(filled) + &"▱".repeat(10 - filled);
    lines.push(Line::from(vec![
        Span::styled("  confidence ", Style::default().fg(theme::MUTED)),
        Span::styled(bar, Style::default().fg(confidence_color(r.confidence))),
        Span::styled(format!(" {pct}%"), Style::default().fg(theme::MUTED)),
    ]));
    if !r.votes.is_empty() {
        let votes: Vec<String> = r
            .votes
            .iter()
            .map(|(id, v)| format!("{} → {}", name(id), clean(v)))
            .collect();
        lines.push(labelled("  votes    ", &votes.join(" · ")));
    }
    if !r.what_changed.trim().is_empty() {
        lines.push(labelled("  changed  ", &clean(&r.what_changed)));
    }
    for d in &r.dissent {
        lines.push(Line::from(vec![
            Span::styled(
                format!("  dissent  {}: ", name(&d.seat)),
                Style::default().fg(theme::ROSE),
            ),
            Span::styled(
                format!("{} — {}", clean(&d.position), clean(&d.why_not_carried)),
                Style::default().fg(theme::MUTED),
            ),
        ]));
    }
    push_list(
        lines,
        "options considered",
        &mut r
            .options_considered
            .iter()
            .map(|o| format!("{} — {}", clean(&o.option), clean(&o.why_not))),
    );
    push_list(
        lines,
        "assumptions",
        &mut r.assumptions.iter().map(|a| clean(a)),
    );
    push_list(
        lines,
        "evidence",
        &mut r
            .evidence
            .iter()
            .map(|e| evidence_line(&e.claim, &e.source, &name(&e.by))),
    );
    push_list(
        lines,
        "open questions",
        &mut r.open_questions.iter().map(|q| clean(q)),
    );
    push_list(
        lines,
        "next actions",
        &mut r.next_actions.iter().map(|n| clean(n)),
    );
    lines.push(Line::from(""));
}

fn push_list(lines: &mut Vec<Line<'static>>, label: &str, items: &mut dyn Iterator<Item = String>) {
    let items: Vec<String> = items.collect();
    if items.is_empty() {
        return;
    }
    lines.push(Line::from(Span::styled(
        format!("  {label}"),
        Style::default()
            .fg(theme::MUTED)
            .add_modifier(Modifier::BOLD),
    )));
    for item in items {
        lines.push(Line::from(vec![
            Span::styled("    • ", Style::default().fg(theme::DIM)),
            Span::styled(item, Style::default().fg(theme::MUTED)),
        ]));
    }
}

type Names = BTreeMap<String, String>;

fn push_legacy(lines: &mut Vec<Line<'static>>, legacy: &[StoredMessage], show_thinking: bool) {
    push_section(lines, "Transcript (pre-v3 session)");
    for m in legacy {
        let color = theme::speaker_color(&m.agent_id);
        let mut header = vec![Span::styled(
            m.display_name.clone(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )];
        if !m.model.is_empty() {
            header.push(Span::styled(
                format!(" · {}", m.model),
                Style::default().fg(theme::DIM),
            ));
        }
        lines.push(Line::from(header));
        if show_thinking && !m.thinking.trim().is_empty() {
            for line in m.thinking.lines() {
                lines.push(Line::from(Span::styled(
                    format!("    {line}"),
                    Style::default()
                        .fg(theme::DIM)
                        .add_modifier(Modifier::ITALIC),
                )));
            }
        }
        for line in m.content.lines() {
            lines.push(Line::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(theme::TEXT),
            )));
        }
        lines.push(Line::from(""));
    }
}

// ---------------------------------------------------------------------------
// Side column
// ---------------------------------------------------------------------------

fn render_side(f: &mut Frame, area: Rect, s: &SessionScreen, frame: u64) {
    let rows = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).split(area);
    // The tab strip.
    let mut spans = Vec::new();
    for tab in SideTab::ALL {
        let on = tab == s.side;
        spans.push(Span::styled(
            format!(" {} ", tab.label()),
            if on {
                Style::default()
                    .fg(Color::Black)
                    .bg(theme::GOLD)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), rows[0]);

    let names = s.names();
    let lines = match s.side {
        SideTab::Plan => plan_lines(s.view.plan.as_ref(), &s.view.corrections, &names),
        SideTab::Board => board_lines(s.view.board.as_ref(), &names),
        SideTab::Convergence => convergence_lines(&s.view.convergences, &names),
        SideTab::Cost => cost_lines(s.view.cost.as_ref(), &s.view, rows[1].width),
        SideTab::Seats => seat_lines(&s.seats, &s.view, frame),
    };
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::DIM))
            .title(Span::styled(
                format!(" {} ", s.side.label()),
                Style::default().fg(theme::MUTED),
            )),
    );
    f.render_widget(para, rows[1]);
}

fn plan_lines(plan: Option<&Plan>, corrections: &[String], names: &Names) -> Vec<Line<'static>> {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let Some(p) = plan else {
        return vec![Line::from(Span::styled(
            " the moderator is framing…",
            Style::default().fg(theme::DIM),
        ))];
    };
    let mut lines = vec![
        kv("deliverable", p.deliverable.label(), theme::GOLD),
        kv("rounds", &p.rounds.to_string(), theme::TEXT),
    ];
    if !p.question.trim().is_empty() {
        lines.push(kv("question", &clean(&p.question), theme::TEXT));
    }
    if !p.settles.trim().is_empty() {
        lines.push(kv("settles", &clean(&p.settles), theme::MUTED));
    }
    if !p.options.is_empty() {
        lines.push(heading("options"));
        for o in &p.options {
            lines.push(bullet(&clean(o), theme::TEXT));
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
                    Style::default().fg(theme::speaker_color(&part.seat)),
                ),
                Span::styled(role.to_string(), Style::default().fg(theme::GOLD)),
                Span::styled(
                    format!(" · {}", clean(&part.reason)),
                    Style::default().fg(theme::DIM),
                ),
            ]));
        }
    }
    if !p.lenses.is_empty() {
        lines.push(heading("lenses"));
        for (seat, lens) in &p.lenses {
            lines.push(bullet(
                &format!("{}: {}", name(seat), clean(lens)),
                theme::MUTED,
            ));
        }
    }
    if !p.subtasks.is_empty() {
        lines.push(heading("prep subtasks"));
        for t in &p.subtasks {
            lines.push(bullet(
                &format!("{}: {}", name(&t.seat), clean(&t.task)),
                theme::MUTED,
            ));
        }
    }
    if let Some(q) = p.ask_user.as_deref().filter(|q| !q.trim().is_empty()) {
        lines.push(kv("asked you", &clean(q), theme::MUTED));
    }
    if !corrections.is_empty() {
        lines.push(heading("corrections"));
        for c in corrections {
            lines.push(bullet(c, theme::DIM));
        }
    }
    lines
}

fn board_lines(board: Option<&Board>, names: &Names) -> Vec<Line<'static>> {
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
        lines.push(bullet(&clean(s), theme::EMERALD));
    }
    lines.push(heading(&format!(
        "disagreements · {}",
        b.disagreements.len()
    )));
    for d in &b.disagreements {
        let who: Vec<String> = d.between.iter().map(|id| name(id)).collect();
        lines.push(bullet(
            &format!("{}: {}", who.join(" ↔ "), clean(&d.about)),
            theme::ROSE,
        ));
    }
    if !b.evidence.is_empty() {
        lines.push(heading(&format!("evidence · {}", b.evidence.len())));
        for e in &b.evidence {
            lines.push(bullet(
                &evidence_line(&e.claim, &e.source, &name(&e.by)),
                theme::MUTED,
            ));
        }
    }
    if !b.open_questions.is_empty() {
        lines.push(heading("open questions"));
        for q in &b.open_questions {
            lines.push(bullet(&clean(q), theme::TEXT));
        }
    }
    if !b.positions.is_empty() {
        lines.push(heading("positions"));
        for (seat, pos) in &b.positions {
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {} ", name(seat)),
                    Style::default().fg(theme::speaker_color(seat)),
                ),
                Span::styled(clean(pos), Style::default().fg(theme::MUTED)),
            ]));
        }
    }
    lines
}

fn convergence_lines(list: &[Convergence], names: &Names) -> Vec<Line<'static>> {
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
        lines.push(bullet(&moved, theme::MUTED));
        if !c.why.trim().is_empty() {
            lines.push(bullet(&clean(&c.why), theme::DIM));
        }
    }
    lines
}

fn cost_lines(cost: Option<&CostSnapshot>, v: &SessionView, width: u16) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if let Some(e) = &v.estimate {
        lines.push(kv(
            "estimate",
            &format!(
                "${:.2}–${:.2} over {} calls",
                e.usd_low, e.usd_high, e.calls
            ),
            theme::MUTED,
        ));
        if !e.unpriced_seats.is_empty() {
            lines.push(kv("unpriced", &e.unpriced_seats.join(", "), theme::DIM));
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
                format!(" {:<9}", truncate(&row.name, 9)),
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
        format!(" {}", "─".repeat((width.saturating_sub(4)) as usize)),
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
                    format!("{:<9}", truncate(&c.name, 9)),
                    if active {
                        Style::default().fg(c.color).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::TEXT)
                    },
                ),
                Span::styled(
                    truncate(
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

fn render_question(f: &mut Frame, area: Rect, question: &str, answer: &str, frame: u64) {
    if area.width < 12 || area.height < 6 {
        return;
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
}

fn render_approval(f: &mut Frame, area: Rect, who: &str, tool: &str, args: &str) {
    if area.width < 12 || area.height < 6 {
        return;
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
                truncate(&clean(args), 200),
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

fn bullet(text: &str, color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled("  • ", Style::default().fg(theme::DIM)),
        Span::styled(text.to_string(), Style::default().fg(color)),
    ])
}

fn kv(label: &str, value: &str, color: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!(" {label:<12}"), Style::default().fg(theme::MUTED)),
        Span::styled(value.to_string(), Style::default().fg(color)),
    ])
}

fn labelled(label: &str, value: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            label.to_string(),
            Style::default()
                .fg(theme::MUTED)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(value.to_string(), Style::default().fg(theme::MUTED)),
    ])
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

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
