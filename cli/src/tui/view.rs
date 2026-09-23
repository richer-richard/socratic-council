//! The Session screen's view of one run, built from the engine's own event
//! stream — the terminal twin of the desktop's `session/reducer.ts`.
//!
//! `apply` folds one `DebateEvent` into the view and never panics on an
//! event it does not understand. Every string that came from a model or a
//! network is passed through `sanitize_terminal` here, so nothing downstream
//! has to remember to. `from_stored` rebuilds the same view from a session
//! file: a v2 document (plan, rounds, board, record, costs) or a v1 file,
//! whose flat transcript becomes `legacy`.

use crate::deliberation::{
    ArgGraph, Board, Convergence, DebateEvent, DecisionRecord, Deliverable, Estimate, PeerEval,
    Plan, RoundKind, RoundLog, ToolUseRecord,
};
use crate::engine::{sanitize_terminal, strip_directives};
use crate::store::{messages_from_json, StoredMessage};
use crate::types::{CostSnapshot, Provider, Roster, ToolCall, Usage};
use serde_json::Value;
use std::collections::BTreeMap;

/// One seat's contribution in one round, live or stored.
#[derive(Debug, Clone, PartialEq)]
pub struct SeatTurn {
    pub seat_id: String,
    pub name: String,
    pub provider: Option<Provider>,
    pub model: String,
    pub text: String,
    pub thinking: String,
    pub tool_uses: Vec<ToolUseRecord>,
    pub usage: Option<Usage>,
    pub structured: Value,
    /// True once `seat_finished` arrived (or the entry came from a file).
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RoundView {
    pub kind: RoundKind,
    pub entries: Vec<SeatTurn>,
}

impl RoundView {
    pub fn label(&self) -> String {
        self.kind.label()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingQuestion {
    pub id: String,
    pub question: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub id: String,
    pub seat_id: String,
    pub call: ToolCall,
}

/// Everything the Session screen draws.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionView {
    /// The current phase name ("Framing", "Positions", …).
    pub phase: Option<String>,
    pub phases: Vec<String>,
    pub plan: Option<Plan>,
    pub corrections: Vec<String>,
    pub estimate: Option<Estimate>,
    pub rounds: Vec<RoundView>,
    pub board: Option<Board>,
    pub convergences: Vec<Convergence>,
    pub moderator_notes: Vec<String>,
    pub record: Option<DecisionRecord>,
    pub document: Option<String>,
    /// The review pass, when it ran. Absent on a session that turned it off.
    pub peer_eval: Option<PeerEval>,
    pub arg_graph: Option<ArgGraph>,
    pub cost: Option<CostSnapshot>,
    pub errors: Vec<String>,
    pub pending_question: Option<PendingQuestion>,
    pub pending_approval: Option<PendingApproval>,
    /// Seats currently generating.
    pub active: Vec<String>,
    pub done: bool,
    /// Set when the run ended early: "cancelled", "budget", "failed", …
    pub stopped_early: Option<String>,
    /// A v1 file's flat transcript (a session written before v3).
    pub legacy: Vec<StoredMessage>,
    /// The hand-off folder and the files in it, once written.
    pub handoff: Option<(String, Vec<String>)>,
}

/// A stable key per round: `prep`, `positions`, `cross-1`, `revision`, `critique`.
pub fn round_key(kind: RoundKind) -> String {
    match kind {
        RoundKind::Prep => "prep".into(),
        RoundKind::Positions => "positions".into(),
        RoundKind::Cross(n) => format!("cross-{n}"),
        RoundKind::Revision => "revision".into(),
        RoundKind::Critique => "critique".into(),
    }
}

fn scrub(s: &str) -> String {
    sanitize_terminal(s)
}

impl SessionView {
    /// The round `kind` belongs to, created at the end when new.
    fn round_index(&mut self, kind: RoundKind) -> usize {
        let key = round_key(kind);
        if let Some(i) = self.rounds.iter().position(|r| round_key(r.kind) == key) {
            return i;
        }
        self.rounds.push(RoundView {
            kind,
            entries: Vec::new(),
        });
        self.rounds.len() - 1
    }

