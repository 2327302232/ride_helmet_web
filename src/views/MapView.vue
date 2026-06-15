<template>
  <div class="map-container">
    <div id="map" class="map"></div>
    <div v-if="isLiveMode" class="live-status-panel">
      <div class="live-status-main">
        <span class="live-dot" :class="'live-dot-' + liveStatus"></span>
        <span>{{ liveStatusLabel }}</span>
      </div>
      <div class="live-status-row">设备：{{ liveDeviceId }}</div>
      <div class="live-status-row">最近：{{ liveLastUpdateText }}</div>
      <div class="live-status-row">点位：{{ livePointCount }}</div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import { loadAmapSdk, initMap, createMarker, initGeolocation } from '../utils/amap.js'
import initTrackService from '../utils/trackService.js'
import { splitByGap, segmentTrack } from '../utils/segment.js'
import { useAppStore } from '../stores'
import { showMessage } from '../composables/useMessage'
import { useTrackSelection } from '../stores/trackSelection.js'
// Pinia 轨迹分段选择 store
const selectionStore = useTrackSelection()
const route = useRoute()
const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
const LIVE_GAP_MS = 30 * 60 * 1000
const LIVE_INITIAL_WINDOW_MS = 30 * 60 * 1000
const LIVE_FETCH_LIMIT = 5000
const LIVE_RECONNECT_MS = 1500

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value
}

const isLiveMode = computed(() => firstQueryValue(route.query.mode) === 'live')
const liveDeviceId = computed(() => String(firstQueryValue(route.query.deviceId) || 'dev-001'))
const liveStatus = ref('idle')
const liveLastTsRef = ref(null)
const livePointCount = ref(0)
const liveStatusLabel = computed(() => {
  switch (liveStatus.value) {
    case 'connecting': return '连接中'
    case 'live': return '实时中'
    case 'reconnecting': return '重连中'
    case 'waiting': return '等待实时数据'
    case 'disconnected': return '已断开'
    case 'error': return '连接异常'
    default: return '准备中'
  }
})
const liveLastUpdateText = computed(() => {
  const ts = Number(liveLastTsRef.value)
  if (!Number.isFinite(ts)) return '暂无'
  return new Date(ts).toLocaleString()
})
// segmentId -> points 缓存，避免重复请求
const segmentPointsCache = {}
// 拉取并渲染单个分段
async function _renderSegmentById(segmentId) {
  const meta = selectionStore.meta[segmentId]
  if (!meta) {
    console.warn('[MapView] meta not found for', segmentId)
    return
  }
  // 已有缓存直接渲染
  if (segmentPointsCache[segmentId]) {
    await trackService.renderer.renderSegment(segmentId, segmentPointsCache[segmentId])
    return
  }
  // 拉取后端
  try {
    const params = new URLSearchParams()
    params.set('deviceId', meta.deviceId)
    params.set('from', meta.startTs)
    params.set('to', meta.endTs)
    const url = `${backendBase.replace(/\/$/, '')}/api/track?${params.toString()}`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const pts = Array.isArray(data.points) ? data.points : []
    segmentPointsCache[segmentId] = pts
    await trackService.renderer.renderSegment(segmentId, pts)
    console.debug('[MapView] renderSegment', segmentId, 'points:', pts.length)
  } catch (e) {
    console.warn('[MapView] fetch segment failed', segmentId, e)
  }
}

const status = ref('加载中…')
const posText = ref('-')
const accText = ref('-')
const isLocating = ref(false)

let map
let marker
let geolocation
let trackService = null
const trackReady = ref(false)
let segmentMarkers = []
let stopSelectionWatch = null
let stopModeWatch = null
let liveWs = null
let liveReconnectTimer = null
let liveStopped = true
let liveSessionId = 0
let liveLastTs = null
const liveSeen = new Set()

