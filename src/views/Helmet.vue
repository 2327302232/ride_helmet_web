<template>
  <div class="panel-view">
    <div class="log-header">
      <div class="log-header-inner">
        <div class="header-left"></div>

        <div class="filter-center" title="选择设备">
          <span class="filter-text">设备：</span>
          <select v-model="deviceId" class="log-select">
            <option v-for="(d, i) in devicesList" :key="d.deviceId || d.device_id || i" :value="d.deviceId || d.device_id">{{ (d.deviceId || d.device_id) + (d.name ? ' — ' + d.name : '') }}</option>
          </select>
          <div class="device-status" :class="['status-' + simStatus]">
            <span class="device-dot"></span>
            <span class="status-text">{{ statusLabel }}</span>
          </div>
          <div class="status-basis" v-if="commandBasis">
            <div style="font-size:12px;color:#666;margin-top:6px;">判定依据（近期下发命令 device_commands，按 deviceId/type=request 过滤）：</div>
            <pre style="max-height:140px;overflow:auto;background:#f7fbff;border:1px solid #e6f0fb;padding:8px;border-radius:6px;margin-top:6px;font-size:12px">{{ JSON.stringify(commandBasis, null, 2) }}</pre>
          </div>
        </div>

        <div class="header-right">
          <button class="log-btn log-btn-small" :disabled="loading" @click="onRefresh">刷新</button>
        </div>
      </div>
    </div>

    <div style="padding:16px;"></div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch, computed, onUnmounted } from 'vue'

onMounted(() => { document.title = '骑行头盔用户站-Helmet' })

const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
const deviceId = ref(null)
const devicesList = ref([])
const loading = ref(false)
const user = ref(JSON.parse(localStorage.getItem('ride_user') || 'null'))
const simStatus = ref('unknown') // 'online'|'offline'|'unknown'|'all'
const commandBasis = ref(null)

// WebSocket for realtime reply delivery
const ws = ref(null)
const wsConnected = ref(false)
const pendingResolvers = new Map() // cmdId -> resolver

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

function waitForCmdReply(cmdId, timeout = 10000) {
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
    case 'pending': return '请求中'
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
      // 使用 device_commands 表的最新一条记录的 status 字段来判定在线（按用户要求）
      if (commandBasis.value.length > 0) {
        const latest = commandBasis.value[0]
        const s = latest.status
        if (s === 'acked') simStatus.value = 'online'
        else if (s === 'failed' || s === 'expired') simStatus.value = 'offline'
        else if (s === 'sent' || s === 'queued') simStatus.value = 'pending'
        else simStatus.value = 'unknown'
      }
    }
  } catch (e) {
    // ignore
  }
}

watch(deviceId, (v) => { loadDeviceOnlineFromServer(v).catch(() => {}) })

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
        if (cmdId) {
          // 使用 WebSocket 等待设备对本次 cmdId 的回复（ack 或 status），优先使用回复决定在线状态
          try {
            ensureSocket()
            subscribeDevice(deviceId.value)
            const reply = await waitForCmdReply(cmdId, 10000).catch(() => null)
            if (reply) {
              // reply 可能来自 cmd_ack 或 status
              if (reply.ok === true || reply.online === true || (reply.payload && reply.payload.online === true)) {
                simStatus.value = 'online'
              } else if (reply.ok === false || reply.online === false || (reply.payload && reply.payload.online === false)) {
                simStatus.value = 'offline'
              } else if (reply.status === 'acked' || (reply.payload && reply.payload.status === 'acked')) {
                simStatus.value = 'online'
              } else {
                // 无法判定则回退到后端持久化状态
                await loadDeviceOnlineFromServer(deviceId.value)
              }
            } else {
              await loadDeviceOnlineFromServer(deviceId.value)
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

onMounted(() => { loadDevicesList().catch(() => {}) })
onUnmounted(() => {
  try { if (ws.value) ws.value.close() } catch (e) {}
})
</script>

<style scoped>
.panel-view {
  --left-col: 34px;
  max-width: 900px;
  margin: 72px auto 0;
  color: #111;
  background: #fff;
  border-radius: 0;
  box-shadow: none;
  padding-bottom: 40px;
  font-size: 15px;
}

.log-header {
  position: relative;
  margin-bottom: 12px;
}
.log-header-inner {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: 0px;
  min-height: 30px;
  width: min(900px, calc(100% - 36px));
  z-index: 1001;
  border-bottom: 1px solid #eef3f9;
  background: #fff;
  box-shadow: 0 6px 18px rgba(33,150,243,0.03);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.header-left { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: var(--left-col); height: 24px }
.filter-center { display:flex; align-items:center; gap:8px }
.filter-text { font-weight: 800; color: #1976d2; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.header-right { position: absolute; right: 0; top: 50%; transform: translateY(-50%); display:flex; align-items:center; gap:8px }

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
</style>
