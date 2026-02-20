import type { GameState, Position, Side } from './types'

export interface AiSearchRequest {
  state: GameState
  side: Side
  depth: number
  timeBudgetMs?: number
  noFallback?: boolean
  noLimit?: boolean
  pikafishMaxThinkMs?: number
}

export interface AiSearchResult {
  side: Side
  move: { from: Position; to: Position } | null
  engine?: 'pikafish' | 'builtin'
  trace?: string[]
}

export interface AiProvider {
  search(request: AiSearchRequest): Promise<AiSearchResult>
  dispose(): void
}

export interface AiWorkerSearchMessage {
  type: 'search'
  requestId: number
  state: GameState
  side: Side
  depth: number
  timeBudgetMs?: number
  noFallback?: boolean
  noLimit?: boolean
  pikafishMaxThinkMs?: number
}

export interface AiWorkerResultMessage {
  type: 'result'
  requestId: number
  side: Side
  move: { from: Position; to: Position } | null
  engine?: 'pikafish' | 'builtin'
  trace?: string[]
}

export type AiWorkerMessage = AiWorkerSearchMessage | AiWorkerResultMessage

export const createWorkerAiProvider = (): AiProvider => {
  const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
  let requestId = 0
  const pending = new Map<number, { resolve: (result: AiSearchResult) => void; reject: (error: Error) => void }>()

  worker.onmessage = (event: MessageEvent<AiWorkerResultMessage>) => {
    const data = event.data
    if (data.type !== 'result') return
    const task = pending.get(data.requestId)
    if (!task) return
    pending.delete(data.requestId)
    task.resolve({ side: data.side, move: data.move, engine: data.engine ?? 'builtin', trace: data.trace })
  }

  worker.onerror = () => {
    const error = new Error('AI worker failed')
    pending.forEach(({ reject }) => reject(error))
    pending.clear()
  }

  return {
    search(request) {
      requestId += 1
      const currentId = requestId
      const message: AiWorkerSearchMessage = {
        type: 'search',
        requestId: currentId,
        state: request.state,
        side: request.side,
        depth: request.depth,
        timeBudgetMs: request.timeBudgetMs,
        noFallback: request.noFallback,
        noLimit: request.noLimit,
        pikafishMaxThinkMs: request.pikafishMaxThinkMs,
      }

      worker.postMessage(message)

      return new Promise<AiSearchResult>((resolve, reject) => {
        pending.set(currentId, { resolve, reject })
      })
    },
    dispose() {
      const error = new Error('AI provider disposed')
      pending.forEach(({ reject }) => reject(error))
      pending.clear()
      worker.terminate()
    },
  }
}
