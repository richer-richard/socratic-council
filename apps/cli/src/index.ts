/**
 * @fileoverview Socratic Council CLI - Main entry point
 * Group chat style multi-agent debate in your terminal
 */

import { input, select, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import Conf from "conf";
import type { AgentId, ModelId, Provider, ProviderCredentials } from "@socratic-council/shared";
import { DEFAULT_AGENTS, getModelsByProvider, getModelInfo } from "@socratic-council/shared";
import { Council, type CouncilEvent } from "@socratic-council/core";
import { ProviderManager, createFetchTransport, type ProxyConfig } from "@socratic-council/sdk";

// Config store for API keys (stored securely in user's config directory)
const config = new Conf<{
  credentials: ProviderCredentials;
  agentModels: Record<AgentId, string>;
}>({
  projectName: "socratic-council",
  schema: {
    credentials: {
      type: "object",
      default: {},
    },
    agentModels: {
      type: "object",
      default: {},
    },
  },
});

// Agent colors for the group chat display
const AGENT_COLORS: Record<AgentId | "system" | "user", (text: string) => string> = {
  george: chalk.blue,
  cathy: chalk.magenta,
  grace: chalk.green,
  douglas: chalk.yellow,
  kate: chalk.cyan,
  quinn: chalk.cyanBright,
  mary: chalk.hex("#f472b6"),
  system: chalk.gray,
  user: chalk.white.bold,
};

// Agent background colors for headers
const AGENT_BG_COLORS: Record<AgentId, (text: string) => string> = {
  george: chalk.bgBlue.white,
  cathy: chalk.bgMagenta.white,
  grace: chalk.bgGreen.black,
  douglas: chalk.bgYellow.black,
  kate: chalk.bgCyan.black,
  quinn: chalk.bgCyanBright.black,
  mary: chalk.bgHex("#f472b6").black,
};

// Agent emoji avatars
const AGENT_AVATARS: Record<AgentId | "system" | "user", string> = {
  george: "🔷",
  cathy: "💜",
  grace: "🌱",
  douglas: "🔶",
  kate: "📚",
  quinn: "🧠",
  mary: "🟢",
  system: "⚙️",
  user: "👤",
};

// Agent role descriptions
const AGENT_ROLES: Record<AgentId, string> = {
  george: "Logician",
  cathy: "Ethicist",
  grace: "Futurist",
  douglas: "Skeptic",
  kate: "Historian",
  quinn: "Strategist",
  mary: "Operator",
};

function parseProxyUrl(raw?: string): ProxyConfig | undefined {
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const type = url.protocol.replace(":", "");
    if (!["http", "https", "socks5", "socks5h"].includes(type)) {
      return undefined;
    }
    if (!url.port || !url.hostname) return undefined;
    const port = parseInt(url.port, 10);
    if (port < 1 || port > 65535) return undefined;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    return {
      type: type as ProxyConfig["type"],
      host: url.hostname,
      port,
      username: username || undefined,
      password: password || undefined,
    };
  } catch {
    return undefined;
  }
}

const proxy =
  parseProxyUrl(process.env.SOCRATIC_PROXY) ||
  parseProxyUrl(process.env.ALL_PROXY) ||
  parseProxyUrl(process.env.HTTPS_PROXY) ||
  parseProxyUrl(process.env.HTTP_PROXY);

const transport = createFetchTransport({ proxy });

/**
 * Display the welcome banner
 */