async function getLocationDiagnostics(extra = {}) {
  const info = {
    href: '',
    origin: '',
    protocol: '',
    hostname: '',
    isSecureContext: false,
    hasNavigatorGeolocation: false,
    permissionsApi: false,
    geolocationPermission: 'unknown',
    userAgent: '',
    ...extra
  }
  try {
    info.href = window.location.href
    info.origin = window.location.origin
    info.protocol = window.location.protocol
    info.hostname = window.location.hostname
    info.isSecureContext = !!window.isSecureContext
    info.userAgent = navigator.userAgent || ''
    info.hasNavigatorGeolocation = !!(navigator && navigator.geolocation)
    info.permissionsApi = !!(navigator && navigator.permissions && navigator.permissions.query)
    if (info.permissionsApi) {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' })
        info.geolocationPermission = perm && perm.state ? perm.state : 'unknown'
      } catch (e) {
        info.geolocationPermission = 'query_failed: ' + (e?.message || String(e))
      }
    }
  } catch (e) {
    info.diagnosticsError = e?.message || String(e)
  }
  console.warn('[geo diagnostics]', info)
  return info
}

function getGeoErrorCode(err) {
  try {
    if (!err) return null
    if (err.code != null) return Number(err.code)
    if (err.result && err.result.code != null) return Number(err.result.code)
  } catch (e) {}
  return null
}

function getGeoErrorMessage(err) {
  try {
    if (!err) return ''
    return err.message || err.info || err.details || (err.result && (err.result.message || err.result.info)) || String(err)
  } catch (e) {
    return String(err)
  }
}

function isPermissionDeniedGeoError(err) {
  const code = getGeoErrorCode(err)
  const msg = getGeoErrorMessage(err)
  return code === 1 || /denied|permission|User denied|用户拒绝|拒绝/i.test(msg)
}

function buildLocationHelpMessage(err) {
  const origin = location && location.origin ? location.origin : '当前网站'
  const msg = getGeoErrorMessage(err)
  if (isPermissionDeniedGeoError(err)) {
    return `浏览器拒绝了 ${origin} 的定位权限。请点击地址栏左侧的锁/网站设置，把“位置信息/定位”改为“允许”，然后刷新页面或点击重试。原始信息：${msg || 'User denied Geolocation'}`
  }
  if (location && location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return `浏览器定位通常要求 HTTPS 安全环境。请使用 https 地址访问后重试。原始信息：${msg || 'unknown'}`
  }
  return msg || '定位失败，请检查浏览器定位权限、系统定位服务和网络。'
}

function formatLocationDiagnostics(diag) {
  try {
    if (!diag) return ''
    return [
      `href: ${diag.href}`,
      `isSecureContext: ${diag.isSecureContext}`,
      `navigator.geolocation: ${diag.hasNavigatorGeolocation}`,
      `permissions.geolocation: ${diag.geolocationPermission}`,
      `protocol: ${diag.protocol}`,
      `hostname: ${diag.hostname}`,
      `errorCode: ${diag.errorCode}`,
      `errorMessage: ${diag.errorMessage}`,
      `userAgent: ${diag.userAgent}`
    ].join('\n')
  } catch (e) {
    return JSON.stringify(diag)
  }
}

