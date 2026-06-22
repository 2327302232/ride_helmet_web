

<template>
  <div class="log-panel-view" ref="panelRef" :style="{ marginTop: panelTopMargin + 'px' }">
    <div class="log-header">
      <div class="log-header-inner" ref="headerRef">
        <div class="header-left">
          <button class="log-delete-btn" @click="deleteSelected" title="删除记录">
            <img :src="deleteIcon" alt="删除" />
          </button>
        </div>
        <div class="filter-center" role="button" @click="toggleFilter" :title="filterVisible ? '收起筛选' : '展开筛选'">
          <span class="filter-text">筛选</span>
          <img class="filter-icon" :src="filterIcon" alt="toggle" />
        </div>
        <div class="header-right">
          <button class="log-btn log-btn-small" :disabled="trackLoading" @click="onRefresh">刷新</button>
        </div>
      </div>
      <div v-show="filterVisible" ref="filterRef" class="filter-panel">
        <div class="filter-row">
          <label>设备ID：
            <select v-model="filterDevice" class="log-select">
              <option value="all">全部</option>
              <option v-for="(d, i) in devicesList" :key="d.deviceId || d.device_id || i" :value="d.deviceId || d.device_id">{{ (d.deviceId || d.device_id) + (d.name ? ' — ' + d.name : '') }}</option>
            </select>
          </label>
          <label>用户：
            <select v-model="filterUser" class="log-select">
              <option value="all">全部</option>
              <option v-for="u in usersFromDevices" :key="u.id" :value="u.id">{{ u.username }}</option>
            </select>
          </label>
          <label>日期：<input type="date" v-model="filterDate" class="log-input-date" /></label>
          <div class="filter-actions">
            <button class="log-btn" @click="applyFilters">应用</button>
            <button class="log-btn" @click="resetFilters">重置</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="filteredSegments.length === 0" class="log-empty">无骑行分段或尚未加载。</div>
        <ul v-else class="log-segment-list">
          <li v-for="(seg, idx) in filteredSegments" :key="segmentId(seg, idx)" class="log-segment-item">
        <div class="log-seg-title">
          <strong>{{ formatDate(seg.points[0]?.ts) }}</strong>
          <span class="log-seg-device">{{ getDeviceLabel(seg) }}</span>
          <span class="log-seg-count">点数: {{ seg.points.length }}</span>
        </div>
        <div class="log-seg-content">
          <div class="log-seg-row">
            <div class="log-seg-checkbox">
              <input type="checkbox"
                :value="segmentId(seg, idx)"
                :checked="selectionStore.isSelected(segmentId(seg, idx))"
                @change="() => selectionStore.toggle(segmentId(seg, idx))"
              />
            </div>
            <div class="log-seg-time">
              <span class="log-label-bold">时间: </span>
              <span>{{ formatTime(seg.points[0]?.ts) }} ~ {{ formatTime(seg.points[seg.points.length - 1]?.ts) }}</span>
            </div>
          </div>
        </div>
        <div class="mini-map-wrapper">
          <SegmentMiniMap :points="seg.points" :height="180" />
        </div>
      </li>
    </ul>
    <!-- 底部工具栏：左侧复选（全选/部分/未选），中间统计，右侧确定按钮 -->
    <div class="log-footer" ref="footerRef">
      <div class="log-footer-left">
        <input ref="bulkCheckbox" type="checkbox" class="log-footer-checkbox" :checked="allSelected" @change="toggleAll" />
      </div>
      <div class="log-footer-center">
        <span class="total-count">{{ totalCount }} 条记录</span>
        <span v-if="selectedCount > 0" class="selected-count">；已选 {{ selectedCount }} 条</span>
      </div>
      <div class="log-footer-right">
        <button class="log-btn" @click="confirmSelection">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { segmentTrack } from '../utils/segment.js'
