<template>
  <div class="panel-view" style="padding:16px;">
    <MessageModal ref="msgModal" />

    <div class="me-header">
      <h2 style="display:flex;align-items:center;justify-content:space-between">个人中心
        <button class="log-btn" :disabled="store.meLoading" @click="onRefresh" style="margin-left:12px;align-self:center">刷新</button>
      </h2>
    </div>

    <div v-if="!user">
      <div class="card auth-card">
        <div class="auth-tabs">
          <button :class="{active: mode==='login'}" @click="mode='login'">登录</button>
          <button :class="{active: mode==='register'}" @click="mode='register'">注册</button>
        </div>

        <div v-if="mode==='login'" class="auth-form">
          <label class="field"><span class="field-label">账号：</span><input v-model="loginForm.username" placeholder="账号" /></label>
          <label class="field"><span class="field-label">密码：</span><input v-model="loginForm.password" type="password" placeholder="密码" /></label>
          <div class="actions">
            <button class="log-btn" @click="login" :disabled="isLoading">登录</button>
          </div>
          <div v-if="authError" class="error">{{ authError }}</div>
        </div>

        <div v-else class="auth-form">
          <label class="field"><span class="field-label">账号：</span><input v-model="regForm.username" placeholder="账号" /></label>
          <label class="field"><span class="field-label">密码：</span><input v-model="regForm.password" type="password" placeholder="密码" /></label>
          <label class="field"><span class="field-label">用户名：</span><input v-model="regForm.displayName" placeholder="用户名 (可选)" /></label>
          <div class="actions">
            <button class="log-btn" @click="register" :disabled="isLoading">注册</button>
          </div>
          <div v-if="authError" class="error">{{ authError }}</div>
        </div>
      </div>
    </div>

    <div v-else>
      <div style="margin-bottom:8px">
        <span v-if="store.meLoading" style="color:#1976d2;margin-right:8px">加载中...</span>
        <span v-if="store.meLastFetchedAt">上次更新时间: {{ formatTs(store.meLastFetchedAt) }}</span>
        <div v-if="store.meError" style="color:#c62828;margin-top:6px">刷新失败，使用旧数据：{{ store.meError }}</div>
      </div>
        <div class="me-user">
        <div class="me-user-info">已登录: <strong>{{ user.displayName || user.username }}</strong></div>
        <div class="me-user-actions"><button class="log-btn" @click="logout">退出</button></div>
      </div>

      <div class="card" style="margin-top:12px;">
        <h3>我的设备</h3>
        <div v-if="devices.length === 0" class="log-empty">尚无设备。</div>
        <ul v-else class="device-list">
          <li v-for="d in devices" :key="d.id || d.deviceId" class="device-item">
              <div class="device-main">
              <div><strong>{{ d.deviceId }}</strong> <span class="device-name">{{ d.name || '—' }}</span></div>
              <div class="device-meta">序列号: {{ d.serial || '—' }} ；创建: {{ formatTs(d.createdAt) }}</div>
              </div>
              <button class="icon-btn edit-right" @click.stop="openEditDevice(d)" title="编辑">
                <img :src="editIcon" alt="edit" />
              </button>
          </li>
        </ul>
      </div>

      <!-- 编辑弹窗 -->
      <div v-if="editingDevice" class="edit-modal" @click.self="closeEdit">
        <div class="card edit-card">
          <h3>编辑设备</h3>
          <label class="field"><span class="field-label">设备 ID（不可修改）：</span><input v-model="editingForm.deviceId" disabled /></label>
          <label class="field"><span class="field-label">设备名称：</span><input v-model="editingForm.name" /></label>
          <label class="field"><span class="field-label">序列号：</span><input v-model="editingForm.serial" /></label>
          <div class="actions">
            <button class="log-btn" @click="saveEditDevice" :disabled="isLoading">保存</button>
            <button class="log-btn cancel" @click="closeEdit">取消</button>
            <button class="log-btn delete" @click="deleteDevice(editingDevice, { confirmType: 'error' })" :disabled="isLoading">删除</button>
          </div>
          <div v-if="deviceMsg" class="info">{{ deviceMsg }}</div>
        </div>
      </div>

      <div class="card">
        <h3>添加设备</h3>
        <label class="field"><span class="field-label">设备 ID：</span><input v-model="deviceForm.deviceId" placeholder="例如 dev-001" /></label>
        <label class="field"><span class="field-label">设备名称：</span><input v-model="deviceForm.name" placeholder="可选" /></label>
        <label class="field"><span class="field-label">序列号：</span><input v-model="deviceForm.serial" placeholder="可选" /></label>
        <div class="actions">
          <button class="log-btn" @click="addDevice" :disabled="isLoading">添加设备</button>
        </div>
        
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import MessageModal from '../components/MessageModal.vue'
import editIcon from '../assets/edit.svg'
onMounted(() => { document.title = '骑行头盔用户站-Me' })

