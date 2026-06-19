# Wi-Fi Hotspot 配对设计文档

> 配套决策：[ADR-002 Wi-Fi 热点](adr-002-wifi-hotspot.md)
> 配套实施路线：[wifi-hotspot-roadmap.md](wifi-hotspot-roadmap.md)
> 版本：v0.3-dev (2026-06-19)

## 1. 目标

让 Android 手机通过 **Wi-Fi 热点 + LAN 加密通道** 与 PC 端 Web 应用建立双向通信，用于：

- 主密码挑战 / 解锁（手机当作硬件 Key，**指纹挑战**）
- 密码库同步（PC ↔ 手机，全量优先）
- 一次性验证码下发（取代当前 4 位 token）

物理钥匙语义靠：手机热点 ~10m 范围 + WPA2 密码 + 首次配对 6 位 PIN + 公钥指纹 TOFU + BiometricPrompt 挑战。

## 2. 架构

```
                    用户操作: 手机开热点 + PC 切 Wi-Fi
                              加入手机热点
                                  │
┌──────────────────┐              ▼              ┌──────────────────┐
│  PC 浏览器        │       Wi-Fi (5GHz)         │  Android 手机     │
│                  │ ◄────────────────────────► │                   │
│  ┌────────────┐  │  192.168.43.x              │  ┌────────────┐   │
│  │ phone.html │  │     ↓                      │  │ PassMan    │   │
│  │  + WS      │  │  192.168.43.1:9876         │  │  APK       │   │
│  └─────┬──────┘  │     ↑                      │  └─────┬──────┘   │
└────────┼─────────┘                            └────────┼──────────┘
         │                                               │
         ▼                                               ▼
   ┌──────────────┐                                ┌────────────┐
   │ Express :3000│                                │ Ktor Netty │
   │ /api/lan/*   │                                │ :9876      │
   │ + lan-server │                                │ + Tink     │
   └──────────────┘                                └────────────┘
```

**职责划分：**

| 层 | PC 端 | 手机端 |
|----|-------|--------|
| 物理层 | OS Wi-Fi 栈 | OS Wi-Fi 栈 + Hotspot Service |
| 传输层 | WebSocket client (Node fetch / 浏览器原生 WS) | Ktor Netty server :9876 |
| 帧层 | WebSocket binary frames（自带分帧） | 同 |
| 加密层 | WebCrypto（X25519 / HKDF / AES-GCM） | Tink（同算法） |
| 应用层 | 配对状态机 + 加密通道 | 配对状态机 + 加密通道 |

## 3. Endpoints

手机端 Ktor server 暴露：

| Path | Method | Auth | 用途 |
|------|--------|------|------|
| `/ping` | GET | 无 | 探活：返回 `{"app":"passman","ver":"0.3","time":...}` |
| `/pair` | POST | PIN | 配对（提交 PIN + PC 公钥，返回手机公钥） |
| `/socket` | WS upgrade | session_key | 加密双向通道（同步、挑战、心跳） |

PC 端 Express 加：

| Path | Method | 用途 |
|------|--------|------|
| `/api/lan/probe` | POST `{ip, port}` | 服务端代理探活手机 server（绕开浏览器 mixed-content / 跨域） |
| `/api/lan/pair` | POST `{ip, port, pin}` | 服务端代理配对（保存设备指纹到 sqlite） |
| `/api/lan/devices` | GET | 列已配对设备 |
| `/api/lan/forget` | DELETE `{id}` | 解除配对 |

为什么 PC 端要走服务端代理而不是浏览器直连手机？
- 手机 Ktor server 用自签证书走 HTTPS / WSS 时，浏览器拒绝
- 浏览器跨域 fetch 需 CORS，控制权在手机端不方便
- Node 端无 CORS 限制，自签证书容易处理（自定义 ca bundle）

## 4. 配对流程（首次）

