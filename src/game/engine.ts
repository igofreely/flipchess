import type { GameState, Move, Piece, PieceType, Position, Side } from './types'

export interface LegalMove {
  from: Position
  to: Position
}

const ROWS = 10
const COLS = 9
const NATURAL_DRAW_LIMIT_PLIES = 120

const EMPTY_BOARD = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null) as (string | null)[])

const inBoard = (pos: Position) => pos.row >= 0 && pos.row < ROWS && pos.col >= 0 && pos.col < COLS

const samePos = (a: Position, b: Position) => a.row === b.row && a.col === b.col

const sideName = (side: Side) => (side === 'red' ? '红方' : '黑方')

const riverCrossed = (side: Side, row: number) => {
  if (side === 'red') return row <= 4
  return row >= 5
}

const palaceContains = (side: Side, pos: Position) => {
  const colOk = pos.col >= 3 && pos.col <= 5
  if (!colOk) return false
  if (side === 'red') return pos.row >= 7 && pos.row <= 9
  return pos.row >= 0 && pos.row <= 2
}

const pieceText = (piece: Piece) => {
  const map: Record<PieceType, string> = {
    king: '将',
    advisor: '士',
    elephant: '象',
    horse: '马',
    rook: '车',
    cannon: '炮',
    pawn: '兵',
  }
  const txt = map[piece.realType]
  return piece.side === 'red' ? txt : txt === '兵' ? '卒' : txt
}

const bornTypeByPosition = (side: Side, pos: Position): PieceType => {
  const redMap: Record<string, PieceType> = {
    '9,0': 'rook',
    '9,1': 'horse',
    '9,2': 'elephant',
    '9,3': 'advisor',
    '9,4': 'king',
    '9,5': 'advisor',
    '9,6': 'elephant',
    '9,7': 'horse',
    '9,8': 'rook',
    '7,1': 'cannon',
    '7,7': 'cannon',
    '6,0': 'pawn',
    '6,2': 'pawn',
    '6,4': 'pawn',
    '6,6': 'pawn',
    '6,8': 'pawn',
  }

  const blackMap: Record<string, PieceType> = {
    '0,0': 'rook',
    '0,1': 'horse',
    '0,2': 'elephant',
    '0,3': 'advisor',
    '0,4': 'king',
    '0,5': 'advisor',
    '0,6': 'elephant',
    '0,7': 'horse',
    '0,8': 'rook',
    '2,1': 'cannon',
    '2,7': 'cannon',
    '3,0': 'pawn',
    '3,2': 'pawn',
    '3,4': 'pawn',
    '3,6': 'pawn',
    '3,8': 'pawn',
  }

  const key = `${pos.row},${pos.col}`
  return (side === 'red' ? redMap : blackMap)[key]
}

const initialPositions = (side: Side): Position[] => {
  if (side === 'red') {
    return [
      { row: 9, col: 0 },
      { row: 9, col: 1 },
      { row: 9, col: 2 },
      { row: 9, col: 3 },
      { row: 9, col: 4 },
      { row: 9, col: 5 },
      { row: 9, col: 6 },
      { row: 9, col: 7 },
      { row: 9, col: 8 },
      { row: 7, col: 1 },
      { row: 7, col: 7 },
      { row: 6, col: 0 },
      { row: 6, col: 2 },
      { row: 6, col: 4 },
      { row: 6, col: 6 },
      { row: 6, col: 8 },
    ]
  }

  return [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: 2 },
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 0, col: 5 },
    { row: 0, col: 6 },
    { row: 0, col: 7 },
    { row: 0, col: 8 },
    { row: 2, col: 1 },
    { row: 2, col: 7 },
    { row: 3, col: 0 },
    { row: 3, col: 2 },
    { row: 3, col: 4 },
    { row: 3, col: 6 },
    { row: 3, col: 8 },
  ]
}

const buildPiecePool = (side: Side) => {
  const pool: PieceType[] = [
    'rook',
    'rook',
    'horse',
    'horse',
    'elephant',
    'elephant',
    'advisor',
    'advisor',
    'cannon',
    'cannon',
    'pawn',
    'pawn',
    'pawn',
    'pawn',
    'pawn',
  ]

  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  const positions = initialPositions(side).filter((p) => !(p.row === (side === 'red' ? 9 : 0) && p.col === 4))

  return positions.map((pos, idx) => ({
    realType: shuffled[idx],
    bornType: bornTypeByPosition(side, pos),
    pos,
  }))
}