import { useTrackSelection } from '../stores/trackSelection.js'
import { showMessage } from '../composables/useMessage'
import expandDown from '../assets/expand-down.svg'
import foldUp from '../assets/fold-up.svg'
import deleteIcon from '../assets/delete.svg'
import SegmentMiniMap from '../components/SegmentMiniMap.vue'
onMounted(() => {
  document.title = '骑行头盔用户站-Log'
  nextTick(() => { updatePanelMargin() })
  window.addEventListener('resize', updatePanelMargin)
  // start polling for current device
  try { appStore.startPolling({ target: 'track', params: { deviceId: deviceId.value }, intervalMs: appStore.defaultPollingIntervalMs }) } catch (e) {}
})

onUnmounted(() => { try { window.removeEventListener('resize', updatePanelMargin) } catch (e) {} })
onUnmounted(() => { try { appStore.stopPolling({ target: 'track', params: { deviceId: deviceId.value } }) } catch (e) {} })

const deviceId = ref('all')
const segments = ref([])
// use app store for track cache and polling
import { useAppDataStore } from '../stores/appDataStore'
const appStore = useAppDataStore()

function getCurrentTrackKey() {
  return appStore.getTrackKey({ deviceId: deviceId.value })
}

const trackLoading = ref(false)
// filter state
const filterVisible = ref(false)
const filterDevice = ref('all')
const filterDate = ref('')
const filterUser = ref('all')
const selectionStore = useTrackSelection()
const router = useRouter()
const bulkCheckbox = ref(null)
const user = ref(JSON.parse(localStorage.getItem('ride_user') || 'null'))
const devicesList = ref([])
const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'

const allUsers = ref([])

const headerRef = ref(null)
const filterRef = ref(null)
const panelRef = ref(null)
const footerRef = ref(null)
const panelTopMargin = ref(16)



const usersFromDevices = computed(() => {
  const map = new Map()
  for (const d of devicesList.value || []) {
    const uid = d.userId !== undefined ? d.userId : (d.user_id !== undefined ? d.user_id : null)
    if (uid == null) continue
    const sid = String(uid)
    if (map.has(sid)) continue
    // try to resolve username from allUsers
    const urow = (allUsers.value || []).find(u => String(u.id) === sid)
    const uname = urow ? (urow.username || urow.displayName || sid) : sid
    map.set(sid, uname)
  }
  // return array of { id, username }
  return Array.from(map.entries()).map(([id, username]) => ({ id, username }))
})

const filteredSegments = computed(() => {
  try {
    return (segments.value || []).filter(seg => {
      // device filter
      if (filterDevice.value && filterDevice.value !== 'all') {
        const segDev = seg.deviceId || seg.device_id
        if (segDev !== filterDevice.value) return false
      }
      // user filter: match device owner
      if (filterUser.value && filterUser.value !== 'all') {
        const segDevId = seg.deviceId || seg.device_id
        const dev = (devicesList.value || []).find(d => (d.deviceId || d.device_id) == segDevId)
        const uid = dev ? (dev.userId !== undefined ? String(dev.userId) : (dev.user_id !== undefined ? String(dev.user_id) : null)) : null
        if (uid !== filterUser.value) return false
      }
      // date filter: match segment start date (local, YYYY-MM-DD)
      if (filterDate.value) {
        const segStart = Number(seg.points[0]?.ts) || 0
        const segMs = segStart < 1e12 ? Math.round(segStart * 1000) : Math.round(segStart)
        const d = new Date(segMs)
        const segDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (segDate !== filterDate.value) return false
      }
      return true
    })
  } catch (e) { return segments.value || [] }
})

const filterIcon = computed(() => filterVisible.value ? foldUp : expandDown)

const totalCount = computed(() => filteredSegments.value.length)
const selectedCount = computed(() => selectionStore.count)
const allSelected = computed(() => selectedCount.value > 0 && selectedCount.value === totalCount.value)
const partialSelected = computed(() => selectedCount.value > 0 && selectedCount.value < totalCount.value)

