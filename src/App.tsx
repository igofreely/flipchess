import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './App.css'
import { createInitialGame, getPieceLabel, playMove, selectCell } from './game/engine'
import type { GameState, Piece, PieceType, Position, Side } from './game/types'
import { createWorkerAiProvider, type AiProvider } from './game/ai-provider'
import { createHttpAiProvider } from './game/ai-provider-http'
import { SERVER_API_BASE, serverApi, type RankingItem, type ServerMatch, type ServerUser } from './server/api'
import { playSound } from './sound/effects'

const aliveCount = (game: GameState) =>
  Object.values(game.pieces).filter((piece) => piece.alive).length

const cloneGameState = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState
const MIN_AI_DEPTH = 1
const MAX_AI_DEPTH = 8
const AI_TIME_BUDGET_OPTIONS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]
const PIKAFISH_MAX_THINK_OPTIONS = [2000, 3000, 5000, 8000, 10000, 12000, 15000, 20000]
const DEFAULT_AI_DEPTH = 5
const DEFAULT_AI_BUDGET = 3000
const DEFAULT_PIKAFISH_MAX_THINK_MS = 12000
const SERVER_POLL_INTERVAL_MS = 900
const AI_HTTP_RETRY_DELAY_MS = 500
const AI_HTTP_MAX_RETRIES = 8

interface MoveLogItem {
  id: number
  side: Side
  actor: 'ai' | 'human'
  aiEngine?: 'pikafish' | 'builtin'
  pieceText: string
  from: Position
  to: Position
  thinkMs: number
}

interface LineCoords {
  x1: number
  y1: number
  x2: number
  y2: number
}

const BOARD_ROWS = 10
const BOARD_COLS = 9

const sideText = (side: Side) => (side === 'red' ? '红方' : '黑方')
const nowMs = () => Date.now()
const aiEngineText = (engine?: 'pikafish' | 'builtin') => (engine === 'pikafish' ? 'Pikafish' : '本地AI')
const localPlayerText = (aiEnabled: boolean, engine?: 'pikafish' | 'builtin') => {
  if (!aiEnabled) return '本地玩家'
  if (!engine) return 'AI(自动)'
  return `AI(${aiEngineText(engine)})`
}

const actorText = (actor: MoveLogItem['actor']) => (actor === 'ai' ? 'AI' : '人类')
const oppositeSide = (side: Side): Side => (side === 'red' ? 'black' : 'red')
const mirrorPos = (pos: Position): Position => ({ row: BOARD_ROWS - 1 - pos.row, col: BOARD_COLS - 1 - pos.col })
const swapMessageSides = (message: string) => message.replace(/红方/g, '__RED_SIDE__').replace(/黑方/g, '红方').replace(/__RED_SIDE__/g, '黑方')

const swapLocalGameStateSides = (state: GameState): GameState => {
  const next = cloneGameState(state)
  const board: (string | null)[][] = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null))

  for (const piece of Object.values(next.pieces)) {
    piece.side = oppositeSide(piece.side)
    piece.currentPos = mirrorPos(piece.currentPos)
    piece.bornPos = mirrorPos(piece.bornPos)
    if (piece.alive) {
      board[piece.currentPos.row][piece.currentPos.col] = piece.id
    }
  }

  next.board = board
  next.turn = oppositeSide(next.turn)
  next.winner = next.winner ? oppositeSide(next.winner) : null
  next.selected = next.selected ? mirrorPos(next.selected) : null
  next.legalMoves = next.legalMoves.map((pos) => mirrorPos(pos))
  next.message = swapMessageSides(next.message)
  next.positionHistory = []
  next.checkHistory = []

  return next
}

const posText = (pos: Position) => `(${pos.row},${pos.col})`

const decodeBase64Utf8 = (base64: string) => {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const parseUserIdFromToken = (token: string | null): string | null => {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const normalized = payload + '='.repeat((4 - (payload.length % 4 || 4)) % 4)
    const decoded = decodeBase64Utf8(normalized)
    const parsed = JSON.parse(decoded) as { userId?: unknown }
    return typeof parsed.userId === 'string' && parsed.userId.length > 0 ? parsed.userId : null
  } catch {
    return null
  }
}

const getUserSideInMatch = (match: ServerMatch, userId: string | null): Side | null => {
  if (!userId) return null
  if (match.red.type === 'user' && match.red.userId === userId) return 'red'
  if (match.black.type === 'user' && match.black.userId === userId) return 'black'
  return null
}

const FEN_PIECE_TYPES: Record<string, PieceType> = {
  k: 'king', a: 'advisor', b: 'elephant', n: 'horse', r: 'rook', c: 'cannon', p: 'pawn',
}

const PIECE_TO_FEN: Record<PieceType, string> = {
  king: 'k', advisor: 'a', elephant: 'b', horse: 'n', rook: 'r', cannon: 'c', pawn: 'p',
}

const gameStateToFen = (state: GameState): string => {
  const rows: string[] = []
  for (let row = 0; row < 10; row += 1) {
    let fenRow = ''
    let emptyCount = 0
    for (let col = 0; col < 9; col += 1) {
      const id = state.board[row][col]
      if (!id) { emptyCount += 1; continue }
      if (emptyCount > 0) { fenRow += String(emptyCount); emptyCount = 0 }
      const piece = state.pieces[id]
      if (!piece) { fenRow += '1'; continue }
      if (!piece.isRevealed) {
        fenRow += piece.side === 'red' ? 'X' : 'x'
      } else {
        const base = PIECE_TO_FEN[piece.realType] ?? 'p'
        fenRow += piece.side === 'red' ? base.toUpperCase() : base
      }
    }
    if (emptyCount > 0) fenRow += String(emptyCount)
    rows.push(fenRow)
  }

  // pool: unrevealed alive pieces
  const counts = new Map<string, number>()
  for (const piece of Object.values(state.pieces)) {
    if (!piece.alive || piece.isRevealed) continue
    const lower = PIECE_TO_FEN[piece.realType] ?? 'p'
    const key = piece.side === 'red' ? lower.toUpperCase() : lower
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const poolOrder = ['A', 'B', 'N', 'R', 'C', 'P', 'a', 'b', 'n', 'r', 'c', 'p']
  const poolParts: string[] = []
  for (const k of poolOrder) {
    const n = counts.get(k) ?? 0
    if (n > 0) poolParts.push(`${k}${n}`)
  }
  const poolText = poolParts.join('') || '-'
  const sideText = state.turn === 'red' ? 'w' : 'b'
  const halfmove = Math.max(0, Math.floor(state.quietMoveCount))
  const fullmove = Math.max(1, Math.floor(state.moveCount / 2) + 1)

  return `${rows.join('/')} ${sideText} ${poolText} ${halfmove} ${fullmove}`
}

const fenToGameState = (fen: string): GameState | null => {
  const parts = fen.trim().split(/\s+/)
  if (parts.length < 3) return null

  const boardPart = parts[0]
  const sidePart = parts[1]
  const poolPart = parts[2]
  const halfmove = parts.length > 3 ? Number(parts[3]) : 0
  const fullmove = parts.length > 4 ? Number(parts[4]) : 1

  const turn: Side = sidePart === 'b' ? 'black' : 'red'
  const boardRows = boardPart.split('/')
  if (boardRows.length !== 10) return null

  // Parse pool into type arrays per side
  const redPool: PieceType[] = []
  const blackPool: PieceType[] = []
  if (poolPart !== '-') {
    const poolTokens = [...poolPart.matchAll(/([A-Za-z])(\d+)/g)]
    for (const tok of poolTokens) {
      const ch = tok[1]
      const count = Number(tok[2])
      const isRed = ch === ch.toUpperCase()
      const pieceType = FEN_PIECE_TYPES[ch.toLowerCase()]
      if (!pieceType) return null
      const target = isRed ? redPool : blackPool
      for (let i = 0; i < count; i++) target.push(pieceType)
    }
    // Shuffle pools so hidden piece assignment is random
    for (const pool of [redPool, blackPool]) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]]
      }
    }
  }

  const board: (string | null)[][] = Array.from({ length: 10 }, () => Array(9).fill(null) as (string | null)[])
  const pieces: Record<string, Piece> = {}
  let pieceIdx = 0
  let redPoolIdx = 0
  let blackPoolIdx = 0

  for (let row = 0; row < 10; row += 1) {
    let col = 0
    for (const ch of boardRows[row]) {
      if (col >= 9) break
      if (ch >= '1' && ch <= '9') {
        col += Number(ch)
        continue
      }

      const pos: Position = { row, col }
      const id = `fen-${pieceIdx++}`

      if (ch === 'X' || ch === 'x') {
        const side: Side = ch === 'X' ? 'red' : 'black'
        const pool = side === 'red' ? redPool : blackPool
        const poolIdx = side === 'red' ? redPoolIdx : blackPoolIdx
        const realType = pool[poolIdx] ?? 'pawn'
        if (side === 'red') redPoolIdx++; else blackPoolIdx++
        pieces[id] = {
          id, side, realType,
          bornType: realType,
          isRevealed: false,
          bornPos: { ...pos }, currentPos: { ...pos },
          alive: true,
        }
      } else {
        const isRed = ch === ch.toUpperCase()
        const side: Side = isRed ? 'red' : 'black'
        const pieceType = FEN_PIECE_TYPES[ch.toLowerCase()]
        if (!pieceType) return null
        pieces[id] = {
          id, side, realType: pieceType,
          bornType: pieceType,
          isRevealed: true,
          bornPos: { ...pos }, currentPos: { ...pos },
          alive: true,
        }
      }
      board[row][col] = id
      col += 1
    }
  }

  const moveCount = Math.max(0, (fullmove - 1) * 2 + (turn === 'black' ? 1 : 0))

  const state: GameState = {
    board, pieces, turn,
    selected: null, legalMoves: [],
    winner: null, isDraw: false,
    quietMoveCount: Number.isFinite(halfmove) ? halfmove : 0,
    moveCount: Number.isFinite(moveCount) ? moveCount : 0,
    message: turn === 'red' ? '轮到红方' : '轮到黑方',
    positionHistory: [],
    checkHistory: [],
  }
  return state
}

const isGameStateLike = (value: unknown): value is GameState => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<GameState>
  return (
    Array.isArray(candidate.board) &&
    typeof candidate.pieces === 'object' &&
    (candidate.turn === 'red' || candidate.turn === 'black') &&
    typeof candidate.moveCount === 'number' &&
    typeof candidate.isDraw === 'boolean' &&
    typeof candidate.quietMoveCount === 'number'
  )
}



