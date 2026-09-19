//! Compatibility layer for the surfaces that still speak the old event
//! vocabulary: the old `DebateEvent` enum, an adapter from the deliberation
//! engine's events, the directive stripper the TUI applies to stored text,
//! and the transcript `Turn`. The chat loop itself is gone; the engine is
//! `crate::deliberation`.

pub use crate::cost;
use crate::deliberation::{self, record, Recommend};
pub use crate::text::sanitize_terminal;
use crate::types::{
    AdvisorNote, CanvasSection, ConclusionStatus, CostSnapshot, DeepResearchReport,
    ModeratorConclusion, PairScore, PeerEvalRound, Provider, ToolUse, Usage, VoteChoice,
};
use std::collections::BTreeMap;

/// Events streamed from the orchestrator to whatever drives the UI.
#[derive(Debug, Clone)]
pub enum DebateEvent {
    Phase(String),
    /// A moderator note (framing / synthesis / resolution nudge).
    Moderator(String),
    /// The moderator's final scored verdict — rendered as a conclusion card.
    Conclusion(ModeratorConclusion),
    TurnStarted {
        agent_id: String,
        name: String,
        provider: Provider,
        model: String,
    },
    Token(String),
    Thinking(String),
    TurnEnded {
        usage: Usage,
        thinking_ms: u64,
    },
    /// An agent's private canvas was updated this turn.
    Canvas {
        agent_id: String,
        name: String,
        sections: Vec<CanvasSection>,
    },
    /// An agent moved to end the session — the council now votes.
    EndVoteStarted {
        proposer: String,
        threshold: u32,
        total: u32,
    },
    /// One agent's cast ballot.
    Vote {
        agent_id: String,
        name: String,
        choice: VoteChoice,
        reason: String,
    },
    /// The vote outcome.
    EndVoteResult {
        passed: bool,
        yes: u32,
        no: u32,
        abstain: u32,
    },
    /// The closing peer-evaluation scorecard.
    PeerEval(PeerEvalRound),
    /// The deep-research report (opt-in).
    DeepResearch(DeepResearchReport),
    /// An advisor slipped a private note to its council partner.
    AdvisorNote(AdvisorNote),
    /// An oracle tool ran; its result joined the shared transcript.
    Tool(ToolUse),
    /// Refreshed pairwise tension scores (after a committed turn).
    Conflict(Vec<PairScore>),
    /// Refreshed cost ledger (after anything billable).
    Cost(CostSnapshot),
    Error(String),
    Done,
}

