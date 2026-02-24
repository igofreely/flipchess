import cors from 'cors'
import express from 'express'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { createInitialGame, getPieceLabel, playMove } from '../../src/game/engine'
import { chooseBestAiMoveTimed } from '../../src/game/ai'
import type { Position, Side } from '../../src/game/types'
import { searchBestMoveWithPikafish } from './pikafish-jieqi'
import { createAuthToken, requireAuth, type AuthenticatedRequest } from './auth'
import { DataStore } from './store.ts'
import type { AiEngine, MatchMode, MatchRecord, MatchSideSlot, MoveRecord, PublicUser, UserRecord } from './types'

const app = express()
const store = new DataStore()

const PORT = Number(process.env.PORT ?? 3001)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*'

const DEFAULT_AI_DEPTH = 5
const DEFAULT_AI_TIME_BUDGET_MS = 2000
const MIN_AI_MOVE_INTERVAL_MS = 1000
const PIKAFISH_SEARCH_DEPTH = 64
const PIKAFISH_NO_LIMIT_BUDGET_MS = 12_000
const PIKAFISH_MAX_THINK_MS = Number(process.env.PIKAFISH_MAX_THINK_MS ?? 20_000)
const PIKAFISH_JIEQI_PATH_ENV = String(process.env.PIKAFISH_JIEQI_PATH ?? '').trim()
const PIKAFISH_EVALFILE_PATH_ENV = String(process.env.PIKAFISH_EVALFILE_PATH ?? '').trim()
const PIKAFISH_THREADS = Number(process.env.PIKAFISH_THREADS ?? 1)
const PIKAFISH_HASH_MB = Number(process.env.PIKAFISH_HASH_MB ?? 64)

const isExecutableFile = (filePath: string) => {
  if (!filePath) return false
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    return (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

const detectPikafishExecutable = () => {
  if (PIKAFISH_JIEQI_PATH_ENV) return PIKAFISH_JIEQI_PATH_ENV
  const root = process.cwd()

  const candidates = [
    resolvePath(root, 'third_party/Pikafish-jieqi-old/src/PikaJieQi'),
    resolvePath(root, '../Pikafish-jieqi-old/src/PikaJieQi'),
    resolvePath(root, '../Pikafish-jieqi/src/pikafish'),
  ]

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      console.log(`[server] auto detected PIKAFISH_JIEQI_PATH=${candidate}`)
      return candidate
    }
  }

  return ''
}

const detectPikafishEvalFile = (enginePath: string) => {
  if (PIKAFISH_EVALFILE_PATH_ENV) return PIKAFISH_EVALFILE_PATH_ENV
  const root = process.cwd()

  const candidates = [
    resolvePath(root, 'server/data/pikafish-master.nnue'),
    enginePath ? resolvePath(dirname(enginePath), 'pikafish.nnue') : '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.log(`[server] auto detected PIKAFISH_EVALFILE_PATH=${candidate}`)
      return candidate
    }
  }
  return ''
}

const PIKAFISH_JIEQI_PATH = detectPikafishExecutable()
const PIKAFISH_EVALFILE_PATH = detectPikafishEvalFile(PIKAFISH_JIEQI_PATH)

const aiTurnTimers = new Map<string, ReturnType<typeof setTimeout>>()

const sideName = (side: Side) => (side === 'red' ? '红方' : '黑方')
const nextSide = (side: Side): Side => (side === 'red' ? 'black' : 'red')

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }))
app.use(express.json({ limit: '2mb' }))

const clampDepth = (value: number | undefined) => {
  if (!value || Number.isNaN(value)) return DEFAULT_AI_DEPTH
  return Math.max(1, Math.min(8, Math.floor(value)))
}

const clampBudget = (value: number | undefined) => {
  if (!value || Number.isNaN(value)) return DEFAULT_AI_TIME_BUDGET_MS
  return Math.max(200, Math.min(60_000, Math.floor(value)))
}

const clampPikafishThinkMs = (value: number) => {
  const cap = Number.isFinite(PIKAFISH_MAX_THINK_MS) ? Math.max(200, Math.floor(PIKAFISH_MAX_THINK_MS)) : 12_000
  return Math.max(200, Math.min(cap, Math.floor(value)))
}

const resolveAiEngine = (requested?: string): AiEngine => {
  if (requested === 'builtin') return 'builtin'
  return PIKAFISH_JIEQI_PATH ? 'pikafish' : 'builtin'
}

const toPublicUser = (user: UserRecord): PublicUser => ({
  id: user.id,
  username: user.username,
  createdAt: user.createdAt,
})

const matchIncludesUser = (match: MatchRecord, userId: string) =>
  match.red.userId === userId || match.black.userId === userId || match.createdByUserId === userId

const normalizeMatchForResponse = async (match: MatchRecord) => {
  ensureLayoutSetupState(match)
  const [redUser, blackUser] = await Promise.all([
    match.red.userId ? store.findUserById(match.red.userId) : Promise.resolve(undefined),
    match.black.userId ? store.findUserById(match.black.userId) : Promise.resolve(undefined),
  ])

  return {
    ...match,
    red: {
      ...match.red,
      username: redUser?.username ?? null,
    },
    black: {
      ...match.black,
      username: blackUser?.username ?? null,
    },
  }
}

const parsePosition = (value: unknown): Position | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Position>
  if (typeof candidate.row !== 'number' || typeof candidate.col !== 'number') return null
  const row = Math.floor(candidate.row)
  const col = Math.floor(candidate.col)
  if (row < 0 || row > 9 || col < 0 || col > 8) return null
  return { row, col }
}

const normalizeParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const isGameStateLike = (value: unknown): value is ReturnType<typeof createInitialGame> => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ReturnType<typeof createInitialGame>>
  return (
    Array.isArray(candidate.board) &&
    typeof candidate.pieces === 'object' &&
    (candidate.turn === 'red' || candidate.turn === 'black') &&
    typeof candidate.moveCount === 'number' &&
    typeof candidate.isDraw === 'boolean' &&
    typeof candidate.quietMoveCount === 'number'
  )
}

const currentSideSlot = (match: MatchRecord): MatchSideSlot => (match.state.turn === 'red' ? match.red : match.black)
const allLayoutReady = (match: MatchRecord) => !!match.layoutReadyBySide?.red && !!match.layoutReadyBySide?.black

const ensureLayoutSetupState = (match: MatchRecord) => {
  if (match.mode !== 'pvp') {
    match.layoutSetupRequired = false
    match.layoutReadyBySide = { red: true, black: true }
    return
  }

  const shouldRequireSetup = match.status === 'ongoing' && match.moves.length === 0
  if (typeof match.layoutSetupRequired !== 'boolean') {
    match.layoutSetupRequired = shouldRequireSetup
  }

  const redReady = match.layoutReadyBySide?.red
  const blackReady = match.layoutReadyBySide?.black
  if (typeof redReady !== 'boolean' || typeof blackReady !== 'boolean') {
    match.layoutReadyBySide = shouldRequireSetup ? { red: false, black: false } : { red: true, black: true }
  }

  const bothReady = !!match.layoutReadyBySide?.red && !!match.layoutReadyBySide?.black

  // Once both sides are ready, keep the match in started-ready state
  // even if no move has been made yet.
  if (bothReady) {
    match.layoutSetupRequired = false
  }

  if (shouldRequireSetup && !bothReady && !match.layoutSetupRequired) {
    match.layoutSetupRequired = true
    if (match.layoutReadyBySide?.red !== true && match.layoutReadyBySide?.black !== true) {
      match.layoutReadyBySide = { red: false, black: false }
    }
  }

  if (!shouldRequireSetup) {
    match.layoutSetupRequired = false
    match.layoutReadyBySide = { red: true, black: true }
  }
}

const cloneState = <T>(state: T): T => JSON.parse(JSON.stringify(state)) as T

const userSideInMatch = (match: MatchRecord, userId: string): Side | null => {
  if (match.red.type === 'user' && match.red.userId === userId) return 'red'
  if (match.black.type === 'user' && match.black.userId === userId) return 'black'
  return null
}

const clearNegotiationState = (match: MatchRecord) => {
  match.drawOfferBySide = { red: false, black: false }
  match.undoRequest = null
}

const resetStateToStart = (state: MatchRecord['state']) => {
  state.selected = null
  state.legalMoves = []
  state.turn = 'red'
  state.winner = null
  state.isDraw = false
  state.quietMoveCount = 0
  state.moveCount = 0
  state.positionHistory = []
  state.checkHistory = []
}

const applySideLayoutFromState = (target: MatchRecord['state'], source: MatchRecord['state'], side: Side) => {
  const positions: Position[] = side === 'red'
    ? [
        { row: 9, col: 0 }, { row: 9, col: 1 }, { row: 9, col: 2 }, { row: 9, col: 3 }, { row: 9, col: 5 }, { row: 9, col: 6 }, { row: 9, col: 7 }, { row: 9, col: 8 },
        { row: 7, col: 1 }, { row: 7, col: 7 },
        { row: 6, col: 0 }, { row: 6, col: 2 }, { row: 6, col: 4 }, { row: 6, col: 6 }, { row: 6, col: 8 },
      ]
    : [
        { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 }, { row: 0, col: 5 }, { row: 0, col: 6 }, { row: 0, col: 7 }, { row: 0, col: 8 },
        { row: 2, col: 1 }, { row: 2, col: 7 },
        { row: 3, col: 0 }, { row: 3, col: 2 }, { row: 3, col: 4 }, { row: 3, col: 6 }, { row: 3, col: 8 },
      ]

  for (const pos of positions) {
    const sourceId = source.board[pos.row]?.[pos.col]
    if (!sourceId) return false
    const sourcePiece = source.pieces[sourceId]
    if (!sourcePiece || !sourcePiece.alive || sourcePiece.side !== side || sourcePiece.realType === 'king') return false

    const targetId = target.board[pos.row]?.[pos.col]
    if (!targetId) return false
    const targetPiece = target.pieces[targetId]
    if (!targetPiece || !targetPiece.alive || targetPiece.side !== side || targetPiece.realType === 'king') return false

    targetPiece.realType = sourcePiece.realType
    targetPiece.isRevealed = false
    targetPiece.currentPos = { ...pos }
    targetPiece.bornPos = { ...pos }
  }

  return true
}

const rebuildStateFromMoves = (match: MatchRecord): boolean => {
  let working = cloneState(match.initialState)
  for (const move of match.moves) {
    const next = playMove(working, move.from, move.to)
    if (next === working) {
      return false
    }
    working = next
  }
  match.state = working
  return true
}

const finalizeMatchStatus = (match: MatchRecord) => {
  if (match.state.winner === 'red' || match.state.winner === 'black') {
    match.status = 'finished'
    match.result = match.state.winner
    match.termination = match.state.message
    clearNegotiationState(match)
    return
  }

  if (match.state.isDraw) {
    match.status = 'finished'
    match.result = 'draw'
    match.termination = match.state.message
    clearNegotiationState(match)
  }
}

const clearAiTurnTimer = (matchId: string) => {
  const timer = aiTurnTimers.get(matchId)
  if (!timer) return
  clearTimeout(timer)
  aiTurnTimers.delete(matchId)
}

