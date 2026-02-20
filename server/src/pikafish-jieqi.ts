import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { getAllLegalMoves, type LegalMove } from '../../src/game/engine'
import type { GameState, PieceType, Position, Side } from '../../src/game/types'

export interface PikafishSearchRequest {
  executablePath: string
  evalFilePath?: string
  state: GameState
  side: Side
  depth: number
  timeBudgetMs: number
  hashMb?: number
  threads?: number
  onTrace?: (line: string) => void
}

const fileChars = 'abcdefghi'

// Pikafish-jieqi coordinate system (standard xiangqi):
// file a = col 0, file i = col 8
// rank 0 = bottom (red's back rank) = our row 9
// rank 9 = top (black's back rank) = our row 0
// Mapping: rank = 9 - row, row = 9 - rank (same for both sides, UCI uses absolute coords)

const positionToSquare = (pos: Position) => {
  const file = fileChars[pos.col] ?? 'a'
  const rank = String(9 - pos.row)
  return `${file}${rank}`
}

const squareToPosition = (square: string): Position | null => {
  if (!/^[a-i][0-9]$/.test(square)) return null
  const col = fileChars.indexOf(square[0])
  const rank = Number(square[1])
  if (col < 0 || rank < 0 || rank > 9) return null
  const row = 9 - rank
  return { row, col }
}

const moveToUci = (move: LegalMove) => {
  return `${positionToSquare(move.from)}${positionToSquare(move.to)}`
}

const typeToFenChar = (type: PieceType) => {
  switch (type) {
    case 'king':
      return 'k'
    case 'advisor':
      return 'a'
    case 'elephant':
      return 'b'
    case 'horse':
      return 'n'
    case 'rook':
      return 'r'
    case 'cannon':
      return 'c'
    case 'pawn':
      return 'p'
    default:
      return 'p'
  }
}

