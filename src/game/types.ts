export type Side = 'red' | 'black'

export type PieceType =
  | 'king'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'rook'
  | 'cannon'
  | 'pawn'

export interface Position {
  row: number
  col: number
}

export interface Piece {
  id: string
  side: Side
  realType: PieceType
  bornType: PieceType
  isRevealed: boolean
  bornPos: Position
  currentPos: Position
  alive: boolean
}

export interface Move {
  from: Position
  to: Position
  captureId?: string
}

export interface GameState {
  board: (string | null)[][]
  pieces: Record<string, Piece>
  turn: Side
  selected: Position | null
  legalMoves: Position[]
  winner: Side | null
  isDraw: boolean
  quietMoveCount: number
  moveCount: number
  message: string
  positionHistory: string[]
  checkHistory: (Side | null)[]
}
