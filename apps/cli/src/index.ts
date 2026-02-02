/**
 * @fileoverview Socratic Council CLI - Main entry point
 * Group chat style multi-agent debate in your terminal
 */

import { input, select, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import Conf from "conf";
import type { AgentId, Provider, ProviderCredentials } from "@socratic-council/shared";
import { DEFAULT_AGENTS, MODEL_REGISTRY, getModelsByProvider } from "@socratic-council/shared";
import { Council, type CouncilEvent } from "@socratic-council/core";
import { ProviderManager } from "@socratic-council/sdk";

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
  system: chalk.gray,
  user: chalk.white.bold,
};

// Agent emoji avatars
const AGENT_AVATARS: Record<AgentId | "system" | "user", string> = {
  george: "🔷",
  cathy: "💜",
  grace: "🌱",
  douglas: "🔶",
  kate: "📚",
  system: "⚙️",
  user: "👤",
};

/**
 * Display the welcome banner
 */
function showBanner(): void {
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║           🏛️  SOCRATIC COUNCIL OF FIVE  🏛️                   ║
║                                                              ║
║     Multi-Agent Group Chat for Deep Philosophical Debate     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`));

  console.log(chalk.gray("  Council Members:"));
  console.log(chalk.blue("  • George (The Logician) - OpenAI GPT-5.2"));
  console.log(chalk.magenta("  • Cathy (The Ethicist) - Anthropic Claude 4.5"));
  console.log(chalk.green("  • Grace (The Futurist) - Google Gemini 3"));
  console.log(chalk.yellow("  • Douglas (The Skeptic) - DeepSeek V3.2"));
  console.log(chalk.cyan("  • Kate (The Historian) - Kimi K2.5"));
  console.log();
}

/**
 * Home menu
 */
async function showHomeMenu(): Promise<"start" | "settings" | "exit"> {
  return await select({
    message: "What would you like to do?",
    choices: [
      { name: "🚀 Start New Discussion", value: "start" as const },
      { name: "⚙️  Settings (API Keys & Models)", value: "settings" as const },
      { name: "🚪 Exit", value: "exit" as const },
    ],
  });
}

/**
 * Settings menu for configuring API keys and models
 */
async function showSettings(): Promise<void> {
  const credentials = config.get("credentials") ?? {};

  while (true) {
    const providers: Provider[] = ["openai", "anthropic", "google", "deepseek", "kimi"];
    const choices = providers.map((p) => {
      const hasKey = !!(credentials as Record<string, { apiKey?: string }>)[p]?.apiKey;
      const status = hasKey ? chalk.green("✓ configured") : chalk.red("✗ not set");
      return {
        name: `${p.charAt(0).toUpperCase() + p.slice(1)} ${status}`,
        value: p,
      };
    });

    choices.push(
      { name: "📊 Configure Agent Models", value: "models" as Provider },
      { name: "🔙 Back to Home", value: "back" as Provider }
    );

    const action = await select({
      message: "Settings - Configure API Keys:",
      choices,
    });

    if (action === "back") break;

    if (action === "models") {
      await configureAgentModels();
      continue;
    }

    // Configure API key for selected provider
    const apiKey = await input({
      message: `Enter your ${action} API key:`,
      validate: (value) => (value.length > 0 ? true : "API key cannot be empty"),
    });

    // Update credentials
    const newCredentials = {
      ...credentials,
      [action]: { apiKey },
    };
    config.set("credentials", newCredentials);

    // Test the connection
    const spinner = ora(`Testing ${action} connection...`).start();
    try {
      const manager = new ProviderManager({ [action]: { apiKey } });
      const results = await manager.testConnections();
      if (results[action as Provider]) {
        spinner.succeed(chalk.green(`${action} API key is valid!`));
      } else {
        spinner.fail(chalk.red(`${action} API key test failed`));
      }
    } catch {
      spinner.fail(chalk.red(`Failed to test ${action} connection`));
    }
  }
}

/**
 * Configure which model each agent uses
 */
async function configureAgentModels(): Promise<void> {
  const agentModels = config.get("agentModels") ?? {};

  const agents: AgentId[] = ["george", "cathy", "grace", "douglas", "kate"];
  const agentProviders: Record<AgentId, Provider> = {
    george: "openai",
    cathy: "anthropic",
    grace: "google",
    douglas: "deepseek",
    kate: "kimi",
  };

  for (const agentId of agents) {
    const provider = agentProviders[agentId];
    const models = getModelsByProvider(provider);
    const currentModel = agentModels[agentId] ?? DEFAULT_AGENTS[agentId].model;

    const modelChoices = models.map((m) => ({
      name: `${m.name} - ${m.description}`,
      value: m.id,
    }));

    const selectedModel = await select({
      message: `Select model for ${AGENT_AVATARS[agentId]} ${DEFAULT_AGENTS[agentId].name} (${provider}):`,
      choices: modelChoices,
      default: currentModel,
    });

    agentModels[agentId] = selectedModel;
  }

  config.set("agentModels", agentModels);
  console.log(chalk.green("✓ Agent models updated!"));
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
    console.log(chalk.red("\n⚠️  No API keys configured!"));
    console.log(chalk.yellow("Please configure at least one provider in Settings first.\n"));

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
  const topic = await input({
    message: "Enter a topic for the council to discuss:",
    validate: (value) => (value.length > 0 ? true : "Topic cannot be empty"),
  });

  // Configure council options
  const maxTurns = await select({
    message: "How many discussion turns?",
    choices: [
      { name: "Quick (5 turns)", value: 5 },
      { name: "Standard (10 turns)", value: 10 },
      { name: "Extended (20 turns)", value: 20 },
      { name: "Marathon (50 turns)", value: 50 },
    ],
    default: 10,
  });

  console.log(chalk.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.bold.white(`  📜 Topic: ${topic}`));
  console.log(chalk.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

  // Build agent configs with selected models
  const agentModels = config.get("agentModels") ?? {};
  const agents = { ...DEFAULT_AGENTS };
  for (const [agentId, model] of Object.entries(agentModels)) {
    if (agents[agentId as AgentId]) {
      agents[agentId as AgentId].model = model;
    }
  }

  // Create council
  const council = new Council(
    credentials as ProviderCredentials,
    { topic, maxTurns, autoMode: true },
    agents
  );

  // Track current streaming content
  let currentAgentContent = "";
  let currentAgentId: AgentId | null = null;

  // Set up event handling for group chat display
  council.onEvent((event: CouncilEvent) => {
    switch (event.type) {
      case "turn_started": {
        currentAgentId = event.agentId;
        currentAgentContent = "";
        const agent = DEFAULT_AGENTS[event.agentId];
        const color = AGENT_COLORS[event.agentId];
        const avatar = AGENT_AVATARS[event.agentId];
        process.stdout.write(color(`\n${avatar} ${agent.name}: `));
        break;
      }

      case "message_chunk": {
        if (event.agentId === currentAgentId) {
          process.stdout.write(event.content);
          currentAgentContent += event.content;
        }
        break;
      }

      case "message_complete": {
        console.log(); // New line after message
        const tokens = event.message.tokens;
        if (tokens) {
          console.log(
            chalk.gray(`  [${tokens.input}→${tokens.output} tokens, ${event.message.metadata?.latencyMs}ms]`)
          );
        }
        break;
      }

      case "bidding_complete": {
        // Could show bidding info in verbose mode
        break;
      }

      case "error": {
        const agentName = event.agentId ? DEFAULT_AGENTS[event.agentId].name : "System";
        console.log(chalk.red(`\n⚠️  Error from ${agentName}: ${event.error.message}`));
        break;
      }

      case "council_completed": {
        console.log(chalk.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
        console.log(chalk.bold.white("  🏁 Discussion Complete"));
        console.log(chalk.gray(`  Total turns: ${event.state.currentTurn}`));
        console.log(chalk.gray(`  Total messages: ${event.state.messages.length}`));
        console.log(chalk.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
        break;
      }
    }
  });

  // Start the discussion
  const spinner = ora("Starting council discussion...").start();
  try {
    spinner.stop();
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
        console.log(chalk.cyan("\n👋 Thank you for using Socratic Council!\n"));
        process.exit(0);
    }
  }
}

// Run the CLI
main().catch(console.error);