    /// The newest unfinished turn of `seat_id` (the one still streaming).
    fn open_turn(&mut self, seat_id: &str) -> Option<&mut SeatTurn> {
        self.rounds.iter_mut().rev().find_map(|r| {
            r.entries
                .iter_mut()
                .rev()
                .find(|t| t.seat_id == seat_id && !t.done)
        })
    }

    /// Fold one engine event into the view.
    pub fn apply(&mut self, event: DebateEvent) {
        match event {
            DebateEvent::Phase { name } => {
                let name = scrub(&name);
                self.phases.push(name.clone());
                self.phase = Some(name);
            }
            DebateEvent::Plan { plan, corrections } => {
                self.plan = Some(plan);
                self.corrections = corrections.iter().map(|c| scrub(c)).collect();
            }
            DebateEvent::Estimate { estimate } => self.estimate = Some(estimate),
            DebateEvent::UserQuestion { id, question } => {
                self.pending_question = Some(PendingQuestion {
                    id,
                    question: scrub(&question),
                });
            }
            DebateEvent::SeatStarted {
                seat_id,
                name,
                provider,
                model,
                round,
            } => {
                let i = self.round_index(round);
                self.rounds[i].entries.push(SeatTurn {
                    seat_id: seat_id.clone(),
                    name: scrub(&name),
                    provider: Some(provider),
                    model: scrub(&model),
                    text: String::new(),
                    thinking: String::new(),
                    tool_uses: Vec::new(),
                    usage: None,
                    structured: Value::Null,
                    done: false,
                });
                if !self.active.contains(&seat_id) {
                    self.active.push(seat_id);
                }
            }
            DebateEvent::Token { seat_id, text } => {
                if let Some(t) = self.open_turn(&seat_id) {
                    t.text.push_str(&scrub(&text));
                }
            }
            DebateEvent::Thinking { seat_id, text } => {
                if let Some(t) = self.open_turn(&seat_id) {
                    t.thinking.push_str(&scrub(&text));
                }
            }
            DebateEvent::ToolApproval { id, seat_id, call } => {
                self.pending_approval = Some(PendingApproval {
                    id,
                    seat_id,
                    call: scrub_call(call),
                });
            }
            DebateEvent::ToolCall {
                seat_id,
                call,
                output,
                error,
            } => {
                if self
                    .pending_approval
                    .as_ref()
                    .is_some_and(|p| p.call.id == call.id)
                {
                    self.pending_approval = None;
                }
                let record = ToolUseRecord {
                    call: scrub_call(call),
                    output: scrub(&output),
                    error: error.as_deref().map(scrub),
                };
                if let Some(t) = self.open_turn(&seat_id) {
                    t.tool_uses.push(record);
                }
            }
            DebateEvent::SeatFinished {
                seat_id,
                name,
                round,
                usage,
                content,
                structured,
            } => {
                let content = scrub(&content);
                match self.open_turn(&seat_id) {
                    Some(t) => {
                        if !content.trim().is_empty() {
                            t.text = content;
                        }
                        t.usage = Some(usage);
                        t.structured = structured;
                        t.done = true;
                    }
                    None => {
                        // A seat may finish without having started in this
                        // view (a subscription that attached late).
                        let i = self.round_index(round);
                        self.rounds[i].entries.push(SeatTurn {
                            seat_id: seat_id.clone(),
                            name: scrub(&name),
                            provider: None,
                            model: String::new(),
                            text: content,
                            thinking: String::new(),
                            tool_uses: Vec::new(),
                            usage: Some(usage),
                            structured,
                            done: true,
                        });
                    }
                }
                self.active.retain(|id| id != &seat_id);
            }
            DebateEvent::Board { board } => self.board = Some(board),
            DebateEvent::Convergence { convergence } => self.convergences.push(convergence),
            DebateEvent::Moderator { text, .. } => self.moderator_notes.push(scrub(&text)),
            DebateEvent::Record { record } => self.record = Some(*record),
            DebateEvent::PeerEvalReady { peer_eval } => self.peer_eval = Some(peer_eval),
            DebateEvent::ArgMap { graph } => self.arg_graph = Some(graph),
            DebateEvent::Document { markdown } => self.document = Some(scrub(&markdown)),
            DebateEvent::Cost { snapshot } => self.cost = Some(snapshot),
            DebateEvent::Error { message } => self.errors.push(scrub(&message)),
            DebateEvent::Handoff { dir, files } => {
                self.handoff = Some((scrub(&dir), files.iter().map(|f| scrub(f)).collect()));
            }
            DebateEvent::Done { .. } => {
                self.done = true;
                self.active.clear();
                self.pending_question = None;
                self.pending_approval = None;
                if self.stopped_early.is_none() && self.record.is_none() && self.document.is_none()
                {
                    self.stopped_early = Some("stopped".into());
                }
            }
        }
    }

