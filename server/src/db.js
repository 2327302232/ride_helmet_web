/*
 * server/src/db.js
 * SQLite helper for the backend. Provides initDb and DB operations used by mqtt/http layers.
 *
 * Usage example:
 * import { initDb, insertHelmetTelemetry, addDeviceCommand } from './db.js';
 * await initDb();
 * insertHelmetTelemetry({ deviceId: 'dev-001', ts: Date.now(), lng: 116.3, lat: 39.9 });
 * addDeviceCommand({ cmdId: 'uuid-1', deviceId: 'dev-001', ts: Date.now(), type: 'cmd', action: 'beep', valueJson: '{}' });
 *
 * 测试验证指引（在终端手动执行）：
 * 1) 确保在 server 目录依赖已安装（better-sqlite3）。
 * 2) 在 Node 中运行：
 *    import { initDb, insertHelmetTelemetry, listDevices, getTrack, addDeviceCommand, updateCommandStatus } from './src/db.js';
 *    await initDb();
 *    insertHelmetTelemetry({ deviceId: 'dev-001', ts: Date.now(), lng: 116.3, lat: 39.9 });
 *    console.log(await listDevices());
 *    console.log(await getTrack({ deviceId: 'dev-001' }));
 *    addDeviceCommand({ cmdId: 'uuid-1', deviceId: 'dev-001', ts: Date.now(), type: 'cmd', action: 'do', valueJson: '{}' });
 *    updateCommandStatus({ cmdId: 'uuid-1', status: 'sent', sentTs: Date.now() });
 * 3) 使用 sqlite3 CLI 或 DB 浏览器打开 server/data/tracks.sqlite 验证表结构与数据。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;
const stmts = {};

const PASSWORD_PREFIX = 'pbkdf2_sha256';
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = 'sha256';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

export function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith(`${PASSWORD_PREFIX}$`);
}

export function verifyPassword(password, stored) {
  const storedStr = stored == null ? '' : String(stored);
  if (!isPasswordHash(storedStr)) return String(password) === storedStr;
  const parts = storedStr.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

function prepareStatements() {
  stmts.listDevices = db.prepare(`SELECT device_id AS deviceId, MAX(ts) AS lastTs FROM helmet_telemetry GROUP BY device_id ORDER BY lastTs DESC LIMIT @limit`);

  stmts.getTrackHelmet = db.prepare(`SELECT
      ts,
      lng,
      lat,
      speed,
      heading,
      altitude,
      accuracy,
      location_source AS locationSource,
      heart_rate AS heartRate,
      temperature,
      humidity,
      collision,
      collision_level AS collisionLevel,
      collision_score AS collisionScore,
      battery,
      low_power AS lowPower,
      source,
      raw_json AS rawJson
    FROM helmet_telemetry
    WHERE device_id = @device_id
      AND lng IS NOT NULL
      AND lat IS NOT NULL
      AND ts >= @from
      AND ts <= @to
    ORDER BY ts ASC
    LIMIT @limit`);

  stmts.insertCmd = db.prepare(`INSERT INTO device_commands (cmd_id, device_id, ts, type, action, value_json, status, retries, created_at, updated_at)
    VALUES (@cmd_id, @device_id, @ts, @type, @action, @value_json, @status, @retries, @created_at, @updated_at)`);

  stmts.getCmdById = db.prepare(`SELECT * FROM device_commands WHERE cmd_id = @cmd_id`);

  stmts.getPending = db.prepare(`SELECT * FROM device_commands WHERE device_id = @device_id AND status IN ('queued','sent') ORDER BY ts ASC`);

  // status table statements: 存放设备层面的状态/错误（例如 GNSS 报错）
  stmts.insertStatus = db.prepare(`INSERT INTO status (device_id, ts, status, message, source, raw_json, created_at)
    VALUES (@device_id, @ts, @status, @message, @source, @raw_json, @created_at)`);

  stmts.listStatus = db.prepare(`SELECT device_id AS deviceId, ts, status, message, source, raw_json, created_at FROM status
    WHERE device_id = @device_id AND ts >= @from AND ts <= @to ORDER BY ts ASC LIMIT @limit`);

  stmts.getLatestStatus = db.prepare(`SELECT device_id AS deviceId, ts, status, message, source, raw_json, created_at FROM status
    WHERE device_id = @device_id ORDER BY ts DESC LIMIT 1`);

  // helmet telemetry statements: GPS + 心率 + 碰撞 + 温湿度等传感器数据
  stmts.insertHelmetTelemetry = db.prepare(`INSERT INTO helmet_telemetry (
      device_id, ts, lng, lat, speed, heading, altitude, accuracy, location_source,
      heart_rate, temperature, humidity, collision, collision_level, collision_score,
      battery, low_power, source, raw_json, created_at
    ) VALUES (
      @device_id, @ts, @lng, @lat, @speed, @heading, @altitude, @accuracy, @location_source,
      @heart_rate, @temperature, @humidity, @collision, @collision_level, @collision_score,
      @battery, @low_power, @source, @raw_json, @created_at
    )`);

  stmts.upsertHelmetTelemetryCurrent = db.prepare(`INSERT INTO helmet_telemetry_current (
      device_id, ts, lng, lat, speed, location_source, heart_rate, temperature, humidity,
      collision, collision_level, collision_score, battery, low_power, raw_json, updated_at
    ) VALUES (
      @device_id, @ts, @lng, @lat, @speed, @location_source, @heart_rate, @temperature, @humidity,
      @collision, @collision_level, @collision_score, @battery, @low_power, @raw_json, @updated_at
    ) ON CONFLICT(device_id) DO UPDATE SET
      ts = @ts,
      lng = @lng,
      lat = @lat,
      speed = @speed,
      location_source = @location_source,
      heart_rate = @heart_rate,
      temperature = @temperature,
      humidity = @humidity,
      collision = @collision,
      collision_level = @collision_level,
      collision_score = @collision_score,
      battery = @battery,
      low_power = @low_power,
      raw_json = @raw_json,
      updated_at = @updated_at`);

  stmts.getHelmetTelemetry = db.prepare(`SELECT id, device_id AS deviceId, ts, lng, lat, speed, heading, altitude, accuracy,
      location_source AS locationSource, heart_rate AS heartRate, temperature, humidity, collision, collision_level AS collisionLevel,
      collision_score AS collisionScore, battery, low_power AS lowPower, source, raw_json AS rawJson, created_at AS createdAt
    FROM helmet_telemetry
    WHERE device_id = @device_id AND ts >= @from AND ts <= @to
    ORDER BY ts ASC LIMIT @limit`);

  stmts.getHelmetTelemetryCurrent = db.prepare(`SELECT device_id AS deviceId, ts, lng, lat, speed,
      location_source AS locationSource, heart_rate AS heartRate, temperature, humidity, collision, collision_level AS collisionLevel,
      collision_score AS collisionScore, battery, low_power AS lowPower, raw_json AS rawJson, updated_at AS updatedAt
    FROM helmet_telemetry_current WHERE device_id = @device_id`);

  stmts.insertCollisionEvent = db.prepare(`INSERT INTO helmet_collision_events (device_id, ts, level, score, lng, lat, speed, message, raw_json, created_at)
    VALUES (@device_id, @ts, @level, @score, @lng, @lat, @speed, @message, @raw_json, @created_at)`);

  stmts.listCollisionEvents = db.prepare(`SELECT id, device_id AS deviceId, ts, level, score, lng, lat, speed, message, raw_json AS rawJson, created_at AS createdAt
    FROM helmet_collision_events
    WHERE device_id = @device_id AND ts >= @from AND ts <= @to
    ORDER BY ts DESC LIMIT @limit`);

  // device_status_current statements (stores latest online state per device)
  stmts.upsertDeviceStatus = db.prepare(`INSERT INTO device_status_current (device_id, online, ts, raw_json, updated_at)
    VALUES (@device_id, @online, @ts, @raw_json, @updated_at)
    ON CONFLICT(device_id) DO UPDATE SET online = @online, ts = @ts, raw_json = @raw_json, updated_at = @updated_at`);

  stmts.getDeviceStatusCurrent = db.prepare(`SELECT device_id AS deviceId, online, ts, raw_json AS rawJson, updated_at AS updatedAt FROM device_status_current WHERE device_id = @device_id`);

  // pending requests: track latest pending cmdId for a device (one refresh -> one cmdId)
  stmts.insertPendingRequest = db.prepare(`INSERT INTO device_pending_requests (device_id, cmd_id, created_at)
    VALUES (@device_id, @cmd_id, @created_at)
    ON CONFLICT(device_id) DO UPDATE SET cmd_id = @cmd_id, created_at = @created_at`);

  stmts.getPendingByDevice = db.prepare(`SELECT device_id AS deviceId, cmd_id AS cmdId, created_at FROM device_pending_requests WHERE device_id = @device_id`);
  stmts.getPendingByCmd = db.prepare(`SELECT device_id AS deviceId, cmd_id AS cmdId, created_at FROM device_pending_requests WHERE cmd_id = @cmd_id`);
  stmts.deletePendingByCmd = db.prepare(`DELETE FROM device_pending_requests WHERE cmd_id = @cmd_id`);
  stmts.deletePendingByDevice = db.prepare(`DELETE FROM device_pending_requests WHERE device_id = @device_id`);
  stmts.deleteExpiredPending = db.prepare(`DELETE FROM device_pending_requests WHERE created_at IS NOT NULL AND created_at < @cutoff`);

  // devices / device_sequences statements
  stmts.insertDevice = db.prepare(`INSERT INTO devices (device_id, serial, name, user_id, metadata, created_at)
    VALUES (@device_id, @serial, @name, @user_id, @metadata, @created_at)`);

  stmts.getDeviceById = db.prepare(`SELECT id, device_id AS deviceId, serial, name, user_id AS userId, metadata, created_at AS createdAt FROM devices WHERE device_id = @device_id`);

  stmts.listDevicesMeta = db.prepare(`SELECT id, device_id AS deviceId, serial, name, user_id AS userId, metadata, created_at AS createdAt FROM devices ORDER BY created_at DESC LIMIT @limit OFFSET @offset`);

  stmts.updateDeviceById = db.prepare(`UPDATE devices SET serial = @serial, name = @name, user_id = @user_id, metadata = @metadata WHERE device_id = @device_id`);

  stmts.deleteDeviceById = db.prepare(`DELETE FROM devices WHERE device_id = @device_id`);

  stmts.getDeviceSequence = db.prepare(`SELECT seq, last_updated FROM device_sequences WHERE table_name = @table_name AND device_id = @device_id`);

  stmts.insertDeviceSequence = db.prepare(`INSERT INTO device_sequences (table_name, device_id, seq, last_updated) VALUES (@table_name, @device_id, @seq, @last_updated)`);

  stmts.updateDeviceSequence = db.prepare(`UPDATE device_sequences SET seq = @seq, last_updated = @last_updated WHERE table_name = @table_name AND device_id = @device_id`);
  
  // users statements (minimal CRUD for testing)
  stmts.insertUser = db.prepare(`INSERT INTO users (username, password_hash, display_name, created_at)
    VALUES (@username, @password_hash, @display_name, @created_at)`);

  stmts.getUserByUsername = db.prepare(`SELECT id, username, password_hash, display_name, created_at FROM users WHERE username = @username`);

  stmts.getUserById = db.prepare(`SELECT id, username, password_hash, display_name, created_at FROM users WHERE id = @id`);

  stmts.listUsers = db.prepare(`SELECT id, username, display_name, created_at FROM users ORDER BY created_at DESC LIMIT @limit OFFSET @offset`);

  stmts.updateUserByUsername = db.prepare(`UPDATE users SET password_hash = @password_hash, display_name = @display_name WHERE username = @username`);

  stmts.deleteUserByUsername = db.prepare(`DELETE FROM users WHERE username = @username`);
}

/**
 * Initialize the database.
 * - 使用 process.env.DB_PATH（若无则使用 server/data/tracks.sqlite）
 * - 确保 data 目录存在
 * - 设置 PRAGMA 并执行 server/src/schema.sql（如存在）
 * @param {Object} [options] Optional options forwarded to better-sqlite3 constructor as second arg (not required)
 * @returns {Database} better-sqlite3 Database 实例
 */
