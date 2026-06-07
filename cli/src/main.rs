//! `socratic-council` CLI entry point.

use clap::{Parser, Subcommand};
use socratic_council::catalog::{catalog_models, DiscoveredModel, ModelSource};
use socratic_council::config::Config;
use socratic_council::engine::{default_agents, DebateEvent, Engine};
use socratic_council::http_client;
use socratic_council::providers::scan::scan_models;
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
        /// Plain streaming output instead of the TUI.
        #[arg(long)]
        no_tui: bool,
        /// Scan each provider's live models before starting.
        #[arg(long)]
        scan: bool,
    },
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
            no_tui,
            scan,
        }) => {
            cmd_run(RunArgs {
                topic: topic.join(" "),
                providers,
                tier,
                max_turns,
                reflect,
                deep_research,
                no_tui,
                scan,
            })
            .await
        }
        Some(Command::Models { provider, scan }) => cmd_models(provider, scan).await,
        Some(Command::Providers) => cmd_providers(),
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
    no_tui: bool,
    scan: bool,
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
            Provider::ALL.iter().map(|p| p.slug()).collect::<Vec<_>>().join(", ")
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
        let configured: Vec<Provider> =
            allowed.iter().copied().filter(|p| config.is_configured(*p)).collect();
        if configured.is_empty() {
            anyhow::bail!(
                "no API keys configured for the selected providers. Add one with \
                 `socratic-council config set-key <provider>` or a <PROVIDER>_API_KEY env \
                 var — or drop --no-tui and add a key in Settings (press ^P)."
            );
        }
        return run_plain_debate(config, http, available, prefetched_keys, &args, &configured).await;
    }

    let initial_topic =
        if args.topic.trim().is_empty() { None } else { Some(args.topic.clone()) };
    let ctx = AppContext { http, config, available, providers: allowed, prefetched_keys };
    tui::run(ctx, initial_topic).await
}

/// Plain (non-TUI) streaming debate for piping / scripting.
async fn run_plain_debate(
    config: Config,
    http: reqwest::Client,
    available: HashMap<Provider, Vec<DiscoveredModel>>,
    mut keys: HashMap<Provider, String>,
    args: &RunArgs,
    providers: &[Provider],
) -> anyhow::Result<()> {
    let mut topic = args.topic.clone();
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
    let engine = Engine::new(http, config, topic, agents, available, keys, max_turns);
    run_plain(engine).await;
    Ok(())
}

async fn run_plain(engine: Engine) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc::unbounded_channel;

    let (tx, mut rx) = unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let engine_cancel = cancel.clone();
    let handle = tokio::spawn(async move { engine.run(tx, engine_cancel).await });

    let mut current = String::new();
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
                    DebateEvent::Moderator(text) => println!("\n— {text}\n"),
                    DebateEvent::Conclusion(c) => {
                        println!("\n── Council Verdict ──");
                        println!("{} {}    Score {}/10", c.status.glyph(), c.status.label(), c.score);
                        println!("{}", c.summary);
                        if !c.reason.trim().is_empty() {
                            println!("Reason: {}", c.reason);
                        }
                        if let Some(next) = &c.next {
                            println!("Next:   {next}");
                        }
                        println!();
                    }
                    DebateEvent::TurnStarted { name, model, .. } => {
                        print!("\n{name} ({model}):\n  ");
                        let _ = std::io::stdout().flush();
                        current.clear();
                    }
                    DebateEvent::Token(t) => {
                        current.push_str(&t);
                        print!("{t}");
                        let _ = std::io::stdout().flush();
                    }
                    DebateEvent::TurnEnded { .. } => println!(),
                    DebateEvent::EndVoteStarted { proposer, threshold, total } => {
                        println!("\n── End Vote · moved by {proposer} (needs {threshold}/{total} YES) ──");
                    }
                    DebateEvent::Vote { name, choice, reason, .. } => {
                        println!("  {name}: {} — {reason}", choice.label());
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
                        println!("\n══ Deep Research Report — {} ({}) ══", r.title, r.confidence.label());
                        println!("{}\n", r.abstract_text);
                        for sec in &r.sections {
                            println!("• {} [{}]", sec.heading, sec.confidence.label());
                            println!("  {}\n", sec.body);
                        }
                    }
                    DebateEvent::Error(e) => eprintln!("\n[error] {e}"),
                    DebateEvent::Done => break,
                    _ => {}
                }
            }
        }
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
                Some(key) => match scan_models(&http, provider, &config.base_url(provider), &key).await
                {
                    Ok(m) => m,
                    Err(e) => {
                        println!("  scan failed ({e}); showing catalog");
                        catalog_models(provider)
                    }
                },
                None => {
                    println!("  no API key; showing catalog");
                    catalog_models(provider)
                }
            }
        } else {
            catalog_models(provider)
        };
        for m in models {
            let tag = if m.source == ModelSource::Scanned { "live" } else { "cat" };
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
