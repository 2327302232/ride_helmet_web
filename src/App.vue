<template>
  <div id="app-root">
    <FloatTaskbar />
    <SosAlertHost />
    <router-view />
  </div>
</template>

<script>
import FloatTaskbar from './components/FloatTaskbar.vue'
import SosAlertHost from './components/SosAlertHost.vue'

export default {
  name: 'App',
  components: {
    FloatTaskbar,
    SosAlertHost
  }
}
</script>

<style>
html, body, #app { height: 100%; margin: 0; padding: 0; }
</style>
