//! `socratic-council` CLI entry point.

use clap::{Parser, Subcommand};
use socratic_council::catalog::{catalog_models, model_row, DiscoveredModel, ModelSource};
use socratic_council::config::{parse_seats_flag, select_roster, Config, Preset};
use socratic_council::deliberation::{
    record, DebateEvent, Deliberation, Deliverable, EngineInput, Recommend,
};
use socratic_council::http_client;
use socratic_council::providers::scan::scan_models;
use socratic_council::store;
use socratic_council::text::sanitize_terminal as clean;
use socratic_council::tools::{Approval, ToolPolicy};
use socratic_council::tui::{self, AppContext};
use socratic_council::types::{Provider, ReasoningTier, Roster};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;

#[derive(Parser)]
#[command(
    name = "socratic-council",
    version,
    about = "A terminal council of AI models that deliberates a question in structured rounds and leaves a decision record."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Command {
    /// Convene the council on a topic (omit the topic to open the Home view).
    Run {
        /// The topic, question or task (omit to open the Home view, or to be prompted with --no-tui).
        topic: Vec<String>,
        /// Council preset: quick (3 seats) | standard (4) | full (8). Default standard.
        #[arg(long)]
        preset: Option<String>,
        /// Explicit seats, comma-separated `provider:model` (model = auto | auto-fast | an id),
        /// e.g. `openai:gpt-6-astra,anthropic:auto,openai:gpt-5.6-luna`. Overrides the preset.
        #[arg(long)]
        seats: Option<String>,
        /// Restrict to these providers (comma-separated slugs).
        #[arg(long)]
        providers: Option<String>,
        /// Force the deliverable: decision | analysis | document | review (default: the moderator decides).
        #[arg(long)]
        deliverable: Option<String>,
        /// Cross-examination rounds allowed (1..6; the moderator may use fewer).
        #[arg(long)]
        rounds: Option<u8>,
        /// Reasoning tier for every round: low | medium | high (default: per round).
        #[arg(long)]
        tier: Option<ReasoningTier>,
        /// Tools the seats may use: none | safe | all (all = safe + sandboxed shell).
        #[arg(long)]
        tools: Option<String>,
        /// Allow the sandboxed shell tool (same as --tools all).
        #[arg(long)]
        allow_shell: bool,
        /// Ask before every tool call (plain mode answers on stdin).
        #[arg(long)]
        ask_tools: bool,
        /// Force the moderator's clarifying question on for this run (else the Settings toggle decides; plain mode answers on stdin).
        #[arg(long)]
        interactive: bool,
        /// Attach a plain-text file (repeatable); seats can search and read it.
        #[arg(long = "file", value_name = "PATH")]
        files: Vec<std::path::PathBuf>,
        /// USD budget cap for this session (0 = unlimited).
        #[arg(long)]
        budget: Option<f64>,
        /// What happens at the budget cap: warn | stop.
        #[arg(long)]
        budget_action: Option<String>,
        /// Workspace directory for tool files and commands (default: per session under the config dir).
        #[arg(long)]
        workspace: Option<std::path::PathBuf>,
        /// Proxy URL for this run (http://, https://, socks5://…).
        #[arg(long)]
        proxy: Option<String>,
        /// Plain streaming output instead of the TUI.
        #[arg(long)]
        no_tui: bool,
        /// Emit every engine event as one JSON line (implies --no-tui).
        #[arg(long)]
        json: bool,
        /// Scan each provider's live models before starting.
        #[arg(long)]
        scan: bool,
        /// Reconvene on a stored session: its record becomes the planner's notes
        /// and a new session is written.
        #[arg(long, value_name = "SESSION_ID")]
        resume: Option<String>,
    },
    /// List stored sessions — shared with the desktop app when it is installed.
    Sessions,
    /// List catalog models, or scan a provider's live models.
    Models {
        /// Limit to one provider slug.
        #[arg(long)]
        provider: Option<String>,
        /// Query the provider's live /models endpoint.
        #[arg(long)]
        scan: bool,
    },
    /// Show which providers have an API key configured.
    Providers,
    /// Send one tiny request to every configured provider (or --provider) and
    /// report model, latency, content, thinking size and usage — a live check
    /// that keys, endpoints and each model's thinking/output contract work.
    Probe {
        /// Limit to one provider slug.
        #[arg(long)]
        provider: Option<String>,
        /// Reasoning tier to probe with (default: the council tier).
        #[arg(long)]
        tier: Option<ReasoningTier>,
        /// Scan the live /models endpoint first.
        #[arg(long)]
        scan: bool,
        /// Also make one native tool-calling request per provider.
        #[arg(long)]
        tools: bool,
    },
    /// Show or change configuration.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print the config file path.
    Path,
    /// Store an API key (prompted; never echoed).
    SetKey {
        /// Provider slug: openai | anthropic | google | deepseek | kimi | qwen | minimax | zhipu.
        provider: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        None => cmd_run(RunArgs::default()).await,
        Some(Command::Run {
            topic,
            preset,
            seats,
            providers,
            deliverable,
            rounds,
            tier,
            tools,
            allow_shell,
            ask_tools,
            interactive,
            files,
            budget,
            budget_action,
            workspace,
            proxy,
            no_tui,
            json,
            scan,
            resume,
        }) => {
            cmd_run(RunArgs {
                topic: topic.join(" "),
                preset,
                seats,
                providers,
                deliverable,
                rounds,
                tier,
                tools,
                allow_shell,
                ask_tools,
                interactive,
                files,
                budget,
                budget_action,
                workspace,
                proxy,
                no_tui: no_tui || json,
                json,
                scan,
                resume,
            })
            .await
        }
        Some(Command::Sessions) => cmd_sessions(),
        Some(Command::Models { provider, scan }) => cmd_models(provider, scan).await,
        Some(Command::Providers) => cmd_providers(),
        Some(Command::Probe {
            provider,
            tier,
            scan,
            tools,
        }) => cmd_probe(provider, tier, scan, tools).await,
        Some(Command::Config { action }) => cmd_config(action),
    };
    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

#[derive(Default)]
struct RunArgs {
    topic: String,
    preset: Option<String>,
    seats: Option<String>,
    providers: Option<String>,
    deliverable: Option<String>,
    rounds: Option<u8>,
    tier: Option<ReasoningTier>,
    tools: Option<String>,
    allow_shell: bool,
    ask_tools: bool,
    interactive: bool,
    files: Vec<std::path::PathBuf>,
    budget: Option<f64>,
    budget_action: Option<String>,
    workspace: Option<std::path::PathBuf>,
    proxy: Option<String>,
    no_tui: bool,
    json: bool,
    scan: bool,
    resume: Option<String>,
}

fn cmd_sessions() -> anyhow::Result<()> {
    let config = Config::load()?;
    let Some(store) = socratic_council::bridge::open_store(config.bridge()) else {
        anyhow::bail!("no session store available (no writable config dir)");
    };
    let rows = store.list();
    println!(
        "{} session(s) in {} ({})",
        rows.len(),
        store.dir().display(),
        match store.location {
            store::StoreLocation::SharedWithApp => "shared with the desktop app",
            store::StoreLocation::CliOwn => "CLI-only; the desktop app is not installed here",
        }
    );
    for r in rows {
        println!(
            "  {:<32} {:<9} {:>3} turns  {:<3}  {}",
            r.id,
            r.status,
            r.current_turn,
            r.origin,
            clean(&r.title)
        );
    }
    Ok(())
}

fn parse_provider_filter(spec: &Option<String>) -> Option<Vec<Provider>> {
    spec.as_ref().map(|s| {
        s.split(',')
            .filter_map(|slug| Provider::from_slug(slug.trim()))
            .collect::<Vec<_>>()
    })
}

fn parse_preset(name: Option<&str>) -> anyhow::Result<Preset> {
    match name {
        None => Ok(Preset::Standard),
        Some(n) => Preset::parse(n)
            .ok_or_else(|| anyhow::anyhow!("unknown preset {n}: use quick, standard or full")),
    }
}

/// Apply the run flags to the loaded config.
fn apply_run_flags(config: &mut Config, args: &RunArgs) -> anyhow::Result<()> {
    if let Some(tier) = args.tier {
        config.council_tier = tier;
        let t = &mut config.protocol.tiers;
        t.positions = tier;
        t.cross = tier;
        t.revision = tier;
        t.record = tier;
    }
    if let Some(rounds) = args.rounds {
        anyhow::ensure!((1..=6).contains(&rounds), "--rounds must be 1..6");
        config.protocol.max_rounds = rounds;
    }
    if let Some(level) = &args.tools {
        config.tools = ToolPolicy::from_flag(level)
            .ok_or_else(|| anyhow::anyhow!("--tools must be none, safe or all"))?;
    }
    if args.allow_shell {
        config.tools.shell.enabled = true;
    }
    if args.ask_tools {
        config.tools.approval = Approval::Ask;
    }
    // The Settings toggle decides; the flag forces the question on for this run.
    if args.interactive {
        config.protocol.interactive = true;
    }
    if let Some(budget) = args.budget {
        anyhow::ensure!(budget.is_finite() && budget >= 0.0, "--budget must be ≥ 0");
        config.budget_per_session_usd = budget;
    }
    if let Some(action) = &args.budget_action {
        anyhow::ensure!(
            matches!(action.to_ascii_lowercase().as_str(), "warn" | "stop"),
            "--budget-action must be warn or stop"
        );
        config.budget_action = action.to_ascii_lowercase();
    }
    if let Some(proxy) = &args.proxy {
        config.proxy = Some(proxy.clone());
    }
    if let Some(ws) = &args.workspace {
        config.workspace = Some(ws.clone());
    }
    Ok(())
}

async fn cmd_run(args: RunArgs) -> anyhow::Result<()> {
    let mut config = Config::load()?;
    apply_run_flags(&mut config, &args)?;
    let forced = match &args.deliverable {
        Some(d) => Some(Deliverable::parse(d).ok_or_else(|| {
            anyhow::anyhow!("--deliverable must be decision, analysis, document or review")
        })?),
        None => None,
    };

    // Attachments (plain text only; seats search and read them with tools).
    let attachments =
        socratic_council::attach::load_attachments(&args.files).map_err(anyhow::Error::msg)?;

    // `--resume <id>`: the stored session's record (or transcript tail)
    // becomes the planner's notes for a fresh run on the same topic.
    let resume = match &args.resume {
        Some(id) => {
            let store = socratic_council::bridge::open_store(config.bridge())
                .ok_or_else(|| anyhow::anyhow!("no session store available"))?;
            let json = store.load(id).ok_or_else(|| {
                anyhow::anyhow!("session {id} not found in {}", store.dir().display())
            })?;
            Some(json)
        }
        None => None,
    };

    // The *allowed* set: the `--providers` filter, or all eight. We deliberately
    // do NOT pre-filter by which keys are configured — a terminal-only user
    // opens the TUI with zero keys and adds one in Settings, and it must become
    // usable immediately. Actual key-gating happens at launch time.
    let filter = parse_provider_filter(&args.providers);
    let allowed: Vec<Provider> = Provider::ALL
        .into_iter()
        .filter(|p| filter.as_ref().map(|f| f.contains(p)).unwrap_or(true))
        .collect();
    if allowed.is_empty() {
        anyhow::bail!(
            "no valid providers in --providers (known slugs: {})",
            Provider::ALL
                .iter()
                .map(|p| p.slug())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // Explicit seats (`--seats`) override the preset; either way only
    // allowed providers count, and key gating happens at launch.
    let preset = parse_preset(args.preset.as_deref())?;
    let roster_override = match &args.seats {
        Some(spec) => {
            let seats = parse_seats_flag(spec)?;
            let roster = Roster { seats }.with_keys(|p| allowed.contains(&p));
            if roster.seats.is_empty() {
                anyhow::bail!("no seats left after --providers / --seats filtering");
            }
            Some(roster)
        }
        None => None,
    };

    let http = http_client(config.proxy.as_deref());

    // The available-models map for every allowed provider. Catalog is offline
    // and free; only `--scan` the providers that have a key, keeping each
    // resolved key so the run reuses it.
    let mut available: HashMap<Provider, Vec<DiscoveredModel>> = HashMap::new();
    let mut prefetched_keys: HashMap<Provider, String> = HashMap::new();
    for provider in &allowed {
        let models = if args.scan && config.is_configured(*provider) {
            let key = config.resolve_api_key(*provider).unwrap_or_default();
            if !key.is_empty() {
                prefetched_keys.insert(*provider, key.clone());
            }
            match scan_models(&http, *provider, &config.base_url(*provider), &key).await {
                Ok(m) => m,
                Err(_) => catalog_models(*provider),
            }
        } else {
            catalog_models(*provider)
        };
        available.insert(*provider, models);
    }

    if args.no_tui {
        let configured: Vec<Provider> = allowed
            .iter()
            .copied()
            .filter(|p| config.is_configured(*p))
            .collect();
        if configured.is_empty() {
            anyhow::bail!(
                "no API keys configured for the selected providers. Add one with \
                 `socratic-council config set-key <provider>` or a <PROVIDER>_API_KEY env \
                 var — or drop --no-tui and add a key in Settings (press ^P)."
            );
        }
        let roster = select_roster(&config, &allowed, roster_override.as_ref(), preset);
        if roster.seats.is_empty() {
            anyhow::bail!("no keyed seat among the selected providers");
        }
        return run_plain(
            config,
            http,
            available,
            prefetched_keys,
            attachments,
            &args,
            roster,
            forced,
            resume,
        )
        .await;
    }

    let initial_topic = if args.topic.trim().is_empty() {
        None
    } else {
        Some(args.topic.clone())
    };
    let ctx = AppContext {
        http,
        config,
        available,
        providers: allowed,
        prefetched_keys,
        attachments,
        roster_override,
        preset,
        forced,
        resume: args.resume.clone(),
    };
    tui::run(ctx, initial_topic).await
}

/// Plain (non-TUI) run for piping and scripting: phases, seat contributions,
/// tool calls, the board and the record as Markdown; or JSON lines.
#[allow(clippy::too_many_arguments)]
async fn run_plain(
    config: Config,
    http: reqwest::Client,
    available: HashMap<Provider, Vec<DiscoveredModel>>,
    mut keys: HashMap<Provider, String>,
    attachments: Vec<socratic_council::attach::Attachment>,
    args: &RunArgs,
    roster: Roster,
    forced: Option<Deliverable>,
    resume: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    use tokio::sync::mpsc::unbounded_channel;

    let mut topic = args.topic.clone();
    if let Some(json) = &resume {
        if topic.trim().is_empty() {
            topic = json["topic"].as_str().unwrap_or("").to_string();
        }
    }
    if topic.trim().is_empty() {
        print!("Topic> ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        topic = line.trim().to_string();
    }
    if topic.is_empty() {
        anyhow::bail!("no topic given");
    }

    for seat in &roster.seats {
        if keys.contains_key(&seat.provider) {
            continue;
        }
        if let Some(key) = config.resolve_api_key(seat.provider) {
            keys.insert(seat.provider, key);
        }
    }
    // The moderator may live on a provider with no seat.
    for provider in Provider::ALL {
        if let std::collections::hash_map::Entry::Vacant(slot) = keys.entry(provider) {
            if let Some(key) = config.resolve_api_key(provider) {
                slot.insert(key);
            }
        }
    }
    let roster = roster.with_keys(|p| keys.contains_key(&p));
    if roster.seats.is_empty() {
        anyhow::bail!("could not read an API key for any selected seat");
    }

    let prior_notes = resume.as_ref().and_then(|json| {
        json["record"]
            .as_object()
            .and_then(|_| {
                serde_json::from_value::<record::DecisionRecord>(json["record"].clone()).ok()
            })
            .map(|r| record::to_markdown(&r, &BTreeMap::new(), None))
            .or_else(|| {
                let msgs = store::messages_from_json(json);
                let tail: Vec<String> = msgs
                    .iter()
                    .rev()
                    .take(6)
                    .map(|m| format!("{}: {}", m.display_name, m.content))
                    .collect();
                (!tail.is_empty()).then(|| tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
            })
    });

    let session_id = store::new_session_id();
    let store = socratic_council::bridge::open_store(config.bridge());
    let engine_config = config.engine_config(&session_id);
    let names: BTreeMap<String, String> = roster
        .seats
        .iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();
    let engine = Deliberation::new(http, engine_config, topic.clone(), roster, keys, available)
        .with_attachments(attachments)
        .with_forced_deliverable(forced)
        .with_store(store)
        .with_prior_notes(prior_notes);

    let (tx, mut rx) = unbounded_channel();
    let (itx, irx) = unbounded_channel::<EngineInput>();
    let handle = tokio::spawn(async move { engine.run(tx, irx).await });
    let json_mode = args.json;
    let stdin_is_tty = std::io::IsTerminal::is_terminal(&std::io::stdin());
    let ask = |prompt: &str| -> Option<String> {
        if !stdin_is_tty {
            return None;
        }
        print!("{prompt}");
        std::io::stdout().flush().ok()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        Some(line.trim().to_string())
    };

    if !json_mode {
        println!("Session {session_id}");
        println!("Topic: {}", clean(&topic));
    }
    while let Some(ev) = rx.recv().await {
        if json_mode {
            if let Ok(line) = serde_json::to_string(&ev) {
                println!("{line}");
            }
        }
        match ev {
            DebateEvent::UserQuestion { id, question } => {
                let answer = ask(&format!(
                    "\nThe moderator asks: {}\nYour answer> ",
                    clean(&question)
                ));
                match answer {
                    Some(text) if !text.is_empty() => {
                        let _ = itx.send(EngineInput::UserAnswer { id, text });
                    }
                    _ => {
                        if !json_mode {
                            println!("(no answer given; planning without it)");
                        }
                        let _ = itx.send(EngineInput::UserAnswer {
                            id,
                            text: String::new(),
                        });
                    }
                }
            }
            DebateEvent::ToolApproval { id, seat_id, call } => {
                let name = names.get(&seat_id).cloned().unwrap_or(seat_id);
                let args_text = clean(&call.arguments.to_string());
                let allow = matches!(
                    ask(&format!(
                        "\n{name} wants to run {}({args_text}). Allow? [y/N] ",
                        call.name
                    ))
                    .as_deref(),
                    Some("y") | Some("Y") | Some("yes")
                );
                if !json_mode && !allow {
                    println!("(declined)");
                }
                let _ = itx.send(EngineInput::ToolDecision { id, allow });
            }
            ev if json_mode => {
                if matches!(ev, DebateEvent::Done { .. }) {
                    break;
                }
            }
            DebateEvent::Phase { name } => println!("\n── {} ──", clean(&name)),
            DebateEvent::Plan { plan, corrections } => {
                if !corrections.is_empty() {
                    println!("[plan adjusted] {}", clean(&corrections.join("; ")));
                }
                let _ = plan;
            }
            DebateEvent::Estimate { estimate } => {
                let unpriced = if estimate.unpriced_seats.is_empty() {
                    String::new()
                } else {
                    format!(" (unpriced: {})", estimate.unpriced_seats.join(", "))
                };
                println!(
                    "Estimate: ≈ ${:.2}–${:.2} over {} calls{unpriced}",
                    estimate.usd_low, estimate.usd_high, estimate.calls
                );
            }
            DebateEvent::SeatStarted {
                name, model, round, ..
            } => {
                println!(
                    "… {} ({}) is working on {}",
                    clean(&name),
                    clean(&model),
                    round.label().to_lowercase()
                );
            }
            DebateEvent::Token { .. } | DebateEvent::Thinking { .. } => {}
            DebateEvent::ToolCall {
                seat_id,
                call,
                output,
                error,
            } => {
                let name = names.get(&seat_id).cloned().unwrap_or(seat_id);
                let shown: String = clean(&output).chars().take(200).collect();
                match error {
                    Some(e) => println!(
                        "  ⚙ {name} {}({}) → ERROR {}",
                        call.name,
                        clean(&call.arguments.to_string()),
                        clean(&e)
                    ),
                    None => println!(
                        "  ⚙ {name} {}({}) → {shown}",
                        call.name,
                        clean(&call.arguments.to_string())
                    ),
                }
            }
            DebateEvent::SeatFinished {
                name,
                round,
                usage,
                content,
                ..
            } => {
                println!(
                    "\n[{}] {} ({} in / {} out / {} reasoning)",
                    round.label(),
                    clean(&name),
                    usage.input,
                    usage.output,
                    usage.reasoning
                );
                println!("{}", clean(&content));
            }
            DebateEvent::Board { board } => {
                println!("\n{}", clean(&board.to_prompt_text(&names)));
            }
            DebateEvent::Convergence { convergence } => {
                println!(
                    "\nConvergence: {} ({} open; moved: {}) — {}",
                    match convergence.recommend {
                        Recommend::Close => "close",
                        Recommend::AnotherRound => "another round",
                        Recommend::Revise => "revise",
                    },
                    convergence.open_disagreements,
                    if convergence.moved.is_empty() {
                        "nobody".to_string()
                    } else {
                        convergence.moved.join(", ")
                    },
                    clean(&convergence.why)
                );
            }
            DebateEvent::Moderator { text } => println!("\n[Moderator] {}", clean(&text)),
            DebateEvent::Record { record: r } => {
                println!("\n{}", clean(&record::to_markdown(&r, &names, None)));
            }
            DebateEvent::Document { markdown } => {
                println!("\n── Document ──\n{}", clean(&markdown));
            }
            DebateEvent::Cost { snapshot } => {
                if let Some(note) = &snapshot.note {
                    println!("[budget] {}", clean(note));
                }
            }
            DebateEvent::Error { message } => eprintln!("[error] {}", clean(&message)),
            DebateEvent::Done { session_id } => {
                println!("\nSaved as session {session_id}");
                break;
            }
        }
    }
    let doc = handle.await?;
    if let Some(snap) = doc["costs"].as_object() {
        if !json_mode {
            let total = snap
                .get("total_usd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let priced = snap
                .get("all_priced")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            println!("Cost: {}${total:.4}", if priced { "" } else { "≥ " });
        }
    }
    Ok(())
}

async fn cmd_models(provider: Option<String>, scan: bool) -> anyhow::Result<()> {
    let config = Config::load()?;
    let http = http_client(config.proxy.as_deref());
    let providers: Vec<Provider> = match provider {
        Some(slug) => vec![Provider::from_slug(&slug)
            .ok_or_else(|| anyhow::anyhow!("unknown provider: {slug}"))?],
        None => Provider::ALL.to_vec(),
    };

    for provider in providers {
        println!("\n{} ({})", provider.display_name(), provider.slug());
        let models = if scan {
            match config.resolve_api_key(provider) {
                Some(key) => {
                    match scan_models(&http, provider, &config.base_url(provider), &key).await {
                        Ok(m) => m,
                        Err(e) => {
                            println!("  scan failed ({e}); showing catalog");
                            catalog_models(provider)
                        }
                    }
                }
                None => {
                    println!("  no API key; showing catalog");
                    catalog_models(provider)
                }
            }
        } else {
            catalog_models(provider)
        };
        for m in models {
            let tag = if m.source == ModelSource::Scanned {
                "live"
            } else {
                "cat"
            };
            println!("  [{tag}] {}", m.id);
        }
    }
    Ok(())
}

fn cmd_providers() -> anyhow::Result<()> {
    let config = Config::load()?;
    println!("Providers:");
    for provider in Provider::ALL {
        let configured = config.is_configured(provider);
        let mark = if configured { "✓" } else { " " };
        println!(
            "  [{mark}] {:<10} {}",
            provider.slug(),
            if configured { "configured" } else { "no key" }
        );
    }
    Ok(())
}

/// `socratic-council probe`: one minimal completion per provider, printed as a
/// table. Content and thinking are reported separately so a model whose
/// reasoning leaks into the answer (or whose answer is empty) is visible.
async fn cmd_probe(
    provider: Option<String>,
    tier: Option<ReasoningTier>,
    scan: bool,
    tools: bool,
) -> anyhow::Result<()> {
    use socratic_council::catalog::resolve_model;
    use socratic_council::providers::stream_completion;
    use socratic_council::types::{ChatMessage, CompletionChunk, CompletionRequest, StopReason};

    let config = Config::load()?;
    let http = http_client(config.proxy.as_deref());
    let tier = tier.unwrap_or(config.council_tier);
    let providers: Vec<Provider> = match provider {
        Some(slug) => vec![Provider::from_slug(&slug)
            .ok_or_else(|| anyhow::anyhow!("unknown provider: {slug}"))?],
        None => Provider::ALL.to_vec(),
    };

    println!("provider   model                        latency  content                   thinking  usage in/out/reason");
    let mut failures = 0usize;
    for provider in providers {
        let Some(key) = config.resolve_api_key(provider) else {
            println!("{:<10} {:<28} {:>7}  no API key", provider.slug(), "-", "-");
            continue;
        };
        let base = config.base_url(provider);
        let models = if scan {
            scan_models(&http, provider, &base, &key)
                .await
                .unwrap_or_else(|_| catalog_models(provider))
        } else {
            catalog_models(provider)
        };
        let selection = config.selection(provider, tier);
        let model = resolve_model(
            provider,
            tier,
            &models,
            selection.as_deref().or(Some("auto")),
        );

        let req = CompletionRequest {
            model: model.clone(),
            system: Some("You are a connectivity probe. Reply with exactly the word OK.".into()),
            // A tiny bit of work so adaptive-thinking models actually emit a
            // thinking block (a bare "say OK" is skipped by Claude/GPT).
            messages: vec![ChatMessage::user(
                "Is 91 a prime number? Work it out, then reply with exactly one word: OK.",
            )],
            // Roomy: adaptive-thinking models spend output budget on thinking first.
            max_tokens: 1024,
            temperature: 1.0,
            tier,
            ..Default::default()
        };
        let mut content = String::new();
        let mut thinking = 0usize;
        let started = std::time::Instant::now();
        let result = {
            let mut on_chunk = |c: &CompletionChunk| {
                content.push_str(&c.content);
                thinking += c.thinking.chars().count();
            };
            stream_completion(&http, provider, &base, &key, &req, &mut on_chunk)
                .await
                .map(|o| o.usage)
        };
        let secs = started.elapsed().as_secs_f32();
        match result {
            Ok(usage) => {
                let shown: String = clean(content.trim()).chars().take(22).collect();
                println!(
                    "{:<10} {:<28} {:>6.1}s  {:<24} {:>8}  {}/{}/{}",
                    provider.slug(),
                    model,
                    secs,
                    format!("{shown:?}"),
                    thinking,
                    usage.input,
                    usage.output,
                    usage.reasoning
                );
            }
            Err(e) => {
                failures += 1;
                let msg: String = clean(&e.to_string()).chars().take(160).collect();
                println!(
                    "{:<10} {:<28} {:>6.1}s  ERROR {}",
                    provider.slug(),
                    model,
                    secs,
                    msg
                );
            }
        }
    }
    if tools {
        println!(
            "\ntool calling: one request per provider offering read_file; expects a tool call back"
        );
        for provider in Provider::ALL {
            let Some(key) = config.resolve_api_key(provider) else {
                continue;
            };
            let base = config.base_url(provider);
            let models = catalog_models(provider);
            let model = resolve_model(
                provider,
                ReasoningTier::Low,
                &models,
                config
                    .selection(provider, ReasoningTier::Low)
                    .as_deref()
                    .or(Some("auto")),
            );
            if !model_row(provider, &model).contract.tools {
                println!(
                    "{:<10} {:<28} no tool support on this model",
                    provider.slug(),
                    model
                );
                continue;
            }
            let specs = socratic_council::tools::specs_for(&ToolPolicy::safe(), false);
            let req = CompletionRequest {
                model: model.clone(),
                system: Some("You are a connectivity probe for tool calling.".into()),
                messages: vec![ChatMessage::user(
                    "Call the read_file tool with path \"notes.txt\" now. Do not answer in prose.",
                )],
                max_tokens: 1024,
                temperature: 1.0,
                tier: ReasoningTier::Low,
                tools: specs,
                cache_key: None,
            };
            let started = std::time::Instant::now();
            let mut on_chunk = |_c: &CompletionChunk| {};
            match stream_completion(&http, provider, &base, &key, &req, &mut on_chunk).await {
                Ok(out) => {
                    let secs = started.elapsed().as_secs_f32();
                    match out.tool_calls.first() {
                        Some(call) if out.stop == StopReason::ToolUse => println!(
                            "{:<10} {:<28} {:>6.1}s  called {}({}) ✓",
                            provider.slug(),
                            model,
                            secs,
                            call.name,
                            clean(&call.arguments.to_string())
                        ),
                        Some(call) => println!(
                            "{:<10} {:<28} {:>6.1}s  call {} but stop={:?}",
                            provider.slug(),
                            model,
                            secs,
                            call.name,
                            out.stop
                        ),
                        None => {
                            failures += 1;
                            let shown: String = clean(out.text.trim()).chars().take(60).collect();
                            println!(
                                "{:<10} {:<28} {:>6.1}s  NO TOOL CALL: {shown:?}",
                                provider.slug(),
                                model,
                                secs
                            );
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    let msg: String = clean(&e.to_string()).chars().take(160).collect();
                    println!("{:<10} {:<28} ERROR {}", provider.slug(), model, msg);
                }
            }
        }
    }
    if failures > 0 {
        anyhow::bail!("{failures} provider probe(s) failed");
    }
    Ok(())
}

fn cmd_config(action: ConfigAction) -> anyhow::Result<()> {
    match action {
        ConfigAction::Path => {
            println!("{}", Config::config_path()?.display());
            Ok(())
        }
        ConfigAction::SetKey { provider } => {
            let provider = Provider::from_slug(&provider)
                .ok_or_else(|| anyhow::anyhow!("unknown provider: {provider}"))?;
            print!("Paste {} API key: ", provider.display_name());
            std::io::stdout().flush()?;
            let mut key = String::new();
            std::io::stdin().read_line(&mut key)?;
            let key = key.trim().to_string();
            if key.is_empty() {
                anyhow::bail!("no key entered");
            }
            let mut config = Config::load()?;
            config.set_key(provider, key);
            config.save_keys()?;
            config.save()?;
            println!("Saved {} key.", provider.display_name());
            Ok(())
        }
    }
}
