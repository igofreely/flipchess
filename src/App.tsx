import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './App.css'
import { createInitialGame, getPieceLabel, playMove, selectCell } from './game/engine'
import type { GameState, Position, Side } from './game/types'
import { createWorkerAiProvider, type AiProvider } from './game/ai-provider'
import { createHttpAiProvider } from './game/ai-provider-http'
import { playSound } from './sound/effects'

const aliveCount = (game: GameState) =>
  Object.values(game.pieces).filter((piece) => piece.alive).length

const cloneGameState = (state: GameState): GameState => JSON.parse(JSON.stringify(state)) as GameState
const MIN_AI_DEPTH = 1
const MAX_AI_DEPTH = 8
const AI_TIME_BUDGET_OPTIONS = [500, 1000, 1800, 2500, 3500, 5000, 8000, 10000]
const DEFAULT_AI_DEPTH = 5
const DEFAULT_AI_BUDGET = 5000

interface MoveLogItem {
  id: number
  side: Side
  actor: 'ai' | 'human'
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

const sideText = (side: Side) => (side === 'red' ? '红方' : '黑方')
const nowMs = () => Date.now()

const actorText = (actor: MoveLogItem['actor']) => (actor === 'ai' ? 'AI' : '人类')

const posText = (pos: Position) => `(${pos.row},${pos.col})`

const pgnSquareText = (pos: Position) => {
  const files = 'abcdefghi'
  return `${files[pos.col]}${9 - pos.row}`
}

const pgnResultText = (state: GameState) => {
  if (state.winner === 'red') return '1-0'
  if (state.winner === 'black') return '0-1'
  if (state.isDraw) return '1/2-1/2'
  return '*'
}

const pgnDateText = () => new Date().toISOString().slice(0, 10).replace(/-/g, '.')

const sanitizePgnTag = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const unescapePgnTag = (value: string) => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')

const encodeBase64Utf8 = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

const decodeBase64Utf8 = (base64: string) => {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const extractPgnTagValue = (content: string, tag: string): string | null => {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`\\[${escapedTag}\\s+"((?:\\\\.|[^"])*)"\\]`, 'i')
  const match = content.match(regex)
  if (!match?.[1]) return null
  return unescapePgnTag(match[1])
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

const parsePgnSquareText = (text: string): Position | null => {
  const normalized = text.trim().toLowerCase()
  if (!/^[a-i][0-9]$/.test(normalized)) return null

  const files = 'abcdefghi'
  const col = files.indexOf(normalized[0])
  const rank = Number(normalized[1])
  const row = 9 - rank

  if (col < 0 || rank < 0 || rank > 9 || row < 0 || row > 9) return null
  return { row, col }
}

const extractPgnMoves = (content: string): Array<{ from: Position; to: Position }> => {
  const plain = content
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;.*$/gm, ' ')
    .replace(/\[[^\]]*\]/g, ' ')

  const tokens = [...plain.matchAll(/([a-i][0-9])\s*-\s*([a-i][0-9])/gi)]
  const parsed: Array<{ from: Position; to: Position }> = []

  for (const token of tokens) {
    const from = parsePgnSquareText(token[1])
    const to = parsePgnSquareText(token[2])
    if (!from || !to) continue
    parsed.push({ from, to })
  }

  return parsed
}

const formatThinkMs = (ms: number | null) => (ms === null ? '--' : `${ms}ms`)

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