    /// Mark a run as cancelled locally (the engine confirms with `done`).
    pub fn mark_cancelled(&mut self) {
        self.stopped_early.get_or_insert_with(|| "cancelled".into());
    }

    /// A stored session's view: the v2 fields when present, else the flat
    /// transcript as `legacy`.
    pub fn from_stored(doc: &Value) -> SessionView {
        let mut view = SessionView::default();
        let is_v2 = doc["version"].as_u64() == Some(2)
            || doc["rounds"].is_array()
            || doc["plan"].is_object();
        if !is_v2 {
            view.legacy = messages_from_json(doc)
                .into_iter()
                .map(|mut m| {
                    m.content = strip_directives(&scrub(&m.content)).0;
                    m.thinking = scrub(&m.thinking);
                    m.display_name = scrub(&m.display_name);
                    m.model = scrub(&m.model);
                    m
                })
                .collect();
            view.done = true;
            return view;
        }
        let providers: BTreeMap<String, Provider> =
            serde_json::from_value::<Roster>(doc["roster"].clone())
                .map(|r| r.seats.into_iter().map(|s| (s.id, s.provider)).collect())
                .unwrap_or_default();
        view.plan = serde_json::from_value(doc["plan"].clone()).ok();
        view.corrections = doc["corrections"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).map(scrub).collect())
            .unwrap_or_default();
        view.estimate = serde_json::from_value(doc["estimate"].clone()).ok();
        view.rounds = serde_json::from_value::<Vec<RoundLog>>(doc["rounds"].clone())
            .unwrap_or_default()
            .into_iter()
            .map(|log| RoundView {
                kind: log.kind,
                entries: log
                    .entries
                    .into_iter()
                    .map(|e| SeatTurn {
                        provider: providers.get(&e.seat).copied(),
                        seat_id: e.seat,
                        name: scrub(&e.name),
                        model: scrub(&e.model),
                        text: scrub(&e.content),
                        thinking: String::new(),
                        tool_uses: e
                            .tool_uses
                            .into_iter()
                            .map(|u| ToolUseRecord {
                                call: scrub_call(u.call),
                                output: scrub(&u.output),
                                error: u.error.as_deref().map(scrub),
                            })
                            .collect(),
                        usage: Some(e.usage),
                        structured: e.structured,
                        done: true,
                    })
                    .collect(),
            })
            .collect();
        // A board is only a board with its `settled` list; an empty object
        // (a run that never reached one) stays `None`.
        view.board = serde_json::from_value::<Board>(doc["board"].clone())
            .ok()
            .filter(|_| doc["board"]["settled"].is_array());
        view.convergences = serde_json::from_value(doc["convergences"].clone()).unwrap_or_default();
        view.record = serde_json::from_value(doc["record"].clone()).ok();
        view.document = doc["document"].as_str().map(scrub);
        // Absent on a session that ran with the review pass off, which is a
        // setting rather than a fault: both stay None and the surfaces fall
        // back to what votes and convergence already say.
        view.peer_eval = serde_json::from_value(doc["peerEval"].clone()).ok();
        view.arg_graph = serde_json::from_value(doc["argGraph"].clone()).ok();
        view.cost = serde_json::from_value::<CostSnapshot>(doc["costs"].clone())
            .ok()
            .filter(|_| doc["costs"].is_object());
        view.stopped_early = doc["stoppedEarly"].as_str().map(scrub);
        if let Some(dir) = doc["handoff"]["dir"].as_str() {
            let files = doc["handoff"]["files"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(scrub).collect())
                .unwrap_or_default();
            view.handoff = Some((scrub(dir), files));
        }
        view.phase = (view.record.is_some() || view.document.is_some()).then(|| "Record".into());
        view.done = true;
        view
    }

