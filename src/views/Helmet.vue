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
import { onMounted, ref, watch, computed } from 'vue'

onMounted(() => { document.title = '骑行头盔用户站-Helmet' })

const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
const deviceId = ref(null)
const devicesList = ref([])
const loading = ref(false)
const user = ref(JSON.parse(localStorage.getItem('ride_user') || 'null'))
const simStatus = ref('unknown') // 'online'|'offline'|'unknown'|'all'

const statusLabel = computed(() => {
  switch (simStatus.value) {
    case 'online': return '在线'
    case 'offline': return '离线'
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
    // 请求后端下发状态请求命令到设备（后端会 publish 到 MQTT）
    try {
      if (deviceId.value) {
        const reqUrl = `${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(deviceId.value)}/request_status`
        await fetch(reqUrl, { method: 'POST' }).catch(() => null)
        // 给设备一点时间回复（设备通常会立即回复），然后再次查询在线状态
        await new Promise((r) => setTimeout(r, 800))
        await loadDeviceOnlineFromServer(deviceId.value)
      }
    } catch (e) {
      console.warn('request_status error', e)
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => { loadDevicesList().catch(() => {}) })
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
.status-text { font-size: 14px; font-weight: 700; white-space: nowrap }
.status-online .status-text { color:#4caf50 }
.status-offline .status-text { color:#f44336 }
.status-unknown .status-text { color:#9e9e9e }
.status-all .status-text { color:#1976d2 }
</style>
