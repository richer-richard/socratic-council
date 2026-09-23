//! The review pass: what the council thought of itself, and the shape of the
//! argument it made.
//!
//! Two artifacts, both produced after the record so a cancelled review still
//! leaves a finished session behind:
//!
//!   - **Peer evaluation.** Every seat scores every other seat on five
//!     dimensions and writes a short critique. One call per evaluator, not one
//!     per pair, so the pass is N calls rather than N×(N−1). The calls run on
//!     the utility slot carrying the evaluator's own identity, which keeps the
//!     critique in character without spending a flagship seat's price on it.
//!   - **Argument map.** A claim/rebuttal graph over the whole debate. The
//!     extraction runs once per round and the rounds are merged, rather than
//!     once per turn as the v2 map did: a round is a coherent unit, the merge
//!     catches the same claim worded two ways across speakers, and the pass
//!     costs about as many calls as there were rounds.
//!
//! Both are optional. `ProtocolPolicy::review` turns the pass off, and a
//! session that ran without it still renders: the surfaces fall back to the
//! metrics derived from votes, convergence and cost, which cost nothing.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Peer evaluation
// ---------------------------------------------------------------------------

/// The rubric. Every dimension is 0 to 100, and the scale is described to the
/// evaluator in the prompt so the numbers mean the same thing across models.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PeerScores {
    pub rigor: u8,
    pub evidence: u8,
    pub novelty: u8,
    pub civility: u8,
    pub on_topic: u8,
}