const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8787'

const user = ref(JSON.parse(localStorage.getItem('ride_user') || 'null'))
const mode = ref('login')
const loginForm = ref({ username: '', password: '' })
const regForm = ref({ username: '', password: '', displayName: '' })
const authError = ref('')
const isLoading = ref(false)

const deviceForm = ref({ deviceId: '', name: '', serial: '' })
const deviceMsg = ref('')
const devices = ref([])

// 编辑/删除相关状态
const editingDevice = ref(null)
const editingForm = ref({ id: null, deviceId: '', name: '', serial: '' })
const msgModal = ref(null)

// Pinia store
import { useAppDataStore } from '../stores/appDataStore'
const store = useAppDataStore()

onMounted(async () => {
  // ensure me data loaded and polling started
  await store.loadMe().catch(() => {})
  store.startPolling({ target: 'me', intervalMs: store.defaultPollingIntervalMs })
})

onBeforeUnmount(() => {
  store.stopPolling({ target: 'me' })
})

async function onRefresh() {
  try {
    await store.manualRefresh({ target: 'me' })
  } catch (e) {
    console.debug('manual refresh me failed', e)
  }
}

function saveUserToStorage(u) {
  if (u) localStorage.setItem('ride_user', JSON.stringify(u))
  else localStorage.removeItem('ride_user')
}

async function register() {
  authError.value = ''
  if (!regForm.value.username || !regForm.value.password) { authError.value = '账号与密码为必填'; return }
  isLoading.value = true
  try {
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/test/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: regForm.value.username, password: regForm.value.password, displayName: regForm.value.displayName }) })
    const j = await res.json()
    if (!res.ok && !j) { authError.value = '注册失败'; return }
    const u = { id: j.id || j.row?.id, username: j.username || regForm.value.username, displayName: j.displayName || j.row?.display_name }
    user.value = u
    saveUserToStorage(u)
    deviceMsg.value = ''
    await refreshDevices()
  } catch (e) {
    console.error('register error', e)
    authError.value = e?.message || String(e)
  } finally { isLoading.value = false }
}

async function login() {
  authError.value = ''
  if (!loginForm.value.username || !loginForm.value.password) { authError.value = '账号与密码为必填'; return }
  isLoading.value = true
  try {
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/test/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginForm.value.username, password: loginForm.value.password }) })
    if (res.status === 401) { authError.value = '账号或密码错误'; return }
    const j = await res.json()
    user.value = { id: j.id, username: j.username, displayName: j.displayName }
    saveUserToStorage(user.value)
    await refreshDevices()
  } catch (e) {
    console.error('login error', e)
    authError.value = e?.message || String(e)
  } finally { isLoading.value = false }
}

function logout() { user.value = null; saveUserToStorage(null); devices.value = []; deviceForm.value = { deviceId: '', name: '', serial: '' }; deviceMsg.value = '' }

function formatTs(ts) {
  if (!ts) return '—'
  const n = Number(ts)
  if (!Number.isFinite(n)) return String(ts)
  const ms = n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  return new Date(ms).toLocaleString()
}

