<template>
  <div class="panel-view">
    <div class="log-header">
        <h2>
          <div class="header-left-group" ref="deviceSelectRef">
            <div class="device-select" @click.stop="toggleDevices" role="button" tabindex="0">
              <span class="device-select-label">{{ selectedDeviceLabel }}</span>
              <span class="caret">▾</span>
            </div>
            <ul v-if="showDeviceDropdown" class="device-dropdown">
              <li v-for="(d, i) in devicesList" :key="d.deviceId || d.device_id || i" @click.stop="selectDevice(d)" :class="{active: String(deviceId) === String(d.deviceId || d.device_id)}">{{ (d.deviceId || d.device_id) + (d.name ? ' — ' + d.name : '') }}</li>
            </ul>
            <div class="device-status" :class="['status-' + simStatus]">
              <span class="device-dot"></span>
              <span class="status-text">{{ statusLabel }}</span>
            </div>
          </div>
          <button class="log-btn" :disabled="loading" @click="onRefresh">刷新</button>
            </h2>
          </div>

    <div style="padding:16px;">
      <div class="status-bar">
        <div class="status-left">
          <img :src="batteryIcon" alt="battery" class="status-icon" />
          <div class="battery-text">{{ simStatus === 'offline' ? 'unknown' : (batteryLevel + '%') }}</div>
        </div>
      </div>
      <div class="power-save-panel" :class="{disabled: simStatus === 'offline'}">
        <div class="ps-left">
          <span class="ps-label">省电模式</span>
          <span class="ps-desc">{{ simStatus === 'offline' ? '不可用（设备离线）' : (powerSave ? '已启用' : '未启用') }}</span>
        </div>
        <label class="ps-switch">
          <input type="checkbox" :checked="powerSave" @click.prevent="onTogglePowerSave" :disabled="powerSaveLoading || loading || simStatus === 'offline'" />
          <span class="ps-slider"></span>
        </label>
      </div>
      <div class="raw-log-panel">
        <div style="font-size:14px;font-weight:700;margin-bottom:8px;">Raw_Log（页面接收到的数据）</div>
        <pre style="max-height:480px;overflow:auto;background:#fff;border:1px solid #e8e8e8;padding:12px;border-radius:6px;font-size:12px">{{ JSON.stringify(rawLog, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch, computed, onUnmounted } from 'vue'

import batteryWorking from '../assets/battery-working.svg'
import batteryEmpty from '../assets/battery-empty.svg'
import batteryCharge from '../assets/battery-charge.svg'
import batteryFull from '../assets/battery-full.svg'

onMounted(() => { document.title = '骑行头盔用户站-Helmet' })

const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
const deviceId = ref(null)
const devicesList = ref([])
const loading = ref(false)
const user = ref(JSON.parse(localStorage.getItem('ride_user') || 'null'))
const simStatus = ref('unknown') // 'online'|'offline'|'unknown'|'all'
const commandBasis = ref(null)
const powerSave = ref(false)
const powerSaveLoading = ref(false)
const showDeviceDropdown = ref(false)
const deviceSelectRef = ref(null)
const batteryLevel = ref(78)
const charging = ref(false)
const batteryIcon = computed(() => {
  try {
    // If device is offline, show empty icon
    if (simStatus.value === 'offline') return batteryEmpty
    const lvl = Number(batteryLevel.value)
    const v = Number.isFinite(lvl) ? Math.max(0, Math.min(100, Math.round(lvl))) : 0
    // charging has priority
    if (charging.value) return batteryCharge
    // mapping: 0-10 -> empty, 11-80 -> working, 81-100 -> full
    if (v <= 10) return batteryEmpty
    if (v <= 80) return batteryWorking
    return batteryFull
  } catch (e) { return batteryWorking }
})
const selectedDeviceLabel = computed(() => {
  const found = devicesList.value.find(d => String(d.deviceId || d.device_id) === String(deviceId.value))
  if (found) return (found.deviceId || found.device_id) + (found.name ? ' — ' + found.name : '')
  if (devicesList.value.length > 0) return '选择设备'
  return '无设备'
})

function toggleDevices() {
  if (!devicesList.value || devicesList.value.length === 0) return
  showDeviceDropdown.value = !showDeviceDropdown.value
}

function selectDevice(d) {
  deviceId.value = d.deviceId || d.device_id
  showDeviceDropdown.value = false
}

function onDocClick(ev) {
  try {
    if (!deviceSelectRef.value) return
    if (!deviceSelectRef.value.contains(ev.target)) showDeviceDropdown.value = false
  } catch (e) {}
}

// Display state logic (前端判定说明):
// - 当用户点击“刷新”并成功下发命令（后端返回 cmdId）时，立即进入 `pending`（显示“连接中”），并等待设备回复。
// - 在等待期内若收到设备的 `ack` 或 `status` 并且表明在线，则设为 `online`（显示“在线”）；若表明离线，则设为 `offline`（显示“离线”）。
// - 若等待期超时（默认 3 秒）且未收到匹配回复，则视为 `offline`（显示“离线”）。
// - 如果未下发命令（或后端未返回 cmdId），则回退到后端持久化的 `device_status_current` 或历史 `status` 记录来决定（可能为 `online`/`offline`/`unknown`）。
// - commandBasis（device_commands）仅作为“判定依据”展示，其最新一条记录的 status 用于快速预览：
//     - 'acked' => online
//     - 'failed'|'expired' => offline
//     - 'sent'|'queued' => pending
//     - 其它 => unknown

// WebSocket for realtime reply delivery
const ws = ref(null)
const wsConnected = ref(false)
const pendingResolvers = new Map() // cmdId -> resolver

// Raw log: 存放页面接收到的原始数据（WS 消息、API 请求/回复等）
const rawLog = ref([])
function appendRawLog(entry) {
  try {
    const rec = { ts: Date.now(), entry }
    rawLog.value.unshift(rec)
    // 限制长度以防内存无限增长
    if (rawLog.value.length > 300) rawLog.value.length = 300
  } catch (e) {
    // ignore
  }
}

function getWsUrl(base) {
  let url = (base || '').replace(/\/$/, '')
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://')
  else if (url.startsWith('https://')) url = url.replace('https://', 'wss://')
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
  }
  return url + '/ws'
}

function ensureSocket() {
  try {
    if (ws.value && (ws.value.readyState === WebSocket.OPEN || ws.value.readyState === WebSocket.CONNECTING)) return
    const url = getWsUrl(backendBase)
    ws.value = new WebSocket(url)
    wsConnected.value = false
    ws.value.onopen = () => { wsConnected.value = true; if (deviceId.value) subscribeDevice(deviceId.value) }
    ws.value.onclose = () => { wsConnected.value = false }
    ws.value.onerror = () => { wsConnected.value = false }
    ws.value.onmessage = (ev) => {
      try { const msg = JSON.parse(ev.data); handleWsMessage(msg) } catch (e) {}
    }
  } catch (e) {
    // ignore
  }
}

function subscribeDevice(devId) {
  try {
    if (!devId) return
    ensureSocket()
    if (!ws.value) return
    if (ws.value.readyState !== WebSocket.OPEN) {
      // try again shortly
      setTimeout(() => subscribeDevice(devId), 250)
      return
    }
    try { ws.value.send(JSON.stringify({ type: 'subscribe', deviceId: devId })) } catch (e) {}
  } catch (e) {}
}

function handleWsMessage(msg) {
  // 记录所有接收到的 WS 消息到 Raw_Log
  try { appendRawLog({ source: 'ws', data: msg }) } catch (e) {}
  if (!msg || !msg.type) return
  if (msg.type === 'cmd_ack') {
    const p = msg.payload
    if (p && p.cmdId && pendingResolvers.has(p.cmdId)) {
      const fn = pendingResolvers.get(p.cmdId)
      pendingResolvers.delete(p.cmdId)
      try { fn(p) } catch (e) {}
    }
  } else if (msg.type === 'status') {
    const p = msg.payload
    // status payload may include raw object with cmdId
    let cmdId = null
    try {
      if (p && (p.cmdId || p.cmd_id)) cmdId = p.cmdId || p.cmd_id
      if (p && p.raw) {
        const raw = p.raw
        if (raw && (raw.cmdId || raw.cmd_id)) cmdId = raw.cmdId || raw.cmd_id
      }
    } catch (e) {}
    if (cmdId && pendingResolvers.has(cmdId)) {
      const fn = pendingResolvers.get(cmdId)
      pendingResolvers.delete(cmdId)
      try { fn(p) } catch (e) {}
    }
  }
}

function applyReplyState(reply) {
  if (!reply) return false
  const raw = reply.raw || reply.payload || reply
  if (reply.ok === true || raw.ok === true || reply.online === true || raw.online === true) {
    simStatus.value = 'online'
  } else if (reply.ok === false || raw.ok === false || reply.online === false || raw.online === false) {
    simStatus.value = 'offline'
  } else if (reply.status === 'acked' || raw.status === 'acked') {
    simStatus.value = 'online'
  } else {
    return false
  }

  try {
    const b = raw.battery ?? raw.bat ?? raw.battery_level ?? raw.batteryLevel ?? reply.battery
    if (b !== undefined && b !== null) {
      batteryLevel.value = Number(b)
      try { localStorage.setItem('ride_battery', JSON.stringify(Number(b))) } catch (e) {}
    }
  } catch (e) {}

  try {
    const lp = raw.low_power ?? raw.lowPower ?? reply.low_power ?? reply.lowPower
    if (lp !== undefined && lp !== null) {
      powerSave.value = !!lp
      try { localStorage.setItem('ride_power_save', JSON.stringify(!!lp)) } catch (e) {}
    }
  } catch (e) {}

  return true
}

async function fetchCommandResult(devId, cmdId) {
  if (!devId || !cmdId) return null
  try {
    const url = `${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(devId)}/request_status/${encodeURIComponent(cmdId)}/result`
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch (e) {
    return null
  }
}

async function waitForCmdReplyWithFallback(devId, cmdId, timeout = 3000) {
  try {
    const reply = await waitForCmdReply(cmdId, timeout)
    return reply
  } catch (e) {
    // 设备回复可能在 WS 订阅建立前已经被后端收到；超时后再从后端 DB 查询一次该 cmdId 的结果。
    const result = await fetchCommandResult(devId, cmdId)
    try { appendRawLog({ source: 'result_fetch_after_ws_timeout', deviceId: devId, cmdId, data: result }) } catch (err) {}
    if (result) {
      if (result.ackPayload) return result.ackPayload
      if (result.onlineFromStatus !== null && result.onlineFromStatus !== undefined) return { online: !!result.onlineFromStatus, raw: result }
      if (result.cmd && result.cmd.status === 'acked') return { ok: true, raw: result.cmd }
    }
    return null
  }
}

function waitForCmdReply(cmdId, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!cmdId) return reject(new Error('no cmdId'))
    const timer = setTimeout(() => {
      if (pendingResolvers.has(cmdId)) pendingResolvers.delete(cmdId)
      reject(new Error('timeout'))
    }, timeout)
    pendingResolvers.set(cmdId, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

const statusLabel = computed(() => {
  switch (simStatus.value) {
    case 'online': return '在线'
    case 'offline': return '离线'
    case 'pending': return '连接中'
    case 'all': return '全部'
    default: return '未知'
  }
})

async function loadDeviceOnlineFromServer(devId) {
  if (!devId) { simStatus.value = 'unknown'; return }
  // 优先从后端获取 device current online 状态
  try {
    const url = `${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(devId)}/online`
    const res = await fetch(url)
    if (!res.ok) { throw new Error('fetch failed') }
    const data = await res.json().catch(() => null)
    if (data && Object.prototype.hasOwnProperty.call(data, 'online')) {
      const on = data.online
      if (on === true || on === 1 || on === '1' || on === 'true') simStatus.value = 'online'
      else if (on === false || on === 0 || on === '0' || on === 'false') simStatus.value = 'offline'
      else {
        // best-effort fallback: treat truthy as online
        try { simStatus.value = on ? 'online' : 'offline' } catch (e) { simStatus.value = 'unknown' }
      }
      return
    }
  } catch (e) {
    // ignore and fallback to local heuristic
  }

  // 同时加载 device_commands 作为判定依据（仅展示，不改变判定流程）
  try { loadCommandBasis(devId).catch(() => {}) } catch (e) {}

  // 后端不可用时退回到设备对象内的 online 字段或确定性模拟
  const found = devicesList.value.find(d => String(d.deviceId || d.device_id) === String(devId))
  if (found && found.online !== undefined) { simStatus.value = found.online ? 'online' : 'offline'; return }
  if (found) {
    const idStr = String(devId || '')
    let sum = 0
    for (let i = 0; i < idStr.length; i++) sum += idStr.charCodeAt(i)
    simStatus.value = (sum % 2 === 0) ? 'online' : 'offline'
    return
  }
  simStatus.value = 'unknown'
}

async function loadCommandBasis(devId) {
  commandBasis.value = null
  if (!devId) return
  try {
    const url = `${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(devId)}/commands?type=request&action=status&limit=5`
    const res = await fetch(url)
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (data && Array.isArray(data.commands)) {
        commandBasis.value = data.commands
        // 记录从后端读取到的 commandBasis
        try { appendRawLog({ source: 'commands_fetch', deviceId: devId, data: data.commands }) } catch (e) {}
      // 使用 device_commands 表的最新一条记录的 status 字段来判定在线（按用户要求）
      if (commandBasis.value.length > 0) {
        const latest = commandBasis.value[0]
        const s = latest.status
        if (s === 'acked') simStatus.value = 'online'
        else if (s === 'failed' || s === 'expired') simStatus.value = 'offline'
        else if (s === 'sent' || s === 'queued') simStatus.value = 'pending'
        else simStatus.value = 'unknown'
        // read battery and low power state from latest command if available
        try {
          if (latest.battery !== undefined && latest.battery !== null) {
            batteryLevel.value = Number(latest.battery)
            try { localStorage.setItem('ride_battery', JSON.stringify(Number(latest.battery))) } catch (e) {}
          }
        } catch (e) {}
        try {
          if (latest.lowPower !== undefined && latest.lowPower !== null) {
            powerSave.value = !!latest.lowPower
            try { localStorage.setItem('ride_power_save', JSON.stringify(!!latest.lowPower)) } catch (e) {}
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    // ignore
  }
}

// Send a low-power set command via backend and return cmdId
async function sendLowPowerCommand(enable) {
  if (!deviceId.value) throw new Error('no device selected')
  const body = { deviceId: deviceId.value, type: 'power', action: 'set', value: { low_power: !!enable } }
  const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('command publish failed')
  const data = await res.json().catch(() => null)
  return data && data.cmdId ? data.cmdId : null
}

// Handler called when user toggles the power-save slider
// We use click.prevent on the input so the browser won't flip the checkbox
// and we can control visual state explicitly. evOrWant can be an Event or a boolean.
async function onTogglePowerSave(evOrWant) {
  const want = typeof evOrWant === 'boolean' ? evOrWant : !powerSave.value
  const prev = powerSave.value
  // keep visual state unchanged until confirmation; show loading
  powerSaveLoading.value = true
  try {
    const cmdId = await sendLowPowerCommand(want)
    if (!cmdId) throw new Error('no cmdId')
    ensureSocket()
    subscribeDevice(deviceId.value)
    const reply = await waitForCmdReply(cmdId, 3000).catch(() => null)
    try { appendRawLog({ source: 'low_power_reply', deviceId: deviceId.value, cmdId, data: reply }) } catch (e) {}
    if (reply) {
      const ok = reply.ok === true || (reply.payload && reply.payload.ok === true) || (reply.raw && reply.raw.ok === true)
      const lp = (reply.low_power ?? (reply.payload && reply.payload.low_power) ?? (reply.raw && reply.raw.low_power))
      if (ok || (lp !== undefined && String(lp) === String(want))) {
        powerSave.value = want
        try { localStorage.setItem('ride_power_save', JSON.stringify(!!powerSave.value)) } catch (e) {}
      } else {
        // revert to prev (visual will follow reactive state)
        powerSave.value = prev
      }
    } else {
      // timeout -> revert
      powerSave.value = prev
    }
  } catch (e) {
    console.warn('send low power command failed', e)
    powerSave.value = prev
  } finally {
    powerSaveLoading.value = false
  }
}

watch(deviceId, (v) => { loadDeviceOnlineFromServer(v).catch(() => {}) })
watch(powerSave, (v) => { try { localStorage.setItem('ride_power_save', JSON.stringify(!!v)) } catch (e) {} })

async function loadDevicesList() {
  try {
      const url = `${backendBase.replace(/\/$/, '')}/api/devices`
      const res = await fetch(url)
      if (!res.ok) { devicesList.value = []; return }
      const data = await res.json().catch(() => null)
      const all = Array.isArray(data?.devices) ? data.devices : []
      // 仅显示当前登录用户的设备（与 Log 页行为一致）
      if (user.value && user.value.id != null) {
        devicesList.value = all.filter(d => {
          const uid = d.userId !== undefined ? d.userId : (d.user_id !== undefined ? d.user_id : null)
          return uid != null && String(uid) === String(user.value.id)
        })
        // 如果当前选择不在列表里，默认选第一个设备（去掉“全部”选项后适配）
        if (devicesList.value.length > 0) {
          const exists = devicesList.value.some(d => String(d.deviceId || d.device_id) === String(deviceId.value))
          if (!exists) deviceId.value = devicesList.value[0].deviceId || devicesList.value[0].device_id
        } else {
          deviceId.value = null
        }
      } else {
        devicesList.value = []
        deviceId.value = null
      }
  } catch (e) {
    console.warn('loadDevicesList failed', e)
    devicesList.value = []
  }
  // load current device online state after devices list updated
  try { loadDeviceOnlineFromServer(deviceId.value).catch(() => {}) } catch (e) {}
}

async function onRefresh() {
  loading.value = true
  try {
    await loadDevicesList()
    // 请求后端下发状态请求命令到设备（后端会 publish 到 MQTT），并轮询该次下发的结果
    try {
      if (deviceId.value) {
        const reqUrl = `${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(deviceId.value)}/request_status`
        const postRes = await fetch(reqUrl, { method: 'POST' }).catch(() => null)
        const postData = postRes && postRes.ok ? await postRes.json().catch(() => null) : null
        const cmdId = postData && postData.cmdId ? postData.cmdId : null
        try { appendRawLog({ source: 'request_post', deviceId: deviceId.value, data: postData }) } catch (e) {}
        if (cmdId) {
          // 使用 WebSocket 等待设备对本次 cmdId 的回复（ack 或 status），优先使用回复决定在线状态
          try {
            // 在等待期间显示连接中
            // 进入连接中状态，等待设备在指定超时内回复
            simStatus.value = 'pending'
            ensureSocket()
            subscribeDevice(deviceId.value)
            const reply = await waitForCmdReplyWithFallback(deviceId.value, cmdId, 3000)
            try { appendRawLog({ source: 'reply_wait', deviceId: deviceId.value, cmdId, data: reply }) } catch (e) {}
            if (reply) {
              // reply 可能来自 cmd_ack 或 status
              if (!applyReplyState(reply)) {
                // 无法明确判定，回退到后端持久化状态
                await loadDeviceOnlineFromServer(deviceId.value)
              }
            } else {
              // 超时未收到设备回复 -> 明确视为离线（避免与“连接中”状态混淆）
              simStatus.value = 'offline'
            }
          } catch (e) {
            await loadDeviceOnlineFromServer(deviceId.value)
          }
        } else {
          // 无 cmdId 时回退到后端持久化的 online
          await loadDeviceOnlineFromServer(deviceId.value)
        }
      }
    } catch (e) {
      console.warn('request_status error', e)
    }
      // 更新判定依据显示
      try { await loadCommandBasis(deviceId.value) } catch (e) {}
    } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadDevicesList().catch(() => {})
  try { powerSave.value = JSON.parse(localStorage.getItem('ride_power_save') || 'false') } catch (e) { powerSave.value = false }
  try { const b = JSON.parse(localStorage.getItem('ride_battery') || 'null'); if (b != null) batteryLevel.value = Number(b) } catch (e) {}
  try { document.addEventListener('click', onDocClick) } catch (e) {}
})
onUnmounted(() => {
  try { if (ws.value) ws.value.close() } catch (e) {}
  try { document.removeEventListener('click', onDocClick) } catch (e) {}
})
</script>

<style scoped>
.panel-view {
  --left-col: 34px;
  max-width: 1000px;
  margin: 0 auto;
  color: #111;
  background: #fff;
  border-radius: 0;
  box-shadow: none;
  padding: 16px 16px 16px 16px;
  font-size: 15px;
}

.log-header { margin: 0 0 12px 0 }
.log-header h2 { display:flex; justify-content: space-between; align-items: center; white-space: nowrap; overflow: visible; text-overflow: ellipsis; width: 100%; padding: 4px 0px; box-sizing: border-box }
.filter-center { display:flex; align-items:center; gap:8px }
.filter-text { font-weight: 800; color: #1976d2; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.header-right { display:flex; align-items:center; gap:8px }

.header-left-group { display:flex; align-items:center; gap:5px; position:relative; flex: 1 }
.device-select { background:transparent; border:none; padding:0; margin-left:0; color:#000; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:6px }
.device-select-label { max-width:220px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#000 }
.caret { font-size:12px; color:#888 }
.device-dropdown { position:absolute; left:0; top:calc(100% + 8px); background:#fff; border:1px solid #e6eefb; border-radius:6px; box-shadow: 0 6px 18px rgba(33,150,243,0.06); z-index:2000; list-style:none; padding:6px 0; margin:0; min-width:220px; max-height:220px; overflow:auto }
.device-dropdown li { padding:8px 12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#222 }
.device-dropdown li:hover { background:#f5faff }
.device-dropdown li.active { background:#eaf4ff; color:#1976d2; font-weight:700 }
/* Buttons — same visual style as Log page */
.log-btn {
  background: #2196f3;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 18px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(33,150,243,0.08);
  transition: background 0.2s;
}
.log-btn:hover { background: #1976d2 }
.log-btn:disabled { opacity: 0.7; cursor: default }
.log-btn-small { padding: 6px 10px; font-size: 14px; border-radius: 6px }
.log-select { margin-left: 3px; padding: 7px 10px; border: 1px solid #bcdffb; border-radius: 7px; font-size: 15px; outline: none; background: #fff; color: #222 }
.log-select:focus { border-color: #2196f3 }
/* 固定筛选框宽度，与 Log 页 filter-panel 中选择器一致 */
.filter-center .log-select { width: 150px; max-width: 200px }
/* 设备在线状态样式 */
.device-status { display:flex; align-items:center; gap:8px; margin-left:8px }
.device-dot { width:10px; height:10px; border-radius:50% }
.status-online .device-dot { background: #4caf50 }
.status-offline .device-dot { background: #f44336 }
.status-unknown .device-dot { background: #9e9e9e }
.status-all .device-dot { background: #1976d2 }
.status-pending .device-dot { background: #ffb300 }
.status-text { font-size: 14px; font-weight: 700; white-space: nowrap }
.status-online .status-text { color:#4caf50 }
.status-offline .status-text { color:#f44336 }
.status-unknown .status-text { color:#9e9e9e }
.status-all .status-text { color:#1976d2 }
.status-pending .status-text { color:#ffb300 }
.status-bar { display:flex; align-items:center; gap:12px; background:#fafafa; padding:10px 12px; border-radius:8px; margin-bottom:12px; border:1px solid #eef6ff }
.status-left { display:flex; align-items:center; gap:8px }
.status-icon { width:20px; height:20px; display:block }
.battery-text { font-weight:700; color:#1976d2 }
.power-save-panel { display:flex; align-items:center; justify-content:space-between; gap:12px; background:#fafafa; padding:10px 12px; border-radius:8px; margin-bottom:12px; border:1px solid #f0f0f0 }
.power-save-panel .ps-left { display:flex; align-items:center; gap:8px }
.ps-label { font-weight:700; color:#1976d2 }
.ps-desc { font-size:13px; color:#666 }
.ps-switch { position:relative; display:inline-block; width:48px; height:26px }
.ps-switch input { opacity:0; width:0; height:0 }
.ps-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#ccc; transition:.18s; border-radius:20px }
.ps-slider:before { content:""; position:absolute; height:20px; width:20px; left:3px; top:3px; background:#fff; transition:.18s; border-radius:50% }
.ps-switch input:checked + .ps-slider { background:#4caf50 }
.ps-switch input:checked + .ps-slider:before { transform: translateX(22px) }
.power-save-panel.disabled { opacity: 0.55; pointer-events: none }
.power-save-panel.disabled .ps-desc { color: #9e9e9e }
</style>
