import type { AiProvider, AiSearchRequest, AiSearchResult } from './ai-provider'
import type { Position, Side } from './types'

export interface HttpAiProviderOptions {
  endpoint: string
  timeoutMs?: number
  headers?: Record<string, string>
}

const isSide = (value: unknown): value is Side => value === 'red' || value === 'black'

const isPosition = (value: unknown): value is Position => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Position>
  return typeof candidate.row === 'number' && typeof candidate.col === 'number'
}

const isMove = (value: unknown): value is { from: Position; to: Position } => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { from?: unknown; to?: unknown }
  return isPosition(candidate.from) && isPosition(candidate.to)
}

const parseResult = (payload: unknown): AiSearchResult | null => {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as { side?: unknown; move?: unknown }
  if (!isSide(candidate.side)) return null
  if (candidate.move !== null && !isMove(candidate.move)) return null
  return {
    side: candidate.side,
    move: candidate.move,
  }
}

export const createHttpAiProvider = (options: HttpAiProviderOptions): AiProvider => {
  const timeoutMs = Math.max(200, options.timeoutMs ?? 12_000)
  const controllers = new Set<AbortController>()

  return {
    async search(request: AiSearchRequest) {
      const controller = new AbortController()
      controllers.add(controller)
      const timer = window.setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP AI request failed: ${response.status}`)
        }

        const data = (await response.json()) as unknown
        const parsed = parseResult(data)
        if (!parsed) {
          throw new Error('HTTP AI response format invalid')
        }

        return parsed
      } finally {
        window.clearTimeout(timer)
        controllers.delete(controller)
      }
    },
    dispose() {
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
    },
  }
}
