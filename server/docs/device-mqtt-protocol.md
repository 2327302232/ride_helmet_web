# 板端 MQTT 开发协议文档

本文档面向 UniKnect MicroPython / EC200U 板端开发者，描述当前网页和后端实际使用的 MQTT 协议。当前 Helmet 页面依赖“下发命令 -> 设备按 cmdId 回复 -> 后端通过 WebSocket/HTTP 给前端结果”的闭环；板端回复里是否带对的 `cmdId` 会直接影响网页显示在线、离线、省电模式是否成功。

## 1. 当前后端配置

后端 MQTT 连接由 `server/.env` 配置：

```env
PORT=8888
MQTT_URL=mqtts://e3133611.ala.cn-hangzhou.emqxsl.cn:8883
MQTT_USERNAME=Server
MQTT_PASSWORD=mqtt
MQTT_CLIENT_ID=ride-helmet-server-01
MQTT_TOPIC_PREFIX=v1/devices
MQTT_CA_PATH=./emqxsl-ca.crt
MQTT_QOS_TELEMETRY=1
MQTT_QOS_CMD=0
COMMAND_ACK_TIMEOUT_MS=3000
```

板端连接同一个 broker，topic 前缀必须与后端一致：

```python
BROKER = "e3133611.ala.cn-hangzhou.emqxsl.cn"
PORT = 8883
USERNAME = "Device"   # 按 broker ACL 实际分配
PASSWORD = "mqtt"
CLIENT_ID = "helmet-{deviceId}"
TOPIC_PREFIX = "v1/devices"
```

CA 证书使用 `server/emqxsl-ca.crt`。EC200U + TLS 环境下，板端 publish 建议全部使用 QoS 0；后端当前对 `request/status` 和 `power/set` 命令也会强制使用 QoS 0 下发。

## 2. Topic 规范

板端订阅后端命令：

```text
v1/devices/{deviceId}/cmd
```

板端发布数据：

| Topic | 用途 | 后端行为 |
| --- | --- | --- |
| `v1/devices/{deviceId}/telemetry` | 传感器/定位/电量上报 | 写入历史 telemetry 和 current telemetry，并通过 WS 推送前端 |
| `v1/devices/{deviceId}/telemetry/gnss` | GNSS 定位上报 | 同 telemetry；topic 中的 `gnss` 会作为定位来源兜底 |
| `v1/devices/{deviceId}/telemetry/lbs` | LBS 定位上报 | 同 telemetry；topic 中的 `lbs` 会作为定位来源兜底 |
| `v1/devices/{deviceId}/status` | 在线状态、命令结果、GNSS 错误 | 更新在线状态或状态历史；带 `cmdId` 时也视为命令回复 |
| `v1/devices/{deviceId}/ack` | 命令 ACK | 更新 `device_commands`，并通过 WS 推送前端 |
| `v1/devices/{deviceId}/events/collision` | 碰撞/SOS 事件 | 写入碰撞事件，更新 current telemetry，并通过 WS 弹出 SOS |
| `v1/devices/{deviceId}/events/gnss` | GNSS 状态/错误事件 | 写入状态历史 |

碰撞事件 topic 的事件名还兼容 `crash`、`impact`、`fall`、`sos`，例如 `v1/devices/{deviceId}/events/sos`。

## 3. 命令与回复

后端下发的命令 payload 固定包含：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-1234",
  "type": "request",
  "action": "status",
  "value": null,
  "ts": 1781010000000
}
```

板端收到命令后必须保存 `cmdId`，并在 `ack` 或 `status` 回复中原样带回。网页默认等待 3 秒；超过 3 秒没有匹配 `cmdId` 的回复，本次操作会被判定失败或离线。

### 3.1 刷新设备状态

网页点击“刷新”后，前端调用：

```text
POST /api/devices/{deviceId}/request_status
```

后端发布：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-1234",
  "type": "request",
  "action": "status",
  "value": null,
  "ts": 1781010000000
}
```

推荐板端回复到 `status`：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-1234",
  "online": true,
  "status": "ok",
  "message": "helmet online",
  "battery": 78,
  "low_power": false,
  "ts": 1781010001000
}
```

也可以回复到 `ack`：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-1234",
  "ok": true,
  "message": "helmet online",
  "battery": 78,
  "low_power": false,
  "ts": 1781010001000
}
```

重要规则：

- `cmdId` 必须与命令一致。
- `status` 回复必须包含 `online: true` 才会被网页明确判定为在线。
- `ack` 回复必须包含 `ok: true` 才会被判定成功。
- 如果用户刚点了刷新，后端只接受匹配 pending `cmdId` 的 `status` 来更新当前在线状态；不带 `cmdId` 的主动 status 会被记录，但不会作为这次刷新结果。

