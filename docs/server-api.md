# FlipChess 服务器版 API 文档

## 概览

- Base URL: `http://localhost:3001/api`
- 认证方式: `Authorization: Bearer <token>`
- 数据持久化: `server/data/store.json`

## 1) 账号

### 注册

`POST /auth/register`

```json
{
  "username": "player_a",
  "password": "secret123"
}
```

返回：

```json
{
  "token": "...",
  "user": { "id": "...", "username": "player_a", "createdAt": "..." }
}
```

### 登录

`POST /auth/login`

```json
{
  "username": "player_a",
  "password": "secret123"
}
```

### 当前用户

`GET /auth/me`（需要 Token）

## 2) 对局

### 创建对局

`POST /matches`（需要 Token）

#### 人机对战

```json
{
  "mode": "vs_ai",
  "aiSide": "black",
  "aiDepthBySide": { "black": 5 },
  "aiTimeBudgetBySide": { "black": 5000 }
}
```

#### 人人对战

```json
{
  "mode": "pvp",
  "opponentUsername": "player_b"
}
```

#### AI vs AI

```json
{
  "mode": "ai_vs_ai",
  "aiDepthBySide": { "red": 4, "black": 6 },
  "aiTimeBudgetBySide": { "red": 2000, "black": 4000 }
}
```

#### 从 PGN 导入建局（可选字段）

`POST /matches` 额外支持：

```json
{
  "mode": "pvp",
  "opponentUsername": "player_b",
  "pgnSetup": { "...": "GameState" },
  "pgnMoves": [
    { "from": { "row": 9, "col": 4 }, "to": { "row": 8, "col": 4 } }
  ]
}
```

- `pgnSetup`：由导出 PGN 的 `FlipChessSetup` 反序列化得到。
- `pgnMoves`：走子序列，服务器会校验合法性并回放到当前对局。

> 说明：当轮到 AI 且局面未结束时，服务器会自动计算并落子。

### 查询对局列表

`GET /matches?mine=true`（需要 Token）

- `mine=true`（默认）：仅返回当前用户参与的对局
- `mine=false`：返回全部对局

### 查询单局

`GET /matches/:matchId`（需要 Token）

### 删除对局

`DELETE /matches/:matchId`（需要 Token）

- 对局参与玩家可删除。
- 删除后会从平台记录中移除该局（不可恢复）。

返回：

```json
{
  "ok": true,
  "matchId": "..."
}
```

### 落子

`POST /matches/:matchId/move`（需要 Token）

```json
{
  "from": { "row": 9, "col": 4 },
  "to": { "row": 8, "col": 4 }
}
```

返回：更新后的 `match`（包含完整 `state`、`moves`、`result`、`termination`）。

### 协议和棋（提和/取消/接受）

`POST /matches/:matchId/draw-offer`（需要 Token）

- 当前玩家未提和：提交提和。
- 当前玩家已提和：取消提和。
- 对方已提和时调用：自动接受，直接和棋结束。

### 认输

`POST /matches/:matchId/resign`（需要 Token）

- 仅对局参与玩家可调用。
- 调用后该玩家判负，对方判胜。

### 悔棋申请

`POST /matches/:matchId/undo-request`（需要 Token）

请求体可选：

```json
{ "action": "request|cancel|accept|reject" }
```

行为：

- 无待处理请求时：默认/`request` 发起悔棋请求。
- 请求发起方再次调用（或 `cancel`）：取消请求。
- 对方调用 `accept`：同意悔棋，回退 1 步并重建局面。
- 对方调用 `reject`：拒绝悔棋请求。

## 3) 统计与排行

### 平台统计

`GET /stats/overview`

返回字段：

- `totalMatches`
- `ongoingMatches`
- `finishedMatches`
- `redWins`
- `blackWins`
- `draws`
- `totalMoves`

### 排行榜

`GET /rankings`

排序规则：

1. `points`（胜3分，和1分）
2. `wins`
3. `losses`（少者优先）
4. `username`

返回字段：

- `username`
- `games` / `wins` / `losses` / `draws`
- `points`
- `winRate`

## 4) 状态字段约定

对局 `match` 的关键字段：

- `status`: `ongoing` | `finished`
- `result`: `red` | `black` | `draw` | `null`
- `termination`: 终局原因（如将死、困毙、协议和棋、自然限着等）
- `moves`: 全部走棋记录（含 `ply`、`side`、`actor`、`from/to`）

## 5) 快速启动

```bash
npm install
npm run server:dev
```

可选环境变量：

- `PORT`（默认 `3001`）
- `CORS_ORIGIN`（默认 `*`）
- `JWT_SECRET`（默认开发值）
- `JWT_EXPIRES_IN`（默认 `7d`）
