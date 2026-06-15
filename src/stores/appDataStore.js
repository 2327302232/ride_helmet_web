import { defineStore } from 'pinia'

const DEFAULT_INTERVAL_MS = 60000

// 非响应性：用于记录正在进行的请求 Promise，避免重复并发
const inFlight = {}

export const useAppDataStore = defineStore('appData', {
  state: () => ({
    meData: null,
    meLoading: false,
    meError: null,
    meLastFetchedAt: null,
    trackCache: {},
    pollingMap: {},
    defaultPollingIntervalMs: DEFAULT_INTERVAL_MS
  }),
  actions: {
    getTrackKey({ deviceId, from, to, limit } = {}) {
      const d = deviceId || 'all'
      const f = (from === undefined || from === null) ? '0' : String(from)
      const t = (to === undefined || to === null) ? '0' : String(to)
      const l = (limit === undefined || limit === null) ? '0' : String(limit)
      return `${d}:${f}:${t}:${l}`
    },

    async loadMe({ force = false } = {}) {
      if (this.meLoading && !force) {
        console.debug('loadMe:start - already loading')
        if (inFlight['me']) return inFlight['me']
        return { ok: true, data: this.meData }
      }
      this.meLoading = true
      console.debug('loadMe:start')

      const p = (async () => {
        try {
          // 优先使用 localStorage 中已有的 ride_user，以兼容当前后端没有 /api/me 的情况
          if (!force) {
            try {
              const stored = localStorage.getItem('ride_user')
              if (stored) {
                const parsed = JSON.parse(stored)
                this.meData = parsed
                this.meLastFetchedAt = Date.now()
                this.meError = null
                console.debug('loadMe:localStorage', parsed)
                return { ok: true, data: parsed, fromCache: true }
              }
            } catch (e) {
              // ignore parse errors and fall through to network fetch
            }
          }

          // 若需要或 localStorage 没有数据，再尝试请求后端的 /api/me（若后端实现）
          const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
          const url = `${backendBase.replace(/\/$/, '')}/api/me`
          const resp = await fetch(url)
          if (!resp.ok) {
            const err = new Error(`HTTP ${resp.status}`)
            err.status = resp.status
            throw err
          }
          const data = await resp.json()
          this.meData = data
          this.meLastFetchedAt = Date.now()
          this.meError = null
          console.debug('loadMe:success', data)
          return { ok: true, data }
        } catch (e) {
          // 失败时保留旧的 meData（若有），并把错误暴露给 UI
          this.meError = e?.message || String(e)
          console.debug('loadMe:failed', e)
          return { ok: false, error: this.meError, data: this.meData }
        } finally {
          this.meLoading = false
          delete inFlight['me']
        }
      })()

      inFlight['me'] = p
      return p
    },

    async loadTrack({ deviceId = 'dev-001', from, to, limit, force = false } = {}) {
      const key = this.getTrackKey({ deviceId, from, to, limit })
      const now = Date.now()
      const cached = this.trackCache[key]

      if (cached && !force) {
        if ((now - (cached.lastFetchedAt || 0) < this.defaultPollingIntervalMs) && !cached.loading) {
          console.debug('loadTrack:cache-hit', key)
          return { ok: true, points: cached.points, fromCache: true }
        }
        if (cached.loading && inFlight[key] && !force) {
          console.debug('loadTrack:start - already loading for', key)
          return inFlight[key]
        }
      }

      // ensure entry exists
      this.trackCache[key] = Object.assign({}, cached || { points: [], lastFetchedAt: null, loading: true, error: null }, { loading: true })
      console.debug('loadTrack:start', key)

      const p = (async () => {
        try {
          const backendBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8888'
          const params = new URLSearchParams()
          params.set('deviceId', deviceId)
          if (from !== undefined) params.set('from', String(from))
          if (to !== undefined) params.set('to', String(to))
          if (limit !== undefined) params.set('limit', String(limit))
          const url = `${backendBase.replace(/\/$/, '')}/api/track?${params.toString()}`
          console.debug('loadTrack:fetch', url)
          const resp = await fetch(url)
          if (!resp.ok) {
            const err = new Error(`HTTP ${resp.status}`)
            err.status = resp.status
            throw err
          }
          const data = await resp.json()
          const pts = Array.isArray(data.points) ? data.points : []
          this.trackCache[key] = { points: pts, lastFetchedAt: Date.now(), loading: false, error: null }
          console.debug('loadTrack:success', key, { count: pts.length })
          return { ok: true, points: pts }
        } catch (e) {
          const errorMsg = e?.message || String(e)
          const oldPoints = (this.trackCache[key] && this.trackCache[key].points) ? this.trackCache[key].points : []
          this.trackCache[key] = { points: oldPoints, lastFetchedAt: this.trackCache[key]?.lastFetchedAt || null, loading: false, error: errorMsg }
          console.debug('loadTrack:failed', key, e)
          return { ok: false, error: errorMsg, points: oldPoints }
        } finally {
          delete inFlight[key]
        }
      })()

      inFlight[key] = p
      return p
    },

    async manualRefresh({ target, params } = {}) {
      if (target === 'me') return this.loadMe({ force: true })
      if (target === 'track') return this.loadTrack({ ...(params || {}), force: true })
      return { ok: false, error: 'unknown target' }
    },

    startPolling({ target, params = {}, intervalMs } = {}) {
      const iv = intervalMs || this.defaultPollingIntervalMs
      const key = target === 'me' ? 'me' : this.getTrackKey(params)
      // clear existing if any
      const prev = this.pollingMap[key]
      if (prev) {
        try { clearInterval(prev) } catch (e) {}
      }
      // immediate
      if (target === 'me') {
        // do not force network fetch for `me` on start; prefer local cache to avoid hitting
        // non-existent /api/me endpoints in some deployments
        this.loadMe({ force: false }).catch(() => {})
      } else {
        this.loadTrack({ ...(params || {}), force: true }).catch(() => {})
      }
      const id = setInterval(() => {
        if (target === 'me') {
          this.loadMe({ force: false }).catch(() => {})
        } else {
          this.loadTrack({ ...(params || {}), force: true }).catch(() => {})
        }
      }, iv)
      this.pollingMap[key] = id
    },

    stopPolling({ target, params = {} } = {}) {
      const key = target === 'me' ? 'me' : this.getTrackKey(params)
      const id = this.pollingMap[key]
      if (id) {
        try { clearInterval(id) } catch (e) {}
        this.pollingMap[key] = null
      }
    },

    getTrackCache(key) { return this.trackCache[key] || null },
    isTrackLoading(key) { return Boolean(this.trackCache[key]?.loading) },
    hasMeData() { return !!this.meData }
  }
})

export default useAppDataStore
