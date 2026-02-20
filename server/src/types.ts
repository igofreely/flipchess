import type { GameState, Position, Side } from '../../src/game/types'

export type MatchMode = 'pvp' | 'vs_ai' | 'ai_vs_ai'
export type AiEngine = 'pikafish' | 'pikafish-fallback' | 'builtin'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  createdAt: string
}

export interface MatchSideSlot {
  type: 'user' | 'ai'
  userId?: string
  aiDepth: number
  aiTimeBudgetMs: number
  aiEngine?: AiEngine
  aiPikafishMaxThinkMs?: number
}

export interface MoveRecord {
  ply: number
  side: Side
  actor: 'user' | 'ai'
  aiEngine?: AiEngine
  from: Position
  to: Position
  pieceText: string
  createdAt: string
}

export interface MatchRecord {
  id: string
  mode: MatchMode
  status: 'ongoing' | 'finished'
  createdAt: string
  updatedAt: string
  createdByUserId?: string
  red: MatchSideSlot
  black: MatchSideSlot
  initialState: GameState
  state: GameState
  drawOfferBySide: Record<Side, boolean>
  undoRequest: {
    fromSide: Side
    requestedAt: string
  } | null
  result: 'red' | 'black' | 'draw' | null
  termination: string | null
  moves: MoveRecord[]
}

export interface DataStoreSchema {
  users: UserRecord[]
  matches: MatchRecord[]
}

export interface PublicUser {
  id: string
  username: string
  createdAt: string
}

export interface AuthPayload {
  userId: string
  username: string
}
