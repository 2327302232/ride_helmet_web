# Server 手动检查清单（server/tests/server-manual-checklist.md）

此文件包含手动验证长期入口 `src/server.js` 的清单与排错提示（仅文档，不执行）。

1) 启动服务

```powershell
cd server
npm run start
```

2) 启动后应观察到日志：
- `DB initialized.` —— 表示 `initDb()` 成功
- `MQTT connected` 与若干 `subscribed` 日志 —— 表示 MQTT 已连接并订阅主题
- 若收到设备数据，会看到 `[MQTT EVENT] telemetry` 或其它事件日志

3) 使用 sqlite3 验证数据写入（示例命令，手动运行）：

```
sqlite3 server/data/tracks.sqlite "SELECT device_id, ts, lng, lat FROM helmet_telemetry ORDER BY ts DESC LIMIT 10;"
sqlite3 server/data/tracks.sqlite "SELECT cmd_id, device_id, status, ts FROM device_commands ORDER BY ts DESC LIMIT 10;"
```

4) 常见问题与排查
- 未看到 `MQTT connected`：确认 `MQTT_URL` 环境变量是否设置正确，检查网络与 TLS（若使用 `MQTT_CA_PATH`）。
- 订阅失败或被踢下线：检查 `MQTT_CLIENT_ID` 是否与其他客户端冲突（重复 clientId 会被 broker 踢）。
- DB 初始化失败：检查 `DB_PATH` 指向是否有效；确认 `server/data` 目录具有写权限。
- 收到 telemetry 但未写入 DB：查看运行日志中的错误（`[MQTT EVENT] error`），并确认 payload 格式是否包含经纬度字段（`lng`/`lat` 或 `lon`/`lat`）。

5) 其它建议
- 使用 `test-start.mjs`（根目录）做快速调试，但 `src/server.js` 为长期运行入口并已在 `package.json` 中添加 `start` 脚本。

6) HTTP 命令 API（手动验证）

1) 启动长期后端（另起终端）：

```powershell
cd server
npm run start
```

2) 在另一个终端使用 `mosquitto_sub` 订阅设备命令 topic：

```bash
mosquitto_sub -t "v1/devices/dev-001/cmd" -v
```

3) 使用 curl 发送命令：

```bash
curl -X POST http://localhost:8787/api/command \
	-H "Content-Type: application/json" \
	-d '{"deviceId":"dev-001","type":"cmd","action":"reboot","value":{"delay":5}}'
```

4) 观察 `mosquitto_sub` 是否收到包含 `cmdId` 的消息；记录返回的 `cmdId`。

5) 在 DB 中查询命令状态：

```
sqlite3 server/data/tracks.sqlite "SELECT cmd_id, device_id, status, ts, sent_ts, ack_ts FROM device_commands WHERE cmd_id='<cmdId>' LIMIT 1;"
```

6) 可用 `mosquitto_pub` 模拟设备发送 ACK（将 `<cmdId>` 替换为上一步返回的 cmdId）：

```bash
mosquitto_pub -t "v1/devices/dev-001/ack" -m '{"cmdId":"<cmdId>","ok":true}'
```

7) 再次查询 DB，确认对应记录的 `status -> acked` 并且 `ack_ts`、`ack_payload` 被写入。

## 验证 ACK 已写入 DB

1) 用 mosquitto_pub 模拟设备 ACK：
   - 发送到 ack topic，payload 示例：
     - 成功 ACK：
       { "deviceId": "dev-001", "cmdId": "<cmdId>", "ok": true, "message": "ack ok", "ts": 1713430000000 }
     - 超时 ACK：
       { "deviceId": "dev-001", "cmdId": "<cmdId>", "ok": false, "message": "ack timeout", "ts": 1713430001000 }
   - 注意：<cmdId> 替换为实际命令 ID。

2) 用 sqlite3 查询 device_commands 表，检查 ack_ts/ack_payload/status：
   - 示例：
     sqlite3 server/data/tracks.sqlite "SELECT cmd_id, device_id, status, ack_ts, ack_payload, last_error FROM device_commands WHERE cmd_id = '<cmdId>';"
   - status 应为 'acked'（ok=true）或 'failed'（超时/失败），ack_ts/ack_payload 应有值。

3) 测试超时情形：
   - 可通过不发送设备 ACK，等待超时后观察 DB 中 status 是否变为 'failed'，ack_payload 包含 { ok:false, message:'ack timeout' }。
   - 若后续真实 ACK 到达（ok=true），应覆盖之前的 failed/expired 状态。

4) 幂等性说明：
   - 若 status 已为 'acked'，后续同 cmdId 的超时/失败不会覆盖。
   - 但真实设备 ACK（ok=true）会覆盖 failed/expired。

故障排查：若发布到 MQTT 失败，路由会把命令状态更新为 `failed` 并在 HTTP 返回中包含错误简述；检查服务端日志中的 `[MQTT EVENT] error` 或 `publishCommand failed` 日志以定位问题。
