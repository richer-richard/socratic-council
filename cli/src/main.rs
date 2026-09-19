//! `socratic-council` CLI entry point.

use clap::{Parser, Subcommand};
use socratic_council::catalog::{catalog_models, DiscoveredModel, ModelSource};
use socratic_council::config::Config;
use socratic_council::engine::{default_agents, DebateEvent, Engine};
use socratic_council::http_client;
use socratic_council::providers::scan::scan_models;
use socratic_council::store::{self, SessionStore, StoredMessage};
use socratic_council::tui::{self, AppContext};
use socratic_council::types::{Agent, Provider, ReasoningTier, Reflection};
use std::collections::HashMap;
use std::io::Write;

#[derive(Parser)]
#[command(
    name = "socratic-council",
    version,
    about = "A terminal multi-agent debate workstation — eight AI agents argue any topic."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start a debate on a topic (default action).
    Run {
        /// The debate topic (omit to open the Home view, or to be prompted with --no-tui).
        topic: Vec<String>,
        /// Restrict to these providers (comma-separated slugs).
        #[arg(long)]
        providers: Option<String>,
        /// Reasoning tier: low | medium | high.
        #[arg(long)]
        tier: Option<ReasoningTier>,
        /// Turn cap (0 = until you quit).
        #[arg(long)]
        max_turns: Option<u32>,
        /// Draft→revise reflection per turn: off | light | deep.
        #[arg(long)]
        reflect: Option<Reflection>,
        /// Synthesize a deep-research report at the close (one extra pass).
        #[arg(long)]
        deep_research: bool,
        /// Skip the closing peer-evaluation scorecard (saves one call per agent).
        #[arg(long)]
        no_peer_eval: bool,
        /// Attach a plain-text file (repeatable) — searchable via oracle.file_search.
        #[arg(long = "file", value_name = "PATH")]
        files: Vec<std::path::PathBuf>,
        /// Disable the outer advisor circle (paired agents passing private notes).
        #[arg(long)]
        no_observers: bool,
        /// Advisors whisper every N turns (0 = off; default 2).
        #[arg(long)]
        observer_interval: Option<u32>,
        /// USD budget cap for this session (0 = unlimited).
        #[arg(long)]
        budget: Option<f64>,
        /// What happens at the budget cap: warn | stop.
        #[arg(long)]
        budget_action: Option<String>,
        /// Disable the oracle tools (web/file search, claim verification).
        #[arg(long)]
        no_search: bool,
        /// Proxy URL for this run (http://, https://, socks5://…).
        #[arg(long)]
        proxy: Option<String>,
        /// Plain streaming output instead of the TUI.
        #[arg(long)]
        no_tui: bool,
        /// Scan each provider's live models before starting.
        #[arg(long)]
        scan: bool,
        /// Continue a stored session (see `sessions`): its transcript becomes
        /// history and new turns append to the same session.
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
        /// Pick the model from the provider's live /models list instead of the catalog.
        #[arg(long)]
        scan: bool,
    },
    /// Manage configuration and keys.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print the config file path.
    Path,
    /// Store an API key for a provider (read from stdin).
    SetKey {
        /// Provider slug (openai, anthropic, …).
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
            providers,
            tier,
            max_turns,
            reflect,
            deep_research,
            no_peer_eval,
            files,
            no_observers,
            observer_interval,
            budget,
            budget_action,
            no_search,
            proxy,
            no_tui,
            scan,
            resume,
        }) => {
            cmd_run(RunArgs {
                topic: topic.join(" "),
                providers,
                tier,
                max_turns,
                reflect,
                deep_research,
                no_peer_eval,
                files,
                no_observers,
                observer_interval,
                budget,
                budget_action,
                no_search,
                proxy,
                no_tui,
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
        }) => cmd_probe(provider, tier, scan).await,
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
    providers: Option<String>,
    tier: Option<ReasoningTier>,
    max_turns: Option<u32>,
    reflect: Option<Reflection>,
    deep_research: bool,
    no_peer_eval: bool,
    files: Vec<std::path::PathBuf>,
    no_observers: bool,
    observer_interval: Option<u32>,
    budget: Option<f64>,
    budget_action: Option<String>,
    no_search: bool,
    proxy: Option<String>,
    no_tui: bool,
    scan: bool,
    resume: Option<String>,
}

