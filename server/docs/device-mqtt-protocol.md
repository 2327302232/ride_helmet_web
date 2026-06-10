# 板端 MQTT 开发协议文档

本文档面向 UniKnect MicroPython (EC200U) 开发者，描述板端设备与后端服务器之间的 MQTT 通信协议。

## 1. MQTT Broker 配置

```python
BROKER = "e3133611.ala.cn-hangzhou.emqxsl.cn"
PORT = 8883  # MQTTS (TLS)
USERNAME = "Device"
PASSWORD = "mqtt"
CLIENT_ID = "helmet-{deviceId}"  # 建议使用唯一 ID
TOPIC_PREFIX = "v1/devices"
```

**CA 证书**: 使用 `emqxsl-ca.crt` (DigiCert Global Root G2)

**QoS 建议**: 板端所有 publish 使用 QoS 0，避免 EC200U + TLS 环境下 QoS 1 的 PUBACK 导致阻塞。

## 2. Topic 规范

### 2.1 板端订阅 (Subscribe)

```
v1/devices/{deviceId}/cmd
```

板端订阅此 topic 接收后端下发的命令。

### 2.2 板端发布 (Publish)

| Topic | 用途 | QoS |
|-------|------|-----|
| `v1/devices/{deviceId}/telemetry` | 传感器数据上报 | 0 |
| `v1/devices/{deviceId}/status` | 状态回复/主动上报 | 0 |
| `v1/devices/{deviceId}/ack` | 命令确认(可选) | 0 |
| `v1/devices/{deviceId}/events/collision` | 碰撞事件 | 0 |
| `v1/devices/{deviceId}/events/gnss` | GNSS 事件/错误 | 0 |

**注意**: 所有 topic 的 `{deviceId}` 必须替换为实际设备 ID (如 `devicereal`)。

## 3. 命令处理流程

### 3.1 刷新状态命令

**后端下发**:
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

**板端回复** (发布到 `v1/devices/{deviceId}/status`):
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

**字段说明**:
- `cmdId`: **必须**与命令中的 cmdId 一致
- `online`: **必须** true/false，表示设备在线
- `battery`: 电量百分比 (0-100)
- `low_power`: **必须** true/false (不能是字符串 "false")
- `ts`: 毫秒时间戳

### 3.2 省电模式命令

**后端下发**:
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

**板端回复**:
```json
{
  "deviceId": "devicereal",
  "cmdId": "uuid-5678",
  "online": true,
  "status": "ok",
  "message": "power mode updated",
  "battery": 78,
  "low_power": true,
  "ts": 1781010001000
}
```

**重要**: 网页必须看到 `low_power` 字段与目标值一致才认为成功。板端必须:
1. 执行省电模式切换
2. 在回复中包含执行后的 `low_power` 实际值
3. 确保 `low_power` 是布尔值,不要发送字符串 `"false"`

## 4. Telemetry 上报

**Topic**: `v1/devices/{deviceId}/telemetry`

**Payload 示例**:
```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "lng": 116.397428,
  "lat": 39.909230,
  "speed": 12.5,
  "heading": 90,
  "altitude": 30,
  "accuracy": 5,
  "heart_rate": 86,
  "temperature": 28.6,
  "humidity": 61.2,
  "battery": 78,
  "low_power": false
}
```

**字段说明**:
- `ts`: **必填**,毫秒时间戳
- `lng`, `lat`: 经纬度 (有 GPS 时填写)
- `speed`: 速度 (km/h 或 m/s,根据实际)
- `heart_rate`: 心率 (bpm)
- `temperature`: 温度 (°C)
- `humidity`: 湿度 (%)
- `battery`: 电量 (0-100)
- `low_power`: 省电模式状态

**上报频率建议**:
- 正常模式: 每 5-10 秒上报一次
- 省电模式: 每 30-60 秒上报一次

## 5. 碰撞事件上报

**Topic**: `v1/devices/{deviceId}/events/collision`

**Payload 示例**:
```json
{
  "deviceId": "devicereal",
  "ts": 1781010000000,
  "event": "collision",
  "level": "medium",
  "score": 2.3,
  "lng": 116.397428,
  "lat": 39.909230,
  "speed": 12.5,
  "message": "collision detected"
}
```

**字段说明**:
- `level`: 碰撞等级 (`low`, `medium`, `high`)
- `score`: 碰撞强度分数 (数值)
- 其他定位/状态字段同 telemetry

**触发条件**: 加速度传感器检测到撞击时立即上报。

## 6. 时间戳规范

**板端时间戳要求**:
- 使用 Unix 毫秒时间戳 (从 1970-01-01 00:00:00 UTC 算起)
- MicroPython `time.time()` 如果基于 2000-01-01,需要加上偏移: `946684800000` 毫秒
- 示例:
  ```python
  import time
  
  def now_ms():
      sec = time.time()
      ms = int(sec * 1000)
      # 检查是否需要加 2000 年偏移
      if sec < 1000000000:  # 小于 2001-09-09
          ms = ms + 946684800000
      return ms
  ```