```
[手机]                                                  [PC]
  │
  │ 1. 用户开热点
  │    手机自己的 SSID="PassMan-XXXX"，密码=自动生成 16 位
  │    手机 APK 启动 HotspotServerService（前台服务）
  │    Ktor server 起在 192.168.43.1:9876
  │    APK 屏幕显示：SSID / 密码 / IP / 6 位 PIN
  │
  │
  │                                                       │
  │ 2.                                                     │ 用户在 phone.html 看到提示
  │                                                       │ 点「Pair via Wi-Fi」按钮
  │                                                       │
  │ 3. 用户根据手机屏幕，PC 端切 Wi-Fi 加入 PassMan-XXXX  │
  │    (PC 主 Wi-Fi 临时断开)                             │
  │                                                       │
  │ 4.                              POST /api/lan/probe   │
  │ ◄────────────────────────────────────────────────────┤
  │                                  body={ip:'192.168.43.1', port:9876}
  │
  │ GET /ping                                              │
  │ ◄──────────────────────────────────────────────────── │
  │ ──────────────────────────────────────────────────►  │
  │ {"app":"passman","ver":"0.3","time":1781942400}        │
  │                                                       │ phone.html 显示：探活成功
  │                                                       │ 弹输入 PIN 框
  │                                                       │
  │ 5.                              POST /api/lan/pair    │
  │ ◄────────────────────────────────────────────────────┤
  │                                  body={ip,port,pin,display_name:'PC-XX'}
  │
  │ PC 端生成 X25519 密钥对                               │
  │ POST /pair  body={pin, pc_pubkey, display_name}       │
  │ ◄──────────────────────────────────────────────────── │
  │                                                       │
  │ 6. 手机端校验 PIN：                                    │
  │    - 错 → 401 + 5 次错锁 1 分钟                        │
  │    - 对 → 生成 X25519 + 持久化 PC 公钥指纹            │
  │           ──────────────────────────────────────────► │
  │           {phone_pubkey, fingerprint}                  │
  │                                                       │
  │ 7.                                                     │ Express 把手机公钥指纹存 paired_devices
  │                                                       │ 返回 phone.html: "配对成功"
  │                                                       │
  │ 8.                                                     │ 用户切回主 Wi-Fi（手机端检测断开 → 自动停热点）
  │                                                       │
  ▼                                                       ▼
DISCONNECTED                                            DISCONNECTED
（下次连：手机开热点 → PC 切 Wi-Fi → 自动 PING → 跳过 PIN 直接 session_key 协商）
```

## 5. 加密通道（沿用 M2 设计）

**密钥协商：** X25519 ECDH。

```
session_key = HKDF-SHA256(
  ikm  = ECDH(pc_priv, phone_pub),
  salt = nonce_pc || nonce_phone,
  info = "passman-lan-v1",       // 注意：与 aoap-v1 区分，避免协议交叉
  L    = 32
)
```

**对称加密：** AES-256-GCM。

**WebSocket 帧格式：**

```
text/binary frame:
┌──────────┬──────────┬─────────────┬────────────┐
│  IV (12) │ frame_ctr│ ciphertext  │  tag (16)  │
│          │   (8)    │     (N)     │            │
└──────────┴──────────┴─────────────┴────────────┘
              GCM AAD = "PassMan-LAN-v1" || frame_ctr
```

frame_ctr 单调递增防重放（同 AOAP 设计）。

## 6. 应用层消息（沿用 M2/M3 设计）

WebSocket 帧 payload 解密后是 JSON：

```json
{ "t": "PING",                "ts": 1781942400000 }
{ "t": "PONG",                "ts": 1781942400123 }
{ "t": "CHALLENGE",           "blob": "base64..."        }
{ "t": "CHALLENGE_RESPONSE",  "blob": "base64...", "biometric_ok": true }
{ "t": "SYNC_PULL",           "since": 0                  }
{ "t": "SYNC_PUSH",           "entries": [...]            }
{ "t": "ERROR",               "code": "...", "msg": "..." }
```

`CHALLENGE` 必须由用户在手机上**通过 BiometricPrompt 验证后**才回 RESPONSE。

## 7. 状态机

```
            ┌─────────────┐
            │ DISCONNECTED│ ← (PC 主 Wi-Fi 上)
            └──────┬──────┘
                   │ 用户点「Pair via Wi-Fi」+ 切 Wi-Fi 到手机热点
                   ▼
            ┌─────────────┐
            │  PROBING    │
            └──────┬──────┘
                   │ /ping ok
                   ▼
            ┌─────────────┐
            │  CHECK_PAIR │
            └──────┬──────┘
                   │
              new? │ │ paired?
                   ▼ ▼
   ┌─────────────┐   ┌─────────────┐
   │  PAIRING    │   │ KEY_EXCHANGE│
   │ (PIN 输入) │──►│              │
   └─────────────┘   └──────┬───────┘
                            │ session_key 协商
                            ▼
                     ┌─────────────┐
                     │   ACTIVE    │ ◄── sync / challenge / heartbeat
                     └──────┬──────┘
                            │ ws closed / 切回主 Wi-Fi / 5min idle
                            ▼
                     ┌─────────────┐
                     │ DISCONNECTED│
                     └─────────────┘
```

