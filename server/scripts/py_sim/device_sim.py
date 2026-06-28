#!/usr/bin/env python3
"""
Windows MQTT 设备模拟器（Python 版）

用途：
- 连接 `v1/devices/{deviceId}/cmd`，接收 Web 端下发命令。
- 支持刷新命令（request/status）和省电命令（power/set）的正确回复（status / ack + cmdId）。
- 支持手动上报 telemetry（可带碰撞字段）、手动发送 events/collision 或 events/sos。
- 支持运行时修改经纬度、电量、心率、温度、湿度、速度、方向、高度、精度等字段。
- 支持定时自动发送 telemetry，便于在开发过程中持续产生数据。

不依赖原始开发板代码，直接可在 Windows 上运行。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import paho.mqtt.client as mqtt

TIME_OFFSET_MS = 38000000


def now_ms() -> int:
    return int(time.time() * 1000) + TIME_OFFSET_MS


def to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value in (1, "1", "true", "True", "TRUE", "yes", "YES", "on", "ON"):
        return True
    if value in (0, "0", "false", "False", "FALSE", "no", "NO", "off", "OFF", ""):
        return False
    return bool(value)


@dataclass
class SimState:
    device_id: str
    lng: float = 113.405403
    lat: float = 23.041300
    speed: float = 0.0
    heading: float = 90.0
    altitude: float = 30.0
    accuracy: float = 5.0
    heart_rate: float = 95.0
    temperature: float = 31.6
    humidity: float = 61.2
    battery: int = 89
    low_power: bool = False
    location_source: str = "lbs"
    collision_score: float = 3.8
    collision_level: str = "high"
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "deviceId": self.device_id,
                "lng": self.lng,
                "lat": self.lat,
                "speed": self.speed,
                "heading": self.heading,
                "altitude": self.altitude,
                "accuracy": self.accuracy,
                "heart_rate": self.heart_rate,
                "temperature": self.temperature,
                "humidity": self.humidity,
                "battery": self.battery,
                "low_power": self.low_power,
                "location_source": self.location_source,
                "collision_score": self.collision_score,
                "collision_level": self.collision_level,
                "ts": now_ms()
            }

    def set_field(self, key: str, value: Any) -> bool:
        key = key.lower()
        with self.lock:
            if key in {"lng", "lon", "longitude"}:
                self.lng = float(value)
            elif key in {"lat", "latitude"}:
                self.lat = float(value)
            elif key == "speed":
                self.speed = float(value)
            elif key in {"heading", "bearing"}:
                self.heading = float(value)
            elif key == "altitude":
                self.altitude = float(value)
            elif key in {"accuracy", "hdop"}:
                self.accuracy = float(value)
            elif key in {"heart_rate", "hr"}:
                self.heart_rate = float(value)
            elif key in {"temperature", "temp", "temperature_c"}:
                self.temperature = float(value)
            elif key in {"humidity", "hum"}:
                self.humidity = float(value)
            elif key in {"battery", "battery_soc"}:
                self.battery = int(value)
            elif key in {"low_power", "lowpower"}:
                self.low_power = to_bool(value)
            elif key == "location_source":
                self.location_source = str(value)
            elif key == "collision_score":
                self.collision_score = float(value)
            elif key == "collision_level":
                self.collision_level = str(value)
            else:
                return False
        return True

    def telemetry_payload(self, collision: bool = False, event: Optional[str] = None) -> Dict[str, Any]:
        snap = self.snapshot()
        payload = {
            "deviceId": snap["deviceId"],
            "ts": snap["ts"],
            "lng": snap["lng"],
            "lat": snap["lat"],
            "speed": snap["speed"],
            "heading": snap["heading"],
            "altitude": snap["altitude"],
            "accuracy": snap["accuracy"],
            "location_source": snap["location_source"],
            "heart_rate": snap["heart_rate"],
            "temperature": snap["temperature"],
            "humidity": snap["humidity"],
            "battery": snap["battery"],
            "low_power": snap["low_power"],
        }
        if collision:
            payload.update(
                {
                    "collision": True,
                    "collision_score": snap["collision_score"],
                    "collision_level": snap["collision_level"],
                    "message": "collision detected (manual)",
                }
            )
            if event:
                payload["event"] = event
        return payload


class PythonHelmetSimulator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state = SimState(device_id=args.device_id)
        self.running = True
        self.connected = threading.Event()
        self._stop = threading.Event()
        self._mqtt = None
        self._cmd_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._topic_cmd = f"{args.topic_prefix}/{args.device_id}/cmd"
        self._topic_ack = f"{args.topic_prefix}/{args.device_id}/ack"
        self._topic_status = f"{args.topic_prefix}/{args.device_id}/status"
        self._topic_telemetry = f"{args.topic_prefix}/{args.device_id}/telemetry"
        self._topic_events = f"{args.topic_prefix}/{args.device_id}/events"
        self.reply_mode = args.reply_mode.lower()
        self.auto_telemetry = not args.no_auto_telemetry
        self.auto_interval = max(1.0, float(args.telemetry_interval))
        self.telemetry_topic_suffix = args.telemetry_topic
        self._telemetry_thread = threading.Thread(target=self._auto_send_telemetry_loop, daemon=True)
        self._cmd_worker_thread = threading.Thread(target=self._cmd_worker_loop, daemon=True)
        self._input_thread = threading.Thread(target=self._input_loop, daemon=True)
        self._command_log = []

    def start(self) -> None:
        self._connect_mqtt()
        self._telemetry_thread.start()
        self._cmd_worker_thread.start()
        self._input_thread.start()
        self._run_forever()

    def stop(self) -> None:
        self._stop.set()
        self.running = False
        if self._mqtt is not None:
            try:
                self._mqtt.disconnect()
            except Exception:
                pass

    def _connect_mqtt(self) -> None:
        kwargs = {}
        try:
            client_id = self.args.client_id or f"sim-{self.state.device_id}-{random.randint(1000, 9999)}"
            # 兼容新旧版本 paho-mqtt
            try:
                self._mqtt = mqtt.Client(client_id=client_id, clean_session=True, **kwargs)
            except TypeError:
                from paho.mqtt.client import CallbackAPIVersion

                self._mqtt = mqtt.Client(
                    callback_api_version=CallbackAPIVersion.VERSION2,
                    client_id=client_id,
                    clean_session=True,
                    **kwargs,
                )
            self._mqtt.on_connect = self._on_connect
            self._mqtt.on_message = self._on_message
            self._mqtt.on_disconnect = self._on_disconnect
            if self.args.protocol == "mqtts":
                self._mqtt.tls_set(ca_certs=self.args.ca_path or None)
                if self.args.insecure:
                    self._mqtt.tls_insecure_set(True)
            self._mqtt.username_pw_set(self.args.username, self.args.password)
            self._mqtt.connect(self.args.broker, self.args.port, keepalive=60)
            self._mqtt.loop_start()
        except Exception as exc:
            raise RuntimeError(f"MQTT connect failed: {exc}") from exc

    def _on_connect(self, *args) -> None:
        rc = 0
        if len(args) == 4:
            _client, _userdata, _flags, rc = args
        elif len(args) >= 5:
            _client, _userdata, _flags, rc = args[0], args[1], args[2], args[3]
        else:
            print(f"[MQTT] unsupported on_connect args: {len(args)}")
            return
        if hasattr(rc, "value"):
            rc = rc.value
        if rc == 0:
            self.connected.set()
            print(f"[MQTT] connected and subscribe {self._topic_cmd}")
            self._mqtt.subscribe(self._topic_cmd, qos=0)
            self._send_status(online=True, status="online", message="simulator connected")
        else:
            print(f"[MQTT] connect failed rc={rc}")

    def _on_disconnect(self, *args) -> None:
        if len(args) >= 3:
            rc = args[2]
        else:
            rc = 0
        if hasattr(rc, "value"):
            rc = rc.value
        self.connected.clear()
        print(f"[MQTT] disconnected rc={rc}")

    def _on_message(self, _client, _userdata, msg) -> None:
        try:
            raw = msg.payload.decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                return
            self._cmd_queue.put(payload)
            self._command_log.append(("in", payload))
            if len(self._command_log) > 30:
                self._command_log = self._command_log[-30:]
            print(f"[MQTT] recv cmd: {payload}")
        except Exception as exc:
            print(f"[MQTT] message parse failed: {exc}")

    def _publish(self, topic: str, payload: Dict[str, Any]) -> bool:
        if not self._mqtt:
            return False
        if not self.connected.is_set():
            return False
        try:
            data = json.dumps(payload, ensure_ascii=False)
            self._mqtt.publish(topic, data, qos=0)
            self._command_log.append(("out", payload))
            if len(self._command_log) > 30:
                self._command_log = self._command_log[-30:]
            return True
        except Exception as exc:
            print(f"[MQTT] publish failed {topic}: {exc}")
            return False

    def _send_status(self, online: bool, status: str, message: str, cmd_id: Optional[str] = None) -> None:
        with self.state.lock:
            battery = self.state.battery
            low_power = self.state.low_power
        body = {
            "deviceId": self.state.device_id,
            "online": bool(online),
            "status": status,
            "message": message,
            "battery": battery,
            "low_power": bool(low_power),
            "ts": now_ms(),
        }
        if cmd_id:
            body["cmdId"] = cmd_id
        self._publish(self._topic_status, body)

    def _send_ack(self, ok: bool, message: str, cmd_id: Optional[str], low_power: Optional[bool] = None) -> None:
        if not cmd_id:
            return
        with self.state.lock:
            battery = self.state.battery
            lp = self.state.low_power if low_power is None else low_power
        payload = {
            "deviceId": self.state.device_id,
            "cmdId": cmd_id,
            "ok": bool(ok),
            "message": message,
            "battery": battery,
            "low_power": bool(lp),
            "ts": now_ms(),
        }
        self._publish(self._topic_ack, payload)

    def _cmd_worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                payload = self._cmd_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            cmd_id = payload.get("cmdId") or payload.get("cmd_id") or payload.get("cmd")
            if not cmd_id:
                print("[CMD] ignore cmd without cmdId")
                self._cmd_queue.task_done()
                continue

            cmd_type = str(payload.get("type", "")).lower()
            action = str(payload.get("action", "")).lower()
            value = payload.get("value")
            delay = max(0.0, float(self.args.command_delay_ms)) / 1000
            if delay > 0:
                time.sleep(delay)

            if cmd_type == "request" and action == "status":
                self._reply_cmd_status(cmd_id, value)
            elif cmd_type == "power" and action == "set":
                target = False
                if isinstance(value, dict):
                    raw_lp = value.get("low_power", value.get("lowPower", value.get("lowPowerMode")))
                    target = bool(to_bool(raw_lp))
                else:
                    target = bool(to_bool(value))
                with self.state.lock:
                    self.state.low_power = target
                self._reply_power_set(cmd_id)
            else:
                # 未知命令返回失败，便于前端快速识别
                self._send_ack(False, f"unsupported command: {cmd_type}/{action}", cmd_id)
            self._cmd_queue.task_done()

    def _reply_cmd_status(self, cmd_id: str, _value: Any = None) -> None:
        # 先更新 telemetry 信息（模拟设备端读取当前电量/低功耗）
        mode = self.reply_mode
        if mode in {"status", "both", "status+ack", "ack+status"}:
            self._send_status(
                online=True,
                status="ok",
                message="simulator request/status processed",
                cmd_id=cmd_id,
            )
            if mode in {"status"}:
                return
            time.sleep(0.1)
        if mode in {"ack", "both", "status+ack", "ack+status"}:
            self._send_ack(True, "simulator request/status ack", cmd_id)

    def _reply_power_set(self, cmd_id: str) -> None:
        mode = self.reply_mode
        if mode in {"ack", "both", "status+ack", "ack+status"}:
            self._send_ack(True, "power mode updated", cmd_id)
            if mode in {"ack"}:
                return
            time.sleep(0.1)
        if mode in {"status", "both", "status+ack", "ack+status"}:
            self._send_status(
                online=True,
                status="ok",
                message="power mode updated",
                cmd_id=cmd_id,
            )

    def _send_telemetry(self, collision: bool = False, event: Optional[str] = None) -> None:
        body = self.state.telemetry_payload(collision=collision, event=event)
        topic = f"{self._topic_telemetry}"
        if self.telemetry_topic_suffix:
            suffix = self.telemetry_topic_suffix.strip("/")
            if suffix:
                topic = f"{self._topic_telemetry}/{suffix}"
        self._publish(topic, body)

    def _send_event(self, event: str, score: Optional[float] = None, level: Optional[str] = None, in_payload: bool = False) -> None:
        with self.state.lock:
            payload = {
                "deviceId": self.state.device_id,
                "ts": now_ms(),
                "lvl": self.state.collision_level if level is None else level,
                "level": self.state.collision_level if level is None else level,
                "score": self.state.collision_score if score is None else score,
                "lng": self.state.lng,
                "lat": self.state.lat,
                "speed": self.state.speed,
                "location_source": self.state.location_source,
                "message": f"{event} detected",
            }
        topic = f"{self._topic_events}/{event}"
        self._publish(topic, payload)
        if in_payload:
            self._send_telemetry(collision=True, event=event)

    def _auto_send_telemetry_loop(self) -> None:
        while not self._stop.is_set():
            if self.auto_telemetry and self.connected.is_set():
                self._send_telemetry()
            time.sleep(self.auto_interval)

    def _handle_set(self, args: list[str]) -> None:
        if len(args) < 2:
            print("set 用法: set <field> <value>")
            return
        key = args[0]
        val = " ".join(args[1:]).strip()
        try:
            if key in {"low_power", "lowpower", "location_source", "time_offset_ms"}:
                value: Any = val
            elif key in {"collision_level"}:
                value = val
            else:
                value = float(val) if "." in val else int(val) if val.isdigit() else float(val)
            if key == "time_offset_ms":
                global TIME_OFFSET_MS
                TIME_OFFSET_MS = int(float(value))
                print(f"time_offset_ms 已设置为 {TIME_OFFSET_MS} ms")
            elif self.state.set_field(key, value):
                print(f"{key} 已设置为 {value}")
            else:
                print(f"未知字段: {key}")
        except Exception as exc:
            print(f"set 失败: {exc}")

    def _handle_send_collision(self, args: list[str], is_event: bool = False) -> None:
        score = self.state.collision_score
        level = self.state.collision_level
        if args:
            try:
                score = float(args[0])
                if len(args) >= 2:
                    level = args[1]
            except Exception:
                if args:
                    level = args[0]
        if is_event:
            self._send_event("collision", score=score, level=level, in_payload=False)
            print(f"已发送 events/collision: score={score}, level={level}")
        else:
            body = self.state.telemetry_payload(collision=True)
            body["collision_score"] = score
            body["collision_level"] = level
            body["message"] = "manual collision telemetry"
            self._publish(f"{self._topic_telemetry}/{self.telemetry_topic_suffix}" if self.telemetry_topic_suffix else self._topic_telemetry, body)
            print(f"已发送 telemetry 碰撞: score={score}, level={level}")

    def _show(self) -> None:
        s = self.state.snapshot()
        print("=== 当前状态 ===")
        print(f"deviceId: {s['deviceId']}")
        print(f"lng/lat: {s['lng']}, {s['lat']}")
        print(f"speed: {s['speed']}, heading: {s['heading']}, altitude: {s['altitude']}, accuracy: {s['accuracy']}")
        print(f"heart_rate: {s['heart_rate']}, temperature: {s['temperature']}, humidity: {s['humidity']}")
        print(f"battery: {s['battery']}%, low_power: {s['low_power']}, source: {s['location_source']}")
        print(f"collision_score: {s['collision_score']}, collision_level: {s['collision_level']}")
        print(f"auto telemetry: {'on' if self.auto_telemetry else 'off'} @ {self.auto_interval:.1f}s | topic_suffix: {self.telemetry_topic_suffix}")
        print(f"reply mode: {self.reply_mode}")

    def _help(self) -> None:
        print("""
