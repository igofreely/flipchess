# AI 接口规范与接入文档

本文档说明 FlipChess 的标准 AI 接口（Provider 协议）以及如何接入新的 AI 实现。

## 1. 接口位置

- 协议定义：`src/game/ai-provider.ts`
- 内置实现：`createWorkerAiProvider()`（基于 `src/game/ai.worker.ts`）
- HTTP 实现：`createHttpAiProvider()`（`src/game/ai-provider-http.ts`）

## 2. 标准接口

```ts
export interface AiSearchRequest {
  state: GameState
  side: Side
  depth: number
  timeBudgetMs?: number
}

export interface AiSearchResult {
  side: Side
  move: { from: Position; to: Position } | null
}

export interface AiProvider {
  search(request: AiSearchRequest): Promise<AiSearchResult>
  dispose(): void
}
```

### 字段约定

- `state`：完整棋局状态快照。
- `side`：请求 AI 执棋方（`red`/`black`）。
- `depth`：最大搜索层数。
- `timeBudgetMs`：可选思考预算（毫秒）。
- `move`：返回走法；`null` 表示无合法着法。

## 3. App 侧接入方式（当前实现）

`src/App.tsx` 通过 `AiProvider` 工作：

1. 初始化 Provider：
  - 默认使用 `createWorkerAiProvider()`。
  - 当 `VITE_AI_PROVIDER=http` 且配置 `VITE_AI_HTTP_ENDPOINT` 时，使用 `createHttpAiProvider()`。
   - 卸载时调用 `dispose()`。
2. 在 AI 回合触发 `search()`。
3. 拿到结果后调用 `playMove()` 更新 `game/timeline/moveLogs`。
4. 使用 token 防止旧请求回写（避免竞态）。

## 4. 新 AI 实现接入步骤

### 4.1 本地算法（无 Worker）

实现一个对象满足 `AiProvider`：

```ts
const provider: AiProvider = {
  async search(req) {
    const move = yourSearch(req.state, req.side, req.depth, req.timeBudgetMs)
    return { side: req.side, move }
  },
  dispose() {},
}
```

### 4.2 远程服务 AI（HTTP）

项目已内置 `src/game/ai-provider-http.ts`：

```ts
import { createHttpAiProvider } from './game/ai-provider-http'

const provider = createHttpAiProvider({
  endpoint: 'https://your-ai-service.example.com/search',
  timeoutMs: 12000,
})
```

远程接口请求体即 `AiSearchRequest`，响应体需为 `AiSearchResult`：

```json
{
  "side": "red",
  "move": {
    "from": { "row": 9, "col": 4 },
    "to": { "row": 8, "col": 4 }
  }
}
```

如无合法着法可返回：

```json
{
  "side": "black",
  "move": null
}
```

### 4.3 环境变量切换（推荐）

在 `.env` 或启动命令中设置：

```bash
VITE_AI_PROVIDER=http
VITE_AI_HTTP_ENDPOINT=https://your-ai-service.example.com/search
VITE_AI_HTTP_TIMEOUT_MS=12000
```

不设置时默认仍使用 Worker 本地 AI。

## 5. Worker 协议

`src/game/ai-provider.ts` 同时导出 Worker 消息类型：

- `AiWorkerSearchMessage`
- `AiWorkerResultMessage`

消息格式：

```ts
// request
{
  type: 'search',
  requestId: number,
  state: GameState,
  side: Side,
  depth: number,
  timeBudgetMs?: number
}

// response
{
  type: 'result',
  requestId: number,
  side: Side,
  move: { from: Position; to: Position } | null
}
```

## 6. 接入建议

- 保持纯函数搜索：不要在 AI 内直接修改传入 `state`。
- 总是返回 `side`，便于日志归属与双 AI 场景统计。
- 建议实现超时保护（迭代加深 + 最近完整层回退）。
- 任何异常都应在 Provider 内转换为拒绝 Promise，避免 UI 卡死。
