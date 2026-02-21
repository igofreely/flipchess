import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

type LayoutReady = { red: boolean; black: boolean }

interface MatchRow extends RowDataPacket {
  id: string
  mode: string
  status: string
  moves_json: string
  layout_setup_required: number | null
  layout_ready_json: string | null
}

const parseArgs = (argv: string[]) => {
  const set = new Set(argv)
  return {
    clearAll: set.has('--clear-all') || set.has('--delete-all') || set.has('--clear-matches'),
  }
}

const buildPool = (): Pool => {
  const url = process.env.MYSQL_URL?.trim()
  if (url) {
    return mysql.createPool({
      uri: url,
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10),
      dateStrings: true,
      timezone: 'Z',
    })
  }

  return mysql.createPool({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'flipchess',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10),
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
  })
}

const safeParseJson = <T>(value: string | null): T | null => {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

const safeMovesLength = (movesJson: string): number => {
  try {
    const parsed = JSON.parse(movesJson)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

const computeNextLayoutState = (row: MatchRow) => {
  const mode = row.mode
  const status = row.status
  const movesLen = safeMovesLength(row.moves_json)
  const currentReady = safeParseJson<Partial<LayoutReady>>(row.layout_ready_json)
  const currentRed = currentReady?.red === true
  const currentBlack = currentReady?.black === true

  if (mode !== 'pvp' || status !== 'ongoing' || movesLen > 0) {
    return { required: false, ready: { red: true, black: true } satisfies LayoutReady }
  }

  const red = currentRed
  const black = currentBlack
  const bothReady = red && black
  if (bothReady) {
    return { required: false, ready: { red: true, black: true } satisfies LayoutReady }
  }

  return { required: true, ready: { red, black } satisfies LayoutReady }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const pool = buildPool()

  try {
    const ensureColumn = async (columnName: string, ddl: string) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'matches'
           AND column_name = ?`,
        [columnName],
      )
      const count = Number(rows[0]?.cnt ?? 0)
      if (count > 0) return
      await pool.query(ddl)
    }

    await ensureColumn('layout_setup_required', 'ALTER TABLE matches ADD COLUMN layout_setup_required TINYINT(1) NULL')
    await ensureColumn('layout_ready_json', 'ALTER TABLE matches ADD COLUMN layout_ready_json JSON NULL')

    const [rows] = await pool.query<MatchRow[]>(
      'SELECT id, mode, status, moves_json, layout_setup_required, layout_ready_json FROM matches',
    )

    let repaired = 0
    for (const row of rows) {
      const next = computeNextLayoutState(row)
      const currentRequired = row.layout_setup_required === 1
      const currentReady = safeParseJson<Partial<LayoutReady>>(row.layout_ready_json)
      const currentRed = currentReady?.red === true
      const currentBlack = currentReady?.black === true

      const changed =
        currentRequired !== next.required ||
        currentRed !== next.ready.red ||
        currentBlack !== next.ready.black

      if (!changed) continue

      await pool.query(
        'UPDATE matches SET layout_setup_required = ?, layout_ready_json = ? WHERE id = ?',
        [next.required ? 1 : 0, JSON.stringify(next.ready), row.id],
      )
      repaired += 1
    }

    console.log(`[maintenance] repaired layout state rows: ${repaired}`)

    if (args.clearAll) {
      const [result] = await pool.query('DELETE FROM matches')
      const affected = typeof result === 'object' && result && 'affectedRows' in result ? Number((result as { affectedRows?: number }).affectedRows ?? 0) : 0
      console.log(`[maintenance] deleted matches: ${affected}`)
    }
  } finally {
    await pool.end()
  }
}

void main().catch((error) => {
  console.error('[maintenance] failed:', error)
  process.exit(1)
})