function showBanner(): void {
  console.clear();

  // Gradient effect banner
  const lines = [
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃                                                                 ┃",
    "┃           🏛️   S O C R A T I C   C O U N C I L   🏛️            ┃",
    "┃                     O F   F I V E                               ┃",
    "┃                                                                 ┃",
    "┃       Multi-Agent Group Debate • Emergent Orchestration         ┃",
    "┃                                                                 ┃",
    "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
  ];

  console.log();
  lines.forEach((line, i) => {
    // Gradient from cyan to blue
    const ratio = i / lines.length;
    if (ratio < 0.5) {
      console.log(chalk.cyan(line));
    } else {
      console.log(chalk.blue(line));
    }
  });
  console.log();

  // Council members display with boxes
  console.log(chalk.gray("  ╭─────────────────────────────────────────────────────────────╮"));
  console.log(chalk.gray("  │") + chalk.white.bold("  Council Members                                            ") + chalk.gray("│"));
  console.log(chalk.gray("  ├─────────────────────────────────────────────────────────────┤"));

  const members = [
    { id: "george" as AgentId, provider: "OpenAI GPT-5.2" },
    { id: "cathy" as AgentId, provider: "Anthropic Claude 4.6" },
    { id: "grace" as AgentId, provider: "Google Gemini 3.1" },
    { id: "douglas" as AgentId, provider: "DeepSeek Reasoner" },
    { id: "kate" as AgentId, provider: "Kimi K2.5" },
    { id: "quinn" as AgentId, provider: "Qwen 3.5 Plus" },
    { id: "mary" as AgentId, provider: "MiniMax M2.5" },
  ];

  members.forEach((m) => {
    const avatar = AGENT_AVATARS[m.id];
    const name = DEFAULT_AGENTS[m.id].name.padEnd(10);
    const role = `(${AGENT_ROLES[m.id]})`.padEnd(12);
    const provider = m.provider.padEnd(24);
    const color = AGENT_COLORS[m.id];
    console.log(
      chalk.gray("  │  ") +
      `${avatar} ` +
      color(name) +
      chalk.gray(role) +
      chalk.dim(provider) +
      chalk.gray("│")
    );
  });

  console.log(chalk.gray("  ╰─────────────────────────────────────────────────────────────╯"));
  console.log();
}

/**
 * Home menu
 */
async function showHomeMenu(): Promise<"start" | "settings" | "exit"> {
  return await select({
    message: chalk.bold("What would you like to do?"),
    choices: [
      { name: chalk.green("🚀 Start New Discussion"), value: "start" as const },
      { name: chalk.blue("⚙️  Settings (API Keys & Models)"), value: "settings" as const },
      { name: chalk.gray("🚪 Exit"), value: "exit" as const },
    ],
  });
}

/**
 * Settings menu for configuring API keys and models
 */
