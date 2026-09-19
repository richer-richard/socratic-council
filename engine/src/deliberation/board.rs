//! The board: the compact state of the debate every seat reads instead of a
//! transcript. Rewritten by a utility call after each round.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Disagreement {
    pub between: Vec<String>,
    pub about: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub claim: String,
    pub source: String,
    pub by: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Board {
    pub settled: Vec<String>,
    pub disagreements: Vec<Disagreement>,
    pub evidence: Vec<Evidence>,
    pub open_questions: Vec<String>,
    /// One line per principal.
    pub positions: BTreeMap<String, String>,
}

impl Board {
    /// Add evidence without duplicating a claim already on the board.
    pub fn merge_evidence(&mut self, items: Vec<Evidence>) {
        for e in items {
            if e.claim.trim().is_empty() {
                continue;
            }
            if !self
                .evidence
                .iter()
                .any(|x| x.claim.eq_ignore_ascii_case(&e.claim))
            {
                self.evidence.push(e);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.settled.is_empty()
            && self.disagreements.is_empty()
            && self.evidence.is_empty()
            && self.open_questions.is_empty()
            && self.positions.is_empty()
    }

    /// The board as the seats read it.
    pub fn to_prompt_text(&self, names: &BTreeMap<String, String>) -> String {
        let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
        let mut out = String::new();
        if self.is_empty() {
            return "BOARD: (nothing settled yet)".into();
        }
        out.push_str("BOARD\n");
        if !self.positions.is_empty() {
            out.push_str("Positions:\n");
            for (id, p) in &self.positions {
                out.push_str(&format!("- {}: {}\n", name(id), p));
            }
        }
        if !self.settled.is_empty() {
            out.push_str("Settled:\n");
            for s in &self.settled {
                out.push_str(&format!("- {s}\n"));
            }
        }
        if !self.disagreements.is_empty() {
            out.push_str("Live disagreements:\n");
            for d in &self.disagreements {
                let who: Vec<String> = d.between.iter().map(|b| name(b)).collect();
                out.push_str(&format!("- {} on: {}\n", who.join(" vs "), d.about));
            }
        }
        if !self.evidence.is_empty() {
            out.push_str("Evidence:\n");
            for e in &self.evidence {
                let src = if e.source.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", e.source)
                };
                let by = if e.by.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", name(&e.by))
                };
                out.push_str(&format!("- {}{src}{by}\n", e.claim));
            }
        }
        if !self.open_questions.is_empty() {
            out.push_str("Open questions:\n");
            for q in &self.open_questions {
                out.push_str(&format!("- {q}\n"));
            }
        }
        out.trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_text_round_trip_and_evidence_merge() {
        let mut b = Board::default();
        assert_eq!(
            b.to_prompt_text(&BTreeMap::new()),
            "BOARD: (nothing settled yet)"
        );
        b.settled.push("s".into());
        b.disagreements.push(Disagreement {
            between: vec!["a".into(), "b".into()],
            about: "x".into(),
        });
        b.positions.insert("a".into(), "yes".into());
        b.merge_evidence(vec![
            Evidence {
                claim: "C".into(),
                source: "u".into(),
                by: "a".into(),
            },
            Evidence {
                claim: "c".into(),
                source: "u2".into(),
                by: "b".into(),
            },
            Evidence {
                claim: " ".into(),
                source: String::new(),
                by: String::new(),
            },
        ]);
        assert_eq!(b.evidence.len(), 1, "case-insensitive dedupe");
        let mut names = BTreeMap::new();
        names.insert("a".to_string(), "Ada".to_string());
        let t = b.to_prompt_text(&names);
        assert!(t.contains("- Ada: yes"));
        assert!(t.contains("Ada vs b on: x"));
        assert!(t.contains("- C [u] (Ada)"));
    }
}