/// Scrub model output of anything that must never reach a visible message:
/// (1) reasoning some models inline as `<think>…</think>` (MiniMax), and
/// (2) `@`-protocol directives (`@end/@canvas/@tool/@quote/@react/@handoff/@vote/
/// @done`) wherever they appear — not just at the start of a line — with balanced
/// parens, mirroring the app's `extractActions`. Returns `(clean_text,
/// requested_end)`; an `@end(...)` anywhere is the close request.
pub fn strip_directives(text: &str) -> (String, bool) {
    let text = strip_think_tags(text);

    const DIRECTIVES: [&str; 8] = [
        "@end", "@canvas", "@tool", "@quote", "@react", "@handoff", "@vote", "@done",
    ];
    let mut out = String::with_capacity(text.len());
    let mut requested_end = false;
    let mut rest: &str = &text;
    'scan: while !rest.is_empty() {
        if rest.starts_with('@') {
            for d in DIRECTIVES {
                if let Some(after) = rest.strip_prefix(d) {
                    // Require a `(` (optionally after spaces) so `@endorse`/`@ending`
                    // are left alone.
                    if let Some(inner) = after.trim_start().strip_prefix('(') {
                        if let Some(end) = balanced_paren_end(inner) {
                            if d == "@end" {
                                requested_end = true;
                            }
                            rest = &inner[end..];
                            continue 'scan;
                        }
                    }
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }

    // Collapse blank lines a removed directive line left behind, then trim.
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    let cleaned = out
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (cleaned, requested_end)
}

/// Remove `<think>…</think>` reasoning spans. A dangling open tag (truncated
/// reasoning stream) drops everything from the tag onward.
fn strip_think_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("<think>") {
        out.push_str(&rest[..open]);
        let after = &rest[open + "<think>".len()..];
        match after.find("</think>") {
            Some(close) => rest = &after[close + "</think>".len()..],
            None => return out, // unterminated reasoning — drop the remainder
        }
    }
    out.push_str(rest);
    out
}

/// Byte offset (into `s`, which begins just after an opening `(`) one past the
/// `)` that balances it. **String-literal aware**: a `(` or `)` inside a JSON
/// string value (e.g. an emoticon `":)"` or an enumeration `"see 3)"` in a
/// `@canvas` directive's text) is NOT counted, so an unbalanced bracket inside
/// the argument can't end the scan early — which would otherwise leak the
/// directive's tail (and the agent's *private* canvas notes) into the public
/// transcript.
fn balanced_paren_end(s: &str) -> Option<usize> {
    let mut depth = 1i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in s.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// One recorded transcript turn.
#[derive(Debug, Clone)]
pub struct Turn {
    pub agent_id: String,
    pub name: String,
    pub content: String,
}

/// Names for rendering (seat id → display name), from a roster.
pub type Names = BTreeMap<String, String>;

/// Translate the deliberation engine's events into the old vocabulary the
/// TUI renders. Parallel seats are serialised: a seat's whole contribution is
/// emitted at once when it finishes (start, text, end), so the single-speaker
/// transcript model never interleaves two seats. Thinking is dropped here;
/// the record and the board arrive as moderator notes.
pub fn adapt(ev: deliberation::DebateEvent, names: &Names) -> Vec<DebateEvent> {
    use deliberation::DebateEvent as E;
    match ev {
        E::Phase { name } => vec![DebateEvent::Phase(name)],
        E::Plan { corrections, .. } => {
            if corrections.is_empty() {
                Vec::new()
            } else {
                vec![DebateEvent::Moderator(format!(
                    "Plan adjusted: {}",
                    corrections.join("; ")
                ))]
            }
        }
        E::Estimate { estimate } => {
            let unpriced = if estimate.unpriced_seats.is_empty() {
                String::new()
            } else {
                format!(" (unpriced: {})", estimate.unpriced_seats.join(", "))
            };
            vec![DebateEvent::Moderator(format!(
                "Estimated cost ≈ ${:.2}–${:.2} over {} calls{unpriced}",
                estimate.usd_low, estimate.usd_high, estimate.calls
            ))]
        }
        E::UserQuestion { question, .. } => vec![DebateEvent::Moderator(format!(
            "Question for you: {question}"
        ))],
        E::SeatStarted { .. } | E::Token { .. } | E::Thinking { .. } => Vec::new(),
        E::ToolApproval { seat_id, call, .. } => vec![DebateEvent::Moderator(format!(
            "{} asks to run {}",
            names.get(&seat_id).cloned().unwrap_or(seat_id),
            call.name
        ))],
        E::ToolCall {
            seat_id,
            call,
            output,
            error,
        } => vec![DebateEvent::Tool(ToolUse {
            name: call.name,
            query: call
                .arguments
                .as_object()
                .map(|o| {
                    o.values()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
            output: match error {
                Some(e) if output.is_empty() => format!("ERROR: {e}"),
                Some(e) => format!("{output}\nERROR: {e}"),
                None => output,
            },
            agent_name: names.get(&seat_id).cloned().unwrap_or(seat_id),
        })],
        E::SeatFinished {
            seat_id,
            name,
            round,
            usage,
            content,
            ..
        } => vec![
            DebateEvent::TurnStarted {
                agent_id: seat_id,
                name: name.clone(),
                provider: Provider::OpenAI,
                model: round.label(),
            },
            DebateEvent::Token(content),
            DebateEvent::TurnEnded {
                usage,
                thinking_ms: 0,
            },
        ],
        E::Board { board } => vec![DebateEvent::Moderator(board.to_prompt_text(names))],
        E::Convergence { convergence } => vec![DebateEvent::Moderator(format!(
            "Convergence: {} ({} open, moved: {}) — {}",
            match convergence.recommend {
                Recommend::Close => "close",
                Recommend::AnotherRound => "another round",
                Recommend::Revise => "revise",
            },
            convergence.open_disagreements,
            if convergence.moved.is_empty() {
                "nobody".to_string()
            } else {
                convergence.moved.join(", ")
            },
            convergence.why
        ))],
        E::Moderator { text } => vec![DebateEvent::Moderator(text)],
        E::Record { record: r } => {
            let status = if r.dissent.is_empty() {
                ConclusionStatus::Consensus
            } else if r.confidence >= 0.5 {
                ConclusionStatus::Majority
            } else {
                ConclusionStatus::Unresolved
            };
            let md = record::to_markdown(&r, names, None);
            vec![
                DebateEvent::Conclusion(ModeratorConclusion {
                    status,
                    summary: r.answer.clone(),
                    score: (r.confidence * 10.0).round().clamp(0.0, 10.0) as u8,
                    reason: r.what_changed.clone(),
                    next: r.next_actions.first().cloned(),
                }),
                DebateEvent::Moderator(md),
            ]
        }
        E::Document { markdown } => vec![DebateEvent::Moderator(markdown)],
        E::Cost { snapshot } => vec![DebateEvent::Cost(snapshot)],
        E::Error { message } => vec![DebateEvent::Error(message)],
        E::Done { .. } => vec![DebateEvent::Done],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_directives_handles_inline_think_and_endorse() {
        // Inline @end() after prose is detected + removed.
        let (clean, end) = strip_directives("I think we're done. @end()");
        assert_eq!(clean, "I think we're done.");
        assert!(end);

        // @endorse must NOT be treated as @end.
        let (clean, end) = strip_directives("I @endorse this fully.");
        assert_eq!(clean, "I @endorse this fully.");
        assert!(!end);

        // <think> reasoning (MiniMax) is stripped from the visible text.
        let (clean, _) = strip_directives("<think>secret reasoning</think>My actual point.");
        assert_eq!(clean, "My actual point.");

        // A @canvas directive with nested JSON parens is excised whole (a blank
        // line where the directive sat is harmless).
        let (clean, _) = strip_directives(
            "Point one.\n@canvas({\"op\":\"append\",\"text\":\"a(b)c\"})\nPoint two.",
        );
        assert_eq!(clean, "Point one.\n\nPoint two.");

        // An unterminated <think> drops the remainder.
        let (clean, _) = strip_directives("visible<think>dangling");
        assert_eq!(clean, "visible");

        // A `)` inside the directive's JSON string must NOT end the scan early
        // (it would otherwise leak the `"})` tail into the visible message).
        let (clean, _) = strip_directives(
            "Real point.\n@canvas({\"op\":\"append\",\"text\":\"see item 3) here\"})\nNext.",
        );
        assert_eq!(clean, "Real point.\n\nNext.");

        // A lone `(` inside the directive's JSON string likewise stays contained
        // — the whole directive (and the private notes) is stripped, not leaked.
        let (clean, _) = strip_directives(
            "Open.\n@canvas({\"op\":\"append\",\"text\":\"post-quantum (Grover\"})\nClose.",
        );
        assert_eq!(clean, "Open.\n\nClose.");

        // Inline @end() with a parenthetical still triggers the close request.
        let (clean, end) = strip_directives("We are done. @end(\"ship it :)\")");
        assert_eq!(clean, "We are done.");
        assert!(end);
    }

    #[test]
    fn sanitize_terminal_strips_escapes_keeps_structure() {
        // OSC 52 clipboard write, CSI cursor games, and a BEL all drop;
        // newlines and tabs survive.
        let evil = "safe\n\x1b]52;c;SGVsbG8=\x07line\ttab\x1b[2Jend\r";
        let clean = sanitize_terminal(evil);
        assert_eq!(clean, "safe\n]52;c;SGVsbG8=line\ttab[2Jend");
        assert!(!clean.contains('\x1b'));
        assert!(!clean.contains('\x07'));
        assert!(!clean.contains('\r'));
    }

    #[test]
    fn adapter_serialises_a_finished_seat_and_maps_the_record() {
        let names: Names = [("a".to_string(), "Ada".to_string())].into_iter().collect();
        let out = adapt(
            deliberation::DebateEvent::SeatFinished {
                seat_id: "a".into(),
                name: "Ada".into(),
                round: deliberation::RoundKind::Positions,
                usage: Usage::default(),
                content: "yes".into(),
                structured: serde_json::json!({}),
            },
            &names,
        );
        assert!(matches!(&out[0], DebateEvent::TurnStarted { name, .. } if name == "Ada"));
        assert!(matches!(&out[1], DebateEvent::Token(t) if t == "yes"));
        assert!(matches!(&out[2], DebateEvent::TurnEnded { .. }));
        let rec = deliberation::DecisionRecord {
            deliverable: deliberation::Deliverable::Analysis,
            question: "q".into(),
            answer: "A".into(),
            confidence: 0.8,
            options_considered: vec![],
            dissent: vec![],
            assumptions: vec![],
            evidence: vec![],
            open_questions: vec![],
            next_actions: vec!["do".into()],
            what_changed: "nothing".into(),
            votes: BTreeMap::new(),
            cost: None,
        };
        let out = adapt(deliberation::DebateEvent::Record { record: rec }, &names);
        assert!(
            matches!(&out[0], DebateEvent::Conclusion(c) if c.score == 8 && c.status == ConclusionStatus::Consensus)
        );
        assert!(matches!(&out[1], DebateEvent::Moderator(md) if md.starts_with("# q")));
    }
}
