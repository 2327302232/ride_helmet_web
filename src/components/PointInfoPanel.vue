<template>
  <div ref="containerRef" v-show="visible" class="pip-container" role="region" aria-label="点信息面板">
    <div class="pip-header">
      <div class="pip-left" aria-hidden="true"></div>
        <div class="pip-center">
        <button class="pip-btn pip-prev" @click="onPrev" :disabled="!options.onPrev" title="上一个" aria-label="上一个">
          <img v-if="icons && icons.prev" :src="icons.prev" alt="上一个" />
        </button>
        <button class="pip-btn pip-play" @click="onTogglePlay" :disabled="!options.onTogglePlay || (!options.canPlay && !isPlaying)" :title="isPlaying ? '停止' : (options.canPlay ? '开始' : '无法播放')" :aria-label="isPlaying ? '停止' : (options.canPlay ? '开始' : '无法播放')">
          <img v-if="(isPlaying ? icons.stop : icons.play)" :src="isPlaying ? icons.stop : icons.play" :alt="isPlaying ? '停止' : '开始'" />
        </button>
        <button class="pip-btn pip-next" @click="onNext" :disabled="!options.onNext" title="下一个" aria-label="下一个">
          <img v-if="icons && icons.next" :src="icons.next" alt="下一个" />
        </button>
      </div>
      <button class="pip-close" @click="onClose" aria-label="关闭">×</button>
    </div>
    <div class="pip-body">
      <slot>
        <div v-if="options.data">
          <div class="pip-row"><strong>经纬度：</strong><span>{{ displayFields.latlng }}</span></div>
          <div class="pip-row"><strong>时间：</strong><span>{{ displayFields.time }}</span></div>
          <div class="pip-row"><strong>速度：</strong><span>{{ displayFields.speed }}</span></div>
          <div class="pip-row"><strong>心率：</strong><span>{{ displayFields.heartRate }}</span></div>
          <div class="pip-row"><strong>温度：</strong><span>{{ displayFields.temperature }}</span></div>
          <div class="pip-row"><strong>湿度：</strong><span>{{ displayFields.humidity }}</span></div>
          <div class="pip-row"><strong>电量：</strong><span>{{ displayFields.battery }}</span></div>
          <div class="pip-row"><strong>省电模式：</strong><span>{{ displayFields.lowPower }}</span></div>
          <div class="pip-row" :class="{ 'pip-alert': displayFields.collisionAlert }"><strong>碰撞检测：</strong><span>{{ displayFields.collision }}</span></div>
        </div>
        <div v-else class="pip-placeholder">点信息将在此显示。</div>
      </slot>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import panelIcons from '../lib/panelIcons.js'

const visible = ref(false)
const containerRef = ref(null)
const options = reactive({ title: '', data: null, onPrev: null, onNext: null, onTogglePlay: null, canPlay: true })
const icons = reactive({ prev: panelIcons.prev, play: panelIcons.play, stop: panelIcons.stop, next: panelIcons.next })
const isPlaying = ref(false)

let _resolver = null

function open(opts = {}) {
  options.title = opts.title || '点信息'
  options.data = opts.data || null
  options.onPrev = typeof opts.onPrev === 'function' ? opts.onPrev : null
  options.onNext = typeof opts.onNext === 'function' ? opts.onNext : null
  options.onTogglePlay = typeof opts.onTogglePlay === 'function' ? opts.onTogglePlay : null
  // whether play action is allowed (if at end, set false to disable play)
  options.canPlay = typeof opts.canPlay === 'boolean' ? opts.canPlay : true

  // allow providing icon URLs via opts.icons
  icons.prev = opts.icons && opts.icons.prev ? opts.icons.prev : icons.prev
  icons.play = opts.icons && opts.icons.play ? opts.icons.play : icons.play
  icons.stop = opts.icons && opts.icons.stop ? opts.icons.stop : icons.stop
  icons.next = opts.icons && opts.icons.next ? opts.icons.next : icons.next

  visible.value = true
  isPlaying.value = !!opts.isPlaying
  return new Promise((resolve) => { _resolver = resolve })
}

function close(result = { action: 'close' }) {
  visible.value = false
  if (_resolver) {
    _resolver(result)
    _resolver = null
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('pointPanel:close', { detail: result }))
    }
  } catch (e) { /* ignore */ }
}

function onClose() { close({ action: 'close' }) }

function onPrev() {
  if (typeof options.onPrev === 'function') {
    try { options.onPrev() } catch (e) { console.warn('onPrev callback failed', e) }
  }
}

function onNext() {
  if (typeof options.onNext === 'function') {
    try { options.onNext() } catch (e) { console.warn('onNext callback failed', e) }
  }
}