    /// The deliverable, from the record or the plan.
    pub fn deliverable(&self) -> Option<Deliverable> {
        self.record
            .as_ref()
            .map(|r| r.deliverable)
            .or_else(|| self.plan.as_ref().map(|p| p.deliverable))
    }

    /// The record (and the document, when there is one) as Markdown.
    pub fn record_markdown(&self, names: &BTreeMap<String, String>) -> Option<String> {
        self.record
            .as_ref()
            .map(|r| crate::deliberation::record::to_markdown(r, names, self.document.as_deref()))
    }

    /// The last few contributions as notes for a reconvened session, when
    /// there is no record to hand over.
    pub fn transcript_tail(&self, n: usize) -> Option<String> {
        let mut lines: Vec<String> = if self.legacy.is_empty() {
            self.rounds
                .iter()
                .flat_map(|r| r.entries.iter())
                .filter(|t| !t.text.trim().is_empty())
                .map(|t| format!("{}: {}", t.name, t.text))
                .collect()
        } else {
            self.legacy
                .iter()
                .map(|m| format!("{}: {}", m.display_name, m.content))
                .collect()
        };
        if lines.is_empty() {
            return None;
        }
        let keep = lines.len().saturating_sub(n);
        lines.drain(..keep);
        Some(lines.join("\n"))
    }

    /// Seat ids that appear anywhere in the view (for stored sessions
    /// without a roster).
    pub fn seat_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for t in self.rounds.iter().flat_map(|r| r.entries.iter()) {
            if !ids.contains(&t.seat_id) {
                ids.push(t.seat_id.clone());
            }
        }
        ids
    }
}

fn scrub_call(mut call: ToolCall) -> ToolCall {
    call.name = scrub(&call.name);
    scrub_value(&mut call.arguments);
    call
}

