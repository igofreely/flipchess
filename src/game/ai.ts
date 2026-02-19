import { getAllLegalMoves, playMove, type LegalMove } from './engine'
import type { GameState, PieceType, Side } from './types'

interface SearchContext {
  deadline: number | null
  timedOut: boolean
}

const pieceValue = (type: PieceType) => {
  switch (type) {
    case 'king':
      return 10000
    case 'rook':
      return 900
    case 'cannon':
      return 500
    case 'horse':
      return 450
    case 'elephant':
      return 200
    case 'advisor':
      return 200
    case 'pawn':
      return 120
    default:
      return 0
  }
}

const evaluateBoard = (state: GameState) => {
  if (state.winner === 'black') return 1_000_000
  if (state.winner === 'red') return -1_000_000
  if (state.isDraw) return 0

  let score = 0
  for (const piece of Object.values(state.pieces)) {
    if (!piece.alive) continue
    const val = pieceValue(piece.realType)
    score += piece.side === 'black' ? val : -val

    if (piece.realType === 'pawn') {
      if (piece.side === 'black' && piece.currentPos.row >= 5) score += 20
      if (piece.side === 'red' && piece.currentPos.row <= 4) score -= 20
    }
  }

  return score
}

const minimax = (
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  maximizingSide: Side,
  context: SearchContext,
): number => {
  if (context.deadline !== null && Date.now() >= context.deadline) {
    context.timedOut = true
    return evaluateBoard(state)
  }

  if (depth === 0 || state.winner || state.isDraw) {
    return evaluateBoard(state)
  }

  const moves = getAllLegalMoves(state, state.turn)
  if (moves.length === 0) {
    return evaluateBoard(state)
  }

  const isMaximizing = state.turn === maximizingSide

  if (isMaximizing) {
    let best = -Infinity
    for (const move of moves) {
      if (context.timedOut) break
      const next = playMove(state, move.from, move.to)
      if (next === state) continue
      const value = minimax(next, depth - 1, alpha, beta, maximizingSide, context)
      best = Math.max(best, value)
      alpha = Math.max(alpha, value)
      if (beta <= alpha) break
    }
    return best
  }

  let best = Infinity
  for (const move of moves) {
    if (context.timedOut) break
    const next = playMove(state, move.from, move.to)
    if (next === state) continue
    const value = minimax(next, depth - 1, alpha, beta, maximizingSide, context)
    best = Math.min(best, value)
    beta = Math.min(beta, value)
    if (beta <= alpha) break
  }
  return best
}

const pickDepth = (moveCount: number) => {
  if (moveCount <= 8) return 3
  if (moveCount <= 24) return 2
  return 3
}

const normalizeDepth = (depth: number) => Math.max(1, Math.min(8, depth))

const rankMoves = (scored: Array<{ move: LegalMove; score: number }>) => {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.move.from.row !== b.move.from.row) return a.move.from.row - b.move.from.row
    if (a.move.from.col !== b.move.from.col) return a.move.from.col - b.move.from.col
    if (a.move.to.row !== b.move.to.row) return a.move.to.row - b.move.to.row
    return a.move.to.col - b.move.to.col
  })
}

const searchAtDepth = (
  state: GameState,
  side: Side,
  legalMoves: LegalMove[],
  depth: number,
  deadline: number | null,
) => {
  const context: SearchContext = { deadline, timedOut: false }
  const scored: Array<{ move: LegalMove; score: number }> = []

  for (const move of legalMoves) {
    if (context.timedOut) break
    const next = playMove(state, move.from, move.to)
    if (next === state) continue

    const score = minimax(next, depth - 1, -Infinity, Infinity, side, context)
    scored.push({ move, score })
  }

  return {
    scored,
    timedOut: context.timedOut,
  }
}

export const chooseBestAiMove = (state: GameState, side: Side, depthOverride?: number): LegalMove | null => {
  const legalMoves = getAllLegalMoves(state, side)
  if (legalMoves.length === 0) return null

  const depth = depthOverride ? normalizeDepth(depthOverride) : pickDepth(legalMoves.length)
  const { scored } = searchAtDepth(state, side, legalMoves, depth, null)

  if (scored.length === 0) return legalMoves[0]

  return rankMoves(scored)[0].move
}

export const chooseBestAiMoveTimed = (
  state: GameState,
  side: Side,
  depthOverride: number,
  timeBudgetMs: number,
): LegalMove | null => {
  const legalMoves = getAllLegalMoves(state, side)
  if (legalMoves.length === 0) return null

  const maxDepth = normalizeDepth(depthOverride)
  const deadline = Date.now() + Math.max(200, timeBudgetMs)

  let orderedMoves = [...legalMoves]
  let bestMoveFromCompletedDepth: LegalMove | null = null
  let bestMoveFallback: LegalMove | null = legalMoves[0]

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const { scored, timedOut } = searchAtDepth(state, side, orderedMoves, depth, deadline)

    if (scored.length > 0) {
      const ranked = rankMoves(scored)
      bestMoveFallback = ranked[0].move
      orderedMoves = ranked.map((item) => item.move)

      if (!timedOut) {
        bestMoveFromCompletedDepth = ranked[0].move
      }
    }

    if (timedOut || Date.now() >= deadline) {
      break
    }
  }

  return bestMoveFromCompletedDepth ?? bestMoveFallback
}
