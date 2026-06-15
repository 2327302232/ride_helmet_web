# 实时轨迹功能 Agent Brief

## 背景

这是一个骑行头盔用户网页，前端是 Vue/Vite 单页应用，主要面向手机端使用。网页部署在 GitHub Pages，并通过 Cloudflare 使用自定义域名访问：

- 前端网页：`https://dkrx.dpdns.org/`
- 后端 API：`https://api.dkrx.dpdns.org`
- WebSocket 目标地址：`wss://api.dkrx.dpdns.org/ws`

`VITE_BACKEND_URL` 已经配置为后端地址，且当前后端已经可以通过 Cloudflare Tunnel 正常供给不同网络下的网页访问。Cloudflare WebSockets 开关已经打开。

本次不需要考虑安全问题，不需要加鉴权，不需要限制 Origin，也不需要处理用户权限隔离。

## 当前部署关系

前端是静态网页，由 GitHub Pages 托管。用户手机浏览器打开 `https://dkrx.dpdns.org/` 后，浏览器直接请求后端域名：

```text
用户手机浏览器
  -> https://dkrx.dpdns.org/              # GitHub Pages 前端
  -> https://api.dkrx.dpdns.org/api/...   # 后端 HTTP API
  -> wss://api.dkrx.dpdns.org/ws          # 后端 WebSocket
```

后端通过 Cloudflare Tunnel 暴露，大致链路为：

```text
用户手机浏览器
  -> https://api.dkrx.dpdns.org
  -> Cloudflare
  -> cloudflared tunnel
  -> 本机/服务器 localhost:8888
  -> Node Express 后端
```

Cloudflare Tunnel 的 `service` 继续使用 HTTP 即可，例如：

```yaml
ingress:
  - hostname: api.dkrx.dpdns.org
    service: http://localhost:8888
  - service: http_status:404
```

不需要把 tunnel service 改成 `ws://`。Cloudflare 会自动处理 WebSocket 的 HTTP Upgrade，把外部 `wss://api.dkrx.dpdns.org/ws` 转发到后端 `/ws`。

## 当前后端现状

后端位于 `server/`，主要入口是：

- `server/src/server.js`
- `server/src/mqtt.js`
- `server/src/api/track.js`
- `server/src/db.js`

当前数据链路：

```text
设备
  -> MQTT broker
  -> 后端 mqtt.js 订阅设备 topic
  -> 写入 SQLite 数据库
  -> HTTP API 给网页读取历史轨迹
```

设备通过 MQTT 发 telemetry 给 broker。后端 `server/src/mqtt.js` 订阅 MQTT topic，解析 payload 后写数据库：

- 有坐标时写入 `gps_points`
- 同时写入/更新 `helmet_telemetry`、`helmet_telemetry_current`
- 然后通过内部 EventEmitter 发出 `telemetry` 事件

轨迹历史读取接口已经存在：

```text
GET /api/track?deviceId=dev-001&from=...&to=...&limit=...
```

对应文件：

- `server/src/api/track.js`
- `server/src/db.js` 中的 `getTrack(...)`

后端也已经有 WebSocket 服务：

- 路径：`/ws`
- 文件：`server/src/server.js`
- 前端连接后发送：

```json
{ "type": "subscribe", "deviceId": "dev-001" }
```

后端会把该 socket 加入对应设备的订阅集合。之后 MQTT 收到该设备 telemetry 时，后端会广播：

```json
{
  "type": "telemetry",
  "payload": {
    "deviceId": "dev-001",
    "ts": 1710000000000,
    "lng": 121.4737,
    "lat": 31.2304,
    "speed": 12.3,
    "battery": 80
  }
}
```

后端也会通过同一个 WebSocket 广播 `status`、`cmd_ack`，Helmet 页已经在使用这套机制。

## 当前前端现状

前端位于 `src/`。相关文件：

- `src/views/MapView.vue`
- `src/utils/trackService.js`
- `src/utils/trackRenderer.js`
- `src/views/Helmet.vue`
- `src/views/Log.vue`
- `src/stores/trackSelection.js`

当前 Map 页主要是历史轨迹展示：

- `MapView.vue` 初始化高德地图
- 从 `trackSelection` 里读取 Log 页选中的轨迹分段
- 根据分段的 `deviceId/from/to` 请求 `/api/track`
- 使用 `trackRenderer.renderSegment(...)` 渲染历史分段

`trackService.js` 已经能请求 `/api/track` 并调用 renderer 渲染轨迹。

`trackRenderer.js` 已经有：

- `renderTrack(points)`
- `renderSegment(segmentId, points)`
- `appendPoints(points)`
- `clearTrack()`

但是当前 `appendPoints(points)` 是把旧点和新点合并后重新 `renderTrack(...)`，不是高性能的真实增量渲染。第一版可以先复用，后续点多时建议优化为只更新 polyline path 和当前 marker。

Helmet 页 `src/views/Helmet.vue` 已经有 WebSocket 连接示例：

- 根据 `VITE_BACKEND_URL` 把 `https://api.dkrx.dpdns.org` 转成 `wss://api.dkrx.dpdns.org/ws`
- 连接 `/ws`
- 发送 `{ type: 'subscribe', deviceId }`
- 接收 `telemetry/status/cmd_ack`

