# 实时轨迹功能整合交接文档

## 1. 本次用户确认后的需求

目标是在骑行头盔用户网页中实现“实时轨迹模式”。

入口行为：

- 在 `Helmet` 页中，当当前设备状态 `simStatus === 'online'` 时，“查看实时定位”按钮可点击。
- 点击后跳转到 `Map` 页，并进入实时模式。
- 建议通过路由 query 区分普通地图模式和实时模式：

```text
/?mode=live&deviceId=dev-001
```

含义：

- `mode=live`：Map 页进入实时轨迹模式。
- `deviceId=xxx`：订阅并显示该设备的实时轨迹。
- 没有 `mode=live` 时，Map 页保持原有逻辑，显示 Log 页选中并确认显示的历史轨迹。

实时模式显示规则：

- 实时模式下，Map 页不显示 Log 页中已确认显示的轨迹。
- 实时模式下，Map 页跳过当前已有的“浏览器/手机定位”逻辑，直接围绕设备轨迹显示。
- 进入实时模式时，先从后端拉取最近一段历史轨迹作为初始轨迹。
- 初始历史轨迹应按 Log 页类似的时间间隔分段逻辑处理。
- 只显示最新连续段作为实时轨迹的起点。如果和上一段轨迹间隔较久，不应把旧段混进实时显示。
- 后续通过 WebSocket 接收设备 telemetry，并把新点追加到当前实时轨迹。
- 每个点位和点位之间的线都要显示，视觉逻辑与 Log 页确认显示后在 Map 页看到的轨迹一致。
- 当跳转到别的页面时，停止实时显示轨迹，关闭 WebSocket 或停止重连。
- 实时显示期间收到的新轨迹点仍由后端写入数据库；之后用户进入 Log 页时，应按 Log 页原有逻辑看到这些轨迹。
- 离开实时模式后，Log 页选中并确认显示的轨迹在 Map 页的原有显示逻辑恢复。

实现原则：

- 实时模式不要修改 `trackSelection` Pinia store。
- 实时模式只在 Map 页临时忽略 `trackSelection.selected`。
- 普通模式继续使用 `trackSelection` 中 Log 页确认过的分段。
- 这样不会破坏用户在 Log 页已有的选择状态。

## 2. 推荐实现方案

### 2.1 Helmet 页入口

文件：

```text
src/views/Helmet.vue
```

需要做：

- 引入 `useRouter`。
- 给“查看实时定位”按钮绑定点击事件。
- 禁用条件保持为设备不在线不可用。
- 点击时跳转：

```js
router.push({
  name: 'map',
  query: {
    mode: 'live',
    deviceId: String(deviceId.value)
  }
})
```

按钮条件：

```text
simStatus === 'online'
```

### 2.2 Map 页实时模式判断

文件：

```text
src/views/MapView.vue
```

建议引入：

```js
import { useRoute } from 'vue-router'
```

判断：

```js
const route = useRoute()
const isLiveMode = computed(() => route.query.mode === 'live')
const liveDeviceId = computed(() => String(route.query.deviceId || 'dev-001'))
```

实时模式时：

- 不执行手机/浏览器定位。
- 不渲染 `selectionStore.selected`。
- 初始化 `trackService` 后执行实时轨迹初始化。

普通模式时：

- 保持现有逻辑：
  - 初始化地图。
  - 可以继续执行当前定位逻辑。
  - 监听 `selectionStore.selected`。
  - 渲染 Log 页确认显示的历史分段。

### 2.3 初始轨迹加载

实时模式进入后：

```text
GET /api/track?deviceId=xxx&from=Date.now()-30min&limit=5000
```

处理方式：

1. 清洗点。
2. 按 `splitByGap` 分段。
3. 取最后一个 segment。
4. 用 `trackService.renderer.renderTrack(latestSegment.points)` 渲染。
5. 设置 `lastTs` 为最新点时间。

如果最近 30 分钟没有点，可以退化为：

- 显示“等待实时数据”状态。
- WebSocket 收到第一个 telemetry 后开始显示。

### 2.4 WebSocket 实时订阅

WebSocket 地址生成逻辑复用 Helmet 页已有的 `getWsUrl(base)`：

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

连接成功后发送：

```json
{ "type": "subscribe", "deviceId": "dev-001" }
```

收到 telemetry 后：

