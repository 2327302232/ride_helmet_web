import express from 'express'
import { addUser, getUserByUsername, listUsers, updateUser, verifyPassword, isPasswordHash } from '../db.js'

const router = express.Router()

// POST /api/test/register
router.post('/api/test/register', async (req, res) => {
  try {
    const body = req.body || {}
    const { username, password, displayName } = body
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username (string) is required' })
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password (string) is required' })
    const added = addUser({ username, password, displayName, createdAt: Date.now() })
    if (added && added.existing) {
      const row = added.row || getUserByUsername(username)
      return res.status(200).json({ existing: true, id: row?.id, username: row?.username, displayName: row?.display_name, createdAt: row?.created_at })
    }
    const row = getUserByUsername(username)
    return res.status(201).json({ id: row?.id, username: row?.username, displayName: row?.display_name, createdAt: row?.created_at })
  } catch (err) {
    console.error('POST /api/test/register error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// POST /api/test/login
router.post('/api/test/login', async (req, res) => {
  try {
    const body = req.body || {}
    const { username, password } = body
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username (string) is required' })
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password (string) is required' })
    const user = getUserByUsername(username)
    if (!user) return res.status(401).json({ error: 'invalid_credentials' })
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'invalid_credentials' })
    // 兼容旧库：如果历史用户仍是明文密码，登录成功后自动升级为 pbkdf2 hash。
    if (!isPasswordHash(user.password_hash)) {
      try { updateUser(username, { password }) } catch (e) { console.warn('password hash upgrade failed', e?.message || e) }
    }
    return res.status(200).json({ id: user.id, username: user.username, displayName: user.display_name })
  } catch (err) {
    console.error('POST /api/test/login error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/test/users
router.get('/api/test/users', async (req, res) => {
  try {
    const { limit, offset } = req.query || {}
    const opt = {}
    if (limit !== undefined) opt.limit = Number(limit)
    if (offset !== undefined) opt.offset = Number(offset)
    const rows = listUsers(opt)
    return res.json({ users: rows })
  } catch (err) {
    console.error('GET /api/test/users error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

export default router
