//! Text hygiene shared by every surface.

/// Strip terminal control characters from model-derived text, keeping `\n` and
/// `\t`. Blocks ANSI/OSC escape injection (cursor games, title/clipboard
/// writes) in both the plain `--no-tui` output and the TUI buffer.
pub fn sanitize_terminal(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}
