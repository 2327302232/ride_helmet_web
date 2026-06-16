#!/usr/bin/env node
import { initDb, insertHelmetTelemetry } from '../src/db.js'

async function main() {
  await initDb()
  const now = Date.now()
  const baseLng = 113.394
  const baseLat = 23.031
  const deviceId = process.argv[2] || 'dev-001'

  const numPoints = 10
  const points = Array.from({ length: numPoints }, (_, i) => {
    const ts = now - (numPoints - 1 - i) * 30
    return {
      ts,
      lng: baseLng - 0.0002 * i,
      lat: baseLat + 0.00015 * i,
      speed: i === 0 ? 0 : 2 + i,
      battery: 100 - i
    }
  })

  for (const p of points) {
    try {
      const res = insertHelmetTelemetry({ deviceId, ts: p.ts, lng: p.lng, lat: p.lat, speed: p.speed, battery: p.battery, source: 'script', rawJson: JSON.stringify(p), createdAt: Date.now() })
      console.log('inserted', p, '->', res)
    } catch (e) {
      console.error('insert failed', e && e.message ? e.message : e)
    }
  }

  console.log('done')
}

main().catch((e) => { console.error(e); process.exit(1) })
