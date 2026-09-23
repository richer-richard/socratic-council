//! Slash commands. A `/` and a command name in the Home composer, or on the
//! command line `/` opens over a session, runs the command instead of
//! convening the council. While you type, the commands that start with what
//! you typed are listed above the input, then the close matches, so a typo
//! still finds its command.
//!
//! The desktop app has the same commands under the same names
//! (`apps/desktop/src/utils/slash.ts`, parity-tested against this list), less
//! `/sessions`, since its sessions list is always on screen.

/// Where a command line is open.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Place {
    Home,
    Session,
}

/// What a command takes after its name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arg {
    None,
    /// One of a fixed set of words.
    Choice(&'static [&'static str]),
    /// A saved session, by title.
    Session,
}

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub arg: Arg,
    pub about: &'static str,
    pub home: bool,
    pub session: bool,
}

impl Command {
    fn usage(&self) -> String {
        match self.arg {
            Arg::None => format!("/{}", self.name),
            Arg::Choice(words) => format!("/{} {}", self.name, words.join("|")),
            Arg::Session => format!("/{} <session title>", self.name),
        }
    }

    fn available(&self, place: Place) -> bool {
        match place {
            Place::Home => self.home,
            Place::Session => self.session,
        }
    }
}

pub const COMMANDS: &[Command] = &[
    Command {
        name: "council",
        aliases: &[],
        arg: Arg::Choice(&["quick", "standard", "full"]),
        about: "how many seats sit",
        home: true,
        session: false,
    },
    Command {
        name: "deliverable",
        aliases: &[],
        arg: Arg::Choice(&["auto", "decision", "analysis", "document", "review"]),
        about: "what the council leaves you",
        home: true,
        session: false,
    },
    Command {
        name: "review",
        aliases: &[],
        arg: Arg::Choice(&["on", "off"]),
        about: "peer review after the record",
        home: true,
        session: false,
    },
    Command {
        name: "open",
        aliases: &[],
        arg: Arg::Session,
        about: "open a saved session",
        home: true,
        session: false,
    },
    Command {
        name: "sessions",
        aliases: &[],
        arg: Arg::None,
        about: "show or hide the sessions list",
        home: true,
        session: false,
    },
    Command {
        name: "summary",
        aliases: &[],
        arg: Arg::None,
        about: "the record and the analysis",
        home: false,
        session: true,
    },
    Command {
        name: "transcript",
        aliases: &[],
        arg: Arg::None,
        about: "every round and turn",
        home: false,
        session: true,
    },
    Command {
        name: "export",
        aliases: &[],
        arg: Arg::None,
        about: "the record and document as Markdown",
        home: false,
        session: true,
    },
    Command {
        name: "stop",
        aliases: &[],
        arg: Arg::None,
        about: "stop the council that is sitting",
        home: false,
        session: true,
    },
    Command {
        name: "reconvene",
        aliases: &[],
        arg: Arg::None,
        about: "run this topic again on its record, a new paid run",
        home: false,
        session: true,
    },
    Command {
        name: "home",
        aliases: &[],
        arg: Arg::None,
        about: "back to Home",
        home: false,
        session: true,
    },
    Command {
        name: "settings",
        aliases: &[],
        arg: Arg::None,
        about: "keys, seats and policies",
        home: true,
        session: true,
    },
    Command {
        name: "help",
        aliases: &[],
        arg: Arg::None,
        about: "every command and key",
        home: true,
        session: true,
    },
    Command {
        name: "quit",
        aliases: &["exit"],
        arg: Arg::None,
        about: "leave Socratic Council",
        home: true,
        session: true,
    },
];

/// One row of the list above the input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    /// What Tab puts in the input.
    pub fill: String,
    /// The left column: the usage, or the full command once an argument is in.
    pub label: String,
    pub about: String,
    /// A close match (a typo, or letters in order) rather than a prefix.
    pub close: bool,
    /// Enter runs it. A command still missing its argument only fills.
    pub runs: bool,
}

/// How far apart two words are, counting a swap of neighbours as one edit
/// (so `/quti` is one step from `/quit`).
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// Every letter of `needle` appears in `hay`, in order.
fn in_order(needle: &str, hay: &str) -> bool {
    let mut rest = hay.chars();
    needle.chars().all(|c| rest.any(|h| h == c))
}

