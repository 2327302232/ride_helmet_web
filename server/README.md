# Server (Windows)

1) 安装依赖：

```powershell
cd server
npm install
```

2) 运行：

```powershell
npm run dev
```

3) 验证（在浏览器或 PowerShell 中）：

- `GET http://localhost:8787/api/health`  -> { ok: true }
- `POST http://localhost:8787/api/test/seed` -> seeds 20 gps points
- `GET http://localhost:8787/api/devices` -> list devices with lastTs
- `GET http://localhost:8787/api/track?deviceId=dev-001` -> track points

注意：不要提交 `.env` 或 `server/data/*.sqlite`。

## 长期后端入口（`src/server.js`）

本仓库新增了 `src/server.js` 作为长期运行的后端入口（ESM 风格）。职责仅限于：初始化数据库、启动 MQTT 客户端并注册优雅退出逻辑；不包含 HTTP 路由或其它业务实现。

启动（文档说明，agent 未执行任何命令）：

```powershell
cd server
npm run start
```

## HTTP 命令 API（阶段 E）

新增了用于测试的命令下发 HTTP 接口：

- POST `/api/command` — 下发设备命令（用于测试，未实现鉴权）

请求示例：

```bash
curl -X POST http://localhost:8787/api/command \
	-H "Content-Type: application/json" \
	-d '{"deviceId":"dev-001","type":"cmd","action":"reboot","value":{"delay":5}}'
```

成功返回示例（HTTP 200）：

```json
{ "cmdId": "<uuid>", "status": "sent" }
```

若输入校验失败将返回 HTTP 400 及错误描述；若发布到 MQTT 失败将返回 HTTP 500 并把 DB 中对应记录标记为 `failed`。

实现要点：

- 路由实现位于 `src/api/command.js`，会先调用 `addDeviceCommand(...)` 写入 `device_commands`（status=queued），然后调用 `publishCommand(...)` 发布到 MQTT（会尝试把状态更新为 `sent`，ACK 由 MQTT 模块处理并更新为 `acked`）。
- 当前未实现鉴权：仅用于本地或测试环境。生产环境请添加鉴权与速率限制。

本地手动测试建议：

1) 启动长期后端：

```powershell
cd server
npm run start
```

2) 在另一个终端订阅设备 topic（示例，使用 mosquitto_sub）：

```bash
mosquitto_sub -t "v1/devices/dev-001/cmd" -v
```

3) 使用 curl 发送命令（参考上方示例），观察 mosquitto_sub 是否收到包含相同 `cmdId` 的 payload。

4) 验证 sqlite 数据库（示例 sqlite3 查询）：

```
sqlite3 server/data/tracks.sqlite "SELECT cmd_id, device_id, status, ts, sent_ts, ack_ts FROM device_commands ORDER BY ts DESC LIMIT 10;"
```

注：当前为测试实现，agent 未执行任何命令或进行安装操作。

## 设备命令 ACK 落库说明

- 当设备通过 MQTT 发送 ACK（或超时未收到 ACK）时，后端会自动将 ACK 结果写入 device_commands 表：
  - status: 'acked'（成功）或 'failed'（超时/失败）
  - ack_ts: ACK 到达或超时时间戳
  - ack_payload: JSON 字符串，记录原始 payload
  - last_error: 仅失败时记录 message
- 幂等策略：
  - 真实设备 ACK（ok=true）会覆盖 failed/expired 状态
  - 若已为 'acked'，后续同 cmdId 的超时/失败不会覆盖

### 手动验证方法

1. 用 mosquitto_pub 向 ack topic 发送 payload，模拟设备 ACK
2. 用 sqlite3 查询 device_commands 表，检查 ack_ts/ack_payload/status
3. 测试超时情形与幂等覆盖（见 tests/server-manual-checklist.md）

主要环境变量（在仓库中被发现并使用）：
- `MQTT_URL`（必需）
- `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID`
- `MQTT_TOPIC_PREFIX`（默认 `v1/devices`）
- `MQTT_CA_PATH`（可选，用于 TLS）
- `MQTT_QOS_TELEMETRY`, `MQTT_QOS_CMD`
- `COMMAND_ACK_TIMEOUT_MS`, `RECONNECT_PERIOD_MS`
- `DB_PATH`（可选，覆盖默认的 `server/data/tracks.sqlite`）

本地手动验证检查点（仅文档）：
1) 启动后应看到 `DB initialized.` 或类似日志，表示 `initDb()` 成功执行。
2) 启动后应看到 MQTT client 相关日志，例如 `MQTT connected` 与 `subscribed`，表示已订阅设备主题。
3) 当设备发送 telemetry 时，`[MQTT EVENT] telemetry` 日志会打印接收到的 payload；同时可使用 sqlite3 或 DB 浏览器检查数据是否写入：

示例 sqlite3 查询（仅示例，手动在 server 目录下使用 sqlite3 CLI 或 DB 浏览器运行）：

```
sqlite3 server/data/tracks.sqlite "SELECT * FROM helmet_telemetry ORDER BY ts DESC LIMIT 10;"
sqlite3 server/data/tracks.sqlite "SELECT * FROM device_commands ORDER BY ts DESC LIMIT 10;"
```

说明：仓库中仍保留 `test-start.mjs` 作为调试/测试脚本（位于仓库根目录），它也会初始化 DB 并启动 MQTT，用于临时调试。长期运行的服务建议使用 `src/server.js`（并通过 `npm run start` 启动）。

## 板端 MQTT 开发协议

板端设备（UniKnect MicroPython / EC200U）与后端的 MQTT 通信协议详见：

📄 **[板端 MQTT 开发协议文档](docs/device-mqtt-protocol.md)**

该文档包含：
- MQTT Broker 连接配置
- Topic 规范与 Payload 格式
- 命令处理流程（状态刷新、省电模式）
- Telemetry 与事件上报
- 时间戳规范
- MicroPython 实现要点（避免 TLS 阻塞）
- 调试方法与常见问题

**关键要点**：
- 板端所有 publish 使用 **QoS 0**（避免 EC200U + TLS 阻塞）
- 回复命令时必须包含 **cmdId**
- `low_power` 必须是**布尔值**而非字符串
- 在主循环中 publish，不要在 MQTT 回调中直接发送