function segmentId(seg, idx) {
  // `${deviceId}:${startTs}:${endTs}` using segment's deviceId if present
  const dev = (seg && seg.deviceId) ? seg.deviceId : deviceId.value
  const start = seg.points[0]?.ts
  const end = seg.points[seg.points.length - 1]?.ts
  return `${dev}:${start}:${end}`
}

function toggleFilter() { filterVisible.value = !filterVisible.value }
function updatePanelMargin() {
  try {
    const headerH = headerRef.value ? headerRef.value.offsetHeight : 72
    const filterH = (filterRef.value && filterVisible.value) ? filterRef.value.offsetHeight : 0
    // 把 filter-panel 固定显示在 header 下面，避免被主面板 marginTop 推开造成巨大间隙
    if (filterRef.value) {
      if (filterVisible.value) {
        filterRef.value.style.position = 'fixed'
        filterRef.value.style.left = '0'
        filterRef.value.style.right = '0'
        filterRef.value.style.transform = ''
        filterRef.value.style.top = headerH + 'px'
        filterRef.value.style.margin = '0'
        filterRef.value.style.zIndex = '1000'
        filterRef.value.style.width = '100%'
      } else {
        filterRef.value.style.position = ''
        filterRef.value.style.left = ''
        filterRef.value.style.right = ''
        filterRef.value.style.transform = ''
        filterRef.value.style.top = ''
        filterRef.value.style.margin = ''
        filterRef.value.style.zIndex = ''
        filterRef.value.style.width = ''
      }
    }
    // 进一步缩小 header 与内容的间距：允许比 header 高度少 8px 的靠近（但不小于 8px）
    panelTopMargin.value = Math.max(8, headerH + (filterVisible.value ? filterH : 0) - 8)
    // 根据 footer 高度设置根容器的 padding-bottom，避免固定的 footer 遮挡列表项
    try {
      const footerH = footerRef && footerRef.value ? footerRef.value.offsetHeight : 0
      if (panelRef && panelRef.value) panelRef.value.style.paddingBottom = (Math.max(16, footerH + 12)) + 'px'
    } catch (e) { /* ignore */ }
  } catch (e) { panelTopMargin.value = 72 }
}

watch(() => filterVisible.value, async () => { await nextTick(); updatePanelMargin() })

function applyFilters() {
  // filtering is reactive via computed; just ensure UI state updated
  // keep panel open so user sees results
}

function resetFilters() {
  filterDevice.value = 'all'
  filterUser.value = 'all'
  filterDate.value = ''
}

async function deleteSelected() {
  if (!selectionStore || selectionStore.count === 0) {
    await showMessage({ message: '未选中任何记录', type: 'warn' })
    return
  }
  const res = await showMessage({ message: `确定删除 ${selectionStore.count} 条记录吗？`, showCancel: true, type: 'error' })
  if (res && res.action === 'confirm') {
    const toDelete = new Set(selectionStore.selected)
    // remove segments that match selected ids
    segments.value = (segments.value || []).filter((seg, idx) => {
      const id = segmentId(seg, idx)
      return !toDelete.has(id)
    })
    selectionStore.clear()
    await showMessage({ message: '已删除所选记录', type: 'success' })
  }
}

