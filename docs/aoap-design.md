# AOAP 设计文档

> 本地密码管理器 — 手机 USB 配对方案
> 版本：v0.3-dev (2026-06-18)

## 1. 目标

在**不开启 USB 调试模式**的前提下，让 Android 手机通过物理 USB 线与 PC 端 Web 应用建立加密双向通道，用于：

- 主密码挑战 / 解锁（手机当作硬件 Key）
- 密码库增量同步（PC ↔ 手机）
- 一次性验证码下发（取代当前 4 位 token）

## 2. 协议选型：AOAP

**Android Open Accessory Protocol** v2.0（Google 官方，自 Android 3.1+ 内置）。

特点：
- ✅ 不需要 USB 调试 / root / 任何驱动
- ✅ 系统级权限对话框，一次授权可记忆
- ✅ Chrome WebUSB 可直接通信（VID/PID 已知）
- ✅ 标准 USB Bulk 端点，吞吐 USB 2.0 全速 (~30 MB/s)
- ❌ 仅 Android（iOS 不支持，需另做方案）

参考资料：
- https://source.android.com/docs/core/interaction/accessories/aoa2
- https://developer.android.com/guide/topics/connectivity/usb/accessory

## 3. 架构

```
┌─────────────────────┐                     ┌─────────────────────┐
│  PC 浏览器           │   USB Cable         │  Android 手机        │
│                     │ ◄─────────────────► │                     │
│  ┌───────────────┐  │                     │  ┌───────────────┐  │
│  │ phone.html    │  │                     │  │ PassMan APK   │  │
│  │  + WebUSB     │  │                     │  │  + Accessory  │  │
│  │  + AOAP layer │  │                     │  │    Service    │  │
│  └───────┬───────┘  │                     │  └───────┬───────┘  │
└──────────┼──────────┘                     └──────────┼──────────┘
           │                                            │
           ▼                                            ▼
   ┌────────────────┐                         ┌────────────────┐
   │ Express :3000  │                         │ SharedPrefs +  │
   │ /api/phone/*   │                         │  encrypted DB  │
   └────────────────┘                         └────────────────┘
```

**职责划分：**

| 层 | PC 端 | 手机端 |
|----|-------|--------|
| 物理层 | WebUSB API | UsbAccessory API |
| 协议层 | AOAP 控制传输 + bulk in/out | AOAP 系统服务（透明） |
| 帧层 | TLV 帧编解码 | TLV 帧编解码 |
| 应用层 | 配对状态机 + 加密通道 | 配对状态机 + 加密通道 |

## 4. AOAP 握手流程

```
PC                                                Phone
│                                                  │
│ 1. WebUSB 发现 Android 设备 (任意 VID/PID)       │
│─────────────────────────────────────────────────►│
│                                                  │
│ 2. Control Transfer: GET_PROTOCOL (req=51)       │
│─────────────────────────────────────────────────►│
│ ◄────────────── version (≥1) ────────────────────│
│                                                  │
│ 3. SEND_STRING × 6 (req=52)                      │
│    manufacturer / modelName / description /      │
│    version / URI / serialNumber                  │
│─────────────────────────────────────────────────►│
│                                                  │
│ 4. START_ACCESSORY (req=53)                      │
│─────────────────────────────────────────────────►│
│                                                  │
│ 5. 手机重新枚举 → VID=0x18D1, PID=0x2D00         │
│ ◄─────────────── 系统弹"打开 PassMan?" ──────────│
│                                                  │
│ 6. 用户确认 → APK 启动 → 占用 accessory          │
│                                                  │
│ 7. WebUSB 重新 claim → bulk endpoints (in/out)   │
│ ◄═══════════════ 双向 bulk 通信 ════════════════►│
│                                                  │
```

**关键 USB 控制请求：**

| bRequest | 名称 | 方向 | wValue | 数据 |
|----------|------|------|--------|------|
| 51 | GET_PROTOCOL | IN | 0 | uint16 version |
| 52 | SEND_STRING | OUT | 0 | string_id (0..5) + UTF-8 |
| 53 | START | OUT | 0 | 无 |
| 58 | REGISTER_HID | OUT | id | (本项目不用) |

**握手前 VID/PID（典型）：** 厂商各异（小米 0x2717, 华为 0x12D1, 三星 0x04E8…）
**握手后 VID/PID：** 固定 `0x18D1:0x2D00`（仅配件）或 `0x2D01`（配件+ADB，本项目用 0x2D00）

## 5. 帧格式（AOAP 之上的应用协议）

bulk 通道是字节流，自定义 TLV 帧分包：

```
┌─────────┬─────────┬─────────────┬───────────┐
│ Magic   │ Type    │ Length (LE) │ Payload   │
│ 2 bytes │ 1 byte  │ 4 bytes     │ N bytes   │
│ "PM"    │ 0x01..  │ uint32      │           │
└─────────┴─────────┴─────────────┴───────────┘
最大帧 16 MB（远超单条密码记录）
```

**Type 定义：**

