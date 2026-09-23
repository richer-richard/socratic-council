//! Shared visual language for the TUI — the desktop app's palette, the eight
//! named agents with their provider colors, and the council-mark geometry.

use crate::types::Provider;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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

/// `s` cut to `max` display columns, with an ellipsis when anything was cut.
/// Counts columns rather than chars, so a CJK name stops where the room does.
pub fn truncate(s: &str, max: usize) -> String {
    if s.width() <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in s.chars() {
        let w = ch.width().unwrap_or(0);
        if used + w + 1 > max {
            break;
        }
        used += w;
        out.push(ch);
    }
    out.push('…');
    out
}

/// The narrowest a text column beside a lead may get before the text moves
/// under the lead instead.
const HANG_MIN: usize = 16;

/// `text` wrapped to `width`, the first row after `lead` and the rest indented
/// to line up under it. A label and its value, the way a printed form sets
/// them, rather than continuation lines snapping back to the margin. When the
/// lead leaves too little room beside it, it takes a row of its own and the
/// text wraps underneath.
pub fn hanging(
    lead: Vec<Span<'static>>,
    text: &str,
    text_style: Style,
    width: usize,
) -> Vec<Line<'static>> {
    let lead_w: usize = lead.iter().map(|s| s.content.width()).sum();
    let beside = width >= lead_w + HANG_MIN;
    let indent = if beside {
        lead_w
    } else {
        lead_w.min(width.saturating_sub(HANG_MIN))
    };
    let room = width.saturating_sub(indent).max(1);
    let rows = textwrap::wrap(text, room);
    let mut out = Vec::new();
    if rows.is_empty() || !beside {
        out.push(Line::from(lead.clone()));
    }
    for (i, row) in rows.iter().enumerate() {
        let mut spans = if i == 0 && beside {
            lead.clone()
        } else {
            vec![Span::raw(" ".repeat(indent))]
        };
        spans.push(Span::styled(row.to_string(), text_style));
        out.push(Line::from(spans));
    }
    out
}

/// Lines no wider than `width`: a row that runs past the edge carries on to
/// the next row instead of being clipped. The views wrap their own text, so
/// this only catches what a fixed-width part pushes over, such as a long name
/// in a label column on a narrow terminal. The row count stays exact, which
/// the scroll clamp relies on.
pub fn fit(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    if width == 0 {
        return lines;
    }
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        if line.width() <= width {
            out.push(line);
            continue;
        }
        let line_style = line.style;
        let mut row: Vec<Span<'static>> = Vec::new();
        let mut used = 0;
        for span in line.spans {
            let mut chunk = String::new();
            for ch in span.content.chars() {
                let w = ch.width().unwrap_or(0);
                if used + w > width && used > 0 {
                    if !chunk.is_empty() {
                        row.push(Span::styled(std::mem::take(&mut chunk), span.style));
                    }
                    out.push(Line::from(std::mem::take(&mut row)).style(line_style));
                    used = 0;
                }
                chunk.push(ch);
                used += w;
            }
            if !chunk.is_empty() {
                row.push(Span::styled(chunk, span.style));
            }
        }
        if !row.is_empty() {
            out.push(Line::from(row).style(line_style));
        }
    }
    out
}

/// Dollars as both clients print them: cents from a dime up, four places
/// below that, so a cheap test run does not read as free.
pub fn usd(n: f64) -> String {
    if n >= 10.0 {
        format!("${n:.1}")
    } else if n >= 0.1 || n == 0.0 {
        format!("${n:.2}")
    } else {
        format!("${n:.4}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line]) -> String {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn truncate_counts_columns_not_chars() {
        assert_eq!(truncate("Anna", 10), "Anna");
        assert_eq!(truncate("Extraordinary", 6), "Extra…");
        let cut = truncate("精神分析学者", 7);
        assert_eq!(cut, "精神分…");
        assert!(cut.width() <= 7);
        assert_eq!(truncate("abc", 0), "");
    }

    #[test]
    fn hanging_puts_text_under_a_lead_that_leaves_no_room() {
        let lead = vec![Span::raw("x".repeat(49))];
        let out = hanging(
            lead,
            "a value long enough to wrap twice here",
            Style::default(),
            56,
        );
        assert_eq!(text(&out[..1]), "x".repeat(49), "the lead has its own row");
        assert!(out.iter().all(|l| l.width() <= 56), "{out:?}");
        // With room beside it, the text starts on the lead's row.
        let out = hanging(vec![Span::raw("Label  ")], "value", Style::default(), 56);
        assert_eq!(text(&out), "Label  value");
    }

    #[test]
    fn fit_carries_an_overlong_row_on_instead_of_clipping_it() {
        let line = Line::from(vec![Span::raw("abcdefghij"), Span::raw("klmnopqrst")]);
        let out = fit(vec![line, Line::from("short")], 8);
        assert_eq!(text(&out), "abcdefgh\nijklmnop\nqrst\nshort");
        assert!(out.iter().all(|l| l.width() <= 8));
    }

    #[test]
    fn usd_keeps_a_cheap_run_from_reading_as_free() {
        assert_eq!(usd(0.003), "$0.0030");
        assert_eq!(usd(0.0745), "$0.0745");
        assert_eq!(usd(0.0), "$0.00");
        assert_eq!(usd(0.49), "$0.49");
        assert_eq!(usd(12.34), "$12.3");
    }
}
