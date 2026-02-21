import type { GameState, Position, Side } from '../game/types'

const inferApiBase = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:3001/api'
  }
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  return `${protocol}//${window.location.hostname}:3001/api`
}

export const SERVER_API_BASE = (import.meta.env.VITE_SERVER_API_BASE as string | undefined) ?? inferApiBase()

export interface ServerUser {
  id: string
  username: string
  createdAt: string
}

export interface ServerMatchSide {
  type: 'user' | 'ai'
  userId?: string
  username?: string | null
  aiDepth: number
  aiTimeBudgetMs: number
  aiEngine?: 'pikafish' | 'builtin'
  aiPikafishMaxThinkMs?: number
}

export interface ServerMoveRecord {
  ply: number
  side: Side
  actor: 'user' | 'ai'
  aiEngine?: 'pikafish' | 'builtin'
  from: Position
  to: Position
  pieceText: string
  createdAt: string
}

export interface ServerMatch {
  id: string
  mode: 'pvp' | 'vs_ai' | 'ai_vs_ai'
  status: 'ongoing' | 'finished'
  createdAt: string
  updatedAt: string
  createdByUserId?: string
  red: ServerMatchSide
  black: ServerMatchSide
  layoutSetupRequired?: boolean
  layoutReadyBySide?: Record<Side, boolean>
  initialState?: GameState
  drawOfferBySide: Record<Side, boolean>
  undoRequest: {
    fromSide: Side
    requestedAt: string
  } | null
  state: GameState
  result: 'red' | 'black' | 'draw' | null
  termination: string | null
  moves: ServerMoveRecord[]
}

export interface RankingItem {
  userId: string
  username: string
  registeredAt: string
  wins: number
  losses: number
  draws: number
  games: number
  points: number
  winRate: number
  reachedAt: string
}

const request = async <T>(path: string, init?: RequestInit, token?: string): Promise<T> => {
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(`${SERVER_API_BASE}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = (await response.json()) as { message?: string }
      if (data.message) message = data.message
    } catch {
      // ignore
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}

export const serverApi = {
  register(username: string, password: string) {
    return request<{ token: string; user: ServerUser }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      undefined,
    )
  },
  login(username: string, password: string) {
    return request<{ token: string; user: ServerUser }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      undefined,
    )
  },
  me(token: string) {
    return request<{ user: ServerUser }>('/auth/me', undefined, token)
  },
  listMatches(token: string, mine = true) {
    return request<{ matches: ServerMatch[] }>(`/matches?mine=${mine ? 'true' : 'false'}`, undefined, token)
  },
  createMatch(
    token: string,
    payload: {
      mode: 'pvp' | 'vs_ai' | 'ai_vs_ai'
      opponentUsername?: string
      aiSide?: Side
      aiDepthBySide?: Partial<Record<Side, number>>
      aiTimeBudgetBySide?: Partial<Record<Side, number>>
      aiEngineBySide?: Partial<Record<Side, 'pikafish' | 'builtin'>>
      aiPikafishMaxThinkBySide?: Partial<Record<Side, number>>
      fenSetup?: GameState
    },
  ) {
    return request<{ match: ServerMatch }>('/matches', { method: 'POST', body: JSON.stringify(payload) }, token)
  },
  getMatch(token: string, matchId: string) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}`, undefined, token)
  },
  updateMatchAiConfig(
    token: string,
    matchId: string,
    payload: {
      aiDepthBySide?: Partial<Record<Side, number>>
      aiTimeBudgetBySide?: Partial<Record<Side, number>>
      aiEngineBySide?: Partial<Record<Side, 'pikafish' | 'builtin'>>
      aiPikafishMaxThinkBySide?: Partial<Record<Side, number>>
    },
  ) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}/ai-config`, { method: 'PATCH', body: JSON.stringify(payload) }, token)
  },
  deleteMatch(token: string, matchId: string) {
    return request<{ ok: boolean; matchId: string }>(`/matches/${matchId}`, { method: 'DELETE' }, token)
  },
  move(token: string, matchId: string, from: Position, to: Position) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }, token)
  },
  submitLayout(token: string, matchId: string, fenSetup: GameState) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}/layout-submit`, { method: 'POST', body: JSON.stringify({ fenSetup }) }, token)
  },
  drawOffer(token: string, matchId: string) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}/draw-offer`, { method: 'POST' }, token)
  },
  resign(token: string, matchId: string) {
    return request<{ match: ServerMatch }>(`/matches/${matchId}/resign`, { method: 'POST' }, token)
  },
  undoRequest(token: string, matchId: string, action?: 'request' | 'cancel' | 'accept' | 'reject') {
    return request<{ match: ServerMatch }>(
      `/matches/${matchId}/undo-request`,
      { method: 'POST', body: JSON.stringify(action ? { action } : {}) },
      token,
    )
  },
  rankings() {
    return request<{ ranking: RankingItem[] }>('/rankings')
  },
}
