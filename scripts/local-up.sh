#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

info() { echo "[local-up] $*"; }
warn() { echo "[local-up] WARNING: $*"; }
err() { echo "[local-up] ERROR: $*"; }

if [[ "${1:-}" = "-h" || "${1:-}" = "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/local-up.sh

What it does:
  1) Ensures Homebrew is available (macOS)
  2) Installs Node + MySQL via brew when missing
  3) Ensures Xcode Command Line Tools are installed (for building Pikafish)
  4) Installs npm deps
  5) Best-effort builds Pikafish (optional)
  6) Starts mysql + backend + frontend (same as npm run dev:local)
EOF
  exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "${OS}" != "Darwin" ]]; then
  warn "This bootstrap currently targets macOS + Homebrew. Continuing anyway..."
fi

if [[ "${OS}" = "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    err "Homebrew not found. Install it first: https://brew.sh/"
    exit 1
  fi

  info "Ensuring Node.js is installed (brew)"
  if ! command -v node >/dev/null 2>&1; then
    brew install node
  fi

  info "Ensuring MySQL is installed (brew)"
  if ! command -v mysql >/dev/null 2>&1; then
    brew install mysql
  fi

  # Pikafish build needs toolchain (clang/make)
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Xcode Command Line Tools not found. Required to build Pikafish."
    warn "Run: xcode-select --install"
    warn "Continuing without building Pikafish (builtin AI will still work)."
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm not found (Node.js install incomplete)."
  exit 1
fi

info "Installing npm dependencies"
npm install

# Create .env if missing (frontend -> backend)
if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  info "Creating default .env"
  cat > "${ROOT_DIR}/.env" <<'EOF'
VITE_SERVER_API_BASE=http://127.0.0.1:3001/api
EOF
fi

# Best-effort: build Pikafish if sources exist and binary not built yet.
ENGINE_BIN="${ROOT_DIR}/third_party/Pikafish-jieqi-old/src/PikaJieQi"
if [[ ! -x "${ENGINE_BIN}" && -f "${ROOT_DIR}/third_party/Pikafish-jieqi-old/src/Makefile" ]]; then
  if command -v make >/dev/null 2>&1 && command -v clang >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then
    info "Building Pikafish (best-effort)"
    if ! npm run -s pikafish:build; then
      warn "Pikafish build failed; continuing with builtin AI."
    fi
  else
    warn "Toolchain missing; skip Pikafish build. (Install Xcode CLT for Pikafish)"
  fi
fi

info "Starting dev stack (mysql + backend + frontend)"
exec npm run -s dev:local