/// How close `typed` is to `word`, when it is close at all: a typo of the
/// word or of its start, or its letters in order. Lower is closer. A short
/// fragment is one letter from half the list, so two letters only count
/// when they appear as they are, and a typo needs three.
fn closeness(typed: &str, word: &str) -> Option<usize> {
    let n = typed.chars().count();
    if n < 2 {
        return None;
    }
    let tolerance = match n {
        2 => 0,
        3 | 4 => 1,
        _ => 2,
    };
    let head: String = word.chars().take(n).collect();
    let d = distance(typed, word).min(distance(typed, &head));
    if d <= tolerance {
        Some(d)
    } else if word.contains(typed) || (n >= 3 && in_order(typed, word)) {
        Some(tolerance + 1)
    } else {
        None
    }
}

/// The command a word names exactly, by name or alias.
fn named(word: &str) -> Option<&'static Command> {
    COMMANDS
        .iter()
        .find(|c| c.name == word || c.aliases.contains(&word))
}

/// Split `/word rest` into the lowercased word and, once a space is typed,
/// the rest.
fn split(input: &str) -> Option<(String, Option<&str>)> {
    let body = input.strip_prefix('/')?;
    match body.find(char::is_whitespace) {
        Some(i) => Some((body[..i].to_lowercase(), Some(body[i..].trim_start()))),
        None => Some((body.to_lowercase(), None)),
    }
}

/// The list to show above the input for `input`. `titles` are the saved
/// sessions, newest first, for `/open`.
/// Whether the command being typed takes a saved session, so the caller knows
/// to have the sessions list loaded before the suggestions are asked for.
pub fn takes_a_session(input: Option<(&str, Place)>) -> bool {
    let Some((input, place)) = input else {
        return false;
    };
    let Some((word, _)) = split(input) else {
        return false;
    };
    named(&word).is_some_and(|c| c.available(place) && c.arg == Arg::Session)
}

pub fn suggest(input: &str, place: Place, titles: &[&str]) -> Vec<Suggestion> {
    let Some((word, rest)) = split(input) else {
        return Vec::new();
    };
    if let (Some(rest), Some(cmd)) = (rest, named(&word)) {
        if cmd.available(place) {
            return suggest_arg(cmd, rest, titles);
        }
    }
    let mut matches = Vec::new();
    let mut close: Vec<(usize, usize, &Command)> = Vec::new();
    for (i, c) in COMMANDS.iter().enumerate() {
        if !c.available(place) {
            continue;
        }
        let words = std::iter::once(c.name).chain(c.aliases.iter().copied());
        if words.clone().any(|w| w.starts_with(&word)) {
            matches.push(c);
        } else if let Some(d) = words.filter_map(|w| closeness(&word, w)).min() {
            close.push((d, i, c));
        }
    }
    close.sort_by_key(|(d, i, _)| (*d, *i));
    let row = |c: &Command, close: bool| Suggestion {
        fill: match c.arg {
            Arg::None => format!("/{}", c.name),
            _ => format!("/{} ", c.name),
        },
        label: c.usage(),
        about: c.about.to_string(),
        close,
        runs: c.arg == Arg::None,
    };
    matches
        .into_iter()
        .map(|c| row(c, false))
        .chain(close.into_iter().map(|(_, _, c)| row(c, true)))
        .collect()
}