async function load() {
  try {
    // ensure devicesList loaded
    if (!devicesList.value || devicesList.value.length === 0) {
      await loadDevicesList()
    }
    // clear previous meta and selection
    selectionStore.meta = {}
    selectionStore.clear()
    segments.value = []

    // Use appStore to load track(s)
    selectionStore.meta = {}
    const combine = []
    if (deviceId.value === 'all') {
      const devices = Array.isArray(devicesList.value) ? devicesList.value : []
      for (const d of devices) {
        const dId = d.deviceId || d.device_id
        if (!dId) continue
        trackLoading.value = true
        const res = await appStore.loadTrack({ deviceId: dId }).catch(() => ({ ok: false }))
        trackLoading.value = false
        const pts = (res && res.ok) ? (res.points || []) : []
        try {
          const segRes = segmentTrack(pts)
          const segs = segRes.segments || []
          for (const seg of segs) { seg.deviceId = dId; combine.push(seg) }
        } catch (e) { console.warn('segmentTrack failed', e) }
      }
      combine.sort((a, b) => (a.points[0]?.ts || 0) - (b.points[0]?.ts || 0))
      segments.value = combine
    } else {
      trackLoading.value = true
      const res = await appStore.loadTrack({ deviceId: deviceId.value }).catch(() => ({ ok: false }))
      trackLoading.value = false
      const pts = (res && res.ok) ? (res.points || []) : []
      const segRes = segmentTrack(pts)
      const segs = segRes.segments || []
      segs.forEach((seg) => { seg.deviceId = deviceId.value })
      segments.value = segs
    }

    // register meta for selectionStore
    segments.value.forEach((seg, idx) => {
      const id = segmentId(seg, idx)
      const meta = {
        deviceId: seg.deviceId,
        startTs: seg.points[0]?.ts,
        endTs: seg.points[seg.points.length - 1]?.ts,
        pointCount: seg.points.length,
        startLng: seg.points[0]?.lng,
        startLat: seg.points[0]?.lat,
        endLng: seg.points[seg.points.length - 1]?.lng,
        endLat: seg.points[seg.points.length - 1]?.lat,
      }
      selectionStore.registerMeta(id, meta)
    })
  } catch (e) {
    console.error('load segments failed', e)
    segments.value = []
  }
}

async function onRefresh() {
  // force refresh current device
  const params = { deviceId: deviceId.value }
  try {
    trackLoading.value = true
    await appStore.manualRefresh({ target: 'track', params })
  } catch (e) {
    console.debug('manual refresh track failed', e)
  } finally {
    trackLoading.value = false
    await load()
  }
}

async function loadDevicesList() {
  try {
    const devsUrl = `${backendBase.replace(/\/$/, '')}/api/devices`
    const res = await fetch(devsUrl)
    if (!res.ok) { console.warn('Failed to list devices', res.status); devicesList.value = []; return }
    const data = await res.json()
    const all = Array.isArray(data.devices) ? data.devices : []
    // try to load users mapping so we can display usernames in the filter
    try {
      const usersUrl = `${backendBase.replace(/\/$/, '')}/api/test/users`
      const ur = await fetch(usersUrl)
      if (ur.ok) {
        const ud = await ur.json().catch(() => null)
        allUsers.value = Array.isArray(ud?.users) ? ud.users : []
      } else {
        allUsers.value = []
      }
    } catch (e) { allUsers.value = []; console.warn('load users failed', e) }
    if (user.value && user.value.id != null) {
      devicesList.value = all.filter(d => {
        const uid = d.userId !== undefined ? d.userId : (d.user_id !== undefined ? d.user_id : null)
        return uid != null && String(uid) === String(user.value.id)
      })
    } else {
      devicesList.value = []
    }
  } catch (e) {
    console.error('loadDevicesList error', e)
    devicesList.value = []
  }
}

function selectAll() {
  const allIds = filteredSegments.value.map((seg, idx) => segmentId(seg, idx))
  selectionStore.bulkSelect(allIds)
}
function clearSelection() {
  selectionStore.clear()
}

function toggleAll() {
  if (allSelected.value) {
    selectionStore.clear()
  } else {
    const allIds = filteredSegments.value.map((seg, idx) => segmentId(seg, idx))
    selectionStore.bulkSelect(allIds)
  }
}

function confirmSelection() {
  // Navigate to map page where MapView will render selectionStore.selected
  router.push({ name: 'map' })
}

