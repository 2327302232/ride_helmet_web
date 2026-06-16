<template>
  <div v-if="visible" class="mm-overlay" :class="'mm-overlay-' + options.type" @click.self="onCancel">
    <div class="mm-dialog" :class="options.type">
      <div class="mm-header" v-if="options.title">{{ options.title }}</div>
      <div class="mm-body" v-if="options.message">{{ options.message }}</div>
      <slot name="body" :options="options" :close="close"></slot>
      <div class="mm-details" v-if="options.details">
        <button class="mm-details-toggle" @click="toggleDetails">{{ showDetails ? '收起' : '查看详情' }}</button>
        <pre v-show="showDetails" class="mm-pre">{{ options.details }}</pre>
      </div>
      <div class="mm-actions">
        <button v-if="options.showCancel" class="mm-btn mm-cancel" @click="onCancel">{{ options.cancelText }}</button>
        <button class="mm-btn mm-confirm" @click="onConfirm">{{ options.confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'

const visible = ref(false)
const showDetails = ref(false)

const options = reactive({
  title: '',
  message: '',
  details: '',
  type: 'info',
  showCancel: false,
  confirmText: '确定',
  cancelText: '取消'
})

let _resolver = null

function open(opts = {}) {
  const type = opts.type || 'info'
  options.title = opts.title || ''
  options.message = opts.message || ''
  options.details = opts.details || ''
  options.type = type
  options.showCancel = typeof opts.showCancel === 'boolean' ? opts.showCancel : !!opts.cancelText
  options.confirmText = opts.confirmText || (type === 'warn' ? '重试' : '确定')
  options.cancelText = opts.cancelText || '取消'
  showDetails.value = !!opts.showDetails
  visible.value = true
  return new Promise((resolve) => {
    _resolver = resolve
  })
}

function close(result) {
  visible.value = false
  showDetails.value = false
  if (_resolver) {
    _resolver(result)
    _resolver = null
  }
}

function onConfirm() { close({ action: 'confirm' }) }
function onCancel() { close({ action: 'cancel' }) }
function toggleDetails() { showDetails.value = !showDetails.value }

defineExpose({ open, close })
</script>

<style scoped>
.mm-overlay {
  position: fixed; left:0; right:0; top:0; bottom:0; display:flex; align-items:center; justify-content:center; background: rgba(0,0,0,0.35); z-index: 9999;
  -webkit-tap-highlight-color: transparent;
}
.mm-overlay-sos { background: rgba(120, 0, 0, 0.58); }
.mm-dialog {
  width: min(92vw, 420px); background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 6px 22px rgba(0,0,0,0.2);
  font-size: 14px;
}
.mm-dialog.info { border-left: 4px solid #2196f3; }
.mm-dialog.warn { border-left: 4px solid #ff9800; }
.mm-dialog.error { border-left: 4px solid #f44336; }
.mm-dialog.success { border-left: 4px solid #4caf50; }
.mm-dialog.sos { border-left: 4px solid #d50000; }

.mm-header { font-weight: 600; margin-bottom: 8px; }
.mm-dialog.sos .mm-header { color:#b00020; font-size:18px; font-weight:800; }
.mm-body { margin-bottom: 8px; color: #333; word-break: break-word; }
.mm-details { margin-bottom: 8px; }
.mm-pre { background:#f7f7f7; padding:8px; border-radius:6px; max-height:240px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.mm-actions { display:flex; justify-content:flex-end; gap:8px; }
.mm-btn { padding: 10px 14px; border-radius:8px; border: none; font-size:14px; cursor:pointer; }
.mm-cancel { background: #f1f1f1; color:#333; }
.mm-confirm { background: #007bff; color: #fff; }
.mm-dialog.sos .mm-confirm { background:#d50000; }
@media (max-width:480px){
  .mm-dialog{ width:92vw; padding:14px; border-radius:10px; font-size:15px;}
  .mm-btn{ padding:12px 14px; border-radius:10px; font-size:16px;}
}
</style>
