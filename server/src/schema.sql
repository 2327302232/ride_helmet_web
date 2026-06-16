-- schema.sql
-- 该文件用于 db.js 的 schema 初始化（会在 initDb 时由 db.js 读取并执行）。
-- 使用 helmet_telemetry 作为历史主表，helmet_telemetry_current 作为当前状态缓存。

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS gps_points;

CREATE TABLE IF NOT EXISTS device_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cmd_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  value_json TEXT NOT NULL,
  battery INTEGER,
  low_power INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_ts INTEGER,
  ack_ts INTEGER,
  ack_payload TEXT,
  retries INTEGER DEFAULT 0,
  last_error TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cmd_device_ts ON device_commands(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_cmd_device_status_ts ON device_commands(device_id, status, ts);
CREATE INDEX IF NOT EXISTS idx_cmd_device_action_ts ON device_commands(device_id, action, ts);

-- Status table: 存放设备层面的状态与错误上报（例如 GNSS 报错）
CREATE TABLE IF NOT EXISTS status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT,
  message TEXT,
  source TEXT DEFAULT 'mqtt',
  raw_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_status_device_ts ON status(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_status_device_status_ts ON status(device_id, status, ts);

-- Helmet telemetry history: 每条 MQTT telemetry 采样的结构化数据。
CREATE TABLE IF NOT EXISTS helmet_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lng REAL,
  lat REAL,
  speed REAL,
  heading REAL,
  altitude REAL,
  accuracy REAL,
  location_source TEXT,
  heart_rate INTEGER,
  temperature REAL,
  humidity REAL,
  collision INTEGER DEFAULT 0,
  collision_level TEXT,
  collision_score REAL,
  battery INTEGER,
  low_power INTEGER,
  source TEXT DEFAULT 'mqtt',
  raw_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_helmet_telemetry_device_ts ON helmet_telemetry(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_helmet_telemetry_device_collision_ts ON helmet_telemetry(device_id, collision, ts);
CREATE INDEX IF NOT EXISTS idx_helmet_telemetry_created_at ON helmet_telemetry(created_at);

-- Helmet current telemetry: 每台设备最新一帧，供 Helmet 页面快速读取。
CREATE TABLE IF NOT EXISTS helmet_telemetry_current (
  device_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  lng REAL,
  lat REAL,
  speed REAL,
  location_source TEXT,
  heart_rate INTEGER,
  temperature REAL,
  humidity REAL,
  collision INTEGER DEFAULT 0,
  collision_level TEXT,
  collision_score REAL,
  battery INTEGER,
  low_power INTEGER,
  raw_json TEXT,
  updated_at INTEGER
);

-- Helmet collision events: 碰撞是事件，单独记录便于告警/历史查询。
CREATE TABLE IF NOT EXISTS helmet_collision_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT,
  score REAL,
  lng REAL,
  lat REAL,
  speed REAL,
  message TEXT,
  raw_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_collision_device_ts ON helmet_collision_events(device_id, ts);

-- 当前设备在线表：存放每个设备的最近在线状态（由 LWT / retained 或设备主动上报更新）
CREATE TABLE IF NOT EXISTS device_status_current (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  online INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  raw_json TEXT,
  updated_at INTEGER
);

DROP INDEX IF EXISTS idx_device_status_current_device;

-- Pending requests per-device: 在用户刷新并下发 request_status 时，记录期望的 cmdId，
-- 只有设备针对该 cmdId 的回复才会被视为本次刷新对应的答复。
CREATE TABLE IF NOT EXISTS device_pending_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  cmd_id TEXT NOT NULL UNIQUE,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_pending_requests_device ON device_pending_requests(device_id);
CREATE INDEX IF NOT EXISTS idx_device_pending_requests_created ON device_pending_requests(created_at);

-- Devices table: 存放设备元信息（安全使用 IF NOT EXISTS）
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  serial TEXT,
  name TEXT,
  user_id TEXT,
  metadata TEXT,
  created_at INTEGER
);

DROP INDEX IF EXISTS idx_devices_device_id;
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

-- Device sequences: 应用层按 (table_name, device_id) 存放自定义序号，替代直接修改 sqlite_sequence
CREATE TABLE IF NOT EXISTS device_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  last_updated INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sequences_table_device ON device_sequences(table_name, device_id);

-- Users table: basic user store. password_hash 使用内置 crypto 生成的 pbkdf2 哈希；旧明文登录由 db.js 兼容升级。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NULL,
  created_at INTEGER
);