const chooseAiMoveWithConfiguredBackend = async (
  state: MatchRecord['state'],
  side: Side,
  slot: MatchSideSlot,
  addTrace?: (line: string) => void,
) => {
  const wantsPikafish = slot.aiEngine !== 'builtin' && !!PIKAFISH_JIEQI_PATH
  if (wantsPikafish) {
    const pikafishBudgetMs = clampPikafishThinkMs(slot.aiPikafishMaxThinkMs ?? slot.aiTimeBudgetMs)
    addTrace?.(`[backend] prefer=pikafish depth=${PIKAFISH_SEARCH_DEPTH} budgetMs=${pikafishBudgetMs}`)
    try {
      const pikafishMove = await searchBestMoveWithPikafish({
        executablePath: PIKAFISH_JIEQI_PATH,
        evalFilePath: PIKAFISH_EVALFILE_PATH || undefined,
        state,
        side,
        depth: PIKAFISH_SEARCH_DEPTH,
        timeBudgetMs: pikafishBudgetMs,
        threads: Number.isFinite(PIKAFISH_THREADS) ? PIKAFISH_THREADS : 1,
        hashMb: Number.isFinite(PIKAFISH_HASH_MB) ? PIKAFISH_HASH_MB : 64,
        onTrace: addTrace,
      })
      if (pikafishMove) {
        return { move: pikafishMove, engine: 'pikafish' as AiEngine }
      }
      addTrace?.('[backend] pikafish returned no usable move, auto-fallback to builtin')
    } catch (err) {
      addTrace?.(`[backend] pikafish error, auto-fallback to builtin: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Pikafish configured but couldn't produce a valid move for this position — use builtin
    return {
      move: chooseBestAiMoveTimed(state, side, slot.aiDepth, slot.aiTimeBudgetMs),
      engine: 'pikafish-fallback' as AiEngine,
    }
  }

  addTrace?.(`[backend] use builtin depth=${slot.aiDepth} budgetMs=${slot.aiTimeBudgetMs}`)
  return {
    move: chooseBestAiMoveTimed(state, side, slot.aiDepth, slot.aiTimeBudgetMs),
    engine: 'builtin' as AiEngine,
  }
}

const appendMoveLog = (
  match: MatchRecord,
  side: Side,
  from: Position,
  to: Position,
  actor: 'user' | 'ai',
  aiEngine?: AiEngine,
) => {
  const movedId = match.state.board[to.row]?.[to.col]
  const pieceText = movedId ? getPieceLabel(match.state.pieces[movedId]) : '子'
  const moveLog: MoveRecord = {
    ply: match.state.moveCount,
    side,
    actor,
    aiEngine,
    from: { ...from },
    to: { ...to },
    pieceText,
    createdAt: new Date().toISOString(),
  }
  match.moves.push(moveLog)
  clearNegotiationState(match)
}

const scheduleAiTurnIfNeeded = (matchId: string, delayMs = MIN_AI_MOVE_INTERVAL_MS) => {
  if (aiTurnTimers.has(matchId)) return

  const safeDelay = Math.max(MIN_AI_MOVE_INTERVAL_MS, Math.floor(delayMs))
  const timer = setTimeout(async () => {
    aiTurnTimers.delete(matchId)

    const match = await store.findMatchById(matchId)
    if (!match || match.status !== 'ongoing') return

    const side = match.state.turn
    const slot = currentSideSlot(match)
    if (slot.type !== 'ai') return

    console.log(
      `[ai] match=${match.id} side=${side} begin preferred=${PIKAFISH_JIEQI_PATH ? 'pikafish' : 'builtin'} depth=${slot.aiDepth} budgetMs=${slot.aiTimeBudgetMs}`,
    )

    let move: ReturnType<typeof chooseBestAiMoveTimed>
    let aiEngineUsed: AiEngine = 'builtin'
    try {
      const result = await chooseAiMoveWithConfiguredBackend(match.state, side, slot)
      move = result.move
      aiEngineUsed = result.engine
    } catch (error) {
      console.warn(
        `[ai] match=${match.id} side=${side} preferred engine failed, fallback to builtin: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        move = chooseBestAiMoveTimed(match.state, side, slot.aiDepth, slot.aiTimeBudgetMs)
        aiEngineUsed = 'builtin'
      } catch (fallbackError) {
        console.error(
          `[ai] match=${match.id} side=${side} builtin fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        )
        match.status = 'finished'
        match.result = 'draw'
        match.termination = 'AI计算异常，判和'
        match.state = {
          ...match.state,
          winner: null,
          isDraw: true,
          selected: null,
          legalMoves: [],
          message: 'AI计算异常，判和',
        }
        clearNegotiationState(match)
        match.updatedAt = new Date().toISOString()
        await store.upsertMatch(match)
        return
      }
    }

    if (!move) {
      finalizeMatchStatus(match)
      match.updatedAt = new Date().toISOString()
      await store.upsertMatch(match)
      return
    }

    const before = match.state
    const next = playMove(before, move.from, move.to)
    if (next === before) {
      finalizeMatchStatus(match)
      match.updatedAt = new Date().toISOString()
      await store.upsertMatch(match)
      return
    }

    match.state = next
    match.updatedAt = new Date().toISOString()
  appendMoveLog(match, side, move.from, move.to, 'ai', aiEngineUsed)
    console.log(`[ai] match=${match.id} side=${side} engine=${aiEngineUsed} move=${move.from.row},${move.from.col}->${move.to.row},${move.to.col}`)
    finalizeMatchStatus(match)
    await store.upsertMatch(match)

    if (match.status === 'ongoing' && currentSideSlot(match).type === 'ai') {
      scheduleAiTurnIfNeeded(match.id, MIN_AI_MOVE_INTERVAL_MS)
    }
  }, safeDelay)

  aiTurnTimers.set(matchId, timer)
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'flipchess-server',
    ai: {
      supportsNoFallback: true,
      supportsNoLimit: true,
    },
  })
})

app.post('/api/ai/search', async (req, res) => {
  const trace: string[] = []
  const addTrace = (line: string) => {
    const time = new Date().toISOString().slice(11, 23)
    trace.push(`${time} ${line}`)
  }

  const side = req.body?.side === 'red' ? 'red' : req.body?.side === 'black' ? 'black' : null
  const noFallback = req.body?.noFallback === true
  const noLimit = req.body?.noLimit === true
  const requestedPikafishMaxThinkMs = Number(req.body?.pikafishMaxThinkMs)
  if (!side) {
    res.status(400).json({ message: 'Invalid side' })
    return
  }

  const state = req.body?.state
  if (!isGameStateLike(state)) {
    res.status(400).json({ message: 'Invalid state' })
    return
  }

  const depth = clampDepth(Number(req.body?.depth))
  const requestedBudgetMs = noLimit ? PIKAFISH_NO_LIMIT_BUDGET_MS : clampBudget(Number(req.body?.timeBudgetMs))
  const requestCapMs = Number.isFinite(requestedPikafishMaxThinkMs)
    ? clampPikafishThinkMs(requestedPikafishMaxThinkMs)
    : Number.POSITIVE_INFINITY
  const timeBudgetMs = clampPikafishThinkMs(Math.min(requestedBudgetMs, requestCapMs))
  addTrace(`[backend] request side=${side} depth=${depth} budgetMs=${timeBudgetMs} noFallback=${noFallback} noLimit=${noLimit}`)
  const slot: MatchSideSlot = {
    type: 'ai',
    aiDepth: depth,
    aiTimeBudgetMs: timeBudgetMs,
    aiEngine: PIKAFISH_JIEQI_PATH ? 'pikafish' : 'builtin',
  }

  try {
    const result = await chooseAiMoveWithConfiguredBackend(state, side, slot, addTrace)
    if (noFallback && result.engine !== 'pikafish' && result.engine !== 'pikafish-fallback') {
      addTrace('[backend] locked Pikafish requested but not configured on server')
      res.status(503).json({ message: 'Pikafish is not configured on server', trace })
      return
    }
    addTrace(`[backend] result engine=${result.engine} move=${result.move ? `${result.move.from.row},${result.move.from.col}->${result.move.to.row},${result.move.to.col}` : 'none'}`)
    res.json({ side, move: result.move, engine: result.engine, trace })
    return
  } catch (error) {
    if (noFallback) {
      addTrace(`[backend] preferred engine failed (locked): ${error instanceof Error ? error.message : String(error)}`)
      res.status(503).json({ message: `AI preferred engine failed: ${error instanceof Error ? error.message : String(error)}`, trace })
      return
    }
    addTrace(`[backend] preferred engine failed, fallback builtin: ${error instanceof Error ? error.message : String(error)}`)
    console.warn(`[ai-http] preferred engine failed, fallback to builtin: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const move = chooseBestAiMoveTimed(state, side, depth, timeBudgetMs)
    addTrace(`[backend] fallback builtin result move=${move ? `${move.from.row},${move.from.col}->${move.to.row},${move.to.col}` : 'none'}`)
    res.json({ side, move, engine: 'builtin' as AiEngine, trace })
  } catch (error) {
    addTrace(`[backend] fallback builtin failed: ${error instanceof Error ? error.message : String(error)}`)
    res.status(500).json({ message: `AI search failed: ${error instanceof Error ? error.message : String(error)}`, trace })
  }
})

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body?.username ?? '').trim()
  const password = String(req.body?.password ?? '')

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    res.status(400).json({ message: 'Username must be 3-20 chars (letters/numbers/_)' })
    return
  }
  if (password.length < 6 || password.length > 64) {
    res.status(400).json({ message: 'Password length must be 6-64' })
    return
  }
  if (await store.findUserByUsername(username)) {
    res.status(409).json({ message: 'Username already exists' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const user: UserRecord = {
    id: randomUUID(),
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  }
  await store.addUser(user)

  const token = createAuthToken({ userId: user.id, username: user.username })
  res.status(201).json({ token, user: toPublicUser(user) })
})

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim()
  const password = String(req.body?.password ?? '')

  const user = await store.findUserByUsername(username)
  if (!user) {
    res.status(401).json({ message: 'Invalid credentials' })
    return
  }

  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) {
    res.status(401).json({ message: 'Invalid credentials' })
    return
  }

  const token = createAuthToken({ userId: user.id, username: user.username })
  res.json({ token, user: toPublicUser(user) })
})