async function showSettings(): Promise<void> {
  const credentials = config.get("credentials") ?? {};

  type SettingsAction = Provider | "models" | "back";

  console.log();
  console.log(chalk.bold.blue("  ⚙️  Settings"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  console.log();

  while (true) {
    const providers: Provider[] = ["openai", "anthropic", "google", "deepseek", "kimi"];
    const choices: Array<{ name: string; value: SettingsAction }> = providers.map((p) => {
      const hasKey = !!(credentials as Record<string, { apiKey?: string }>)[p]?.apiKey;
      const status = hasKey ? chalk.green("✓") : chalk.red("✗");
      const name = p.charAt(0).toUpperCase() + p.slice(1);
      return {
        name: `${status} ${name.padEnd(12)} ${hasKey ? chalk.dim("configured") : chalk.dim("not set")}`,
        value: p,
      };
    });

    choices.push(
      { name: chalk.yellow("📊 Configure Agent Models"), value: "models" },
      { name: chalk.gray("🔙 Back to Home"), value: "back" }
    );

    const action = await select<SettingsAction>({
      message: "Select provider to configure:",
      choices,
    });

    if (action === "back") break;

    if (action === "models") {
      await configureAgentModels();
      continue;
    }

    // Configure API key for selected provider
    const providerName = action.charAt(0).toUpperCase() + action.slice(1);
    console.log();
    const apiKey = await input({
      message: `Enter your ${chalk.bold(providerName)} API key:`,
      validate: (value) => (value.length > 0 ? true : "API key cannot be empty"),
    });

    // Update credentials
    const newCredentials = {
      ...credentials,
      [action]: { apiKey },
    };
    config.set("credentials", newCredentials);

    // Test the connection
    const spinner = ora({
      text: `Testing ${providerName} connection...`,
      color: "cyan",
    }).start();

    try {
      const manager = new ProviderManager({ [action]: { apiKey } }, { transport });
      const results = await manager.testConnections();
      if (results[action as Provider]) {
        spinner.succeed(chalk.green(`${providerName} API key verified successfully!`));
      } else {
        spinner.fail(chalk.red(`${providerName} API key test failed - please check your key`));
      }
    } catch {
      spinner.fail(chalk.red(`Failed to connect to ${providerName}`));
    }
    console.log();
  }
}

/**
 * Configure which model each agent uses
 */
async function configureAgentModels(): Promise<void> {
  const agentModels = config.get("agentModels") ?? {};

  console.log();
  console.log(chalk.bold.yellow("  📊 Configure Agent Models"));
  console.log(chalk.gray("  ─────────────────────────────────────────────"));
  console.log();

  const agents: AgentId[] = ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary"];
  const agentProviders: Record<AgentId, Provider> = {
    george: "openai",
    cathy: "anthropic",
    grace: "google",
    douglas: "deepseek",
    kate: "kimi",
    quinn: "qwen",
    mary: "minimax",
  };

  for (const agentId of agents) {
    const provider = agentProviders[agentId];
    const models = getModelsByProvider(provider);
    const currentModel = agentModels[agentId] ?? DEFAULT_AGENTS[agentId].model;
    const color = AGENT_COLORS[agentId];

    const modelChoices = models.map((m) => ({
      name: `${m.name} ${chalk.dim(`- ${m.description}`)}`,
      value: m.id,
    }));

    const selectedModel = await select<ModelId>({
      message: `${AGENT_AVATARS[agentId]} ${color(DEFAULT_AGENTS[agentId].name)} ${chalk.dim(`(${AGENT_ROLES[agentId]})`)}:`,
      choices: modelChoices,
      default: currentModel,
    });

    agentModels[agentId] = selectedModel as string;
  }

  config.set("agentModels", agentModels);
  console.log();
  console.log(chalk.green("  ✓ Agent models updated successfully!"));
  console.log();
}

/**
 * Display bidding scores visualization
 */
function displayBiddingScores(scores: Record<AgentId, number>, winner: AgentId): void {
  const maxScore = Math.max(...Object.values(scores));
  const barWidth = 20;

  console.log();
  console.log(chalk.gray("  ┌─────────────────────────────────────────────────────┐"));
  console.log(chalk.gray("  │") + chalk.white.bold("  Bidding Round Results                              ") + chalk.gray("│"));
  console.log(chalk.gray("  ├─────────────────────────────────────────────────────┤"));

  const sortedAgents = (Object.entries(scores) as [AgentId, number][])
    .sort((a, b) => b[1] - a[1]);

  for (const [agentId, score] of sortedAgents) {
    const barLength = Math.round((score / maxScore) * barWidth);
    const bar = "█".repeat(barLength) + "░".repeat(barWidth - barLength);
    const color = AGENT_COLORS[agentId];
    const isWinner = agentId === winner;
    const winnerMark = isWinner ? chalk.yellow(" ★") : "  ";
    const name = DEFAULT_AGENTS[agentId].name.padEnd(8);
    const scoreStr = score.toFixed(1).padStart(5);

    console.log(
      chalk.gray("  │  ") +
      color(name) +
      color(bar) + " " +
      chalk.white(scoreStr) +
      winnerMark +
      chalk.gray("      │")
    );
  }

  console.log(chalk.gray("  └─────────────────────────────────────────────────────┘"));
  console.log();
}

/**
 * Display turn header
 */
function displayTurnHeader(agentId: AgentId, turnNumber: number, maxTurns: number): void {
  const bgColor = AGENT_BG_COLORS[agentId];
  const agent = DEFAULT_AGENTS[agentId];
  const progress = `${turnNumber}/${maxTurns}`;

  console.log();
  console.log(
    chalk.gray("  ╭──") +
    bgColor(` ${AGENT_AVATARS[agentId]} ${agent.name} `) +
    chalk.gray("──") +
    chalk.dim(` Turn ${progress} `) +
    chalk.gray("─".repeat(35))
  );
  console.log(chalk.gray("  │"));
}

/**
 * Display message footer with stats
 */
function displayMessageFooter(tokens: { input: number; output: number }, latencyMs: number): void {
  console.log(chalk.gray("  │"));
  console.log(
    chalk.gray("  ╰──") +
    chalk.dim(` ${tokens.input}→${tokens.output} tokens • ${latencyMs}ms `) +
    chalk.gray("─".repeat(35))
  );
}

/**
 * Display completion summary
 */
function displayCompletionSummary(
  totalTurns: number,
  totalMessages: number,
  totalTokens: { input: number; output: number },
  agentStats: Record<AgentId, { messages: number; tokens: number }>
): void {
  console.log();
  console.log(chalk.cyan("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"));
  console.log(chalk.cyan("┃") + chalk.bold.white("  🏁 Discussion Complete                                        ") + chalk.cyan("┃"));
  console.log(chalk.cyan("┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫"));

  // Overall stats
  console.log(chalk.cyan("┃") + chalk.white("  📊 Summary                                                    ") + chalk.cyan("┃"));
  console.log(chalk.cyan("┃") + chalk.gray(`     Total turns: ${String(totalTurns).padEnd(10)} Total messages: ${String(totalMessages).padEnd(10)}`) + chalk.cyan("     ┃"));
  console.log(chalk.cyan("┃") + chalk.gray(`     Tokens used: ${String(totalTokens.input + totalTokens.output).padEnd(10)} (${totalTokens.input} in, ${totalTokens.output} out)`) + chalk.cyan("     ┃"));
  console.log(chalk.cyan("┃") + "                                                                 " + chalk.cyan("┃"));

  // Per-agent breakdown
  console.log(chalk.cyan("┃") + chalk.white("  👥 Agent Participation                                        ") + chalk.cyan("┃"));

  for (const agentId of Object.keys(agentStats) as AgentId[]) {
    const stats = agentStats[agentId];
    const color = AGENT_COLORS[agentId];
    const name = DEFAULT_AGENTS[agentId].name.padEnd(10);
    const msgCount = `${stats.messages} msgs`.padEnd(10);
    const tokenCount = `${stats.tokens} tokens`;

    console.log(
      chalk.cyan("┃") +
      "     " +
      `${AGENT_AVATARS[agentId]} ` +
      color(name) +
      chalk.gray(msgCount) +
      chalk.dim(tokenCount.padEnd(20)) +
      chalk.cyan("       ┃")
    );
  }

  console.log(chalk.cyan("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"));
  console.log();
}

/**
 * Start a new discussion
 */
async function startDiscussion(): Promise<void> {
  const credentials = config.get("credentials") ?? {};

  // Check if at least some providers are configured
  const configuredProviders = Object.keys(credentials).filter(
    (k) => (credentials as Record<string, { apiKey?: string }>)[k]?.apiKey
  );

  if (configuredProviders.length === 0) {
    console.log();
    console.log(chalk.red("  ⚠️  No API keys configured!"));
    console.log(chalk.yellow("  Please configure at least one provider in Settings first."));
    console.log();

    const goToSettings = await confirm({
      message: "Would you like to configure API keys now?",
      default: true,
    });

    if (goToSettings) {
      await showSettings();
    }
    return;
  }

  // Get discussion topic
  console.log();
  const topic = await input({
    message: chalk.bold("Enter a topic for the council to discuss:"),
    validate: (value) => (value.length > 0 ? true : "Topic cannot be empty"),
  });

  // Configure council options
  const maxTurns = await select({
    message: "Select discussion length:",
    choices: [
      { name: chalk.green("⚡ Quick") + chalk.dim(" (5 turns)"), value: 5 },
      { name: chalk.blue("📝 Standard") + chalk.dim(" (10 turns)"), value: 10 },
      { name: chalk.yellow("📚 Extended") + chalk.dim(" (20 turns)"), value: 20 },
      { name: chalk.red("🏃 Marathon") + chalk.dim(" (50 turns)"), value: 50 },
    ],
    default: 10,
  });

  // Display topic header
  console.log();
  console.log(chalk.cyan("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"));
  console.log(chalk.cyan("┃") + chalk.bold.white("  📜 Discussion Topic                                           ") + chalk.cyan("┃"));
  console.log(chalk.cyan("┃") + "                                                                 " + chalk.cyan("┃"));

  // Wrap topic text
  const wrappedTopic = topic.length > 60
    ? topic.substring(0, 57) + "..."
    : topic.padEnd(60);
  console.log(chalk.cyan("┃") + chalk.white(`  "${wrappedTopic}"`) + chalk.cyan(" ┃"));
  console.log(chalk.cyan("┃") + "                                                                 " + chalk.cyan("┃"));
  console.log(chalk.cyan("┃") + chalk.dim(`  Turns: ${maxTurns} • Mode: Auto • Bidding: Enabled`.padEnd(62)) + chalk.cyan(" ┃"));
  console.log(chalk.cyan("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"));

  // Build agent configs with selected models
  const agentModels = config.get("agentModels") ?? {};
  const agents = Object.fromEntries(
    Object.entries(DEFAULT_AGENTS).map(([id, cfg]) => {
      const stored = agentModels[id as AgentId] as string | undefined;
      const model = stored && getModelInfo(stored) ? (stored as ModelId) : cfg.model;
      return [id, { ...cfg, model }];
    })
  ) as Record<AgentId, typeof DEFAULT_AGENTS[AgentId]>;

  // Create council
  const council = new Council(
    credentials as ProviderCredentials,
    { topic, maxTurns, autoMode: true },
    agents,
    { transport }
  );

  // Track statistics
  let currentAgentId: AgentId | null = null;
  const totalTokens = { input: 0, output: 0 };
  const agentStats: Record<AgentId, { messages: number; tokens: number }> = {
    george: { messages: 0, tokens: 0 },
    cathy: { messages: 0, tokens: 0 },
    grace: { messages: 0, tokens: 0 },
    douglas: { messages: 0, tokens: 0 },
    kate: { messages: 0, tokens: 0 },
    quinn: { messages: 0, tokens: 0 },
    mary: { messages: 0, tokens: 0 },
  };

  // Set up event handling for group chat display
  council.onEvent((event: CouncilEvent) => {
    switch (event.type) {
      case "turn_started": {
        currentAgentId = event.agentId;
        displayTurnHeader(event.agentId, event.turnNumber, maxTurns);
        process.stdout.write(chalk.gray("  │  "));
        break;
      }

      case "message_chunk": {
        if (event.agentId === currentAgentId) {
          // Word wrap long lines
          process.stdout.write(event.content);
        }
        break;
      }

      case "message_complete": {
        console.log(); // New line after message
        const tokens = event.message.tokens;
        if (tokens) {
          totalTokens.input += tokens.input;
          totalTokens.output += tokens.output;

          if (currentAgentId) {
            agentStats[currentAgentId].messages += 1;
            agentStats[currentAgentId].tokens += tokens.input + tokens.output;
          }

          displayMessageFooter(tokens, event.message.metadata?.latencyMs ?? 0);
        }
        break;
      }

      case "bidding_complete": {
        displayBiddingScores(event.scores, event.winner);
        break;
      }

      case "error": {
        const agentName = event.agentId ? DEFAULT_AGENTS[event.agentId].name : "System";
        console.log();
        console.log(chalk.red(`  ⚠️  Error from ${agentName}: ${event.error.message}`));
        console.log();
        break;
      }

      case "council_completed": {
        displayCompletionSummary(
          event.state.currentTurn,
          event.state.messages.length,
          totalTokens,
          agentStats
        );
        break;
      }
    }
  });

  // Start the discussion
  const spinner = ora({
    text: "Initializing council discussion...",
    color: "cyan",
  }).start();

  try {
    spinner.stop();
    console.log();
    await council.start(topic);
  } catch (error) {
    spinner.fail(chalk.red("Failed to start discussion"));
    console.error(error);
  }
}

/**
 * Main application loop
 */
async function main(): Promise<void> {
  showBanner();

  while (true) {
    const action = await showHomeMenu();

    switch (action) {
      case "start":
        await startDiscussion();
        break;
      case "settings":
        await showSettings();
        break;
      case "exit":
        console.log();
        console.log(chalk.cyan("  👋 Thank you for using Socratic Council!"));
        console.log(chalk.gray("  Visit https://github.com/socratic-council for more info."));
        console.log();
        process.exit(0);
    }
  }
}

// Run the CLI
main().catch(console.error);
