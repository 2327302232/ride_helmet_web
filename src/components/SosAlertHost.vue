<template>
  <MessageModal ref="modalRef">
    <template #body>
      <div v-if="activeSos" class="sos-body">
        <div class="sos-status">
          <span class="sos-pulse"></span>
          <div>
            <div class="sos-title">检测到头盔碰撞</div>
            <div class="sos-subtitle">{{ activeSos.deviceId || '未知设备' }} · {{ formatTs(activeSos.ts) }}</div>
          </div>
        </div>

        <SegmentMiniMap
          v-if="hasLocation(activeSos)"
          :points="sosMapPoints"
          :alert-point="activeSos"
          :height="190"
          :alert-radius="90"
        />

        <div v-else class="sos-no-location">本次碰撞暂未携带有效定位。</div>

        <div class="sos-meta">
          <div>
            <span>等级</span>
            <strong>{{ activeSos.level || '未知' }}</strong>
          </div>
          <div>
            <span>强度</span>
            <strong>{{ activeSos.score ?? '未知' }}</strong>
          </div>
          <div>
            <span>速度</span>
            <strong>{{ formatSpeed(activeSos.speed) }}</strong>
          </div>
        </div>
      </div>
    </template>
  </MessageModal>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MessageModal from './MessageModal.vue'
import SegmentMiniMap from './SegmentMiniMap.vue'

const router = useRouter()
const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
const modalRef = ref(null)
const activeSos = ref(null)

let ws = null
let reconnectTimer = null
let stopped = false
let modalOpen = false
let modalSeq = 0
const subscribedDevices = new Set()
const recentSosKeys = new Map()
const RECENT_SOS_TTL_MS = 15000

const sosMapPoints = computed(() => {
  const p = normalizeSos(activeSos.value)
  return hasLocation(p) ? [p] : []
})

function getWsUrl(base) {
  let url = (base || '').replace(/\/$/, '')
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://')
  else if (url.startsWith('https://')) url = url.replace('https://', 'wss://')
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
  }
  return url + '/ws'
}

function getCurrentUser() {
  try {
    const raw = localStorage.getItem('ride_user')
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function normalizeTs(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return Date.now()
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

function normalizeSos(payload) {
  if (!payload) return null
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  const lng = Number(firstDefined(payload.lng, payload.lon, payload.longitude, raw.lng, raw.lon, raw.longitude))
  const lat = Number(firstDefined(payload.lat, payload.latitude, raw.lat, raw.latitude))
  return {
    ...payload,
    deviceId: firstDefined(payload.deviceId, raw.deviceId),
    ts: normalizeTs(firstDefined(payload.ts, raw.ts)),
    lng: Number.isFinite(lng) ? lng : null,
    lat: Number.isFinite(lat) ? lat : null,
    speed: firstDefined(payload.speed, raw.speed, raw.spd),
    level: firstDefined(payload.level, payload.collisionLevel, payload.collision_level, raw.level, raw.collisionLevel, raw.collision_level),
    score: firstDefined(payload.score, payload.collisionScore, payload.collision_score, raw.score, raw.collisionScore, raw.collision_score),
    message: firstDefined(payload.message, raw.message, 'collision detected'),
    raw
  }
}

function hasLocation(payload) {
  if (!payload) return false
  const lng = Number(payload.lng)
  const lat = Number(payload.lat)
  return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
}

function formatTs(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n)) return '时间未知'
  return new Date(n).toISOString()
}

function formatSpeed(speed) {
  const n = Number(speed)
  if (!Number.isFinite(n)) return '未知'
  return `${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)} km/h`
}

function makeSosKey(payload) {
  const p = normalizeSos(payload)
  if (!p) return ''
  const tsBucket = Math.round(Number(p.ts || Date.now()) / 5000)
  const loc = hasLocation(p) ? `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}` : 'no-loc'
  return `${p.deviceId || 'unknown'}:${tsBucket}:${loc}`
}

function pruneRecentSos() {
  const now = Date.now()
  for (const [key, ts] of recentSosKeys.entries()) {
    if (now - ts > RECENT_SOS_TTL_MS) recentSosKeys.delete(key)
  }
}

function isRecentDuplicate(payload) {
  pruneRecentSos()
  const key = makeSosKey(payload)
  if (!key) return false
  if (recentSosKeys.has(key)) return true
  recentSosKeys.set(key, Date.now())
  return false
}

function vibrateSos() {
  try {
    if (navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate([240, 120, 240, 120, 480])
    }
  } catch (e) {
    // ignore browser support differences
  }
}

function openMapForSos(payload) {
  const p = normalizeSos(payload)
  if (!p || !p.deviceId) return
  const query = {
    mode: 'live',
    deviceId: String(p.deviceId),
    sos: '1',
    sosTs: String(p.ts || Date.now())
  }
  if (hasLocation(p)) {
    query.sosLng = String(p.lng)
    query.sosLat = String(p.lat)
  }
  router.push({ name: 'map', query })
}

async function showSos(payload) {
  const sos = normalizeSos(payload)
  if (!sos || !sos.deviceId) return
  if (isRecentDuplicate(sos)) return
  const seq = modalSeq + 1
  modalSeq = seq
  activeSos.value = sos
  vibrateSos()
  await nextTick()

  if (!modalRef.value || typeof modalRef.value.open !== 'function') return
  if (modalOpen) {
    try { modalRef.value.close({ action: 'replace' }) } catch (e) {}
  }
  modalOpen = true
  const result = await modalRef.value.open({
    title: 'SOS 报警',
    message: '',
    type: 'sos',
    showCancel: true,
    cancelText: '忽略',
    confirmText: '放大地图'
  })
  if (seq !== modalSeq) return
  modalOpen = false

  if (result && result.action === 'confirm') {
    openMapForSos(activeSos.value)
  }
  activeSos.value = null
}

function subscribeDevice(deviceId) {
  if (!deviceId || !ws || ws.readyState !== WebSocket.OPEN) return
  const id = String(deviceId)
  if (subscribedDevices.has(id)) return
  try {
    ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }))
    subscribedDevices.add(id)
  } catch (e) {
    subscribedDevices.delete(id)
  }
}

