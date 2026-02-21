const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3101/api'

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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path} => ${JSON.stringify(data)}`)
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

  for (let i = 0; i < 16; i += 1) {
    const current = await request(`/matches/${matchId}`, { method: 'GET' }, token)
    const match = current.match

    if (match.state.moveCount > 0) {
      const firstActor = match.moves[0]?.actor ?? 'none'
      const firstEngine = match.moves[0]?.aiEngine ?? 'none'
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

  throw new Error('timeout_waiting_first_move')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