## 8. 持久化

**PC 端 sqlite 新表（M3' 加 migration）：**

```sql
CREATE TABLE paired_devices (
  id            INTEGER PRIMARY KEY,
  phone_pubkey  BLOB    NOT NULL,         -- 32B X25519 pubkey
  fingerprint   TEXT    NOT NULL UNIQUE,  -- SHA256(pubkey) hex 16 位
  display_name  TEXT,                     -- 用户取的名字 ("我的小米14")
  ssid          TEXT,                     -- 上次成功配对的热点 SSID
  paired_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sync_at  DATETIME,
  revoked       INTEGER DEFAULT 0
);
```

**手机端持久化（EncryptedSharedPreferences）：**

```
peer.{fingerprint}.pubkey       -> 32B X25519 pubkey
peer.{fingerprint}.display_name -> "DESKTOP-XXX"
peer.{fingerprint}.first_seen   -> timestamp
peer.{fingerprint}.last_seen    -> timestamp
self.private_key                -> 32B (Tink AEAD primitive 包装)
self.hotspot_ssid_seed          -> 用于稳定 SSID 不每次变（部分 ROM 强制变）
```

## 9. 安全模型

| 威胁 | 缓解 |
|------|------|
| 攻击者在 10m 内监听热点流量 | WPA2 + AES-GCM 端到端，明文不出端 |
| 攻击者在 10m 内尝试加入热点 | 16 位随机 WPA2 密码 + 5 次错 PIN 锁 1 分钟 |
| 攻击者已知 PIN 但热点已断 | 即使 PIN 对，session_key 协商需 ECDH，攻击者无 PC 私钥 |
| 公钥指纹冲突（碰撞攻击） | SHA256 16 进制 16 位 = 64 bit，足够防 birthday |
| 重放：录帧重发 | frame_ctr 单调递增 + GCM AAD 包含计数器 |
| 中间人替换手机 APK | 首次配对人眼确认手机屏显的 PC display_name |
| 手机被偷 | 已配对仍需指纹解锁 + PIN 二次确认（高敏操作） |
| PC 被恶意 web 调用 LAN 端口 | localhost-only Express + 同源 + LAN IP 仅限 192.168.43.0/24 |

## 10. 已知限制

- **PC 切 Wi-Fi 期间断主网**：用户体验差，需 UI 强提示
- **部分 ROM 强制热点 SSID 每次变**（华为某些版本）：手机端容忍 SSID 变化，凭公钥指纹认设备
- **企业 Wi-Fi 锁定**：PC 在公司无法切热点 → 兜底走 USB tethering（v0.4+）
- **iOS Personal Hotspot 兼容性**：M5' 测，可能默认网关 IP 不同（172.20.10.1）

## 11. 性能预估

- 单条密码记录约 200~500 B（已加密）
- Wi-Fi 5GHz 实测吞吐 50~200 Mbps（同热点直连）
- 1000 条密码全量同步预估 < 0.5 秒
- 配对延迟典型 1~3 秒（含 PIN 输入）
- ping/pong 往返 < 30ms

## 12. 与 M2~M5（原 AOAP roadmap）的映射

| 原 milestone | 新 milestone | 沿用 | 变更 |
|--------------|---------------|------|------|
| M1 (USB 握手) | M1' (热点 PoC) | — | 全替换 |
| M2 (帧+ECDH) | M2' (加密通道) | ECDH/HKDF/AES-GCM 算法 | TLV 帧 → WebSocket 帧 |
| M3 (配对+同步) | M3' (配对+同步) | 状态机、`paired_devices` 表、CHALLENGE 流程 | 加 PIN + 弃 USB 重连逻辑 |
| M4 (UI+持久化) | M4' (UI+持久化) | 全部沿用 | UI 加「切 Wi-Fi 提示」 |
| M5 (加固+测试) | M5' (加固+测试) | 全部沿用 | iOS 测、企业 Wi-Fi 兜底 |
