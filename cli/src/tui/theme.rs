//! Shared visual language for the TUI — the desktop app's palette, the eight
//! named agents with their provider colors, and the council-mark geometry.

use crate::types::Provider;
use ratatui::style::Color;

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

/// One inner-ring council agent, paired to a provider and its accent color.
pub struct AgentInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub provider: Provider,
    pub color: Color,
}

/// The eight speakers, in the app's canonical order, with the Home-page colors.
pub const AGENTS: [AgentInfo; 8] = [
    AgentInfo { id: "george", name: "George", provider: Provider::OpenAI, color: Color::Rgb(0x60, 0xA5, 0xFA) },
    AgentInfo { id: "cathy", name: "Cathy", provider: Provider::Anthropic, color: Color::Rgb(0xFB, 0xBF, 0x24) },
    AgentInfo { id: "grace", name: "Grace", provider: Provider::Google, color: Color::Rgb(0x34, 0xD3, 0x99) },
    AgentInfo { id: "douglas", name: "Douglas", provider: Provider::DeepSeek, color: Color::Rgb(0xF8, 0x71, 0x71) },
    AgentInfo { id: "kate", name: "Kate", provider: Provider::Kimi, color: Color::Rgb(0x2D, 0xD4, 0xBF) },
    AgentInfo { id: "quinn", name: "Quinn", provider: Provider::Qwen, color: Color::Rgb(0x22, 0xD3, 0xEE) },
    AgentInfo { id: "mary", name: "Mary", provider: Provider::MiniMax, color: Color::Rgb(0xF4, 0x72, 0xB6) },
    AgentInfo { id: "zara", name: "Zara", provider: Provider::Zhipu, color: Color::Rgb(0xA7, 0x8B, 0xFA) },
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
    AGENTS.iter().find(|a| a.id == agent_id).map(|a| a.color).unwrap_or_else(|| match agent_id {
        "user" => MUTED,
        _ => GOLD, // moderator / system
    })
}

/// Eight node positions on the unit circle (radius `r`) for the council mark,
/// slowly rotated by `phase` radians. Returned as `(x, y)` in canvas space.
pub fn ring_positions(r: f64, phase: f64) -> [(f64, f64); 8] {
    let mut pts = [(0.0, 0.0); 8];
    for (i, p) in pts.iter_mut().enumerate() {
        let angle = -std::f64::consts::FRAC_PI_2 + (i as f64) * std::f64::consts::TAU / 8.0 + phase;
        *p = (r * angle.cos(), r * angle.sin());
    }
    pts
}
