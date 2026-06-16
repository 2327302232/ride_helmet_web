<template>
  <div class="segment-mini-map">
    <div ref="container" class="mini-map-canvas" :style="{ height: height + 'px' }"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, onUnmounted } from 'vue'
import { loadAmapSdk, initMap, addPolyline, createMarker } from '../utils/amap.js'

const props = defineProps({
  points: { type: Array, default: () => [] },
  alertPoint: { type: Object, default: null },
  alertRadius: { type: Number, default: 80 },
  alertLabel: { type: String, default: 'SOS' },
  height: { type: [Number, String], default: 180 },
  // paddingZoom: how much to *zoom out* after fitting the path so there's breathing room.
  // Default 0.8 will slightly zoom out to ensure the path isn't flush to the edges.
  paddingZoom: { type: Number, default: 0.01 }
})

const container = ref(null)
let map = null
let polyline = null

function normalizePoint(point) {
  if (!point) return null
  const lng = Number(point.lng ?? point.lon ?? point.longitude)
  const lat = Number(point.lat ?? point.latitude)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return { ...point, lng, lat }
}

function clearMapOverlays() {
  try {
    if (polyline && typeof polyline.setMap === 'function') {
      polyline.setMap(null)
      polyline = null
    }
    if (map && typeof map.clearMap === 'function') {
      try { map.clearMap() } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

async function renderMini() {
  if (!container.value) return
  try {
    await loadAmapSdk()
    if (!map) {
      map = initMap(container.value, { zoom: 14, center: [116.397428, 39.90923], resizeEnable: true })
    } else {
      try { map.clearMap() } catch (e) { /* ignore */ }
    }

    const pts = (props.points || []).map(normalizePoint).filter(Boolean)
    const alertPoint = normalizePoint(props.alertPoint)
    if ((!pts || pts.length === 0) && !alertPoint) return
    const path = pts.map(p => [Number(p.lng), Number(p.lat)])
    const fitOverlays = []
    if (path.length > 1) {
      polyline = addPolyline(map, path, { strokeColor: '#ff8800', strokeWeight: 3 })
      fitOverlays.push(polyline)
    }

    // draw point markers: start, end, and intermediate small points (no click handlers)
    try {
      // start marker
      const s = pts[0]
      if (s) {
        const html = `<div style="width:14px;height:14px;border-radius:50%;background:#2ecc71;border:2px solid #ffffff;box-shadow:0 0 4px rgba(0,0,0,0.12)"></div>`
        const opts = { content: html }
        if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') opts.offset = new window.AMap.Pixel(-7, -7)
        try {
          const m = createMarker(map, [Number(s.lng), Number(s.lat)], opts)
          if (m) fitOverlays.push(m)
        } catch (e) { /* ignore */ }
      }
      // end marker
      const e = pts[pts.length - 1]
      if (e && pts.length > 1) {
        const html2 = `<div style="width:14px;height:14px;border-radius:50%;background:#e74c3c;border:2px solid #ffffff;box-shadow:0 0 4px rgba(0,0,0,0.12)"></div>`
        const opts2 = { content: html2 }
        if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') opts2.offset = new window.AMap.Pixel(-7, -7)
        try {
          const m = createMarker(map, [Number(e.lng), Number(e.lat)], opts2)
          if (m) fitOverlays.push(m)
        } catch (err) { /* ignore */ }
      }
      // intermediate points
      if (pts.length > 2) {
        for (let i = 1; i < pts.length - 1; i++) {
          const p = pts[i]
          if (!p) continue
          const htmlP = `<div style="width:8px;height:8px;border-radius:50%;background:#ff8800;border:1px solid #ffffff;box-shadow:0 0 2px rgba(0,0,0,0.08)"></div>`
          const optsP = { content: htmlP }
          if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') optsP.offset = new window.AMap.Pixel(-4, -4)
          try { createMarker(map, [Number(p.lng), Number(p.lat)], optsP) } catch (err) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore marker failures */ }

    if (alertPoint) {
      try {
        const center = [Number(alertPoint.lng), Number(alertPoint.lat)]
        if (window.AMap && typeof window.AMap.Circle === 'function') {
          const circle = new window.AMap.Circle({
            center,
            radius: Number(props.alertRadius) || 80,
            strokeColor: '#d50000',
            strokeWeight: 2,
            strokeOpacity: 0.95,
            fillColor: '#ff1744',
            fillOpacity: 0.16,
            zIndex: 120
          })
          map.add(circle)
          fitOverlays.push(circle)
        }
        const html = `<div style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:#d50000;color:#fff;border:3px solid #fff;box-shadow:0 0 0 6px rgba(213,0,0,0.18),0 4px 12px rgba(0,0,0,0.28);font-size:10px;font-weight:800;line-height:1">${String(props.alertLabel || 'SOS')}</div>`
        const opts = { content: html, zIndex: 130 }
        if (typeof window !== 'undefined' && window.AMap && typeof window.AMap.Pixel === 'function') opts.offset = new window.AMap.Pixel(-17, -17)
        const marker = createMarker(map, center, opts)
        if (marker) fitOverlays.push(marker)
      } catch (e) {
        console.warn('SegmentMiniMap alert marker failed', e)
      }
    }

      try {
        const PIXEL_PADDING = 10
        if (map && typeof map.setFitView === 'function' && fitOverlays.length) {
          // try to use AMap's padding support (either array [l,t,r,b] or single number)
          try {
            map.setFitView(fitOverlays, [PIXEL_PADDING, PIXEL_PADDING, PIXEL_PADDING, PIXEL_PADDING])
          } catch (e1) {
            try { map.setFitView(fitOverlays, PIXEL_PADDING) } catch (e2) { map.setFitView(fitOverlays) }
          }
        } else {
          // fallback bbox (best-effort): compute center and pick zoom by bbox heuristics
          const bboxPath = path.length ? path : (alertPoint ? [[alertPoint.lng, alertPoint.lat]] : [])
          let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
          for (const pt of bboxPath) {
            const lng = Number(pt[0]), lat = Number(pt[1])
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
            if (lng < minLng) minLng = lng
            if (lng > maxLng) maxLng = lng
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
          }
          if (minLng !== Infinity) {
            const center = [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
            try { map.setCenter(center) } catch (e) { /* ignore */ }
            const lngDiff = maxLng - minLng
            const latDiff = maxLat - minLat
            const maxDiff = Math.max(lngDiff, latDiff)
            let zoom = 14
            if (maxDiff < 0.0005) zoom = 19
            else if (maxDiff < 0.001) zoom = 18
            else if (maxDiff < 0.005) zoom = 17
            else if (maxDiff < 0.01) zoom = 16
            else if (maxDiff < 0.02) zoom = 15
            else if (maxDiff < 0.05) zoom = 14
            else if (maxDiff < 0.1) zoom = 13
            else if (maxDiff < 0.5) zoom = 11
            else if (maxDiff < 1) zoom = 9
            else zoom = 8
            try { map.setZoom(Math.max(3, zoom)) } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { console.warn('SegmentMiniMap fit failed', e) }
  } catch (e) {
    console.warn('SegmentMiniMap init failed', e)
  }
}

onMounted(() => { renderMini() })
watch(() => props.points, () => { renderMini() }, { deep: true })
watch(() => props.alertPoint, () => { renderMini() }, { deep: true })
onUnmounted(() => {
  try { clearMapOverlays() } catch (e) { /* ignore */ }
  try { if (map && typeof map.destroy === 'function') map.destroy() } catch (e) { /* ignore */ }
  map = null
})
</script>

<style scoped>
.segment-mini-map { border-radius: 8px; overflow: hidden; border: 1px solid #e3eaf2; margin-top: 8px }
.mini-map-canvas { width: 100%; }
</style>