impl PeerScores {
    pub fn mean(&self) -> f32 {
        (self.rigor as f32
            + self.evidence as f32
            + self.novelty as f32
            + self.civility as f32
            + self.on_topic as f32)
            / 5.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerStance {
    Agree,
    Disagree,
    Mixed,
}

/// One evaluator's verdict on one target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerCritique {
    pub evaluator: String,
    pub target: String,
    pub scores: PeerScores,
    /// The evaluator's own holistic 0 to 100, not an average of the rubric.
    pub overall: u8,
    pub stance: PeerStance,
    pub critique: String,
}

/// What one seat received, across every evaluator who scored it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PeerSummary {
    pub average: PeerScores,
    pub overall_average: f32,
    /// 1 is highest. Ties keep roster order, so the rank is stable per run.
    pub rank: u32,
    pub reviews_received: u32,
    /// The opening sentence of the harshest critique this seat received.
    pub standout: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PeerEval {
    /// Seat ids in display order. The matrix and the graph both index on this,
    /// so a row and a node always mean the same seat.
    pub seats: Vec<String>,
    pub critiques: Vec<PeerCritique>,
    pub per_seat: BTreeMap<String, PeerSummary>,
    /// Evaluators whose reply did not parse. Surfaced, never hidden: a matrix
    /// with a silently missing row reads as a seat nobody rated.
    pub failed: Vec<String>,
}

/// Fold the raw critiques into a per-seat summary and rank them.
pub fn summarize(seats: &[String], critiques: &[PeerCritique]) -> BTreeMap<String, PeerSummary> {
    let mut out: BTreeMap<String, PeerSummary> = BTreeMap::new();
    for seat in seats {
        let received: Vec<&PeerCritique> = critiques.iter().filter(|c| &c.target == seat).collect();
        if received.is_empty() {
            out.insert(seat.clone(), PeerSummary::default());
            continue;
        }
        let n = received.len() as f32;
        let sum =
            |f: fn(&PeerCritique) -> u8| received.iter().map(|c| f(c) as f32).sum::<f32>() / n;
        let average = PeerScores {
            rigor: sum(|c| c.scores.rigor).round() as u8,
            evidence: sum(|c| c.scores.evidence).round() as u8,
            novelty: sum(|c| c.scores.novelty).round() as u8,
            civility: sum(|c| c.scores.civility).round() as u8,
            on_topic: sum(|c| c.scores.on_topic).round() as u8,
        };
        let harshest = received.iter().min_by_key(|c| c.overall);
        let standout = harshest.and_then(|c| first_sentence(&c.critique));
        out.insert(
            seat.clone(),
            PeerSummary {
                average,
                overall_average: sum(|c| c.overall),
                rank: 0,
                reviews_received: received.len() as u32,
                standout,
            },
        );
    }

    // Rank by overall average, descending. Seats with no reviews sort last and
    // share the tail rank rather than claiming first place with a 0.
    let mut order: Vec<String> = seats.to_vec();
    order.sort_by(|a, b| {
        let sa = out.get(a).map(|s| s.overall_average).unwrap_or(-1.0);
        let sb = out.get(b).map(|s| s.overall_average).unwrap_or(-1.0);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    for (i, seat) in order.iter().enumerate() {
        if let Some(s) = out.get_mut(seat) {
            if s.reviews_received > 0 {
                s.rank = i as u32 + 1;
            }
        }
    }
    out
}

fn first_sentence(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let end = trimmed
        .char_indices()
        .find(|(_, c)| matches!(c, '.' | '!' | '?'))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(trimmed.len());
    Some(trimmed[..end].trim().to_string())
}

// ---------------------------------------------------------------------------
// Argument map
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgNodeKind {
    Claim,
    Premise,
    Evidence,
    Rebuttal,
    Concession,
    Question,
    Assumption,
    Definition,
    Proposal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgRelation {
    Supports,
    Rebuts,
    Concedes,
    Restates,
    Refines,
    Agrees,
    Contradicts,
    DependsOn,
    Answers,
    Addresses,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArgNode {
    pub id: String,
    pub kind: ArgNodeKind,
    pub text: String,
    /// Every seat that asserted this, in the order they first did. A claim two
    /// seats make in different words is one node with two names here.
    pub by: Vec<String>,
    /// The round this first appeared in, 0 for positions.
    pub round: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArgEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: ArgRelation,
    pub rationale: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ArgGraph {
    pub nodes: Vec<ArgNode>,
    pub edges: Vec<ArgEdge>,
    /// Rounds the extractor returned nothing usable for, by label. A map with a
    /// round quietly missing reads as a round where nobody argued anything.
    #[serde(default)]
    pub missing: Vec<String>,
}

/// A fragment as the extractor returns it, before it is placed in the graph.
#[derive(Debug, Clone, PartialEq)]
pub struct ArgFragment {
    pub kind: ArgNodeKind,
    pub text: String,
    pub by: String,
    /// The text of the node this answers, as the extractor saw it. Resolved to
    /// a node id by the merge, which is why the extractor never invents ids.
    pub target: Option<String>,
    pub relation: Option<ArgRelation>,
    pub rationale: String,
}

/// Bag-of-words cosine over lowercased alphanumeric tokens. Enough to catch
/// "same claim, different wording" between two speakers without reaching for
/// an embedding model, which is the same bar the v2 merger set.
fn similarity(a: &str, b: &str) -> f32 {
    let tokens = |s: &str| -> BTreeMap<String, f32> {
        let mut m: BTreeMap<String, f32> = BTreeMap::new();
        for w in s
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
        {
            *m.entry(w.to_lowercase()).or_insert(0.0) += 1.0;
        }
        m
    };
    let (ta, tb) = (tokens(a), tokens(b));
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let dot: f32 = ta
        .iter()
        .map(|(k, v)| tb.get(k).copied().unwrap_or(0.0) * v)
        .sum();
    let na: f32 = ta.values().map(|v| v * v).sum::<f32>().sqrt();
    let nb: f32 = tb.values().map(|v| v * v).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// Two points this close in wording, of the same kind and the same polarity,
/// are treated as the same point. Bag-of-words cosine cannot see "not", so the
/// threshold alone would fold "X is the safest" and "X is not the safest" into
/// one node (they score 0.93): the kind and polarity checks are what keep a
/// rebuttal from being merged into the claim it rebuts.
const MERGE_THRESHOLD: f32 = 0.85;

/// A quoted target only has to be recognisable, since the extractor copies it
/// from text it can see. Polarity still has to agree.
const TARGET_THRESHOLD: f32 = 0.72;

/// Whether a sentence is negated. Crude on purpose: it only has to tell a
/// claim from its denial when the rest of the words are the same.
fn negated(text: &str) -> bool {
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .any(|w| {
            matches!(
                w,
                "not" | "no" | "never" | "cannot" | "without" | "neither" | "nor"
            ) || w.ends_with("n't")
        })
}

/// Find the node a piece of text refers to, by closest wording above
/// `threshold`, with the same polarity, and of `kind` when one is given.
/// `None` when nothing qualifies, which keeps an unrelated fragment from being
/// welded onto the nearest node.
fn match_node(
    graph: &ArgGraph,
    text: &str,
    kind: Option<ArgNodeKind>,
    exclude: Option<&str>,
    threshold: f32,
) -> Option<usize> {
    let polarity = negated(text);
    let mut best: Option<(usize, f32)> = None;
    for (i, node) in graph.nodes.iter().enumerate() {
        if kind.is_some_and(|k| node.kind != k) || exclude == Some(node.id.as_str()) {
            continue;
        }
        if negated(&node.text) != polarity {
            continue;
        }
        let score = similarity(&node.text, text);
        if score >= threshold && best.map(|(_, b)| score > b).unwrap_or(true) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

/// Fold one round's fragments into the running graph.
pub fn merge_fragments(graph: &mut ArgGraph, fragments: &[ArgFragment], round: u8) {
    for frag in fragments {
        if frag.text.trim().is_empty() {
            continue;
        }
        let from = match match_node(graph, &frag.text, Some(frag.kind), None, MERGE_THRESHOLD) {
            Some(i) => {
                // Same claim from a second seat: record the speaker, keep the
                // first wording so edges pointing at it stay meaningful.
                if !graph.nodes[i].by.contains(&frag.by) {
                    graph.nodes[i].by.push(frag.by.clone());
                }
                graph.nodes[i].id.clone()
            }
            None => {
                let id = format!("n{}", graph.nodes.len() + 1);
                graph.nodes.push(ArgNode {
                    id: id.clone(),
                    kind: frag.kind,
                    text: frag.text.trim().to_string(),
                    by: vec![frag.by.clone()],
                    round,
                });
                id
            }
        };

        let (Some(target), Some(relation)) = (frag.target.as_ref(), frag.relation) else {
            continue;
        };
        // The node just placed is never its own target: a rebuttal worded
        // close to the claim it answers would otherwise point at itself.
        let Some(to_index) = match_node(graph, target, None, Some(from.as_str()), TARGET_THRESHOLD)
        else {
            continue;
        };
        let to = graph.nodes[to_index].id.clone();
        if to == from {
            continue;
        }
        let duplicate = graph
            .edges
            .iter()
            .any(|e| e.from == from && e.to == to && e.relation == relation);
        if duplicate {
            continue;
        }
        graph.edges.push(ArgEdge {
            id: format!("e{}", graph.edges.len() + 1),
            from: from.clone(),
            to,
            relation,
            rationale: frag.rationale.trim().to_string(),
        });
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn raw_number(v: &Value, key: &str) -> Option<f64> {
    match &v[key] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').parse::<f64>().ok(),
        _ => None,
    }
}

/// The factor that puts one evaluator's reply on 0..100. Decided once for the
/// whole reply, from its largest number: judged value by value, a strict 1 out
/// of 100 looked like a 1 out of 10 and came out as 100, turning the worst
/// score in the matrix into the best. Only a reply whose every number fits a
/// smaller scale is read on that scale.
fn scale_of(items: &[Value]) -> f64 {
    let top = items
        .iter()
        .flat_map(|item| {
            SCORE_KEYS
                .iter()
                .filter_map(|k| raw_number(&item["scores"], k))
                .chain(raw_number(item, "overall"))
        })
        .fold(0.0f64, f64::max);
    if top <= 1.0 {
        100.0
    } else if top <= 10.0 {
        10.0
    } else {
        1.0
    }
}

const SCORE_KEYS: [&str; 5] = ["rigor", "evidence", "novelty", "civility", "on_topic"];

fn score(v: &Value, key: &str, scale: f64) -> u8 {
    let n = raw_number(v, key).unwrap_or(0.0) * scale;
    n.clamp(0.0, 100.0).round() as u8
}

fn text_of(v: &Value, key: &str) -> String {
    match &v[key] {
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn stance_of(raw: &str) -> PeerStance {
    match raw.trim().to_ascii_lowercase().as_str() {
        "agree" | "agrees" | "agreed" => PeerStance::Agree,
        "disagree" | "disagrees" | "disagreed" | "against" => PeerStance::Disagree,
        _ => PeerStance::Mixed,
    }
}

/// The seat id a reply names, matched on id or display name in any case. The
/// prompt lists seats as `george (George)`, and a model that answers with the
/// name, or copies the whole label, still meant that seat.
fn resolve_seat(raw: &str, known: &[(String, String)]) -> Option<String> {
    let key = raw.split(" (").next().unwrap_or(raw).trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    known
        .iter()
        .find(|(id, name)| id.to_lowercase() == key || name.to_lowercase() == key)
        .map(|(id, _)| id.clone())
}

/// One evaluator's reply: a list of verdicts, one per seat they were asked
/// about. `known` is (id, display name) for every seat that may be scored.
/// Unknown targets are dropped rather than invented into the matrix.
pub fn parse_peer_eval(
    raw: &str,
    evaluator: &str,
    known: &[(String, String)],
) -> Vec<PeerCritique> {
    let Some(json) = super::parse::extract_json(raw) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(items) = v["evaluations"].as_array() else {
        return Vec::new();
    };
    let scale = scale_of(items);
    let mut out = Vec::new();
    for item in items {
        let Some(target) = resolve_seat(&text_of(item, "seat"), known) else {
            continue;
        };
        if target == evaluator {
            continue;
        }
        if out.iter().any(|c: &PeerCritique| c.target == target) {
            continue;
        }
        let scores = PeerScores {
            rigor: score(&item["scores"], "rigor", scale),
            evidence: score(&item["scores"], "evidence", scale),
            novelty: score(&item["scores"], "novelty", scale),
            civility: score(&item["scores"], "civility", scale),
            on_topic: score(&item["scores"], "on_topic", scale),
        };
        let overall = match raw_number(item, "overall") {
            None => scores.mean().round() as u8,
            Some(_) => score(item, "overall", scale),
        };
        out.push(PeerCritique {
            evaluator: evaluator.to_string(),
            target,
            scores,
            overall,
            stance: stance_of(&text_of(item, "stance")),
            critique: text_of(item, "critique"),
        });
    }
    out
}

fn kind_of(raw: &str) -> ArgNodeKind {
    match raw.trim().to_ascii_lowercase().as_str() {
        "premise" => ArgNodeKind::Premise,
        "evidence" => ArgNodeKind::Evidence,
        "rebuttal" | "rebut" | "objection" => ArgNodeKind::Rebuttal,
        "concession" | "concede" => ArgNodeKind::Concession,
        "question" => ArgNodeKind::Question,
        "assumption" => ArgNodeKind::Assumption,
        "definition" => ArgNodeKind::Definition,
        "proposal" => ArgNodeKind::Proposal,
        _ => ArgNodeKind::Claim,
    }
}

fn relation_of(raw: &str) -> Option<ArgRelation> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "supports" | "support" => Some(ArgRelation::Supports),
        "rebuts" | "rebut" => Some(ArgRelation::Rebuts),
        "concedes" | "concede" => Some(ArgRelation::Concedes),
        "restates" | "restate" => Some(ArgRelation::Restates),
        "refines" | "refine" => Some(ArgRelation::Refines),
        "agrees" | "agree" => Some(ArgRelation::Agrees),
        "contradicts" | "contradict" => Some(ArgRelation::Contradicts),
        "depends_on" | "dependson" => Some(ArgRelation::DependsOn),
        "answers" | "answer" => Some(ArgRelation::Answers),
        "addresses" | "address" => Some(ArgRelation::Addresses),
        _ => None,
    }
}

pub fn parse_fragments(raw: &str) -> Vec<ArgFragment> {
    let Some(json) = super::parse::extract_json(raw) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(items) = v["fragments"].as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let text = text_of(item, "text");
            if text.is_empty() {
                return None;
            }
            let target = {
                let t = text_of(item, "target");
                (!t.is_empty()).then_some(t)
            };
            Some(ArgFragment {
                kind: kind_of(&text_of(item, "kind")),
                text,
                by: text_of(item, "by"),
                relation: relation_of(&text_of(item, "relation")),
                target,
                rationale: text_of(item, "rationale"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn critique(evaluator: &str, target: &str, overall: u8) -> PeerCritique {
        PeerCritique {
            evaluator: evaluator.into(),
            target: target.into(),
            scores: PeerScores {
                rigor: overall,
                evidence: overall,
                novelty: overall,
                civility: overall,
                on_topic: overall,
            },
            overall,
            stance: PeerStance::Mixed,
            critique: "Thin on evidence. Worth another look.".into(),
        }
    }

    #[test]
    fn ranks_by_overall_and_leaves_unreviewed_seats_unranked() {
        let seats = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let critiques = vec![
            critique("b", "a", 40),
            critique("c", "a", 50),
            critique("a", "b", 90),
        ];
        let out = summarize(&seats, &critiques);
        assert_eq!(out["b"].rank, 1);
        assert_eq!(out["a"].rank, 2);
        // c was never reviewed: no rank, no reviews, and not ranked first.
        assert_eq!(out["c"].rank, 0);
        assert_eq!(out["c"].reviews_received, 0);
        assert_eq!(out["a"].reviews_received, 2);
        assert_eq!(out["a"].overall_average, 45.0);
    }

    #[test]
    fn standout_is_the_first_sentence_of_the_harshest_review() {
        let seats = vec!["a".to_string()];
        let mut harsh = critique("b", "a", 20);
        harsh.critique = "Circular on the main point. It never engaged the counterexample.".into();
        let out = summarize(&seats, &[critique("c", "a", 80), harsh]);
        assert_eq!(
            out["a"].standout.as_deref(),
            Some("Circular on the main point.")
        );
    }

    fn seats(ids: &[&str]) -> Vec<(String, String)> {
        ids.iter()
            .map(|id| (id.to_string(), id.to_uppercase()))
            .collect()
    }

    #[test]
    fn peer_eval_drops_self_reviews_unknown_seats_and_duplicates() {
        let known = seats(&["a", "b", "c"]);
        let raw = r#"{"evaluations":[
            {"seat":"a","scores":{"rigor":80,"evidence":70,"novelty":60,"civility":90,"on_topic":85},"overall":78,"stance":"agree","critique":"Solid."},
            {"seat":"a","scores":{"rigor":10,"evidence":10,"novelty":10,"civility":10,"on_topic":10},"overall":10,"stance":"disagree","critique":"Dup."},
            {"seat":"zz","scores":{"rigor":50,"evidence":50,"novelty":50,"civility":50,"on_topic":50},"overall":50,"stance":"mixed","critique":"Ghost."},
            {"seat":"c","scores":{"rigor":50,"evidence":50,"novelty":50,"civility":50,"on_topic":50},"overall":50,"stance":"mixed","critique":"Self."}
        ]}"#;
        let out = parse_peer_eval(raw, "c", &known);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].target, "a");
        assert_eq!(out[0].overall, 78);
        assert_eq!(out[0].stance, PeerStance::Agree);
    }

    #[test]
    fn a_strict_low_score_on_the_hundred_scale_stays_low() {
        // The prompt asks for 0 to 100 and for strictness. A 1 out of 100 must
        // not be mistaken for a 1 out of 10 and come out as the top score.
        let known = seats(&["a"]);
        let raw = r#"{"evaluations":[{"seat":"a","scores":{"rigor":60,"evidence":10,"novelty":5,"civility":80,"on_topic":1},"overall":20,"stance":"disagree","critique":"x"}]}"#;
        let out = parse_peer_eval(raw, "b", &known);
        assert_eq!(out[0].scores.evidence, 10);
        assert_eq!(out[0].scores.novelty, 5);
        assert_eq!(out[0].scores.on_topic, 1);
        assert_eq!(out[0].overall, 20);
    }

    #[test]
    fn a_reply_entirely_on_a_ten_scale_is_read_on_that_scale() {
        let known = seats(&["a", "c"]);
        let raw = r#"{"evaluations":[
            {"seat":"a","scores":{"rigor":8,"evidence":6,"novelty":7,"civility":9,"on_topic":10},"overall":8,"stance":"agree","critique":"x"},
            {"seat":"c","scores":{"rigor":2,"evidence":1,"novelty":3,"civility":7,"on_topic":5},"stance":"mixed","critique":"y"}
        ]}"#;
        let out = parse_peer_eval(raw, "b", &known);
        assert_eq!(out[0].scores.rigor, 80);
        assert_eq!(out[0].scores.on_topic, 100);
        assert_eq!(out[0].overall, 80);
        assert_eq!(out[1].scores.evidence, 10);
        // No "overall" in the reply: it falls back to the rubric mean.
        assert_eq!(out[1].overall, 36);
    }

    #[test]
    fn a_reply_entirely_on_a_unit_scale_is_read_on_that_scale() {
        let known = seats(&["a"]);
        let raw = r#"{"evaluations":[{"seat":"a","scores":{"rigor":0.8,"evidence":0.9,"novelty":0.5,"civility":1,"on_topic":0.7},"overall":0.75,"stance":"agree","critique":"x"}]}"#;
        let out = parse_peer_eval(raw, "b", &known);
        assert_eq!(out[0].scores.evidence, 90);
        assert_eq!(out[0].scores.civility, 100);
        assert_eq!(out[0].overall, 75);
    }

    #[test]
    fn a_seat_named_by_display_name_or_label_still_counts() {
        let known = vec![
            ("george".to_string(), "George".to_string()),
            ("cathy".to_string(), "Cathy".to_string()),
        ];
        let raw = r#"{"evaluations":[
            {"seat":"George","scores":{"rigor":70,"evidence":70,"novelty":70,"civility":70,"on_topic":70},"overall":70,"stance":"agree","critique":"x"},
            {"seat":"cathy (Cathy)","scores":{"rigor":60,"evidence":60,"novelty":60,"civility":60,"on_topic":60},"overall":60,"stance":"mixed","critique":"y"}
        ]}"#;
        let out = parse_peer_eval(raw, "kate", &known);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].target, "george");
        assert_eq!(out[1].target, "cathy");
    }

    #[test]
    fn the_same_claim_from_two_seats_is_one_node_with_two_speakers() {
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[ArgFragment {
                kind: ArgNodeKind::Claim,
                text: "Ranked choice voting reduces wasted votes in practice".into(),
                by: "george".into(),
                target: None,
                relation: None,
                rationale: String::new(),
            }],
            0,
        );
        merge_fragments(
            &mut g,
            &[ArgFragment {
                kind: ArgNodeKind::Claim,
                text: "In practice ranked choice voting reduces wasted votes".into(),
                by: "cathy".into(),
                target: None,
                relation: None,
                rationale: String::new(),
            }],
            1,
        );
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].by, vec!["george", "cathy"]);
    }