const nextSide = (side: Side): Side => (side === 'red' ? 'black' : 'red')
const moveTypeOf = (piece: Piece): PieceType => (piece.isRevealed ? piece.realType : piece.bornType)

const getPieceAt = (board: (string | null)[][], pos: Position): string | null => board[pos.row][pos.col]

const canCapture = (source: Piece, target: Piece) => source.side !== target.side

const addIfValid = (
  moves: Position[],
  board: (string | null)[][],
  pieces: Record<string, Piece>,
  source: Piece,
  pos: Position,
) => {
  if (!inBoard(pos)) return
  const id = getPieceAt(board, pos)
  if (!id) {
    moves.push(pos)
    return
  }
  const target = pieces[id]
  if (target && canCapture(source, target)) moves.push(pos)
}

const rookMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const dirs = [
    { dr: 1, dc: 0 },
    { dr: -1, dc: 0 },
    { dr: 0, dc: 1 },
    { dr: 0, dc: -1 },
  ]
  for (const d of dirs) {
    let row = source.currentPos.row + d.dr
    let col = source.currentPos.col + d.dc
    while (inBoard({ row, col })) {
      const id = board[row][col]
      if (!id) {
        out.push({ row, col })
      } else {
        const target = pieces[id]
        if (target.side !== source.side) out.push({ row, col })
        break
      }
      row += d.dr
      col += d.dc
    }
  }
  return out
}

const cannonMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const dirs = [
    { dr: 1, dc: 0 },
    { dr: -1, dc: 0 },
    { dr: 0, dc: 1 },
    { dr: 0, dc: -1 },
  ]

  for (const d of dirs) {
    let row = source.currentPos.row + d.dr
    let col = source.currentPos.col + d.dc
    let jumped = false

    while (inBoard({ row, col })) {
      const id = board[row][col]
      if (!jumped) {
        if (!id) {
          out.push({ row, col })
        } else {
          jumped = true
        }
      } else if (id) {
        const target = pieces[id]
        if (target.side !== source.side) out.push({ row, col })
        break
      }
      row += d.dr
      col += d.dc
    }
  }

  return out
}

const horseMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const plans = [
    { leg: { dr: -1, dc: 0 }, to: { dr: -2, dc: -1 } },
    { leg: { dr: -1, dc: 0 }, to: { dr: -2, dc: 1 } },
    { leg: { dr: 1, dc: 0 }, to: { dr: 2, dc: -1 } },
    { leg: { dr: 1, dc: 0 }, to: { dr: 2, dc: 1 } },
    { leg: { dr: 0, dc: -1 }, to: { dr: -1, dc: -2 } },
    { leg: { dr: 0, dc: -1 }, to: { dr: 1, dc: -2 } },
    { leg: { dr: 0, dc: 1 }, to: { dr: -1, dc: 2 } },
    { leg: { dr: 0, dc: 1 }, to: { dr: 1, dc: 2 } },
  ]

  for (const p of plans) {
    const legPos = { row: source.currentPos.row + p.leg.dr, col: source.currentPos.col + p.leg.dc }
    if (!inBoard(legPos)) continue
    if (board[legPos.row][legPos.col]) continue
    addIfValid(out, board, pieces, source, {
      row: source.currentPos.row + p.to.dr,
      col: source.currentPos.col + p.to.dc,
    })
  }

  return out
}

const elephantMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const dirs = [
    { dr: -2, dc: -2 },
    { dr: -2, dc: 2 },
    { dr: 2, dc: -2 },
    { dr: 2, dc: 2 },
  ]

  for (const d of dirs) {
    const eye = { row: source.currentPos.row + d.dr / 2, col: source.currentPos.col + d.dc / 2 }
    if (!inBoard(eye) || board[eye.row][eye.col]) continue
    addIfValid(out, board, pieces, source, {
      row: source.currentPos.row + d.dr,
      col: source.currentPos.col + d.dc,
    })
  }

  return out
}

const advisorMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const dirs = [
    { dr: -1, dc: -1 },
    { dr: -1, dc: 1 },
    { dr: 1, dc: -1 },
    { dr: 1, dc: 1 },
  ]

  for (const d of dirs) {
    addIfValid(out, board, pieces, source, {
      row: source.currentPos.row + d.dr,
      col: source.currentPos.col + d.dc,
    })
  }

  return out
}

const kingMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const dirs = [
    { dr: -1, dc: 0 },
    { dr: 1, dc: 0 },
    { dr: 0, dc: -1 },
    { dr: 0, dc: 1 },
  ]

  for (const d of dirs) {
    const to = { row: source.currentPos.row + d.dr, col: source.currentPos.col + d.dc }
    if (!palaceContains(source.side, to)) continue
    addIfValid(out, board, pieces, source, to)
  }

  return out
}

const pawnMoves = (board: (string | null)[][], pieces: Record<string, Piece>, source: Piece): Position[] => {
  const out: Position[] = []
  const forward = source.side === 'red' ? -1 : 1

  addIfValid(out, board, pieces, source, {
    row: source.currentPos.row + forward,
    col: source.currentPos.col,
  })

  if (riverCrossed(source.side, source.currentPos.row)) {
    addIfValid(out, board, pieces, source, {
      row: source.currentPos.row,
      col: source.currentPos.col - 1,
    })
    addIfValid(out, board, pieces, source, {
      row: source.currentPos.row,
      col: source.currentPos.col + 1,
    })
  }

  return out
}

const getMovesByType = (
  board: (string | null)[][],
  pieces: Record<string, Piece>,
  source: Piece,
  type: PieceType,
): Position[] => {
  switch (type) {
    case 'rook':
      return rookMoves(board, pieces, source)
    case 'horse':
      return horseMoves(board, pieces, source)
    case 'elephant':
      return elephantMoves(board, pieces, source)
    case 'advisor':
      return advisorMoves(board, pieces, source)
    case 'king':
      return kingMoves(board, pieces, source)
    case 'cannon':
      return cannonMoves(board, pieces, source)
    case 'pawn':
      return pawnMoves(board, pieces, source)
    default:
      return []
  }
}

const positionHash = (state: Pick<GameState, 'board' | 'turn'>) => {
  const rows = state.board.map((row) => row.map((cell) => cell ?? '.').join(',')).join('/')
  return `${state.turn}|${rows}`
}

const findKingPos = (state: GameState, side: Side): Position | null => {
  const king = Object.values(state.pieces).find((piece) => piece.alive && piece.side === side && piece.realType === 'king')
  return king ? { ...king.currentPos } : null
}

const isKingsFacing = (state: GameState) => {
  const redKing = findKingPos(state, 'red')
  const blackKing = findKingPos(state, 'black')
  if (!redKing || !blackKing) return false
  if (redKing.col !== blackKing.col) return false

  const top = Math.min(redKing.row, blackKing.row) + 1
  const bottom = Math.max(redKing.row, blackKing.row)
  for (let row = top; row < bottom; row += 1) {
    if (state.board[row][redKing.col]) return false
  }
  return true
}

const isKingInCheck = (state: GameState, side: Side): boolean => {
  const kingPos = findKingPos(state, side)
  if (!kingPos) return true

  if (isKingsFacing(state)) return true

  const enemy = nextSide(side)
  const enemyPieces = Object.values(state.pieces).filter((piece) => piece.alive && piece.side === enemy)

  return enemyPieces.some((piece) => {
    const attacks = getMovesByType(state.board, state.pieces, piece, moveTypeOf(piece))
    return attacks.some((pos) => samePos(pos, kingPos))
  })
}

const cloneState = (state: GameState): GameState => ({
  ...state,
  board: state.board.map((row) => [...row]),
  pieces: Object.fromEntries(Object.entries(state.pieces).map(([id, p]) => [id, { ...p, currentPos: { ...p.currentPos } }])),
  selected: state.selected ? { ...state.selected } : null,
  legalMoves: state.legalMoves.map((m) => ({ ...m })),
  quietMoveCount: state.quietMoveCount,
  positionHistory: [...state.positionHistory],
  checkHistory: [...state.checkHistory],
})

