#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_ENGINE_PATH="$ROOT_DIR/third_party/Pikafish-jieqi-old/src/PikaJieQi"
FALLBACK_ENGINE_PATH="$(cd "$ROOT_DIR/.." && pwd)/Pikafish-jieqi-old/src/PikaJieQi"
ENGINE_PATH="${PIKAFISH_JIEQI_PATH:-$DEFAULT_ENGINE_PATH}"
if [[ ! -x "$ENGINE_PATH" && -x "$FALLBACK_ENGINE_PATH" ]]; then
  ENGINE_PATH="$FALLBACK_ENGINE_PATH"
fi

DEFAULT_EVALFILE_PATH="$ROOT_DIR/server/data/pikafish-master.nnue"
EVALFILE_PATH="${PIKAFISH_EVALFILE_PATH:-}"
if [[ -z "$EVALFILE_PATH" && -f "$DEFAULT_EVALFILE_PATH" ]]; then
  EVALFILE_PATH="$DEFAULT_EVALFILE_PATH"
fi
CHECK_PORT="${CHECK_PORT:-3101}"
BASE_URL="http://127.0.0.1:${CHECK_PORT}/api"
SERVER_LOG="/tmp/flipchess-pikafish-check.log"

if [[ ! -x "$ENGINE_PATH" ]]; then
  echo "[check:pikafish] 引擎不可执行：$ENGINE_PATH"
  echo "[check:pikafish] 请先编译并设置 PIKAFISH_JIEQI_PATH"
  exit 1
fi

echo "[check:pikafish] 使用引擎：$ENGINE_PATH"
if [[ -n "$EVALFILE_PATH" ]]; then
  echo "[check:pikafish] 使用 EvalFile：$EVALFILE_PATH"
fi
echo "[check:pikafish] 使用端口：$CHECK_PORT"

npm run mysql:up >/dev/null

PIKAFISH_JIEQI_PATH="$ENGINE_PATH" PIKAFISH_EVALFILE_PATH="$EVALFILE_PATH" PORT="$CHECK_PORT" npm run server:start:mysql >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in {1..40}; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "[check:pikafish] 服务启动失败，日志：$SERVER_LOG"
  tail -n 80 "$SERVER_LOG" || true
  exit 1
fi

BASE_URL="$BASE_URL" node <<'NODE'
const baseUrl = process.env.BASE_URL

const request = async (path, init = {}, token = '') => {
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path} => ${JSON.stringify(data)}`)
  }

  return data
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  await request('/health')

  const username = `u${String(Date.now() % 1_000_000).padStart(6, '0')}`
  const register = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'secret123' }),
  })

  const token = register.token
  const created = await request(
    '/matches',
    {
      method: 'POST',
      body: JSON.stringify({
        mode: 'vs_ai',
        aiSide: 'red',
        aiDepthBySide: { red: 2 },
        aiTimeBudgetBySide: { red: 1000 },
      }),
    },
    token,
  )

  const matchId = created.match.id

  for (let i = 1; i <= 12; i += 1) {
    const current = await request(`/matches/${matchId}`, { method: 'GET' }, token)
    const match = current.match
    if (match.state.moveCount > 0) {
      const firstActor = match.moves[0]?.actor ?? 'none'
      const firstEngine = match.moves[0]?.aiEngine ?? 'none'
      if (firstActor !== 'ai') {
        throw new Error(`首步执行方异常：${firstActor}`)
      }
      if (firstEngine !== 'pikafish') {
        throw new Error(`首步引擎异常：${firstEngine}（可能已回退到内置AI）`)
      }

      console.log(
        JSON.stringify({
          ok: true,
          username,
          matchId,
          moveCount: match.state.moveCount,
          firstMoveActor: firstActor,
          firstMoveEngine: firstEngine,
        }),
      )
      return
    }
    await sleep(500)
  }

  throw new Error('超时：未观察到 AI 首步落子')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
NODE

echo "[check:pikafish] 通过"
