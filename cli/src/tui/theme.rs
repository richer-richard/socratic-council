//! Shared visual language for the TUI — the desktop app's palette, the eight
//! named agents with their provider colors, and the council-mark geometry.

use crate::types::Provider;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

/// Gold accent (`#F5C542`) — the app's signature.
pub const GOLD: Color = Color::Rgb(0xF5, 0xC5, 0x42);
/// Off-white body text (`#E8E8EF`).
pub const TEXT: Color = Color::Rgb(0xE8, 0xE8, 0xEF);
/// Muted slate for secondary text (`#94A3B8`).
pub const MUTED: Color = Color::Rgb(0x94, 0xA3, 0xB8);
/// Dim slate for borders / inactive (`#5B6172`).
pub const DIM: Color = Color::Rgb(0x5B, 0x61, 0x72);
/// Faint line color for the council-mark web.
pub const WEB: Color = Color::Rgb(0x3A, 0x40, 0x4E);
/// Emerald for settled / completed (`#34D399`).
pub const EMERALD: Color = Color::Rgb(0x34, 0xD3, 0x99);
/// Rose for dissent, errors and stops (`#FB7185`).
pub const ROSE: Color = Color::Rgb(0xFB, 0x71, 0x85);
/// Cyan for tool chips (`#22D3EE`).
pub const CYAN: Color = Color::Rgb(0x22, 0xD3, 0xEE);
/// The app's background (`#0B0F16`). The TUI leaves the terminal's own
/// background alone; this is only the base that heat cells blend against, so
/// a score reads as a weight of gold on the dark the desktop is drawn on.
pub const BG: Color = Color::Rgb(0x0B, 0x0F, 0x16);
/// Ink for text sitting on a strong gold fill, where TEXT would wash out.
pub const INK_ON_GOLD: Color = Color::Rgb(0x0B, 0x0F, 0x16);
/// Stance colours, as the desktop's critique graph draws them.
pub const AGREE: Color = EMERALD;
pub const DISAGREE: Color = Color::Rgb(0xF8, 0x71, 0x71);
pub const MIXED: Color = MUTED;

/// `base` moved `amount` (0..1) of the way toward `toward`. Both must be RGB;
/// anything else returns `toward` unchanged, which is the safe reading on a
/// terminal that only has named colours.
pub fn blend(base: Color, toward: Color, amount: f32) -> Color {
    match (base, toward) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let t = amount.clamp(0.0, 1.0);
            let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
            Color::Rgb(mix(r1, r2), mix(g1, g2), mix(b1, b2))
        }
        _ => toward,
    }
}

/// A heat cell for a 0..100 value: gold on the app's dark, squared so values
/// bunched between 40 and 95 still read as different cells (the desktop's
/// matrix uses the same ramp). Returns (background, foreground).
pub fn heat(value: u8) -> (Color, Color) {
    let w = (value.min(100) as f32) / 100.0;
    let bg = blend(BG, GOLD, 0.04 + w * w * 0.74);
    let fg = if w > 0.62 { INK_ON_GOLD } else { TEXT };
    (bg, fg)
}

/// One inner-ring council agent, paired to a provider and its accent color.
pub struct AgentInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub provider: Provider,
    pub color: Color,
}

/// The eight speakers, in the app's canonical order, with the Home-page colors.
pub const AGENTS: [AgentInfo; 8] = [
    AgentInfo {
        id: "george",
        name: "George",
        provider: Provider::OpenAI,
        color: Color::Rgb(0x60, 0xA5, 0xFA),
    },
    AgentInfo {
        id: "cathy",
        name: "Cathy",
        provider: Provider::Anthropic,
        color: Color::Rgb(0xFB, 0xBF, 0x24),
    },
    AgentInfo {
        id: "grace",
        name: "Grace",
        provider: Provider::Google,
        color: Color::Rgb(0x34, 0xD3, 0x99),
    },
    AgentInfo {
        id: "douglas",
        name: "Douglas",
        provider: Provider::DeepSeek,
        color: Color::Rgb(0xF8, 0x71, 0x71),
    },
    AgentInfo {
        id: "kate",
        name: "Kate",
        provider: Provider::Kimi,
        color: Color::Rgb(0x2D, 0xD4, 0xBF),
    },
    AgentInfo {
        id: "quinn",
        name: "Quinn",
        provider: Provider::Qwen,
        color: Color::Rgb(0x22, 0xD3, 0xEE),
    },
    AgentInfo {
        id: "mary",
        name: "Mary",
        provider: Provider::MiniMax,
        color: Color::Rgb(0xF4, 0x72, 0xB6),
    },
    AgentInfo {
        id: "zara",
        name: "Zara",
        provider: Provider::Zhipu,
        color: Color::Rgb(0xA7, 0x8B, 0xFA),
    },
];

/// Color for a provider's agent node.
pub fn provider_color(provider: Provider) -> Color {
    AGENTS
        .iter()
        .find(|a| a.provider == provider)
        .map(|a| a.color)
        .unwrap_or(MUTED)
}

/// Color for a transcript line, keyed by agent id (`george`…`zara`) or the
/// special `user` / `system` / moderator speakers.
pub fn speaker_color(agent_id: &str) -> Color {
    AGENTS
        .iter()
        .find(|a| a.id == agent_id)
        .map(|a| a.color)
        .unwrap_or_else(|| match agent_id {
            "user" => MUTED,
            _ => GOLD, // moderator / system
        })
}

/// `n` node positions on the unit circle (radius `r`) for the council mark,
/// slowly rotated by `phase` radians. Returned as `(x, y)` in canvas space.
pub fn ring_positions(n: usize, r: f64, phase: f64) -> Vec<(f64, f64)> {
    let n = n.max(1);
    (0..n)
        .map(|i| {
            let angle = -std::f64::consts::FRAC_PI_2
                + (i as f64) * std::f64::consts::TAU / n as f64
                + phase;
            (r * angle.cos(), r * angle.sin())
        })
        .collect()
}

/// A footer of `key what` hints, in priority order, cut from the end to fit
/// `width` rather than running off the edge. A hint either shows whole or not
/// at all, so a narrow terminal never shows a key without what it does.
pub fn hint_bar(hints: &[(&str, &str)], width: usize) -> Line<'static> {
    let mut spans = vec![Span::raw(" ")];
    let mut used = 1;
    for (key, what) in hints {
        let cost = key.chars().count() + what.chars().count() + 4;
        if used + cost > width {
            break;
        }
        used += cost;
        spans.push(Span::styled(
            key.to_string(),
            Style::default().fg(GOLD).add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(
            format!(" {what}   "),
            Style::default().fg(MUTED),
        ));
    }
    Line::from(spans)
}