export async function initDb(options = {}) {
  if (db) return db;

  const envPath = process.env.DB_PATH;
  const dbPath = envPath ? (path.isAbsolute(envPath) ? envPath : path.resolve(envPath)) : path.resolve(__dirname, '..', 'data', 'tracks.sqlite');
  const dataDir = path.dirname(dbPath);
  fs.mkdirSync(dataDir, { recursive: true });

  // 如果传入 options（非空对象），则传给 better-sqlite3，否则使用默认构造
  if (options && Object.keys(options).length > 0) {
    db = new Database(dbPath, options);
  } else {
    db = new Database(dbPath);
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -20000');
  } catch (err) {
    console.warn('Failed to apply PRAGMA:', err && err.message ? err.message : err);
  }

  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    try {
      db.exec(sql);
    } catch (err) {
      console.error('Failed to execute schema.sql:', err && err.message ? err.message : err);
      throw err;
    }
  } else {
    console.warn('schema.sql not found at', schemaPath);
  }

  // Migration: ensure compatibility/optimization columns and indexes.
  try {
    const ensureColumn = (tableName, columnName, definition) => {
      const cols = db.prepare(`PRAGMA table_info('${tableName}')`).all();
      const colNames = (cols || []).map(c => String(c.name));
      if (!colNames.includes(columnName)) {
        try { db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`); } catch (e) { console.warn(`Failed to add ${tableName}.${columnName}`, e && e.message ? e.message : e); }
      }
    };
    ensureColumn('helmet_telemetry', 'location_source', 'TEXT');
    ensureColumn('helmet_telemetry_current', 'location_source', 'TEXT');

    const cols = db.prepare("PRAGMA table_info('device_commands')").all();
    const colNames = (cols || []).map(c => String(c.name));
    if (!colNames.includes('battery')) {
      try { db.exec("ALTER TABLE device_commands ADD COLUMN battery INTEGER"); } catch (e) { console.warn('Failed to add battery column', e && e.message ? e.message : e); }
    }
    if (!colNames.includes('low_power')) {
      try { db.exec("ALTER TABLE device_commands ADD COLUMN low_power INTEGER"); } catch (e) { console.warn('Failed to add low_power column', e && e.message ? e.message : e); }
    }
    if (!colNames.includes('created_at')) {
      try { db.exec("ALTER TABLE device_commands ADD COLUMN created_at INTEGER"); } catch (e) { console.warn('Failed to add created_at column', e && e.message ? e.message : e); }
    }
    if (!colNames.includes('updated_at')) {
      try { db.exec("ALTER TABLE device_commands ADD COLUMN updated_at INTEGER"); } catch (e) { console.warn('Failed to add updated_at column', e && e.message ? e.message : e); }
    }
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cmd_device_status_ts ON device_commands(device_id, status, ts);
        CREATE INDEX IF NOT EXISTS idx_cmd_device_action_ts ON device_commands(device_id, action, ts);
        CREATE INDEX IF NOT EXISTS idx_status_device_status_ts ON status(device_id, status, ts);
        CREATE INDEX IF NOT EXISTS idx_device_pending_requests_created ON device_pending_requests(created_at);
        CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
        DROP INDEX IF EXISTS idx_devices_device_id;
        DROP INDEX IF EXISTS idx_device_status_current_device;
      `);
    } catch (e) { console.warn('Failed to apply index migration', e && e.message ? e.message : e); }
  } catch (e) {
    console.warn('device_commands migration check failed', e && e.message ? e.message : e);
  }

  prepareStatements();

  try {
    const jm = db.pragma('journal_mode');
    const bt = db.pragma('busy_timeout');
    const sync = db.pragma('synchronous');
    console.log(`Using DB path: ${dbPath}`);
    console.log('PRAGMA journal_mode:', jm);
    console.log('PRAGMA busy_timeout:', bt);
    console.log('PRAGMA synchronous:', sync);
  } catch (err) {
    console.log(`Using DB path: ${dbPath}`);
  }

  return db;
}

function nullableNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nullableInteger(v) {
  const n = nullableNumber(v);
  return n == null ? null : Math.round(n);
}

function nullableBooleanInt(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes') return 1;
  if (v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'no') return 0;
  return v ? 1 : 0;
}

function normalizeLocationSource(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'gps') return 'gnss';
  if (s === 'cell' || s === 'cellular' || s === 'base_station' || s === 'basestation') return 'lbs';
  if (s === 'gnss' || s === 'lbs') return s;
  return s;
}

function normalizeTelemetryRow({ deviceId, ts, lng = null, lat = null, speed = null, heading = null, altitude = null, accuracy = null, locationSource = null, heartRate = null, temperature = null, humidity = null, collision = null, collisionLevel = null, collisionScore = null, battery = null, lowPower = null, source = 'mqtt', rawJson = null, createdAt = null, updatedAt = null } = {}) {
  return {
    device_id: String(deviceId),
    ts: Number(ts),
    lng: nullableNumber(lng),
    lat: nullableNumber(lat),
    speed: nullableNumber(speed),
    heading: nullableNumber(heading),
    altitude: nullableNumber(altitude),
    accuracy: nullableNumber(accuracy),
    location_source: normalizeLocationSource(locationSource),
    heart_rate: nullableInteger(heartRate),
    temperature: nullableNumber(temperature),
    humidity: nullableNumber(humidity),
    collision: nullableBooleanInt(collision) || 0,
    collision_level: collisionLevel == null ? null : String(collisionLevel),
    collision_score: nullableNumber(collisionScore),
    battery: nullableInteger(battery),
    low_power: nullableBooleanInt(lowPower),
    source: source == null ? 'mqtt' : String(source),
    raw_json: rawJson == null ? null : String(rawJson),
    created_at: createdAt == null ? Date.now() : Number(createdAt),
    updated_at: updatedAt == null ? Date.now() : Number(updatedAt)
  };
}