const formatDurationMs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`
const formatThinkMs = (ms: number | null) => (ms === null ? '--' : formatDurationMs(ms))
const formatDateTime = (value: string) => {
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return value
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const inferMoveInfo = (prev: GameState, next: GameState, mover: Side) => {
  for (const id of Object.keys(prev.pieces)) {
    const pPrev = prev.pieces[id]
    const pNext = next.pieces[id]
    if (!pPrev || !pNext) continue
    if (pPrev.side !== mover || !pPrev.alive || !pNext.alive) continue
    const moved = pPrev.currentPos.row !== pNext.currentPos.row || pPrev.currentPos.col !== pNext.currentPos.col
    if (!moved) continue
    return {
      pieceId: id,
      from: { ...pPrev.currentPos },
      to: { ...pNext.currentPos },
    }
  }
  return null
}

const computeLastThinkMap = (logs: MoveLogItem[]): Record<Side, number | null> => {
  const redLog = [...logs].reverse().find((log) => log.side === 'red')
  const blackLog = [...logs].reverse().find((log) => log.side === 'black')
  return {
    red: redLog?.thinkMs ?? null,
    black: blackLog?.thinkMs ?? null,
  }
}

const SERVER_TOKEN_KEY = 'flipchess.server.token'
const PLAY_MODE_KEY = 'flipchess.play.mode'
const ACTIVE_MATCH_KEY = 'flipchess.server.activeMatchId'
const LOCAL_SNAPSHOT_KEY = 'flipchess.local.snapshot'

interface LocalSnapshot {
  game: GameState
  timeline: GameState[]
  moveLogs: MoveLogItem[]
  lastThinkBySide: Record<Side, number | null>
  boardFlipped: boolean
  soundOn: boolean
  aiEnabledBySide: Record<Side, boolean>
  aiPikafishEnabledBySide: Record<Side, boolean>
  aiNoFallbackBySide?: Record<Side, boolean>
  aiPikafishMaxThinkBySide: Record<Side, number>
  aiDepthBySide: Record<Side, number>
  aiTimeBudgetBySide: Record<Side, number>
  drawOfferBySide: Record<Side, boolean>
  isReplayMode: boolean
  replayIndex: number
}

const mapServerMovesToLogs = (moves: ServerMatch['moves'], matchCreatedAt?: string): MoveLogItem[] => {
  let prevAt = matchCreatedAt ? Date.parse(matchCreatedAt) : Number.NaN

  return moves.map((item) => {
    const nowAt = Date.parse(item.createdAt)
    const thinkMs = Number.isFinite(nowAt) && Number.isFinite(prevAt) ? Math.max(0, nowAt - prevAt) : 0
    prevAt = nowAt

    return {
      id: item.ply,
      side: item.side,
      actor: item.actor === 'ai' ? 'ai' : 'human',
      aiEngine: item.aiEngine,
      pieceText: item.pieceText,
      from: { ...item.from },
      to: { ...item.to },
      thinkMs,
    }
  })
}

function App() {
  const initialGame = useMemo(() => createInitialGame(), [])
  const [game, setGame] = useState(() => initialGame)
  const [soundOn, setSoundOn] = useState(true)
  const [boardFlipped, setBoardFlipped] = useState(false)
  const [aiEnabledBySide, setAiEnabledBySide] = useState<Record<Side, boolean>>({ red: false, black: false })
  const [aiPikafishEnabledBySide, setAiPikafishEnabledBySide] = useState<Record<Side, boolean>>({ red: false, black: false })
  const [aiPikafishMaxThinkBySide, setAiPikafishMaxThinkBySide] = useState<Record<Side, number>>({
    red: DEFAULT_PIKAFISH_MAX_THINK_MS,
    black: DEFAULT_PIKAFISH_MAX_THINK_MS,
  })
  const [aiDepthBySide, setAiDepthBySide] = useState<Record<Side, number>>({
    red: DEFAULT_AI_DEPTH,
    black: DEFAULT_AI_DEPTH,
  })
  const [aiTimeBudgetBySide, setAiTimeBudgetBySide] = useState<Record<Side, number>>({
    red: DEFAULT_AI_BUDGET,
    black: DEFAULT_AI_BUDGET,
  })
  const [drawOfferBySide, setDrawOfferBySide] = useState<Record<Side, boolean>>({ red: false, black: false })
  const [moveLogs, setMoveLogs] = useState<MoveLogItem[]>([])
  const [lastThinkBySide, setLastThinkBySide] = useState<Record<Side, number | null>>({ red: null, black: null })
  const [timeline, setTimeline] = useState<GameState[]>(() => [cloneGameState(initialGame)])
  const [isReplayMode, setIsReplayMode] = useState(false)
  const [replayIndex, setReplayIndex] = useState(0)
  const [actionsCollapsed, setActionsCollapsed] = useState(false)
  const [playMode, setPlayMode] = useState<'local' | 'server'>(() => {
    const raw = localStorage.getItem(PLAY_MODE_KEY)
    return raw === 'server' ? 'server' : 'local'
  })
  const [serverToken, setServerToken] = useState<string | null>(() => localStorage.getItem(SERVER_TOKEN_KEY))
  const [serverUser, setServerUser] = useState<ServerUser | null>(null)
  const [serverSessionHydrating, setServerSessionHydrating] = useState(() => !!localStorage.getItem(SERVER_TOKEN_KEY))
  const [serverMatches, setServerMatches] = useState<ServerMatch[]>([])
  const [activeMatchId, setActiveMatchId] = useState<string | null>(() => localStorage.getItem(ACTIVE_MATCH_KEY))
  const [showAllMatches, setShowAllMatches] = useState(false)
  const [rankings, setRankings] = useState<RankingItem[]>([])
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [createMode, setCreateMode] = useState<'pvp' | 'vs_ai' | 'ai_vs_ai'>('vs_ai')
  const [createOpponent, setCreateOpponent] = useState('')
  const [createAiSide, setCreateAiSide] = useState<Side>('black')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverMessage, setServerMessage] = useState('')
  const [localAiLockMessage, setLocalAiLockMessage] = useState('')
  const [localAiLockProbeMessage, setLocalAiLockProbeMessage] = useState('')
  const [aiInteractionTrace, setAiInteractionTrace] = useState<string[]>([])
  const [serverView, setServerView] = useState<'match' | 'ranking'>('match')
  const [clockNowMs, setClockNowMs] = useState(() => nowMs())
  const [aiProviderMode, setAiProviderMode] = useState<'worker' | 'http' | 'auto'>('auto')
  const aiWorkerProviderRef = useRef<AiProvider | null>(null)
  const aiHttpProviderRef = useRef<AiProvider | null>(null)
  const aiSearchTokenRef = useRef(0)
  const aiRetryCountRef = useRef<Record<Side, number>>({ red: 0, black: 0 })
  const [aiSearchRetryTick, setAiSearchRetryTick] = useState(0)
  const fenInputRef = useRef<HTMLInputElement | null>(null)
  const serverFenInputRef = useRef<HTMLInputElement | null>(null)
  const turnStartAtRef = useRef(0)
  const latestGameRef = useRef(game)
  const latestTimelineRef = useRef(timeline)
  const soundOnRef = useRef(soundOn)
  const activeServerMatchRef = useRef<ServerMatch | null>(null)
  const activeMatchIdRef = useRef(activeMatchId)
  const serverBootstrapRequestRef = useRef(0)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [lastMoveLine, setLastMoveLine] = useState<LineCoords | null>(null)
  const localHydratedRef = useRef(false)

  const displayedGame = isReplayMode && timeline[replayIndex] ? timeline[replayIndex] : game
  const activeMatch = useMemo(
    () => (activeMatchId ? serverMatches.find((match) => match.id === activeMatchId) ?? null : null),
    [activeMatchId, serverMatches],
  )
  const isServerMode = playMode === 'server'
  const serverUserId = serverUser?.id ?? parseUserIdFromToken(serverToken)
  const myServerSide: Side | null =
    activeMatch && serverUserId
      ? activeMatch.red.type === 'user' && activeMatch.red.userId === serverUserId
        ? 'red'
        : activeMatch.black.type === 'user' && activeMatch.black.userId === serverUserId
          ? 'black'
          : null
      : null
  const pendingUndoFromOpponent =
    !!activeMatch && !!myServerSide && !!activeMatch.undoRequest && activeMatch.undoRequest.fromSide !== myServerSide
  const isMyServerTurn = !!activeMatch && !!myServerSide && activeMatch.status === 'ongoing' && game.turn === myServerSide
  const isRankingView = isServerMode && serverView === 'ranking'
  const effectiveBoardFlipped = isServerMode ? myServerSide === 'black' : boardFlipped
  const statusDrawBySide = isServerMode && activeMatch ? activeMatch.drawOfferBySide : drawOfferBySide
  const statusUndoText = isServerMode && activeMatch?.undoRequest ? `${sideText(activeMatch.undoRequest.fromSide)} 请求中` : '无'
  const localLastAiEngineBySide: Record<Side, 'pikafish' | 'builtin' | undefined> = {
    red: [...moveLogs].reverse().find((log) => log.actor === 'ai' && log.side === 'red')?.aiEngine,
    black: [...moveLogs].reverse().find((log) => log.actor === 'ai' && log.side === 'black')?.aiEngine,
  }
  const localAiSourceBySide: Record<Side, string> = {
    red: !aiEnabledBySide.red ? 'AI关闭' : localLastAiEngineBySide.red ? aiEngineText(localLastAiEngineBySide.red) : '未触发',
    black: !aiEnabledBySide.black ? 'AI关闭' : localLastAiEngineBySide.black ? aiEngineText(localLastAiEngineBySide.black) : '未触发',
  }
  const localAiSourceSummary = `红方${localAiSourceBySide.red} / 黑方${localAiSourceBySide.black}`
  const aiThinkingSide: Side | null = !isReplayMode && !game.winner && !game.isDraw && aiEnabledBySide[game.turn] ? game.turn : null
  const serverAiEnabledBySide: Record<Side, boolean> = {
    red: createMode === 'ai_vs_ai' ? true : createMode === 'vs_ai' ? createAiSide === 'red' : activeMatch ? activeMatch.red.type === 'ai' : true,
    black: createMode === 'ai_vs_ai' ? true : createMode === 'vs_ai' ? createAiSide === 'black' : activeMatch ? activeMatch.black.type === 'ai' : true,
  }
  const serverAiDepthBySide: Record<Side, number> = {
    red: activeMatch ? activeMatch.red.aiDepth : aiDepthBySide.red,
    black: activeMatch ? activeMatch.black.aiDepth : aiDepthBySide.black,
  }
  const serverAiTimeBudgetBySide: Record<Side, number> = {
    red: activeMatch ? activeMatch.red.aiTimeBudgetMs : aiTimeBudgetBySide.red,
    black: activeMatch ? activeMatch.black.aiTimeBudgetMs : aiTimeBudgetBySide.black,
  }
  const serverAiPikafishEnabledBySide: Record<Side, boolean> = {
    red: activeMatch ? activeMatch.red.aiEngine === 'pikafish' : aiPikafishEnabledBySide.red,
    black: activeMatch ? activeMatch.black.aiEngine === 'pikafish' : aiPikafishEnabledBySide.black,
  }
  const serverAiPikafishMaxThinkBySide: Record<Side, number> = {
    red: activeMatch ? activeMatch.red.aiPikafishMaxThinkMs ?? DEFAULT_PIKAFISH_MAX_THINK_MS : aiPikafishMaxThinkBySide.red,
    black: activeMatch ? activeMatch.black.aiPikafishMaxThinkMs ?? DEFAULT_PIKAFISH_MAX_THINK_MS : aiPikafishMaxThinkBySide.black,
  }
  const serverPlayerText = (side: Side): string => {
    if (activeMatch) {
      const slot = side === 'red' ? activeMatch.red : activeMatch.black
      return slot.type === 'user' ? (slot.username ?? '未知用户') : `AI(${aiEngineText(slot.aiEngine)})`
    }
    if (!serverAiEnabledBySide[side]) return '玩家'
    return `AI(${serverAiPikafishEnabledBySide[side] ? 'Pikafish' : '本地AI'})`
  }
  const statusRedPlayer = isServerMode ? serverPlayerText('red') : localPlayerText(aiEnabledBySide.red, localLastAiEngineBySide.red)
  const statusBlackPlayer = isServerMode ? serverPlayerText('black') : localPlayerText(aiEnabledBySide.black, localLastAiEngineBySide.black)
  const statusSummaryText = `提和状态：红${statusDrawBySide.red ? '已提' : '未提'} / 黑${statusDrawBySide.black ? '已提' : '未提'} ｜ 悔棋请求：${statusUndoText} ｜ 双方：红方${statusRedPlayer} / 黑方${statusBlackPlayer}`
  const currentUserRank = serverUser ? rankings.findIndex((item) => item.userId === serverUser.id) + 1 : 0

  const legalKeySet = useMemo(() => {
    return new Set(displayedGame.legalMoves.map((m) => `${m.row}-${m.col}`))
  }, [displayedGame.legalMoves])

  useEffect(() => {
    latestGameRef.current = game
  }, [game])

  useEffect(() => {
    latestTimelineRef.current = timeline
  }, [timeline])

  useEffect(() => {
    if (playMode !== 'local') {
      localHydratedRef.current = true
      return
    }

    const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY)
    if (!raw) {
      localHydratedRef.current = true
      return
    }

    try {
      const parsed = JSON.parse(raw) as Partial<LocalSnapshot>
      if (!parsed.game || !parsed.timeline || !parsed.moveLogs) {
        localHydratedRef.current = true
        return
      }

      if (!isGameStateLike(parsed.game) || !Array.isArray(parsed.timeline) || !parsed.timeline.every(isGameStateLike)) {
        localHydratedRef.current = true
        return
      }

      setGame(cloneGameState(parsed.game))
      setTimeline(parsed.timeline.map((item) => cloneGameState(item)))
      setMoveLogs(parsed.moveLogs)
      setLastThinkBySide(parsed.lastThinkBySide ?? { red: null, black: null })
      setBoardFlipped(parsed.boardFlipped ?? false)
      setSoundOn(parsed.soundOn ?? true)
      setAiEnabledBySide(parsed.aiEnabledBySide ?? { red: false, black: false })
      setAiPikafishEnabledBySide(parsed.aiPikafishEnabledBySide ?? parsed.aiNoFallbackBySide ?? { red: false, black: false })
      setAiPikafishMaxThinkBySide(
        parsed.aiPikafishMaxThinkBySide ?? { red: DEFAULT_PIKAFISH_MAX_THINK_MS, black: DEFAULT_PIKAFISH_MAX_THINK_MS },
      )
      setAiDepthBySide(parsed.aiDepthBySide ?? { red: DEFAULT_AI_DEPTH, black: DEFAULT_AI_DEPTH })
      setAiTimeBudgetBySide(parsed.aiTimeBudgetBySide ?? { red: DEFAULT_AI_BUDGET, black: DEFAULT_AI_BUDGET })
      setDrawOfferBySide(parsed.drawOfferBySide ?? { red: false, black: false })
      setIsReplayMode(parsed.isReplayMode ?? false)
      setReplayIndex(Math.max(0, Math.min(parsed.replayIndex ?? 0, parsed.timeline.length - 1)))
    } catch {
      // ignore malformed snapshot
    } finally {
      localHydratedRef.current = true
    }
  }, [playMode])

  useEffect(() => {
    localStorage.setItem(PLAY_MODE_KEY, playMode)
  }, [playMode])

  useEffect(() => {
    if (serverToken) {
      localStorage.setItem(SERVER_TOKEN_KEY, serverToken)
    } else {
      localStorage.removeItem(SERVER_TOKEN_KEY)
    }
  }, [serverToken])

  useEffect(() => {
    activeMatchIdRef.current = activeMatchId
    if (activeMatchId) {
      localStorage.setItem(ACTIVE_MATCH_KEY, activeMatchId)
    } else {
      localStorage.removeItem(ACTIVE_MATCH_KEY)
    }
  }, [activeMatchId])

  useEffect(() => {
    if (!localHydratedRef.current) return
    if (playMode !== 'local') return

    const snapshot: LocalSnapshot = {
      game: cloneGameState(game),
      timeline: timeline.map((item) => cloneGameState(item)),
      moveLogs,
      lastThinkBySide,
      boardFlipped,
      soundOn,
      aiEnabledBySide,
      aiPikafishEnabledBySide,
      aiPikafishMaxThinkBySide,
      aiDepthBySide,
      aiTimeBudgetBySide,
      drawOfferBySide,
      isReplayMode,
      replayIndex,
    }
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot))
  }, [
    playMode,
    game,
    timeline,
    moveLogs,
    lastThinkBySide,
    boardFlipped,
    soundOn,
    aiEnabledBySide,
    aiPikafishEnabledBySide,
    aiPikafishMaxThinkBySide,
    aiDepthBySide,
    aiTimeBudgetBySide,
    drawOfferBySide,
    isReplayMode,
    replayIndex,
  ])

  useEffect(() => {
    if (playMode !== 'server') return
    if (isReplayMode) {
      setIsReplayMode(false)
      setReplayIndex(0)
    }
  }, [playMode, isReplayMode])

  useEffect(() => {
    turnStartAtRef.current = nowMs()
  }, [])

  useEffect(() => {
    soundOnRef.current = soundOn
  }, [soundOn])

  useEffect(() => {
    activeServerMatchRef.current = activeMatch
  }, [activeMatch])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockNowMs(nowMs())
    }, 250)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!aiPikafishEnabledBySide.red) {
      aiRetryCountRef.current.red = 0
    }
    if (!aiPikafishEnabledBySide.black) {
      aiRetryCountRef.current.black = 0
    }
    if (aiPikafishEnabledBySide.red || aiPikafishEnabledBySide.black) return
    setLocalAiLockMessage('')
  }, [aiPikafishEnabledBySide])

  useEffect(() => {
    const providerKind = (import.meta.env.VITE_AI_PROVIDER ?? 'auto').toString().toLowerCase()
    const endpointFromEnv = String(import.meta.env.VITE_AI_HTTP_ENDPOINT ?? '').trim()
    const endpoint = endpointFromEnv || `${SERVER_API_BASE}/ai/search`
    const timeoutMs = Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS ?? 12_000)

    const mode: 'worker' | 'http' | 'auto' =
      providerKind === 'worker' || providerKind === 'http' ? providerKind : 'auto'
    setAiProviderMode(mode)

    const workerProvider = createWorkerAiProvider()
    const httpProvider = mode === 'worker' ? null : createHttpAiProvider({ endpoint, timeoutMs })

    aiWorkerProviderRef.current = workerProvider
    aiHttpProviderRef.current = httpProvider

    return () => {
      aiWorkerProviderRef.current?.dispose()
      aiHttpProviderRef.current?.dispose()
      aiWorkerProviderRef.current = null
      aiHttpProviderRef.current = null
    }
  }, [])

  useEffect(() => {
    if (playMode !== 'local') return

    const probeLockCapability = async () => {
      const endpoint = `${SERVER_API_BASE}/health`
      try {
        const response = await fetch(endpoint, { method: 'GET' })
        if (!response.ok) {
          setLocalAiLockProbeMessage(`Pikafish启用能力检测失败：后端健康检查HTTP ${response.status}`)
          return
        }

        const payload = (await response.json()) as {
          ai?: { supportsNoFallback?: unknown; supportsNoLimit?: unknown }
        }
        const supportsNoFallback = payload.ai?.supportsNoFallback === true
        const supportsNoLimit = payload.ai?.supportsNoLimit === true
        if (supportsNoFallback && supportsNoLimit) {
          setLocalAiLockProbeMessage('')
          return
        }

        setLocalAiLockProbeMessage('当前后端不支持“开启Pikafish”选项，请重启后端到最新代码')
      } catch (error) {
        const detail = error instanceof Error && error.message ? `：${error.message}` : ''
        setLocalAiLockProbeMessage(`Pikafish启用能力检测失败，后端不可达${detail}`)
      }
    }

    void probeLockCapability()
  }, [playMode])

  const appendAiTrace = useCallback((lines: string[]) => {
    if (lines.length === 0) return
    const normalized = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`)
    if (normalized.length === 0) return

    setAiInteractionTrace((prev) => [...prev, ...normalized].slice(-120))
  }, [])

  const applyServerMatch = useCallback((match: ServerMatch) => {
    const prevMatch = activeServerMatchRef.current
    if (soundOnRef.current && prevMatch && prevMatch.id === match.id) {
      const moved = match.moves.length > prevMatch.moves.length || match.state.moveCount > prevMatch.state.moveCount
      if (moved) {
        const capture = aliveCount(match.state) < aliveCount(prevMatch.state)
        const checkedNow = match.state.message.includes('被将军') && !prevMatch.state.message.includes('被将军')
        const wonNow = (!prevMatch.state.winner && !!match.state.winner) || (!prevMatch.state.isDraw && match.state.isDraw)

        if (wonNow) {
          void playSound('win')
        } else if (checkedNow) {
          void playSound('check')
        } else if (capture) {
          void playSound('capture')
        } else {
          void playSound('move')
        }
      }
    }

    const drawAgreedNow =
      match.status === 'finished' &&
      match.result === 'draw' &&
      !!match.termination &&
      match.termination.includes('协议和棋') &&
      (!prevMatch ||
        prevMatch.id !== match.id ||
        prevMatch.status !== 'finished' ||
        prevMatch.result !== 'draw' ||
        prevMatch.termination !== match.termination)

    const undoAcceptedNow =
      !!prevMatch &&
      prevMatch.id === match.id &&
      !!prevMatch.undoRequest &&
      !match.undoRequest &&
      (match.state.moveCount < prevMatch.state.moveCount || match.moves.length < prevMatch.moves.length)

    if (drawAgreedNow) {
      setServerMessage('提和已达成，当前对局和棋')
    } else if (undoAcceptedNow) {
      setServerMessage('悔棋已同意，已回退一步')
    }

    setServerMatches((prev) => {
      const idx = prev.findIndex((item) => item.id === match.id)
      if (idx < 0) return [match, ...prev]
      const next = [...prev]
      next[idx] = match
      return next
    })
    setActiveMatchId(match.id)

    const latestGame = latestGameRef.current
    const currentUserId = serverUser?.id ?? parseUserIdFromToken(serverToken)
    const incomingMySide = getUserSideInMatch(match, currentUserId)
    const incomingMyTurn = !!incomingMySide && match.status === 'ongoing' && match.state.turn === incomingMySide
    const noNewMove = match.state.moveCount === latestGame.moveCount
    const shouldResetTurnStart = !prevMatch || prevMatch.id !== match.id || match.state.turn !== latestGame.turn || !noNewMove
    const preserveLocalInteraction = incomingMyTurn && noNewMove

    if (!preserveLocalInteraction) {
      setGame(cloneGameState(match.state))
      setTimeline([cloneGameState(match.state)])
      setReplayIndex(0)
      setIsReplayMode(false)
      const logs = mapServerMovesToLogs(match.moves, match.createdAt)
      setMoveLogs(logs)
      setLastThinkBySide(computeLastThinkMap(logs))
      setDrawOfferBySide({ red: false, black: false })
      if (shouldResetTurnStart) {
        turnStartAtRef.current = nowMs()
      }
    }

    activeServerMatchRef.current = match
  }, [serverToken, serverUser?.id])

  const refreshRankings = async () => {
    try {
      const data = await serverApi.rankings()
      setRankings(data.ranking)
    } catch {
      setRankings([])
    }
  }

  useEffect(() => {
    if (!serverToken) {
      setServerSessionHydrating(false)
      setServerUser(null)
      setServerMatches([])
      setActiveMatchId(null)
      setRankings([])
      return
    }

    setServerSessionHydrating(true)

    const requestId = serverBootstrapRequestRef.current + 1
    serverBootstrapRequestRef.current = requestId
    let cancelled = false

    void (async () => {
      try {
        const me = await serverApi.me(serverToken)
        if (cancelled || requestId !== serverBootstrapRequestRef.current) return
        setServerUser(me.user)

        const data = await serverApi.listMatches(serverToken, true)
        if (cancelled || requestId !== serverBootstrapRequestRef.current) return
        setServerMatches(data.matches)

        if (data.matches.length > 0) {
          const currentActiveId = activeMatchIdRef.current
          const preferredMatch = currentActiveId ? data.matches.find((item) => item.id === currentActiveId) : undefined
          const nextMatch = preferredMatch ?? data.matches[0]
          applyServerMatch(nextMatch)
        } else {
          setActiveMatchId(null)
        }

        await refreshRankings()
        if (cancelled || requestId !== serverBootstrapRequestRef.current) return
        setServerSessionHydrating(false)
      } catch (error) {
        if (cancelled || requestId !== serverBootstrapRequestRef.current) return
        setServerMessage(error instanceof Error ? error.message : '服务器连接失败')
        setServerSessionHydrating(false)
      }
    })()

    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverToken, applyServerMatch])

  useEffect(() => {
    if (!isServerMode || !serverToken || !activeMatchId) return

    const activeMatchRef_snapshot = activeServerMatchRef.current
    if (activeMatchRef_snapshot?.status === 'finished') return

    let stopped = false
    let inFlight = false

    const poll = () => {
      if (stopped || inFlight) return
      const currentId = activeMatchIdRef.current
      if (!currentId) return
      inFlight = true
      void serverApi
        .getMatch(serverToken, currentId)
        .then((data) => {
          if (!stopped && activeMatchIdRef.current === currentId) {
            applyServerMatch(data.match)
          }
        })
        .catch(() => {
          // silent polling failure
        })
        .finally(() => {
          inFlight = false
        })
    }

    poll()
    const timer = window.setInterval(poll, SERVER_POLL_INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [isServerMode, serverToken, activeMatchId, applyServerMatch])

  const handleRegister = async () => {
    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.register(authUsername.trim(), authPassword)
      setServerToken(data.token)
      localStorage.setItem(SERVER_TOKEN_KEY, data.token)
      setAuthPassword('')
      setServerMessage('注册成功并已登录')
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '注册失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleLogin = async () => {
    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.login(authUsername.trim(), authPassword)
      setServerToken(data.token)
      localStorage.setItem(SERVER_TOKEN_KEY, data.token)
      setAuthPassword('')
      setServerMessage('登录成功')
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '登录失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleLogout = () => {
    setServerToken(null)
    setServerUser(null)
    setServerMatches([])
    setActiveMatchId(null)
    setServerView('match')
    setServerMessage('已退出登录')
    localStorage.removeItem(SERVER_TOKEN_KEY)
  }

  const openRankingPage = async () => {
    setServerView('ranking')
    await refreshRankings()
  }

  const handleCreateMatch = async () => {
    if (!serverToken) return
    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.createMatch(serverToken, {
        mode: createMode,
        opponentUsername: createMode === 'pvp' ? createOpponent.trim() : undefined,
        aiSide: createMode === 'vs_ai' ? createAiSide : undefined,
        aiDepthBySide,
        aiTimeBudgetBySide,
        aiEngineBySide: {
          red: aiPikafishEnabledBySide.red ? 'pikafish' : 'builtin',
          black: aiPikafishEnabledBySide.black ? 'pikafish' : 'builtin',
        },
        aiPikafishMaxThinkBySide,
      })
      applyServerMatch(data.match)
      await refreshRankings()
      setServerMessage('对局创建成功')
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '创建对局失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleImportFenToServer = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    input.value = ''
    if (!file || !serverToken) return

    setServerBusy(true)
    setServerMessage('')
    try {
      const text = await file.text()
      const setupState = fenToGameState(text)
      if (!setupState) {
        setServerMessage('FEN 格式无效，无法建局')
        return
      }

      const data = await serverApi.createMatch(serverToken, {
        mode: createMode,
        opponentUsername: createMode === 'pvp' ? createOpponent.trim() : undefined,
        aiSide: createMode === 'vs_ai' ? createAiSide : undefined,
        aiDepthBySide,
        aiTimeBudgetBySide,
        aiEngineBySide: {
          red: aiPikafishEnabledBySide.red ? 'pikafish' : 'builtin',
          black: aiPikafishEnabledBySide.black ? 'pikafish' : 'builtin',
        },
        aiPikafishMaxThinkBySide,
        fenSetup: setupState,
      })

      applyServerMatch(data.match)
      await refreshRankings()
      setServerMessage('已从 FEN 导入并创建在线对局')
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '导入 FEN 创建对局失败')
    } finally {
      setServerBusy(false)
    }
  }

  const openMatch = async (matchId: string) => {
    if (!serverToken) return
    setServerBusy(true)
    try {
      const data = await serverApi.getMatch(serverToken, matchId)
      applyServerMatch(data.match)
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '加载对局失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleDeleteMatch = async (matchId: string) => {
    if (!serverToken) return
    const ok = window.confirm('确认删除该对局吗？删除后无法恢复。')
    if (!ok) return

    setServerBusy(true)
    setServerMessage('')
    try {
      await serverApi.deleteMatch(serverToken, matchId)
      setServerMatches((prev) => prev.filter((item) => item.id !== matchId))
      if (activeMatchId === matchId) {
        setActiveMatchId(null)
      }
      setServerMessage('对局已删除')
      await refreshRankings()
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '删除对局失败')
    } finally {
      setServerBusy(false)
    }
  }

  const updateServerAiDepth = async (side: Side, delta: number) => {
    if (!activeMatch) {
      if (!serverAiEnabledBySide[side]) return
      setAiDepthBySide((prev) => {
        const nextDepth = Math.max(MIN_AI_DEPTH, Math.min(MAX_AI_DEPTH, prev[side] + delta))
        if (nextDepth === prev[side]) return prev
        return { ...prev, [side]: nextDepth }
      })
      return
    }

    if (!serverToken) return
    const slot = side === 'red' ? activeMatch.red : activeMatch.black
    if (slot.type !== 'ai') return

    const nextDepth = Math.max(MIN_AI_DEPTH, Math.min(MAX_AI_DEPTH, slot.aiDepth + delta))
    if (nextDepth === slot.aiDepth) return

    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.updateMatchAiConfig(serverToken, activeMatch.id, {
        aiDepthBySide: { [side]: nextDepth },
      })
      applyServerMatch(data.match)
      setServerMessage(`${sideText(side)}AI层数已更新为 ${nextDepth}`)
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '更新AI层数失败')
    } finally {
      setServerBusy(false)
    }
  }

  const updateServerAiBudget = async (side: Side, value: string) => {
    const nextBudget = Number(value)
    if (Number.isNaN(nextBudget) || nextBudget <= 0) return

    if (!activeMatch) {
      if (!serverAiEnabledBySide[side]) return
      setAiTimeBudgetBySide((prev) => ({ ...prev, [side]: nextBudget }))
      return
    }

    if (!serverToken) return
    const slot = side === 'red' ? activeMatch.red : activeMatch.black
    if (slot.type !== 'ai') return

    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.updateMatchAiConfig(serverToken, activeMatch.id, {
        aiTimeBudgetBySide: { [side]: nextBudget },
      })
      applyServerMatch(data.match)
      setServerMessage(`${sideText(side)}AI时限已更新为 ${nextBudget}ms`)
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '更新AI时限失败')
    } finally {
      setServerBusy(false)
    }
  }

  const updateServerAiEngine = async (side: Side) => {
    const currentEnabled = serverAiPikafishEnabledBySide[side]
    const nextEngine = currentEnabled ? 'builtin' : 'pikafish'

    if (!activeMatch) {
      if (!serverAiEnabledBySide[side]) return
      setAiPikafishEnabledBySide((prev) => ({ ...prev, [side]: !currentEnabled }))
      return
    }

    if (!serverToken) return
    const slot = side === 'red' ? activeMatch.red : activeMatch.black
    if (slot.type !== 'ai') return

    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.updateMatchAiConfig(serverToken, activeMatch.id, {
        aiEngineBySide: { [side]: nextEngine },
      })
      applyServerMatch(data.match)
      setServerMessage(`${sideText(side)}AI引擎已切换为 ${nextEngine === 'pikafish' ? 'Pikafish' : '本地AI'}`)
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '切换AI引擎失败')
    } finally {
      setServerBusy(false)
    }
  }

  const updateServerAiPikafishMaxThink = async (side: Side, value: string) => {
    const nextMs = Number(value)
    if (Number.isNaN(nextMs) || nextMs <= 0) return

    if (!activeMatch) {
      if (!serverAiEnabledBySide[side]) return
      setAiPikafishMaxThinkBySide((prev) => ({ ...prev, [side]: nextMs }))
      return
    }

    if (!serverToken) return
    const slot = side === 'red' ? activeMatch.red : activeMatch.black
    if (slot.type !== 'ai') return

    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.updateMatchAiConfig(serverToken, activeMatch.id, {
        aiPikafishMaxThinkBySide: { [side]: nextMs },
      })
      applyServerMatch(data.match)
      setServerMessage(`${sideText(side)}Pikafish思考上限已更新为 ${nextMs / 1000}秒`)
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '更新Pikafish思考上限失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleServerDrawOffer = async () => {
    if (!serverToken || !activeMatch) return
    setServerBusy(true)
    setServerMessage('')
    const mySide = myServerSide
    try {
      const data = await serverApi.drawOffer(serverToken, activeMatch.id)
      applyServerMatch(data.match)
      await refreshRankings()
      if (data.match.status === 'finished' && data.match.result === 'draw') {
        setServerMessage('提和已达成，当前对局和棋')
      } else if (mySide && data.match.drawOfferBySide[mySide]) {
        setServerMessage('已发起提和请求')
      } else {
        setServerMessage('已取消提和请求')
      }
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '提和操作失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleServerResign = async () => {
    if (!serverToken || !activeMatch) return
    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.resign(serverToken, activeMatch.id)
      applyServerMatch(data.match)
      await refreshRankings()
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '认输失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleServerUndoAction = async (action?: 'request' | 'cancel' | 'accept' | 'reject') => {
    if (!serverToken || !activeMatch) return
    setServerBusy(true)
    setServerMessage('')
    try {
      const data = await serverApi.undoRequest(serverToken, activeMatch.id, action)
      applyServerMatch(data.match)
      await refreshRankings()
      const hasAi = activeMatch.red.type === 'ai' || activeMatch.black.type === 'ai'
      if (action === 'accept') {
        setServerMessage('已同意悔棋')
      } else if (action === 'reject') {
        setServerMessage('已拒绝悔棋请求')
      } else if (action === 'cancel') {
        setServerMessage('已取消悔棋请求')
      } else if (hasAi) {
        setServerMessage('已悔棋')
      } else {
        setServerMessage('已发起悔棋请求')
      }
    } catch (error) {
      setServerMessage(error instanceof Error ? error.message : '悔棋请求操作失败')
    } finally {
      setServerBusy(false)
    }
  }

  const handleCellClick = async (row: number, col: number) => {
    if (isReplayMode) return
    if (isServerMode) {
      if (!serverToken || !activeMatch) return

      const prevServer = game
      const nextServer = selectCell(prevServer, { row, col })
      const movedServer = nextServer.moveCount > prevServer.moveCount

      if (!movedServer) {
        setGame(nextServer)
        const selected = !prevServer.selected && !!nextServer.selected
        if (selected && soundOn) {
          void playSound('select')
        }
        return
      }

      const moveInfo = inferMoveInfo(prevServer, nextServer, prevServer.turn)
      if (!moveInfo) return

      setGame(nextServer)

      setServerBusy(true)
      setServerMessage('')
      try {
        const data = await serverApi.move(serverToken, activeMatch.id, moveInfo.from, moveInfo.to)
        applyServerMatch(data.match)
        await refreshRankings()
      } catch (error) {
        setGame(prevServer)
        setServerMessage(error instanceof Error ? error.message : '落子失败')
      } finally {
        setServerBusy(false)
      }
      return
    }

    if (aiEnabledBySide[game.turn]) return

    const prev = game
    const next = selectCell(prev, { row, col })
    const moved = next.moveCount > prev.moveCount

    setGame(next)

    if (moved) {
      const snapshot = cloneGameState(next)
      const nextTimeline = [...timeline, snapshot]
      setTimeline(nextTimeline)
      setReplayIndex(nextTimeline.length - 1)

      const moveInfo = inferMoveInfo(prev, next, prev.turn)
      const thinkMs = Math.max(1, nowMs() - turnStartAtRef.current)
      turnStartAtRef.current = nowMs()
      setDrawOfferBySide({ red: false, black: false })

      if (moveInfo) {
        const piece = next.pieces[moveInfo.pieceId]
        const pieceText = piece ? getPieceLabel(piece) : '子'
        const logItem: MoveLogItem = {
          id: next.moveCount,
          side: prev.turn,
          actor: 'human',
          pieceText,
          from: moveInfo.from,
          to: moveInfo.to,
          thinkMs,
        }
        setMoveLogs((prevLogs) => {
          const nextLogs = [...prevLogs, logItem]
          setLastThinkBySide(computeLastThinkMap(nextLogs))
          return nextLogs
        })
      }
    }

    if (!soundOn) {
      return
    }

    const capture = moved && aliveCount(next) < aliveCount(prev)
    const selected = !moved && !prev.selected && !!next.selected
    const checkedNow = next.message.includes('被将军') && !prev.message.includes('被将军')
    const wonNow = !prev.winner && !!next.winner

    if (wonNow) {
      void playSound('win')
    } else if (checkedNow) {
      void playSound('check')
    } else if (capture) {
      void playSound('capture')
    } else if (moved) {
      void playSound('move')
    } else if (selected) {
      void playSound('select')
    }
  }

  const restart = () => {
    const initial = createInitialGame()
    const snapshot = cloneGameState(initial)
    setGame(initial)
    setTimeline([snapshot])
    setReplayIndex(0)
    setIsReplayMode(false)
    setMoveLogs([])
    setLastThinkBySide({ red: null, black: null })
    setDrawOfferBySide({ red: false, black: false })
    turnStartAtRef.current = nowMs()
  }

  const undoMove = () => {
    if (timeline.length <= 1 || isReplayMode) return
    const nextTimeline = timeline.slice(0, -1)
    const latest = cloneGameState(nextTimeline[nextTimeline.length - 1])
    setTimeline(nextTimeline)
    setGame(latest)
    setReplayIndex(nextTimeline.length - 1)
    const nextLogs = moveLogs.slice(0, -1)
    setMoveLogs(nextLogs)
    setLastThinkBySide(computeLastThinkMap(nextLogs))
    setDrawOfferBySide({ red: false, black: false })
    turnStartAtRef.current = nowMs()
  }

  const toggleReplay = () => {
    if (timeline.length === 0) return
    if (isReplayMode) {
      const latest = cloneGameState(timeline[timeline.length - 1])
      setGame(latest)
      setReplayIndex(timeline.length - 1)
      setIsReplayMode(false)
      turnStartAtRef.current = nowMs()
      return
    }
    setReplayIndex(timeline.length - 1)
    setIsReplayMode(true)
  }

  const replayPrev = () => {
    if (!isReplayMode) return
    setReplayIndex((idx) => Math.max(0, idx - 1))
  }

  const replayNext = () => {
    if (!isReplayMode) return
    setReplayIndex((idx) => Math.min(timeline.length - 1, idx + 1))
  }

  const toggleSound = () => {
    setSoundOn((prev) => {
      const next = !prev
      if (next) {
        void playSound('toggle')
      }
      return next
    })
  }

  const toggleAiForSide = (side: Side) => {
    setAiEnabledBySide((prev) => ({ ...prev, [side]: !prev[side] }))
  }

  const toggleAiNoFallbackForSide = (side: Side) => {
    setAiPikafishEnabledBySide((prev) => ({ ...prev, [side]: !prev[side] }))
  }

  const decreaseAiDepth = (side: Side) => {
    setAiDepthBySide((prev) => ({
      ...prev,
      [side]: Math.max(MIN_AI_DEPTH, prev[side] - 1),
    }))
  }

  const increaseAiDepth = (side: Side) => {
    setAiDepthBySide((prev) => ({
      ...prev,
      [side]: Math.min(MAX_AI_DEPTH, prev[side] + 1),
    }))
  }

  const updateAiBudget = (side: Side, value: string) => {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    setAiTimeBudgetBySide((prev) => ({ ...prev, [side]: parsed }))
  }

  const updatePikafishMaxThink = (side: Side, value: string) => {
    const parsed = Number(value)
    if (Number.isNaN(parsed) || parsed <= 0) return
    setAiPikafishMaxThinkBySide((prev) => ({ ...prev, [side]: parsed }))
  }

  const toggleBoardSide = () => {
    setBoardFlipped((prev) => !prev)
  }

  const swapLocalSides = () => {
    if (isServerMode) return

    const swappedGame = swapLocalGameStateSides(game)
    const swappedTimeline = timeline.map((item) => swapLocalGameStateSides(item))
    const swappedLogs = moveLogs.map((item) => ({
      ...item,
      side: oppositeSide(item.side),
      from: mirrorPos(item.from),
      to: mirrorPos(item.to),
    }))

    setGame(swappedGame)
    setTimeline(swappedTimeline)
    setMoveLogs(swappedLogs)
    setLastThinkBySide({ red: lastThinkBySide.black, black: lastThinkBySide.red })
    setDrawOfferBySide({ red: drawOfferBySide.black, black: drawOfferBySide.red })
    setAiEnabledBySide({ red: aiEnabledBySide.black, black: aiEnabledBySide.red })
    setAiPikafishEnabledBySide({ red: aiPikafishEnabledBySide.black, black: aiPikafishEnabledBySide.red })
    setAiPikafishMaxThinkBySide({ red: aiPikafishMaxThinkBySide.black, black: aiPikafishMaxThinkBySide.red })
    setAiDepthBySide({ red: aiDepthBySide.black, black: aiDepthBySide.red })
    setAiTimeBudgetBySide({ red: aiTimeBudgetBySide.black, black: aiTimeBudgetBySide.red })
    turnStartAtRef.current = nowMs()
    setServerMessage('已交换双方局面')
  }

  const exportFen = () => {
    const exportState = isServerMode && activeMatch ? activeMatch.state : game
    const fenContent = gameStateToFen(exportState)
    const blob = new Blob([fenContent], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    link.href = url
    link.download = `flipchess-${stamp}.fen`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const importFen = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    const text = await file.text()
    const parsed = fenToGameState(text)
    if (!parsed) {
      window.alert('FEN 格式无效，无法导入')
      return
    }

    setGame(parsed)
    setTimeline([cloneGameState(parsed)])
    setReplayIndex(0)
    setIsReplayMode(false)
    setMoveLogs([])
    setLastThinkBySide({ red: null, black: null })
    setDrawOfferBySide({ red: false, black: false })
    turnStartAtRef.current = nowMs()
  }

  const declareAgreementDraw = () => {
    const current = latestGameRef.current
    if (current.winner || current.isDraw) return

    const next: GameState = {
      ...cloneGameState(current),
      winner: null,
      isDraw: true,
      selected: null,
      legalMoves: [],
      message: '双方协议和棋',
    }

    setGame(next)
    const snapshot = cloneGameState(next)
    const nextTimeline = [...latestTimelineRef.current, snapshot]
    setTimeline(nextTimeline)
    setReplayIndex(nextTimeline.length - 1)
    setIsReplayMode(false)
    setDrawOfferBySide({ red: false, black: false })
    turnStartAtRef.current = nowMs()
  }

  const toggleDrawOffer = (side: Side) => {
    if (isReplayMode) return
    if (game.winner || game.isDraw) return

    const opponent: Side = side === 'red' ? 'black' : 'red'
    if (drawOfferBySide[side]) {
      setDrawOfferBySide((prev) => ({ ...prev, [side]: false }))
      return
    }

    if (drawOfferBySide[opponent]) {
      declareAgreementDraw()
      return
    }

    setDrawOfferBySide((prev) => ({ ...prev, [side]: true }))
  }

  const isSelected = (pos: Position) => {
    return !!displayedGame.selected && displayedGame.selected.row === pos.row && displayedGame.selected.col === pos.col
  }

  const opponentSide: Side = displayedGame.turn === 'red' ? 'black' : 'red'
  const opponentLastMove = [...moveLogs].reverse().find((log) => log.side === opponentSide)
  const recentMoves = [...moveLogs].reverse()
  const lastMove = moveLogs.length > 0 ? moveLogs[moveLogs.length - 1] : null

  const thinkTotals = useMemo(() => {
    return moveLogs.reduce(
      (acc, item) => {
        acc[item.side] += item.thinkMs
        return acc
      },
      { red: 0, black: 0 },
    )
  }, [moveLogs])

  const liveTurnElapsedMs = !isReplayMode && !game.winner && !game.isDraw ? Math.max(0, clockNowMs - turnStartAtRef.current) : 0

  const liveThinkBySide = useMemo<Record<Side, number | null>>(() => {
    const next: Record<Side, number | null> = { ...lastThinkBySide }
    if (!isReplayMode && !game.winner && !game.isDraw) {
      next[game.turn] = liveTurnElapsedMs
    }
    return next
  }, [lastThinkBySide, isReplayMode, game.turn, game.winner, game.isDraw, liveTurnElapsedMs])

  const liveThinkTotals = useMemo<Record<Side, number>>(() => {
    const next: Record<Side, number> = { ...thinkTotals }
    if (!isReplayMode && !game.winner && !game.isDraw) {
      next[game.turn] += liveTurnElapsedMs
    }
    return next
  }, [thinkTotals, isReplayMode, game.turn, game.winner, game.isDraw, liveTurnElapsedMs])

  useEffect(() => {
    const updateLine = () => {
      if (!lastMove || !boardRef.current) {
        setLastMoveLine(null)
        return
      }

      const fromKey = `${lastMove.from.row}-${lastMove.from.col}`
      const toKey = `${lastMove.to.row}-${lastMove.to.col}`
      const fromEl = cellRefs.current[fromKey]
      const toEl = cellRefs.current[toKey]
      if (!fromEl || !toEl) {
        setLastMoveLine(null)
        return
      }

      const boardRect = boardRef.current.getBoundingClientRect()
      const fromRect = fromEl.getBoundingClientRect()
      const toRect = toEl.getBoundingClientRect()

      setLastMoveLine({
        x1: ((fromRect.left + fromRect.width / 2 - boardRect.left) / boardRect.width) * 100,
        y1: ((fromRect.top + fromRect.height / 2 - boardRect.top) / boardRect.height) * 100,
        x2: ((toRect.left + toRect.width / 2 - boardRect.left) / boardRect.width) * 100,
        y2: ((toRect.top + toRect.height / 2 - boardRect.top) / boardRect.height) * 100,
      })
    }

    updateLine()
    window.addEventListener('resize', updateLine)

    return () => {
      window.removeEventListener('resize', updateLine)
    }
  }, [lastMove, displayedGame, effectiveBoardFlipped, isReplayMode, replayIndex])

  useEffect(() => {
    aiSearchTokenRef.current += 1
    const searchToken = aiSearchTokenRef.current
    if (isServerMode) return
    const side = game.turn
    if (!aiEnabledBySide[side]) return
    if (isReplayMode) return
    if (game.winner || game.isDraw) return
    const pikafishEnabled = aiPikafishEnabledBySide[side]

    const searchRequest = {
      state: game,
      side,
      depth: aiDepthBySide[side],
      timeBudgetMs: pikafishEnabled ? aiPikafishMaxThinkBySide[side] : aiTimeBudgetBySide[side],
      noFallback: pikafishEnabled,
      pikafishMaxThinkMs: aiPikafishMaxThinkBySide[side],
    }

    const workerProvider = aiWorkerProviderRef.current
    const httpProvider = aiHttpProviderRef.current

    const searchWithWorker = () => {
      if (!workerProvider) throw new Error('Worker AI provider unavailable')
      return workerProvider.search(searchRequest)
    }

    const searchWithHttp = () => {
      if (!httpProvider) throw new Error('HTTP AI provider unavailable')
      return httpProvider.search(searchRequest)
    }

    let selectedProvider: 'worker' | 'http' = 'worker'
    const searchPromise = (() => {
      if (aiProviderMode === 'worker') {
        selectedProvider = 'worker'
        return searchWithWorker()
      }
      if (aiProviderMode === 'http') {
        if (pikafishEnabled) {
          selectedProvider = 'http'
          return searchWithHttp()
        }
        selectedProvider = 'worker'
        return searchWithWorker()
      }

      if (pikafishEnabled) {
        selectedProvider = 'http'
        return searchWithHttp()
      }

      selectedProvider = 'worker'
      return searchWithWorker()
    })()

    appendAiTrace([
      `[frontend] 发起AI请求 token=${searchToken} side=${side} provider=${selectedProvider} depth=${searchRequest.depth} budgetMs=${searchRequest.timeBudgetMs}`,
    ])

    const snapshot = game
    const handlePikafishFailure = (detailText: string, traceLines: string[] = []) => {
      if (traceLines.length > 0) {
        appendAiTrace(traceLines)
      }

      const nextRetries = (aiRetryCountRef.current[side] ?? 0) + 1
      aiRetryCountRef.current[side] = nextRetries
      appendAiTrace([`[frontend] Pikafish失败 ${nextRetries}/${AI_HTTP_MAX_RETRIES}：${detailText}`])

      if (nextRetries >= AI_HTTP_MAX_RETRIES) {
        setLocalAiLockMessage(
          `${sideText(side)}Pikafish请求失败（${nextRetries}/${AI_HTTP_MAX_RETRIES}）：${detailText}，改用本地AI`,
        )
        appendAiTrace(['[frontend] 达到最大重试，切换本地AI兜底'])
        void searchWithWorker()
          .then((fallbackData) => {
            if (searchToken !== aiSearchTokenRef.current) return
            aiRetryCountRef.current[side] = 0
            if (fallbackData.trace?.length) {
              appendAiTrace(fallbackData.trace)
            }
            applyAiResult({ ...fallbackData, engine: 'builtin' })
          })
          .catch((fallbackError: unknown) => {
            if (searchToken !== aiSearchTokenRef.current) return
            const fallbackDetail = fallbackError instanceof Error && fallbackError.message ? fallbackError.message : '未知错误'
            appendAiTrace([`[frontend] 本地AI兜底失败：${fallbackDetail}`])
            setLocalAiLockMessage(
              `${sideText(side)}Pikafish重试失败且本地AI兜底失败：${fallbackDetail}，请手动操作`,
            )
          })
        return
      }

      setLocalAiLockMessage(
        `${sideText(side)}Pikafish请求失败（${nextRetries}/${AI_HTTP_MAX_RETRIES}）：${detailText}，${AI_HTTP_RETRY_DELAY_MS}ms后重试`,
      )
      window.setTimeout(() => {
        if (searchToken !== aiSearchTokenRef.current) return
        setAiSearchRetryTick((prev) => prev + 1)
      }, AI_HTTP_RETRY_DELAY_MS)
    }

    const applyAiResult = (data: {
      side: Side
      move: { from: Position; to: Position } | null
      engine?: 'pikafish' | 'builtin'
      trace?: string[]
    }) => {
      if (data.trace?.length) {
        appendAiTrace(data.trace)
      }
      if (!data.move) return

      appendAiTrace([
        `[frontend] AI返回 engine=${data.engine ?? 'builtin'} move=${data.move.from.row},${data.move.from.col}->${data.move.to.row},${data.move.to.col}`,
      ])

      const currentGame = latestGameRef.current
      if (currentGame !== snapshot) return

      const next = playMove(currentGame, data.move.from, data.move.to)
      if (next === currentGame) return

      const thinkMs = Math.max(1, nowMs() - turnStartAtRef.current)
      const movedId = next.board[data.move.to.row]?.[data.move.to.col]
      const pieceText = movedId ? getPieceLabel(next.pieces[movedId]) : '子'

      setGame(next)
      const nextTimeline = [...latestTimelineRef.current, cloneGameState(next)]
      setTimeline(nextTimeline)
      setReplayIndex(nextTimeline.length - 1)
      turnStartAtRef.current = nowMs()
      setDrawOfferBySide({ red: false, black: false })

      const logItem: MoveLogItem = {
        id: next.moveCount,
        side: data.side,
        actor: 'ai',
        aiEngine: data.engine ?? 'builtin',
        pieceText,
        from: { ...data.move.from },
        to: { ...data.move.to },
        thinkMs,
      }
      setMoveLogs((prev) => {
        const nextLogs = [...prev, logItem]
        setLastThinkBySide(computeLastThinkMap(nextLogs))
        return nextLogs
      })

      if (!soundOnRef.current) return

      const capture = aliveCount(next) < aliveCount(currentGame)
      const checkedNow = next.message.includes('被将军') && !currentGame.message.includes('被将军')
      const wonNow = !currentGame.winner && !!next.winner

      if (wonNow) {
        void playSound('win')
      } else if (checkedNow) {
        void playSound('check')
      } else if (capture) {
        void playSound('capture')
      } else {
        void playSound('move')
      }
    }

    void searchPromise
      .then((data) => {
        if (searchToken !== aiSearchTokenRef.current) return
        if (data.trace?.length) {
          appendAiTrace(data.trace)
        }
        if (!data.move) {
          const shouldReportPikafish = pikafishEnabled && (aiProviderMode === 'auto' || aiProviderMode === 'http')
          if (shouldReportPikafish) {
            handlePikafishFailure('引擎未返回可用走子', data.trace)
          }
          return
        }

        aiRetryCountRef.current[side] = 0
        if (pikafishEnabled && data.engine === 'pikafish') {
          setLocalAiLockMessage('')
        } else if (pikafishEnabled && data.engine === 'builtin') {
          setLocalAiLockMessage(`${sideText(side)}Pikafish当前不可用，已回退本地AI`)
        }
        applyAiResult(data)
      })
      .catch((error: unknown) => {
        if (searchToken !== aiSearchTokenRef.current) return

        const traceLines =
          typeof error === 'object' &&
          error !== null &&
          'trace' in error &&
          Array.isArray((error as { trace?: unknown }).trace)
            ? (error as { trace: string[] }).trace
            : []

        const shouldReportPikafish = pikafishEnabled && (aiProviderMode === 'auto' || aiProviderMode === 'http')
        if (shouldReportPikafish) {
          const detailText = error instanceof Error && error.message ? error.message : '未知错误'
          handlePikafishFailure(detailText, traceLines)
          return
        }

        const detailText = error instanceof Error && error.message ? error.message : '未知错误'
        appendAiTrace(traceLines)
        appendAiTrace([`[frontend] AI请求失败：${detailText}`])
      })
  }, [
    isServerMode,
    aiEnabledBySide,
    aiPikafishEnabledBySide,
    isReplayMode,
    game,
    aiDepthBySide,
    aiTimeBudgetBySide,
    aiPikafishMaxThinkBySide,
    aiProviderMode,
    aiSearchRetryTick,
    appendAiTrace,
  ])

  return (
    <div className="page">
      {!actionsCollapsed && (
        <>
          <header className={`topbar${isRankingView ? ' ranking-mode' : ''}`}>
            <div className="topbar-head">
              <h1>揭棋</h1>
              {!isRankingView && (
                <div className="head-actions">
                  <button type="button" className={`mode-toggle ${playMode === 'local' ? 'active' : ''}`} onClick={() => setPlayMode('local')}>
                    本地模式
                  </button>
                  <button type="button" className={`mode-toggle ${playMode === 'server' ? 'active' : ''}`} onClick={() => setPlayMode('server')}>
                    服务器模式
                  </button>
                  <button type="button" className="collapse-toggle" onClick={() => setActionsCollapsed((prev) => !prev)}>
                    折叠操作
                  </button>
                </div>
              )}
            </div>
            {isServerMode && (
              <section className={`server-panel${isRankingView ? ' ranking-mode' : ''}`}>
                <div className="server-row">
                  {serverSessionHydrating && serverToken ? (
                    <span>正在恢复登录状态...</span>
                  ) : serverUser ? (
                    <>
                      <span>当前用户：{serverUser.username}（排名：{currentUserRank > 0 ? `#${currentUserRank}` : '--'}）</span>
                      {serverView !== 'ranking' && (
                        <button type="button" onClick={() => void openRankingPage()} disabled={serverBusy}>
                          排行榜
                        </button>
                      )}
                      <button type="button" onClick={handleLogout} disabled={serverBusy}>
                        退出
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        value={authUsername}
                        onChange={(event) => setAuthUsername(event.target.value)}
                        placeholder="用户名"
                        autoComplete="username"
                      />
                      <input
                        type="password"
                        value={authPassword}
                        onChange={(event) => setAuthPassword(event.target.value)}
                        placeholder="密码"
                        autoComplete="current-password"
                      />
                      <button type="button" onClick={handleRegister} disabled={serverBusy}>
                        注册
                      </button>
                      <button type="button" onClick={handleLogin} disabled={serverBusy}>
                        登录
                      </button>
                    </>
                  )}
                </div>
                {serverUser && serverView === 'match' && (
                  <>
                    <div className="server-row">
                      <select value={createMode} onChange={(event) => setCreateMode(event.target.value as 'pvp' | 'vs_ai' | 'ai_vs_ai')}>
                        <option value="vs_ai">人机对战</option>
                        <option value="pvp">人人对战</option>
                        <option value="ai_vs_ai">双AI对战</option>
                      </select>
                      {createMode === 'pvp' && (
                        <input value={createOpponent} onChange={(event) => setCreateOpponent(event.target.value)} placeholder="对手用户名" />
                      )}
                      {createMode === 'vs_ai' && (
                        <select value={createAiSide} onChange={(event) => setCreateAiSide(event.target.value as Side)}>
                          <option value="red">AI执红</option>
                          <option value="black">AI执黑</option>
                        </select>
                      )}
                      <button type="button" onClick={handleCreateMatch} disabled={serverBusy}>
                        创建对局
                      </button>
                      <button type="button" onClick={() => serverFenInputRef.current?.click()} disabled={serverBusy}>
                        导入FEN建局
                      </button>
                      <input
                        ref={serverFenInputRef}
                        type="file"
                        accept=".fen,text/plain"
                        style={{ display: 'none' }}
                        onChange={handleImportFenToServer}
                      />
                    </div>
                    <div className="server-row list">
                      <span>对局记录（{serverMatches.length}）：</span>
                      <div className="match-history-list">
                        {(() => {
                          const sorted = [...serverMatches].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
                          const visible = showAllMatches ? sorted : sorted.slice(0, 5)
                          const hiddenCount = sorted.length - 5
                          return (
                            <>
                              {visible.map((item) => {
                                const redLabel = item.red.type === 'user' ? (item.red.username ?? '玩家') : `AI(${aiEngineText(item.red.aiEngine)})`
                                const blackLabel = item.black.type === 'user' ? (item.black.username ?? '玩家') : `AI(${aiEngineText(item.black.aiEngine)})`
                                const statusLabel = item.status === 'finished'
                                  ? item.result === 'red' ? '红胜' : item.result === 'black' ? '黑胜' : item.result === 'draw' ? '平局' : '已结束'
                                  : '进行中'
                                return (
                                  <div key={item.id} className={`match-history-card${item.id === activeMatchId ? ' active' : ''}`}>
                                    <div className="match-history-main" onClick={() => void openMatch(item.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void openMatch(item.id) }}>
                                      <span className="match-history-sides">红 {redLabel} vs 黑 {blackLabel}</span>
                                      <span className={`match-history-status ${item.status}`}>{statusLabel}</span>
                                      <span className="match-history-time">开始 {formatDateTime(item.createdAt)}{item.status === 'finished' ? ` · 结束 ${formatDateTime(item.updatedAt)}` : ''}</span>
                                    </div>
                                    <button type="button" className="danger" onClick={() => void handleDeleteMatch(item.id)} title="删除该对局">删除</button>
                                  </div>
                                )
                              })}
                              {!showAllMatches && hiddenCount > 0 && (
                                <button type="button" className="match-history-expand" onClick={() => setShowAllMatches(true)}>
                                  展开更早的 {hiddenCount} 个对局
                                </button>
                              )}
                              {showAllMatches && sorted.length > 5 && (
                                <button type="button" className="match-history-expand" onClick={() => setShowAllMatches(false)}>
                                  收起
                                </button>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  </>
                )}
                {serverUser && serverView === 'ranking' && (
                  <section className="ranking-page">
                    <div className="ranking-list">
                      <div className="ranking-sticky-row">
                        <button type="button" onClick={() => setServerView('match')}>
                          返回对局
                        </button>
                      </div>
                      {rankings.map((item, idx) => (
                        <div key={item.userId} className="ranking-item">
                          <span>#{idx + 1}</span>
                          <span>{item.username}</span>
                          <span>{item.points}分</span>
                          <span>注册：{formatDateTime(item.registeredAt)}</span>
                          <span>达到当前积分：{formatDateTime(item.reachedAt)}</span>
                        </div>
                      ))}
                      {rankings.length > 0 && <div className="ranking-end">已到底部</div>}
                    </div>
                  </section>
                )}
                {serverMessage && <div className="server-message">{serverMessage}</div>}
              </section>
            )}
            {!isRankingView && <div className="actions">
              <button type="button" onClick={toggleSound}>
                音效：{soundOn ? '开' : '关'}
              </button>
              {!isServerMode && (
                <>
                  <button type="button" onClick={() => toggleAiForSide('red')}>
                    红方AI：{aiEnabledBySide.red ? '开' : '关'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAiNoFallbackForSide('red')}
                    disabled={aiProviderMode === 'worker'}
                  >
                    红方Pikafish：{aiPikafishEnabledBySide.red ? '开' : '关'}
                  </button>
                  <label className="ai-budget" aria-label="红方Pikafish最长思考时长">
                    <span>红Pika上限</span>
                    <select
                      value={aiPikafishMaxThinkBySide.red}
                      onChange={(event) => updatePikafishMaxThink('red', event.target.value)}
                      disabled={!aiPikafishEnabledBySide.red || aiProviderMode === 'worker'}
                    >
                      {PIKAFISH_MAX_THINK_OPTIONS.map((ms) => (
                        <option key={`red-pika-max-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => toggleDrawOffer('red')} disabled={isReplayMode || !!game.winner || game.isDraw}>
                    {drawOfferBySide.red ? '红方取消提和' : '红方提和'}
                  </button>
                  <div className="ai-depth" aria-label="红方AI搜索层数">
                    <button type="button" onClick={() => decreaseAiDepth('red')} disabled={aiDepthBySide.red <= MIN_AI_DEPTH}>
                      -
                    </button>
                    <span>红层：{aiDepthBySide.red}</span>
                    <button type="button" onClick={() => increaseAiDepth('red')} disabled={aiDepthBySide.red >= MAX_AI_DEPTH}>
                      +
                    </button>
                  </div>
                  <label className="ai-budget" aria-label="红方本地AI思考时限">
                    <span>红本地时限</span>
                    <select
                      value={aiTimeBudgetBySide.red}
                      onChange={(event) => updateAiBudget('red', event.target.value)}
                      disabled={aiPikafishEnabledBySide.red && aiProviderMode !== 'worker'}
                    >
                      {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                        <option key={ms} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => toggleAiForSide('black')}>
                    黑方AI：{aiEnabledBySide.black ? '开' : '关'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAiNoFallbackForSide('black')}
                    disabled={aiProviderMode === 'worker'}
                  >
                    黑方Pikafish：{aiPikafishEnabledBySide.black ? '开' : '关'}
                  </button>
                  <label className="ai-budget" aria-label="黑方Pikafish最长思考时长">
                    <span>黑Pika上限</span>
                    <select
                      value={aiPikafishMaxThinkBySide.black}
                      onChange={(event) => updatePikafishMaxThink('black', event.target.value)}
                      disabled={!aiPikafishEnabledBySide.black || aiProviderMode === 'worker'}
                    >
                      {PIKAFISH_MAX_THINK_OPTIONS.map((ms) => (
                        <option key={`black-pika-max-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => toggleDrawOffer('black')} disabled={isReplayMode || !!game.winner || game.isDraw}>
                    {drawOfferBySide.black ? '黑方取消提和' : '黑方提和'}
                  </button>
                  <div className="ai-depth" aria-label="黑方AI搜索层数">
                    <button type="button" onClick={() => decreaseAiDepth('black')} disabled={aiDepthBySide.black <= MIN_AI_DEPTH}>
                      -
                    </button>
                    <span>黑层：{aiDepthBySide.black}</span>
                    <button type="button" onClick={() => increaseAiDepth('black')} disabled={aiDepthBySide.black >= MAX_AI_DEPTH}>
                      +
                    </button>
                  </div>
                  <label className="ai-budget" aria-label="黑方本地AI思考时限">
                    <span>黑本地时限</span>
                    <select
                      value={aiTimeBudgetBySide.black}
                      onChange={(event) => updateAiBudget('black', event.target.value)}
                      disabled={aiPikafishEnabledBySide.black && aiProviderMode !== 'worker'}
                    >
                      {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                        <option key={ms} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {isServerMode && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleServerResign()}
                    disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing'}
                  >
                    认输
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleServerDrawOffer()}
                    disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing'}
                  >
                    {activeMatch && myServerSide && activeMatch.drawOfferBySide[myServerSide] ? '取消提和' : '提和'}
                  </button>
                  {activeMatch && (activeMatch.red.type === 'ai' || activeMatch.black.type === 'ai') ? (
                    <button
                      type="button"
                      onClick={() => void handleServerUndoAction('request')}
                      disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing'}
                    >
                      悔棋
                    </button>
                  ) : activeMatch && activeMatch.undoRequest ? (
                    activeMatch.undoRequest.fromSide === myServerSide ? (
                      <button
                        type="button"
                        onClick={() => void handleServerUndoAction('cancel')}
                        disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing'}
                      >
                        取消悔棋请求
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleServerUndoAction('accept')}
                          disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing' || !pendingUndoFromOpponent}
                        >
                          同意悔棋
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleServerUndoAction('reject')}
                          disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing' || !pendingUndoFromOpponent}
                        >
                          拒绝悔棋
                        </button>
                      </>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleServerUndoAction('request')}
                      disabled={!activeMatch || !myServerSide || activeMatch.status !== 'ongoing'}
                    >
                      请求悔棋
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void updateServerAiEngine('red')}
                    disabled={!serverAiEnabledBySide.red}
                  >
                    红方Pikafish：{serverAiEnabledBySide.red ? (serverAiPikafishEnabledBySide.red ? '开' : '关') : '--'}
                  </button>
                  <label className="ai-budget" aria-label="服务器红方Pikafish最长思考时长">
                    <span>红Pika上限</span>
                    <select
                      value={serverAiPikafishMaxThinkBySide.red}
                      onChange={(event) => {
                        void updateServerAiPikafishMaxThink('red', event.target.value)
                      }}
                      disabled={!serverAiEnabledBySide.red || !serverAiPikafishEnabledBySide.red}
                    >
                      {PIKAFISH_MAX_THINK_OPTIONS.map((ms) => (
                        <option key={`server-red-pika-max-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="ai-depth" aria-label="服务器红方AI搜索层数">
                    <button
                      type="button"
                      onClick={() => void updateServerAiDepth('red', -1)}
                      disabled={!serverAiEnabledBySide.red || serverAiDepthBySide.red <= MIN_AI_DEPTH}
                    >
                      -
                    </button>
                    <span>红AI层：{serverAiEnabledBySide.red ? serverAiDepthBySide.red : '--'}</span>
                    <button
                      type="button"
                      onClick={() => void updateServerAiDepth('red', 1)}
                      disabled={!serverAiEnabledBySide.red || serverAiDepthBySide.red >= MAX_AI_DEPTH}
                    >
                      +
                    </button>
                  </div>
                  <label className="ai-budget" aria-label="服务器红方AI思考时限">
                    <span>红AI时限</span>
                    <select
                      value={serverAiTimeBudgetBySide.red}
                      onChange={(event) => {
                        void updateServerAiBudget('red', event.target.value)
                      }}
                      disabled={!serverAiEnabledBySide.red}
                    >
                      {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                        <option key={`server-red-budget-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void updateServerAiEngine('black')}
                    disabled={!serverAiEnabledBySide.black}
                  >
                    黑方Pikafish：{serverAiEnabledBySide.black ? (serverAiPikafishEnabledBySide.black ? '开' : '关') : '--'}
                  </button>
                  <label className="ai-budget" aria-label="服务器黑方Pikafish最长思考时长">
                    <span>黑Pika上限</span>
                    <select
                      value={serverAiPikafishMaxThinkBySide.black}
                      onChange={(event) => {
                        void updateServerAiPikafishMaxThink('black', event.target.value)
                      }}
                      disabled={!serverAiEnabledBySide.black || !serverAiPikafishEnabledBySide.black}
                    >
                      {PIKAFISH_MAX_THINK_OPTIONS.map((ms) => (
                        <option key={`server-black-pika-max-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="ai-depth" aria-label="服务器黑方AI搜索层数">
                    <button
                      type="button"
                      onClick={() => void updateServerAiDepth('black', -1)}
                      disabled={!serverAiEnabledBySide.black || serverAiDepthBySide.black <= MIN_AI_DEPTH}
                    >
                      -
                    </button>
                    <span>黑AI层：{serverAiEnabledBySide.black ? serverAiDepthBySide.black : '--'}</span>
                    <button
                      type="button"
                      onClick={() => void updateServerAiDepth('black', 1)}
                      disabled={!serverAiEnabledBySide.black || serverAiDepthBySide.black >= MAX_AI_DEPTH}
                    >
                      +
                    </button>
                  </div>
                  <label className="ai-budget" aria-label="服务器黑方AI思考时限">
                    <span>黑AI时限</span>
                    <select
                      value={serverAiTimeBudgetBySide.black}
                      onChange={(event) => {
                        void updateServerAiBudget('black', event.target.value)
                      }}
                      disabled={!serverAiEnabledBySide.black}
                    >
                      {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                        <option key={`server-black-budget-${ms}`} value={ms}>
                          {ms / 1000}秒
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <button type="button" onClick={isServerMode ? toggleBoardSide : swapLocalSides} disabled={isServerMode}>
                {isServerMode ? `我方在下（${myServerSide === 'black' ? '黑方' : '红方'}）` : '交换棋盘'}
              </button>
              {!isServerMode && (
                <>
                  <button type="button" onClick={undoMove} disabled={timeline.length <= 1 || isReplayMode}>
                    悔棋
                  </button>
                  <button type="button" onClick={toggleReplay} disabled={timeline.length <= 1}>
                    {isReplayMode ? '退出复盘' : '进入复盘'}
                  </button>
                  <button type="button" onClick={restart}>
                    重新开局
                  </button>
                </>
              )}
              <button type="button" onClick={exportFen} disabled={isServerMode ? !activeMatch : false}>
                导出FEN
              </button>
              {!isServerMode && (
                <>
                  <button type="button" onClick={() => fenInputRef.current?.click()}>
                    导入FEN
                  </button>
                  <input ref={fenInputRef} type="file" accept=".fen,text/plain" style={{ display: 'none' }} onChange={importFen} />
                </>
              )}
            </div>}
          </header>

          {!isRankingView && (
            <>
              <section className="status">
                <div className="server-row">
                  <div>
                    {displayedGame.message}
                    {!isServerMode && aiThinkingSide ? `（${sideText(aiThinkingSide)}AI思考中）` : ''}
                    {` ｜ ${statusSummaryText}`}
                  </div>
                  <div>步数：{displayedGame.moveCount}</div>
                  <div>
                    {isServerMode
                      ? `在线：${activeMatch ? `${activeMatch.mode} · ${activeMatch.status} · ${isMyServerTurn ? '轮到你走' : '等待对手/AI'}` : '未选择对局'}`
                      : `提和：红方${drawOfferBySide.red ? '已提' : '未提'} / 黑方${drawOfferBySide.black ? '已提' : '未提'} ｜ 当前AI来源：${localAiSourceSummary}`}
                  </div>
                </div>
                {!isServerMode && localAiLockProbeMessage && <div className="server-row">{localAiLockProbeMessage}</div>}
                {!isServerMode && localAiLockMessage && <div className="server-row">{localAiLockMessage}</div>}
                {!isServerMode && aiInteractionTrace.length > 0 && (
                  <details className="insights-panel">
                    <summary>AI链路追踪（最近{aiInteractionTrace.length}条）</summary>
                    <section className="insights">
                      <div className="move-list">
                        {[...aiInteractionTrace].reverse().map((line, index) => (
                          <div key={`trace-${index}`}>{line}</div>
                        ))}
                      </div>
                    </section>
                  </details>
                )}
              </section>

              <details className="insights-panel">
                <summary>对局信息</summary>
                <section className="insights">
                  {isServerMode ? (
                    <>
                      <div className="think-row">
                        <span>红方思考：{formatThinkMs(liveThinkBySide.red)}</span>
                        <span>黑方思考：{formatThinkMs(liveThinkBySide.black)}</span>
                      </div>
                      <div className="think-row total">
                        <span>红方总时长：{formatDurationMs(liveThinkTotals.red)}</span>
                        <span>黑方总时长：{formatDurationMs(liveThinkTotals.black)}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="think-row">
                        <span>红方思考：{formatThinkMs(liveThinkBySide.red)}</span>
                        <span>黑方思考：{formatThinkMs(liveThinkBySide.black)}</span>
                      </div>
                      <div className="think-row total">
                        <span>红方总时长：{formatDurationMs(liveThinkTotals.red)}</span>
                        <span>黑方总时长：{formatDurationMs(liveThinkTotals.black)}</span>
                      </div>
                      <div className="last-row">
                        对手上一步：
                        {opponentLastMove
                          ? `${sideText(opponentLastMove.side)} ${opponentLastMove.pieceText} ${posText(opponentLastMove.from)}→${posText(opponentLastMove.to)}（${opponentLastMove.actor === 'ai' ? `AI(${aiEngineText(opponentLastMove.aiEngine)})` : actorText(opponentLastMove.actor)} ${formatDurationMs(opponentLastMove.thinkMs)}）`
                          : '暂无'}
                      </div>
                    </>
                  )}
                  {recentMoves.length > 0 && (
                    <div className="move-list">
                      {recentMoves.map((log) => (
                        <div key={`${log.id}-${log.side}-${log.from.row}-${log.from.col}`}>
                          {log.id}. {sideText(log.side)} {log.pieceText} {posText(log.from)}→{posText(log.to)} · {log.actor === 'ai' ? `AI(${aiEngineText(log.aiEngine)})` : actorText(log.actor)}
                          {!isServerMode ? ` · ${formatDurationMs(log.thinkMs)}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </details>

              {!isServerMode && isReplayMode && (
                <section className="replay-bar">
                  <button type="button" onClick={replayPrev} disabled={replayIndex <= 0}>
                    上一步
                  </button>
                  <span>
                    复盘 {replayIndex} / {Math.max(0, timeline.length - 1)}
                  </span>
                  <button type="button" onClick={replayNext} disabled={replayIndex >= timeline.length - 1}>
                    下一步
                  </button>
                </section>
              )}
            </>
          )}
        </>
      )}

      {actionsCollapsed && (
        <button type="button" className="expand-floating" onClick={() => setActionsCollapsed(false)}>
          展开操作
        </button>
      )}

      {actionsCollapsed && (
        <section className="collapsed-status">
          <div>
            {displayedGame.message}
            {!isServerMode && aiThinkingSide ? `（${sideText(aiThinkingSide)}AI思考中）` : ''}
            {` ｜ ${statusSummaryText}`}
          </div>
          <div>红方思考：{formatThinkMs(liveThinkBySide.red)} · 黑方思考：{formatThinkMs(liveThinkBySide.black)}</div>
          <div>红方总时长：{formatDurationMs(liveThinkTotals.red)} · 黑方总时长：{formatDurationMs(liveThinkTotals.black)}</div>
          {!isServerMode && <div>当前AI来源：{localAiSourceSummary}</div>}
          {!isServerMode && localAiLockProbeMessage && <div>{localAiLockProbeMessage}</div>}
          {!isServerMode && localAiLockMessage && <div>{localAiLockMessage}</div>}
          {isServerMode && <div>{activeMatch ? `在线：${activeMatch.mode} · ${activeMatch.status} · ${isMyServerTurn ? '轮到你走' : '等待对手/AI'}` : '在线：未选择对局'}</div>}
        </section>
      )}

      {!isRankingView && (
        <main className="board-wrap">
          <div className={`board ${effectiveBoardFlipped ? 'flipped' : ''}`} role="grid" aria-label="揭棋棋盘" ref={boardRef}>
          {lastMoveLine && (
            <svg className="move-trail" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs>
                <marker id="trail-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" fill="#0f6adf" />
                </marker>
              </defs>
              <line
                x1={lastMoveLine.x1}
                y1={lastMoveLine.y1}
                x2={lastMoveLine.x2}
                y2={lastMoveLine.y2}
                stroke="#0f6adf"
                strokeWidth="3"
                strokeLinecap="round"
                markerEnd="url(#trail-arrow)"
              />
            </svg>
          )}
          {displayedGame.board.map((row, r) =>
            row.map((id, c) => {
              const key = `${r}-${c}`
              const pos = { row: r, col: c }
              const piece = id ? displayedGame.pieces[id] : null

              return (
                <button
                  key={key}
                  ref={(el) => {
                    cellRefs.current[key] = el
                  }}
                  type="button"
                  className={`cell ${isSelected(pos) ? 'selected' : ''} ${legalKeySet.has(key) ? 'legal' : ''} ${
                    lastMove && lastMove.from.row === r && lastMove.from.col === c ? 'trail-from' : ''
                  } ${lastMove && lastMove.to.row === r && lastMove.to.col === c ? 'trail-to' : ''}`}
                  disabled={
                    isReplayMode ||
                    displayedGame.isDraw ||
                    !!displayedGame.winner ||
                    (isServerMode
                      ? !activeMatch || activeMatch.status !== 'ongoing'
                      : aiEnabledBySide[displayedGame.turn])
                  }
                  onClick={() => handleCellClick(r, c)}
                >
                  {piece ? (
                    <span className={`piece ${piece.side} ${piece.isRevealed ? 'revealed' : 'hidden'}`}>
                      {getPieceLabel(piece)}
                    </span>
                  ) : (
                    <span className="dot" />
                  )}
                </button>
              )
            }),
          )}
          </div>
        </main>
      )}

      {!isRankingView && (
        <section className="tips">
          <p>规则：暗子首次按所在初始位规则走，走后翻为明子；象士可过河。支持本地模式与服务器模式（账号、在线对局、AI 对战、排行统计）。</p>
        </section>
      )}
    </div>
  )
}

export default App
