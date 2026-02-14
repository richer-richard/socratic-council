![Socratic Council App Icon](apps/desktop/src-tauri/app-icon.png)

# Socratic Council

Socratic Council is a local‑first desktop app that runs a five‑agent “seminar” on any topic. You provide one or more AI provider API keys, type a topic, and watch five agents discuss it in a turn‑taking group chat. The app includes search, quoting, export, conflict visualization, and token/cost tracking.

This repository is a monorepo:

- Desktop app: `apps/desktop` (Tauri v2 + React)
- CLI app: `apps/cli`
- Shared types/constants/model registry: `packages/shared`
- Provider SDK: `packages/sdk`
- Orchestration logic: `packages/core`

Socratic Council is not published to Homebrew, npm, or an app store. macOS installers are published on GitHub Releases; otherwise (and for developers), clone the repo and build from source.

## Table of contents

- [What this is](#what-this-is)
- [What you can do](#what-you-can-do)
- [Installation](#installation)
  - [Download (macOS release)](#download-macos-release)
  - [Quick install (copy/paste)](#quick-install-copypaste)
  - [Prerequisites](#prerequisites)
  - [macOS prerequisites](#macos-prerequisites)
  - [Windows prerequisites](#windows-prerequisites)
  - [Linux prerequisites](#linux-prerequisites)
  - [Build the desktop bundle](#build-the-desktop-bundle)
  - [Install and run](#install-and-run)
  - [Update to a newer version](#update-to-a-newer-version)
  - [Uninstall](#uninstall)
- [First run setup](#first-run-setup)
  - [API keys](#api-keys)
  - [Models](#models)
  - [Proxy](#proxy)
  - [Preferences](#preferences)
- [Using the app](#using-the-app)
  - [Home screen](#home-screen)
  - [Chat screen](#chat-screen)
  - [Pause, resume, stop](#pause-resume-stop)
  - [Search](#search)
  - [Export](#export)
  - [Logs](#logs)
- [How the conversation works](#how-the-conversation-works)
  - [Council members and providers](#council-members-and-providers)
  - [Turn selection (bidding)](#turn-selection-bidding)
  - [Conflict detection and conflict focus](#conflict-detection-and-conflict-focus)
  - [Moderator agent](#moderator-agent)
  - [Markdown, math, and code](#markdown-math-and-code)
  - [Quotes and reactions](#quotes-and-reactions)
  - [Tool calling (oracle)](#tool-calling-oracle)
  - [Tokens and cost tracking](#tokens-and-cost-tracking)
- [Export reference](#export-reference)
  - [File naming and save behavior](#file-naming-and-save-behavior)
  - [Markdown export](#markdown-export)
  - [JSON export schema](#json-export-schema)
  - [PDF export layout](#pdf-export-layout)
  - [DOCX export](#docx-export)
  - [PPTX export](#pptx-export)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributor guide](#contributor-guide)
  - [Repo scripts](#repo-scripts)
  - [Desktop development](#desktop-development)
  - [CLI development](#cli-development)
- [License](#license)

## What this is

Socratic Council is a desktop application that:

- Runs a multi‑agent group discussion in a single chat timeline
- Uses real provider APIs (you bring keys)
- Shows lightweight signals about who is speaking, how much the discussion costs, and where disagreement is strongest
- Lets you search the conversation and export it into shareable formats

What it is not:

- Not a hosted SaaS service
- Not an “install from a package manager” app at the moment
- Not a single‑agent chatbot (it is explicitly multi‑agent)

## What you can do

Core features in the desktop app:

- Start a discussion with five agents: George, Cathy, Grace, Douglas, Kate
- Configure API keys, base URLs, models, and a global proxy per provider
- See turn selection (“bidding”) scores (optional)
- See a conflict graph that visualizes pairwise tension signals
- See a “cost ledger” with per‑agent token usage and estimated spend
- Search the transcript and jump to matches
- Copy quote tokens for agents to reference specific prior messages
- Export to Markdown, JSON, PDF, DOCX, or PPTX

## Installation

Socratic Council is not distributed through an app store or package manager.

### Download (macOS release)

1. Open the Releases page:
   https://github.com/richer-richard/socratic-council-of-five/releases/latest
2. Download the DMG that matches your Mac:
   - Apple Silicon (arm64): `Socratic.Council_0.1.0_aarch64.dmg`
   - Intel (x64): `Socratic.Council_0.1.0_x64.dmg`
3. Open the DMG and drag `Socratic Council.app` into `/Applications`.
4. First launch: releases are not notarized yet. If macOS blocks the app, right-click it in Finder → Open → Open.

Optional: remove the quarantine attribute:

```bash
xattr -dr com.apple.quarantine "/Applications/Socratic Council.app"
```

If you are on Windows/Linux, or you prefer to build from source, use the steps below.

The build is safe and standard for a Tauri app:

- Frontend: Vite builds the React UI
- Backend: Rust builds the Tauri shell
- Output: a DMG/MSI/AppImage bundle depending on your OS

### Quick install (copy/paste)

If you're building from source, this is the flow most people should use:

```bash
git clone https://github.com/richer-richard/socratic-council-of-five.git
cd socratic-council-of-five
pnpm install
pnpm --filter @socratic-council/desktop tauri:build
```

After the build completes, install the output:

- macOS: open the DMG in `apps/desktop/src-tauri/target/release/bundle/dmg/`
- Windows: run the MSI in `apps/desktop/src-tauri/target/release/bundle/msi/`
- Linux: run the AppImage in `apps/desktop/src-tauri/target/release/bundle/appimage/`

If you hit a build error, read [Troubleshooting](#troubleshooting) and the OS prerequisites sections below.

### Prerequisites

You need these installed before building:

- Git
- Node.js 22+ (this repo targets Node 22)
- pnpm 9+ (recommended: use Corepack to match the repo’s pinned pnpm version)
- Rust toolchain (stable)
- Tauri v2 OS dependencies

Quick version checks:

```bash
git --version
node -v
pnpm -v
rustc -V
cargo -V
```

#### pnpm via Corepack (recommended)

This repo declares a pnpm version in `package.json` (`"packageManager": "pnpm@9.15.0"`). The most reliable way to match it is to use Corepack (ships with modern Node).

Run:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v
```

If your Node install does not include Corepack, install pnpm using the official pnpm installation guide: https://pnpm.io/installation

### macOS prerequisites

1. Install Apple Command Line Tools:

```bash
xcode-select --install
```

2. Install Node.js 22+ from https://nodejs.org/ (use the macOS installer).

3. Enable pnpm via Corepack (recommended):

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

4. Install Rust from https://rustup.rs/ (this is the standard rustup installer).

5. Confirm versions:

```bash
node -v
pnpm -v
rustc -V
```

Notes:

- Building produces an unsigned app bundle by default. macOS Gatekeeper may warn when you launch it. See [Troubleshooting](#troubleshooting).

### Windows prerequisites

Windows builds require a working Rust + MSVC toolchain and the Tauri prerequisites.

1. Install Git for Windows: https://git-scm.com/download/win

2. Install Node.js 22+ from https://nodejs.org/

3. Enable pnpm via Corepack (PowerShell):

```powershell
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v
```

4. Install Rust from https://rustup.rs/ (choose the stable toolchain).

5. Install Visual Studio 2022 Build Tools (or full Visual Studio) with “Desktop development with C++”.

6. Install WebView2 (usually already present on Windows 11, but required for Tauri).

Notes:

- If you see linker/compiler errors, it almost always means the C++ build tools or Windows SDK are missing.
- If Windows SmartScreen warns about running the MSI, that is expected for unsigned builds.

### Linux prerequisites

Linux builds require standard build tools plus WebKitGTK development packages. Exact package names differ by distro.

Start with Tauri’s official prerequisites page:

https://tauri.app/v2/guides/getting-started/prerequisites/

Common examples:

Debian/Ubuntu (example only; adjust to your distro/version):

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  librsvg2-dev
```

Fedora (example only):

```bash
sudo dnf install -y \
  gcc gcc-c++ make pkgconf-pkg-config \
  openssl-devel \
  webkit2gtk4.1-devel \
  gtk3-devel \
  librsvg2-devel
```

Arch (example only):

```bash
sudo pacman -S --needed \
  base-devel pkgconf \
  openssl \
  webkit2gtk-4.1 \
  gtk3 \
  librsvg
```

Then install Node 22+, enable pnpm via Corepack, and install Rust.

### Build the desktop bundle

From the repo root:

```bash
pnpm install
pnpm --filter @socratic-council/desktop tauri:build
```

Build output folder:

`apps/desktop/src-tauri/target/release/bundle/`

Typical outputs:

- macOS: `apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg`
- Windows: `apps/desktop/src-tauri/target/release/bundle/msi/*.msi`
- Linux: `apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage`

### Install and run

macOS:

1. Open the DMG:

```bash
open apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
```

2. Drag “Socratic Council.app” to Applications
3. Launch it from Applications

Windows:

1. Run the MSI from `apps/desktop/src-tauri/target/release/bundle/msi/`
2. Launch “Socratic Council” from the Start Menu

Linux:

1. Run the AppImage:

```bash
chmod +x apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
./apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
```

### Update to a newer version

If you already cloned the repo and want to update:

```bash
cd socratic-council-of-five
git pull
pnpm install
pnpm --filter @socratic-council/desktop tauri:build
```

Then reinstall the newly produced DMG/MSI/AppImage.

### Uninstall

macOS:

- Delete `/Applications/Socratic Council.app`

Windows:

- Uninstall from “Apps & features”

Linux:

- Delete the AppImage file you ran

Settings and keys are stored locally. If you want to fully reset settings, see [FAQ](#faq) and [Troubleshooting](#troubleshooting).

## First run setup

Socratic Council requires at least one provider API key before it can start a discussion.

Open the app, click Settings, and configure:

- API Keys (required)
- Models (recommended)
- Proxy (optional)
- Preferences (optional)

### API keys

Steps:

1. Open Settings
2. Go to the API Keys tab
3. Enter an API key for one or more providers
4. Optionally click Test to verify connectivity

Providers shown in the desktop app:

- OpenAI
- Anthropic
- Google
- DeepSeek
- Moonshot (the provider id in code is `kimi`; the API key label in Settings is “Kimi”)

Important behavior:

- Each council member is tied to a provider. If you do not configure a provider, that agent will not participate (their bid score becomes 0).
- You can run the app with only one provider configured, but you will have fewer active agents.

### Models

In Settings → Models, you can select which model each provider uses.

Defaults (as shipped in the desktop app):

- OpenAI: `gpt-5.2`
- Anthropic: `claude-opus-4-6`
- Google: `gemini-3-pro-preview`
- DeepSeek: `deepseek-reasoner`
- Moonshot: `kimi-k2.5`

If you are unsure which model to pick, start with the defaults, then experiment.

### Proxy

The desktop app supports a single global proxy setting that applies to all providers.

Proxy types:

- `http`
- `https`
- `socks5`
- `socks5h`

To configure:

1. Settings → Proxy
2. Choose a proxy type
3. Enter host + port
4. Optionally enter username/password

If you are behind a corporate network, start by setting the proxy and then use the Test buttons in API Keys to confirm requests can reach each provider.

### Preferences

Settings → Preferences includes:

- Show Bidding Scores (shows per‑round bid scores)
- Auto‑scroll Messages
- Sound Effects
- Moderator Agent (adds occasional moderator notes)
- Default Discussion Length (Quick/Standard/Extended/Marathon/Custom)

Custom discussion length:

- If set to Custom and turns = 0, the discussion is unlimited until you press Stop.

## Using the app

### Home screen

On the home screen:

1. Enter a topic in the input box
2. Or click one of the suggested topics
3. Click Start

If you did not configure any API keys yet, the app will warn you and prompt you to open Settings.

### Chat screen

The chat screen is the main experience. It has:

- A header with the current turn count, token usage, and cost estimate (if available)
- Controls for Logs, Search, and Export
- Pause/Resume and Stop controls while the discussion is running
- The message timeline
- A right-side panel with:
  - Council Members (who is configured and who is currently speaking)
  - Conflict Graph (pairwise tension)
  - Bidding Round (optional, if enabled)
  - Cost Ledger (tokens and estimated spend)
  - Summary (after the discussion stops)

### Pause, resume, stop

While a discussion is running:

- Pause: aborts in‑flight requests and stops further turns until you resume
- Resume: continues the discussion
- Stop: ends the discussion

Pausing also removes incomplete streaming messages that were still being generated.

### Search

Search is a side panel view that lets you:

- Type one or more terms
- See matches in message content and speaker label
- Jump to each match in the message timeline

Search behavior (exact):

- Case-insensitive
- All terms must match (logical AND)
- Searches both the speaker label and the message content

### Export

Export is a side panel view that lets you:

- Choose a format (Markdown, JSON, PDF, DOCX, PPTX)
- Choose a file name
- Toggle “Include tokens” and “Include cost”

Notes:

- On desktop builds, export uses the native save dialog and writes to the chosen path.
- In a browser/dev fallback, export triggers a download.

### Logs

Logs show recent provider/API activity:

- Provider name
- Timestamp
- Message
- Error/warning indicators

Logs are useful for diagnosing:

- Missing keys
- Network/proxy issues
- Provider timeouts

## How the conversation works

### Council members and providers

The five council members and their default providers:

- George: OpenAI
- Cathy: Anthropic
- Grace: Google
- Douglas: DeepSeek
- Kate: Moonshot (provider id `kimi`)

Important: in the desktop app, these are neutral agents by default (not “roleplay personas”). They follow shared guidelines for short, direct, group‑chat style responses unless you modify the code.

### Turn selection (bidding)

Socratic Council selects the next speaker using a “bidding” system. Each eligible agent gets a score, and the highest score speaks next.

The score is influenced by:

- Random base score (to keep the discussion from being deterministic)
- Fairness adjustment (agents who have spoken less get a small boost)
- Engagement “debts” (agents who were directly addressed get priority)
- Conflict focus bonus (during a conflict focus period)

If a provider is not configured (no API key), that agent’s bid is forced to 0.

If you enable “Show Bidding Scores” in Settings → Preferences, you will see the per‑round scores in the side panel.

### Conflict detection and conflict focus

The app computes heuristic tension scores between pairs of agents. It renders these as a pentagon “conflict graph”:

- Each node is an agent
- Each edge is a pairwise tension score
- Color shifts from blue (low) to red (high)
- Width increases with stronger tension

When the app detects a strong conflict pair, it enters a short “Conflict Focus” period:

- A badge appears in the header: “Conflict Focus · N turns”
- For the next few turns (currently 3), the bidding system nudges the conflicting pair to respond
- The conflict focus ends automatically after those turns

Conflict scores are heuristic signals. They are designed as a “vibe check”, not a factual truth detector.

### Moderator agent

If you enable the Moderator Agent (Settings → Preferences), the app occasionally inserts brief moderator notes:

- An opening message at the start of the discussion
- A short note when strong tension is detected

The Moderator is generated by whichever configured provider is available first in this order:

1. OpenAI
2. Anthropic
3. Google
4. DeepSeek
5. Moonshot

If none of the providers are configured, the Moderator will not appear.

### Markdown, math, and code

Messages support Markdown rendering, including:

- GitHub Flavored Markdown (tables, links, code blocks)
- Hard line breaks
- LaTeX math (inline `$...$` and block `$$...$$`)
- Syntax highlighting for fenced code blocks

In practice:

- Most messages are plain text
- Markdown is best used for equations, short code snippets, and tables

### Quotes and reactions

The app supports quote and reaction actions.

Quote tokens:

- Agents can include `@quote(MSG_ID)` in their message text.
- The app parses these tokens and renders quoted message blocks above the message body.
- The UI includes a Quote button on each message that copies an `@quote(...)` token to your clipboard.

Reaction tokens:

- Agents can include `@react(MSG_ID, EMOJI)` where `EMOJI` is one of the supported reactions.
- The UI also lets you react manually using the React button.

Supported reactions (as used by the app):

- 👍 👎 ❤️ 😂 😮 😢 😡 ✨ 🎉

### Tool calling (oracle)

Agents can optionally call tools using a simple inline syntax:

```text
@tool(oracle.search, {"query":"..."})
```

Available tools:

- `oracle.search`: web search
- `oracle.verify`: verify a factual claim against search evidence
- `oracle.cite`: produce citations/snippets for a topic

How tool results appear:

- Tool results are injected back into the conversation as “Tool result (...)” text.
- Example:

```text
Tool result (oracle.search): No results found.
```

This is not an error by itself; it means the tool call returned an empty result set.

Tool limits:

- Tool calls have a short timeout (currently 12 seconds)
- Results are capped (currently up to 5 items)

### Tokens and cost tracking

The app tracks:

- Input tokens (prompt tokens)
- Output tokens (completion tokens)
- Estimated USD cost (when pricing information is available for the model)

Where you see this:

- Header badges: total tokens and total cost (if available)
- Side panel: “Cost Ledger” showing per‑agent token totals and per‑agent cost

Cost precision:

- Costs display with 4 digits after the decimal point (example: `$0.1234`)

If cost shows as “Pricing not configured” or “Cost N/A”:

- It means the model registry does not have pricing data for the selected model, or the provider response did not include token usage.

## Export reference

### File naming and save behavior

Export uses a base file name plus an extension:

- Markdown: `.md`
- PDF: `.pdf`
- DOCX: `.docx`
- PPTX: `.pptx`
- JSON: `.json`

On desktop builds:

- Export opens a native Save dialog
- The app writes the file to the selected path

In a browser/dev fallback:

- Export triggers a download instead of writing to the file system

### Markdown export

Markdown export is a plain text transcript:

- Title header
- Topic and exported timestamp
- Per message: speaker, optional model, local time, and content
- Optional token and cost lines

### JSON export schema

JSON export includes:

- `exportedAt`: ISO timestamp
- `topic`: string
- `messages`: array

Message fields (current desktop export):

- `id`: string
- `agentId` (optional): string (e.g., `george`, `cathy`, `system`)
- `speaker`: display name
- `model` (optional): display model name
- `timestamp`: number (milliseconds since epoch)
- `content`: string
- `tokens` (optional): `{ input, output, reasoning? }`
- `costUSD` (optional): number or null

Example (shortened):

```json
{
  "exportedAt": "2026-02-13T16:23:52.000Z",
  "topic": "Is privacy more important than security?",
  "messages": [
    {
      "id": "msg_...",
      "agentId": "george",
      "speaker": "George",
      "model": "GPT-5.2",
      "timestamp": 1760370000000,
      "content": "I think the tradeoff is framed incorrectly...",
      "tokens": { "input": 512, "output": 148 },
      "costUSD": 0.0123
    }
  ]
}
```

### PDF export layout

The PDF export is designed to be shareable and readable. It includes:

Cover page:

- Title (two lines)
- Topic
- Exported timestamp (UTC)
- Summary cards (messages, speakers, tokens)

Charts:

- Messages by speaker (bar chart)
- Cost ledger (separate box, below the speaker chart)

Transcript:

- Messages rendered as card blocks with a colored accent strip per speaker
- Optional per-message token and cost metadata line

Conflict graph:

- Appends a final page with a pentagon-style conflict graph and a “Top tensions” list

### DOCX export

DOCX export is intended for editing and sharing:

- Cover-style header (with app icon if available)
- Summary table
- Speaker distribution table
- Transcript blocks with headings and spacing

### PPTX export

PPTX export is intended for presentations:

- Title slide
- Snapshot slide (message counts, speaker chart)
- Transcript slides (chunked into multiple slides)

## Privacy and security

Socratic Council is designed to be local-first:

- There is no central server component in this repo that stores your conversations.
- Provider requests are sent from your machine to the provider endpoints you configure.

API keys:

- Desktop app: stored locally in the app’s webview storage (similar to browser localStorage).
- CLI app: stored locally in your user config directory.

Tool calling:

- The oracle tool performs web requests (search/verification/citations). If you enable tool calling in practice (agents may call it), your machine will make web requests for those queries.

Exports:

- Exported files are written to your local file system at the path you choose.

You are responsible for:

- Keeping your API keys secure
- Not exporting/sharing sensitive transcripts unintentionally

## Troubleshooting

This section is intentionally detailed. If you are stuck, search within this README first.

### Build fails immediately

Checklist:

- Node is 22+: `node -v`
- pnpm is installed and matches the repo: `pnpm -v`
- Rust is installed: `rustc -V`
- You installed Tauri OS prerequisites

If `pnpm install` fails:

- Re-run with a clean install
- Check that you are in the repo root (same folder as `pnpm-workspace.yaml`)

If `pnpm --filter @socratic-council/desktop tauri:build` fails:

- Scroll up to the first error in the output
- Common causes: missing OS prerequisites, missing C++ toolchain on Windows, missing WebKitGTK dev packages on Linux

### macOS: “app is damaged” / Gatekeeper warnings

Unsigned local builds may trigger Gatekeeper.

Try:

1. Right-click the app in Applications
2. Click Open
3. Confirm the prompt

If you cannot open it, check System Settings → Privacy & Security for an “Open Anyway” button.

### Windows: MSVC / linker errors

If you see errors mentioning `link.exe`, “MSVC”, or missing Windows SDK:

- Install Visual Studio Build Tools
- Ensure “Desktop development with C++” is selected
- Ensure a Windows 10/11 SDK is installed

### Linux: missing WebKitGTK / GTK errors

If you see errors mentioning WebKitGTK, GTK, or pkg-config:

- Install the Linux prerequisites listed in the Tauri docs for your distro
- Ensure `pkg-config` is installed

### “No API key configured for …”

This means the provider for that agent has no API key in Settings → API Keys.

Fix:

- Add the key
- Optionally test the connection
- Start a new discussion

### Provider test fails

Try in this order:

1. Double-check the API key is correct (no extra spaces)
2. If you changed base URL, reset it to default and try again
3. If you are behind a proxy, configure Settings → Proxy and try again
4. Check Logs for the provider’s error message

### Tool result says “No results found”

This message is produced by the oracle tool when a search returns an empty result set.

It can happen when:

- The query is too narrow
- The network blocks the search request
- The search provider returns no results

### Export fails or does nothing

Export behavior depends on environment:

- Desktop app: opens a native save dialog
- Browser/dev fallback: downloads a file

If export fails in the desktop app:

- Check Logs for errors
- Try exporting a simpler format (Markdown or JSON) first
- Verify you can write to the selected folder

## FAQ

### Is there a downloadable release?

Yes — macOS installers are published on GitHub Releases:

https://github.com/richer-richard/socratic-council-of-five/releases

Download the DMG that matches your Mac (Apple Silicon `*_aarch64.dmg`, Intel `*_x64.dmg`).

Windows/Linux users: build from source for now.

### Where are my API keys stored?

Desktop app:

- Stored locally in the app’s webview storage (similar to browser localStorage).
- Keys are not sent to a Socratic Council server because there is no such server in this repo.

CLI:

- Stored locally in your user config directory via the `conf` package.

### Does the app save my conversations?

The desktop app keeps the current conversation in memory while it runs. To keep a transcript, use Export.

### Can I change which provider each agent uses?

In the desktop app, each agent is associated with a provider (George/OpenAI, Cathy/Anthropic, etc.). You can change the model for each provider, but not the provider mapping without changing the code.

### Why does the Moonshot provider show up as “Kimi” in some places?

Internally, the provider id is `kimi` (historical naming). In the desktop UI:

- Provider display name on the home screen is “Moonshot”.
- API key label in Settings is “Kimi”.

### How do I reset all settings?

Because settings are stored locally, the simplest reset is:

1. Close the app
2. Clear the app’s local storage / application data for Socratic Council (method varies by OS)
3. Reopen the app and re-enter keys

If you want, open an issue and we can add a “Reset settings” button in the UI.

## Contributor guide

This section is for people modifying the code.

### Repo scripts

From the repo root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Useful desktop-specific commands:

```bash
pnpm --filter @socratic-council/desktop lint
pnpm --filter @socratic-council/desktop build
pnpm --filter @socratic-council/desktop tauri:dev
pnpm --filter @socratic-council/desktop tauri:build
```

### Desktop development

Run the desktop app in dev mode:

```bash
pnpm --filter @socratic-council/desktop tauri:dev
```

If you see errors importing workspace packages (`@socratic-council/shared`, `@socratic-council/core`, etc.), build the workspace packages first:

```bash
pnpm build
```

Then re-run `tauri:dev`.

### CLI development

Build and run the CLI from source:

```bash
pnpm --filter @socratic-council/cli build
node apps/cli/dist/index.js
```

The CLI can also be run in watch mode:

```bash
pnpm --filter @socratic-council/cli dev
```

## License

Apache-2.0. See `LICENSE`.