/**
 * Insert a device status/event into status table.
 * @param {Object} param
 * @param {string} param.deviceId
 * @param {number} param.ts
 * @param {string} [param.status]
 * @param {string} [param.message]
 * @param {string} [param.source]
 * @param {string} [param.rawJson]
 * @param {number} [param.createdAt]
 * @returns {{lastInsertRowid:number,changes:number}} 返回插入信息。发生错误时抛出异常。
 */
export function insertStatus({ deviceId, ts, status = null, message = null, source = 'mqtt', rawJson = null, createdAt = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId || ts == null) {
    throw new Error('Missing required fields: deviceId, ts');
  }
  try {
    const info = stmts.insertStatus.run({
      device_id: String(deviceId),
      ts: Number(ts),
      status: status == null ? null : String(status),
      message: message == null ? null : String(message),
      source: source == null ? 'mqtt' : String(source),
      raw_json: rawJson == null ? null : String(rawJson),
      created_at: createdAt == null ? null : Number(createdAt)
    });
    // 尝试为该设备在 device_sequences 表上递增序号（容错，不阻塞主流程）
    try {
      const seqRes = incDeviceSequence({ tableName: 'status', deviceId: String(deviceId), delta: 1 });
      return { lastInsertRowid: info.lastInsertRowid, changes: info.changes, seq: seqRes.seq };
    } catch (e) {
      console.warn('[DB] incDeviceSequence failed for status', e && e.message ? e.message : e);
      return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
    }
  } catch (err) {
    throw err;
  }
}

