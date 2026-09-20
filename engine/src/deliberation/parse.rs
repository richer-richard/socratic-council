//! Lenient parsers for the JSON shapes the protocol asks models for. Every
//! field defaults when missing; numbers are clamped; fenced or prose-wrapped
//! JSON is tolerated. A reply with no object at all is `None`, and the
//! runner then retries once at low reasoning before falling back.

use super::board::{Board, Disagreement, Evidence};
use super::plan::{Deliverable, Participant, Plan, SeatRole, Subtask};
use super::record::{DecisionRecord, Dissent, OptionConsidered};
use super::{
    Attack, Convergence, Critique, CritiqueIssue, Position, Recommend, Revision, Severity,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Extract the first balanced `{…}` object from model output. **String-literal
/// aware**: a `{` or `}` inside a JSON string (a stray brace in prose, a
/// set/code notation) is not counted, so it can't truncate the object early.
pub fn extract_json(raw: &str) -> Option<&str> {
    let s = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```");
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in s[start..].char_indices() {
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
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

fn object(raw: &str) -> Option<Value> {
    serde_json::from_str::<Value>(extract_json(raw)?).ok()
}

fn s(v: &Value, key: &str) -> String {
    match &v[key] {
        Value::String(x) => x.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn list(v: &Value, key: &str) -> Vec<String> {
    match &v[key] {
        Value::Array(items) => items
            .iter()
            .filter_map(|i| match i {
                Value::String(x) if !x.trim().is_empty() => Some(x.trim().to_string()),
                Value::Object(_) => Some(i.to_string()),
                _ => None,
            })
            .collect(),
        Value::String(x) if !x.trim().is_empty() => vec![x.trim().to_string()],
        _ => Vec::new(),
    }
}

fn unit(v: &Value, key: &str, default: f32) -> f32 {
    let n = match &v[key] {
        Value::Number(n) => n.as_f64().unwrap_or(default as f64) as f32,
        Value::String(x) => x
            .trim()
            .trim_end_matches('%')
            .parse::<f32>()
            .unwrap_or(default),
        _ => default,
    };
    // Accept percentages.
    let n = if n > 1.0 && n <= 100.0 { n / 100.0 } else { n };
    n.clamp(0.0, 1.0)
}

pub fn parse_plan(raw: &str) -> Option<Plan> {
    let v = object(raw)?;
    let deliverable = Deliverable::parse(&s(&v, "deliverable")).unwrap_or(Deliverable::Analysis);
    let participants = v["participants"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let seat = s(p, "seat");
                    if seat.is_empty() {
                        return None;
                    }
                    let role = if s(p, "role").eq_ignore_ascii_case("support") {
                        SeatRole::Support
                    } else {
                        SeatRole::Principal
                    };
                    Some(Participant {
                        seat,
                        role,
                        reason: s(p, "reason"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let lenses: BTreeMap<String, String> = v["lenses"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| val.as_str().map(|x| (k.clone(), x.trim().to_string())))
                .filter(|(_, x)| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let subtasks = v["subtasks"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let seat = s(t, "seat");
                    let task = s(t, "task");
                    if seat.is_empty() || task.is_empty() {
                        return None;
                    }
                    Some(Subtask {
                        seat,
                        task,
                        tools: list(t, "tools"),
                        word_cap: t["word_cap"].as_u64().unwrap_or(200).clamp(60, 400) as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let rounds = v["rounds"]
        .as_u64()
        .unwrap_or(1)
        .clamp(1, super::plan::MAX_ROUNDS as u64) as u8;
    let ask_user = {
        let q = s(&v, "ask_user");
        (!q.is_empty() && !q.eq_ignore_ascii_case("null") && !q.eq_ignore_ascii_case("none"))
            .then_some(q)
    };
    Some(Plan {
        deliverable,
        question: s(&v, "question"),
        options: list(&v, "options"),
        settles: s(&v, "settles"),
        participants,
        lenses,
        subtasks,
        rounds,
        ask_user,
    })
}

pub fn parse_position(raw: &str) -> Option<Position> {
    let v = object(raw)?;
    let position = s(&v, "position");
    if position.is_empty() {
        return None;
    }
    Some(Position {
        position,
        key_reason: s(&v, "key_reason"),
        strongest_objection: s(&v, "strongest_objection"),
        would_change_mind: s(&v, "would_change_mind"),
        confidence: unit(&v, "confidence", 0.5),
    })
}

pub fn parse_attack(raw: &str) -> Option<Attack> {
    let v = object(raw)?;
    let argument = s(&v, "argument");
    if argument.is_empty() {
        return None;
    }
    Some(Attack {
        target: s(&v, "target"),
        claim_challenged: s(&v, "claim_challenged"),
        argument,
        evidence: s(&v, "evidence"),
        concession: s(&v, "concession"),
    })
}

pub fn parse_revision(raw: &str) -> Option<Revision> {
    let v = object(raw)?;
    let position = s(&v, "position");
    if position.is_empty() {
        return None;
    }
    Some(Revision {
        position,
        changed: s(&v, "changed"),
        final_confidence: unit(&v, "final_confidence", 0.5),
        vote: s(&v, "vote"),
    })
}

pub fn parse_board(raw: &str) -> Option<Board> {
    let v = object(raw)?;
    let disagreements = v["disagreements"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    let about = s(d, "about");
                    if about.is_empty() {
                        return None;
                    }
                    Some(Disagreement {
                        between: list(d, "between"),
                        about,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let evidence = v["evidence"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let claim = s(e, "claim");
                    if claim.is_empty() {
                        return None;
                    }
                    Some(Evidence {
                        claim,
                        source: s(e, "source"),
                        by: s(e, "by"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let positions: BTreeMap<String, String> = v["positions"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| val.as_str().map(|x| (k.clone(), x.trim().to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some(Board {
        settled: list(&v, "settled"),
        disagreements,
        evidence,
        open_questions: list(&v, "open_questions"),
        positions,
    })
}

pub fn parse_convergence(raw: &str) -> Option<Convergence> {
    let v = object(raw)?;
    let recommend = match s(&v, "recommend").to_ascii_lowercase().as_str() {
        "close" | "closed" | "done" => Recommend::Close,
        "another_round" | "another round" | "continue" | "round" => Recommend::AnotherRound,
        _ => Recommend::Revise,
    };
    Some(Convergence {
        moved: list(&v, "moved"),
        open_disagreements: v["open_disagreements"].as_u64().unwrap_or(0).min(50) as u32,
        recommend,
        why: s(&v, "why"),
    })
}

pub fn parse_record(raw: &str) -> Option<DecisionRecord> {
    let v = object(raw)?;
    let answer = s(&v, "answer");
    if answer.is_empty() {
        return None;
    }
    let options_considered = v["options_considered"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| {
                    let option = s(o, "option");
                    (!option.is_empty()).then(|| OptionConsidered {
                        option,
                        why_not: s(o, "why_not"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let dissent = v["dissent"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    let seat = s(d, "seat");
                    let position = s(d, "position");
                    (!seat.is_empty() || !position.is_empty()).then(|| Dissent {
                        seat,
                        position,
                        why_not_carried: s(d, "why_not_carried"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let evidence = v["evidence"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let claim = s(e, "claim");
                    (!claim.is_empty()).then(|| Evidence {
                        claim,
                        source: s(e, "source"),
                        by: s(e, "by"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(DecisionRecord {
        deliverable: Deliverable::Analysis,
        question: String::new(),
        answer,
        confidence: unit(&v, "confidence", 0.5),
        options_considered,
        dissent,
        assumptions: list(&v, "assumptions"),
        evidence,
        open_questions: list(&v, "open_questions"),
        next_actions: list(&v, "next_actions"),
        what_changed: s(&v, "what_changed"),
        votes: BTreeMap::new(),
        cost: None,
    })
}

pub fn parse_critique(raw: &str) -> Option<Critique> {
    let v = object(raw)?;
    let issues = v["issues"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    let problem = s(i, "problem");
                    (!problem.is_empty()).then(|| CritiqueIssue {
                        location: s(i, "where"),
                        problem,
                        fix: s(i, "fix"),
                        severity: Severity::parse(&s(i, "severity")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let endorse = !s(&v, "verdict").eq_ignore_ascii_case("revise");
    Some(Critique { issues, endorse })
}

/// Serde helper for callers that want the raw object too.
#[derive(Debug, Deserialize)]
pub struct RawObject(pub Value);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_tolerates_fences_prose_and_braces_in_strings() {
        let raw = "Sure!\n```json\n{\"a\": \"x } y\", \"b\": {\"c\": 1}}\n```\ntrailing";
        assert_eq!(
            extract_json(raw),
            Some("{\"a\": \"x } y\", \"b\": {\"c\": 1}}")
        );
        assert!(extract_json("no object here").is_none());
    }

    #[test]
    fn parse_position_clamps_confidence_and_tolerates_fences() {
        let p = parse_position(
            "```json\n{\"position\":\"Yes\",\"key_reason\":\"r\",\"confidence\": 85}\n```",
        )
        .unwrap();
        assert_eq!(p.position, "Yes");
        assert!((p.confidence - 0.85).abs() < 1e-6);
        let p = parse_position("{\"position\":\"No\",\"confidence\":\"0.3\"}").unwrap();
        assert!((p.confidence - 0.3).abs() < 1e-6);
        assert!(
            parse_position("{\"confidence\":0.9}").is_none(),
            "a position needs text"
        );
    }

    #[test]
    fn parse_attack_defaults_missing_fields() {
        let a = parse_attack("{\"target\":\"cathy\",\"argument\":\"because\"}").unwrap();
        assert_eq!(a.target, "cathy");
        assert_eq!(a.claim_challenged, "");
        assert_eq!(a.concession, "");
        assert!(parse_attack("{\"target\":\"x\"}").is_none());
    }

    #[test]
    fn parse_plan_validates_shape_leniently() {
        let raw = r#"{"deliverable":"decision","question":"Q?","options":["A","B"],"settles":"data",
            "participants":[{"seat":"george","role":"principal","reason":"strong"},{"seat":"mary","role":"support"},{"role":"principal"}],
            "lenses":{"george":"cost"},"subtasks":[{"seat":"mary","task":"summarise","tools":["search_attachments"],"word_cap":9999}],
            "rounds":9,"ask_user":null}"#;
        let p = parse_plan(raw).unwrap();
        assert_eq!(p.deliverable, Deliverable::Decision);
        assert_eq!(p.participants.len(), 2);
        assert_eq!(p.participants[1].role, SeatRole::Support);
        assert_eq!(p.subtasks[0].word_cap, 400);
        assert_eq!(p.rounds, 6, "clamped to MAX_ROUNDS");
        assert!(p.ask_user.is_none());
        assert_eq!(p.lenses["george"], "cost");
    }

    #[test]
    fn parse_board_convergence_revision_and_record() {
        let b = parse_board(r#"{"settled":["s1"],"disagreements":[{"between":["a","b"],"about":"x"}],"evidence":[{"claim":"c","source":"u","by":"a"}],"open_questions":["q"],"positions":{"a":"yes"}}"#).unwrap();
        assert_eq!(b.disagreements[0].between, vec!["a", "b"]);
        assert_eq!(b.positions["a"], "yes");
        let c = parse_convergence(
            r#"{"moved":["a"],"open_disagreements":2,"recommend":"another_round","why":"w"}"#,
        )
        .unwrap();
        assert_eq!(c.recommend, Recommend::AnotherRound);
        assert_eq!(
            parse_convergence(r#"{"recommend":"close"}"#)
                .unwrap()
                .recommend,
            Recommend::Close
        );
        assert_eq!(
            parse_convergence(r#"{"recommend":"???"}"#)
                .unwrap()
                .recommend,
            Recommend::Revise
        );
        let r =
            parse_revision(r#"{"position":"p","changed":"c","final_confidence":0.7,"vote":"A"}"#)
                .unwrap();
        assert_eq!(r.vote, "A");
        let rec = parse_record(r#"{"answer":"A","confidence":0.8,"options_considered":[{"option":"B","why_not":"slow"}],"dissent":[{"seat":"b","position":"B","why_not_carried":"x"}],"assumptions":["a"],"evidence":[{"claim":"c","source":"s"}],"open_questions":[],"next_actions":["do"],"what_changed":"nothing"}"#).unwrap();
        assert_eq!(rec.options_considered[0].option, "B");
        assert_eq!(rec.dissent[0].seat, "b");
        assert!(
            parse_record(r#"{"confidence":1}"#).is_none(),
            "a record needs an answer"
        );
        let cr = parse_critique(r#"{"issues":[{"where":"intro","problem":"vague","fix":"be specific"},{"where":"§2","problem":"wrong","fix":"redo","severity":"blocker"},{"where":"§3","problem":"typo","fix":"fix","severity":"nit"}],"verdict":"revise"}"#).unwrap();
        assert_eq!(cr.issues[0].severity, Severity::Major);
        assert_eq!(cr.issues[1].severity, Severity::Blocker);
        assert_eq!(cr.issues[2].severity, Severity::Minor);
        assert!(!cr.endorse);
        assert_eq!(cr.issues[0].location, "intro");
    }
}