function formatTs(ts) {
  if (!ts) return '—'
  const n = Number(ts)
  if (!Number.isFinite(n)) return String(ts)
  const ms = n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  return new Date(ms).toLocaleString()
}
function formatDate(ts) {
  if (!ts) return '—'
  const n = Number(ts)
  if (!Number.isFinite(n)) return String(ts)
  const ms = n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  return new Date(ms).toLocaleString()
}
function formatTime(ts) {
  if (!ts) return '—'
  const n = Number(ts)
  if (!Number.isFinite(n)) return String(ts)
  const ms = n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  return new Date(ms).toLocaleString()
}
function formatLatLng(p) {
  if (!p) return '—'
  const lng = Number(p.lng); const lat = Number(p.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '—'
  return `${lng.toFixed(6)}, ${lat.toFixed(6)}`
}

function getDeviceLabel(seg) {
  try {
    const segDevId = seg.deviceId || seg.device_id
    if (!segDevId) return '—'
    const dev = (devicesList.value || []).find(d => (d.deviceId || d.device_id) == segDevId)
    if (dev && dev.name) return dev.name
    return String(segDevId)
  } catch (e) {
    return seg?.deviceId || seg?.device_id || '—'
  }
}

// initial load
// auto-load when deviceId changes
watch(deviceId, () => { load() })

// initial load: first load devices list then segments
loadDevicesList().then(() => load())

// watch selection/segments to update bulk checkbox indeterminate state
watch([() => selectionStore.selected.slice(), () => filteredSegments.value.length], async () => {
  await nextTick()
  try {
    if (bulkCheckbox.value) bulkCheckbox.value.indeterminate = partialSelected.value
  } catch (e) { /* ignore */ }
  try { updatePanelMargin() } catch (e) { /* ignore */ }
}, { immediate: true })
</script>

<style scoped>
.log-panel-view {
  --left-col: 34px;
  --checkbox-accent: #2196f3;
  max-width: 900px;
  margin: 72px auto 0;
  color: #111;
  background: #fff;
  border-radius: 0;
  box-shadow: none;
  padding: 24px 18px 110px 18px;
  font-size: 15px;
}
.log-header {
  position: relative;
  margin-bottom: 12px;
}
.log-header-inner {
  /* fixed at top center of viewport, similar to log-footer */
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
  border-radius: 0;
}
.filter-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display:flex; align-items:center; gap:8px; cursor:pointer }
.filter-text { font-weight: 600; color: #1976d2; font-size: 16px }
.filter-icon { width:18px; height:18px }
.header-left { position: absolute; left: 0; top: 50%; transform: translateY(-50%); display:flex; align-items:center; gap:8px; z-index:1002; }
.header-right { position: absolute; right: 0; top: 50%; transform: translateY(-50%); display:flex; align-items:center; gap:8px; }
.log-delete-btn { background: transparent; border: none; padding: 6px; cursor: pointer }
.log-delete-btn img { width:22px; height:22px }

.log-btn-small { padding: 6px 10px; font-size: 14px; border-radius: 6px }

.filter-panel {
  position: fixed;
  left: 0;
  right: 0;
  transform: none;
  top: 56px; /* 默认值，会在 JS 中按实际 header 高度调整 */
  padding: 10px 12px 14px 12px;
  margin: 0;
  border-radius: 0;
  background: #fff; /* 设为不透明白色，完全遮盖下面内容 */
  border-bottom: 1px solid #eef3f9; /* 与 header 分隔线一致 */
  box-shadow: 0 6px 18px rgba(33,150,243,0.03);
  width: 100%;
  z-index: 1000; /* 位于内容之上，header (1001) 之下 */
}
.filter-row {
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap;
  max-width: min(900px, calc(100% - 36px));
  margin: 0 auto;
  padding: 0 12px;
  box-sizing: border-box;
}
.filter-panel label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

}
.filter-panel .log-select {
  max-width: 220px;
  min-width: 0;

}
.filter-actions {
  display:flex;
  gap:8px;
  margin-left: auto;
  flex-wrap:wrap;
}
.log-input-date { padding:6px 8px; border-radius:6px; border:1px solid #dfeffb }
.filter-actions { display:flex; gap:8px; margin-left: auto }
.log-label {
  font-weight: 500;
  color: #1976d2;
}
.log-select {
  margin-left: 8px;
  padding: 7px 10px;
  border: 1px solid #bcdffb;
  border-radius: 7px;
  font-size: 15px;
  outline: none;
  transition: border 0.2s;
  background: #fff;
  color: #222;
}
.log-select:focus {
  border-color: #2196f3;
}

/* 标题与提示类文本不换行，超出用省略号显示 */
.filter-text,
.log-label,
.log-seg-device,
.log-seg-count {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-seg-title > strong {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
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
.log-btn:hover {
  background: #1976d2;
}
.log-empty {
  color: #888;
  background: #f7fafd;
  border-radius: 8px;
  padding: 18px 0;
  text-align: center;
  font-size: 16px;
}
.log-segment-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.log-segment-item {
  position: relative;
  margin-bottom: 18px;
  padding: 12px 14px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1.5px 6px rgba(33,150,243,0.04);
  color: #111;
  border: 1px solid #e3eaf2;
}
.log-seg-checkbox {
  position: absolute;
  left: calc(10px - var(--left-col)); /* 向左微移 4px */
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  z-index: 1100;
  width: auto;
}
.log-seg-row { display:flex; align-items:center; justify-content:center; position:relative; }
.log-seg-time { flex:1; text-align:center }
.log-seg-checkbox input { transform: scale(1.12); accent-color: var(--checkbox-accent); }
.log-seg-content { margin-left: calc(var(--left-col) + 0px); }
.log-segment-item:last-child {
  margin-bottom: 0;
}
.log-seg-title {
  font-size: 16px;
  font-weight: 600;
  color: #222;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 5px;
  justify-content: flex-start;
}
.log-seg-count {
  font-size: 13px;
  color: #2196f3;
  background: #e3f2fd;
  border-radius: 6px;
  padding: 2px 8px;
  margin-left: 2px;
}
.log-seg-device {
  font-size: 13px;
  color: #ff9800;
  background: #fff3e0;
  border-radius: 6px;
  padding: 2px 8px;
  margin-left: 2px;
}
.log-seg-row {
  margin-bottom: 3px;
  color: #111;
}
.log-label-bold {
  font-weight: 600;
  color: #111;
}
.mini-toggle { margin-top: 8px }
.log-btn.mini { padding: 6px 10px; font-size: 13px; background: #fff; color: #1976d2; border: 1px solid #bcdffb }
.mini-map-wrapper { margin-top: 8px }
/* footer styles */
.log-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid #eef3f9;
  background: #fff;
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: min(900px, calc(100% - 36px));
  box-shadow: 0 -6px 18px rgba(33,150,243,0.03);
  z-index: 999;
}
.log-footer-left { display:flex; align-items:center; margin-left: 7px; width: var(--left-col); justify-content:center }
.log-footer-checkbox { margin-right: 10px; transform: scale(1.18); vertical-align: middle; accent-color: var(--checkbox-accent); }
.log-footer-center { color: #666; font-size: 14px; }
.log-footer-right { }
.log-footer .log-btn { padding: 8px 16px; }
@media (max-width: 600px) {
  .log-panel-view {
    padding: 12px 2vw 10px 2vw;
    font-size: 16px;
  }
  .filter-panel { padding: 8px 10px; }
  .filter-panel .log-select { max-width: 140px; }
  .filter-panel .log-btn { padding: 6px 10px; font-size: 14px; }
  .log-header {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .log-segment-item {
    padding: 12px 8px 10px 10px;
    font-size: 15px;
  }
  .log-seg-title {
    font-size: 15px;
  }
}
</style>
