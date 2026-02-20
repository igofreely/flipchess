import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import type { DataStoreSchema, MatchRecord, UserRecord } from './types'

interface UserRow extends RowDataPacket {
  id: string
  username: string
  password_hash: string
  created_at: Date | string
}

interface MatchRow extends RowDataPacket {
  id: string
  mode: MatchRecord['mode']
  status: MatchRecord['status']
  created_at: Date | string
  updated_at: Date | string
  created_by_user_id: string | null
  red_json: string
  black_json: string
  initial_state_json: string
  state_json: string
  draw_offer_json: string
  undo_request_json: string | null
  result: MatchRecord['result']
  termination: string | null
  moves_json: string
}

const toIsoString = (value: Date | string) => {
  if (value instanceof Date) return value.toISOString()
  if (value.includes('T')) return value.endsWith('Z') ? value : `${value}Z`
  return value.replace(' ', 'T').replace(/(?<!Z)$/, 'Z')
}

const toMySqlDateTime = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid datetime value: ${String(value)}`)
  }

  const pad2 = (v: number) => String(v).padStart(2, '0')
  const pad3 = (v: number) => String(v).padStart(3, '0')

  const yyyy = date.getUTCFullYear()
  const mm = pad2(date.getUTCMonth() + 1)
  const dd = pad2(date.getUTCDate())
  const hh = pad2(date.getUTCHours())
  const mi = pad2(date.getUTCMinutes())
  const ss = pad2(date.getUTCSeconds())
  const ms = pad3(date.getUTCMilliseconds())

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`
}

const stringifyJson = (value: unknown) => JSON.stringify(value)

const parseJson = <T>(value: unknown): T => {
  if (typeof value === 'string') {
    return JSON.parse(value) as T
  }

  return value as T
}

const buildPool = (): Pool => {
  const url = process.env.MYSQL_URL?.trim()
  if (url) {
    return mysql.createPool({
      uri: url,
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10),
      dateStrings: true,
      timezone: 'Z',
    })
  }

  return mysql.createPool({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'flipchess',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10),
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
  })
}

export class DataStore {
  private readonly pool: Pool

  constructor() {
    this.pool = buildPool()
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id CHAR(36) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id CHAR(36) PRIMARY KEY,
        mode VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        created_by_user_id CHAR(36) NULL,
        red_json JSON NOT NULL,
        black_json JSON NOT NULL,
        initial_state_json JSON NOT NULL,
        state_json JSON NOT NULL,
        draw_offer_json JSON NOT NULL,
        undo_request_json JSON NULL,
        result VARCHAR(16) NULL,
        termination TEXT NULL,
        moves_json JSON NOT NULL,
        INDEX idx_matches_updated_at (updated_at),
        INDEX idx_matches_status (status),
        INDEX idx_matches_created_by_user (created_by_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  }

  private rowToUser(row: UserRow): UserRecord {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: toIsoString(row.created_at),
    }
  }

  private rowToMatch(row: MatchRow): MatchRecord {
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      createdByUserId: row.created_by_user_id ?? undefined,
      red: parseJson(row.red_json),
      black: parseJson(row.black_json),
      initialState: parseJson(row.initial_state_json),
      state: parseJson(row.state_json),
      drawOfferBySide: parseJson(row.draw_offer_json),
      undoRequest: row.undo_request_json ? parseJson(row.undo_request_json) : null,
      result: row.result,
      termination: row.termination,
      moves: parseJson(row.moves_json),
    }
  }

  async listUsers() {
    const [rows] = await this.pool.query<UserRow[]>('SELECT id, username, password_hash, created_at FROM users')
    return rows.map((row) => this.rowToUser(row))
  }

  async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    const [rows] = await this.pool.query<UserRow[]>('SELECT id, username, password_hash, created_at FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [
      username,
    ])
    const row = rows[0]
    return row ? this.rowToUser(row) : undefined
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const [rows] = await this.pool.query<UserRow[]>('SELECT id, username, password_hash, created_at FROM users WHERE id = ? LIMIT 1', [id])
    const row = rows[0]
    return row ? this.rowToUser(row) : undefined
  }

  async addUser(user: UserRecord) {
    await this.pool.query('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [
      user.id,
      user.username,
      user.passwordHash,
      toMySqlDateTime(user.createdAt),
    ])
  }

  async listMatches() {
    const [rows] = await this.pool.query<MatchRow[]>(
      'SELECT id, mode, status, created_at, updated_at, created_by_user_id, red_json, black_json, initial_state_json, state_json, draw_offer_json, undo_request_json, result, termination, moves_json FROM matches',
    )
    return rows.map((row) => this.rowToMatch(row))
  }

  async findMatchById(matchId: string): Promise<MatchRecord | undefined> {
    const [rows] = await this.pool.query<MatchRow[]>(
      'SELECT id, mode, status, created_at, updated_at, created_by_user_id, red_json, black_json, initial_state_json, state_json, draw_offer_json, undo_request_json, result, termination, moves_json FROM matches WHERE id = ? LIMIT 1',
      [matchId],
    )
    const row = rows[0]
    return row ? this.rowToMatch(row) : undefined
  }

  async upsertMatch(match: MatchRecord) {
    await this.pool.query(
      `INSERT INTO matches (
        id, mode, status, created_at, updated_at, created_by_user_id,
        red_json, black_json, initial_state_json, state_json,
        draw_offer_json, undo_request_json, result, termination, moves_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        mode = VALUES(mode),
        status = VALUES(status),
        created_at = VALUES(created_at),
        updated_at = VALUES(updated_at),
        created_by_user_id = VALUES(created_by_user_id),
        red_json = VALUES(red_json),
        black_json = VALUES(black_json),
        initial_state_json = VALUES(initial_state_json),
        state_json = VALUES(state_json),
        draw_offer_json = VALUES(draw_offer_json),
        undo_request_json = VALUES(undo_request_json),
        result = VALUES(result),
        termination = VALUES(termination),
        moves_json = VALUES(moves_json)`,
      [
        match.id,
        match.mode,
        match.status,
        toMySqlDateTime(match.createdAt),
        toMySqlDateTime(match.updatedAt),
        match.createdByUserId ?? null,
        stringifyJson(match.red),
        stringifyJson(match.black),
        stringifyJson(match.initialState),
        stringifyJson(match.state),
        stringifyJson(match.drawOfferBySide),
        match.undoRequest ? stringifyJson(match.undoRequest) : null,
        match.result,
        match.termination,
        stringifyJson(match.moves),
      ],
    )
  }

  async removeMatch(matchId: string) {
    const [result] = await this.pool.query('DELETE FROM matches WHERE id = ?', [matchId])
    const affectedRows = 'affectedRows' in result ? Number(result.affectedRows) : 0
    return affectedRows > 0
  }

  async exportSnapshot(): Promise<DataStoreSchema> {
    const [users, matches] = await Promise.all([this.listUsers(), this.listMatches()])
    return { users, matches }
  }
}