async function refreshDevices() {
  if (!user.value) { devices.value = []; return }
  try {
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/devices`)
    if (!res.ok) { console.warn('failed to list devices', res.status); devices.value = []; return }
    const j = await res.json()
    const all = Array.isArray(j.devices) ? j.devices : []
    devices.value = all.filter(d => {
      const uid = d.userId !== undefined ? d.userId : (d.user_id !== undefined ? d.user_id : null)
      return uid != null && String(uid) === String(user.value.id)
    })
  } catch (e) {
    console.error('refreshDevices error', e)
    devices.value = []
  }
}

async function addDevice() {
  deviceMsg.value = ''
  if (!user.value) { deviceMsg.value = '请先登录'; return }
  if (!deviceForm.value.deviceId) { deviceMsg.value = '设备 ID 为必填'; return }
  isLoading.value = true
  try {
    const body = { deviceId: deviceForm.value.deviceId, name: deviceForm.value.name || null, serial: deviceForm.value.serial || null, userId: user.value.id }
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await res.json().catch(() => null)
    if (!res.ok) {
      if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '添加设备失败', message: '添加设备失败: ' + (j?.error || res.status), type: 'error' })
      return
    }
    // refresh list first so UI reflects the change
    await refreshDevices()
    deviceForm.value.deviceId = ''
    deviceForm.value.name = ''
    deviceForm.value.serial = ''
    if (j && j.existing) {
      if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '添加设备', message: '设备已存在（已关联或重复）。', type: 'warn' })
    } else {
      if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '添加设备', message: '设备已添加。', type: 'success' })
    }
  } catch (e) {
    console.error('addDevice error', e)
    if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '添加设备失败', message: e?.message || String(e), type: 'error' })
  } finally { isLoading.value = false }
}

if (user.value) refreshDevices()

function openEditDevice(d) {
  editingDevice.value = d
  editingForm.value = { id: d.id, deviceId: d.deviceId, name: d.name, serial: d.serial }
  deviceMsg.value = ''
}

function closeEdit() {
  editingDevice.value = null
  editingForm.value = { id: null, deviceId: '', name: '', serial: '' }
}

async function saveEditDevice() {
  deviceMsg.value = ''
  if (!editingForm.value.deviceId) { deviceMsg.value = '设备 ID 为必填'; return }
  isLoading.value = true
  try {
    // 使用原始 deviceId（editingDevice.deviceId）作为路径参数，因为后端不支持修改主键 device_id
    const originalId = editingDevice.value?.deviceId || editingForm.value.deviceId
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(originalId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingForm.value.name || null, serial: editingForm.value.serial || null, userId: user.value?.id })
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) { deviceMsg.value = '更新失败: ' + (j?.error || res.status); return }
    deviceMsg.value = '设备已更新'
    await refreshDevices()
    closeEdit()
  } catch (e) {
    console.error('saveEditDevice error', e)
    deviceMsg.value = e?.message || String(e)
  } finally { isLoading.value = false }
}

async function deleteDevice(d, opts = {}) {
  if (!d) return
  const deviceId = d.deviceId || d.device_id || (d.id ? String(d.id) : null)
  if (!deviceId) { if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '删除设备失败', message: '无法识别设备 ID，删除失败', type: 'error' }); return }
  // 使用 MessageModal 进行确认
  try {
    const confirmType = opts && opts.confirmType ? opts.confirmType : 'warn'
    const ans = await (msgModal.value && msgModal.value.open ? msgModal.value.open({ title: '删除设备', message: `确定删除设备 ${deviceId}？此操作不可恢复。`, showCancel: true, type: confirmType }) : Promise.resolve({ action: 'confirm' }))
    if (!ans || ans.action !== 'confirm') return
  } catch (e) {
    return
  }
  deviceMsg.value = ''
  isLoading.value = true
  try {
    const res = await fetch(`${backendBase.replace(/\/$/, '')}/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    const j = await res.json().catch(() => null)
    if (!res.ok) {
      if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '删除失败', message: '删除失败: ' + (j?.error || res.status), type: 'error' })
      return
    }
    // 刷新列表并用 modal 通知（红色）
    await refreshDevices()
    if (editingDevice.value && editingDevice.value.deviceId === deviceId) closeEdit()
    if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '删除设备', message: '设备已删除', type: 'error' })
  } catch (e) {
    console.error('deleteDevice error', e)
    if (msgModal.value && msgModal.value.open) await msgModal.value.open({ title: '删除失败', message: e?.message || String(e), type: 'error' })
  } finally { isLoading.value = false }
}
</script>

