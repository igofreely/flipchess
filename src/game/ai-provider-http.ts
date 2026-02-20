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

const normalizeEngine = (value: unknown): 'pikafish' | 'builtin' | undefined => {
  if (value === 'pikafish' || value === 'pikafish-fallback') return 'pikafish'
  if (value === 'builtin') return 'builtin'
  return undefined
}

const parseTrace = (value: unknown) => {
  if (!Array.isArray(value)) return undefined
  const lines = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return lines.length > 0 ? lines : undefined
}

type HttpAiError = Error & { trace?: string[] }

const parseResult = (payload: unknown): AiSearchResult | null => {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as { side?: unknown; move?: unknown; engine?: unknown; trace?: unknown }
  if (!isSide(candidate.side)) return null
  if (candidate.move !== null && !isMove(candidate.move)) return null
  const engine = normalizeEngine(candidate.engine)
  const trace = parseTrace(candidate.trace)
  return {
    side: candidate.side,
    move: candidate.move,
    engine,
    trace,
  }
}

export const createHttpAiProvider = (options: HttpAiProviderOptions): AiProvider => {
  const timeoutMs = Math.max(200, options.timeoutMs ?? 12_000)
  const controllers = new Set<AbortController>()

  return {
    async search(request: AiSearchRequest) {
      const controller = new AbortController()
      controllers.add(controller)
      // Dynamic timeout: base timeout or budget + overhead, whichever is larger
      const budgetMs = request.timeBudgetMs ?? 0
      const pikafishMs = request.pikafishMaxThinkMs ?? 0
      const maxBudget = Math.max(budgetMs, pikafishMs)
      const dynamicTimeoutMs = maxBudget > 0 ? maxBudget + 5_000 : timeoutMs
      const requestTimeoutMs = request.noLimit
        ? Math.max(timeoutMs, 25_000)
        : Math.max(timeoutMs, dynamicTimeoutMs)
      const timer = window.setTimeout(() => controller.abort(), requestTimeoutMs)

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
          let details = ''
          let trace: string[] | undefined
          try {
            const payload = (await response.json()) as { message?: unknown; trace?: unknown }
            if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
              details = payload.message.trim()
            }
            trace = parseTrace(payload.trace)
          } catch {
            // ignore
          }
          const message = details ? `HTTP AI request failed (${response.status}): ${details}` : `HTTP AI request failed: ${response.status}`
          const error = new Error(message) as HttpAiError
          if (trace) {
            error.trace = trace
          }
          throw error
        }

        const data = (await response.json()) as unknown
        const parsed = parseResult(data)
        if (!parsed) {
          throw new Error('HTTP AI response format invalid')
        }

        return parsed
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error(`HTTP AI request timeout (${requestTimeoutMs}ms)`)
        }
        if (error instanceof TypeError) {
          throw new Error(`HTTP AI request network error: ${error.message}`)
        }
        throw error
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