/// Every string inside a tool call's arguments is model output: scrub them.
fn scrub_value(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => *s = scrub(s),
        serde_json::Value::Array(items) => items.iter_mut().for_each(scrub_value),
        serde_json::Value::Object(map) => map.values_mut().for_each(scrub_value),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deliberation::{ModeratorNoteKind, Recommend, RoundKind};
    use serde_json::json;

    fn started(seat: &str, round: RoundKind) -> DebateEvent {
        DebateEvent::SeatStarted {
            seat_id: seat.into(),
            name: seat.to_uppercase(),
            provider: Provider::OpenAI,
            model: "fake".into(),
            round,
        }
    }

    fn finished(seat: &str, round: RoundKind, content: &str) -> DebateEvent {
        DebateEvent::SeatFinished {
            seat_id: seat.into(),
            name: seat.to_uppercase(),
            round,
            usage: Usage {
                input: 10,
                output: 5,
                ..Default::default()
            },
            content: content.into(),
            structured: json!({"position": content}),
        }
    }

    fn call(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "read_file".into(),
            arguments: json!({"path": "notes.txt"}),
            signature: None,
        }
    }

    fn record() -> DecisionRecord {
        DecisionRecord {
            deliverable: Deliverable::Analysis,
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
            how_it_went: "George pushed on cost; Cathy moved.".into(),
            votes: BTreeMap::new(),
            cost: None,
        }
    }

    #[test]
    fn scripted_stream_builds_the_view() {
        let mut v = SessionView::default();
        for p in [
            "Framing",
            "Prep",
            "Positions",
            "Cross-examination 1",
            "Record",
        ] {
            v.apply(DebateEvent::Phase { name: p.into() });
        }
        assert_eq!(v.phases.len(), 5);
        assert_eq!(v.phase.as_deref(), Some("Record"));

        v.apply(DebateEvent::Plan {
            plan: Plan {
                deliverable: Deliverable::Analysis,
                question: "Is it effective?".into(),
                options: vec![],
                settles: "a record".into(),
                participants: vec![],
                lenses: BTreeMap::new(),
                subtasks: vec![],
                rounds: 1,
                ask_user: None,
            },
            corrections: vec!["dropped seat z".into()],
        });
        v.apply(DebateEvent::Estimate {
            estimate: Estimate {
                calls: 6,
                usd_low: 0.1,
                usd_high: 0.3,
                unpriced_seats: vec![],
            },
        });
        v.apply(started("a", RoundKind::Positions));
        v.apply(started("b", RoundKind::Positions));
        v.apply(DebateEvent::Token {
            seat_id: "a".into(),
            text: "hel".into(),
        });
        v.apply(DebateEvent::Token {
            seat_id: "a".into(),
            text: "lo".into(),
        });
        v.apply(DebateEvent::Thinking {
            seat_id: "b".into(),
            text: "hmm".into(),
        });
        v.apply(DebateEvent::ToolCall {
            seat_id: "a".into(),
            call: call("c1"),
            output: "notes".into(),
            error: None,
        });
        assert_eq!(v.active, vec!["a".to_string(), "b".to_string()]);
        v.apply(finished("a", RoundKind::Positions, "A says yes"));
        v.apply(finished("b", RoundKind::Positions, "B says no"));
        assert!(v.active.is_empty());

        v.apply(DebateEvent::Board {
            board: Board {
                settled: vec!["it runs".into()],
                ..Default::default()
            },
        });
        v.apply(DebateEvent::Convergence {
            convergence: Convergence {
                moved: vec!["a".into()],
                open_disagreements: 0,
                recommend: Recommend::Close,
                why: "agreed".into(),
            },
        });
        v.apply(DebateEvent::Moderator {
            kind: ModeratorNoteKind::Note,
            text: "note".into(),
        });
        v.apply(DebateEvent::Record {
            record: Box::new(record()),
        });
        v.apply(DebateEvent::Cost {
            snapshot: CostSnapshot {
                total_usd: 0.12,
                all_priced: true,
                ..Default::default()
            },
        });
        v.apply(DebateEvent::Handoff {
            dir: "/ws/handoff".into(),
            files: vec!["handoff.md".into()],
        });
        v.apply(DebateEvent::Done {
            session_id: "s".into(),
        });

        assert_eq!(
            v.handoff.as_ref().map(|h| h.0.as_str()),
            Some("/ws/handoff")
        );
        assert_eq!(v.rounds.len(), 1);
        assert_eq!(v.rounds[0].kind, RoundKind::Positions);
        assert_eq!(v.rounds[0].entries.len(), 2);
        let a = &v.rounds[0].entries[0];
        assert_eq!(
            a.text, "A says yes",
            "seat_finished content replaces the stream"
        );
        assert_eq!(a.tool_uses.len(), 1);
        assert_eq!(a.tool_uses[0].call.name, "read_file");
        assert!(a.done);
        assert_eq!(a.usage.as_ref().map(|u| u.input), Some(10));
        assert_eq!(v.rounds[0].entries[1].thinking, "hmm");
        assert_eq!(v.plan.as_ref().unwrap().question, "Is it effective?");
        assert_eq!(v.corrections, vec!["dropped seat z".to_string()]);
        assert_eq!(v.estimate.as_ref().unwrap().calls, 6);
        assert_eq!(
            v.board.as_ref().unwrap().settled,
            vec!["it runs".to_string()]
        );
        assert_eq!(v.convergences.len(), 1);
        assert_eq!(v.moderator_notes, vec!["note".to_string()]);
        assert_eq!(v.record.as_ref().unwrap().answer, "A");
        assert_eq!(v.cost.as_ref().unwrap().total_usd, 0.12);
        assert!(v.done);
        assert_eq!(
            v.stopped_early, None,
            "a run with a record did not stop early"
        );
        assert_eq!(v.deliverable(), Some(Deliverable::Analysis));
        assert!(v
            .record_markdown(&BTreeMap::new())
            .unwrap()
            .starts_with("# q"));
        assert_eq!(v.seat_ids(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn seat_finished_without_start_appends_an_entry_and_a_stop_is_recorded() {
        let mut v = SessionView::default();
        v.apply(finished("c", RoundKind::Cross(2), "late"));
        assert_eq!(round_key(v.rounds[0].kind), "cross-2");
        let t = &v.rounds[0].entries[0];
        assert_eq!(t.seat_id, "c");
        assert_eq!(t.text, "late");
        assert!(t.done && t.provider.is_none());

        v.apply(DebateEvent::Done {
            session_id: "s".into(),
        });
        assert_eq!(v.stopped_early.as_deref(), Some("stopped"));

        let mut v = SessionView::default();
        v.mark_cancelled();
        v.apply(DebateEvent::Done {
            session_id: "s".into(),
        });
        assert_eq!(v.stopped_early.as_deref(), Some("cancelled"));
    }

    #[test]
    fn question_and_approval_are_pending_until_answered_or_done() {
        let mut v = SessionView::default();
        v.apply(DebateEvent::UserQuestion {
            id: "q1".into(),
            question: "Which region?".into(),
        });
        assert_eq!(v.pending_question.as_ref().unwrap().id, "q1");

        v.apply(started("a", RoundKind::Cross(1)));
        v.apply(DebateEvent::ToolApproval {
            id: "ap1".into(),
            seat_id: "a".into(),
            call: call("c9"),
        });
        assert_eq!(v.pending_approval.as_ref().unwrap().call.id, "c9");
        // The tool ran: the approval it waited on is no longer pending.
        v.apply(DebateEvent::ToolCall {
            seat_id: "a".into(),
            call: call("c9"),
            output: "ok".into(),
            error: Some("partial".into()),
        });
        assert!(v.pending_approval.is_none());
        assert_eq!(
            v.rounds[0].entries[0].tool_uses[0].error.as_deref(),
            Some("partial")
        );

        v.apply(DebateEvent::ToolApproval {
            id: "ap2".into(),
            seat_id: "a".into(),
            call: call("c10"),
        });
        v.apply(DebateEvent::Done {
            session_id: "s".into(),
        });
        assert!(v.pending_question.is_none() && v.pending_approval.is_none());
    }

    #[test]
    fn escape_bytes_never_reach_the_view() {
        let mut v = SessionView::default();
        v.apply(DebateEvent::Phase {
            name: "Fra\x1b[2Jming".into(),
        });
        v.apply(started("a", RoundKind::Positions));
        v.apply(DebateEvent::Token {
            seat_id: "a".into(),
            text: "safe\x1b]52;c;SGVsbG8=\x07text".into(),
        });
        v.apply(DebateEvent::Moderator {
            kind: ModeratorNoteKind::Note,
            text: "note\x1b[31m".into(),
        });
        v.apply(DebateEvent::Error {
            message: "bad\x07".into(),
        });
        v.apply(DebateEvent::Document {
            markdown: "# doc\x1b[0m".into(),
        });
        let all = format!(
            "{}{}{}{}{}",
            v.phase.as_deref().unwrap(),
            v.rounds[0].entries[0].text,
            v.moderator_notes[0],
            v.errors[0],
            v.document.as_deref().unwrap()
        );
        assert!(!all.contains('\x1b') && !all.contains('\x07'));
    }

    #[test]
    fn from_stored_reads_a_v2_document() {
        let doc = json!({
            "id": "sc-1", "topic": "T", "version": 2, "protocol": "rounds",
            "roster": {"seats": [{"id": "a", "name": "Ada", "provider": "anthropic", "model": "auto"}]},
            "plan": {"deliverable": "decision", "question": "Q", "options": ["x"], "settles": "s",
                     "participants": [], "lenses": {}, "subtasks": [], "rounds": 1, "ask_user": null},
            "corrections": ["c1"],
            "estimate": {"calls": 3, "usd_low": 0.1, "usd_high": 0.2, "unpriced_seats": []},
            "board": {"settled": ["s1"], "disagreements": [], "evidence": [], "open_questions": [], "positions": {}},
            "rounds": [{"kind": "positions", "entries": [{"seat": "a", "name": "Ada", "model": "m",
                        "content": "yes\x1b[2J", "structured": {}, "tool_uses": [{"call": {"id": "c", "name": "read_file",
                        "arguments": {"path": "n"}}, "output": "o", "error": null}],
                        "usage": {"input": 1, "output": 2, "reasoning": 0, "cached_input": 0, "cache_write": 0}}]},
                       {"kind": {"cross": 1}, "entries": []}],
            "convergences": [{"moved": [], "open_disagreements": 1, "recommend": "close", "why": "w"}],
            "record": {"deliverable": "decision", "question": "Q", "answer": "A", "confidence": 0.9,
                       "options_considered": [], "dissent": [], "assumptions": [], "evidence": [],
                       "open_questions": [], "next_actions": [], "what_changed": "", "votes": {}, "cost": null},
            "document": null,
            "costs": {"rows": [], "lane_usd": [], "total_usd": 0.5, "total_input": 1, "total_output": 2,
                      "total_reasoning": 0, "all_priced": true, "daily_usd": 0.5, "session_cap": 0.0,
                      "daily_cap": 0.0, "note": null},
            "stoppedEarly": "budget",
            "messages": [{"id": "m0", "agentId": "a", "displayName": "Ada", "content": "yes", "timestamp": 1}]
        });
        let v = SessionView::from_stored(&doc);
        assert!(v.legacy.is_empty());
        assert_eq!(v.plan.as_ref().unwrap().question, "Q");
        assert_eq!(v.corrections, vec!["c1".to_string()]);
        assert_eq!(v.estimate.as_ref().unwrap().calls, 3);
        assert_eq!(v.rounds.len(), 2);
        assert_eq!(v.rounds[1].kind, RoundKind::Cross(1));
        let t = &v.rounds[0].entries[0];
        assert_eq!(t.provider, Some(Provider::Anthropic));
        assert_eq!(t.text, "yes[2J", "stored content is scrubbed on load");
        assert_eq!(t.tool_uses[0].output, "o");
        assert!(t.done);
        assert_eq!(v.board.as_ref().unwrap().settled, vec!["s1".to_string()]);
        assert_eq!(v.convergences[0].open_disagreements, 1);
        assert_eq!(v.record.as_ref().unwrap().answer, "A");
        assert_eq!(v.cost.as_ref().unwrap().total_usd, 0.5);
        assert_eq!(v.stopped_early.as_deref(), Some("budget"));
        assert_eq!(v.phase.as_deref(), Some("Record"));
        assert!(v.handoff.is_none());
        let mut with = doc.clone();
        with["handoff"] = json!({"dir": "/tmp/h", "files": ["handoff.md", "record.md"]});
        let v = SessionView::from_stored(&with);
        assert_eq!(
            v.handoff,
            Some((
                "/tmp/h".to_string(),
                vec!["handoff.md".to_string(), "record.md".to_string()]
            ))
        );
        assert!(v.done);

        // A v2 file that never reached a board or a record.
        let doc = json!({"version": 2, "rounds": [], "board": {}, "record": null, "costs": {},
                         "stoppedEarly": null, "messages": []});
        let v = SessionView::from_stored(&doc);
        assert!(v.board.is_none() && v.record.is_none() && v.phase.is_none());
    }

    #[test]
    fn from_stored_reads_a_v1_transcript() {
        let doc = json!({
            "id": "sc-0", "topic": "old",
            "messages": [
                {"id": "m0", "agentId": "system", "displayName": "Moderator", "content": "convened", "timestamp": 1},
                {"id": "m1", "agentId": "george", "displayName": "George", "content": "<think>x</think>point @end()", "timestamp": 2}
            ]
        });
        let v = SessionView::from_stored(&doc);
        assert!(v.rounds.is_empty() && v.record.is_none());
        assert_eq!(v.legacy.len(), 2);
        assert_eq!(v.legacy[0].agent_id, "moderator");
        assert_eq!(
            v.legacy[1].content, "point",
            "v1 directives and think tags are stripped"
        );
        assert!(v.done);
        assert_eq!(
            v.transcript_tail(1).as_deref(),
            Some("George: point"),
            "the tail feeds a reconvened session"
        );
    }
}
