//! The ratatui terminal UI: a three-zone "chamber" — transcript on the left,
//! the council roster on the right, a header and a keybinding footer.

use crate::engine::{DebateEvent, Engine};
use crate::types::{Provider, Usage};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

const GOLD: Color = Color::Rgb(245, 197, 66);

pub struct AgentMeta {
    pub name: String,
    pub provider: Provider,
    pub model: String,
}

struct TurnView {
    name: String,
    model: String,
    content: String,
}

struct App {
    topic: String,
    roster: Vec<AgentMeta>,
    turns: Vec<TurnView>,
    streaming: Option<TurnView>,
    active: Option<String>,
    usage: Usage,
    turn_count: u32,
    show_thinking: bool,
    thinking: String,
    status: String,
    follow: bool,
    scroll: u16,
    done: bool,
}

impl App {
    fn new(topic: String, roster: Vec<AgentMeta>) -> Self {
        Self {
            topic,
            roster,
            turns: Vec::new(),
            streaming: None,
            active: None,
            usage: Usage::default(),
            turn_count: 0,
            show_thinking: false,
            thinking: String::new(),
            status: "Convening…".into(),
            follow: true,
            scroll: 0,
            done: false,
        }
    }

    fn apply(&mut self, ev: DebateEvent) {
        match ev {
            DebateEvent::Phase(p) => self.status = p,
            DebateEvent::Moderator(text) => self.turns.push(TurnView {
                name: "Moderator".into(),
                model: String::new(),
                content: text,
            }),
            DebateEvent::TurnStarted { name, model, .. } => {
                self.turn_count += 1;
                self.active = Some(name.clone());
                self.thinking.clear();
                self.streaming = Some(TurnView { name, model, content: String::new() });
            }
            DebateEvent::Token(t) => {
                if let Some(s) = self.streaming.as_mut() {
                    s.content.push_str(&t);
                }
            }
            DebateEvent::Thinking(t) => self.thinking.push_str(&t),
            DebateEvent::TurnEnded { usage } => {
                self.usage.input += usage.input;
                self.usage.output += usage.output;
                self.usage.reasoning += usage.reasoning;
                if let Some(s) = self.streaming.take() {
                    if !s.content.trim().is_empty() {
                        self.turns.push(s);
                    }
                }
                self.active = None;
            }
            DebateEvent::Error(e) => self.turns.push(TurnView {
                name: "⚠ Error".into(),
                model: String::new(),
                content: e,
            }),
            DebateEvent::Done => {
                self.done = true;
                self.status = "Done".into();
                self.active = None;
            }
        }
    }
}

/// Run the TUI to completion. Spawns the engine and renders its events.
pub async fn run(engine: Engine, roster: Vec<AgentMeta>, topic: String) -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let (tx, mut rx) = unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let engine_cancel = cancel.clone();
    let handle = tokio::spawn(async move { engine.run(tx, engine_cancel).await });

    let mut app = App::new(topic, roster);
    let res = run_loop(&mut terminal, &mut app, &cancel, &mut rx).await;

    // Stop the engine immediately — abort() cancels any in-flight request so
    // quitting never blocks on a slow turn.
    cancel.store(true, Ordering::Relaxed);
    handle.abort();
    let _ = handle.await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    res
}

async fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    cancel: &Arc<AtomicBool>,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<DebateEvent>,
) -> anyhow::Result<()> {
    loop {
        // Drain any pending debate events.
        while let Ok(ev) = rx.try_recv() {
            app.apply(ev);
        }

        terminal.draw(|f| ui(f, app))?;

        // Poll input briefly so the engine task keeps progressing.
        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        cancel.store(true, Ordering::Relaxed);
                        break;
                    }
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        cancel.store(true, Ordering::Relaxed);
                        break;
                    }
                    KeyCode::Char('t') => app.show_thinking = !app.show_thinking,
                    KeyCode::Up => {
                        app.follow = false;
                        app.scroll = app.scroll.saturating_sub(1);
                    }
                    KeyCode::Down => {
                        app.scroll = app.scroll.saturating_add(1);
                    }
                    KeyCode::PageUp => {
                        app.follow = false;
                        app.scroll = app.scroll.saturating_sub(10);
                    }
                    KeyCode::PageDown => app.scroll = app.scroll.saturating_add(10),
                    KeyCode::Char('g') => {
                        app.follow = true;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn ui(f: &mut Frame, app: &mut App) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(2)])
        .split(f.area());

    render_header(f, rows[0], app);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
        .split(rows[1]);

    render_transcript(f, body[0], app);
    render_roster(f, body[1], app);
    render_footer(f, rows[2], app);
}

