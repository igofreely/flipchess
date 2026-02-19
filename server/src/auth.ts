import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import type { AuthPayload } from './types'

const JWT_SECRET = process.env.JWT_SECRET ?? 'flipchess-dev-secret'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d'

export const createAuthToken = (payload: AuthPayload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export interface AuthenticatedRequest extends Request {
  user?: AuthPayload
}

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing bearer token' })
    return
  }

  const token = header.slice('Bearer '.length)
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
    }
    next()
  } catch {
    res.status(401).json({ message: 'Invalid token' })
  }
}
