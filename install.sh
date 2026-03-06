#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Socratic Council — Quick Install (macOS)
#
# Usage:
#   chmod +x install.sh && ./install.sh
#
# What it does:
#   1. Checks / installs every prerequisite (Xcode CLT, Homebrew,
#      Node.js 22+, pnpm, Rust stable)
#   2. Installs workspace dependencies
#   3. Builds the production .app bundle
#   4. Copies .app to /Applications
#   5. Cleans local build caches from the cloned repo
#   6. Opens the app
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colours / helpers ────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

info()  { printf "${BLUE}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[  OK]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[FAIL]${NC}  %s\n" "$*"; exit 1; }
step()  { printf "\n${BOLD}━━━ %s ━━━${NC}\n" "$*"; }

cleanup_local_build_artifacts() {
  local path=""
  local cleanup_paths=(
    "node_modules"
    ".pnpm-store"
    "apps/cli/node_modules"
    "apps/desktop/node_modules"
    "packages/core/node_modules"
    "packages/sdk/node_modules"
    "packages/shared/node_modules"
    "apps/cli/dist"
    "apps/desktop/dist"
    "packages/core/dist"
    "packages/sdk/dist"
    "packages/shared/dist"
    "apps/desktop/src-tauri/target"
  )

  for path in "${cleanup_paths[@]}"; do
    [[ -e "$path" ]] || continue
    rm -rf "$path"
  done
}

activate_homebrew() {
  local brew_bin=""

  if command -v brew &>/dev/null; then
    brew_bin="$(command -v brew)"
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    brew_bin="/opt/homebrew/bin/brew"
  elif [[ -x /usr/local/bin/brew ]]; then
    brew_bin="/usr/local/bin/brew"
  fi

  [[ -n "$brew_bin" ]] || return 1
  eval "$("$brew_bin" shellenv)"
}

PINNED_PNPM_VERSION="$(awk -F'"' '/"packageManager"/ {split($4, parts, "@"); print parts[2]; exit}' package.json)"
[[ -n "$PINNED_PNPM_VERSION" ]] || fail "Could not determine the pinned pnpm version from package.json."

# ── Require macOS ────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || fail "This script is macOS-only."

# Helper: compare semver "major.minor.patch" — returns 0 if $1 >= $2
ver_gte() {
  # Returns 0 (true) if version $1 >= $2
  printf '%s\n%s' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n -C
}

# ─────────────────────────────────────────────────────────────
# 1. PREREQUISITES
# ─────────────────────────────────────────────────────────────
step "1/7  Checking prerequisites"

# ── 1a. Xcode Command Line Tools ────────────────────────────
info "Checking Xcode Command Line Tools …"
if xcode-select -p &>/dev/null; then
  ok "Xcode CLT installed at $(xcode-select -p)"
else
  info "Installing Xcode Command Line Tools (this may open a dialog) …"
  xcode-select --install 2>/dev/null || true
  # Wait for the installation to finish
  until xcode-select -p &>/dev/null; do
    sleep 5
  done
  ok "Xcode CLT installed"
fi

# ── 1b. Homebrew ─────────────────────────────────────────────
info "Checking Homebrew …"
if activate_homebrew; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  info "Installing Homebrew …"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  activate_homebrew || fail "Homebrew installed, but the script could not add it to PATH."
  ok "Homebrew installed"
fi

# ── 1c. Node.js ≥ 22 ────────────────────────────────────────
REQUIRED_NODE_MAJOR=22

info "Checking Node.js (need ≥ ${REQUIRED_NODE_MAJOR}) …"
INSTALL_NODE=false

if command -v node &>/dev/null; then
  CURRENT_NODE="$(node -v | sed 's/^v//')"
  CURRENT_NODE_MAJOR="${CURRENT_NODE%%.*}"
  if (( CURRENT_NODE_MAJOR >= REQUIRED_NODE_MAJOR )); then
    ok "Node.js v${CURRENT_NODE}"
  else
    warn "Node.js v${CURRENT_NODE} is below v${REQUIRED_NODE_MAJOR} — will upgrade"
    INSTALL_NODE=true
  fi
else
  warn "Node.js not found — will install"
  INSTALL_NODE=true
fi

if $INSTALL_NODE; then
  info "Installing Node.js ${REQUIRED_NODE_MAJOR} via Homebrew …"
  brew install node@${REQUIRED_NODE_MAJOR}
  # Link if not already linked
  brew link --overwrite node@${REQUIRED_NODE_MAJOR} 2>/dev/null || true
  # Verify
  if ! command -v node &>/dev/null; then
    # Add Homebrew node to PATH for this session
    export PATH="/opt/homebrew/opt/node@${REQUIRED_NODE_MAJOR}/bin:$PATH"
    export PATH="/usr/local/opt/node@${REQUIRED_NODE_MAJOR}/bin:$PATH"
  fi
  CURRENT_NODE="$(node -v | sed 's/^v//')"
  ok "Node.js v${CURRENT_NODE} installed"
fi

# ── 1d. pnpm ─────────────────────────────────────────────────
# The repo pins pnpm via the packageManager field. We need that exact version
# so the workspace install and Tauri beforeBuildCommand both resolve the same
# toolchain on a clean clone.

info "Checking pnpm (need v${PINNED_PNPM_VERSION}) …"
if command -v pnpm &>/dev/null; then
  PNPM_VER="$(pnpm -v 2>/dev/null || echo "none")"
  if [[ "$PNPM_VER" == "$PINNED_PNPM_VERSION" ]]; then
    ok "pnpm v${PNPM_VER}"
  else
    warn "pnpm v${PNPM_VER} does not match pinned v${PINNED_PNPM_VERSION} — will replace it"
  fi
fi