const applyMoveOnState = (state: GameState, move: Move) => {
  const fromId = state.board[move.from.row][move.from.col]
  if (!fromId) return null

  const piece = state.pieces[fromId]
  const targetId = state.board[move.to.row][move.to.col]

  if (targetId) {
    state.pieces[targetId].alive = false
  }

  state.board[move.from.row][move.from.col] = null
  state.board[move.to.row][move.to.col] = fromId
  piece.currentPos = { ...move.to }
  if (!piece.isRevealed) {
    piece.isRevealed = true
  }

  return { mover: piece.side, capturedId: targetId }
}

const legalMovesForPiece = (state: GameState, piece: Piece): Position[] => {
  const pseudoMoves = getMovesByType(state.board, state.pieces, piece, moveTypeOf(piece))
  const out: Position[] = []

  for (const to of pseudoMoves) {
    const sim = cloneState(state)
    const applied = applyMoveOnState(sim, { from: piece.currentPos, to })
    if (!applied) continue
    if (!isKingInCheck(sim, piece.side)) {
      out.push(to)
    }
  }

  return out
}

const sideHasAnyLegalMove = (state: GameState, side: Side) => {
  const ownPieces = Object.values(state.pieces).filter((piece) => piece.alive && piece.side === side)
  return ownPieces.some((piece) => legalMovesForPiece(state, piece).length > 0)
}

const detectLongCheckLoser = (state: GameState, mover: Side): Side | null => {
  const len = state.checkHistory.length
  if (len < 5) return null

  const repeatedCheck =
    state.checkHistory[len - 1] === mover &&
    state.checkHistory[len - 3] === mover &&
    state.checkHistory[len - 5] === mover

  if (!repeatedCheck) return null

  const currentHash = state.positionHistory[state.positionHistory.length - 1]
  const repeatCount = state.positionHistory.filter((hash) => hash === currentHash).length
  if (repeatCount < 3) return null

  return mover
}

const isThreefoldRepetition = (state: GameState) => {
  if (state.positionHistory.length < 3) return false
  const currentHash = state.positionHistory[state.positionHistory.length - 1]
  const repeatCount = state.positionHistory.filter((hash) => hash === currentHash).length
  return repeatCount >= 3
}

const makeMove = (state: GameState, move: Move): GameState => {
  const next = cloneState(state)
  const applied = applyMoveOnState(next, move)
  if (!applied) return state
  const mover = applied.mover

  next.turn = nextSide(next.turn)
  next.selected = null
  next.legalMoves = []
  next.moveCount += 1
  next.quietMoveCount = applied.capturedId ? 0 : next.quietMoveCount + 1

  const redKingAlive = Object.values(next.pieces).some((p) => p.side === 'red' && p.realType === 'king' && p.alive)
  const blackKingAlive = Object.values(next.pieces).some((p) => p.side === 'black' && p.realType === 'king' && p.alive)

  if (!redKingAlive) next.winner = 'black'
  if (!blackKingAlive) next.winner = 'red'

  if (next.winner) {
    next.message = `${sideName(next.winner)}吃将获胜`
    next.positionHistory.push(positionHash(next))
    return next
  }

  const defender = next.turn
  const defenderInCheck = isKingInCheck(next, defender)
  next.checkHistory.push(defenderInCheck ? mover : null)
  next.positionHistory.push(positionHash(next))

  const longCheckLoser = detectLongCheckLoser(next, mover)
  if (longCheckLoser) {
    next.winner = nextSide(longCheckLoser)
    next.message = `${sideName(longCheckLoser)}长打判负，${sideName(next.winner)}获胜`
    return next
  }

  if (isThreefoldRepetition(next)) {
    next.winner = null
    next.isDraw = true
    next.message = '三次重复局面，判和棋'
    return next
  }

  const defenderHasMove = sideHasAnyLegalMove(next, defender)
  if (!defenderHasMove) {
    next.winner = mover
    next.message = defenderInCheck ? `${sideName(mover)}将死获胜` : `${sideName(mover)}困毙获胜`
    return next
  }

  if (next.quietMoveCount >= NATURAL_DRAW_LIMIT_PLIES) {
    next.winner = null
    next.isDraw = true
    next.message = `达到自然限着（${NATURAL_DRAW_LIMIT_PLIES}步无吃子），判和棋`
    return next
  }

  next.message = defenderInCheck ? `轮到${sideName(defender)}（被将军）` : `轮到${sideName(defender)}`

  return next
}