### 3.2 省电模式

网页切换“省电模式”后，前端调用 `POST /api/command`，后端发布：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-5678",
  "type": "power",
  "action": "set",
  "value": {
    "low_power": true
  },
  "ts": 1781010000000
}
```

板端执行完成后回复到 `ack` 或 `status`，回复中必须包含执行后的 `low_power` 实际值：

```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-5678",
  "ok": true,
  "message": "power mode updated",
  "battery": 78,
  "low_power": true,
  "ts": 1781010001000
}
```

网页只有看到 `low_power` / `lowPower` 与目标值一致，才会把开关保持在新状态；否则会回滚。`low_power`、`online`、`ok` 建议使用 JSON 布尔值 `true` / `false`，不要发送字符串。

## 4. Telemetry 上报

Topic 可以使用：

```text
v1/devices/{deviceId}/telemetry
v1/devices/{deviceId}/telemetry/gnss
v1/devices/{deviceId}/telemetry/lbs
```

Payload 示例：

```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "lng": 116.397428,
  "lat": 39.90923,
  "speed": 12.5,
  "heading": 90,
  "altitude": 30,
  "accuracy": 5,
  "location_source": "gnss",
  "heart_rate": 86,
  "temperature": 28.6,
  "humidity": 61.2,
  "battery": 78,
  "low_power": false
}
```

后端会写入 `helmet_telemetry` 历史表和 `helmet_telemetry_current` 当前表。Helmet 页启动和切换设备时会读取 `/api/devices/{deviceId}/telemetry/current`，地图实时模式会通过 WebSocket 接收 telemetry，并定时从 `/api/track` 补点。

字段兼容：

| 标准字段 | 兼容字段 |
| --- | --- |
| `lng` | `lon`, `long`, `longitude` |
| `lat` | `latitude` |
| `speed` | `spd` |
| `heading` | `bearing` |
| `altitude` | `alt` |
| `accuracy` | `hdop` |
| `location_source` | `locationSource`, `loc_source`, `locSource`, `loc_type`, `locType`, `position_source`, `positionSource`, `positioning`, `positioning_type`, `positioningType`, `gps_source`, `gpsSource` |
| `heart_rate` | `heartRate`, `hr`, `bpm` |
| `temperature` | `temp`, `t` |
| `humidity` | `hum`, `h` |
| `battery` | `bat`, `battery_level`, `batteryLevel` |
| `low_power` | `lowPower`, `lowPowerMode` |

定位来源会把 `gps` 规范化为 `gnss`，把 `cell`、`cellular`、`base_station`、`basestation` 规范化为 `lbs`。建议板端优先发送标准字段名。

## 5. 碰撞与 SOS

板端有两种方式触发 SOS。

方式一：在 telemetry 中携带碰撞字段：

```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "lng": 116.397428,
  "lat": 39.90923,
  "speed": 12.5,
  "collision": true,
  "collision_level": "high",
  "collision_score": 3.8,
  "message": "collision detected"
}
```

方式二：发布事件：

```text
v1/devices/{deviceId}/events/collision
```

```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "level": "high",
  "score": 3.8,
  "lng": 116.397428,
  "lat": 39.90923,
  "speed": 12.5,
  "location_source": "gnss",
  "message": "collision detected"
}
```

后端判定规则：

- `collision`、`crash`、`impact`、`fall` 为真，会触发碰撞。
- 或 `collision_score`、`collisionScore`、`impact_score`、`impactScore`、`score` 为大于 0 的数值，会触发碰撞。
- 事件 topic 的 `collision`、`crash`、`impact`、`fall`、`sos` 都会触发 SOS。

触发后，后端写入 `helmet_collision_events`，并通过 WebSocket 向已订阅该设备的前端推送 `sos`。前端会弹出 SOS 报警；如果 payload 带有效 `lng` / `lat`，会显示碰撞位置并支持跳转实时地图。

## 6. GNSS 状态与错误

板端可以用 `status` 或 `events/gnss` 上报 GNSS 状态：

```text
v1/devices/{deviceId}/events/gnss
```

```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "status": "error",
  "message": "gnss no fix"
}
```

只要 payload 中包含 `status` 或 `message`，后端会写入 `status` 表，便于调试和历史查看。

## 7. 时间戳规范

建议板端所有 `ts` 使用 Unix 毫秒时间戳。前端显示时会兼容秒级时间戳，但后端查询、轨迹窗口和命令状态都以毫秒为主。

MicroPython 若 `time.time()` 基于 2000-01-01，需要加偏移：

```python
import time

def now_ms():
    sec = time.time()
    ms = int(sec * 1000)
    if sec < 1000000000:
        ms += 946684800000
    return ms
