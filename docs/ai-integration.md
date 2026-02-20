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

## 7. 服务端接入 Pikafish(jieqi)

当前项目已支持在服务端 AI 回合直接调用 `Pikafish(jieqi)`（模仿 JieqiBox 的 UCI 流程）。

### 7.1 启用方式

给服务端设置以下环境变量即可启用：

```bash
PIKAFISH_JIEQI_PATH=/absolute/path/to/pikafish
PIKAFISH_EVALFILE_PATH=/absolute/path/to/pikafish.nnue
PIKAFISH_THREADS=1
PIKAFISH_HASH_MB=64
```

- `PIKAFISH_JIEQI_PATH`：`jieqi` 分支编译出的可执行文件路径。
- `PIKAFISH_EVALFILE_PATH`：可选，NNUE 文件绝对路径（用于显式指定 `EvalFile`）。
- `PIKAFISH_THREADS`：可选，默认 `1`。
- `PIKAFISH_HASH_MB`：可选，默认 `64`。

未设置 `PIKAFISH_JIEQI_PATH` 时，服务端保持使用内置本地 AI。

### 7.1.1 分支兼容建议

- `jieqi` 与 `jieqi_old` 都可接入；若某一分支出现 NNUE 加载失败，可切换到另一分支验证链路。
- 建议以 `npm run check:pikafish` 为准：输出中的 `firstMoveEngine` 为 `pikafish` 才算真正启用成功。

### 7.2 UCI 调用模式

服务端每次搜索会按如下命令与引擎交互：

```text
uci
setoption name Threads value <threads>
setoption name Hash value <hash>
isready
ucinewgame
position fen <jieqi-old-fen>
go depth <d> movetime <ms>
quit
```

并解析 `bestmove` 的前 4 位坐标（如 `a0a1`），映射回项目坐标后再进行合法性校验。

### 7.3 FEN 约定

服务端输出的是 Jieqi 旧格式 FEN：

`[Board] [Dark Piece Pool] [Side to Move] - - [Halfmove] [Fullmove]`

- 未翻开的棋子使用 `X/x`。
- 暗子池按 `A/B/N/R/C/P` 与小写黑方统计。