fn render_header(f: &mut Frame, area: Rect, app: &App) {
    let title = Line::from(vec![
        Span::styled("  Socratic Council  ", Style::default().fg(Color::Black).bg(GOLD)),
        Span::raw("  "),
        Span::styled(truncate(&app.topic, area.width.saturating_sub(40) as usize), Style::default().fg(Color::White)),
    ]);
    let meta = format!(
        "turn {} · {} tok in / {} out · {}",
        app.turn_count, app.usage.input, app.usage.output, app.status
    );
    let para = Paragraph::new(vec![title, Line::from(Span::styled(meta, Style::default().fg(Color::DarkGray)))])
        .block(Block::default().borders(Borders::BOTTOM).border_style(Style::default().fg(Color::DarkGray)));
    f.render_widget(para, area);
}

fn render_transcript(f: &mut Frame, area: Rect, app: &mut App) {
    let mut lines: Vec<Line> = Vec::new();
    for turn in &app.turns {
        push_turn(&mut lines, &turn.name, &turn.model, &turn.content);
    }
    if app.show_thinking && !app.thinking.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("  ⋯ {}", truncate(&app.thinking, 200)),
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        )));
    }
    if let Some(s) = &app.streaming {
        push_turn(&mut lines, &format!("{} ▌", s.name), &s.model, &s.content);
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("  waiting for the first speaker…", Style::default().fg(Color::DarkGray))));
    }

    let inner_h = area.height.saturating_sub(2);
    let total = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    let max_off = total.saturating_sub(inner_h);
    // While following, keep scroll pinned at the bottom so the first manual
    // scroll-up starts from there instead of teleporting to the top.
    let scroll = if app.follow {
        app.scroll = max_off;
        max_off
    } else {
        app.scroll = app.scroll.min(max_off);
        app.scroll
    };

    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" Transcript "),
        );
    f.render_widget(para, area);
}

fn push_turn(lines: &mut Vec<Line>, name: &str, model: &str, content: &str) {
    let mut header = vec![Span::styled(
        name.to_string(),
        Style::default().fg(GOLD).add_modifier(Modifier::BOLD),
    )];
    if !model.is_empty() {
        header.push(Span::styled(format!("  {model}"), Style::default().fg(Color::DarkGray)));
    }
    lines.push(Line::from(header));
    for line in content.lines() {
        lines.push(Line::from(Span::raw(format!("  {line}"))));
    }
    if content.is_empty() {
        lines.push(Line::from(Span::raw("")));
    }
    lines.push(Line::from(""));
}

fn render_roster(f: &mut Frame, area: Rect, app: &App) {
    let items: Vec<ListItem> = app
        .roster
        .iter()
        .map(|a| {
            let is_active = app.active.as_deref() == Some(a.name.as_str());
            let marker = if is_active { "●" } else { "○" };
            let style = if is_active {
                Style::default().fg(GOLD).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!(" {marker} "), style),
                Span::styled(format!("{:<8}", a.name), style),
                Span::styled(a.provider.slug().to_string(), Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(" Council "),
    );
    f.render_widget(list, area);
}

fn render_footer(f: &mut Frame, area: Rect, app: &App) {
    let hint = if app.done {
        "q quit · t thinking · ↑/↓ scroll · g follow"
    } else {
        "q quit · t thinking · ↑/↓ scroll · g follow (running…)"
    };
    let para = Paragraph::new(Line::from(Span::styled(hint, Style::default().fg(Color::DarkGray))));
    f.render_widget(para, area);
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
