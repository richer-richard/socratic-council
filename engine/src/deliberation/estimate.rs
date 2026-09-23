//! A cost estimate before the run, from the plan and the roster's prices.

use super::plan::{Deliverable, Plan, SeatRole};
use crate::catalog::Pricing;
use crate::types::ReasoningTier;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Estimate {
    pub calls: u32,
    pub usd_low: f64,
    pub usd_high: f64,
    /// Seats whose model has no published price (the estimate is a floor).
    pub unpriced_seats: Vec<String>,
}

/// One priced participant as the estimator sees it.
pub struct PricedSeat {
    pub id: String,
    pub role: SeatRole,
    pub pricing: Pricing,
}

fn reasoning_tokens(tier: ReasoningTier) -> f64 {
    match tier {
        ReasoningTier::Low => 300.0,
        ReasoningTier::Medium => 1500.0,
        ReasoningTier::High => 4000.0,
    }
}

fn call_usd(p: &Pricing, input: f64, output: f64, reasoning: f64) -> Option<f64> {
    let i = p.input?;
    let o = p.output?;
    Some((input * i + (output + reasoning) * o) / 1_000_000.0)
}

/// Calls and dollars for `plan` with the given seats, moderator and utility
/// prices and round tiers.
pub fn estimate(
    plan: &Plan,
    seats: &[PricedSeat],
    moderator: &Pricing,
    utility: &Pricing,
    tiers: &super::plan::RoundTiers,
    review: bool,
) -> Estimate {
    let principals: Vec<&PricedSeat> = seats
        .iter()
        .filter(|s| s.role == SeatRole::Principal)
        .collect();
    let n = principals.len() as f64;
    let base_input = 1200.0 + 250.0 * n;
    let mut calls = 0u32;
    let mut usd = 0.0f64;
    let mut unpriced = Vec::new();

    let mut add = |p: &Pricing, id: &str, input: f64, output: f64, tier: ReasoningTier| {
        calls += 1;
        match call_usd(p, input, output, reasoning_tokens(tier)) {
            Some(u) => usd += u,
            None => {
                if !unpriced.iter().any(|x| x == id) {
                    unpriced.push(id.to_string());
                }
            }
        }
    };

    // Plan.
    add(moderator, "moderator", base_input, 600.0, tiers.utility);
    // Subtasks.
    for t in &plan.subtasks {
        let p = seats
            .iter()
            .find(|s| s.id == t.seat)
            .map(|s| &s.pricing)
            .unwrap_or(utility);
        add(
            p,
            &t.seat,
            base_input,
            f64::from(t.word_cap) * 1.5,
            tiers.subtask,
        );
    }
    // Positions.
    for s in &principals {
        add(&s.pricing, &s.id, base_input, 270.0, tiers.positions);
    }
    // Rounds: cross-examination per principal, then board and convergence.
    for _ in 0..plan.rounds.max(1) {
        for s in &principals {
            add(
                &s.pricing,
                &s.id,
                base_input + 220.0 * n,
                225.0,
                tiers.cross,
            );
        }
        add(
            utility,
            "utility",
            base_input + 300.0 * n,
            500.0,
            tiers.utility,
        );
        add(utility, "utility", base_input, 150.0, tiers.utility);
    }
    // Revision.
    for s in &principals {
        add(
            &s.pricing,
            &s.id,
            base_input + 300.0 * n,
            225.0,
            tiers.revision,
        );
    }
    // Record.
    add(
        moderator,
        "moderator",
        base_input + 500.0 * n,
        900.0,
        tiers.record,
    );
    if plan.deliverable == Deliverable::Document {
        add(
            moderator,
            "moderator",
            base_input + 500.0 * n,
            1800.0,
            tiers.record,
        );
        for s in &principals {
            add(&s.pricing, &s.id, base_input + 1800.0, 300.0, tiers.cross);
        }
        add(
            moderator,
            "moderator",
            base_input + 2400.0,
            1800.0,
            tiers.record,
        );
    }
    // Review: one peer-evaluation call per principal, then one argument-map
    // extraction per round the debate logged (positions, each cross round, and
    // the revision). Both run on the utility slot, and both read the whole
    // transcript, which is what makes their input large and their output small.
    if review && principals.len() > 1 {
        let transcript = base_input + 1400.0 * n * (plan.rounds.max(1) as f64 + 2.0);
        for s in &principals {
            add(utility, &s.id, transcript, 800.0, tiers.utility);
        }
        for _ in 0..(plan.rounds.max(1) as u32 + 2) {
            add(utility, "utility", base_input + 1600.0 * n, 700.0, tiers.utility);
        }
    }
    Estimate {
        calls,
        usd_low: usd,
        usd_high: usd * 1.6,
        unpriced_seats: unpriced,
    }
}