- 校验 `msg.type === 'telemetry'`。
- 校验 `payload.deviceId === liveDeviceId`。
- 校验 `lng/lat/ts` 有效。
- 去重。
- 如果新点和当前最后点的时间差超过分段阈值，则清空当前实时轨迹，只用新点开始新段。
- 否则追加到当前轨迹。
- 更新 `lastTs`。

分段阈值使用和 `splitByGap` 一致的默认值：

```text
30 * 60 * 1000 ms
```

### 2.5 断线重连和补漏

维护变量：

```js
let liveWs = null
let liveReconnectTimer = null
let liveStopped = false
let liveLastTs = null
const liveSeen = new Set()
```

断线后：

- 状态显示为“重连中”。
- 延迟重连，例如 1500 ms。
- 重连成功后再次 subscribe。
- 如果 `liveLastTs` 存在，调用：

```text
GET /api/track?deviceId=xxx&from=liveLastTs+1&limit=5000
```

补漏点处理：

- 按时间排序。
- 去重。
- 按实时追加规则加入地图。

### 2.6 离开页面时清理

在 `onUnmounted` 中：

- 标记 `liveStopped = true`。
- `clearTimeout(liveReconnectTimer)`。
- `liveWs.close()`。
- 停止实时显示。

这样跳转到其他页面后不会继续接收实时轨迹。

### 2.7 轻量状态显示

Map 页建议添加一个小状态浮层，只在实时模式显示：

```text
实时中 / 连接中 / 重连中 / 已断开 / 等待实时数据
最近更新时间
当前设备 ID
```

注意：

- 不需要做复杂 UI。
- 手机端不要遮挡地图主体。

## 3. 实现注意事项

### 3.1 与 Log 页历史轨迹互斥

实时模式必须临时忽略 Log 选择：

```js
if (isLiveMode.value) {
  // 不 watch selectionStore.selected
  // 不渲染 selectionStore.selected
}
```

普通模式才执行原来的 watch：

```js
watch(() => selectionStore.selected.slice(), ...)
```

### 3.2 实时点仍会进入 Log

前端实时模式不需要额外保存轨迹。数据链路是：

```text
设备 MQTT telemetry
  -> 后端 mqtt.js
  -> 写入 SQLite helmet_telemetry
  -> WebSocket broadcast
  -> Map 实时显示
```

因此实时显示过的点之后会自然出现在 Log 页。

### 3.3 每个点和线都显示

第一版可以复用当前 `trackRenderer.renderTrack(...)` 和 `appendPoints(...)`。

当前 `appendPoints(points)` 会合并旧点并重绘整条轨迹，不是高性能增量更新，但第一版可接受。

后续优化方向：

- 维护 live polyline。
- 新点到来时只更新 path。
- 当前设备 marker 只移动位置。
- 点数过多时不要为每个实时点创建 marker，或做抽稀。

### 3.4 建议改动文件

```text
src/views/Helmet.vue
src/views/MapView.vue
```

可选新增工具：

```text
src/utils/ws.js
```

但第一版可以先不新增文件，直接在 `MapView.vue` 内实现。

## 4. 已确认的问题答案

### 4.1 query 区分实时模式是什么意思？

`query` 是 URL 后面的参数，例如：

```text
/?mode=live&deviceId=dev-001
```

Map 页还是同一个页面 `/`，但它通过 `mode=live` 判断这次应进入实时模式。

没有这个参数时，Map 页保持普通模式，继续显示 Log 页确认过的历史轨迹。

### 4.2 最近 30 分钟轨迹如何处理？

进入实时模式时拉最近 30 分钟轨迹，但不是无脑全部显示。

应按 Log 页类似的分段逻辑处理：

- 如果最近 30 分钟里存在多段轨迹，只取最新一段用于实时显示。
- 如果上一段和当前轨迹间隔较久，不应显示在实时轨迹里。
- 这些点仍然在数据库中，之后 Log 页可以按原有逻辑看到。

### 4.3 是否跳过 Map 页当前手机定位？

是。实时模式应跳过手机/浏览器定位。

原因：

- 用户点击的是“查看设备实时定位”。
- 地图应直接围绕设备轨迹，而不是先定位用户手机。

### 4.4 Helmet 页按钮何时可点？

只在：

```text
simStatus === 'online'
```

时可点击。

## 5. 原 realtime-track-agent-brief.md 完整内容

以下为原始 brief 全文，未省略。

---

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

- 写入 `helmet_telemetry`，有坐标时可作为轨迹点读取
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