/// The choices for a command's argument, the ones starting with (or, for a
/// title, containing) what was typed first, then the close ones.
fn suggest_arg(cmd: &Command, typed: &str, titles: &[&str]) -> Vec<Suggestion> {
    const MAX_TITLES: usize = 8;
    let typed = typed.trim().to_lowercase();
    let row = |choice: &str, about: &str, close: bool| Suggestion {
        fill: format!("/{} {choice}", cmd.name),
        label: format!("/{} {choice}", cmd.name),
        about: about.to_string(),
        close,
        runs: true,
    };
    match cmd.arg {
        Arg::None => vec![Suggestion {
            fill: format!("/{}", cmd.name),
            label: cmd.usage(),
            about: cmd.about.to_string(),
            close: false,
            runs: true,
        }],
        Arg::Choice(words) => {
            let mut matches: Vec<Suggestion> = words
                .iter()
                .filter(|w| w.starts_with(&typed))
                .map(|w| row(w, cmd.about, false))
                .collect();
            let mut close: Vec<(usize, &str)> = words
                .iter()
                .filter(|w| !w.starts_with(&typed))
                .filter_map(|w| closeness(&typed, w).map(|d| (d, *w)))
                .collect();
            close.sort_by_key(|(d, _)| *d);
            matches.extend(close.into_iter().map(|(_, w)| row(w, cmd.about, true)));
            matches
        }
        Arg::Session => {
            let mut matches: Vec<Suggestion> = titles
                .iter()
                .filter(|t| t.to_lowercase().contains(&typed))
                .take(MAX_TITLES)
                .map(|t| row(t, "saved session", false))
                .collect();
            if matches.len() < MAX_TITLES {
                let room = MAX_TITLES - matches.len();
                matches.extend(
                    titles
                        .iter()
                        .filter(|t| !t.to_lowercase().contains(&typed))
                        .filter(|t| {
                            let t = t.to_lowercase();
                            t.split_whitespace().any(|w| closeness(&typed, w).is_some())
                                || (typed.chars().count() >= 3 && in_order(&typed, &t))
                        })
                        .take(room)
                        .map(|t| row(t, "saved session", true)),
                );
            }
            matches
        }
    }
}