#[cfg(test)]
mod tests {
    use super::super::plan::{Participant, RoundTiers};
    use super::*;
    use crate::types::Roster;

    #[test]
    fn estimate_counts_calls_for_one_round_four_principals() {
        let roster = Roster::default_eight().take(4);
        let plan = Plan::default_for("t", &roster, None);
        let seats: Vec<PricedSeat> = roster
            .seats
            .iter()
            .map(|s| PricedSeat {
                id: s.id.clone(),
                role: SeatRole::Principal,
                pricing: Pricing::usd(1.0, 0.1, 5.0),
            })
            .collect();
        let e = estimate(
            &plan,
            &seats,
            &Pricing::usd(1.0, 0.1, 5.0),
            &Pricing::usd(0.1, 0.01, 0.4),
            &RoundTiers::default(),
            false,
        );
        // 1 plan + 4 positions + (4 cross + 2 utility) + 4 revision + 1 record = 16
        assert_eq!(e.calls, 16);
        assert!(e.usd_low > 0.0 && e.usd_high > e.usd_low);
        assert!(e.unpriced_seats.is_empty());

        // The review pass is the same run plus one peer evaluation per
        // principal and one argument-map extraction per logged round.
        let reviewed = estimate(
            &plan,
            &seats,
            &Pricing::usd(1.0, 0.1, 5.0),
            &Pricing::usd(0.1, 0.01, 0.4),
            &RoundTiers::default(),
            true,
        );
        assert_eq!(reviewed.calls, 16 + 4 + 3);
        // Both passes are on the cheap utility price, so the review is a small
        // fraction of the bill rather than a second debate's worth.
        assert!(reviewed.usd_low > e.usd_low);
        assert!(reviewed.usd_low < e.usd_low * 1.5);
    }

    #[test]
    fn unpriced_seats_are_reported_and_documents_cost_more() {
        let roster = Roster::default_eight().take(2);
        let mut plan = Plan::default_for("t", &roster, Some(Deliverable::Document));
        plan.participants = vec![
            Participant {
                seat: "george".into(),
                role: SeatRole::Principal,
                reason: String::new(),
            },
            Participant {
                seat: "cathy".into(),
                role: SeatRole::Principal,
                reason: String::new(),
            },
        ];
        let seats = vec![
            PricedSeat {
                id: "george".into(),
                role: SeatRole::Principal,
                pricing: Pricing::usd(1.0, 0.1, 5.0),
            },
            PricedSeat {
                id: "cathy".into(),
                role: SeatRole::Principal,
                pricing: Pricing::default(),
            },
        ];
        let e = estimate(
            &plan,
            &seats,
            &Pricing::usd(1.0, 0.1, 5.0),
            &Pricing::usd(0.1, 0.01, 0.4),
            &RoundTiers::default(),
            false,
        );
        assert_eq!(e.unpriced_seats, vec!["cathy"]);
        // 1 + 2 + (2 + 2) + 2 + 1 + document (1 + 2 + 1) = 14
        assert_eq!(e.calls, 14);
    }
}