const buildOldFormatPoolText = (state: GameState) => {
  const counts = new Map<string, number>()

  for (const piece of Object.values(state.pieces)) {
    if (!piece.alive || piece.isRevealed) continue
    const lower = typeToFenChar(piece.realType)
    const key = piece.side === 'red' ? lower.toUpperCase() : lower
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const order = ['A', 'B', 'N', 'R', 'C', 'P', 'a', 'b', 'n', 'r', 'c', 'p']
  const parts: string[] = []
  for (const key of order) {
    const n = counts.get(key) ?? 0
    if (n > 0) {
      parts.push(`${key}${n}`)
    }
  }

  return parts.join('') || '-'
}

const boardToJieqiOldFen = (state: GameState) => {
  const rows: string[] = []

  for (let row = 0; row < 10; row += 1) {
    let fenRow = ''
    let emptyCount = 0

    for (let col = 0; col < 9; col += 1) {
      const id = state.board[row][col]
      if (!id) {
        emptyCount += 1
        continue
      }

      if (emptyCount > 0) {
        fenRow += String(emptyCount)
        emptyCount = 0
      }

      const piece = state.pieces[id]
      if (!piece) {
        fenRow += '1'
        continue
      }

      if (!piece.isRevealed) {
        fenRow += piece.side === 'red' ? 'X' : 'x'
        continue
      }

      const base = typeToFenChar(piece.realType)
      fenRow += piece.side === 'red' ? base.toUpperCase() : base
    }

    if (emptyCount > 0) {
      fenRow += String(emptyCount)
    }

    rows.push(fenRow)
  }

  const boardText = rows.join('/')
  const poolText = buildOldFormatPoolText(state)
  const sideText = state.turn === 'red' ? 'w' : 'b'
  const halfmove = Math.max(0, Math.floor(state.quietMoveCount))
  const fullmove = Math.max(1, Math.floor(state.moveCount / 2) + 1)

  // Pikafish-jieqi FEN format: <board> <side> <pool> <halfmove> <fullmove>
  return `${boardText} ${sideText} ${poolText} ${halfmove} ${fullmove}`
}

const parseUciMove = (uci: string): { from: Position; to: Position } | null => {
  const trimmed = uci.trim()
  const match = trimmed.match(/^([a-i][0-9])([a-i][0-9])/)
  if (!match) return null
  const from = squareToPosition(match[1])
  const to = squareToPosition(match[2])
  if (!from || !to) return null
  return { from, to }
}

const isLegalMove = (state: GameState, move: LegalMove) => {
  const legalMoves = getAllLegalMoves(state, state.turn)
  return legalMoves.some(
    (item) =>
      item.from.row === move.from.row &&
      item.from.col === move.from.col &&
      item.to.row === move.to.row &&
      item.to.col === move.to.col,
  )
}

export const searchBestMoveWithPikafish = async (request: PikafishSearchRequest): Promise<LegalMove | null> => {
  const trace = (line: string) => {
    request.onTrace?.(`[engine] ${line}`)
  }

  if (request.state.turn !== request.side) return null

  const legalMoves = getAllLegalMoves(request.state, request.side)
  if (legalMoves.length === 0) return null

  // Build UCI move map using absolute coordinate transform
  const legalMoveMap = new Map<string, LegalMove>()
  for (const legalMove of legalMoves) {
    const uci = moveToUci(legalMove)
    if (!legalMoveMap.has(uci)) {
      legalMoveMap.set(uci, legalMove)
    }
  }
  const searchMoves = [...legalMoveMap.keys()]

  const fen = boardToJieqiOldFen(request.state)
  const timeoutMs = Math.max(1200, request.timeBudgetMs + 1000)
  trace(`start side=${request.side} depth=${request.depth} movetime=${request.timeBudgetMs} legalMoves=${legalMoves.length}`)

  const runEngine = (useSearchMoves: boolean): Promise<string | null> => {
    return new Promise<string | null>((resolve, reject) => {
      const child = spawn(request.executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: dirname(request.executablePath),
      })
      trace(`spawn executable=${request.executablePath}`)

      let stdoutBuffer = ''
      let stdoutHistory = ''
      let stderrHistory = ''
      let done = false

      const appendHistory = (history: string, chunk: string, maxLen = 2000) => {
        const merged = history + chunk
        if (merged.length <= maxLen) return merged
        return merged.slice(-maxLen)
      }

      const finish = (value: string | null, error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        if (error) {
          trace(`finish error=${error.message}`)
          reject(error)
        } else {
          trace(`finish bestmove=${value ?? 'none'}`)
          resolve(value)
        }
      }

      const onStdout = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stdoutHistory = appendHistory(stdoutHistory, text)
        stdoutBuffer += text
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (line.includes('ERROR:')) {
            trace(line)
          }
          if (!line.startsWith('bestmove ')) continue
          const token = line.replace(/^bestmove\s+/, '').split(/\s+/)[0] ?? ''
          trace(`raw ${line}`)
          if (!token || token === '(none)' || token === 'none') {
            finish(null)
            return
          }
          finish(token)
          return
        }
      }

      const onStderr = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderrHistory = appendHistory(stderrHistory, text)
      }

      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)

      child.on('error', (error) => {
        trace(`process error=${error.message}`)
        finish(null, error)
      })

      child.on('exit', (code, signal) => {
        if (done) return
        trace(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        finish(
          null,
          new Error(
            `Pikafish exited before bestmove (code=${code ?? 'null'}, signal=${signal ?? 'null'}, stdout=${stdoutHistory}, stderr=${stderrHistory})`,
          ),
        )
      })

      const timer = setTimeout(() => {
        trace(`timeout ${timeoutMs}ms`)
        finish(null, new Error('Pikafish search timeout'))
      }, timeoutMs)

      const commands: string[] = ['uci']
      if (request.threads && request.threads > 0) {
        commands.push(`setoption name Threads value ${Math.floor(request.threads)}`)
      }
      if (request.hashMb && request.hashMb > 0) {
        commands.push(`setoption name Hash value ${Math.floor(request.hashMb)}`)
      }
      if (request.evalFilePath) {
        commands.push(`setoption name EvalFile value ${request.evalFilePath}`)
      }

      commands.push('isready')
      commands.push('ucinewgame')
      commands.push(`position fen ${fen}`)

      const safeDepth = Math.max(1, Math.min(128, Math.floor(request.depth)))
      const safeTime = Math.max(100, Math.floor(request.timeBudgetMs))

      if (useSearchMoves) {
        trace(`go depth=${safeDepth} movetime=${safeTime} searchmoves=${searchMoves.length}`)
        commands.push(`go depth ${safeDepth} movetime ${safeTime} searchmoves ${searchMoves.join(' ')}`)
      } else {
        trace(`go depth=${safeDepth} movetime=${safeTime} (no searchmoves)`)
        commands.push(`go depth ${safeDepth} movetime ${safeTime}`)
      }

      child.stdin.write(`${commands.join('\n')}\n`)
    })
  }

  const mapBestmove = (bestmove: string): LegalMove | null => {
    // Direct lookup in raw-coordinate map
    const mapped = legalMoveMap.get(bestmove)
    if (mapped) {
      trace(`mapped move ${mapped.from.row},${mapped.from.col}->${mapped.to.row},${mapped.to.col}`)
      return mapped
    }

    // Parse coordinates and check legality
    const parsed = parseUciMove(bestmove)
    if (parsed && isLegalMove(request.state, parsed)) {
      trace(`parsed move ${parsed.from.row},${parsed.from.col}->${parsed.to.row},${parsed.to.col}`)
      return parsed
    }

    return null
  }

  // Phase 1: try with searchmoves (restricts to our legal moves)
  let bestmove = await runEngine(true)

  if (bestmove) {
    const move = mapBestmove(bestmove)
    if (move) return move
    trace(`searchmoves bestmove=${bestmove} not in our legal moves, retrying without searchmoves`)
  } else {
    trace('bestmove (none) with searchmoves, retrying without searchmoves')
  }

  // Phase 2: retry without searchmoves (let Pikafish freely search)
  bestmove = await runEngine(false)

  if (!bestmove) {
    trace(`bestmove (none) even without searchmoves — position may be terminal (fen="${fen}"), returning null`)
    return null
  }

  const move = mapBestmove(bestmove)
  if (!move) {
    const parsed = parseUciMove(bestmove)
    const parsedStr = parsed ? `(${parsed.from.row},${parsed.from.col})->(${parsed.to.row},${parsed.to.col})` : 'parse-failed'
    trace(`illegal bestmove=${bestmove} mapped=${parsedStr} — Pikafish move rules differ from ours for X/x pieces, returning null`)
    console.warn(
      `[pikafish] illegal bestmove side=${request.side} bestmove=${bestmove} mapped=${parsedStr} legalMoves=${legalMoves.length} fen="${fen}"`,
    )
    return null
  }

  return move
}
