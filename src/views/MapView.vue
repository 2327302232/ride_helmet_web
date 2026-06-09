<template>
  <div class="map-container">
    <div id="map" class="map"></div>
  
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { loadAmapSdk, initMap, createMarker, initGeolocation } from '../utils/amap.js'
import initTrackService from '../utils/trackService.js'
import { splitByGap } from '../utils/segment.js'
import { useAppStore } from '../stores'
import { showMessage } from '../composables/useMessage'
import { useTrackSelection } from '../stores/trackSelection.js'
// Pinia 轨迹分段选择 store
const selectionStore = useTrackSelection()
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
    const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8787'
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

function _clearSegmentMarkers() {
  try {
    if (Array.isArray(segmentMarkers) && segmentMarkers.length) {
      for (const m of segmentMarkers) {
        try { if (m && typeof m.setMap === 'function') m.setMap(null) } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ } finally { segmentMarkers = [] }
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
      const res = await showMessage({
        title: denied ? '定位权限被拒绝' : '定位失败',
        message: buildLocationHelpMessage(e),
        details: JSON.stringify(e),
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
    const res = await showMessage({
      title: denied ? '定位权限被拒绝' : '定位异常',
      message: buildLocationHelpMessage(err),
      details: JSON.stringify(err),
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

    marker = createMarker(map, map.getCenter())

    geolocation = await initGeolocation()
    status.value = '地图已加载'

    // 先进行定位，再初始化轨迹渲染器并加载轨迹（保证先定位）
    try {
      await locate()
    } catch (e) {
      console.warn('[MapView] locate failed', e)
    }

    // 初始化轨迹渲染器
    try {
      trackService = initTrackService(map)
      trackReady.value = true
    } catch (e) {
      console.warn('[MapView] initTrackService failed', e)
    }

    // 订阅 selected 变化，增量渲染/清理分段
    let prevSelected = new Set(selectionStore.selected)
    watch(() => selectionStore.selected.slice(), async (newVal, oldVal) => {
      const newSet = new Set(newVal)
      const oldSet = new Set(oldVal)
      // 新增
      for (const id of newSet) {
        if (!oldSet.has(id)) {
          await _renderSegmentById(id)
        }
      }
      // 移除
      for (const id of oldSet) {
        if (!newSet.has(id)) {
          if (trackService && trackService.renderer && typeof trackService.renderer.clearSegment === 'function') {
            trackService.renderer.clearSegment(id)
            console.debug('[MapView] clearSegment', id)
          }
        }
      }
    }, { immediate: true })

    // 首次渲染所有已选分段
    for (const id of selectionStore.selected) {
      await _renderSegmentById(id)
    }

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
</script>

<style scoped>
.map-container { position: relative; height: 100vh; width: 100vw; }
.map { height: 100%; width: 100%; }
.map-controls { position: absolute; top: 12px; left: 12px; z-index: 2000; }
.map-controls button { padding: 8px 10px; background: white; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
.row { margin: 6px 0; }
button { padding: 8px 10px; }
code { user-select: all; }
</style>