/**
 * Upsert device current online state.
 * @param {Object} param
 * @param {string} param.deviceId
 * @param {boolean|number} param.online
 * @param {number} [param.ts]
 * @param {string} [param.rawJson]
 * @param {number} [param.updatedAt]
 */
export function setDeviceOnline({ deviceId, online = false, ts = null, rawJson = null, updatedAt = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId || ts == null) throw new Error('Missing required fields: deviceId, ts');
  const info = stmts.upsertDeviceStatus.run({
    device_id: String(deviceId),
    online: online ? 1 : 0,
    ts: Number(ts),
    raw_json: rawJson == null ? null : String(rawJson),
    updated_at: updatedAt == null ? Date.now() : Number(updatedAt)
  });
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

/**
 * Get current online state for a device.
 * @param {string} deviceId
 * @returns {object|null}
 */
export function getDeviceOnline(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const row = stmts.getDeviceStatusCurrent.get({ device_id: String(deviceId) });
  if (!row) return null;
  return { deviceId: row.deviceId, online: !!row.online, ts: row.ts, rawJson: row.rawJson, updatedAt: row.updatedAt };
}

/**
 * Get latest status record (status table) for a device.
 */
export function getLatestStatus(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const row = stmts.getLatestStatus.get({ device_id: String(deviceId) });
  return row || null;
}

export function insertHelmetTelemetry(payload = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!payload.deviceId || payload.ts == null) throw new Error('Missing required fields: deviceId, ts');
  const row = normalizeTelemetryRow(payload);
  const info = stmts.insertHelmetTelemetry.run(row);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

export function upsertHelmetTelemetryCurrent(payload = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!payload.deviceId || payload.ts == null) throw new Error('Missing required fields: deviceId, ts');
  const row = normalizeTelemetryRow(payload);
  const info = stmts.upsertHelmetTelemetryCurrent.run(row);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

/**
 * Update specific fields on helmet_telemetry_current for a device.
 * Used to sync low_power/battery from command acks without waiting for the next telemetry packet.
 */
export function updateHelmetTelemetryCurrentFields(deviceId, { lowPower, battery } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const sets = [];
  const params = { device_id: String(deviceId), updated_at: Date.now() };
  if (lowPower !== undefined && lowPower !== null) {
    sets.push('low_power = @low_power');
    params.low_power = lowPower ? 1 : 0;
  }
  if (battery !== undefined && battery !== null) {
    sets.push('battery = @battery');
    params.battery = Math.round(Number(battery));
  }
  if (sets.length === 0) return { changes: 0 };
  sets.push('updated_at = @updated_at');
  const sql = `UPDATE helmet_telemetry_current SET ${sets.join(', ')} WHERE device_id = @device_id`;
  const info = db.prepare(sql).run(params);
  return { changes: info.changes };
}

export function getHelmetTelemetry({ deviceId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 1000 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  return stmts.getHelmetTelemetry.all({ device_id: String(deviceId), from: Number(from), to: Number(to), limit: Number(limit) });
}

export function getHelmetTelemetryCurrent(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  return stmts.getHelmetTelemetryCurrent.get({ device_id: String(deviceId) }) || null;
}

export function insertCollisionEvent(payload = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!payload.deviceId || payload.ts == null) throw new Error('Missing required fields: deviceId, ts');
  const info = stmts.insertCollisionEvent.run({
    device_id: String(payload.deviceId),
    ts: Number(payload.ts),
    level: payload.level == null ? null : String(payload.level),
    score: nullableNumber(payload.score),
    lng: nullableNumber(payload.lng),
    lat: nullableNumber(payload.lat),
    speed: nullableNumber(payload.speed),
    message: payload.message == null ? null : String(payload.message),
    raw_json: payload.rawJson == null ? null : String(payload.rawJson),
    created_at: payload.createdAt == null ? Date.now() : Number(payload.createdAt)
  });
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

export function listCollisionEvents({ deviceId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  return stmts.listCollisionEvents.all({ device_id: String(deviceId), from: Number(from), to: Number(to), limit: Number(limit) });
}

/**
 * Add or update a pending request for a device (one refresh -> one cmdId).
 */
export function addPendingRequest({ deviceId, cmdId, createdAt = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId || !cmdId) throw new Error('deviceId and cmdId are required.');
  const now = createdAt == null ? Date.now() : Number(createdAt);
  try { cleanupExpiredPendingRequests(); } catch (e) { console.warn('[DB] cleanupExpiredPendingRequests failed', e && e.message ? e.message : e); }
  const info = stmts.insertPendingRequest.run({ device_id: String(deviceId), cmd_id: String(cmdId), created_at: now });
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

export function cleanupExpiredPendingRequests({ olderThanMs = 60000, now = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  const base = now == null ? Date.now() : Number(now);
  const cutoff = base - Number(olderThanMs);
  const info = stmts.deleteExpiredPending.run({ cutoff });
  return { changes: info.changes, cutoff };
}

export function getPendingRequestByDevice(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const row = stmts.getPendingByDevice.get({ device_id: String(deviceId) });
  return row || null;
}

export function getPendingRequestByCmd(cmdId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!cmdId) throw new Error('cmdId is required.');
  const row = stmts.getPendingByCmd.get({ cmd_id: String(cmdId) });
  return row || null;
}

export function deletePendingRequestByCmd(cmdId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!cmdId) throw new Error('cmdId is required.');
  const info = stmts.deletePendingByCmd.run({ cmd_id: String(cmdId) });
  return { changes: info.changes };
}

export function deletePendingRequestByDevice(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const info = stmts.deletePendingByDevice.run({ device_id: String(deviceId) });
  return { changes: info.changes };
}

/**
 * List devices with their latest timestamp.
 * @param {Object} [opt]
 * @param {number} [opt.limit=100]
 * @returns {Array<{deviceId:string,lastTs:number}>}
 */
export function listDevices({ limit = 100 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  const rows = stmts.listDevices.all({ limit: Number(limit) });
  return rows.map(r => ({ deviceId: r.deviceId, lastTs: r.lastTs }));
}

/**
 * Get track points for a device in a time range [from, to]
 * @param {Object} opt
 * @param {string} opt.deviceId
 * @param {number} [opt.from=0]
 * @param {number} [opt.to=Number.MAX_SAFE_INTEGER]
 * @param {number} [opt.limit=5000]
 * @returns {Array<object>} rows
 */
export function getTrack({ deviceId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 5000 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const params = { device_id: String(deviceId), from: Number(from), to: Number(to), limit: Number(limit) };
  const helmetRows = stmts.getTrackHelmet.all(params);
  return (helmetRows || []).map((row) => ({
    ...row,
    collision: !!row.collision,
    lowPower: row.lowPower == null ? null : !!row.lowPower
  }));
}

/**
 * Add a device command. 对重复 cmdId 返回已有记录以保证幂等性。
 * @param {Object} param
 * @param {string} param.cmdId
 * @param {string} param.deviceId
 * @param {number} param.ts
 * @param {string} param.type
 * @param {string} param.action
 * @param {string} param.valueJson
 * @returns {{lastInsertRowid?:number,cmdId?:string,existing?:boolean,row?:object}}
 */
export function addDeviceCommand({ cmdId, deviceId, ts, type, action, valueJson } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!cmdId || !deviceId || ts == null || !type || !action) {
    throw new Error('Missing required fields for addDeviceCommand: cmdId, deviceId, ts, type, action');
  }

  // 支持传入对象或字符串。若未提供则默认 '{}'(非 NULL，因为 schema 要求 NOT NULL)。
  let valueJsonStr;
  if (valueJson == null) {
    valueJsonStr = '{}';
  } else if (typeof valueJson === 'object') {
    try {
      valueJsonStr = JSON.stringify(valueJson);
    } catch (e) {
      throw new Error('Failed to stringify valueJson object');
    }
  } else {
    valueJsonStr = String(valueJson);
  }

  try {
      const now = Date.now();
      const info = stmts.insertCmd.run({ cmd_id: String(cmdId), device_id: String(deviceId), ts: Number(ts), type: String(type), action: String(action), value_json: valueJsonStr, status: 'queued', retries: 0, created_at: now, updated_at: now });
    // 增加 device_commands 的设备级序号（容错）
    try {
      const seqRes = incDeviceSequence({ tableName: 'device_commands', deviceId: String(deviceId), delta: 1 });
      return { lastInsertRowid: info.lastInsertRowid, cmdId, seq: seqRes.seq };
    } catch (e) {
      console.warn('[DB] incDeviceSequence failed for device_commands', e && e.message ? e.message : e);
      return { lastInsertRowid: info.lastInsertRowid, cmdId };
    }
  } catch (err) {
    // 若唯一约束冲突，则返回已有记录，便于幂等。
    if (err && err.message && (err.message.includes('UNIQUE') || err.message.includes('constraint'))) {
      const row = stmts.getCmdById.get({ cmd_id: String(cmdId) });
      return { existing: true, row, status: row ? row.status : undefined };
    }
    throw err;
  }
}

/**
 * Update command status fields by cmdId. 只更新提供的字段。
 * @param {Object} param
 * @param {string} param.cmdId
 * @param {string} [param.status]
 * @param {number} [param.sentTs]
 * @param {number} [param.ackTs]
 * @param {string} [param.ackPayload]
 * @param {number} [param.retries]
 * @param {string} [param.lastError]
 * @returns {{changes:number}} 返回受影响行数。
 */
export function updateCommandStatus({ cmdId, status, sentTs, ackTs, ackPayload, retries, lastError } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!cmdId) throw new Error('cmdId is required.');
  const sets = [];
  const params = { cmd_id: String(cmdId) };
  if (status !== undefined) { sets.push('status = @status'); params.status = String(status); }
  if (sentTs !== undefined) { sets.push('sent_ts = @sent_ts'); params.sent_ts = sentTs == null ? null : Number(sentTs); }
  if (ackTs !== undefined) { sets.push('ack_ts = @ack_ts'); params.ack_ts = ackTs == null ? null : Number(ackTs); }
  if (ackPayload !== undefined) { sets.push('ack_payload = @ack_payload'); params.ack_payload = ackPayload == null ? null : String(ackPayload); }
  if (retries !== undefined) { sets.push('retries = @retries'); params.retries = retries == null ? null : Number(retries); }
  if (lastError !== undefined) { sets.push('last_error = @last_error'); params.last_error = lastError == null ? null : String(lastError); }
  if (arguments && arguments.length > 0 && arguments[0] && Object.prototype.hasOwnProperty.call(arguments[0], 'battery')) {
    sets.push('battery = @battery');
    params.battery = arguments[0].battery == null ? null : Number(arguments[0].battery);
  }
  if (arguments && arguments.length > 0 && arguments[0] && Object.prototype.hasOwnProperty.call(arguments[0], 'lowPower')) {
    sets.push('low_power = @low_power');
    const lp = arguments[0].lowPower;
    params.low_power = lp == null ? null : (lp ? 1 : 0);
  }
  if (sets.length === 0) throw new Error('No fields to update provided.');
  sets.push('updated_at = @updated_at');
  params.updated_at = Date.now();
  const sql = `UPDATE device_commands SET ${sets.join(', ')} WHERE cmd_id = @cmd_id`;
  const stmt = db.prepare(sql);
  const info = stmt.run(params);
  return { changes: info.changes };
}

/**
 * Get pending commands for a device (status IN ('queued','sent')).
 * @param {Object} param
 * @param {string} param.deviceId
 * @returns {Array<object>}
 */
export function getPendingCommands({ deviceId } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  return stmts.getPending.all({ device_id: String(deviceId) });
}

/* Devices management API */
export function addDevice({ deviceId, serial = null, name = null, userId = null, metadata = null, createdAt = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const created = createdAt == null ? Date.now() : Number(createdAt);
  try {
    const info = stmts.insertDevice.run({ device_id: String(deviceId), serial: serial == null ? null : String(serial), name: name == null ? null : String(name), user_id: userId == null ? null : String(userId), metadata: metadata == null ? null : String(metadata), created_at: created });
    return { lastInsertRowid: info.lastInsertRowid, createdAt: created };
  } catch (err) {
    if (err && err.message && (err.message.includes('UNIQUE') || err.message.includes('constraint'))) {
      const row = stmts.getDeviceById.get({ device_id: String(deviceId) });
      return { existing: true, row };
    }
    throw err;
  }
}

export function getDevice(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const row = stmts.getDeviceById.get({ device_id: String(deviceId) });
  return row || null;
}

export function listRegisteredDevices({ limit = 100, offset = 0 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  const rows = stmts.listDevicesMeta.all({ limit: Number(limit), offset: Number(offset) });
  return rows;
}

export function updateDevice(deviceId, updates = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const sets = [];
  const params = { device_id: String(deviceId) };
  if (updates.serial !== undefined) { sets.push('serial = @serial'); params.serial = updates.serial == null ? null : String(updates.serial); }
  if (updates.name !== undefined) { sets.push('name = @name'); params.name = updates.name == null ? null : String(updates.name); }
  if (updates.userId !== undefined) { sets.push('user_id = @user_id'); params.user_id = updates.userId == null ? null : String(updates.userId); }
  if (updates.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = updates.metadata == null ? null : String(updates.metadata); }
  if (sets.length === 0) throw new Error('No fields to update provided');
  const sql = `UPDATE devices SET ${sets.join(', ')} WHERE device_id = @device_id`;
  const stmt = db.prepare(sql);
  const info = stmt.run(params);
  return { changes: info.changes };
}

export function removeDevice(deviceId) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!deviceId) throw new Error('deviceId is required.');
  const info = stmts.deleteDeviceById.run({ device_id: String(deviceId) });
  return { changes: info.changes };
}

/* device_sequences operations */
export function getDeviceSequence({ tableName, deviceId } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!tableName || !deviceId) throw new Error('tableName and deviceId are required.');
  const row = stmts.getDeviceSequence.get({ table_name: String(tableName), device_id: String(deviceId) });
  return row ? { seq: row.seq, lastUpdated: row.last_updated } : null;
}

export function setDeviceSequence({ tableName, deviceId, seq } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!tableName || !deviceId) throw new Error('tableName and deviceId are required.');
  const now = Date.now();
  const existing = stmts.getDeviceSequence.get({ table_name: String(tableName), device_id: String(deviceId) });
  if (existing) {
    const info = stmts.updateDeviceSequence.run({ seq: Number(seq), last_updated: now, table_name: String(tableName), device_id: String(deviceId) });
    return { changes: info.changes };
  } else {
    const info = stmts.insertDeviceSequence.run({ table_name: String(tableName), device_id: String(deviceId), seq: Number(seq), last_updated: now });
    return { lastInsertRowid: info.lastInsertRowid };
  }
}

export function incDeviceSequence({ tableName, deviceId, delta = 1 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!tableName || !deviceId) throw new Error('tableName and deviceId are required.');
  const tx = db.transaction((tName, dId, dlt) => {
    const row = stmts.getDeviceSequence.get({ table_name: tName, device_id: dId });
    const now = Date.now();
    if (row) {
      const newSeq = Number(row.seq) + Number(dlt);
      stmts.updateDeviceSequence.run({ seq: newSeq, last_updated: now, table_name: tName, device_id: dId });
      return newSeq;
    }
    stmts.insertDeviceSequence.run({ table_name: tName, device_id: dId, seq: Number(dlt), last_updated: now });
    return Number(dlt);
  });
  const result = tx(tableName, deviceId, delta);
  return { seq: result };
}

export { db };

// Users CRUD functions
export function addUser({ username, password, displayName = null, createdAt = null } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!username || !password) throw new Error('username and password are required.');
  const created = createdAt == null ? Date.now() : Number(createdAt);
  try {
    const info = stmts.insertUser.run({ username: String(username), password_hash: hashPassword(password), display_name: displayName == null ? null : String(displayName), created_at: created });
    return { lastInsertRowid: info.lastInsertRowid, createdAt: created };
  } catch (err) {
    // UNIQUE 违例 -> 返回 existing=true 并提供已有行（参照 addDeviceCommand 风格）
    if (err && err.message && (err.message.includes('UNIQUE') || err.message.includes('constraint'))) {
      console.error('addUser unique constraint:', err && err.message ? err.message : err);
      try {
        const row = stmts.getUserByUsername.get({ username: String(username) });
        return { existing: true, row };
      } catch (e2) {
        console.error('addUser failed to fetch existing user:', e2 && e2.message ? e2.message : e2);
        return { existing: true };
      }
    }
    console.error('addUser DB error:', err && err.message ? err.message : err);
    throw err;
  }
}

