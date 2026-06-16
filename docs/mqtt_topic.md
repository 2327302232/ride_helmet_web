# MQTT Topic 与 Payload 规范（建议）

**版本**: v1
**目标**: 明确 broker 上下行 topic、payload 与 QoS 策略，便于后端网关与前端联调。

## 1. 命名约定
- 版本前缀：`v1`
- Topic 模板：`v1/devices/{deviceId}/{category}/{sub}`
- 多租户可选：`v1/tenants/{tenantId}/devices/{deviceId}/...`

## 2. 核心 Topic 列表
- `v1/devices/{deviceId}/telemetry/gnss` — 位置上报（频繁）
- `v1/devices/{deviceId}/telemetry/state` — 心跳 / 运行状态（周期）
- `v1/devices/{deviceId}/events/{eventType}` — 报警/事件
- `v1/devices/{deviceId}/cmd` — 下发命令（服务器 publish）
- `v1/devices/{deviceId}/ack` — 命令回执（设备 publish）
- `v1/devices/{deviceId}/status` — 在线状态（LWT & retained）

推荐服务器订阅：
- `v1/devices/+/telemetry/#`
- `v1/devices/+/ack`
- `v1/devices/+/status`

## 3. QoS / Retain / LWT 建议
- `telemetry`: QoS 0（延迟更小）或 QoS 1（需要更可靠）
- `cmd` / `ack`: 推荐 QoS 1（至少一次）
- `status`: 使用 broker LWT 发布 `{"online":false,"ts":...}`，并设 `retained=true`
- 切勿对高频 `telemetry` 使用 `retained`

## 4. Payload 字段（JSON）
强制字段：
- `deviceId` (string)
- `ts` (number)：建议 epoch 毫秒（ms）
- `lat` (number)
- `lng` (number)
- `seq` (number)：单调序号，用于去重/排序

可选字段：
- `alt`、`speed`、`bearing`、`fix`、`hdop`
- `location_source`：定位方式，填写 `gnss` 或 `lbs`；兼容字段名 `locationSource`
- `battery`、`rssi`
- `extra`（object，用于设备自定义扩展）

坐标/时间校验建议：
- `lat` ∈ [-90, 90]，`lng` ∈ [-180, 180]
- `ts` 必须为数字（epoch ms），后端统一解析

## 5. 示例
- Telemetry（GNSS）
```json
{
  "deviceId":"dev001",
  "ts":1710000000000,
  "lat":31.2304,
  "lng":121.4737,
  "location_source":"gnss",
  "speed":12.3,
  "bearing":90,
  "fix":3,
  "seq":12345
}
```

- Command（下发）
```json
{
  "deviceId":"dev001",
  "cmdId":"c20260415-001",
  "type":"power",
  "action":"set",
  "value":"low_power",
  "ts":1710000005000
}
```

- Ack（回执）
```json
{
  "deviceId":"dev001",
  "cmdId":"c20260415-001",
  "ok":true,
  "message":"entered low power",
  "ts":1710000006000
}
```

- Status（LWT / retained）
```json
{
  "deviceId":"dev001",
  "online":false,
  "ts":1710000007000
}
```

## 6. 命令生命周期（后端 DB 建议）
- 建议字段：`id`, `cmdId`, `deviceId`, `payload`, `status`（queued/sent/acked/failed），`created_ts`, `sent_ts`, `ack_ts`, `retry_count`, `last_error`
- 流程：`POST /api/cmd` → 写 DB（queued）→ 后端 publish 到 `v1/devices/{deviceId}/cmd`（QoS1）→ 更新 sent → 等待 ack 更新为 acked/failed

## 7. 去重 / 抽稀策略
- 使用 `seq` + `ts` 做去重判定
- 高频点可在后端抽稀（例如每 N 秒取一条，或按速度/角度变化抽稀）
- 对 SQLite：推荐开启 WAL 模式并使用写队列/批量写入以降低锁竞争

## 8. 安全与连接建议
- 使用 `mqtts`（TLS），每设备使用独立凭证（username/deviceId, password=token）
- clientId 建议格式：`dev-{deviceId}` 或 `gw-{hostname}`
- Broker ACL：设备只允许 publish 到 `v1/devices/{deviceId}/...`，服务端/网关允许订阅 wildcard
- 前端不要直接订阅 broker；通过后端 API / WebSocket 获取数据并下发命令

## 9. 性能与扩展
- 当数据量增长，考虑将 SQLite 升级为 PostgreSQL / TSDB
- 后端在写库前做合并/抽样以减少写入压力
- 保留 telemetry 的原始点备份策略或周期性归档

## 10. 测试与工具
- 推荐使用 `mosquitto_pub` / `mosquitto_sub` 或 `mqtt.js` / `MQTT.fx` 模拟测试
- 用场景测试：连接断线重连、LWT 生效、命令下发与 ack、抽稀/去重逻辑

## 11. 常用 Topic 列表（复制用）
- `v1/devices/dev001/telemetry/gnss`
- `v1/devices/dev001/telemetry/state`
- `v1/devices/dev001/events/accel`
- `v1/devices/dev001/cmd`
- `v1/devices/dev001/ack`
- `v1/devices/dev001/status`

## 下一步建议
- 将此文件加入后端文档并在网关中实现 topic 映射与样例代码
- 我可以帮你生成 Node.js 的示例网关脚手架（包含订阅、入库、命令下发）
