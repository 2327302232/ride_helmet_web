/*
 * server/src/server.js
 * 长期后端入口（ESM）
 * 职责：
 *  - 在进程启动时调用并等待 `initDb()` 完成；
 *  - 启动 MQTT 客户端（`startMqtt()`）；
 *  - 打印启动日志（DB 初始化成功、MQTT 启动提示）；
 *  - 注册优雅退出（SIGINT / SIGTERM），在退出时停止 MQTT 并关闭 DB 连接。
 *
 * 注意：此文件不实现 HTTP 路由或其它业务逻辑，仅作为长期运行入口。
 */

import 'dotenv/config';
import { initDb, db } from './db.js';
import { startMqtt, stopMqtt, on as onMqtt } from './mqtt.js';
import express from 'express';
import commandRouter from './api/command.js';
import trackRouter from './api/track.js';
import devicesRouter from './api/devices.js';
import usersRouter from './api/users.js';
import meRouter from './api/me.js'
import telemetryRouter from './api/telemetry.js'
import { WebSocketServer } from 'ws';

let shuttingDown = false;
let httpServer = null;

async function start() {
  try {
    console.log('src/server.js: starting...');

    console.log('src/server.js: initializing DB...');
    await initDb();
    console.log('src/server.js: DB initialized.');

    console.log('src/server.js: starting MQTT client...');
    await startMqtt();
    console.log('src/server.js: MQTT client started (see mqtt logs for subscriptions).');

    // 挂载并启动内置 HTTP 接口（若需要使用 express）
    // WebSocket 相关变量提升到 start() 的作用域，便于后续 MQTT 事件也能广播
    let wss = null;
    const wsSubscriptions = new Map(); // deviceId -> Set(ws)
    const wsReverse = new Map(); // ws -> Set(deviceId)

    function broadcastToDevice(deviceId, messageObj) {
      try {
        const set = wsSubscriptions.get(String(deviceId));
        if (!set || set.size === 0) return;
        const payload = JSON.stringify(messageObj);
        for (const s of set) {
          try { if (s && s.readyState === s.OPEN) s.send(payload); } catch (e) { /* ignore per-socket errors */ }
        }
      } catch (e) { /* ignore */ }
    }

    try {
      const app = express();
      // Simple CORS middleware to allow frontend dev server access.
      app.use((req, res, next) => {
        const allowed = process.env.CORS_ORIGIN || '*';
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        // If you need to support credentials, set Access-Control-Allow-Credentials accordingly and avoid '*'
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
      });
      app.use(express.json({ limit: '1mb' }));
      // 健康检查
      app.get('/api/health', (req, res) => res.json({ ok: true }));
      // mount command router and track router
      app.use(commandRouter);
      app.use(trackRouter);
      app.use(devicesRouter);
      app.use(telemetryRouter);
      app.use(meRouter);
      app.use(usersRouter);

      const port = process.env.PORT ? Number(process.env.PORT) : 8888;
      httpServer = app.listen(port, () => console.log(`HTTP server listening on port ${port}`));

      try {
        wss = new WebSocketServer({ server: httpServer, path: '/ws' });
        wss.on('connection', (socket, req) => {
          socket.isAlive = true;
          socket.on('pong', () => { socket.isAlive = true; });

          socket.on('message', (msg) => {
            try {
              const str = typeof msg === 'string' ? msg : msg.toString();
              const obj = JSON.parse(str);
              if (!obj || !obj.type) return;
              if (obj.type === 'subscribe' && obj.deviceId) {
                const dev = String(obj.deviceId);
                const set = wsSubscriptions.get(dev) || new Set();
                set.add(socket);
                wsSubscriptions.set(dev, set);
                const sset = wsReverse.get(socket) || new Set();
                sset.add(dev);
                wsReverse.set(socket, sset);
                try { socket.send(JSON.stringify({ type: 'subscribed', deviceId: dev })); } catch (e) {}
              } else if (obj.type === 'unsubscribe' && obj.deviceId) {
                const dev = String(obj.deviceId);
                const set = wsSubscriptions.get(dev);
                if (set) { set.delete(socket); if (set.size === 0) wsSubscriptions.delete(dev); }
                const sset = wsReverse.get(socket);
                if (sset) { sset.delete(dev); if (sset.size === 0) wsReverse.delete(socket); }
                try { socket.send(JSON.stringify({ type: 'unsubscribed', deviceId: dev })); } catch (e) {}
              } else if (obj.type === 'ping') {
                try { socket.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
              }
            } catch (e) {
              // ignore parse errors
            }
          });

          socket.on('close', () => {
            const sset = wsReverse.get(socket);
            if (sset) {
              for (const dev of sset) {
                const set = wsSubscriptions.get(dev);
                if (set) { set.delete(socket); if (set.size === 0) wsSubscriptions.delete(dev); }
              }
            }
            wsReverse.delete(socket);
          });
        });

        const wsPingInterval = setInterval(() => {
          wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            try { ws.ping(); } catch (e) {}
          });
        }, 30000);

        wss.on('close', () => clearInterval(wsPingInterval));
        console.log('WebSocket server started at /ws');
      } catch (e) {
        console.warn('Failed to start WebSocket server', e && e.message ? e.message : e);
      }
    } catch (e) {
      console.warn('src/server.js: failed to start HTTP server', e && e.message ? e.message : e);
    }

    // 订阅 MQTT 事件用于运行时日志观察
    onMqtt('telemetry', (p) => {
      console.log('[MQTT EVENT] telemetry', JSON.stringify(p));
      try { if (p && p.deviceId) broadcastToDevice(p.deviceId, { type: 'telemetry', payload: p }); } catch (e) {}
    });
    onMqtt('cmd_ack', async (payload) => {
      console.log('[MQTT EVENT] cmd_ack', JSON.stringify(payload));
      try {
        const cmdId = payload.cmdId || payload.cmd_id || payload.cmd;
        if (!cmdId) {
          console.warn('[ACK] Missing cmdId in payload:', payload);
          return;
        }
        // 幂等策略：若 DB 已有 status='acked'，则忽略后续失败/超时更新，但允许 ok=true 覆盖
        let shouldUpdate = true;
        let currentStatus = null;
        try {
          if (db && typeof db.prepare === 'function') {
            const row = db.prepare('SELECT status FROM device_commands WHERE cmd_id = ?').get(cmdId);
            currentStatus = row ? row.status : null;
            if (currentStatus === 'acked' && payload.ok !== true) {
              shouldUpdate = false;
              console.log(`[ACK] cmdId ${cmdId} 已为 acked，忽略本次 status=${payload.ok ? 'acked' : 'failed'}`);
            }
          }
        } catch (e) {
          console.warn('[ACK] 查询当前命令状态失败:', e);
        }
        if (!shouldUpdate) return;
        // 状态判定
        let status = 'acked';
        if (payload.ok === true) {
          status = 'acked';
        } else if (payload.ok === false && payload.message === 'ack timeout') {
          status = 'failed';
        } else if (payload.ok === false) {
          status = 'failed';
        }
        // ack_ts
        const ackTs = payload.ts != null ? Number(payload.ts) : Date.now();
        // ack_payload
        const ackPayload = JSON.stringify(payload.raw || payload);
        // last_error
        const lastError = payload.ok === false ? (payload.message || 'ACK failed') : undefined;
        // extract battery / low_power from payload.raw or payload
        const raw = payload.raw || payload;
        const batteryVal = raw && (raw.battery ?? raw.bat ?? raw.battery_level ?? raw.batteryLevel);
        const lowPowerVal = raw && (raw.low_power ?? raw.lowPower ?? raw.lowPowerMode ?? null);
        // DB 更新
        const { updateCommandStatus } = await import('./db.js');
        try {
          const res = updateCommandStatus({
            cmdId,
            status,
            ackTs,
            ackPayload,
            lastError,
            battery: batteryVal == null ? undefined : batteryVal,
            lowPower: lowPowerVal == null ? undefined : lowPowerVal
          });
          console.log(`[ACK] DB updated for cmdId ${cmdId} -> status ${status}, changes: ${res.changes}`);
        } catch (err) {
          console.error(`[ACK] DB update failed for cmdId ${cmdId}:`, err);
        }

        // 广播到通过 WebSocket 订阅该 deviceId 的前端客户端（若有）
        try { if (payload && payload.deviceId) broadcastToDevice(payload.deviceId, { type: 'cmd_ack', payload }); } catch (e) {}
      } catch (e) {
        console.error('[ACK] handler error:', e);
      }
    });
    onMqtt('status', (s) => {
      console.log('[MQTT EVENT] status', JSON.stringify(s));
      try { if (s && s.deviceId) broadcastToDevice(s.deviceId, { type: 'status', payload: s }); } catch (e) {}
    });
    onMqtt('event', (e) => console.log('[MQTT EVENT] event', JSON.stringify(e)));
    onMqtt('error', (err) => console.error('[MQTT EVENT] error', err && err.error ? err.error : err));

    console.log('src/server.js: ready. Waiting for MQTT messages. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('src/server.js: failed to start:', err);
    await shutdown(1);
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('src/server.js: shutting down...');

  try {
    // 停止 MQTT
    try {
      const res = stopMqtt();
      if (res && typeof res.then === 'function') await res;
      console.log('src/server.js: MQTT client stopped.');
    } catch (e) {
      console.warn('src/server.js: error while stopping MQTT client:', e);
    }

    // 关闭数据库连接（better-sqlite3 的 close 是同步方法）
    try {
      if (db && typeof db.close === 'function') {
        db.close();
        console.log('src/server.js: database connection closed.');
      } else {
        console.log('src/server.js: no DB connection to close.');
      }
    } catch (e) {
      console.warn('src/server.js: error while closing DB:', e);
    }

    // 关闭 HTTP server（若存在）
    try {
      if (httpServer && typeof httpServer.close === 'function') {
        await new Promise((resolve) => httpServer.close(() => resolve()));
        console.log('src/server.js: HTTP server closed.');
      }
    } catch (e) {
      console.warn('src/server.js: error while closing HTTP server:', e);
    }
  } catch (err) {
    console.error('src/server.js: error during shutdown:', err);
    exitCode = exitCode || 1;
  } finally {
    console.log('src/server.js: exit now.');
    // 确保进程退出
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => { console.log('src/server.js: SIGINT received'); shutdown(0); });
process.on('SIGTERM', () => { console.log('src/server.js: SIGTERM received'); shutdown(0); });
process.on('uncaughtException', (err) => { console.error('src/server.js: uncaughtException', err); shutdown(1); });
process.on('unhandledRejection', (reason) => { console.error('src/server.js: unhandledRejection', reason); shutdown(1); });

// 启动
start();