/// What an input asks for when Enter is pressed on it.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    /// Run `name` with `arg`: a canonical choice, a session title as typed,
    /// or empty.
    Run { name: &'static str, arg: String },
    /// A command that needs its argument first.
    NeedsArg { name: &'static str },
    /// A choice the command does not take.
    BadArg { name: &'static str, arg: String },
    /// A command that exists, but not on this screen.
    NotHere { name: &'static str },
    /// No such command, with the closest one if any is close.
    Unknown {
        word: String,
        near: Option<&'static str>,
    },
}

pub fn resolve(input: &str, place: Place) -> Resolved {
    let Some((word, rest)) = split(input) else {
        return Resolved::Unknown {
            word: input.to_string(),
            near: None,
        };
    };
    let Some(cmd) = named(&word) else {
        let near = COMMANDS
            .iter()
            .filter(|c| c.available(place))
            .filter_map(|c| closeness(&word, c.name).map(|d| (d, c.name)))
            .min_by_key(|(d, _)| *d)
            .map(|(_, n)| n);
        return Resolved::Unknown { word, near };
    };
    if !cmd.available(place) {
        return Resolved::NotHere { name: cmd.name };
    }
    let arg = rest.unwrap_or("").trim();
    match cmd.arg {
        Arg::None => Resolved::Run {
            name: cmd.name,
            arg: String::new(),
        },
        _ if arg.is_empty() => Resolved::NeedsArg { name: cmd.name },
        Arg::Session => Resolved::Run {
            name: cmd.name,
            arg: arg.to_string(),
        },
        Arg::Choice(words) => {
            let lower = arg.to_lowercase();
            let starting: Vec<&str> = words
                .iter()
                .copied()
                .filter(|w| w.starts_with(&lower))
                .collect();
            let exact = words.iter().copied().find(|w| *w == lower);
            let only = match starting.as_slice() {
                [w] => Some(*w),
                _ => None,
            };
            match exact.or(only) {
                Some(w) => Resolved::Run {
                    name: cmd.name,
                    arg: w.to_string(),
                },
                _ => Resolved::BadArg {
                    name: cmd.name,
                    arg: arg.to_string(),
                },
            }
        }
    }
}

/// The usage line of a command, for the messages that name its choices.
pub fn usage(name: &str) -> String {
    named(name).map(Command::usage).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(s: &[Suggestion]) -> Vec<(&str, bool)> {
        s.iter().map(|s| (s.label.as_str(), s.close)).collect()
    }

    #[test]
    fn a_bare_slash_lists_every_command_for_the_screen() {
        let home = suggest("/", Place::Home, &[]);
        assert_eq!(
            home.iter().map(|s| s.fill.as_str()).collect::<Vec<_>>(),
            [
                "/council ",
                "/deliverable ",
                "/review ",
                "/open ",
                "/sessions",
                "/settings",
                "/help",
                "/quit"
            ]
        );
        assert!(home.iter().all(|s| !s.close));
        let session = suggest("/", Place::Session, &[]);
        assert!(session.iter().any(|s| s.fill == "/export"));
        assert!(!session.iter().any(|s| s.fill == "/council "));
    }

    #[test]
    fn prefixes_come_first_then_close_matches() {
        let s = suggest("/se", Place::Home, &[]);
        assert_eq!(
            labels(&s),
            [("/sessions", false), ("/settings", false)],
            "both start with se"
        );
        // A typo finds its command as a close match.
        let s = suggest("/setings", Place::Home, &[]);
        assert_eq!(labels(&s), [("/settings", true)]);
        let s = suggest("/quti", Place::Session, &[]);
        assert_eq!(labels(&s), [("/quit", true)]);
        // An alias counts as the command's name.
        let s = suggest("/ex", Place::Home, &[]);
        assert_eq!(labels(&s), [("/quit", false)]);
        // Nothing near: nothing listed.
        assert!(suggest("/zzzz", Place::Home, &[]).is_empty());
    }

    #[test]
    fn after_the_name_the_list_is_its_choices() {
        let s = suggest("/council ", Place::Home, &[]);
        assert_eq!(
            labels(&s),
            [
                ("/council quick", false),
                ("/council standard", false),
                ("/council full", false)
            ]
        );
        assert!(s.iter().all(|s| s.runs));
        let s = suggest("/council ful", Place::Home, &[]);
        assert_eq!(labels(&s), [("/council full", false)]);
        let s = suggest("/deliverable decison", Place::Home, &[]);
        assert_eq!(labels(&s), [("/deliverable decision", true)]);
    }

    #[test]
    fn open_lists_saved_sessions_by_title() {
        let titles = [
            "Should we colonize Mars?",
            "Pricing for the Pro plan",
            "Mars base staffing",
        ];
        let s = suggest("/open mars", Place::Home, &titles);
        assert_eq!(
            labels(&s),
            [
                ("/open Should we colonize Mars?", false),
                ("/open Mars base staffing", false)
            ]
        );
        let s = suggest("/open pricng", Place::Home, &titles);
        assert_eq!(labels(&s), [("/open Pricing for the Pro plan", true)]);
    }

    #[test]
    fn a_command_needing_an_argument_only_fills_until_it_has_one() {
        let s = suggest("/cou", Place::Home, &[]);
        assert_eq!(s[0].fill, "/council ");
        assert!(!s[0].runs);
        let s = suggest("/hel", Place::Home, &[]);
        assert!(s[0].runs);
    }

    #[test]
    fn resolve_runs_names_choices_and_aliases() {
        assert_eq!(
            resolve("/quit", Place::Home),
            Resolved::Run {
                name: "quit",
                arg: String::new()
            }
        );
        assert_eq!(
            resolve("/EXIT", Place::Session),
            Resolved::Run {
                name: "quit",
                arg: String::new()
            }
        );
        assert_eq!(
            resolve("/council Full", Place::Home),
            Resolved::Run {
                name: "council",
                arg: "full".into()
            }
        );
        // A unique start of a choice is enough.
        assert_eq!(
            resolve("/review of", Place::Home),
            Resolved::Run {
                name: "review",
                arg: "off".into()
            }
        );
        assert_eq!(
            resolve("/review o", Place::Home),
            Resolved::BadArg {
                name: "review",
                arg: "o".into()
            }
        );
        assert_eq!(
            resolve("/council", Place::Home),
            Resolved::NeedsArg { name: "council" }
        );
        assert_eq!(
            resolve("/open  Mars base ", Place::Home),
            Resolved::Run {
                name: "open",
                arg: "Mars base".into()
            }
        );
    }

    #[test]
    fn resolve_names_what_is_missing() {
        assert_eq!(
            resolve("/setings", Place::Home),
            Resolved::Unknown {
                word: "setings".into(),
                near: Some("settings")
            }
        );
        assert_eq!(
            resolve("/zzzz", Place::Home),
            Resolved::Unknown {
                word: "zzzz".into(),
                near: None
            }
        );
        assert_eq!(
            resolve("/export", Place::Home),
            Resolved::NotHere { name: "export" }
        );
        assert_eq!(
            resolve("/council full", Place::Session),
            Resolved::NotHere { name: "council" }
        );
    }

    #[test]
    fn distance_counts_a_swap_as_one() {
        assert_eq!(distance("quti", "quit"), 1);
        assert_eq!(distance("setings", "settings"), 1);
        assert_eq!(distance("abc", "abc"), 0);
        assert_eq!(distance("", "abc"), 3);
    }
}
