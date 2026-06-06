//! `socratic-council` CLI entry point.

use clap::{Parser, Subcommand};
use socratic_council::catalog::{catalog_models, resolve_model, DiscoveredModel, ModelSource};
use socratic_council::config::Config;
use socratic_council::engine::{default_agents, DebateEvent, Engine};
use socratic_council::providers::scan::scan_models;
use socratic_council::tui::{self, AgentMeta};
use socratic_council::types::{Provider, ReasoningTier};
use socratic_council::http_client;
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
        /// The debate topic (omit to be prompted).
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
        Some(Command::Run { topic, providers, tier, max_turns, no_tui, scan }) => {
            cmd_run(RunArgs {
                topic: topic.join(" "),
                providers,
                tier,
                max_turns,
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
    let config = Config::load()?;

    let mut topic = args.topic;
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

    let tier = args.tier.unwrap_or(config.council_tier);
    let configured = config.configured_providers();
    if configured.is_empty() {
        anyhow::bail!(
            "no API keys configured. Set one with `socratic-council config set-key <provider>` \
             or a <PROVIDER>_API_KEY env var."
        );
    }
    let filter = parse_provider_filter(&args.providers);

    let mut agents: Vec<_> = default_agents(tier)
        .into_iter()
        .filter(|a| configured.contains(&a.provider))
        .filter(|a| filter.as_ref().map(|f| f.contains(&a.provider)).unwrap_or(true))
        .collect();
    if agents.is_empty() {
        anyhow::bail!("none of the requested providers have a key configured");
    }
    // Stable speaking order.
    agents.sort_by_key(|a| a.name.clone());

    let http = http_client(config.proxy.as_deref());

    // Build the available-models map per provider (scan or catalog).
    let mut available: HashMap<Provider, Vec<DiscoveredModel>> = HashMap::new();
    for agent in &agents {
        if available.contains_key(&agent.provider) {
            continue;
        }
        let models = if args.scan {
            match scan_models(
                &http,
                agent.provider,
                &config.base_url(agent.provider),
                config.api_key(agent.provider).unwrap_or_default(),
            )
            .await
            {
                Ok(m) => m,
                Err(_) => catalog_models(agent.provider),
            }
        } else {
            catalog_models(agent.provider)
        };
        available.insert(agent.provider, models);
    }

    // Roster (resolved model per agent) for display.
    let roster: Vec<AgentMeta> = agents
        .iter()
        .map(|a| {
            let empty = Vec::new();
            let avail = available.get(&a.provider).unwrap_or(&empty);
            let model = resolve_model(
                a.provider,
                a.tier,
                avail,
                config.selection(a.provider, a.tier).as_deref(),
            );
            AgentMeta { name: a.name.clone(), provider: a.provider, model }
        })
        .collect();

    let max_turns = match args.max_turns.unwrap_or(config.max_turns) {
        0 => 1000,
        n => n,
    };

    let engine = Engine::new(http, config, topic.clone(), agents, available, max_turns);

    if args.no_tui {
        run_plain(engine).await;
        Ok(())
    } else {
        tui::run(engine, roster, topic).await
    }
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
            match config.api_key(provider) {
                Some(key) => match scan_models(&http, provider, &config.base_url(provider), key).await
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
        let mark = if config.api_key(provider).is_some() { "✓" } else { " " };
        println!(
            "  [{mark}] {:<10} {}",
            provider.slug(),
            if config.api_key(provider).is_some() { "configured" } else { "no key" }
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