export const createInitialGame = (): GameState => {
  const board = EMPTY_BOARD()
  const pieces: Record<string, Piece> = {}

  const redKingId = 'red-king'
  const blackKingId = 'black-king'

  pieces[redKingId] = {
    id: redKingId,
    side: 'red',
    realType: 'king',
    bornType: 'king',
    isRevealed: true,
    bornPos: { row: 9, col: 4 },
    currentPos: { row: 9, col: 4 },
    alive: true,
  }

  pieces[blackKingId] = {
    id: blackKingId,
    side: 'black',
    realType: 'king',
    bornType: 'king',
    isRevealed: true,
    bornPos: { row: 0, col: 4 },
    currentPos: { row: 0, col: 4 },
    alive: true,
  }

  board[9][4] = redKingId
  board[0][4] = blackKingId

  for (const side of ['red', 'black'] as Side[]) {
    const pool = buildPiecePool(side)
    pool.forEach((item, idx) => {
      const id = `${side}-${idx}`
      const piece: Piece = {
        id,
        side,
        realType: item.realType,
        bornType: item.bornType,
        isRevealed: false,
        bornPos: { ...item.pos },
        currentPos: { ...item.pos },
        alive: true,
      }
      pieces[id] = piece
      board[item.pos.row][item.pos.col] = id
    })
  }

  const initialState: GameState = {
    board,
    pieces,
    turn: 'red',
    selected: null,
    legalMoves: [],
    winner: null,
    isDraw: false,
    quietMoveCount: 0,
    moveCount: 0,
    message: '轮到红方',
    positionHistory: [],
    checkHistory: [],
  }

  initialState.positionHistory.push(positionHash(initialState))
  return initialState
}

export const getPieceLabel = (piece: Piece) => {
  if (!piece.isRevealed) return '暗'
  return pieceText(piece)
}

export const selectCell = (state: GameState, pos: Position): GameState => {
  if (state.winner || state.isDraw) return state
  const next = cloneState(state)
  const id = next.board[pos.row][pos.col]

  if (!id) {
    if (next.selected && next.legalMoves.some((m) => samePos(m, pos))) {
      return makeMove(next, { from: next.selected, to: pos })
    }
    next.selected = null
    next.legalMoves = []
    return next
  }

  const piece = next.pieces[id]

  if (next.selected && next.legalMoves.some((m) => samePos(m, pos))) {
    return makeMove(next, { from: next.selected, to: pos, captureId: id })
  }

  if (piece.side !== next.turn) {
    next.selected = null
    next.legalMoves = []
    return next
  }

  next.selected = { ...pos }
  next.legalMoves = legalMovesForPiece(next, piece)
  return next
}

export const getAllLegalMoves = (state: GameState, side: Side = state.turn): LegalMove[] => {
  if (state.winner || state.isDraw) return []
  if (side !== state.turn) return []

  const ownPieces = Object.values(state.pieces).filter((piece) => piece.alive && piece.side === side)
  const result: LegalMove[] = []

  for (const piece of ownPieces) {
    const moves = legalMovesForPiece(state, piece)
    for (const to of moves) {
      result.push({
        from: { ...piece.currentPos },
        to: { ...to },
      })
    }
  }

  return result
}

export const playMove = (state: GameState, from: Position, to: Position): GameState => {
  if (state.winner || state.isDraw) return state

  const id = state.board[from.row]?.[from.col]
  if (!id) return state

  const piece = state.pieces[id]
  if (!piece || piece.side !== state.turn) return state

  const legalMoves = legalMovesForPiece(state, piece)
  const legal = legalMoves.some((pos) => samePos(pos, to))
  if (!legal) return state

  return makeMove(state, { from: { ...from }, to: { ...to } })
}
