# Python Helmet Simulator (Windows)

本脚本用于在 Windows 上模拟开发板与 `web/ride_helmet_web/server` 的 MQTT 后端进行联调。

## 1) 安装依赖

在 `web/ride_helmet_web/server/scripts/py_sim` 目录执行：

```powershell
pip install -r requirements.txt
```

依赖说明：

- `paho-mqtt`: Python MQTT 客户端库，负责连接 broker、订阅/接收 `.../cmd` 并发布 `.../ack`、`.../status`、`.../telemetry`、`.../events`。

## 2) 启动模拟器

```powershell
cd web/ride_helmet_web/server/scripts/py_sim
python device_sim.py --device-id dev-001 --reply-mode status
```

参数（关键）：

- `--broker`：MQTT Broker 地址（默认 e3133611.ala.cn-hangzhou.emqxsl.cn）
- `--port`：端口（默认 8883）
- `--protocol`：`mqtt` 或 `mqtts`（默认 mqtts）
- `--username` / `--password`：MQTT 凭据
- `--ca-path`：TLS CA 证书（可不传，使用系统默认/不验证）
- `--device-id`：设备 ID（要和网页端绑定设备一致）
- `--topic-prefix`：主题前缀（默认 `v1/devices`）
- `--reply-mode`：`status`(默认), `ack`, `both`, `status+ack`, `ack+status`
- `--telemetry-interval`：自动上报间隔（秒）
- `--no-auto-telemetry`：关闭自动上报，改为手动发 telem
- `--telemetry-topic`：telemetry 子主题（默认 `gnss`）

## 3) 与网页流程对应

### 3.1 刷新按钮（关键）

网页点击“刷新”会调用：

`POST /api/devices/{deviceId}/request_status`

后端会发布到：

`v1/devices/{deviceId}/cmd`

payload 里带 `type=request`, `action=status`, `cmdId`。

模拟器收到该命令后会按 `--reply-mode` 自动回包：

- `status` 主题：`v1/devices/{deviceId}/status`
  - `{ cmdId, online, battery, low_power, ok?(可选) }`
- `ack` 主题：`v1/devices/{deviceId}/ack`

前端会匹配 cmdId 后将状态置为在线。

### 3.2 省电模式开关

网页点击开关会调用 `POST /api/command`

- 下发：`type=power`, `action=set`, `value.low_power`

模拟器处理后会更新 `low_power` 并回复：

- `ack`（推荐）
  - `{ cmdId, ok:true, low_power:bool }`
- 如设置 `--reply-mode=both` 也会再回 `status`。

### 3.3 手动 SOS 与碰撞

控制台命令：

- `sos [score] [level]`：发送 `events/sos`
- `collision [score] [level]`：发送 `telemetry` 里的碰撞事件
- `collision-event [score] [level]`：发送 `events/collision`

`level`/`score` 可按需传入。

## 4) 可改字段（实时生效）

交互命令：

```text
set lng <value>
set lat <value>
set speed <value>
set heading <value>
set altitude <value>
set accuracy <value>
set heart_rate <value>
set temperature <value>
set humidity <value>
set battery <value>
set low_power <true/false>
set location_source <gnss|lbs|...>
set collision_score <value>
set collision_level <high/medium/low>
```

也可 `show` 查看当前状态，`log` 查看最近消息。

## 5) 常用示例

1. 标准联调（推荐）：

```powershell
python device_sim.py --device-id dev-001 --protocol mqtts --port 8883 --reply-mode status --insecure
```

2. 先开关电量/经纬度后再发一包：

```text
set battery 66
set lng 116.40
set lat 39.91
telemetry
```

3. 模拟请求/响应（刷新）：

在网页点“刷新”，观察日志出现：
`[MQTT] recv cmd: {...request...}`，然后 `.../status` 回包。

4. 模拟碰撞告警：

```text
collision 8.2 high
sos 7 medium
```

---

你可以持续在同一个 session 里修改参数，不需要重启脚本。