app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const current = req.user ? await store.findUserById(req.user.userId) : undefined
  if (!current) {
    res.status(401).json({ message: 'User not found' })
    return
  }

  res.json({ user: toPublicUser(current) })
})

app.post('/api/matches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const creator = req.user ? await store.findUserById(req.user.userId) : undefined
  if (!creator) {
    res.status(401).json({ message: 'User not found' })
    return
  }

  const mode = String(req.body?.mode ?? 'vs_ai') as MatchMode
  if (!['pvp', 'vs_ai', 'ai_vs_ai'].includes(mode)) {
    res.status(400).json({ message: 'Invalid mode' })
    return
  }

  const aiDepthBySide = (req.body?.aiDepthBySide ?? {}) as Partial<Record<Side, number>>
  const aiTimeBudgetBySide = (req.body?.aiTimeBudgetBySide ?? {}) as Partial<Record<Side, number>>
  const aiEngineBySide = (req.body?.aiEngineBySide ?? {}) as Partial<Record<Side, string>>
  const aiPikafishMaxThinkBySide = (req.body?.aiPikafishMaxThinkBySide ?? {}) as Partial<Record<Side, number>>
  const importedSetup = req.body?.fenSetup as unknown

  let initialState = createInitialGame()
  if (importedSetup !== undefined) {
    if (!isGameStateLike(importedSetup)) {
      res.status(400).json({ message: 'Invalid fenSetup' })
      return
    }
    initialState = cloneState(importedSetup)
  }

  const newMatch: MatchRecord = {
    id: randomUUID(),
    mode,
    status: 'ongoing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdByUserId: creator.id,
    red: {
      type: 'user',
      userId: creator.id,
      aiDepth: clampDepth(aiDepthBySide.red),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.red),
    },
    black: {
      type: 'ai',
      aiDepth: clampDepth(aiDepthBySide.black),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.black),
      aiEngine: resolveAiEngine(aiEngineBySide.black),
      aiPikafishMaxThinkMs: typeof aiPikafishMaxThinkBySide.black === 'number' ? clampPikafishThinkMs(aiPikafishMaxThinkBySide.black) : undefined,
    },
    layoutSetupRequired: false,
    layoutReadyBySide: { red: true, black: true },
    initialState: cloneState(initialState),
    state: initialState,
    drawOfferBySide: { red: false, black: false },
    undoRequest: null,
    result: null,
    termination: null,
    moves: [],
  }

  if (mode === 'pvp') {
    const opponentUsername = String(req.body?.opponentUsername ?? '').trim()
    const opponent = await store.findUserByUsername(opponentUsername)
    if (!opponent) {
      res.status(400).json({ message: 'Opponent username not found' })
      return
    }
    if (opponent.id === creator.id) {
      res.status(400).json({ message: 'Opponent must be another user' })
      return
    }

    newMatch.red = {
      type: 'user',
      userId: creator.id,
      aiDepth: clampDepth(aiDepthBySide.red),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.red),
    }
    newMatch.black = {
      type: 'user',
      userId: opponent.id,
      aiDepth: clampDepth(aiDepthBySide.black),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.black),
    }
    newMatch.status = 'pending'
    newMatch.layoutSetupRequired = true
    newMatch.layoutReadyBySide = { red: false, black: false }
    newMatch.state = {
      ...newMatch.state,
      message: '等待对手接受邀请',
      selected: null,
      legalMoves: [],
    }
    newMatch.initialState = {
      ...newMatch.initialState,
      message: '等待对手接受邀请',
      selected: null,
      legalMoves: [],
    }
  } else if (mode === 'vs_ai') {
    const aiSide = (String(req.body?.aiSide ?? 'black') as Side) === 'red' ? 'red' : 'black'
    if (aiSide === 'red') {
      newMatch.red = {
        type: 'ai',
        aiDepth: clampDepth(aiDepthBySide.red),
        aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.red),
        aiEngine: resolveAiEngine(aiEngineBySide.red),
        aiPikafishMaxThinkMs: typeof aiPikafishMaxThinkBySide.red === 'number' ? clampPikafishThinkMs(aiPikafishMaxThinkBySide.red) : undefined,
      }
      newMatch.black = {
        type: 'user',
        userId: creator.id,
        aiDepth: clampDepth(aiDepthBySide.black),
        aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.black),
      }
    }
  } else {
    newMatch.red = {
      type: 'ai',
      aiDepth: clampDepth(aiDepthBySide.red),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.red),
      aiEngine: resolveAiEngine(aiEngineBySide.red),
      aiPikafishMaxThinkMs: typeof aiPikafishMaxThinkBySide.red === 'number' ? clampPikafishThinkMs(aiPikafishMaxThinkBySide.red) : undefined,
    }
    newMatch.black = {
      type: 'ai',
      aiDepth: clampDepth(aiDepthBySide.black),
      aiTimeBudgetMs: clampBudget(aiTimeBudgetBySide.black),
      aiEngine: resolveAiEngine(aiEngineBySide.black),
      aiPikafishMaxThinkMs: typeof aiPikafishMaxThinkBySide.black === 'number' ? clampPikafishThinkMs(aiPikafishMaxThinkBySide.black) : undefined,
    }
  }

  await store.upsertMatch(newMatch)
  if (newMatch.status === 'ongoing' && currentSideSlot(newMatch).type === 'ai') {
    scheduleAiTurnIfNeeded(newMatch.id, MIN_AI_MOVE_INTERVAL_MS)
  }
  res.status(201).json({ match: await normalizeMatchForResponse(newMatch) })
})