## 7. MicroPython 实现要点

### 7.1 避免 TLS 阻塞

- **QoS**: 所有 publish 使用 QoS 0
- **Payload 大小**: 尽量精简,避免大 JSON (> 512 字节)
- **发送间隔**: 两次 publish 之间至少间隔 20ms
- **不在回调中 publish**: 收到命令后入队,在主循环中处理回复

```python
# 示例代码结构
pending_replies = []

def on_message(topic, msg):
    payload = json.loads(msg)
    pending_replies.append(payload)  # 只入队,不直接回复

def main_loop():
    while True:
        client.check_msg()  # 非阻塞接收
        
        if pending_replies:
            cmd = pending_replies.pop(0)
            handle_and_reply(cmd)  # 在主循环中回复
            time.sleep(0.02)  # 给模组时间处理
        
        time.sleep(0.1)
```

### 7.2 数据类型注意

- `battery`: 整数 0-100,不要带百分号
- `low_power`: 布尔值 `true`/`false`,不要用字符串 `"true"`/`"false"`
- `online`: 布尔值 `true`/`false`
- `ts`: 数值型毫秒时间戳

### 7.3 CA 证书路径

```python
# 常见路径
CA_PATHS = (
    "./emqxsl-ca.crt",
    "/flash/emqxsl-ca.crt",
)

def make_ssl():
    for path in CA_PATHS:
        try:
            with open(path, 'r') as f:
                ca = f.read().encode('utf-8')
            context = tls.SSLContext(tls.PROTOCOL_TLS_CLIENT)
            context.verify_mode = tls.CERT_REQUIRED
            context.load_verify_locations(ca)
            return context
        except:
            pass
    return True  # 回退到基本 TLS
```

## 8. 调试方法

### 8.1 使用 mosquitto_sub 监听

```bash
# 监听设备上报
mosquitto_sub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/#" -v

# 监听后端下发命令
mosquitto_sub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/cmd" -v
```

### 8.2 使用 mosquitto_pub 模拟板端

```bash
# 模拟状态回复
mosquitto_pub -h e3133611.ala.cn-hangzhou.emqxsl.cn -p 8883 \
  -u Device -P mqtt \
  --cafile emqxsl-ca.crt \
  -t "v1/devices/devicereal/status" \
  -m '{"deviceId":"devicereal","cmdId":"test-123","online":true,"battery":78,"low_power":false,"ts":1781010000000}'
```

### 8.3 检查后端数据库

```bash
# 查看设备最新状态
sqlite3 server/data/tracks.sqlite \
  "SELECT * FROM device_status_current WHERE device_id='devicereal';"

# 查看命令记录
sqlite3 server/data/tracks.sqlite \
  "SELECT cmd_id, type, action, status, ack_ts FROM device_commands WHERE device_id='devicereal' ORDER BY ts DESC LIMIT 10;"

# 查看 telemetry
sqlite3 server/data/tracks.sqlite \
  "SELECT ts, battery, low_power, heart_rate FROM helmet_telemetry_current WHERE device_id='devicereal';"
```

## 9. 常见问题

### Q1: 板子发送后网页没反应?

**检查**:
1. 板端是否成功连接到 MQTT Broker (观察 `MQTT connected` 日志)
2. Payload 中的 `deviceId` 是否与后端一致
3. Payload 中的 `cmdId` 是否与命令一致 (状态回复时必须)
4. `low_power` 是否为布尔值而不是字符串

### Q2: 板子发送后卡住?

**原因**: TLS + QoS 1 导致阻塞。

**解决**:
- 所有 publish 改用 QoS 0
- 减小 payload 大小
- 不要在 `on_message` 回调中直接 publish

### Q3: 网页显示离线但板端认为在线?

**检查**:
1. 板端回复的 `cmdId` 是否匹配
2. 板端回复的 topic 是否正确 (`v1/devices/{deviceId}/status`)
3. 板端回复中是否包含 `online: true`
4. 时间戳 `ts` 是否正确 (毫秒时间戳)

### Q4: 省电模式开关不生效?

**检查**:
1. 板端是否正确解析 `value.low_power`
2. 板端回复中 `low_power` 是否与目标值一致
3. `low_power` 是否为布尔值 (不要发送字符串 `"false"`)

## 10. 完整示例代码

参考项目中的 `ride_helmet/V0/helmet_status.py`,它实现了:
- TLS 连接
- 命令订阅与回复
- 队列式回复 (避免阻塞)
- 状态上报
- 省电模式支持

关键要点:
1. 使用 QoS 0
2. 回复中必须包含 `cmdId`
3. `low_power` 使用布尔值
4. 在主循环中 publish,不在回调中

---

**文档版本**: 1.0  
**最后更新**: 2026-06-10  
**适用固件**: UniKnect MicroPython for EC200U
