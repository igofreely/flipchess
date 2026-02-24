#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${ROOT_DIR}/third_party/Pikafish-jieqi-old/src"
ENGINE_BIN="${ENGINE_DIR}/PikaJieQi"

if ! command -v make >/dev/null 2>&1; then
  echo "[pikafish:build] ERROR: make not found"
  exit 1
fi

# macOS toolchain sanity
if [[ "$(uname -s)" = "Darwin" ]]; then
  if ! command -v clang >/dev/null 2>&1; then
    echo "[pikafish:build] ERROR: clang not found. Install Xcode Command Line Tools: xcode-select --install"
    exit 1
  fi
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "[pikafish:build] ERROR: Xcode Command Line Tools not configured. Run: xcode-select --install"
    exit 1
  fi
fi

JOBS="${JOBS:-}"
if [[ -z "${JOBS}" ]] && command -v sysctl >/dev/null 2>&1; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi
JOBS="${JOBS:-4}"

ARCH="${ARCH:-}"
if [[ -z "${ARCH}" ]]; then
  if [[ "$(uname -s)" = "Darwin" ]] && [[ "$(uname -m)" = "arm64" ]]; then
    ARCH="apple-silicon"
  else
    ARCH="general-64"
  fi
fi

echo "[pikafish:build] building in ${ENGINE_DIR} (ARCH=${ARCH}, JOBS=${JOBS})"
make -C "${ENGINE_DIR}" -j"${JOBS}" build ARCH="${ARCH}"

if [[ ! -x "${ENGINE_BIN}" ]]; then
  echo "[pikafish:build] ERROR: build finished but binary not found: ${ENGINE_BIN}"
  exit 1
fi

echo "[pikafish:build] OK: ${ENGINE_BIN}"

echo "[pikafish:build] quick uci smoke test"
# This only checks the binary starts; NNUE may still be required at runtime.
( printf 'uci\nisready\nquit\n' | "${ENGINE_BIN}" >/dev/null ) || {
  echo "[pikafish:build] WARNING: engine uci smoke test failed"
}

echo ""
echo "Next: provide an NNUE file and set env vars (or place it in server/data):"
echo "  - engine:  export PIKAFISH_JIEQI_PATH=\"${ENGINE_BIN}\""
echo "  - eval:    export PIKAFISH_EVALFILE_PATH=\"${ROOT_DIR}/server/data/pikafish-master.nnue\""
echo ""
echo "Then run: npm run check:pikafish"