function onTogglePlay() {
  isPlaying.value = !isPlaying.value
  if (typeof options.onTogglePlay === 'function') {
    try { options.onTogglePlay(isPlaying.value) } catch (e) { console.warn('onTogglePlay callback failed', e) }
  }
}

function setIcons(ic = {}) {
  icons.prev = ic.prev || icons.prev
  icons.play = ic.play || icons.play
  icons.stop = ic.stop || icons.stop
  icons.next = ic.next || icons.next
}

function setPlaying(v) {
  isPlaying.value = !!v
}

defineExpose({ open, close, prev: onPrev, next: onNext, togglePlay: onTogglePlay, setIcons, setPlaying })

// 精确的双击拦截：只在真正的双击（时间短、位移小）时阻止默认缩放
let _lastTapTime = 0
let _lastTapX = 0
let _lastTapY = 0
let _tapTimeout = null
let _touchStartX = 0
let _touchStartY = 0
let _touchMoved = false
const DOUBLE_TAP_MAX_DELAY = 300
const DOUBLE_TAP_MAX_DISTANCE = 30

function _onTouchStart(e) {
  if (!visible.value) return
  if (!e.touches || e.touches.length > 1) { _touchMoved = true; return }
  _touchMoved = false
  const t = e.touches[0]
  _touchStartX = t.clientX
  _touchStartY = t.clientY
}

function _onTouchMove(e) {
  if (_touchMoved) return
  if (!e.touches || e.touches.length === 0) return
  const t = e.touches[0]
  const dx = t.clientX - _touchStartX
  const dy = t.clientY - _touchStartY
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) _touchMoved = true
}

function _onTouchEnd(e) {
  try {
    if (!visible.value) return
    if (!e.changedTouches || e.changedTouches.length === 0) return
    if (_touchMoved) { _lastTapTime = 0; return }
    const t = e.changedTouches[0]
    const now = Date.now()
    const dx = t.clientX - _lastTapX
    const dy = t.clientY - _lastTapY
    const distSq = dx * dx + dy * dy
    if (_lastTapTime && (now - _lastTapTime) <= DOUBLE_TAP_MAX_DELAY && distSq <= (DOUBLE_TAP_MAX_DISTANCE * DOUBLE_TAP_MAX_DISTANCE)) {
      // 识别为双击：阻止默认双击缩放，并触发一次点击
      e.preventDefault()
      e.stopPropagation()
      const el = document.elementFromPoint(t.clientX, t.clientY) || e.target
      try { if (el && typeof el.click === 'function') el.click() } catch (err) { /* ignore */ }
      _lastTapTime = 0
      _lastTapX = 0; _lastTapY = 0
      if (_tapTimeout) { clearTimeout(_tapTimeout); _tapTimeout = null }
      return
    }
    // 记录为单次点击，等待可能的下一次（双击）
    _lastTapTime = now
    _lastTapX = t.clientX
    _lastTapY = t.clientY
    if (_tapTimeout) clearTimeout(_tapTimeout)
    _tapTimeout = setTimeout(() => { _lastTapTime = 0; _tapTimeout = null }, DOUBLE_TAP_MAX_DELAY + 50)
  } catch (err) {
    /* ignore */
  }
}

onMounted(() => {
  try {
    if (containerRef.value && containerRef.value.addEventListener) {
      containerRef.value.addEventListener('touchstart', _onTouchStart, { passive: true })
      containerRef.value.addEventListener('touchmove', _onTouchMove, { passive: true })
      // touchend must be passive:false to allow preventDefault
      containerRef.value.addEventListener('touchend', _onTouchEnd, { passive: false })
    }
  } catch (e) { /* ignore */ }
})

onBeforeUnmount(() => {
  try {
    if (containerRef.value && containerRef.value.removeEventListener) {
      containerRef.value.removeEventListener('touchstart', _onTouchStart)
      containerRef.value.removeEventListener('touchmove', _onTouchMove)
      containerRef.value.removeEventListener('touchend', _onTouchEnd)
    }
  } catch (e) { /* ignore */ }
  if (_tapTimeout) { clearTimeout(_tapTimeout); _tapTimeout = null }
})