function initCitySearch() {
  return new Promise((resolve, reject) => {
    try {
      if (!window.AMap) return reject(new Error('AMap SDK 尚未加载'))
      window.AMap.plugin('AMap.CitySearch', () => {
        try {
          resolve(new window.AMap.CitySearch())
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}

async function locateByCityFallback(reason = null) {
  try {
    status.value = '精确定位不可用，尝试城市级定位…'
    const citySearch = await initCitySearch()
    const cityResult = await new Promise((resolve, reject) => {
      try {
        citySearch.getLocalCity((st, result) => {
          if (st === 'complete' && result) resolve(result)
          else reject(result || new Error('CitySearch failed'))
        })
      } catch (e) {
        reject(e)
      }
    })

    let center = null
    try {
      if (cityResult.bounds && typeof cityResult.bounds.getCenter === 'function') {
        const c = cityResult.bounds.getCenter()
        center = [Number(c.lng), Number(c.lat)]
      }
    } catch (e) {}

    if (center && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
      marker.setPosition(center)
      map.setCenter(center)
      map.setZoom(11)
      posText.value = `${center[0].toFixed(6)}, ${center[1].toFixed(6)}（城市级）`
    } else if (cityResult.city && typeof map.setCity === 'function') {
      map.setCity(cityResult.city)
      posText.value = `${cityResult.city}（城市级）`
    } else {
      throw new Error('城市级定位没有返回可用位置')
    }

    accText.value = '城市级粗略定位'
    status.value = '已使用城市级粗略定位'
    console.warn('[geo city fallback]', { cityResult, reason })
    await showMessage({
      title: '已使用粗略定位',
      message: `浏览器精确定位不可用，已回退到高德城市/IP 粗略定位。若要精确定位，请在 iOS 设置和浏览器站点权限中允许定位。当前城市：${cityResult.city || cityResult.province || '未知'}`,
      details: reason ? formatLocationDiagnostics(reason) : '',
      type: 'warn',
      confirmText: '知道了'
    })
    return true
  } catch (e) {
    console.warn('[geo city fallback failed]', e)
    status.value = '城市级定位也失败'
    return false
  }
}

function _clearSegmentMarkers() {
  try {
    if (Array.isArray(segmentMarkers) && segmentMarkers.length) {
      for (const m of segmentMarkers) {
        try { if (m && typeof m.setMap === 'function') m.setMap(null) } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ } finally { segmentMarkers = [] }
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

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function normalizeLiveTs(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return NaN
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

function normalizeLivePoint(payload) {
  if (!payload) return null
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  const ts = normalizeLiveTs(firstDefined(payload.ts, raw.ts))
  const lng = Number(firstDefined(payload.lng, payload.lon, payload.longitude, raw.lng, raw.lon, raw.longitude))
  const lat = Number(firstDefined(payload.lat, payload.latitude, raw.lat, raw.latitude))
  if (!Number.isFinite(ts) || !Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return {
    ...payload,
    deviceId: String(firstDefined(payload.deviceId, raw.deviceId, liveDeviceId.value)),
    ts,
    lng,
    lat,
    speed: firstDefined(payload.speed, raw.speed, raw.spd),
    battery: firstDefined(payload.battery, raw.battery, raw.bat)
  }
}

function makeLivePointKey(point) {
  return `${liveDeviceId.value}:${point.ts}:${point.lng}:${point.lat}`
}

function resetLivePointState() {
  liveLastTs = null
  liveLastTsRef.value = null
  livePointCount.value = 0
  liveSeen.clear()
}

function rememberLivePoints(points) {
  for (const point of points || []) {
    if (!point) continue
    liveSeen.add(makeLivePointKey(point))
  }
}

async function fetchTrackPoints({ deviceId, from, to, limit = LIVE_FETCH_LIMIT } = {}) {
  const params = new URLSearchParams()
  params.set('deviceId', deviceId || liveDeviceId.value)
  if (from !== undefined) params.set('from', String(from))
  if (to !== undefined) params.set('to', String(to))
  if (limit !== undefined) params.set('limit', String(limit))
  const url = `${backendBase.replace(/\/$/, '')}/api/track?${params.toString()}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = await resp.json()
  return Array.isArray(data.points) ? data.points : []
}

async function renderInitialLiveTrack(sessionId) {
  if (!trackService || liveStopped || sessionId !== liveSessionId) return
  liveStatus.value = 'connecting'
  resetLivePointState()
  try {
    const rawPoints = await fetchTrackPoints({
      deviceId: liveDeviceId.value,
      from: Date.now() - LIVE_INITIAL_WINDOW_MS,
      limit: LIVE_FETCH_LIMIT
    })
    if (liveStopped || sessionId !== liveSessionId) return
    const { segments } = segmentTrack(rawPoints, LIVE_GAP_MS)
    const latest = segments.length ? segments[segments.length - 1] : null
    if (!latest || !Array.isArray(latest.points) || latest.points.length === 0) {
      try { trackService.clearTrack() } catch (e) {}
      liveStatus.value = 'waiting'
      return
    }
    const points = latest.points
    const lastPoint = points[points.length - 1]
    rememberLivePoints(points)
    liveLastTs = lastPoint.ts
    liveLastTsRef.value = lastPoint.ts
    livePointCount.value = points.length
    await trackService.renderer.renderTrack(points)
    if (!liveStopped && sessionId === liveSessionId) liveStatus.value = 'live'
  } catch (e) {
    console.warn('[MapView] initial live track failed', e)
    try { if (trackService) trackService.clearTrack() } catch (err) {}
    resetLivePointState()
    if (!liveStopped && sessionId === liveSessionId) liveStatus.value = 'waiting'
  }
}

async function appendLivePoint(point, sessionId) {
  if (!trackService || liveStopped || sessionId !== liveSessionId || !point) return false
  if (String(point.deviceId || liveDeviceId.value) !== String(liveDeviceId.value)) return false
  if (liveLastTs !== null && point.ts < liveLastTs) return false
  const key = makeLivePointKey(point)
  if (liveSeen.has(key)) return false

  if (liveLastTs !== null && point.ts - liveLastTs > LIVE_GAP_MS) {
    try { trackService.clearTrack() } catch (e) {}
    resetLivePointState()
  }

  liveSeen.add(key)
  liveLastTs = point.ts
  liveLastTsRef.value = point.ts
  try {
    const result = await trackService.appendPoints([point])
    if (result && Array.isArray(result.points)) livePointCount.value = result.points.length
    else livePointCount.value += 1
    liveStatus.value = 'live'
    return true
  } catch (e) {
    console.warn('[MapView] append live point failed', e)
    liveStatus.value = 'error'
    return false
  }
}

async function backfillLiveGap(sessionId) {
  if (!trackService || liveStopped || sessionId !== liveSessionId || liveLastTs === null) return
  try {
    const rawPoints = await fetchTrackPoints({
      deviceId: liveDeviceId.value,
      from: liveLastTs + 1,
      limit: LIVE_FETCH_LIMIT
    })
    if (liveStopped || sessionId !== liveSessionId) return
    const { cleanPoints } = segmentTrack(rawPoints, LIVE_GAP_MS)
    for (const point of cleanPoints) {
      await appendLivePoint(point, sessionId)
    }
  } catch (e) {
    console.warn('[MapView] live backfill failed', e)
  }
}

function scheduleLiveReconnect(sessionId) {
  if (liveStopped || sessionId !== liveSessionId) return
  liveStatus.value = 'reconnecting'
  try { if (liveReconnectTimer) clearTimeout(liveReconnectTimer) } catch (e) {}
  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = null
    connectLiveWs(sessionId, true)
  }, LIVE_RECONNECT_MS)
}

function handleLiveWsMessage(msg, sessionId) {
  if (!msg || liveStopped || sessionId !== liveSessionId) return
  if (msg.type === 'telemetry') {
    const payload = msg.payload || {}
    if (String(payload.deviceId || liveDeviceId.value) !== String(liveDeviceId.value)) return
    const point = normalizeLivePoint(payload)
    appendLivePoint(point, sessionId)
  } else if (msg.type === 'subscribed') {
    if (livePointCount.value === 0) liveStatus.value = 'waiting'
  }
}

function connectLiveWs(sessionId, reconnecting = false) {
  if (liveStopped || sessionId !== liveSessionId) return
  try {
    if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) return
    liveStatus.value = reconnecting ? 'reconnecting' : 'connecting'
    liveWs = new WebSocket(getWsUrl(backendBase))
    liveWs.onopen = () => {
      if (liveStopped || sessionId !== liveSessionId) {
        try { liveWs && liveWs.close() } catch (e) {}
        return
      }
      try { liveWs.send(JSON.stringify({ type: 'subscribe', deviceId: liveDeviceId.value })) } catch (e) {}
      liveStatus.value = livePointCount.value > 0 ? 'live' : 'waiting'
      backfillLiveGap(sessionId)
    }
    liveWs.onmessage = (ev) => {
      try { handleLiveWsMessage(JSON.parse(ev.data), sessionId) } catch (e) {}
    }
    liveWs.onerror = () => {
      if (!liveStopped && sessionId === liveSessionId) liveStatus.value = 'reconnecting'
    }
    liveWs.onclose = () => {
      liveWs = null
      if (!liveStopped && sessionId === liveSessionId) scheduleLiveReconnect(sessionId)
    }
  } catch (e) {
    console.warn('[MapView] live ws connect failed', e)
    scheduleLiveReconnect(sessionId)
  }
}

function stopLiveMode({ clearMap = true } = {}) {
  liveStopped = true
  liveSessionId += 1
  try { if (liveReconnectTimer) clearTimeout(liveReconnectTimer) } catch (e) {}
  liveReconnectTimer = null
  try {
    if (liveWs) {
      liveWs.onopen = null
      liveWs.onmessage = null
      liveWs.onerror = null
      liveWs.onclose = null
      liveWs.close()
    }
  } catch (e) {}
  liveWs = null
  liveStatus.value = 'disconnected'
  resetLivePointState()
  if (clearMap && trackService) {
    try { trackService.clearTrack() } catch (e) {}
  }
}

async function startLiveMode() {
  if (!trackService) return
  stopLiveMode({ clearMap: true })
  if (stopSelectionWatch) {
    stopSelectionWatch()
    stopSelectionWatch = null
  }
  _clearSegmentMarkers()
  try {
    if (trackService.renderer && typeof trackService.renderer.clearAll === 'function') trackService.renderer.clearAll()
    trackService.clearTrack()
  } catch (e) {}
  try {
    if (marker && typeof marker.setMap === 'function') marker.setMap(null)
  } catch (e) {}
  marker = null
  geolocation = null

  liveStopped = false
  const sessionId = liveSessionId + 1
  liveSessionId = sessionId
  await renderInitialLiveTrack(sessionId)
  connectLiveWs(sessionId)
}

function startSelectionRendering() {
  if (stopSelectionWatch || !trackService) return
  stopSelectionWatch = watch(() => selectionStore.selected.slice(), async (newVal, oldVal = []) => {
    if (isLiveMode.value) return
    const newSet = new Set(newVal)
    const oldSet = new Set(oldVal)
    for (const id of newSet) {
      if (!oldSet.has(id)) {
        await _renderSegmentById(id)
      }
    }
    for (const id of oldSet) {
      if (!newSet.has(id)) {
        if (trackService && trackService.renderer && typeof trackService.renderer.clearSegment === 'function') {
          trackService.renderer.clearSegment(id)
          console.debug('[MapView] clearSegment', id)
        }
      }
    }
  }, { immediate: true })
}

async function ensureBrowserLocation() {
  if (!map) return
  if (!marker) marker = createMarker(map, map.getCenter())
  if (!geolocation) geolocation = await initGeolocation()
  status.value = '地图已加载'
  try {
    await locate()
  } catch (e) {
    console.warn('[MapView] locate failed', e)
  }
}

async function startNormalMode() {
  stopLiveMode({ clearMap: true })
  if (stopSelectionWatch) {
    stopSelectionWatch()
    stopSelectionWatch = null
  }
  if (trackService && trackService.renderer && typeof trackService.renderer.clearAll === 'function') {
    try { trackService.renderer.clearAll() } catch (e) {}
  }
  _clearSegmentMarkers()
  await ensureBrowserLocation()
  startSelectionRendering()
}

async function applyCurrentMode() {
  if (!trackService) return
  if (isLiveMode.value) await startLiveMode()
  else await startNormalMode()
}

async function loadTrack() {
  if (!trackService) {
    console.warn('[MapView] trackService not ready')
    await showMessage({ title: '轨迹未就绪', message: '地图尚未初始化', type: 'warn' })
    return
  }

  try {
    const deviceId = 'dev-001'
    const { result, raw } = await trackService.loadTrack({ deviceId })
    if (!result || !result.rendered) {
      await showMessage({ title: '无轨迹数据', message: '无有效轨迹点', type: 'warn' })
    }
    console.debug('[MapView] track rendered', (raw && raw.points) ? raw.points.length : 0)
    // draw per-segment start/end markers
    try {
      const cleaned = (result && result.points) ? result.points : (raw && Array.isArray(raw.points) ? raw.points : [])
      const segments = splitByGap(cleaned)
      _clearSegmentMarkers()
      if (Array.isArray(segments) && segments.length) {
        for (const seg of segments) {
          try {
            const s = seg.points && seg.points[0]
            const e = seg.points && seg.points[seg.points.length - 1]
            if (s) {
              const html = `<div style="width:16px;height:16px;border-radius:50%;background:#2ecc71;border:2px solid #ffffff;box-shadow:0 0 4px rgba(0,0,0,0.12)"></div>`
              const opts = { content: html }
              if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') opts.offset = new window.AMap.Pixel(-8, -8)
              const m = createMarker(map, [s.lng, s.lat], opts)
              segmentMarkers.push(m)
            }
            if (e) {
              const html2 = `<div style="width:16px;height:16px;border-radius:50%;background:#e74c3c;border:2px solid #ffffff;box-shadow:0 0 4px rgba(0,0,0,0.12)"></div>`
              const opts2 = { content: html2 }
              if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') opts2.offset = new window.AMap.Pixel(-8, -8)
              const m2 = createMarker(map, [e.lng, e.lat], opts2)
              segmentMarkers.push(m2)
            }
          } catch (e) { /* ignore individual marker failures */ }
        }
      }
    } catch (e) { console.warn('[MapView] segment markers failed', e) }
  } catch (e) {
    console.error('[MapView] load track error', e)
    await showMessage({ title: '轨迹加载异常', message: e?.message || String(e), type: 'error' })
  }
}

async function locate() {
  if (!geolocation) {
    const res = await showMessage({
      title: '定位未就绪',
      message: '定位组件未就绪，无法定位，请稍后重试。',
      type: 'warn',
      showCancel: true,
      confirmText: '重试',
      cancelText: '关闭'
    })
    if (res && res.action === 'confirm') {
      // 允许用户重试（可能需要外部重新初始化 geolocation）
      try { geolocation = await initGeolocation() } catch (e) { /* ignore */ }
      locate()
    }
    return
  }

  if (isLocating.value) return
  isLocating.value = true

  try {
    // Parameters (可微调)
    const attempts = 3
    const desiredAccuracy = 10 // meters (目标精度)
    const initialTimeout = 100 // ms, 首次等待时间，尽量快速展示结果

    status.value = '高德定位中…'
    accText.value = '-'

    // Helper: wrap AMap geolocation callback into a promise
    const getAmapPositionOnce = () => new Promise((resolve) => {
      try {
        geolocation.getCurrentPosition((st, result) => resolve({ st, result }))
      } catch (e) {
        resolve({ st: 'error', result: e })
      }
    })

    // Helper: promise with timeout that resolves to null on timeout
    const withTimeout = (p, ms) => new Promise((resolve) => {
      let done = false
      p.then((v) => { if (!done) { done = true; resolve(v) } }).catch((e) => { if (!done) { done = true; resolve({ st: 'error', result: e }) } })
      setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    })

    // 1) 尝试快速获取首个结果（短超时），尽快显示给用户
    const initial = await withTimeout(getAmapPositionOnce(), initialTimeout)
    let best = null

    if (initial && initial.st === 'complete' && initial.result && initial.result.position) {
      const acc = initial.result.accuracy != null ? initial.result.accuracy : Infinity
      best = { result: initial.result, acc }
      const lng = initial.result.position.lng
      const lat = initial.result.position.lat
      posText.value = `${lng.toFixed(6)}, ${lat.toFixed(6)}`
      accText.value = acc !== Infinity ? `${Math.round(acc)} m` : '未知'
      marker.setPosition([lng, lat])
      map.setCenter([lng, lat])
      map.setZoom(17)

      if (acc <= desiredAccuracy) {
        status.value = '定位成功'
        return
      }

      // 后台继续优化，但不阻塞用户体验
      status.value = '初始定位完成，后台优化精度中…'

      // 2) 额外尝试，但以后台方式进行，用户先看到初始位置
      for (let i = 0; i < attempts - 1; i++) {
        // small delay between attempts to allow chipset/GNSS to refine
        await new Promise((r) => setTimeout(r, 700))
        const next = await withTimeout(getAmapPositionOnce(), 3000)
        if (next && next.st === 'complete' && next.result && next.result.position) {
          const acc2 = next.result.accuracy != null ? next.result.accuracy : Infinity
          if (!best || acc2 < best.acc) {
            best = { result: next.result, acc: acc2 }
            const lng2 = next.result.position.lng
            const lat2 = next.result.position.lat
            posText.value = `${lng2.toFixed(6)}, ${lat2.toFixed(6)}`
            accText.value = acc2 !== Infinity ? `${Math.round(acc2)} m` : '未知'
            marker.setPosition([lng2, lat2])
            map.setCenter([lng2, lat2])
            map.setZoom(17)
            if (acc2 <= desiredAccuracy) {
              status.value = '定位成功'
              return
            }
          }
        }
      }

      status.value = '定位完成（精度可能有限）'
      return
    }

    // 3) 如果短超时内未得到初始结果，做一次较长的 AMap 定位尝试
    status.value = '等待高德定位结果…'
    const final = await withTimeout(getAmapPositionOnce(), 8000)
    if (final && final.st === 'complete' && final.result && final.result.position) {
      const acc = final.result.accuracy != null ? final.result.accuracy : Infinity
      const lng = final.result.position.lng
      const lat = final.result.position.lat
      posText.value = `${lng.toFixed(6)}, ${lat.toFixed(6)}`
      accText.value = acc !== Infinity ? `${Math.round(acc)} m` : '未知'
      marker.setPosition([lng, lat])
      map.setCenter([lng, lat])
      map.setZoom(17)
      status.value = acc <= desiredAccuracy ? '定位成功' : '定位完成（精度可能有限）'
      return
    }

    // 4) 最后退回到浏览器原生定位
    status.value = '定位失败（高德），尝试浏览器定位…'
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
      })
      const lng = pos.coords.longitude
      const lat = pos.coords.latitude
      const acc = pos.coords.accuracy
      posText.value = `${lng.toFixed(6)}, ${lat.toFixed(6)}`
      accText.value = acc != null ? `${Math.round(acc)} m` : '未知'
      marker.setPosition([lng, lat])
      map.setCenter([lng, lat])
      map.setZoom(17)
      status.value = '浏览器定位成功（回退）'
      return
    } catch (e) {
      console.warn('定位回退失败', e)
      // allow user to retry
      isLocating.value = false
      const denied = isPermissionDeniedGeoError(e)
      const diagnostics = await getLocationDiagnostics({
        stage: 'navigator.geolocation fallback',
        errorCode: getGeoErrorCode(e),
        errorMessage: getGeoErrorMessage(e)
      })
      const cityOk = await locateByCityFallback(diagnostics)
      if (cityOk) return
      const res = await showMessage({
        title: denied ? '定位权限被拒绝' : '定位失败',
        message: buildLocationHelpMessage(e),
        details: formatLocationDiagnostics(diagnostics),
        type: 'error',
        showCancel: true,
        confirmText: '重试',
        cancelText: '关闭'
      })
      if (res && res.action === 'confirm') locate()
      return
    }
  } catch (err) {
    console.error('locate error', err)
    isLocating.value = false
    const denied = isPermissionDeniedGeoError(err)
    const diagnostics = await getLocationDiagnostics({
      stage: 'locate outer catch',
      errorCode: getGeoErrorCode(err),
      errorMessage: getGeoErrorMessage(err)
    })
    const res = await showMessage({
      title: denied ? '定位权限被拒绝' : '定位异常',
      message: buildLocationHelpMessage(err),
      details: formatLocationDiagnostics(diagnostics),
      type: 'error',
      showCancel: true,
      confirmText: '重试',
      cancelText: '关闭'
    })
    if (res && res.action === 'confirm') locate()
    return
  } finally {
    isLocating.value = false
  }
}

onMounted(async () => {
  try {
    status.value = '加载高德 SDK…'
    await loadAmapSdk()

    status.value = '初始化地图…'
    map = initMap('map', { zoom: 14, center: [116.397428, 39.90923] })

    // 初始化轨迹渲染器
    try {
      trackService = initTrackService(map)
      trackReady.value = true
    } catch (e) {
      console.warn('[MapView] initTrackService failed', e)
    }

    await applyCurrentMode()
    stopModeWatch = watch(() => [isLiveMode.value, liveDeviceId.value], () => {
      applyCurrentMode().catch((e) => console.warn('[MapView] mode switch failed', e))
    })

    // Pinia 非侵入式验证（仅用于确认 store 可用，不改 UI）
    try {
      const appStore = useAppStore()
      console.log('[pinia]', appStore.appName, appStore.upperName)
    } catch (e) {
      console.warn('[pinia] store init failed', e)
    }
  } catch (err) {
    status.value = '错误：' + (err?.message || String(err))
    console.error(err)
  }
})

onUnmounted(() => {
  try { if (stopModeWatch) stopModeWatch() } catch (e) {}
  stopModeWatch = null
  try { if (stopSelectionWatch) stopSelectionWatch() } catch (e) {}
  stopSelectionWatch = null
  stopLiveMode({ clearMap: false })
  _clearSegmentMarkers()
})
</script>

<style scoped>
.map-container { position: relative; height: 100vh; width: 100vw; }
.map { height: 100%; width: 100%; }
.live-status-panel {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2000;
  box-sizing: border-box;
  max-width: min(260px, calc(100vw - 24px));
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid rgba(33, 150, 243, 0.18);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
  color: #111;
  font-size: 12px;
  line-height: 1.45;
  backdrop-filter: blur(8px);
}
.live-status-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  color: #1976d2;
  font-size: 14px;
  font-weight: 800;
}
.live-status-row {
  margin-top: 2px;
  overflow-wrap: anywhere;
  color: #555;
}
.live-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #9e9e9e;
  flex: 0 0 auto;
}
.live-dot-live { background: #4caf50; }
.live-dot-connecting,
.live-dot-reconnecting,
.live-dot-waiting { background: #ffb300; }
.live-dot-disconnected,
.live-dot-error { background: #f44336; }
.map-controls { position: absolute; top: 12px; left: 12px; z-index: 2000; }
.map-controls button { padding: 8px 10px; background: white; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
.row { margin: 6px 0; }
button { padding: 8px 10px; }
code { user-select: all; }
@media (max-width: 420px) {
  .live-status-panel {
    top: 10px;
    left: 10px;
    max-width: calc(100vw - 20px);
    padding: 8px 10px;
  }
}
</style>