async function loadAndSubscribeDevices() {
  const user = getCurrentUser()
  if (!user || user.id == null) return
  try {
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/devices`)
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    const devices = Array.isArray(data?.devices) ? data.devices : []
    for (const d of devices) {
      const userId = d.userId !== undefined ? d.userId : d.user_id
      if (userId != null && String(userId) === String(user.id)) {
        subscribeDevice(d.deviceId || d.device_id)
      }
    }
  } catch (e) {
    // best effort only; pages with a selected device can still receive through their own socket.
  }
}

function handleWsMessage(msg) {
  if (!msg || !msg.type) return
  if (msg.type === 'sos') {
    showSos(msg.payload).catch(() => {})
    return
  }
  if (msg.type === 'telemetry') {
    const payload = msg.payload || {}
    if (payload.collision === true || payload.collision === 1 || payload.collision === '1' || payload.collision === 'true') {
      showSos(payload).catch(() => {})
    }
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWs()
  }, 2000)
}

function connectWs() {
  if (stopped) return
  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    ws = new WebSocket(getWsUrl(backendBase))
    ws.onopen = () => {
      subscribedDevices.clear()
      loadAndSubscribeDevices().catch(() => {})
    }
    ws.onmessage = (ev) => {
      try { handleWsMessage(JSON.parse(ev.data)) } catch (e) {}
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      ws = null
      subscribedDevices.clear()
      scheduleReconnect()
    }
  } catch (e) {
    scheduleReconnect()
  }
}

onMounted(() => {
  stopped = false
  connectWs()
})

onUnmounted(() => {
  stopped = true
  try { if (reconnectTimer) clearTimeout(reconnectTimer) } catch (e) {}
  reconnectTimer = null
  try {
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }
  } catch (e) {}
  ws = null
})
</script>

<style scoped>
.sos-body { color:#171717; }
.sos-status {
  display:flex;
  align-items:center;
  gap:12px;
  margin-bottom:10px;
}
.sos-pulse {
  width:42px;
  height:42px;
  border-radius:50%;
  background:#d50000;
  box-shadow:0 0 0 0 rgba(213,0,0,0.45);
  flex:0 0 auto;
  animation:sosPulse 1.2s infinite;
}
.sos-title { font-size:18px; line-height:1.25; font-weight:900; color:#b00020; }
.sos-subtitle { margin-top:2px; color:#666; font-size:12px; overflow-wrap:anywhere; }
.sos-no-location {
  margin-top:8px;
  padding:14px 12px;
  border-radius:8px;
  background:#fff5f5;
  border:1px solid #ffcdd2;
  color:#b00020;
  font-weight:700;
}
.sos-meta {
  display:grid;
  grid-template-columns:repeat(3, minmax(0, 1fr));
  gap:8px;
  margin-top:10px;
}
.sos-meta div {
  min-width:0;
  padding:8px;
  border-radius:8px;
  background:#fafafa;
  border:1px solid #f0f0f0;
}
.sos-meta span {
  display:block;
  color:#777;
  font-size:12px;
  margin-bottom:3px;
}
.sos-meta strong {
  display:block;
  color:#111;
  font-size:14px;
  overflow-wrap:anywhere;
}
@keyframes sosPulse {
  0% { box-shadow:0 0 0 0 rgba(213,0,0,0.45); }
  70% { box-shadow:0 0 0 12px rgba(213,0,0,0); }
  100% { box-shadow:0 0 0 0 rgba(213,0,0,0); }
}
@media (max-width:480px) {
  .sos-title { font-size:17px; }
  .sos-meta { gap:6px; }
  .sos-meta div { padding:7px; }
}
</style>
