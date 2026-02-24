#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PORT_FRONTEND="${PORT_FRONTEND:-2222}"
PORT_BACKEND="${PORT_BACKEND:-3001}"
HOST_FRONTEND="${HOST_FRONTEND:-0.0.0.0}"

kill_descendants() {
  local parent_pid="$1"
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  local child
  while IFS= read -r child; do
    [[ -z "${child}" ]] && continue
    kill_descendants "${child}" || true
    kill "${child}" 2>/dev/null || true
  done < <(pgrep -P "${parent_pid}" 2>/dev/null || true)
}

cleanup() {
  echo "\n[dev-local] stopping..."
  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    kill_descendants "${FRONTEND_PID}" || true
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill_descendants "${BACKEND_PID}" || true
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "[dev-local] ERROR: node not found. Please install Node.js (20+ recommended)."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[dev-local] ERROR: npm not found."
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "[dev-local] node_modules not found, running npm install"
  npm install
fi

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "[dev-local] .env not found, creating default .env"
  cat > "${ROOT_DIR}/.env" <<'EOF'
VITE_SERVER_API_BASE=http://127.0.0.1:3001/api
EOF
fi

# Auto enable Pikafish when artifacts are present.
if [[ -z "${PIKAFISH_JIEQI_PATH:-}" ]]; then
  if [[ -x "${ROOT_DIR}/third_party/Pikafish-jieqi-old/src/PikaJieQi" ]]; then
    export PIKAFISH_JIEQI_PATH="${ROOT_DIR}/third_party/Pikafish-jieqi-old/src/PikaJieQi"
  fi
fi

if [[ -n "${PIKAFISH_JIEQI_PATH:-}" && -z "${PIKAFISH_EVALFILE_PATH:-}" ]]; then
  if [[ -f "${ROOT_DIR}/server/data/pikafish-master.nnue" ]]; then
    export PIKAFISH_EVALFILE_PATH="${ROOT_DIR}/server/data/pikafish-master.nnue"
  fi
fi

if [[ -n "${PIKAFISH_JIEQI_PATH:-}" ]]; then
  echo "[dev-local] pikafish enabled"
  echo "  - engine: ${PIKAFISH_JIEQI_PATH}"
  if [[ -n "${PIKAFISH_EVALFILE_PATH:-}" ]]; then
    echo "  - eval:   ${PIKAFISH_EVALFILE_PATH}"
  else
    echo "  - eval:   (not set; optional)"
  fi
fi

echo "[dev-local] starting MySQL (npm run mysql:up)"
npm run -s mysql:up

echo "[dev-local] starting backend (npm run server:dev) on port ${PORT_BACKEND}"
PORT="${PORT_BACKEND}" npm run -s server:dev &
BACKEND_PID=$!

# Give backend a moment to start before frontend (optional, keeps logs cleaner)
sleep 0.5

echo "[dev-local] starting frontend (npm run dev) on http://localhost:${PORT_FRONTEND}"
npm run -s dev -- --host "${HOST_FRONTEND}" --port "${PORT_FRONTEND}" &
FRONTEND_PID=$!

echo "[dev-local] ready"
echo "  - frontend: http://localhost:${PORT_FRONTEND}"
echo "  - backend:  http://127.0.0.1:${PORT_BACKEND}"
echo "  - health:   http://127.0.0.1:${PORT_BACKEND}/api/health"

echo "[dev-local] press Ctrl+C to stop"

wait "${BACKEND_PID}" "${FRONTEND_PID}"