```

## 8. 板端实现要点

- 订阅 `v1/devices/{deviceId}/cmd`。
- 收到命令后只在回调中入队，在主循环中执行和 publish 回复，避免 TLS 回调内阻塞。
- 回复 `request/status` 时优先发 `status`，并带 `cmdId`、`online`、`battery`、`low_power`。
- 回复 `power/set` 时必须带 `cmdId` 和执行后的 `low_power`。
- 所有 publish 建议 QoS 0，payload 尽量小于 512 字节。
- 两次 publish 之间建议间隔至少 20ms。

示例结构：

```python
pending_cmds = []

def on_message(topic, msg):
    payload = json.loads(msg)
    pending_cmds.append(payload)

def handle_cmd(cmd):
    cmd_id = cmd.get("cmdId")
    typ = cmd.get("type")
    action = cmd.get("action")

    if typ == "request" and action == "status":
        publish_status(cmd_id)
    elif typ == "power" and action == "set":
        want = bool(cmd.get("value", {}).get("low_power"))
        set_low_power(want)
        publish_ack(cmd_id, low_power=want)

def main_loop():
    while True:
        client.check_msg()
        if pending_cmds:
            handle_cmd(pending_cmds.pop(0))
            time.sleep(0.02)
        time.sleep(0.1)
```

## 9. 前端/后端联动摘要

- Helmet 页设备列表来自 `GET /api/devices`，只显示当前登录用户绑定的设备。
- Helmet 页当前传感器数据来自 `GET /api/devices/{deviceId}/telemetry/current` 和实时 WS `telemetry`。
- 点击刷新后，网页进入“连接中”，后端发布 `request/status`，等待匹配 `cmdId` 的 `ack` 或 `status`。
- 当前在线状态来自 `device_status_current`；刷新期间只有匹配 `cmdId` 的回复能更新它。
- 省电开关只在收到匹配 `cmdId` 且 `low_power` 与目标一致时生效。
- 实时定位地图订阅 WS `telemetry`，并从 `/api/track` 补齐断线期间轨迹。
- SOS 弹窗订阅 WS `sos`，也会从带碰撞标志的 `telemetry` 中兜底触发。

## 10. 调试方法

监听设备所有上报：

```bash
mosquitto_sub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Server -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/#" -v
```

模拟状态回复：

```bash
mosquitto_pub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/status" \
  -m '{"deviceId":"devicereal","cmdId":"test-123","online":true,"status":"ok","battery":78,"low_power":false,"ts":1781010000000}'
```

模拟 telemetry：

```bash
mosquitto_pub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/telemetry/gnss" \
  -m '{"deviceId":"devicereal","ts":1781010000000,"lng":116.397428,"lat":39.90923,"speed":12.5,"heart_rate":86,"temperature":28.6,"humidity":61.2,"battery":78,"low_power":false}'
```

模拟 SOS：

```bash
mosquitto_pub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/events/collision" \
  -m '{"deviceId":"devicereal","ts":1781010000000,"level":"high","score":3.8,"lng":116.397428,"lat":39.90923,"speed":12.5,"message":"collision detected"}'
```

常用数据库检查：

```bash
sqlite3 server/data/tracks.sqlite \
  "SELECT * FROM device_status_current WHERE device_id='devicereal';"

sqlite3 server/data/tracks.sqlite \
  "SELECT cmd_id, type, action, status, battery, low_power, ack_ts FROM device_commands WHERE device_id='devicereal' ORDER BY ts DESC LIMIT 10;"

sqlite3 server/data/tracks.sqlite \
  "SELECT ts, lng, lat, location_source, battery, low_power, heart_rate FROM helmet_telemetry_current WHERE device_id='devicereal';"

sqlite3 server/data/tracks.sqlite \
  "SELECT ts, level, score, lng, lat, message FROM helmet_collision_events WHERE device_id='devicereal' ORDER BY ts DESC LIMIT 10;"
```

## 11. 常见问题

### 网页刷新后一直离线

检查板端是否回复了本次命令的 `cmdId`。刷新期间，不带 `cmdId` 或 `cmdId` 不匹配的 `status` 不会更新当前在线状态。

### 省电模式开关回滚

检查回复中是否带了执行后的 `low_power`，并且值是否与网页下发的 `value.low_power` 一致。

### 传感器数据不更新

检查 topic 是否在 `v1/devices/{deviceId}/telemetry/#` 下，payload 是否是合法 JSON，`deviceId` 是否与网页选中的设备一致。

### SOS 没有弹窗

检查碰撞字段是否能被后端识别：`collision: true` 或 `score > 0`，或者发布到 `events/collision`、`events/sos` 等碰撞事件 topic。

---

文档版本：2.0
最后更新：2026-06-16
适用固件：UniKnect MicroPython for EC200U