app.get('/api/matches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const mineOnly = String(req.query.mine ?? 'true') !== 'false'
  const userId = req.user?.userId

  const all = await store.listMatches()
  const result = mineOnly && userId ? all.filter((match) => matchIncludesUser(match, userId)) : all
  const normalized = await Promise.all(result.map((match) => normalizeMatchForResponse(match)))
  res.json({ matches: normalized })
})

app.get('/api/matches/:matchId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }

  res.json({ match: await normalizeMatchForResponse(match) })
})

app.post('/api/matches/:matchId/invite-response', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }

  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (match.mode !== 'pvp') {
    res.status(400).json({ message: 'Only pvp supports invite response' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }
  if (match.status !== 'pending') {
    res.status(400).json({ message: '邀请已处理，无需重复操作' })
    return
  }

  const inviterId = match.createdByUserId
  const inviteeId = [match.red.userId, match.black.userId].find((id) => !!id && id !== inviterId)

  const action = String(req.body?.action ?? '').trim()
  if (action !== 'accept' && action !== 'reject' && action !== 'cancel') {
    res.status(400).json({ message: 'Invalid action, expected accept|reject|cancel' })
    return
  }

  if (action === 'cancel') {
    if (!inviterId || req.user.userId !== inviterId) {
      res.status(403).json({ message: 'Only inviter can cancel' })
      return
    }
    const removed = await store.removeMatch(match.id)
    if (!removed) {
      res.status(500).json({ message: 'Cancel invite failed' })
      return
    }
    clearAiTurnTimer(match.id)
    res.json({ ok: true, matchId: match.id, action: 'cancel' })
    return
  }

  if (!inviteeId || req.user.userId !== inviteeId) {
    res.status(403).json({ message: 'Only invited user can respond' })
    return
  }

  if (action === 'reject') {
    const removed = await store.removeMatch(match.id)
    if (!removed) {
      res.status(500).json({ message: 'Reject invite failed' })
      return
    }
    clearAiTurnTimer(match.id)
    res.json({ ok: true, matchId: match.id, action: 'reject' })
    return
  }

  match.status = 'ongoing'
  match.layoutSetupRequired = true
  match.layoutReadyBySide = { red: false, black: false }
  match.state = {
    ...match.state,
    message: '等待双方完成布局',
    selected: null,
    legalMoves: [],
  }
  match.initialState = {
    ...match.initialState,
    message: '等待双方完成布局',
    selected: null,
    legalMoves: [],
  }
  clearNegotiationState(match)
  match.updatedAt = new Date().toISOString()
  await store.upsertMatch(match)

  res.json({ match: await normalizeMatchForResponse(match) })
})

