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
#   2. Installs workspace dependencies (pnpm install)
#   3. Builds the production Tauri app (tauri:build)
#   4. Mounts the DMG, copies .app to /Applications, ejects
#   5. Opens the app
# ──────────────────────────────────────────────────────────────
set -euo pipefail

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
if command -v brew &>/dev/null; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  info "Installing Homebrew …"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
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

# ── 1d. Corepack + pnpm ─────────────────────────────────────
info "Enabling corepack …"
corepack enable 2>/dev/null || sudo corepack enable
ok "Corepack enabled"

# pnpm version is pinned by the repo's packageManager field — corepack handles it.
# We just verify it works.
info "Checking pnpm (version pinned to 9.15.0 by repo) …"
PNPM_VER="$(pnpm -v 2>/dev/null || echo "none")"
if [[ "$PNPM_VER" == "none" ]]; then
  warn "pnpm not responding — corepack will fetch it on first use"
else
  ok "pnpm v${PNPM_VER}"
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
step "2/7  Installing workspace dependencies (pnpm install)"
pnpm install
ok "Dependencies installed"

# ─────────────────────────────────────────────────────────────
# 3. BUILD PRODUCTION APP
# ─────────────────────────────────────────────────────────────
step "3/7  Building production desktop app (this may take 10-30 min on first run)"
pnpm --filter @socratic-council/desktop tauri:build
ok "Production build complete"

# ─────────────────────────────────────────────────────────────
# 4. LOCATE BUILD ARTIFACTS
# ─────────────────────────────────────────────────────────────
step "4/7  Locating build artifacts"

BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"

# Find the DMG
DMG_PATH="$(find "${BUNDLE_DIR}/dmg" -name '*.dmg' -type f 2>/dev/null | head -1)"
# Find the .app (fallback if DMG isn't available)
APP_PATH="$(find "${BUNDLE_DIR}/macos" -name '*.app' -maxdepth 1 -type d 2>/dev/null | head -1)"

if [[ -n "$DMG_PATH" ]]; then
  ok "DMG found: ${DMG_PATH}"
elif [[ -n "$APP_PATH" ]]; then
  ok ".app found: ${APP_PATH}"
else
  fail "No .dmg or .app found in ${BUNDLE_DIR}. Build may have failed."
fi

# ─────────────────────────────────────────────────────────────
# 5. INSTALL TO /Applications
# ─────────────────────────────────────────────────────────────
step "5/7  Installing to /Applications"

APP_NAME="Socratic Council.app"
DEST="/Applications/${APP_NAME}"

if [[ -n "$DMG_PATH" ]]; then
  info "Mounting DMG …"

  # Mount and capture the mount point
  MOUNT_OUTPUT="$(hdiutil attach "$DMG_PATH" -nobrowse -noverify 2>&1)"
  MOUNT_POINT="$(echo "$MOUNT_OUTPUT" | grep '/Volumes/' | awk -F'\t' '{print $NF}' | head -1)"

  if [[ -z "$MOUNT_POINT" ]]; then
    fail "Failed to mount DMG. Output:\n${MOUNT_OUTPUT}"
  fi
  ok "Mounted at: ${MOUNT_POINT}"

  # Find the .app inside the mounted DMG
  DMG_APP="$(find "$MOUNT_POINT" -name '*.app' -maxdepth 1 -type d | head -1)"
  if [[ -z "$DMG_APP" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    fail "No .app found inside the mounted DMG."
  fi

  # Remove existing installation if present
  if [[ -d "$DEST" ]]; then
    warn "Removing existing ${DEST} …"
    rm -rf "$DEST"
  fi

  info "Copying to /Applications …"
  cp -R "$DMG_APP" "/Applications/"
  ok "Installed: ${DEST}"

  # ── 6. EJECT ───────────────────────────────────────────────
  step "6/7  Ejecting DMG"
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || hdiutil detach "$MOUNT_POINT" -force 2>/dev/null || true
  ok "DMG ejected"

elif [[ -n "$APP_PATH" ]]; then
  # Direct .app copy (no DMG to eject)
  if [[ -d "$DEST" ]]; then
    warn "Removing existing ${DEST} …"
    rm -rf "$DEST"
  fi

  info "Copying .app to /Applications …"
  cp -R "$APP_PATH" "/Applications/"
  ok "Installed: ${DEST}"

  step "6/7  Eject (skipped — no DMG)"
  ok "Nothing to eject"
fi

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
