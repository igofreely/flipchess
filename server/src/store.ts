import fs from 'node:fs'
import path from 'node:path'
import type { DataStoreSchema, MatchRecord, UserRecord } from './types'

const STORE_PATH = path.resolve(process.cwd(), 'server/data/store.json')

const EMPTY_STORE: DataStoreSchema = {
  users: [],
  matches: [],
}

const ensureStoreFile = () => {
  const dir = path.dirname(STORE_PATH)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(EMPTY_STORE, null, 2), 'utf-8')
  }
}

const readStore = (): DataStoreSchema => {
  ensureStoreFile()
  const raw = fs.readFileSync(STORE_PATH, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<DataStoreSchema>
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    matches: Array.isArray(parsed.matches) ? parsed.matches : [],
  }
}

const writeStore = (data: DataStoreSchema) => {
  ensureStoreFile()
  const tempPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tempPath, STORE_PATH)
}

export class DataStore {
  private data: DataStoreSchema

  constructor() {
    this.data = readStore()
  }

  save() {
    writeStore(this.data)
  }

  listUsers() {
    return this.data.users
  }

  findUserByUsername(username: string): UserRecord | undefined {
    return this.data.users.find((user) => user.username.toLowerCase() === username.toLowerCase())
  }

  findUserById(id: string): UserRecord | undefined {
    return this.data.users.find((user) => user.id === id)
  }

  addUser(user: UserRecord) {
    this.data.users.push(user)
    this.save()
  }

  listMatches() {
    return this.data.matches
  }

  findMatchById(matchId: string): MatchRecord | undefined {
    return this.data.matches.find((match) => match.id === matchId)
  }

  upsertMatch(match: MatchRecord) {
    const index = this.data.matches.findIndex((item) => item.id === match.id)
    if (index >= 0) {
      this.data.matches[index] = match
    } else {
      this.data.matches.push(match)
    }
    this.save()
  }

  removeMatch(matchId: string) {
    const index = this.data.matches.findIndex((item) => item.id === matchId)
    if (index < 0) return false
    this.data.matches.splice(index, 1)
    this.save()
    return true
  }
}