function _normalizeTs(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return NaN
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

function _firstValue(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
}

function _formatNumber(raw, unit = '', digits = 1) {
  const v = _firstValue(raw)
  if (v === null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return `${n.toFixed(digits)}${unit}`
}

function _formatBool(raw, trueText = '开启', falseText = '关闭') {
  const v = _firstValue(raw)
  if (v === null) return '—'
  if (v === true || v === 1 || v === '1') return trueText
  if (v === false || v === 0 || v === '0') return falseText
  const s = String(v).toLowerCase()
  if (s === 'true' || s === 'yes' || s === 'on') return trueText
  if (s === 'false' || s === 'no' || s === 'off') return falseText
  return v ? trueText : falseText
}

function _isTruthy(raw) {
  const v = _firstValue(raw)
  if (v === null) return false
  if (v === true || v === 1 || v === '1') return true
  if (v === false || v === 0 || v === '0') return false
  const s = String(v).toLowerCase()
  if (s === 'true' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === 'no' || s === 'off') return false
  return !!v
}

function _formatLocationSource(raw) {
  const v = _firstValue(raw)
  if (v === null) return '未知'
  const s = String(v).trim().toLowerCase()
  if (!s) return '未知'
  if (s === 'gnss' || s === 'gps') return 'GNSS'
  if (s === 'lbs' || s === 'cell' || s === 'cellular' || s === 'base_station' || s === 'basestation') return 'LBS'
  return String(v).toUpperCase()
}

const displayFields = computed(() => {
  const d = options.data
  if (!d) return { latlng: '—', time: '—', speed: '—', heartRate: '—', temperature: '—', humidity: '—', battery: '—', lowPower: '—', collision: '—', collisionAlert: false }
  const ts = _normalizeTs(d.ts)
  const time = Number.isFinite(ts) ? new Date(ts).toISOString() : '—'
  const lng = Number(d.lng); const lat = Number(d.lat)
  const locationSource = _formatLocationSource(_firstValue(d.locationSource, d.location_source, d.locSource, d.loc_source, d.locType, d.loc_type, d.positioning))
  const latlng = (Number.isFinite(lng) && Number.isFinite(lat)) ? `${lng.toFixed(6)}, ${lat.toFixed(6)}（${locationSource}）` : '—'
  const speed = _formatNumber(_firstValue(d.speed, d.spd), ' km/h', 1)
  const heartRate = _formatNumber(_firstValue(d.heartRate, d.heart_rate, d.hr, d.bpm), ' bpm', 0)
  const temperature = _formatNumber(_firstValue(d.temperature, d.temp, d.t), ' ℃', 1)
  const humidity = _formatNumber(_firstValue(d.humidity, d.hum, d.h), ' %', 1)
  const batteryRaw = _firstValue(d.battery, d.bat, d.battery_level, d.batteryLevel)
  const battery = batteryRaw == null ? '—' : (Number.isFinite(Number(batteryRaw)) ? `${Number(batteryRaw)}%` : String(batteryRaw))
  const lowPower = _formatBool(_firstValue(d.lowPower, d.low_power, d.lowPowerMode), '开启', '关闭')
  const collisionAlert = _isTruthy(_firstValue(d.collision, d.crash, d.impact, d.fall))
  const collisionLevel = _firstValue(d.collisionLevel, d.collision_level, d.impactLevel, d.impact_level, d.level)
  const collisionScore = _firstValue(d.collisionScore, d.collision_score, d.impactScore, d.impact_score, d.score)
  const collision = collisionAlert
    ? `异常${collisionLevel ? ' ' + collisionLevel : ''}${collisionScore != null ? ' / ' + collisionScore : ''}`
    : '正常'
  return { latlng, time, speed, heartRate, temperature, humidity, battery, lowPower, collision, collisionAlert }
})
</script>

<style scoped>
.pip-container {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 33vh;
  min-height: 140px;
  max-height: 45vh;
  background: rgba(255,255,255,0.98);
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
  box-shadow: 0 -8px 30px rgba(0,0,0,0.12);
  z-index: 9998;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
}
.pip-header {
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  background: rgba(255,255,255,0.95);
}
.pip-left { width:36px }
.pip-center { display:flex; gap:12px; align-items:center; justify-content:center; flex:1 }
.pip-close { background:transparent; border:none; font-size:22px; padding:6px 8px; cursor:pointer; color:#666; }
.pip-btn { width:44px; height:44px; border-radius:50%; background:#fff; border:1px solid #eee; display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow: 0 1px 6px rgba(0,0,0,0.06); }
/* removed touch-action to avoid interfering with rapid clicks on mobile */
.pip-btn img { width:75%; height:75%; object-fit:contain }
.pip-ic { font-size:18px; color:#333 }
.pip-close { background:transparent; border:none; font-size:22px; padding:6px 8px; cursor:pointer; color:#666; }
.pip-body { padding:10px 12px; overflow:auto; flex:1; }
.pip-pre { margin:0; font-size:13px; color:#333; white-space:pre-wrap; word-break:break-word; }
.pip-placeholder { color:#888; }
.pip-row { display:flex; gap:8px; padding:6px 0; align-items:center; }
.pip-row strong { width:88px; color:#444; font-weight:600; }
.pip-row span { flex:1; min-width:0; word-break:break-word; }
.pip-alert strong, .pip-alert span { color:#c62828; font-weight:700; }
.pip-btn[disabled] { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
@media (max-width:480px) {
  .pip-container { height: 40vh; }
  .pip-btn { width:48px; height:48px }
}
</style>