fn cmd_sessions() -> anyhow::Result<()> {
    let config = Config::load()?;
    let Some(store) = SessionStore::open(config.bridge()) else {
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
            socratic_council::engine::sanitize_terminal(&r.title)
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

async fn cmd_run(args: RunArgs) -> anyhow::Result<()> {
    let mut config = Config::load()?;
    // CLI flags override the inherited / default config.
    if let Some(tier) = args.tier {
        config.council_tier = tier;
    }
    if let Some(n) = args.max_turns {
        config.max_turns = n;
    }
    if let Some(r) = args.reflect {
        config.reflection = r;
    }
    config.deep_research = args.deep_research;
    config.peer_eval = !args.no_peer_eval;
    config.search_enabled = !args.no_search;
    if args.no_observers {
        config.observers_enabled = false;
    }
    if let Some(interval) = args.observer_interval {
        config.observers_enabled = interval > 0;
        config.observer_interval = interval;
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

    // Attachments (plain text only; searched via oracle.file_search).
    let attachments =
        socratic_council::attach::load_attachments(&args.files).map_err(anyhow::Error::msg)?;

    // `--resume <id>`: the stored transcript becomes history (plain mode only —
    // the TUI resumes from its history sidebar with Enter).
    let resume = match &args.resume {
        Some(id) => {
            let store = SessionStore::open(config.bridge())
                .ok_or_else(|| anyhow::anyhow!("no session store available"))?;
            let json = store.load(id).ok_or_else(|| {
                anyhow::anyhow!("session {id} not found in {}", store.dir().display())
            })?;
            Some((id.clone(), json))
        }
        None => None,
    };

    // The *allowed* set: the `--providers` filter, or all eight. We deliberately
    // do NOT pre-filter by which keys are configured — a terminal-only/VPS user
    // opens the TUI with zero keys and adds one in Settings, and it must become
    // usable immediately. Actual key-gating happens at debate-launch time.
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

    let http = http_client(config.proxy.as_deref());

    // Build the available-models map for every allowed provider. Catalog is
    // offline + free, so we can populate even unconfigured providers (their
    // roster row + resolved model render before any key exists). Only `--scan`
    // the providers that actually have a key, capturing each resolved key so
    // launching a debate reuses it.
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
        // Plain mode has no interactive way to add a key, so it still requires
        // at least one configured provider up front.
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
        return run_plain_debate(
            config,
            http,
            available,
            prefetched_keys,
            attachments,
            &args,
            &configured,
            resume,
        )
        .await;
    }
    if resume.is_some() {
        anyhow::bail!("--resume is a plain-mode option (add --no-tui); in the TUI, press Tab, pick the session and press Enter");
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
    };
    tui::run(ctx, initial_topic).await
}

/// Plain (non-TUI) streaming debate for piping / scripting.
#[allow(clippy::too_many_arguments)]
async fn run_plain_debate(
    config: Config,
    http: reqwest::Client,
    available: HashMap<Provider, Vec<DiscoveredModel>>,
    mut keys: HashMap<Provider, String>,
    attachments: Vec<socratic_council::attach::Attachment>,
    args: &RunArgs,
    providers: &[Provider],
    resume: Option<(String, serde_json::Value)>,
) -> anyhow::Result<()> {
    let mut topic = args.topic.clone();
    if let Some((_, json)) = &resume {
        if topic.trim().is_empty() {
            topic = json["topic"].as_str().unwrap_or("").to_string();
        }
    }
    if topic.trim().is_empty() {
        print!("Debate topic> ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        topic = line.trim().to_string();
    }
    if topic.is_empty() {
        anyhow::bail!("no topic given");
    }

    let mut agents: Vec<Agent> = default_agents(config.council_tier)
        .into_iter()
        .filter(|a| providers.contains(&a.provider))
        .collect();
    agents.sort_by(|a, b| a.name.cmp(&b.name));

    // Resolve any key not already prefetched (from env / the CLI's encrypted
    // store / the app's vault), then drop agents whose key couldn't be resolved.
    for agent in &agents {
        if keys.contains_key(&agent.provider) {
            continue;
        }
        if let Some(key) = config.resolve_api_key(agent.provider) {
            keys.insert(agent.provider, key);
        }
    }
    agents.retain(|a| keys.contains_key(&a.provider));
    if agents.is_empty() {
        anyhow::bail!("could not read an API key for any selected provider");
    }

    let max_turns = match config.max_turns {
        0 => 1000,
        n => n,
    };
    let display_cap = if config.max_turns == 0 { 0 } else { max_turns };
    let store = SessionStore::open(config.bridge());
    let (session_id, created_at_ms, prior_msgs) = match &resume {
        Some((id, json)) => (
            id.clone(),
            json["createdAt"].as_u64().unwrap_or_else(store::now_ms),
            store::messages_from_json(json),
        ),
        None => (store::new_session_id(), store::now_ms(), Vec::new()),
    };
    let prior: Vec<socratic_council::engine::Turn> = prior_msgs
        .iter()
        .filter(|m| m.agent_id != "error")
        .map(|m| socratic_council::engine::Turn {
            agent_id: m.agent_id.clone(),
            name: m.display_name.clone(),
            content: m.content.clone(),
        })
        .collect();
    let engine = Engine::new(
        http,
        config,
        topic.clone(),
        agents,
        available,
        keys,
        max_turns,
    )
    .with_attachments(attachments)
    .with_prior_transcript(prior);
    // Turns already in the stored session keep counting up on resume.
    let prior_turns = prior_msgs
        .iter()
        .filter(|m| {
            socratic_council::tui::theme::AGENTS
                .iter()
                .any(|a| a.id == m.agent_id)
        })
        .count() as u32;
    let record = PlainRecord {
        store,
        session_id,
        created_at_ms,
        topic,
        messages: prior_msgs,
        prior_turns,
    };
    run_plain(engine, display_cap, record).await;
    Ok(())
}

/// What plain mode persists to the shared session store.
struct PlainRecord {
    store: Option<SessionStore>,
    session_id: String,
    created_at_ms: u64,
    topic: String,
    messages: Vec<StoredMessage>,
    prior_turns: u32,
}

impl PlainRecord {
    fn push(
        &mut self,
        agent_id: &str,
        name: &str,
        content: String,
        thinking: String,
        model: String,
    ) {
        if content.trim().is_empty() {
            return;
        }
        self.messages.push(StoredMessage {
            agent_id: agent_id.into(),
            display_name: name.into(),
            content,
            thinking,
            model,
            at_ms: store::now_ms(),
        });
    }

    fn save(&self, done: bool, turn_count: u32, usage: socratic_council::types::Usage) {
        let Some(store) = &self.store else { return };
        let json = store::build_session_json(
            &self.session_id,
            &self.topic,
            self.created_at_ms,
            &self.messages,
            if done { "completed" } else { "paused" },
            self.prior_turns + turn_count,
            usage,
        );
        if let Err(e) = store.save(&json) {
            eprintln!("[session] not saved: {e}");
        }
    }
}

async fn run_plain(engine: Engine, max_turns: u32, mut record: PlainRecord) {
    use socratic_council::engine::sanitize_terminal as clean;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc::unbounded_channel;

    let (tx, mut rx) = unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let engine_cancel = cancel.clone();
    let handle = tokio::spawn(async move { engine.run(tx, engine_cancel).await });

    let mut current = String::new();
    let mut current_thinking = String::new();
    let mut current_speaker: (String, String, String) = Default::default();
    let mut usage_total = socratic_council::types::Usage::default();
    let mut done = false;
    let mut turn_no: u32 = 0;
    let mut last_tension: f32 = 0.0;
    let mut final_cost: Option<socratic_council::types::CostSnapshot> = None;
    println!("session {}", record.session_id);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                cancel.store(true, Ordering::Relaxed);
                eprintln!("\n(stopping…)");
                break;
            }
            maybe = rx.recv() => {
                let Some(ev) = maybe else { break };
                match ev {
                    DebateEvent::Moderator(text) => {
                        println!("\n— {}\n", clean(&text));
                        record.push("moderator", "Moderator", text, String::new(), String::new());
                    }
                    DebateEvent::Conclusion(c) => {
                        println!("\n── Council Verdict ──");
                        println!("{} {}    Score {}/10", c.status.glyph(), c.status.label(), c.score);
                        println!("{}", clean(&c.summary));
                        if !c.reason.trim().is_empty() {
                            println!("Reason: {}", clean(&c.reason));
                        }
                        if let Some(next) = &c.next {
                            println!("Next:   {}", clean(next));
                        }
                        println!();
                        record.push(
                            "moderator",
                            "Moderator",
                            format!("Verdict: {} · Score {}/10\n{}\n{}", c.status.label(), c.score, c.summary, c.reason),
                            String::new(),
                            String::new(),
                        );
                    }
                    DebateEvent::TurnStarted { agent_id, name, model, .. } => {
                        turn_no += 1;
                        let marker = if max_turns > 0 {
                            format!("[{turn_no}/{max_turns}] ")
                        } else {
                            format!("[{turn_no}] ")
                        };
                        print!("\n{marker}{name} ({model}):\n");
                        let _ = std::io::stdout().flush();
                        current.clear();
                        current_thinking.clear();
                        current_speaker = (agent_id, name, model);
                    }
                    // Accumulate the turn; print the directive-stripped message at
                    // the end so piped output stays clean (no @canvas/@end lines).
                    DebateEvent::Token(t) => current.push_str(&t),
                    DebateEvent::Thinking(t) => current_thinking.push_str(&t),
                    DebateEvent::TurnEnded { usage, .. } => {
                        usage_total.input += usage.input;
                        usage_total.output += usage.output;
                        usage_total.reasoning += usage.reasoning;
                        let (stripped, _) = socratic_council::engine::strip_directives(&current);
                        for line in clean(&stripped).lines() {
                            println!("  {line}");
                        }
                        println!();
                        let (agent_id, name, model) = current_speaker.clone();
                        record.push(&agent_id, &name, stripped, std::mem::take(&mut current_thinking), model);
                        record.save(false, turn_no, usage_total);
                    }
                    DebateEvent::AdvisorNote(n) => {
                        println!("  🔒 ({} → {}): {}", n.observer_name, n.partner_name, clean(&n.text));
                    }
                    DebateEvent::Tool(t) => {
                        println!("\n[tool] {} — “{}” (asked by {})", t.name, clean(&t.query), t.agent_name);
                        for line in clean(&t.output).lines() {
                            println!("  {line}");
                        }
                        println!();
                        record.push("tool", "Tool", format!("Tool result ({}): {}", t.name, t.output), String::new(), String::new());
                    }
                    DebateEvent::Conflict(pairs) => {
                        // Only narrate meaningful shifts of the top tension.
                        let top = pairs
                            .iter()
                            .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal));
                        if let Some(p) = top {
                            if p.score >= 0.40 && (p.score - last_tension).abs() >= 0.10 {
                                last_tension = p.score;
                                println!("  ⚡ tension {} ↔ {} {:.2}", p.a_name, p.b_name, p.score);
                            }
                        }
                    }
                    DebateEvent::Cost(snap) => {
                        if let Some(note) = &snap.note {
                            eprintln!("  [budget] {}", clean(note));
                        }
                        final_cost = Some(snap);
                    }
                    DebateEvent::EndVoteStarted { proposer, threshold, total } => {
                        println!("\n── End Vote · moved by {proposer} (needs {threshold}/{total} YES) ──");
                    }
                    DebateEvent::Vote { name, choice, reason, .. } => {
                        println!("  {name}: {} — {}", choice.label(), clean(&reason));
                    }
                    DebateEvent::EndVoteResult { passed, yes, no, abstain } => {
                        println!(
                            "  Result: {} — YES {yes} · NO {no} · ABSTAIN {abstain}\n",
                            if passed { "PASSED" } else { "FAILED" }
                        );
                    }
                    DebateEvent::PeerEval(round) => {
                        println!("\n── Peer Review Scorecard · {} critiques ──", round.critiques.len());
                        println!("   #  Agent       rig evi nov civ top   avg");
                        for s in &round.summaries {
                            println!(
                                "  #{} {:<10} {:>3} {:>3} {:>3} {:>3} {:>3}   {:>3}",
                                s.rank, s.name, s.avg.rigor, s.avg.evidence, s.avg.novelty,
                                s.avg.civility, s.avg.on_topic, s.overall
                            );
                        }
                        println!();
                    }
                    DebateEvent::DeepResearch(r) => {
                        println!("\n══ Deep Research Report — {} ({}) ══", clean(&r.title), r.confidence.label());
                        println!("{}\n", clean(&r.abstract_text));
                        for sec in &r.sections {
                            println!("• {} [{}]", clean(&sec.heading), sec.confidence.label());
                            println!("  {}\n", clean(&sec.body));
                        }
                    }
                    DebateEvent::Error(e) => eprintln!("\n[error] {}", clean(&e)),
                    DebateEvent::Done => {
                        done = true;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    record.save(done, turn_no, usage_total);
    if record.store.is_some() {
        eprintln!(
            "[session] saved {} ({})",
            record.session_id,
            if done {
                "completed"
            } else {
                "paused — resume with --resume"
            }
        );
    }

    // Closing cost ledger.
    if let Some(snap) = final_cost {
        println!("\n── Cost Ledger ──");
        for row in &snap.rows {
            println!(
                "  {:<10} {:>9} in {:>9} out  {}${:.4}",
                row.name,
                row.input,
                row.output + row.reasoning,
                if row.priced { "" } else { "≥" },
                row.usd
            );
        }
        for (lane, usd) in &snap.lane_usd {
            println!("  {:<10} ${usd:.4}", lane.label());
        }
        println!(
            "  total      {}${:.4}{}",
            if snap.all_priced { "" } else { "≥" },
            snap.total_usd,
            if snap.daily_cap > 0.0 || snap.session_cap > 0.0 {
                format!("  (today ${:.2})", snap.daily_usd)
            } else {
                String::new()
            }
        );
    }

    handle.abort();
    let _ = handle.await;
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
) -> anyhow::Result<()> {
    use socratic_council::catalog::resolve_model;
    use socratic_council::engine::sanitize_terminal as clean;
    use socratic_council::providers::stream_completion;
    use socratic_council::types::{ChatMessage, CompletionChunk, CompletionRequest};

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
        };
        let mut content = String::new();
        let mut thinking = 0usize;
        let started = std::time::Instant::now();
        let result = {
            let mut on_chunk = |c: &CompletionChunk| {
                content.push_str(&c.content);
                thinking += c.thinking.chars().count();
            };
            stream_completion(&http, provider, &base, &key, &req, &mut on_chunk).await
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