| Type | 名称 | 方向 | Payload |
|------|------|------|---------|
| `0x01` | HELLO | PC→Phone | proto_version + nonce_pc (32B) |
| `0x02` | HELLO_ACK | Phone→PC | proto_version + nonce_phone (32B) + phone_pubkey (32B) |
| `0x10` | PAIR_REQUEST | PC→Phone | pc_pubkey (32B) + display_name |
| `0x11` | PAIR_CONFIRM | Phone→PC | accept (1B) + signed_session_id (64B) |
| `0x20` | CHALLENGE | PC→Phone | encrypted(challenge_blob) |
| `0x21` | CHALLENGE_RESPONSE | Phone→PC | encrypted(answer_blob) |
| `0x30` | SYNC_PULL | PC→Phone | last_sync_ts |
| `0x31` | SYNC_PUSH | both | encrypted(entries[]) |
| `0xF0` | PING | both | 8B timestamp |
| `0xF1` | PONG | both | 8B timestamp |
| `0xFE` | ERROR | both | code + msg |

## 6. 加密通道

**密钥协商：** X25519 ECDH（PC 端 WebCrypto / 手机端 Tink 或 AndroidKeyStore）。

```
session_key = HKDF-SHA256(
  ikm  = ECDH(pc_priv, phone_pub),
  salt = nonce_pc || nonce_phone,
  info = "passman-aoap-v1",
  L    = 32
)
```

**对称加密：** AES-256-GCM（与现有 `crypto.js` 对齐）。
**重放保护：** 每帧 GCM IV = `frame_counter (8B) || random (4B)`。
**配对持久化：** 首次配对成功后，手机端把 PC 公钥指纹存入 SharedPrefs，下次连线只校验指纹无需用户再确认。

## 7. 配对状态机

```
            ┌─────────────┐
            │ DISCONNECTED│
            └──────┬──────┘
                   │ USB plug
                   ▼
            ┌─────────────┐
            │ ENUMERATING │
            └──────┬──────┘
                   │ AOAP handshake ok
                   ▼
            ┌─────────────┐
            │  HELLO_X    │
            └──────┬──────┘
              new? │ │ paired before
                   ▼ ▼
   ┌─────────────┐   ┌─────────────┐
   │  PAIRING    │   │ AUTHENTICATED│
   │ (user 确认) │──►│              │
   └─────────────┘   └──────┬───────┘
                            │ master pwd ok
                            ▼
                     ┌─────────────┐
                     │   ACTIVE    │ ◄── sync / challenge
                     └──────┬──────┘
                            │ unplug / timeout
                            ▼
                     ┌─────────────┐
                     │ DISCONNECTED│
                     └─────────────┘
```

## 8. 与现有代码的整合点

**PC 端（`src/`）：**
- `public/phone.html`：替换现有 ADB 逻辑为 AOAP；新增 `aoap.js`、`frame.js`、`pair.js`
- `server.js`：保留 `/api/phone/token` 作为兜底（无 USB 时退回 4 位码）
- 新增 `/api/phone/pair` 持久化已配对设备指纹

**手机端（新仓库 `android/` 子目录）：**
- 复用现有 APK 项目（CHANGELOG 里 6-18 已构建）
- 新增 `UsbAccessoryService` (前台服务)
- 新增 `Pairing` / `Sync` Activity
- AndroidManifest 加：

```xml
<intent-filter>
  <action android:name="android.hardware.usb.action.USB_ACCESSORY_ATTACHED" />
</intent-filter>
<meta-data
  android:name="android.hardware.usb.action.USB_ACCESSORY_ATTACHED"
  android:resource="@xml/accessory_filter" />
```

`accessory_filter.xml` 必须匹配 PC 端 SEND_STRING 发的 manufacturer / model：

```xml
<usb-accessory manufacturer="PassMan" model="LocalPwdMgr" version="1.0" />
```

## 9. 安全模型

| 威胁 | 缓解 |
|------|------|
| USB 嗅探物理线 | 全程 AES-GCM，明文不出端 |
| PC 被恶意 Web 调用 WebUSB | 浏览器同源 + 用户授权弹窗 |
| 手机 APK 被替换 | 首次配对需用户人眼确认指纹 |
| 重放攻击 | 帧计数器 + GCM nonce 单调递增 |
| 中间人（USB Hub 注入） | ECDH + 公钥指纹 TOFU |
| 手机丢失 | 已配对仍需输入主密码才能 sync |

## 10. 已知限制

- iOS 完全不支持 AOAP — iPhone 用户后续走另一套（MFi / 蓝牙 / 二维码）
- 部分国产 ROM 把 USB 默认设为「仅充电」，需用户切到「文件传输」或「USB 配件」
- WebUSB 在 Chrome/Edge 可用，Firefox 不支持
- 一次只能一台手机连一台 PC（AOAP 协议限制）

## 11. 性能预估

- 单条密码记录约 200-500 B（已加密）
- AOAP bulk 实测吞吐 5-20 MB/s（视手机芯片）
- 1000 条密码全量同步预估 < 1 秒
- 握手延迟典型 200-500 ms（含用户点确认）