export function getUserByUsername(username) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!username) throw new Error('username is required.');
  const row = stmts.getUserByUsername.get({ username: String(username) });
  return row || null;
}

export function getUserById(id) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (id == null) throw new Error('id is required.');
  const row = stmts.getUserById.get({ id: Number(id) });
  return row || null;
}

export function listUsers({ limit = 100, offset = 0 } = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  const rows = stmts.listUsers.all({ limit: Number(limit), offset: Number(offset) });
  return rows;
}

export function updateUser(username, updates = {}) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!username) throw new Error('username is required.');
  if (!updates || Object.keys(updates).length === 0) throw new Error('No fields to update provided.');
  const sets = [];
  const params = { username: String(username) };
  if (updates.password !== undefined) { sets.push('password_hash = @password_hash'); params.password_hash = updates.password == null ? null : hashPassword(updates.password); }
  if (updates.displayName !== undefined) { sets.push('display_name = @display_name'); params.display_name = updates.displayName == null ? null : String(updates.displayName); }
  if (sets.length === 0) throw new Error('No fields to update provided.');
  const sql = `UPDATE users SET ${sets.join(', ')} WHERE username = @username`;
  const stmt = db.prepare(sql);
  const info = stmt.run(params);
  return { changes: info.changes };
}

export function removeUser(username) {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  if (!username) throw new Error('username is required.');
  const info = stmts.deleteUserByUsername.run({ username: String(username) });
  return { changes: info.changes };
}

// 我已完成：server/src/schema.sql 和 server/src/db.js（不包含 git 操作）
