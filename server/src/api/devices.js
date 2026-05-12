import express from 'express'
import { addDevice, getDevice, listRegisteredDevices, updateDevice, removeDevice, getDeviceOnline, getLatestStatus } from '../db.js'
import { publishCommand } from '../mqtt.js'

const router = express.Router()

// GET /api/devices?limit=100&offset=0
router.get('/api/devices', async (req, res) => {
  try {
    const { limit, offset } = req.query || {}
    const opt = {}
    if (limit !== undefined) opt.limit = Number(limit)
    if (offset !== undefined) opt.offset = Number(offset)
    const rows = listRegisteredDevices(opt)
    return res.json({ devices: rows })
  } catch (err) {
    console.error('GET /api/devices error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/devices/:deviceId
router.get('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params
    const row = getDevice(deviceId)
    if (!row) return res.status(404).json({ error: 'not_found' })
    return res.json({ device: row })
  } catch (err) {
    console.error('GET /api/devices/:deviceId error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/devices/:deviceId/online  — 返回设备当前在线状态（来自 device_status_current 表）
router.get('/api/devices/:deviceId/online', async (req, res) => {
  try {
    const { deviceId } = req.params
    const row = getDeviceOnline(deviceId)
    if (row) {
      return res.json({ deviceId: row.deviceId, online: !!row.online, ts: row.ts, rawJson: row.rawJson, updatedAt: row.updatedAt })
    }

    // fallback: if no current online record, try latest status table entry
    try {
      const latest = getLatestStatus(deviceId)
      if (latest) {
        let onlineVal = null
        if (latest.raw_json) {
          try {
            const parsed = JSON.parse(latest.raw_json)
            if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'online')) {
              onlineVal = parsed.online === true || parsed.online === 'true' || parsed.online === 1 || parsed.online === '1'
            }
          } catch (e) {
            // ignore parse errors
          }
        }
        console.log(`[HTTP] GET /api/devices/${deviceId}/online fallback -> latest status ts=${latest.ts} online=${onlineVal}`)
        return res.json({ deviceId, online: onlineVal, ts: latest.ts, status: latest.status, message: latest.message, rawJson: latest.raw_json })
      }
    } catch (e) {
      console.warn('Fallback getLatestStatus failed', e && e.message ? e.message : e)
    }

    return res.json({ deviceId, online: null, ts: null })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/online error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// POST /api/devices/:deviceId/request_status  — 向设备下发请求状态的命令
router.post('/api/devices/:deviceId/request_status', async (req, res) => {
  try {
    const { deviceId } = req.params
    // 下发命令，设备应回复到 /ack 或 /status
    try {
      const cmdId = await publishCommand({ deviceId, type: 'request', action: 'status', value: null })
      return res.status(200).json({ cmdId, status: 'sent' })
    } catch (e) {
      console.error('publishCommand failed', e)
      return res.status(500).json({ error: e?.message || String(e) })
    }
  } catch (err) {
    console.error('POST /api/devices/:deviceId/request_status error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// POST /api/devices
router.post('/api/devices', async (req, res) => {
  try {
    const body = req.body || {}
    const { deviceId, serial, name, userId, metadata } = body
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId (string) is required' })
    const added = addDevice({ deviceId, serial, name, userId, metadata, createdAt: Date.now() })
    if (added && added.existing) return res.status(200).json({ device: added.row, existing: true })
    const row = getDevice(deviceId)
    return res.status(201).json({ device: row })
  } catch (err) {
    console.error('POST /api/devices error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// PUT /api/devices/:deviceId
router.put('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params
    const updates = req.body || {}
    const result = updateDevice(deviceId, updates)
    return res.json(result)
  } catch (err) {
    console.error('PUT /api/devices/:deviceId error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// DELETE /api/devices/:deviceId
router.delete('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params
    const result = removeDevice(deviceId)
    return res.json(result)
  } catch (err) {
    console.error('DELETE /api/devices/:deviceId error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

export default router