命令列表：
  help                     查看帮助
  show                     打印当前模拟器状态
  set <字段> <值>           修改发送数据：lng/lat/speed/heading/altitude/accuracy/heart_rate/temperature/humidity/battery/low_power/location_source/collision_score/collision_level
  telemetry [collision]      发送一次 telemetry，可选参数: collision
  collision [score] [level]  手动发送 telemetry 中的碰撞数据（可选强度 score）
  collision-event [score] [level]  发送 events/collision
  sos [score] [level]       手动发送 events/sos（可选强度）
  status [online] [message]  主动发送状态，不带 cmdId
  replymode [status|ack|both|status+ack|ack+status] 设置回复模式（默认 status）
  auto [on|off]             开启/关闭定时上报 telemetry
  interval <seconds>        设置自动上报间隔
  topic <suffix>           设置 telemetry 主题后缀（如 gnss / lbs / ''）
  sendall                   发送一次 telemetry + 发送一次低功耗状态
  flush                     清空最近发送/接收命令日志
  log                       打印最近 30 条 MQ 消息收发记录
  q/quit/exit              退出
""".strip())

    def _input_loop(self) -> None:
        self._help()
        while not self._stop.is_set():
            try:
                line = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n退出中...")
                self.stop()
                return

            if not line:
                continue
            parts = line.split()
            cmd = parts[0].lower()
            args = parts[1:]

            if cmd in {"q", "quit", "exit"}:
                self.stop()
                return
            if cmd == "help":
                self._help()
            elif cmd == "show":
                self._show()
            elif cmd == "set":
                self._handle_set(args)
            elif cmd == "telemetry":
                collision = len(args) >= 1 and args[0].lower() == "collision"
                if collision and len(args) >= 2:
                    score = float(args[1])
                    self.state.set_field("collision_score", score)
                    self.state.set_field("collision_level", args[2] if len(args) >= 3 else self.state.collision_level)
                self._send_telemetry(collision=collision)
                print("已发送 telemetry")
            elif cmd == "collision":
                self._handle_send_collision(args, is_event=False)
            elif cmd == "collision-event":
                self._handle_send_collision(args, is_event=True)
            elif cmd == "sos":
                score = self.state.collision_score
                level = self.state.collision_level
                if args:
                    score = float(args[0])
                    if len(args) >= 2:
                        level = args[1]
                self._send_event("sos", score=score, level=level, in_payload=True)
                print(f"已发送 SOS 事件: score={score}, level={level}")
            elif cmd == "status":
                online = True
                message = "manual status"
                if args:
                    if args[0].lower() in {"0", "false", "off", "no"}:
                        online = False
                    if len(args) >= 2:
                        message = " ".join(args[1:])
                self._send_status(online=online, status="ok", message=message)
                print("已发送设备主动 status")
            elif cmd == "replymode":
                if args and args[0] in {"status", "ack", "both", "status+ack", "ack+status"}:
                    self.reply_mode = args[0]
                    print(f"回复模式已改为 {self.reply_mode}")
                else:
                    print("replymode 参数错误：status / ack / both / status+ack / ack+status")
            elif cmd == "auto":
                if args and args[0].lower() in {"on", "off"}:
                    self.auto_telemetry = args[0].lower() == "on"
                    print(f"auto telemetry: {'on' if self.auto_telemetry else 'off'}")
                else:
                    print("auto 参数错误：on/off")
            elif cmd == "interval":
                if not args:
                    print("interval 参数缺失")
                    continue
                self.auto_interval = max(1.0, float(args[0]))
                print(f"auto telemetry interval = {self.auto_interval:.1f}s")
            elif cmd == "topic":
                self.telemetry_topic_suffix = args[0].strip("/") if args else ""
                print(f"telemetry suffix = {self.telemetry_topic_suffix or '(none)'}")
            elif cmd == "sendall":
                self._send_telemetry()
                self._send_status(online=True, status="ok", message="manual sendall")
                print("已发送 telemetry + status")
            elif cmd == "flush":
                self._command_log = []
                print("日志已清空")
            elif cmd == "log":
                print("=== 最近MQ消息（in/out）===")
                for direction, msg in self._command_log:
                    print(direction, msg)
            else:
                print("未知命令，输入 help 查看")

    def _run_forever(self) -> None:
        print("模拟器已启动：输入 help 查看命令，按 Ctrl+C 可退出")
        try:
            while not self._stop.is_set():
                time.sleep(0.2)
        finally:
            print("退出模拟器")
            self.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Python Helmet MQTT simulator (Windows)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--broker", default=os.getenv("MQTT_BROKER", "e3133611.ala.cn-hangzhou.emqxsl.cn"))
    parser.add_argument("--port", type=int, default=int(os.getenv("MQTT_PORT", "8883")))
    parser.add_argument(
        "--protocol",
        default="mqtts",
        choices=["mqtt", "mqtts"],
        help="mqtt 或 mqtts"
    )
    parser.add_argument("--insecure", action="store_true", help="跳过 TLS 证书验证")
    parser.add_argument("--ca-path", default=os.getenv("MQTT_CA_PATH", ""))
    parser.add_argument("--username", default=os.getenv("MQTT_USERNAME", "Device"))
    parser.add_argument("--password", default=os.getenv("MQTT_PASSWORD", "mqtt"))
    parser.add_argument("--device-id", default="dev-001")
    parser.add_argument("--topic-prefix", default="v1/devices")
    parser.add_argument("--client-id", default="")
    parser.add_argument("--reply-mode", default="status", choices=["status", "ack", "both", "status+ack", "ack+status"])
    parser.add_argument("--telemetry-interval", default=2.0, type=float, help="自动上报周期（秒）")
    parser.add_argument("--no-auto-telemetry", action="store_true", help="不自动上报 telemetry")
    parser.add_argument("--telemetry-topic", default="gnss", help="telemetry 子主题名（例如 gnss/lbs）")
    parser.add_argument("--command-delay-ms", default=800, type=int, help="收到 cmd 后回包前延迟（ms）")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sim = PythonHelmetSimulator(args)
    try:
        sim.start()
    except KeyboardInterrupt:
        sim.stop()


if __name__ == "__main__":
    main()