    #[test]
    fn an_unrelated_claim_is_its_own_node() {
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[
                ArgFragment {
                    kind: ArgNodeKind::Claim,
                    text: "Ranked choice voting reduces wasted votes".into(),
                    by: "george".into(),
                    target: None,
                    relation: None,
                    rationale: String::new(),
                },
                ArgFragment {
                    kind: ArgNodeKind::Rebuttal,
                    text: "Ballot exhaustion undermines that claim entirely".into(),
                    by: "cathy".into(),
                    target: Some("Ranked choice voting reduces wasted votes".into()),
                    relation: Some(ArgRelation::Rebuts),
                    rationale: "Exhausted ballots are wasted too".into(),
                },
            ],
            0,
        );
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].relation, ArgRelation::Rebuts);
        assert_eq!(g.edges[0].from, "n2");
        assert_eq!(g.edges[0].to, "n1");
    }

    #[test]
    fn an_edge_to_nothing_is_dropped_rather_than_pointed_at_the_nearest_node() {
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[ArgFragment {
                kind: ArgNodeKind::Rebuttal,
                text: "Turnout effects are overstated".into(),
                by: "kate".into(),
                target: Some("something nobody in this debate ever said".into()),
                relation: Some(ArgRelation::Rebuts),
                rationale: String::new(),
            }],
            0,
        );
        assert_eq!(g.nodes.len(), 1);
        assert!(g.edges.is_empty());
    }

    #[test]
    fn duplicate_edges_collapse() {
        let mut g = ArgGraph::default();
        let frags = vec![
            ArgFragment {
                kind: ArgNodeKind::Claim,
                text: "Turnout rises under automatic registration".into(),
                by: "a".into(),
                target: None,
                relation: None,
                rationale: String::new(),
            },
            ArgFragment {
                kind: ArgNodeKind::Evidence,
                text: "Oregon saw a four point rise after the 2016 rollout".into(),
                by: "b".into(),
                target: Some("Turnout rises under automatic registration".into()),
                relation: Some(ArgRelation::Supports),
                rationale: String::new(),
            },
        ];
        merge_fragments(&mut g, &frags, 0);
        merge_fragments(&mut g, &frags, 1);
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn fragments_parse_from_fenced_json_and_unknown_relations_drop_the_edge() {
        let raw = "```json\n{\"fragments\":[{\"kind\":\"rebuttal\",\"text\":\"X is false\",\"by\":\"a\",\"target\":\"X is true\",\"relation\":\"nonsense\",\"rationale\":\"r\"}]}\n```";
        let out = parse_fragments(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, ArgNodeKind::Rebuttal);
        assert!(out[0].relation.is_none());
    }

    #[test]
    fn junk_replies_yield_nothing_rather_than_panicking() {
        assert!(parse_fragments("I could not do that.").is_empty());
        assert!(parse_peer_eval("no json here", "a", &seats(&["b"])).is_empty());
        assert!(parse_fragments("{\"fragments\": \"not an array\"}").is_empty());
    }

    fn frag(
        kind: ArgNodeKind,
        text: &str,
        by: &str,
        target: Option<&str>,
        relation: Option<ArgRelation>,
    ) -> ArgFragment {
        ArgFragment {
            kind,
            text: text.into(),
            by: by.into(),
            target: target.map(Into::into),
            relation,
            rationale: String::new(),
        }
    }

    #[test]
    fn a_rebuttal_that_negates_a_claim_is_not_folded_into_it() {
        // These two score 0.93 on bag-of-words cosine. Merged, the rebutting
        // seat became a supporter and the rebuttal vanished from the map.
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[
                frag(
                    ArgNodeKind::Claim,
                    "Nuclear power is the safest energy source",
                    "a",
                    None,
                    None,
                ),
                frag(
                    ArgNodeKind::Rebuttal,
                    "Nuclear power is not the safest energy source",
                    "b",
                    Some("Nuclear power is the safest energy source"),
                    Some(ArgRelation::Rebuts),
                ),
            ],
            0,
        );
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.nodes[0].by, vec!["a"]);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].from, "n2");
        assert_eq!(g.edges[0].to, "n1");
    }

    #[test]
    fn a_claim_and_its_denial_stay_apart_even_as_the_same_kind() {
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[
                frag(
                    ArgNodeKind::Claim,
                    "Ranked choice voting reduces wasted votes",
                    "a",
                    None,
                    None,
                ),
                frag(
                    ArgNodeKind::Claim,
                    "Ranked choice voting doesn't reduce wasted votes",
                    "b",
                    None,
                    None,
                ),
            ],
            0,
        );
        assert_eq!(g.nodes.len(), 2);
    }

    #[test]
    fn the_same_wording_as_a_different_kind_is_a_different_node() {
        let mut g = ArgGraph::default();
        merge_fragments(
            &mut g,
            &[
                frag(
                    ArgNodeKind::Claim,
                    "Turnout rises under automatic registration",
                    "a",
                    None,
                    None,
                ),
                frag(
                    ArgNodeKind::Question,
                    "Turnout rises under automatic registration",
                    "b",
                    None,
                    None,
                ),
            ],
            0,
        );
        assert_eq!(g.nodes.len(), 2);
    }
}
