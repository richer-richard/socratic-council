//! The moderator's plan: what the session delivers, who takes part in which
//! role, what chores run first, and how many rounds the council gets.

/// The most cross-examination rounds a plan may ask for; the CLI flag and
/// the desktop's protocol limits agree on it.
pub const MAX_ROUNDS: u8 = 6;

use crate::types::Roster;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What a session produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Deliverable {
    /// Pick among options; the record is the decision.
    Decision,
    /// Answer an open question with evidence.
    Analysis,
    /// Write a work product; the document plus its record.
    Document,
    /// Critique an attached artifact; the record is a findings list.
    Review,
}

impl Deliverable {
    pub fn parse(s: &str) -> Option<Deliverable> {
        match s.trim().to_ascii_lowercase().as_str() {
            "decision" | "decide" | "choice" => Some(Deliverable::Decision),
            "analysis" | "answer" | "question" => Some(Deliverable::Analysis),
            "document" | "doc" | "plan" | "report" | "write" => Some(Deliverable::Document),
            "review" | "critique" | "audit" => Some(Deliverable::Review),
            _ => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Deliverable::Decision => "decision",
            Deliverable::Analysis => "analysis",
            Deliverable::Document => "document",
            Deliverable::Review => "review",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeatRole {
    /// Reasons in every round.
    Principal,
    /// Runs bounded chores before the positions round.
    Support,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    pub seat: String,
    pub role: SeatRole,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subtask {
    pub seat: String,
    pub task: String,
    pub tools: Vec<String>,
    pub word_cap: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub deliverable: Deliverable,
    pub question: String,
    pub options: Vec<String>,
    pub settles: String,
    pub participants: Vec<Participant>,
    pub lenses: BTreeMap<String, String>,
    pub subtasks: Vec<Subtask>,
    pub rounds: u8,
    pub ask_user: Option<String>,
}

/// Reasoning tier per round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoundTiers {
    pub positions: crate::types::ReasoningTier,
    pub cross: crate::types::ReasoningTier,
    pub revision: crate::types::ReasoningTier,
    pub subtask: crate::types::ReasoningTier,
    pub utility: crate::types::ReasoningTier,
    pub record: crate::types::ReasoningTier,
}

impl Default for RoundTiers {
    fn default() -> Self {
        use crate::types::ReasoningTier::*;
        Self {
            positions: High,
            cross: Medium,
            revision: High,
            subtask: Low,
            utility: Low,
            record: High,
        }
    }
}

/// The engine's caps on what a plan may ask for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProtocolPolicy {
    pub max_rounds: u8,
    pub max_principals: u8,
    /// The moderator may ask the user one clarifying question.
    pub interactive: bool,
    pub tiers: RoundTiers,
    /// Seats streaming at once inside a round.
    pub concurrency: usize,
}

impl Default for ProtocolPolicy {
    fn default() -> Self {
        Self {
            max_rounds: 3,
            max_principals: 8,
            interactive: true,
            tiers: RoundTiers::default(),
            concurrency: 4,
        }
    }
}

impl Plan {
    /// Check the plan against the roster and policy, correcting field by
    /// field; the corrections are reported to the user.
    pub fn validate(mut self, roster: &Roster, policy: &ProtocolPolicy) -> (Plan, Vec<String>) {
        let mut notes = Vec::new();
        let known = |id: &str| roster.seat(id).is_some();

        let before = self.participants.len();
        self.participants.retain(|p| known(&p.seat));
        if self.participants.len() < before {
            notes.push(format!(
                "dropped {} participant(s) not on the roster",
                before - self.participants.len()
            ));
        }
        // Dedupe by seat, first mention wins.
        let mut seen = std::collections::BTreeSet::new();
        self.participants.retain(|p| seen.insert(p.seat.clone()));

        let principals = self
            .participants
            .iter()
            .filter(|p| p.role == SeatRole::Principal)
            .count();
        if principals == 0 {
            // Everyone on the roster reasons when the plan named nobody.
            let existing: std::collections::BTreeSet<String> =
                self.participants.iter().map(|p| p.seat.clone()).collect();
            for s in &roster.seats {
                if !existing.contains(&s.id) {
                    self.participants.push(Participant {
                        seat: s.id.clone(),
                        role: SeatRole::Principal,
                        reason: "default: every seat reasons".into(),
                    });
                }
            }
            if self
                .participants
                .iter()
                .all(|p| p.role == SeatRole::Support)
            {
                for p in &mut self.participants {
                    p.role = SeatRole::Principal;
                }
            }
            notes.push("no principals named; every roster seat reasons".into());
        }
        let mut principal_count = 0;
        for p in &mut self.participants {
            if p.role == SeatRole::Principal {
                principal_count += 1;
                if principal_count > policy.max_principals as usize {
                    p.role = SeatRole::Support;
                    notes.push(format!(
                        "{} demoted to support: more than {} principals",
                        p.seat, policy.max_principals
                    ));
                }
            }
        }

        let before = self.subtasks.len();
        let support: std::collections::BTreeSet<String> = self
            .participants
            .iter()
            .filter(|p| p.role == SeatRole::Support)
            .map(|p| p.seat.clone())
            .collect();
        self.subtasks.retain(|t| known(&t.seat));
        if self.subtasks.len() < before {
            notes.push("dropped subtask(s) for seats not on the roster".into());
        }
        for t in &mut self.subtasks {
            if !support.contains(&t.seat) {
                // A principal may still run a chore; note it so the record is honest.
                notes.push(format!("subtask for {} runs on a principal seat", t.seat));
            }
            t.word_cap = t.word_cap.clamp(60, 400);
        }
        self.lenses.retain(|k, _| known(k));

        if self.rounds == 0 {
            self.rounds = 1;
        }
        if self.rounds > policy.max_rounds.max(1) {
            notes.push(format!("rounds capped at {}", policy.max_rounds.max(1)));
            self.rounds = policy.max_rounds.max(1);
        }
        if !policy.interactive && self.ask_user.is_some() {
            notes.push("clarifying question dropped: session is not interactive".into());
            self.ask_user = None;
        }
        if self.deliverable == Deliverable::Decision && self.options.len() < 2 {
            notes.push("decision without two options; treated as an analysis".into());
            self.deliverable = Deliverable::Analysis;
        }
        (self, notes)
    }

    /// The plan used when the planner fails: every seat reasons, one round.
    pub fn default_for(topic: &str, roster: &Roster, forced: Option<Deliverable>) -> Plan {
        Plan {
            deliverable: forced.unwrap_or(Deliverable::Analysis),
            question: topic.trim().to_string(),
            options: Vec::new(),
            settles: String::new(),
            participants: roster
                .seats
                .iter()
                .map(|s| Participant {
                    seat: s.id.clone(),
                    role: SeatRole::Principal,
                    reason: "default plan".into(),
                })
                .collect(),
            lenses: BTreeMap::new(),
            subtasks: Vec::new(),
            rounds: 1,
            ask_user: None,
        }
    }

    pub fn principals(&self) -> Vec<&str> {
        self.participants
            .iter()
            .filter(|p| p.role == SeatRole::Principal)
            .map(|p| p.seat.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelChoice, Provider, ReasoningTier, Seat};

    fn roster(ids: &[&str]) -> Roster {
        Roster {
            seats: ids
                .iter()
                .map(|id| Seat {
                    id: id.to_string(),
                    name: id.to_uppercase(),
                    provider: Provider::OpenAI,
                    model: ModelChoice::Auto(ReasoningTier::High),
                    reasoning: None,
                })
                .collect(),
        }
    }

    #[test]
    fn plan_validate_drops_unknown_seats_and_caps_rounds() {
        let mut p = Plan::default_for("t", &roster(&["a", "b"]), None);
        p.participants.push(Participant {
            seat: "ghost".into(),
            role: SeatRole::Principal,
            reason: String::new(),
        });
        p.subtasks.push(Subtask {
            seat: "ghost".into(),
            task: "x".into(),
            tools: vec![],
            word_cap: 9,
        });
        p.lenses.insert("ghost".into(), "l".into());
        p.rounds = 9;
        p.ask_user = Some("why?".into());
        let policy = ProtocolPolicy {
            max_rounds: 2,
            interactive: false,
            ..ProtocolPolicy::default()
        };
        let (p, notes) = p.validate(&roster(&["a", "b"]), &policy);
        assert_eq!(p.participants.len(), 2);
        assert!(p.subtasks.is_empty());
        assert!(p.lenses.is_empty());
        assert_eq!(p.rounds, 2);
        assert!(p.ask_user.is_none());
        assert!(notes.iter().any(|n| n.contains("rounds capped")));
    }

    #[test]
    fn plan_default_when_planner_fails_uses_all_seats_as_principals() {
        let p = Plan::default_for(
            "Should we?",
            &roster(&["a", "b", "c"]),
            Some(Deliverable::Decision),
        );
        assert_eq!(p.principals(), vec!["a", "b", "c"]);
        assert_eq!(p.rounds, 1);
        // A decision with no options is downgraded on validation.
        let (p, notes) = p.validate(&roster(&["a", "b", "c"]), &ProtocolPolicy::default());
        assert_eq!(p.deliverable, Deliverable::Analysis);
        assert!(notes.iter().any(|n| n.contains("two options")));
    }

    #[test]
    fn validate_promotes_when_nobody_is_principal_and_caps_principals() {
        let mut p = Plan::default_for("t", &roster(&["a", "b", "c"]), None);
        for x in &mut p.participants {
            x.role = SeatRole::Support;
        }
        let (p, _) = p.validate(&roster(&["a", "b", "c"]), &ProtocolPolicy::default());
        assert_eq!(p.principals().len(), 3);
        let p2 = Plan::default_for("t", &roster(&["a", "b", "c"]), None);
        let policy = ProtocolPolicy {
            max_principals: 2,
            ..ProtocolPolicy::default()
        };
        let (p2, notes) = p2.validate(&roster(&["a", "b", "c"]), &policy);
        assert_eq!(p2.principals().len(), 2);
        assert!(notes.iter().any(|n| n.contains("demoted")));
    }
}
