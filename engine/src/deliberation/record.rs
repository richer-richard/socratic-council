//! The decision record: what a session leaves behind.

use super::board::Evidence;
use super::plan::Deliverable;
use crate::types::CostSnapshot;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OptionConsidered {
    pub option: String,
    pub why_not: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Dissent {
    pub seat: String,
    pub position: String,
    pub why_not_carried: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub deliverable: Deliverable,
    pub question: String,
    pub answer: String,
    pub confidence: f32,
    pub options_considered: Vec<OptionConsidered>,
    pub dissent: Vec<Dissent>,
    pub assumptions: Vec<String>,
    pub evidence: Vec<Evidence>,
    pub open_questions: Vec<String>,
    pub next_actions: Vec<String>,
    pub what_changed: String,
    /// Seat id → vote (an option, or endorse / dissent).
    pub votes: BTreeMap<String, String>,
    pub cost: Option<CostSnapshot>,
}

fn section(out: &mut String, title: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    out.push_str(&format!("\n## {title}\n\n"));
    for i in items {
        out.push_str(&format!("- {i}\n"));
    }
}

/// The record as Markdown, with the document (when the session wrote one)
/// appended after it.
pub fn to_markdown(
    record: &DecisionRecord,
    names: &BTreeMap<String, String>,
    document: Option<&str>,
) -> String {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let mut out = String::new();
    out.push_str(&format!(
        "# {}\n\n",
        if record.question.is_empty() {
            "Decision record"
        } else {
            &record.question
        }
    ));
    out.push_str(&format!(
        "**Deliverable:** {}  \n",
        record.deliverable.label()
    ));
    out.push_str(&format!(
        "**Confidence:** {:.0}%\n\n",
        record.confidence * 100.0
    ));
    out.push_str("## Answer\n\n");
    out.push_str(record.answer.trim());
    out.push('\n');
    if !record.options_considered.is_empty() {
        out.push_str("\n## Options considered\n\n");
        for o in &record.options_considered {
            out.push_str(&format!("- **{}**: {}\n", o.option, o.why_not));
        }
    }
    if !record.dissent.is_empty() {
        out.push_str("\n## Dissent\n\n");
        for d in &record.dissent {
            out.push_str(&format!(
                "- **{}**: {} ({})\n",
                name(&d.seat),
                d.position,
                d.why_not_carried
            ));
        }
    }
    section(&mut out, "Assumptions", &record.assumptions);
    if !record.evidence.is_empty() {
        out.push_str("\n## Evidence\n\n");
        for e in &record.evidence {
            let src = if e.source.is_empty() {
                String::new()
            } else {
                format!(" — {}", e.source)
            };
            out.push_str(&format!("- {}{src}\n", e.claim));
        }
    }
    section(&mut out, "Open questions", &record.open_questions);
    section(&mut out, "Next actions", &record.next_actions);
    if !record.what_changed.trim().is_empty() {
        out.push_str("\n## What changed\n\n");
        out.push_str(record.what_changed.trim());
        out.push('\n');
    }
    if !record.votes.is_empty() {
        out.push_str("\n## Votes\n\n");
        for (id, v) in &record.votes {
            out.push_str(&format!("- {}: {}\n", name(id), v));
        }
    }
    if let Some(c) = &record.cost {
        out.push_str(&format!(
            "\n## Cost\n\n{}${:.4} ({} in / {} out / {} reasoning tokens)\n",
            if c.all_priced { "" } else { "≥ " },
            c.total_usd,
            c.total_input,
            c.total_output,
            c.total_reasoning
        ));
    }
    if let Some(doc) = document {
        out.push_str("\n---\n\n");
        out.push_str(doc.trim());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_markdown_has_dissent_and_next_actions_sections() {
        let mut votes = BTreeMap::new();
        votes.insert("a".to_string(), "endorse".to_string());
        let r = DecisionRecord {
            deliverable: Deliverable::Decision,
            question: "Q?".into(),
            answer: "A".into(),
            confidence: 0.8,
            options_considered: vec![OptionConsidered {
                option: "B".into(),
                why_not: "slow".into(),
            }],
            dissent: vec![Dissent {
                seat: "b".into(),
                position: "B".into(),
                why_not_carried: "cost".into(),
            }],
            assumptions: vec!["x".into()],
            evidence: vec![Evidence {
                claim: "c".into(),
                source: "s".into(),
                by: "a".into(),
            }],
            open_questions: vec![],
            next_actions: vec!["do it".into()],
            what_changed: "a moved".into(),
            votes,
            cost: None,
        };
        let mut names = BTreeMap::new();
        names.insert("b".to_string(), "Bea".to_string());
        let md = to_markdown(&r, &names, Some("# Doc\nbody"));
        assert!(md.starts_with("# Q?\n"));
        assert!(md.contains("## Dissent\n\n- **Bea**: B (cost)"));
        assert!(md.contains("## Next actions\n\n- do it"));
        assert!(!md.contains("## Open questions"));
        assert!(md.contains("**Confidence:** 80%"));
        assert!(md.ends_with("# Doc\nbody\n"));
    }
}
