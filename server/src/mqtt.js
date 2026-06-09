/*
 * server/src/mqtt.js
 *
 * 功能：实现一个常驻 MQTT 客户端模块，负责订阅设备 topic、解析 payload、把 telemetry 写入 db 模块、
 * 处理命令下发与 ACK、并通过事件机制把收到的实时数据发给上层（index.js 或其它模块）。
 *
 * 使用示例（非可运行代码，仅说明用法）：
 * import { startMqtt, stopMqtt, publishCommand, emitter as mqttEmitter, on } from './mqtt.js';
 * await startMqtt();
 * on('telemetry', p => console.log('telemetry', p));
 * const cmdId = await publishCommand({ deviceId: 'dev001', type: 'power', action: 'set', value: 'low' });
 *
 * 导出：
 * - startMqtt(): Promise<Client>  启动并返回 mqtt client
 * - stopMqtt(): void            优雅断开连接
 * - publishCommand(obj): Promise<cmdId>  发布命令并返回 cmdId
 * - emitter (EventEmitter)     事件总线，或使用 on(event, cb)
 *
 * 事件名称与 payload 结构：
 * - 'telemetry': { deviceId, ts, lng, lat, speed?, battery?, raw }
 * - 'cmd_ack'  : { deviceId, cmdId, ok, message?, ts, raw }
 * - 'status'   : { deviceId, online, ts, raw }
 * - 'event'    : { deviceId, eventType, raw }
 * - 'error'    : { error, context? }
 *
 * 我已完成：server/src/mqtt.js（不包含 git 操作）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { insertGpsPoint, insertStatus, addDeviceCommand, updateCommandStatus, getPendingCommands, setDeviceOnline, getPendingRequestByCmd, getPendingRequestByDevice, deletePendingRequestByCmd, insertHelmetTelemetry, upsertHelmetTelemetryCurrent, insertCollisionEvent } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const emitter = new EventEmitter();

// 环境变量与默认值
const {
  MQTT_URL,
  MQTT_USERNAME,
  MQTT_PASSWORD,
  MQTT_CLIENT_ID,
  MQTT_TOPIC_PREFIX = 'v1/devices',
  MQTT_REJECT_UNAUTHORIZED = 'true',
  MQTT_CA_PATH,
  MQTT_QOS_TELEMETRY = '0',
  MQTT_QOS_CMD = '1',
  COMMAND_ACK_TIMEOUT_MS = '3000',
  RECONNECT_PERIOD_MS = '2000'
} = process.env;

const DEFAULT_CLIENT_ID = MQTT_CLIENT_ID || `ride-helmet-server-${Date.now()}`;
const rejectUnauthorized = String(MQTT_REJECT_UNAUTHORIZED).toLowerCase() !== 'false';
const qosTelemetry = Number.isFinite(Number(MQTT_QOS_TELEMETRY)) ? Number(MQTT_QOS_TELEMETRY) : 0;
const qosCmd = Number.isFinite(Number(MQTT_QOS_CMD)) ? Number(MQTT_QOS_CMD) : 1;
const ackTimeoutMs = Number.isFinite(Number(COMMAND_ACK_TIMEOUT_MS)) ? Number(COMMAND_ACK_TIMEOUT_MS) : 3000;
const reconnectPeriodMs = Number.isFinite(Number(RECONNECT_PERIOD_MS)) ? Number(RECONNECT_PERIOD_MS) : 2000;

let caBuffer = null;
if (MQTT_CA_PATH) {
  try {
    const caPath = path.isAbsolute(MQTT_CA_PATH) ? MQTT_CA_PATH : path.resolve(__dirname, '..', MQTT_CA_PATH);
    if (fs.existsSync(caPath)) caBuffer = fs.readFileSync(caPath);
  } catch (e) {
    // 读取 CA 失败，继续但 emit 错误
    emitter.emit('error', { error: e, context: { where: 'read CA file', path: MQTT_CA_PATH } });
  }
}

// 内存结构
const ackTimers = new Map(); // cmdId -> Timeout
let client = null;
let clientConnected = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60000;
let manualStop = false;

function extractBatteryLowPower(payloadObj) {
  const batteryVal = payloadObj && (payloadObj.battery ?? payloadObj.bat ?? payloadObj.battery_level ?? payloadObj.batteryLevel);
  const lowPowerVal = payloadObj && (payloadObj.low_power ?? payloadObj.lowPower ?? payloadObj.lowPowerMode ?? null);
  return { batteryVal, lowPowerVal };
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toFiniteNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === 'no' || s === 'n') return false;
  return !!v;
}

function normalizeTelemetryPayload(deviceId, payloadObj, source = 'mqtt') {
  const ts = payloadObj.ts != null ? Number(payloadObj.ts) : Date.now();
  const lng = toFiniteNumber(firstDefined(payloadObj.lng, payloadObj.lon, payloadObj.long, payloadObj.longitude));
  const lat = toFiniteNumber(firstDefined(payloadObj.lat, payloadObj.latitude));
  const speed = toFiniteNumber(firstDefined(payloadObj.speed, payloadObj.spd));
  const heading = toFiniteNumber(firstDefined(payloadObj.heading, payloadObj.bearing));
  const altitude = toFiniteNumber(firstDefined(payloadObj.altitude, payloadObj.alt));
  const accuracy = toFiniteNumber(firstDefined(payloadObj.accuracy, payloadObj.hdop));
  const heartRate = toFiniteNumber(firstDefined(payloadObj.heart_rate, payloadObj.heartRate, payloadObj.hr, payloadObj.bpm));
  const temperature = toFiniteNumber(firstDefined(payloadObj.temperature, payloadObj.temp, payloadObj.t));
  const humidity = toFiniteNumber(firstDefined(payloadObj.humidity, payloadObj.hum, payloadObj.h));
  const collisionRaw = firstDefined(payloadObj.collision, payloadObj.crash, payloadObj.impact, payloadObj.fall);
  const collisionScore = toFiniteNumber(firstDefined(payloadObj.collision_score, payloadObj.collisionScore, payloadObj.impact_score, payloadObj.impactScore, payloadObj.score));
  const collision = toBool(collisionRaw) === true || (collisionScore != null && collisionScore > 0);
  const collisionLevel = firstDefined(payloadObj.collision_level, payloadObj.collisionLevel, payloadObj.impact_level, payloadObj.impactLevel, payloadObj.level);
  const battery = toFiniteNumber(firstDefined(payloadObj.battery, payloadObj.bat, payloadObj.battery_level, payloadObj.batteryLevel));
  const lowPowerRaw = firstDefined(payloadObj.low_power, payloadObj.lowPower, payloadObj.lowPowerMode);
  const lowPower = toBool(lowPowerRaw);

  return {
    deviceId,
    ts,
    lng,
    lat,
    speed,
    heading,
    altitude,
    accuracy,
    heartRate,
    temperature,
    humidity,
    collision,
    collisionLevel,
    collisionScore,
    battery,
    lowPower,
    source,
    rawJson: JSON.stringify(payloadObj),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function clearAckTimer(cmdId) {
  try {
    const t = ackTimers.get(cmdId);
    if (t) {
      clearTimeout(t);
      ackTimers.delete(cmdId);
    }
  } catch (e) {
    // ignore timer cleanup errors
  }
}

function markCommandReplied({ deviceId, cmdId, ok = true, ts = null, payloadObj = null, message = null, source = 'mqtt-reply' } = {}) {
  if (!cmdId) return;
  const replyTs = ts != null ? Number(ts) : Date.now();
  const { batteryVal, lowPowerVal } = extractBatteryLowPower(payloadObj || {});

  // 真实设备回复（ack 或带 cmdId 的 status）都应结束 ACK 等待，避免 3 秒后又被超时覆盖为 failed/expired。
  clearAckTimer(cmdId);

  try {
    updateCommandStatus({
      cmdId,
      status: ok ? 'acked' : 'failed',
      ackTs: replyTs,
      ackPayload: payloadObj == null ? null : JSON.stringify(payloadObj),
      lastError: ok ? null : (message || `${source} failed`),
      battery: batteryVal == null ? undefined : batteryVal,
      lowPower: lowPowerVal == null ? undefined : lowPowerVal
    });
  } catch (err) {
    emitter.emit('error', { error: err, context: { where: 'markCommandReplied', cmdId, deviceId, source } });
  }
}

function safeJsonParse(buf) {
  try {
    if (!buf) return null;
    if (Buffer.isBuffer(buf)) return JSON.parse(buf.toString());
    if (typeof buf === 'string') return JSON.parse(buf);
    return buf; // already object
  } catch (err) {
    return { __parseError: err };
  }
}

async function handleTelemetry(deviceId, payloadObj, topic) {
  if (!payloadObj || payloadObj.__parseError) {
    emitter.emit('error', { error: payloadObj && payloadObj.__parseError ? payloadObj.__parseError : new Error('Empty telemetry payload'), context: { topic } });
    return;
  }

  const telemetry = normalizeTelemetryPayload(deviceId, payloadObj, 'mqtt');
  const ts = telemetry.ts;
  const lng = telemetry.lng;
  const lat = telemetry.lat;

  const hasCoords = Number.isFinite(lng) && Number.isFinite(lat);

  try {
    insertHelmetTelemetry(telemetry);
    upsertHelmetTelemetryCurrent(telemetry);
  } catch (err) {
    emitter.emit('error', { error: err, context: { where: 'insert helmet telemetry', deviceId, topic } });
  }

  if (telemetry.collision) {
    try {
      insertCollisionEvent({
        deviceId,
        ts,
        level: telemetry.collisionLevel,
        score: telemetry.collisionScore,
        lng,
        lat,
        speed: telemetry.speed,
        message: payloadObj.message ?? 'collision detected',
        rawJson: JSON.stringify(payloadObj),
        createdAt: Date.now()
      });
    } catch (err) {
      emitter.emit('error', { error: err, context: { where: 'insert collision event', deviceId, topic } });
    }
  }

  if (hasCoords) {
    try {
      const insertRes = insertGpsPoint({
        deviceId,
        ts,
        lng,
        lat,
        speed: telemetry.speed,
        heading: telemetry.heading,
        altitude: telemetry.altitude,
        accuracy: telemetry.accuracy,
        battery: telemetry.battery,
        status: payloadObj.status ?? 'ok',
        source: 'mqtt',
        rawJson: JSON.stringify(payloadObj),
        createdAt: Date.now()
      });
      emitter.emit('telemetry', { ...telemetry, raw: payloadObj });
      return insertRes;
    } catch (err) {
      emitter.emit('error', { error: err, context: { deviceId, topic } });
      return;
    }
  }

  emitter.emit('telemetry', { ...telemetry, raw: payloadObj });
}

async function handleEvent(deviceId, eventType, payloadObj, topic) {
  if (!payloadObj || payloadObj.__parseError) {
    emitter.emit('error', { error: payloadObj && payloadObj.__parseError ? payloadObj.__parseError : new Error('Empty event payload'), context: { topic } });
    return;
  }

  // 若事件包含坐标，可写入 gps_points
  const lng = Number(payloadObj.lng ?? payloadObj.lon ?? null);
  const lat = Number(payloadObj.lat ?? payloadObj.lat ?? null);
  const hasCoords = Number.isFinite(lng) && Number.isFinite(lat);
  if (hasCoords) {
    try {
      insertGpsPoint({ deviceId, ts: payloadObj.ts ?? Date.now(), lng, lat, rawJson: JSON.stringify(payloadObj), source: 'mqtt-event', createdAt: Date.now() });
    } catch (e) {
      emitter.emit('error', { error: e, context: { deviceId, eventType } });
    }
  }

  // 若为 GNSS 事件且包含状态/报错信息，则写入 status 表（便于查询与告警）
  if (eventType === 'gnss') {
    try {
      if (payloadObj.status !== undefined || payloadObj.message !== undefined) {
        insertStatus({ deviceId, ts: payloadObj.ts ?? Date.now(), status: payloadObj.status ?? null, message: payloadObj.message ?? null, rawJson: JSON.stringify(payloadObj), source: 'mqtt-event', createdAt: Date.now() });
      }
    } catch (e) {
      emitter.emit('error', { error: e, context: { deviceId, eventType } });
    }
  }

  emitter.emit('event', { deviceId, eventType: eventType || null, raw: payloadObj });
}

async function handleAck(deviceId, payloadObj, topic) {
  if (!payloadObj || payloadObj.__parseError) {
    emitter.emit('error', { error: payloadObj && payloadObj.__parseError ? payloadObj.__parseError : new Error('Empty ack payload'), context: { topic } });
    return;
  }

  const cmdId = payloadObj.cmdId ?? payloadObj.cmd_id ?? payloadObj.cmd;
  if (!cmdId) {
    emitter.emit('error', { error: new Error('No cmdId in ack'), context: { topic, payload: payloadObj } });
    return;
  }

  const ok = payloadObj.ok === true || payloadObj.ok === 'true' || payloadObj.ok === 1 || payloadObj.ok === '1';
  const ackTs = payloadObj.ts != null ? Number(payloadObj.ts) : Date.now();

  markCommandReplied({ deviceId, cmdId, ok, ts: ackTs, payloadObj, message: payloadObj.message, source: 'ack' });

  emitter.emit('cmd_ack', { deviceId, cmdId, ok, message: payloadObj.message, ts: ackTs, raw: payloadObj });

  // 如果该 cmdId 对应当前 pending 请求，则把它视为本次刷新/请求的回复并更新 device_status_current
  try {
    const pending = getPendingRequestByCmd(cmdId);
    if (pending && String(pending.deviceId) === String(deviceId)) {
      try {
        setDeviceOnline({ deviceId, online: !!ok, ts: ackTs, rawJson: JSON.stringify(payloadObj), updatedAt: Date.now() });
      } catch (e) {
        emitter.emit('error', { error: e, context: { where: 'setDeviceOnline after ack', cmdId, deviceId } });
      }
      try {
        deletePendingRequestByCmd(cmdId);
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore pending lookup errors
  }
}

async function handleStatus(deviceId, payloadObj, topic) {
  if (!payloadObj || payloadObj.__parseError) {
    emitter.emit('error', { error: payloadObj && payloadObj.__parseError ? payloadObj.__parseError : new Error('Empty status payload'), context: { topic } });
    return;
  }

  const online = payloadObj.online === true || payloadObj.online === 'true' || payloadObj.online === 1 || payloadObj.online === '1';
  const ts = payloadObj.ts != null ? Number(payloadObj.ts) : Date.now();
  const payloadCmd = payloadObj.cmdId || payloadObj.cmd_id || payloadObj.cmd || null;

  // 兼容设备只回复 status、不回复 ack 的情况：只要 status 带有 cmdId，就把该命令视为已回复，
  // 并清掉 ACK 超时计时器，避免网页先收到在线状态后又被超时事件覆盖为失败。
  if (payloadCmd) {
    markCommandReplied({ deviceId, cmdId: payloadCmd, ok: online !== false, ts, payloadObj, message: payloadObj.message, source: 'status' });
  }
  // 若为设备上报的 status（包含状态/报错，如 GNSS 报错），写入 status 表
  try {
    if (payloadObj.status !== undefined || payloadObj.message !== undefined) {
      insertStatus({ deviceId, ts: payloadObj.ts ?? ts, status: payloadObj.status ?? null, message: payloadObj.message ?? null, rawJson: JSON.stringify(payloadObj), source: 'mqtt-status', createdAt: Date.now() });
    }
  } catch (e) {
    emitter.emit('error', { error: e, context: { deviceId } });
  }

  // 如果包含 online 字段，则根据是否存在 pending 请求决定是否更新 device_status_current：
  // - 若存在 pending（用户刚刷新并下发 request），只有当该 status payload 包含 cmdId 并与 pending.cmdId 匹配时，才将其视为本次请求的回复并更新 current state；
  // - 若不存在 pending，则按原逻辑更新 current state。
  try {
    if (payloadObj.online !== undefined) {
      const pending = getPendingRequestByDevice(deviceId);
      if (pending) {
        // 若 payload 中包含 cmdId，则匹配并处理；否则忽略对 device_status_current 的更新（只保留历史 status 记录）
        if (payloadCmd && String(payloadCmd) === String(pending.cmdId)) {
          try {
            setDeviceOnline({ deviceId, online: online, ts, rawJson: JSON.stringify(payloadObj), updatedAt: Date.now() });
          } catch (e) {
            emitter.emit('error', { error: e, context: { where: 'setDeviceOnline from status', deviceId } });
          }
          try { deletePendingRequestByCmd(pending.cmdId); } catch (e) {}
          // 如果 payload 中包含 battery/low_power，则更新对应的 device_commands 行
          try {
            const { batteryVal, lowPowerVal } = extractBatteryLowPower(payloadObj);
            if (batteryVal !== undefined || lowPowerVal !== undefined) {
              try { updateCommandStatus({ cmdId: payloadCmd, battery: batteryVal == null ? undefined : batteryVal, lowPower: lowPowerVal == null ? undefined : lowPowerVal }); } catch (e) { emitter.emit('error', { error: e, context: { where: 'updateCommandStatus from status', cmdId: payloadCmd } }); }
            }
          } catch (e) {
            // ignore
          }
        } else {
          // ignore updating current device_status while waiting for matching reply
        }
      } else {
        try {
          setDeviceOnline({ deviceId, online: online, ts, rawJson: JSON.stringify(payloadObj), updatedAt: Date.now() });
        } catch (e) {
          emitter.emit('error', { error: e, context: { where: 'setDeviceOnline', deviceId } });
        }
      }
    }
  } catch (e) {
    // ignore outer
  }

  emitter.emit('status', { deviceId, online, ts, raw: payloadObj });
}

function routeMessage(topic, payload) {
  const prefixParts = MQTT_TOPIC_PREFIX.split('/');
  const parts = topic.split('/');
  const deviceIdIndex = prefixParts.length;
  const deviceId = parts[deviceIdIndex];
  const category = parts[deviceIdIndex + 1];
  const rest = parts.slice(deviceIdIndex + 2);

  const parsed = safeJsonParse(payload);
  if (parsed && parsed.__parseError) {
    emitter.emit('error', { error: parsed.__parseError, context: { topic, raw: payload.toString() } });
    return;
  }

  switch (category) {
    case 'telemetry':
      handleTelemetry(deviceId, parsed, topic).catch(e => emitter.emit('error', { error: e, context: { topic } }));
      break;
    case 'events':
      handleEvent(deviceId, rest[0] || null, parsed, topic).catch(e => emitter.emit('error', { error: e, context: { topic } }));
      break;
    case 'ack':
      handleAck(deviceId, parsed, topic).catch(e => emitter.emit('error', { error: e, context: { topic } }));
      break;
    case 'status':
      handleStatus(deviceId, parsed, topic).catch(e => emitter.emit('error', { error: e, context: { topic } }));
      break;
    default:
      // 未识别的 category，emit event 供上层处理
      emitter.emit('event', { deviceId, eventType: category, raw: parsed });
  }
}

export async function startMqtt() {
  if (!MQTT_URL) throw new Error('MQTT_URL is required in process.env');
  if (client) return client;

  // disable manual stop flag
  manualStop = false;

  const optsBase = {
    protocolVersion: 4,
    clientId: DEFAULT_CLIENT_ID,
    keepalive: 30,
    clean: false,
    // disable mqtt.js auto-reconnect: we implement controlled reconnect below
    reconnectPeriod: 0,
    rejectUnauthorized,
    connectTimeout: 100000,
  };
  if (MQTT_USERNAME) optsBase.username = MQTT_USERNAME;
  if (MQTT_PASSWORD) optsBase.password = MQTT_PASSWORD;
  if (caBuffer) optsBase.ca = caBuffer;

  function cleanupClient() {
    if (!client) return;
    try {
      client.removeAllListeners();
    } catch (e) {}
    try {
      client.end(true);
    } catch (e) {}
    client = null;
    clientConnected = false;
  }

  function scheduleReconnect(reason) {
    if (manualStop) return;
    if (reconnectTimer) return; // already scheduled
    reconnectAttempts = reconnectAttempts + 1;
    const delay = Math.min(reconnectPeriodMs * reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    console.log('MQTT schedule reconnect in', delay, 'ms', reason && reason.message ? reason.message : reason);
    emitter.emit('error', { error: new Error('mqtt schedule reconnect'), context: { reason } });
    // ensure previous client closed
    try { cleanupClient(); } catch (e) {}
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect();
    }, delay);
  }

  function doConnect() {
    if (client) {
      // if already connected, no op
      if (clientConnected) return client;
      try { cleanupClient(); } catch (e) {}
    }

    const opts = Object.assign({}, optsBase);
    client = mqtt.connect(MQTT_URL, opts);

    client.on('connect', (connack) => {
      clientConnected = true;
      reconnectAttempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log('MQTT connected', MQTT_URL);
      const prefix = MQTT_TOPIC_PREFIX;
      client.subscribe(`${prefix}/+/telemetry/#`, { qos: qosTelemetry }, (err, granted) => {
        if (err) emitter.emit('error', { error: err, context: { action: 'subscribe', topic: `${prefix}/+/telemetry/#` } });
        else console.log('subscribed', granted);
      });
      client.subscribe(`${prefix}/+/events/#`, { qos: qosTelemetry }, (err, granted) => {
        if (err) emitter.emit('error', { error: err, context: { action: 'subscribe', topic: `${prefix}/+/events/#` } });
      });
      client.subscribe(`${prefix}/+/ack`, { qos: 0 }, (err, granted) => {
        if (err) emitter.emit('error', { error: err, context: { action: 'subscribe', topic: `${prefix}/+/ack` } });
        else console.log('subscribed', granted);
      });
      client.subscribe(`${prefix}/+/status`, { qos: 0 }, (err, granted) => {
        if (err) emitter.emit('error', { error: err, context: { action: 'subscribe', topic: `${prefix}/+/status` } });
        else console.log('subscribed', granted);
      });
    });

    client.on('offline', () => {
      clientConnected = false;
      console.log('MQTT offline');
    });

    client.on('close', () => {
      clientConnected = false;
      console.log('MQTT connection closed');
      scheduleReconnect(new Error('close'));
    });

    client.on('error', (err) => {
      emitter.emit('error', { error: err, context: { where: 'mqtt client' } });
      // ensure we attempt a reconnect after cleaning up
      scheduleReconnect(err);
    });

    client.on('message', (topic, payload, packet) => {
      try {
        routeMessage(topic, payload);
      } catch (err) {
        emitter.emit('error', { error: err, context: { topic } });
      }
    });

    return client;
  }

  // initial connect
  doConnect();
  return client;
}

export function stopMqtt() {
  manualStop = true;
  try {
    if (reconnectTimer) {
      try { clearTimeout(reconnectTimer); } catch (e) {}
      reconnectTimer = null;
    }
  } catch (e) {}

  if (!client) return;
  try {
    client.removeAllListeners();
  } catch (e) {}
  try {
    client.end(true);
  } catch (e) { emitter.emit('error', { error: e, context: { where: 'stopMqtt.end' } }); }
  client = null;
  clientConnected = false;
  try { emitter.emit('status', { deviceId: null, online: false, ts: Date.now(), raw: null }); } catch (e) {}

  // 清理 ackTimers
  for (const [cmdId, t] of ackTimers.entries()) {
    try { clearTimeout(t); } catch (e) {}
    try { updateCommandStatus({ cmdId, status: 'expired' }); } catch (e) {}
  }
  ackTimers.clear();
}

export function publishCommand({ deviceId, cmdId = null, type, action, value } = {}) {
  return new Promise(async (resolve, reject) => {
    if (!deviceId) return reject(new Error('deviceId is required'));
    if (!client) return reject(new Error('MQTT client not started'));

    const finalCmdId = cmdId || uuidv4();
    const ts = Date.now();

    // 先写 DB（幂等）
    try {
      await addDeviceCommand({ cmdId: finalCmdId, deviceId, ts, type, action, valueJson: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') });
    } catch (err) {
      // 若 addDeviceCommand 抛错（非唯一约束冲突），记录并返回失败
      try { updateCommandStatus({ cmdId: finalCmdId, status: 'failed', lastError: err && err.message ? err.message : String(err) }); } catch (e) {}
      return reject(err);
    }

    const payload = { deviceId, cmdId: finalCmdId, type, action, value, ts };
    const topic = `${MQTT_TOPIC_PREFIX}/${deviceId}/cmd`;

    // 默认使用 qosCmd，但针对 request/status（刷新设备状态请求）使用 QoS 0
    const pubOpts = { qos: qosCmd };
    if (type === 'request' && action === 'status') pubOpts.qos = 0;

    client.publish(topic, JSON.stringify(payload), pubOpts, (err) => {
      if (err) {
        try { updateCommandStatus({ cmdId: finalCmdId, status: 'failed', lastError: err && err.message ? err.message : String(err) }); } catch (e) {}
        return reject(err);
      }

      try { updateCommandStatus({ cmdId: finalCmdId, status: 'sent', sentTs: Date.now() }); } catch (e) { emitter.emit('error', { error: e, context: { cmdId: finalCmdId } }); }

      // 启动 ACK 超时计时器
      try {
        const t = setTimeout(() => {
          try {
            if (!ackTimers.has(finalCmdId)) return;
            // 如果真实 ACK/status 与超时几乎同时到达，真实回复路径会先 clearAckTimer。
            // 这里再次确认 timer 仍存在后才标记 expired，避免后续超时覆盖真实在线状态。
            updateCommandStatus({ cmdId: finalCmdId, status: 'expired' });
          } catch (e) { emitter.emit('error', { error: e, context: { cmdId: finalCmdId } }); }
          ackTimers.delete(finalCmdId);
          emitter.emit('cmd_ack', { deviceId, cmdId: finalCmdId, ok: false, message: 'ack timeout', ts: Date.now(), raw: null });
        }, ackTimeoutMs);
        ackTimers.set(finalCmdId, t);
      } catch (e) {
        emitter.emit('error', { error: e, context: { where: 'set ack timer', cmdId: finalCmdId } });
      }

      return resolve(finalCmdId);
    });
  });
}

export function on(eventName, cb) { return emitter.on(eventName, cb); }

export { emitter as mqttEmitter };

// 我已完成：server/src/mqtt.js（不包含 git 操作）
