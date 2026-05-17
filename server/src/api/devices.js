import express from 'express'
import { addDevice, getDevice, listRegisteredDevices, updateDevice, removeDevice, getDeviceOnline, getLatestStatus, db, addPendingRequest, deletePendingRequestByCmd, setDeviceOnline } from '../db.js'
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
      // 记录本次 pending 请求，并临时将设备置为离线（以本次回复为准）
      try {
        addPendingRequest({ deviceId, cmdId, createdAt: Date.now() })
        try {
          setDeviceOnline({ deviceId, online: false, ts: Date.now(), rawJson: JSON.stringify({ pendingCmdId: cmdId }), updatedAt: Date.now() })
        } catch (e) {
          console.warn('[HTTP] setDeviceOnline failed after request_status', e && e.message ? e.message : e)
        }
      } catch (e) {
        console.warn('[HTTP] addPendingRequest failed', e && e.message ? e.message : e)
      }
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

// GET /api/devices/:deviceId/request_status/:cmdId/result
// 返回与该次下发命令相关的 ack 与 status 记录（只包含 ts >= cmd.ts 的 status）
router.get('/api/devices/:deviceId/request_status/:cmdId/result', async (req, res) => {
  try {
    const { deviceId, cmdId } = req.params
    if (!cmdId) return res.status(400).json({ error: 'cmdId required' })

    // 直接查询 device_commands 表
    const cmdRow = db.prepare('SELECT * FROM device_commands WHERE cmd_id = ?').get(cmdId)
    if (!cmdRow) return res.status(404).json({ error: 'cmd_not_found' })
    if (String(cmdRow.device_id) !== String(deviceId)) return res.status(400).json({ error: 'device_mismatch' })

    // 解析 ack_payload（若存在）
    let ackPayload = null
    try {
      if (cmdRow.ack_payload) ackPayload = JSON.parse(cmdRow.ack_payload)
    } catch (e) { ackPayload = cmdRow.ack_payload }

    // 查询从 cmd.ts 开始的 status 记录（历史状态），优先按 raw_json 中的 online 字段判断
    const statusStmt = db.prepare('SELECT id, device_id AS deviceId, ts, status, message, source, raw_json FROM status WHERE device_id = ? AND ts >= ? ORDER BY ts ASC')
    const statusRows = statusStmt.all(deviceId, cmdRow.ts)

    let onlineFromStatus = null
    for (const s of statusRows) {
      if (s && s.raw_json) {
        try {
          const parsed = JSON.parse(s.raw_json)
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'online')) {
            const on = parsed.online
            if (on === true || on === 1 || on === '1' || on === 'true') onlineFromStatus = true
            else if (on === false || on === 0 || on === '0' || on === 'false') onlineFromStatus = false
            else onlineFromStatus = Boolean(on)
            break
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }

    const cmdInfo = { cmdId: cmdRow.cmd_id, deviceId: cmdRow.device_id, ts: cmdRow.ts, status: cmdRow.status, sentTs: cmdRow.sent_ts, ackTs: cmdRow.ack_ts }
    try { cmdInfo.battery = cmdRow.battery == null ? null : Number(cmdRow.battery) } catch (e) { cmdInfo.battery = cmdRow.battery }
    try { cmdInfo.lowPower = cmdRow.low_power == null ? null : (Number(cmdRow.low_power) === 1) } catch (e) { cmdInfo.lowPower = !!cmdRow.low_power }
    return res.json({ cmd: cmdInfo, ackPayload, statusRecords: statusRows, onlineFromStatus })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/request_status/:cmdId/result error', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

// GET /api/devices/:deviceId/commands?type=...&action=...&limit=10
router.get('/api/devices/:deviceId/commands', async (req, res) => {
  try {
    const { deviceId } = req.params
    const { type, action, limit } = req.query || {}
    const lim = limit ? Number(limit) : 10
    let sql = 'SELECT id, cmd_id AS cmdId, device_id AS deviceId, ts, type, action, value_json AS valueJson, status, sent_ts AS sentTs, ack_ts AS ackTs, ack_payload AS ackPayload, last_error AS lastError, battery, low_power AS lowPower FROM device_commands WHERE device_id = ?'
    const params = [deviceId]
    if (type) { sql += ' AND type = ?'; params.push(String(type)) }
    if (action) { sql += ' AND action = ?'; params.push(String(action)) }
    sql += ' ORDER BY ts DESC LIMIT ?'; params.push(Number(lim))
    const stmt = db.prepare(sql)
    const rows = stmt.all(...params)
    // try to parse ackPayload JSON where possible
    const parsed = rows.map(r => {
      const copy = Object.assign({}, r)
      try { copy.ackPayload = copy.ackPayload ? JSON.parse(copy.ackPayload) : null } catch (e) { /* leave as raw */ }
      try { copy.valueJson = copy.valueJson ? JSON.parse(copy.valueJson) : null } catch (e) { /* ignore */ }
      // normalize battery & lowPower
      try { copy.battery = copy.battery == null ? null : Number(copy.battery) } catch (e) { copy.battery = copy.battery }
      try { copy.lowPower = copy.lowPower == null ? null : (Number(copy.lowPower) === 1) } catch (e) { copy.lowPower = !!copy.lowPower }
      return copy
    })
    return res.json({ commands: parsed })
  } catch (err) {
    console.error('GET /api/devices/:deviceId/commands error', err)
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