app.patch('/api/matches/:matchId/ai-config', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }
  if (!matchIncludesUser(match, req.user.userId)) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const aiDepthBySide = (req.body?.aiDepthBySide ?? {}) as Partial<Record<Side, number>>
  const aiTimeBudgetBySide = (req.body?.aiTimeBudgetBySide ?? {}) as Partial<Record<Side, number>>
  const aiEngineBySide = (req.body?.aiEngineBySide ?? {}) as Partial<Record<Side, string>>
  const aiPikafishMaxThinkBySide = (req.body?.aiPikafishMaxThinkBySide ?? {}) as Partial<Record<Side, number>>
  let updated = false

  for (const side of ['red', 'black'] as Side[]) {
    const slot = side === 'red' ? match.red : match.black
    if (slot.type !== 'ai') continue

    if (typeof aiDepthBySide[side] === 'number') {
      slot.aiDepth = clampDepth(aiDepthBySide[side])
      updated = true
    }
    if (typeof aiTimeBudgetBySide[side] === 'number') {
      slot.aiTimeBudgetMs = clampBudget(aiTimeBudgetBySide[side])
      updated = true
    }
    if (typeof aiEngineBySide[side] === 'string') {
      slot.aiEngine = resolveAiEngine(aiEngineBySide[side])
      updated = true
    }
    if (typeof aiPikafishMaxThinkBySide[side] === 'number') {
      slot.aiPikafishMaxThinkMs = clampPikafishThinkMs(aiPikafishMaxThinkBySide[side])
      updated = true
    }
  }

  if (!updated) {
    res.status(400).json({ message: 'No AI config updated (target side is not AI or payload missing)' })
    return
  }

  match.updatedAt = new Date().toISOString()
  await store.upsertMatch(match)

  if (match.status === 'ongoing' && currentSideSlot(match).type === 'ai') {
    clearAiTurnTimer(match.id)
    scheduleAiTurnIfNeeded(match.id, MIN_AI_MOVE_INTERVAL_MS)
  }

  res.json({ match: await normalizeMatchForResponse(match) })
})

app.delete('/api/matches/:matchId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }
  if (!matchIncludesUser(match, req.user.userId)) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const removed = await store.removeMatch(match.id)
  if (!removed) {
    res.status(500).json({ message: 'Delete match failed' })
    return
  }

  clearAiTurnTimer(match.id)

  res.json({ ok: true, matchId: match.id })
})

app.post('/api/matches/:matchId/move', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (match.status !== 'ongoing') {
    res.status(400).json({ message: match.status === 'pending' ? '对手尚未接受邀请' : 'Match already finished' })
    return
  }
  ensureLayoutSetupState(match)
  if (match.mode === 'pvp' && match.layoutSetupRequired && !allLayoutReady(match)) {
    res.status(400).json({ message: '双方尚未完成自定义布局，暂不能开始' })
    return
  }

  const slot = currentSideSlot(match)
  if (slot.type !== 'user') {
    res.status(400).json({ message: 'Current turn is controlled by AI' })
    return
  }
  if (!req.user || slot.userId !== req.user.userId) {
    res.status(403).json({ message: 'Not your turn' })
    return
  }

  const from = parsePosition(req.body?.from)
  const to = parsePosition(req.body?.to)
  if (!from || !to) {
    res.status(400).json({ message: 'Invalid move payload' })
    return
  }

  const side = match.state.turn
  const before = match.state
  const next = playMove(before, from, to)
  if (next === before) {
    res.status(400).json({ message: 'Illegal move' })
    return
  }

  match.state = next
  match.updatedAt = new Date().toISOString()
  appendMoveLog(match, side, from, to, 'user')
  finalizeMatchStatus(match)
  await store.upsertMatch(match)
  if (match.status === 'ongoing' && currentSideSlot(match).type === 'ai') {
    scheduleAiTurnIfNeeded(match.id, MIN_AI_MOVE_INTERVAL_MS)
  }
  res.json({ match: await normalizeMatchForResponse(match) })
})