function App() {
  const initialGame = useMemo(() => createInitialGame(), [])
  const [game, setGame] = useState(() => initialGame)
  const [soundOn, setSoundOn] = useState(true)
  const [boardFlipped, setBoardFlipped] = useState(false)
  const [aiEnabledBySide, setAiEnabledBySide] = useState<Record<Side, boolean>>({ red: false, black: false })
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
  const aiProviderRef = useRef<AiProvider | null>(null)
  const aiSearchTokenRef = useRef(0)
  const pgnInputRef = useRef<HTMLInputElement | null>(null)
  const turnStartAtRef = useRef(0)
  const latestGameRef = useRef(game)
  const latestTimelineRef = useRef(timeline)
  const soundOnRef = useRef(soundOn)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [lastMoveLine, setLastMoveLine] = useState<LineCoords | null>(null)

  const displayedGame = isReplayMode && timeline[replayIndex] ? timeline[replayIndex] : game
  const aiThinkingSide: Side | null = !isReplayMode && !game.winner && !game.isDraw && aiEnabledBySide[game.turn] ? game.turn : null

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
    turnStartAtRef.current = nowMs()
  }, [])

  useEffect(() => {
    soundOnRef.current = soundOn
  }, [soundOn])

  useEffect(() => {
    const providerKind = (import.meta.env.VITE_AI_PROVIDER ?? 'worker').toString().toLowerCase()
    const provider =
      providerKind === 'http' && import.meta.env.VITE_AI_HTTP_ENDPOINT
        ? createHttpAiProvider({
            endpoint: import.meta.env.VITE_AI_HTTP_ENDPOINT,
            timeoutMs: Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS ?? 12_000),
          })
        : createWorkerAiProvider()

    aiProviderRef.current = provider

    return () => {
      aiProviderRef.current?.dispose()
      aiProviderRef.current = null
    }
  }, [])

  const handleCellClick = (row: number, col: number) => {
    if (isReplayMode) return
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

  const toggleBoardSide = () => {
    setBoardFlipped((prev) => !prev)
  }

  const exportPgn = () => {
    const result = pgnResultText(game)
    const startState = timeline[0] ? cloneGameState(timeline[0]) : createInitialGame()
    const setupPayload = encodeBase64Utf8(JSON.stringify(startState))
    const movetextParts: string[] = []

    for (let idx = 0; idx < moveLogs.length; idx += 2) {
      const redMove = moveLogs[idx]
      const blackMove = moveLogs[idx + 1]
      if (!redMove) break

      const round = Math.floor(idx / 2) + 1
      const redText = `${pgnSquareText(redMove.from)}-${pgnSquareText(redMove.to)}`
      if (blackMove) {
        const blackText = `${pgnSquareText(blackMove.from)}-${pgnSquareText(blackMove.to)}`
        movetextParts.push(`${round}. ${redText} ${blackText}`)
      } else {
        movetextParts.push(`${round}. ${redText}`)
      }
    }

    if (result !== '*') {
      movetextParts.push(result)
    }

    const headers = [
      `[Event "FlipChess Game"]`,
      `[Site "Local"]`,
      `[Date "${pgnDateText()}"]`,
      `[Round "-"]`,
      `[White "Red"]`,
      `[Black "Black"]`,
      `[Result "${result}"]`,
      `[Variant "FlipChess"]`,
      `[FlipChessSetup "${setupPayload}"]`,
      `[Termination "${sanitizePgnTag(game.message)}"]`,
    ]

    const pgnContent = `${headers.join('\n')}\n\n${movetextParts.join(' ')}\n`
    const blob = new Blob([pgnContent], { type: 'application/x-chess-pgn;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    link.href = url
    link.download = `flipchess-${stamp}.pgn`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const importPgn = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    const text = await file.text()
    const setupTag = extractPgnTagValue(text, 'FlipChessSetup')
    const moves = extractPgnMoves(text)

    if (moves.length === 0 && !setupTag) {
      window.alert('未在PGN中识别到可用着法')
      return
    }

    let working: GameState
    if (setupTag) {
      try {
        const decoded = JSON.parse(decodeBase64Utf8(setupTag)) as unknown
        if (!isGameStateLike(decoded)) {
          window.alert('PGN初始局面数据无效，无法导入')
          return
        }
        working = cloneGameState(decoded)
      } catch {
        window.alert('PGN初始局面数据损坏，无法导入')
        return
      }
    } else {
      working = createInitialGame()
    }

    const importedTimeline: GameState[] = [cloneGameState(working)]
    const importedLogs: MoveLogItem[] = []

    for (const item of moves) {
      const before = working
      const after = playMove(before, item.from, item.to)
      if (after === before) {
        window.alert(`PGN包含非法着法：${pgnSquareText(item.from)}-${pgnSquareText(item.to)}（请确认使用本应用导出的PGN）`)
        break
      }

      const movedId = after.board[item.to.row]?.[item.to.col]
      const pieceText = movedId ? getPieceLabel(after.pieces[movedId]) : '子'

      importedLogs.push({
        id: after.moveCount,
        side: before.turn,
        actor: 'human',
        pieceText,
        from: { ...item.from },
        to: { ...item.to },
        thinkMs: 0,
      })

      working = after
      importedTimeline.push(cloneGameState(working))

      if (working.winner || working.isDraw) {
        break
      }
    }

    setGame(working)
    setTimeline(importedTimeline)
    setReplayIndex(0)
    setIsReplayMode(true)
    setMoveLogs(importedLogs)
    setLastThinkBySide(computeLastThinkMap(importedLogs))
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
  }, [lastMove, displayedGame, boardFlipped, isReplayMode, replayIndex])

  useEffect(() => {
    aiSearchTokenRef.current += 1
    const searchToken = aiSearchTokenRef.current
    const side = game.turn
    if (!aiEnabledBySide[side]) return
    if (isReplayMode) return
    if (game.winner || game.isDraw) return
    if (!aiProviderRef.current) return

    const snapshot = game
    void aiProviderRef.current
      .search({
        state: snapshot,
        side,
        depth: aiDepthBySide[side],
        timeBudgetMs: aiTimeBudgetBySide[side],
      })
      .then((data) => {
        if (searchToken !== aiSearchTokenRef.current) return
        if (!data.move) return

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
      })
      .catch(() => {
        if (searchToken !== aiSearchTokenRef.current) return
      })
  }, [aiEnabledBySide, isReplayMode, game, aiDepthBySide, aiTimeBudgetBySide])

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-head">
          <h1>揭棋</h1>
          <button type="button" className="collapse-toggle" onClick={() => setActionsCollapsed((prev) => !prev)}>
            {actionsCollapsed ? '展开操作' : '折叠操作'}
          </button>
        </div>
        <div className={`actions ${actionsCollapsed ? 'collapsed' : ''}`}>
          <button type="button" onClick={toggleSound}>
            音效：{soundOn ? '开' : '关'}
          </button>
          <button type="button" onClick={() => toggleAiForSide('red')}>
            红方AI：{aiEnabledBySide.red ? '开' : '关'}
          </button>
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
          <label className="ai-budget" aria-label="红方AI思考时限">
            <span>红时限</span>
            <select value={aiTimeBudgetBySide.red} onChange={(event) => updateAiBudget('red', event.target.value)}>
              {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms}ms
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => toggleAiForSide('black')}>
            黑方AI：{aiEnabledBySide.black ? '开' : '关'}
          </button>
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
          <label className="ai-budget" aria-label="黑方AI思考时限">
            <span>黑时限</span>
            <select value={aiTimeBudgetBySide.black} onChange={(event) => updateAiBudget('black', event.target.value)}>
              {AI_TIME_BUDGET_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms}ms
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={toggleBoardSide}>
            交换棋盘
          </button>
          <button type="button" onClick={undoMove} disabled={timeline.length <= 1 || isReplayMode}>
            悔棋
          </button>
          <button type="button" onClick={toggleReplay} disabled={timeline.length <= 1}>
            {isReplayMode ? '退出复盘' : '进入复盘'}
          </button>
          <button type="button" onClick={restart}>
            重新开局
          </button>
          <button type="button" onClick={exportPgn}>
            导出PGN
          </button>
          <button type="button" onClick={() => pgnInputRef.current?.click()}>
            导入PGN
          </button>
          <input ref={pgnInputRef} type="file" accept=".pgn,text/plain" style={{ display: 'none' }} onChange={importPgn} />
        </div>
      </header>

      <section className="status">
        <div>
          {displayedGame.message}
          {aiThinkingSide ? `（${sideText(aiThinkingSide)}AI思考中）` : ''}
        </div>
        <div>步数：{displayedGame.moveCount}</div>
        <div>提和：红方{drawOfferBySide.red ? '已提' : '未提'} / 黑方{drawOfferBySide.black ? '已提' : '未提'}</div>
      </section>

      <details className="insights-panel">
        <summary>对局信息</summary>
        <section className="insights">
          <div className="think-row">
            <span>红方思考：{formatThinkMs(lastThinkBySide.red)}</span>
            <span>黑方思考：{formatThinkMs(lastThinkBySide.black)}</span>
          </div>
          <div className="think-row total">
            <span>红方总时长：{thinkTotals.red}ms</span>
            <span>黑方总时长：{thinkTotals.black}ms</span>
          </div>
          <div className="last-row">
            对手上一步：
            {opponentLastMove
              ? `${sideText(opponentLastMove.side)} ${opponentLastMove.pieceText} ${posText(opponentLastMove.from)}→${posText(opponentLastMove.to)}（${actorText(opponentLastMove.actor)} ${opponentLastMove.thinkMs}ms）`
              : '暂无'}
          </div>
          {recentMoves.length > 0 && (
            <div className="move-list">
              {recentMoves.map((log) => (
                <div key={`${log.id}-${log.side}-${log.from.row}-${log.from.col}`}>
                  {log.id}. {sideText(log.side)} {log.pieceText} {posText(log.from)}→{posText(log.to)} · {actorText(log.actor)} · {log.thinkMs}ms
                </div>
              ))}
            </div>
          )}
        </section>
      </details>

      {isReplayMode && (
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

      <main className="board-wrap">
        <div className={`board ${boardFlipped ? 'flipped' : ''}`} role="grid" aria-label="揭棋棋盘" ref={boardRef}>
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
                    aiEnabledBySide[displayedGame.turn]
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

      <section className="tips">
        <p>规则：暗子首次按所在初始位规则走，走后翻为明子；象士可过河。支持悔棋、复盘、交换棋盘与双 AI 对战（双方层数/思考时限独立可调）。</p>
      </section>
    </div>
  )
}

export default App
