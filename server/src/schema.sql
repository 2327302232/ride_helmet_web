-- schema.sql
-- 该文件用于 db.js 的 schema 初始化（会在 initDb 时由 db.js 读取并执行）。
-- 包含 gps_points 与 device_commands 两张表及必要索引，使用 IF NOT EXISTS 以便重复执行安全。

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS gps_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  speed REAL,
  heading REAL,
  altitude REAL,
  accuracy REAL,
  battery INTEGER,
  status TEXT DEFAULT 'ok',
  source TEXT DEFAULT 'raw',
  raw_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gps_device_ts ON gps_points(device_id, ts);

CREATE TABLE IF NOT EXISTS device_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cmd_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  value_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_ts INTEGER,
  ack_ts INTEGER,
  ack_payload TEXT,
  retries INTEGER DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_cmd_device_ts ON device_commands(device_id, ts);

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

-- 当前设备在线表：存放每个设备的最近在线状态（由 LWT / retained 或设备主动上报更新）
CREATE TABLE IF NOT EXISTS device_status_current (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  online INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  raw_json TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_status_current_device ON device_status_current(device_id);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);

-- Device sequences: 应用层按 (table_name, device_id) 存放自定义序号，替代直接修改 sqlite_sequence
CREATE TABLE IF NOT EXISTS device_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  last_updated INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sequences_table_device ON device_sequences(table_name, device_id);

-- 我已完成：server/src/schema.sql 和 server/src/db.js（不包含 git 操作）

-- Users table: basic user store for testing (password_hash stores plaintext on purpose)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NULL,
  created_at INTEGER
);