app.post('/api/matches/:matchId/layout-submit', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }
  if (match.mode !== 'pvp') {
    res.status(400).json({ message: 'Only pvp supports two-side layout confirmation' })
    return
  }
  if (match.status !== 'ongoing') {
    res.status(400).json({ message: match.status === 'pending' ? '对手尚未接受邀请' : 'Match already finished' })
    return
  }
  if (match.moves.length > 0) {
    res.status(400).json({ message: 'Match already started' })
    return
  }

  const side = userSideInMatch(match, req.user.userId)
  if (!side) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const submittedSetup = req.body?.fenSetup as unknown
  if (!isGameStateLike(submittedSetup)) {
    res.status(400).json({ message: 'Invalid fenSetup' })
    return
  }

  ensureLayoutSetupState(match)

  if (allLayoutReady(match) && !match.layoutSetupRequired) {
    res.status(400).json({ message: '双方已完成布局，不能重复提交' })
    return
  }

  if (match.layoutReadyBySide?.[side] === true) {
    res.status(400).json({ message: `${sideName(side)}已提交布局，不能重复提交` })
    return
  }

  const source = cloneState(submittedSetup)
  const nextInitial = cloneState(match.initialState)
  const nextState = cloneState(match.state)
  const appliedInitial = applySideLayoutFromState(nextInitial, source, side)
  const appliedState = applySideLayoutFromState(nextState, source, side)
  if (!appliedInitial || !appliedState) {
    res.status(400).json({ message: 'Invalid side layout setup' })
    return
  }

  const readyBySide: Record<Side, boolean> = {
    red: match.layoutReadyBySide?.red === true,
    black: match.layoutReadyBySide?.black === true,
  }
  match.layoutSetupRequired = !allLayoutReady(match)
  readyBySide[side] = true
  match.layoutReadyBySide = readyBySide
  resetStateToStart(nextInitial)
  resetStateToStart(nextState)
  const allReady = readyBySide.red && readyBySide.black
  const waitingSide: Side | null = !readyBySide.red ? 'red' : !readyBySide.black ? 'black' : null
  nextInitial.message = allReady ? '轮到红方' : waitingSide ? `等待${sideName(waitingSide)}完成布局` : '等待双方完成布局'
  nextState.message = nextInitial.message

  match.initialState = nextInitial
  match.state = nextState
  match.moves = []
  clearNegotiationState(match)
  if (allReady) {
    match.layoutSetupRequired = false
    match.state.message = '轮到红方'
    match.initialState.message = '轮到红方'
  }
  match.updatedAt = new Date().toISOString()

  await store.upsertMatch(match)
  res.json({ match: await normalizeMatchForResponse(match) })
})

