import { chooseBestAiMoveTimed } from './ai'
import type { AiWorkerResultMessage, AiWorkerSearchMessage } from './ai-provider'

self.onmessage = (event: MessageEvent<AiWorkerSearchMessage>) => {
  const data = event.data
  if (data.type !== 'search') return

  const budget = data.timeBudgetMs ?? 1800
  const move = chooseBestAiMoveTimed(data.state, data.side, data.depth, budget)
  const response: AiWorkerResultMessage = {
    type: 'result',
    requestId: data.requestId,
    side: data.side,
    move,
  }

  self.postMessage(response)
}