Map 页可以复用或抽取这部分 WebSocket 地址生成逻辑。

## 为什么不用前端直接连 MQTT

目标架构不是让网页直接订阅 MQTT broker。

推荐链路：

```text
MQTT:      设备 -> 后端
WebSocket: 后端 -> 网页
HTTP API:  数据库历史轨迹/断线补漏 -> 网页
```

原因：

- 设备侧 MQTT 已经由后端统一订阅和入库
- 网页只需要跟后端通信
- 历史数据以数据库为准
- 实时数据由后端在入库后推送给网页

## 要实现的实时轨迹目标

目标是在 Map 页实时查看设备轨迹。

第一版目标：

1. Map 页进入实时模式后，先通过 `/api/track` 拉一段历史轨迹作为初始轨迹。
2. 连接 `wss://api.dkrx.dpdns.org/ws`。
3. WebSocket open 后发送订阅消息：

```json
{ "type": "subscribe", "deviceId": "dev-001" }
```

4. 收到 `type === "telemetry"` 的消息后：
   - 校验 `payload.deviceId`
   - 校验 `payload.lng/payload.lat/payload.ts`
   - 追加到当前轨迹
   - 移动“当前设备位置” marker
   - 更新最后收到的 `lastTs`

5. WebSocket 断线后自动重连。
6. 重连后用 `/api/track?deviceId=xxx&from=lastTs+1` 补回断线期间漏掉的点。
7. 页面上显示轻量状态，例如：
   - 实时中
   - 连接中
   - 重连中
   - 已断开
   - 最近更新时间

## 推荐实现策略

### 设备选择

第一版可以先保守处理：

- 如果 Map 页来自 Log 页选择的轨迹分段，则优先使用选中分段的 `deviceId`
- 如果没有选中分段，则使用当前用户绑定设备列表里的第一个设备
- 如果仍然没有设备，则 fallback 到 `dev-001`

后续如果需要多设备实时查看，再加设备切换 UI。

### 初始历史轨迹

进入实时模式时建议拉最近一段：

```text
GET /api/track?deviceId=xxx&from=最近30分钟或当天开始&limit=5000
```

如果不确定时间范围，可以先不传 `from/to`，但注意点很多时手机端渲染可能变慢。

### WebSocket 地址

不要硬编码 `wss://api.dkrx.dpdns.org/ws`。应从 `VITE_BACKEND_URL` 转换：

```js
function getWsUrl(base) {
  let url = (base || '').replace(/\/$/, '')
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://')
  else if (url.startsWith('https://')) url = url.replace('https://', 'wss://')
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
  }
  return url + '/ws'
}
```

Helmet 页已有类似实现，可以复用。

### 实时追加

第一版可以调用现有：

```js
trackService.appendPoints([point])
```

但要注意该方法当前会重绘整条轨迹。若点数增长后手机卡顿，需要优化 `trackRenderer`：

- 维护 live polyline
- 新点到来时只更新 path
- 当前设备 marker 只移动位置
- 不为每个实时点都创建 marker

### 断线补漏

维护 `lastTs`：

- 初始化历史轨迹后，把最后一个点的时间设为 `lastTs`
- 每次收到 WebSocket telemetry 后更新 `lastTs`
- WebSocket 断线重连成功后请求：

```text
GET /api/track?deviceId=xxx&from=lastTs+1
```

拿到补漏点后按时间排序、去重，再追加到地图。

### 去重

至少按以下组合去重：

```text
deviceId + ts + lng + lat
```

如果设备 payload 后续稳定提供 `seq`，可以优先按 `seq` 去重。

## 不需要做的事

本次不需要：

- 不需要加鉴权
- 不需要改 GitHub Pages
- 不需要改 Cloudflare 前端域名
- 不需要让网页直接连 MQTT broker
- 不需要把 Cloudflare Tunnel service 改成 `ws://`
- 不需要重构整个后端

## 需要验证

建议完成后至少验证：

1. `https://api.dkrx.dpdns.org/api/health` 可访问。
2. `wss://api.dkrx.dpdns.org/ws` 可以从前端连接成功。
3. Map 页发送 subscribe 后，后端返回 `subscribed`。
4. 设备发 MQTT telemetry 后：
   - 后端数据库有新点
   - 后端日志有 telemetry
   - Map 页收到 WebSocket `telemetry`
   - 地图轨迹追加新点
   - 当前设备 marker 移动
5. 关闭网络或后端后，Map 页进入断线/重连状态。
6. 恢复连接后，Map 页能补回断线期间的轨迹点。

## 给后续 Agent 的核心结论

后端实时通道已经基本存在。主要任务不是新建后端实时系统，而是把 Map 页接入现有 `/ws`：

```text
Map 页初始化历史轨迹
  -> 连接 /ws
  -> subscribe deviceId
  -> 收 telemetry
  -> 追加轨迹点
  -> 断线重连
  -> 用 /api/track 补漏
```

第一版以可用为主，后续再优化渲染性能和多设备 UI。