app.post('/api/matches/:matchId/draw-offer', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (match.status !== 'ongoing') {
    res.status(400).json({ message: match.status === 'pending' ? '对手尚未接受邀请' : 'Match already finished' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }

  const side = userSideInMatch(match, req.user.userId)
  if (!side) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const opponent = nextSide(side)
  const opponentSlot = opponent === 'red' ? match.red : match.black

  if (match.drawOfferBySide[side]) {
    match.drawOfferBySide[side] = false
    match.updatedAt = new Date().toISOString()
    clearAiTurnTimer(match.id)
    await store.upsertMatch(match)
    res.json({ match: await normalizeMatchForResponse(match) })
    return
  }

  if (match.drawOfferBySide[opponent] || opponentSlot.type === 'ai') {
    match.status = 'finished'
    match.result = 'draw'
    match.termination = '双方协议和棋'
    match.state = {
      ...match.state,
      winner: null,
      isDraw: true,
      selected: null,
      legalMoves: [],
      message: '双方协议和棋',
    }
    clearNegotiationState(match)
    match.updatedAt = new Date().toISOString()
    await store.upsertMatch(match)
    res.json({ match: await normalizeMatchForResponse(match) })
    return
  }

  match.drawOfferBySide[side] = true
  match.updatedAt = new Date().toISOString()
  await store.upsertMatch(match)
  res.json({ match: await normalizeMatchForResponse(match) })
})

app.post('/api/matches/:matchId/resign', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (match.status !== 'ongoing') {
    res.status(400).json({ message: match.status === 'pending' ? '对手尚未接受邀请' : 'Match already finished' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }

  const side = userSideInMatch(match, req.user.userId)
  if (!side) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const winner = nextSide(side)
  const termination = `${sideName(side)}认输，${sideName(winner)}获胜`
  match.status = 'finished'
  match.result = winner
  match.termination = termination
  match.state = {
    ...match.state,
    winner,
    isDraw: false,
    selected: null,
    legalMoves: [],
    message: termination,
  }
  clearNegotiationState(match)
  match.updatedAt = new Date().toISOString()
  clearAiTurnTimer(match.id)
  await store.upsertMatch(match)
  res.json({ match: await normalizeMatchForResponse(match) })
})

app.post('/api/matches/:matchId/undo-request', requireAuth, async (req: AuthenticatedRequest, res) => {
  const matchId = normalizeParam(req.params.matchId)
  if (!matchId) {
    res.status(400).json({ message: 'Invalid matchId' })
    return
  }
  const match = await store.findMatchById(matchId)
  if (!match) {
    res.status(404).json({ message: 'Match not found' })
    return
  }
  if (match.status !== 'ongoing') {
    res.status(400).json({ message: match.status === 'pending' ? '对手尚未接受邀请' : 'Match already finished' })
    return
  }
  if (!req.user) {
    res.status(401).json({ message: 'User not found' })
    return
  }
  if (match.moves.length === 0) {
    res.status(400).json({ message: 'No moves to undo' })
    return
  }

  const side = userSideInMatch(match, req.user.userId)
  if (!side) {
    res.status(403).json({ message: 'You are not a player in this match' })
    return
  }

  const action = String(req.body?.action ?? '') as 'request' | 'cancel' | 'accept' | 'reject' | ''

  const hasAiSide = match.red.type === 'ai' || match.black.type === 'ai'

  if (!match.undoRequest) {
    if (action === 'accept' || action === 'reject' || action === 'cancel') {
      res.status(400).json({ message: 'No pending undo request' })
      return
    }
    // When AI is involved, directly undo without request/accept flow
    if (hasAiSide) {
      match.moves = match.moves.slice(0, -1)
      const rebuilt = rebuildStateFromMoves(match)
      if (!rebuilt) {
        res.status(500).json({ message: 'Failed to rebuild match state after undo' })
        return
      }
      match.status = 'ongoing'
      match.result = null
      match.termination = null
      clearNegotiationState(match)
      match.updatedAt = new Date().toISOString()
      await store.upsertMatch(match)
      if (match.status === 'ongoing' && currentSideSlot(match).type === 'ai') {
        scheduleAiTurnIfNeeded(match.id, MIN_AI_MOVE_INTERVAL_MS)
      }
      res.json({ match: await normalizeMatchForResponse(match) })
      return
    }
    match.undoRequest = { fromSide: side, requestedAt: new Date().toISOString() }
    match.updatedAt = new Date().toISOString()
    await store.upsertMatch(match)
    res.json({ match: await normalizeMatchForResponse(match) })
    return
  }

  if (match.undoRequest.fromSide === side) {
    if (action === 'accept') {
      res.status(400).json({ message: 'Cannot accept your own undo request' })
      return
    }
    match.undoRequest = null
    match.updatedAt = new Date().toISOString()
    await store.upsertMatch(match)
    res.json({ match: await normalizeMatchForResponse(match) })
    return
  }

  if (action === 'reject') {
    match.undoRequest = null
    match.updatedAt = new Date().toISOString()
    await store.upsertMatch(match)
    res.json({ match: await normalizeMatchForResponse(match) })
    return
  }

  match.moves = match.moves.slice(0, -1)
  const rebuilt = rebuildStateFromMoves(match)
  if (!rebuilt) {
    res.status(500).json({ message: 'Failed to rebuild match state after undo' })
    return
  }

  match.status = 'ongoing'
  match.result = null
  match.termination = null
  clearNegotiationState(match)
  match.updatedAt = new Date().toISOString()
  await store.upsertMatch(match)
  if (match.status === 'ongoing' && currentSideSlot(match).type === 'ai') {
    scheduleAiTurnIfNeeded(match.id, MIN_AI_MOVE_INTERVAL_MS)
  }
  res.json({ match: await normalizeMatchForResponse(match) })
})

app.get('/api/stats/overview', async (_req, res) => {
  const matches = await store.listMatches()
  const finished = matches.filter((item) => item.status === 'finished')

  const overview = {
    totalMatches: matches.length,
    ongoingMatches: matches.length - finished.length,
    finishedMatches: finished.length,
    redWins: finished.filter((item) => item.result === 'red').length,
    blackWins: finished.filter((item) => item.result === 'black').length,
    draws: finished.filter((item) => item.result === 'draw').length,
    totalMoves: matches.reduce((acc, item) => acc + item.moves.length, 0),
  }

  res.json({ overview })
})

app.get('/api/rankings', async (_req, res) => {
  const [users, matches] = await Promise.all([store.listUsers(), store.listMatches()])
  const userById = new Map(users.map((user) => [user.id, user]))
  const finished = matches
    .filter((item) => item.status === 'finished')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const stats = new Map<
    string,
    {
      userId: string
      username: string
      registeredAt: string
      wins: number
      losses: number
      draws: number
      games: number
      points: number
      reachedAt: string
    }
  >()

  users.forEach((user) => {
    stats.set(user.id, {
      userId: user.id,
      username: user.username,
      registeredAt: user.createdAt,
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      points: 0,
      reachedAt: user.createdAt,
    })
  })

  const ensure = (userId: string) => {
    const existing = stats.get(userId)
    if (existing) return existing
    const user = userById.get(userId)
    const createdAt = user?.createdAt ?? new Date(0).toISOString()
    const created = {
      userId,
      username: user?.username ?? userId,
      registeredAt: user?.createdAt ?? createdAt,
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      points: 0,
      reachedAt: createdAt,
    }
    stats.set(userId, created)
    return created
  }

  const addPoints = (userId: string, delta: number, reachedAt: string) => {
    const row = ensure(userId)
    if (delta <= 0) return row
    row.points += delta
    row.reachedAt = reachedAt
    return row
  }

  finished.forEach((match) => {
    const redUserId = match.red.type === 'user' ? match.red.userId : undefined
    const blackUserId = match.black.type === 'user' ? match.black.userId : undefined
    const reachedAt = match.updatedAt

    if (!redUserId && !blackUserId) return

    if (redUserId) ensure(redUserId).games += 1
    if (blackUserId) ensure(blackUserId).games += 1

    if (match.result === 'draw') {
      if (redUserId) {
        const row = ensure(redUserId)
        row.draws += 1
        addPoints(redUserId, 1, reachedAt)
      }
      if (blackUserId) {
        const row = ensure(blackUserId)
        row.draws += 1
        addPoints(blackUserId, 1, reachedAt)
      }
      return
    }

    if (match.result === 'red') {
      if (redUserId) {
        const row = ensure(redUserId)
        row.wins += 1
        addPoints(redUserId, 3, reachedAt)
      }
      if (blackUserId) ensure(blackUserId).losses += 1
      return
    }

    if (match.result === 'black') {
      if (blackUserId) {
        const row = ensure(blackUserId)
        row.wins += 1
        addPoints(blackUserId, 3, reachedAt)
      }
      if (redUserId) ensure(redUserId).losses += 1
    }
  })

  const ranking = [...stats.values()]
    .map((row) => ({
      ...row,
      winRate: row.games > 0 ? Number(((row.wins / row.games) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.points - a.points || a.reachedAt.localeCompare(b.reachedAt) || a.username.localeCompare(b.username))

  res.json({ ranking })
})

const startServer = async () => {
  await store.init()
  app.listen(PORT, () => {
    console.log(`FlipChess server listening at http://localhost:${PORT}`)
  })
}

void startServer().catch((error) => {
  console.error('Failed to start FlipChess server:', error)
  process.exit(1)
})