<style scoped>
.panel-view {
  --left-col: 34px;
  max-width: 900px;
  margin: 0 auto;
  color: #111;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 4px 18px rgba(33,150,243,0.07), 0 1.5px 6px rgba(0,0,0,0.04);
  padding: 24px 18px 40px 18px;
  font-size: 15px;
}
.me-header h2 {display: flex; margin: 0 0 12px 0; justify-content: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.auth-tabs { display:flex; gap:8px; margin-bottom:12px; justify-content:center; align-items:center }
.auth-tabs button { padding:8px 12px; border-radius:8px; border:1px solid #bcdffb; background:#fff }
.auth-tabs button.active { background:#2196f3; color:#fff; border-color:#1976d2 }
.auth-form .field, .card .field { display:flex; align-items:center; gap:8px; margin:8px 0 }
.field-label { flex: 0 0 auto; white-space: nowrap; word-break: keep-all; overflow-wrap: normal; line-height: 1.4 }
.field input { padding:8px 10px; border-radius:6px; border:1px solid #bcdffb; width:320px; max-width:100%; box-sizing:border-box }
.actions { margin-top:8px }
.log-btn { background: #2196f3; color: #fff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 15px; font-weight: 500; cursor: pointer; box-shadow: 0 2px 8px rgba(33,150,243,0.08); transition: background 0.2s; white-space: nowrap; word-break: keep-all }
.log-btn:hover { background: #1976d2 }
.card { background:#fff; border-radius:10px; margin-bottom:12px; padding:12px; border:1px solid #e3eaf2; box-shadow: 0 1.5px 6px rgba(33,150,243,0.04) }
.auth-card { padding: 16px }
.log-empty { color: #888; background: #f7fafd; border-radius: 8px; padding: 12px; text-align: center }
.device-list { list-style:none; padding:0; margin:0 }
.device-item { padding:8px 0; border-bottom:1px solid #f0f6fb; display:flex; align-items:center; gap:8px; position:relative; }
.device-main { flex:1; cursor:default; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding-right:8px }
.device-main div { line-height:1.4 }
.device-meta { color:#666; font-size:13px }
.icon-btn { background: transparent; border: none; padding:6px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer }
.icon-btn img { width:18px; height:18px; display:block }
.icon-btn.delete-left { margin-right:6px }
.icon-btn.edit-right { margin-left:6px; position:absolute; right:10px; top:50%; transform:translateY(-50%); }
.edit-modal { position:fixed; left:0; top:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; background: rgba(0,0,0,0.35); z-index:999 }
.edit-card { width: 480px; max-width:92%; }
.log-btn.cancel { background:#9e9e9e; margin-left:8px }
.log-btn.delete { background:#c62828; margin-left:8px }
.error { color:#c00; margin-top:8px }
.info { color:#1976d2; margin-top:8px }
.me-user { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; padding: 0 16px }
.me-user-info { font-size:15px }
.me-user-actions { }
@media (max-width: 600px) {
  .panel-view { padding: 12px 2vw 10px 2vw; font-size: 16px }
  .auth-form .field, .card .field { flex-direction: column; align-items: stretch }
  .field-label { align-self: flex-start }
  .field input { width: 100% }
}
</style>
