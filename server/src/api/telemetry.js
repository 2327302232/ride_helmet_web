import express from 'express'
import { getHelmetTelemetry, getHelmetTelemetryCurrent, listCollisionEvents } from '../db.js'

const router = express.Router()

function parseRangeQuery(query = {}, defaultLimit = 1000) {
  const opt = {}
  if (query.from !== undefined) opt.from = Number(query.from)
  if (query.to !== undefined) opt.to = Number(query.to)
  opt.limit = query.limit !== undefined ? Number(query.limit) : defaultLimit
  if (!Number.isFinite(opt.limit) || opt.limit <= 0) opt.limit = defaultLimit
  opt.limit = Math.min(opt.limit, 10000)
  return opt
}

function normalizeTelemetryRow(row) {
  if (!row) return null
  return {
    ...row,
    collision: !!row.collision,
    lowPower: row.lowPower == null ? null : !!row.lowPower,
    raw: (() => {
      try { return row.rawJson ? JSON.parse(row.rawJson) : null } catch (e) { return row.rawJson || null }
    })()
  }
}

// GET /api/devices/:deviceId/telemetry/current
router.get('/api/devices/:deviceId/telemetry/current', async (req, res) => {
  try {
    const { deviceId } = req.params
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    const row = getHelmetTelemetryCurrent(deviceId)
    return res.json({ deviceId, telemetry: normalizeTelemetryRow(row) })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/telemetry/current error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/devices/:deviceId/telemetry?from=&to=&limit=
router.get('/api/devices/:deviceId/telemetry', async (req, res) => {
  try {
    const { deviceId } = req.params
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    const opt = { deviceId, ...parseRangeQuery(req.query, 1000) }
    const rows = getHelmetTelemetry(opt).map(normalizeTelemetryRow)
    return res.json({ deviceId, telemetry: rows })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/telemetry error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/devices/:deviceId/collisions?from=&to=&limit=
router.get('/api/devices/:deviceId/collisions', async (req, res) => {
  try {
    const { deviceId } = req.params
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    const opt = { deviceId, ...parseRangeQuery(req.query, 100) }
    const rows = listCollisionEvents(opt).map((r) => ({
      ...r,
      raw: (() => {
        try { return r.rawJson ? JSON.parse(r.rawJson) : null } catch (e) { return r.rawJson || null }
      })()
    }))
    return res.json({ deviceId, collisions: rows })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/collisions error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

export default router