if ! command -v pnpm &>/dev/null || [[ "${PNPM_VER:-none}" != "$PINNED_PNPM_VERSION" ]]; then
  if ! command -v corepack &>/dev/null; then
    info "corepack not found — installing via npm …"
    npm install -g --force corepack 2>/dev/null || sudo npm install -g --force corepack
  fi

  if command -v corepack &>/dev/null; then
    COREPACK_BIN="$(command -v corepack)"
    "$COREPACK_BIN" enable 2>/dev/null || sudo "$COREPACK_BIN" enable 2>/dev/null || true
    "$COREPACK_BIN" prepare "pnpm@${PINNED_PNPM_VERSION}" --activate 2>/dev/null || \
      sudo "$COREPACK_BIN" prepare "pnpm@${PINNED_PNPM_VERSION}" --activate 2>/dev/null || true
  fi

  PNPM_VER="$(pnpm -v 2>/dev/null || echo "none")"
  if [[ "$PNPM_VER" != "$PINNED_PNPM_VERSION" ]]; then
    info "Installing pinned pnpm via npm …"
    npm install -g "pnpm@${PINNED_PNPM_VERSION}" 2>/dev/null || sudo npm install -g "pnpm@${PINNED_PNPM_VERSION}"
    export PATH="$(npm prefix -g)/bin:$PATH"
    hash -r
  fi

  PNPM_VER="$(pnpm -v 2>/dev/null || echo "none")"
  [[ "$PNPM_VER" == "$PINNED_PNPM_VERSION" ]] || fail "Could not install pnpm v${PINNED_PNPM_VERSION}. Check your Node.js installation."
  ok "pnpm v${PNPM_VER} installed"
fi

# ── 1e. Rust (stable ≥ 1.77.2) ──────────────────────────────
REQUIRED_RUST="1.77.2"

info "Checking Rust (need stable ≥ ${REQUIRED_RUST}) …"
INSTALL_RUST=false

if command -v rustc &>/dev/null; then
  CURRENT_RUST="$(rustc -V | awk '{print $2}')"
  if ver_gte "$CURRENT_RUST" "$REQUIRED_RUST"; then
    ok "Rust ${CURRENT_RUST}"
  else
    warn "Rust ${CURRENT_RUST} is below ${REQUIRED_RUST} — will update"
    INSTALL_RUST=true
  fi
else
  warn "Rust not found — will install"
  INSTALL_RUST=true
fi

if $INSTALL_RUST; then
  if command -v rustup &>/dev/null; then
    info "Updating Rust via rustup …"
    rustup update stable
  else
    info "Installing Rust via rustup …"
    curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  CURRENT_RUST="$(rustc -V | awk '{print $2}')"
  ok "Rust ${CURRENT_RUST} installed"
fi

# ── 1f. Summary ──────────────────────────────────────────────
step "Prerequisite summary"
printf "  %-18s %s\n" "Xcode CLT:" "$(xcode-select -p)"
printf "  %-18s %s\n" "Homebrew:" "$(brew --version | head -1 | awk '{print $2}')"
printf "  %-18s %s\n" "Node.js:" "$(node -v)"
printf "  %-18s %s\n" "pnpm:" "$(pnpm -v 2>/dev/null || echo 'will auto-fetch')"
printf "  %-18s %s\n" "Rust:" "$(rustc -V | awk '{print $2}')"
printf "  %-18s %s\n" "Cargo:" "$(cargo -V | awk '{print $2}')"

# ─────────────────────────────────────────────────────────────
# 2. INSTALL WORKSPACE DEPENDENCIES
# ─────────────────────────────────────────────────────────────
step "2/7  Installing workspace dependencies"
pnpm install --force --frozen-lockfile
ok "Dependencies installed"

# ─────────────────────────────────────────────────────────────
# 3. BUILD PRODUCTION APP
# ─────────────────────────────────────────────────────────────
step "3/7  Building production desktop app (this may take 10-30 min on first run)"
pnpm --filter @socratic-council/desktop exec tauri build --bundles app
ok "Production app bundle complete"

# ─────────────────────────────────────────────────────────────
# 4. LOCATE BUILD ARTIFACTS
# ─────────────────────────────────────────────────────────────
step "4/7  Locating app bundle"

BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"
APP_PATH="$(find "${BUNDLE_DIR}/macos" -name '*.app' -maxdepth 1 -type d 2>/dev/null | head -1)"

if [[ -n "$APP_PATH" ]]; then
  ok ".app found: ${APP_PATH}"
else
  fail "No .app found in ${BUNDLE_DIR}. Build may have failed."
fi

# ─────────────────────────────────────────────────────────────
# 5. INSTALL TO /Applications
# ─────────────────────────────────────────────────────────────
step "5/7  Installing to /Applications"

APP_NAME="Socratic Council.app"
DEST="/Applications/${APP_NAME}"

if [[ -d "$DEST" ]]; then
  warn "Removing existing ${DEST} …"
  rm -rf "$DEST"
fi

info "Copying .app to /Applications …"
ditto "$APP_PATH" "$DEST"
ok "Installed: ${DEST}"

step "6/7  Cleaning local build caches"
cleanup_local_build_artifacts
ok "Removed workspace dependencies and build artifacts from the cloned repo"

# ─────────────────────────────────────────────────────────────
# 7. OPEN THE APP
# ─────────────────────────────────────────────────────────────
step "7/7  Launching Socratic Council"

if [[ -d "$DEST" ]]; then
  open "$DEST"
  ok "App launched!"
else
  fail "Installation not found at ${DEST}"
fi

# ── Done ─────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}✅  Socratic Council installed and running!${NC}\n"
printf "    Location: ${DEST}\n"
printf "    To re-open: ${BOLD}open \"/Applications/Socratic Council.app\"${NC}\n\n"
