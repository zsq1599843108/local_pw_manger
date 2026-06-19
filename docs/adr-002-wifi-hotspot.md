# ADR-002: 抛弃 AOAP，转向 Wi-Fi 热点 + LAN 加密通道

> 作者：Claude + 用户
> 日期：2026-06-19
> 状态：**Accepted**（用户当面拍板）
> 取代：[ADR-001 选用 AOAP](adr-001-aoap.md)（标记为 Superseded）

## 上下文

v0.3 原计划用 AOAP（Android Open Accessory Protocol）让手机当物理钥匙：
- 物理 USB 线 = 物理钥匙语义最强
- 不需要开 USB 调试模式（AOAP 是 Android 系统级协议）
- WebUSB 直接走，无需自定义驱动

预算 5~6 天。M1 干了大半天，**踩到 Windows 平台的死墙**。

## 阻塞证据（M1 实测，2026-06-19）

环境：
- PC：Win11 Pro 26200，Chrome 130
- 手机：小米 14 Pro，HyperOS（基于 Android 14）
- USB 模式：文件传输（MTP）

### 测试 1：Chrome WebUSB（前端）
```
navigator.usb.requestDevice({filters: []})  → 设备框可见小米
device.open()                                → ❌ Failed to execute 'open' on 'USBDevice': Access denied.
```

### 测试 2：libusb（Node.js 后端）
```
const u = require('usb');         // usb@3.0.0
phone.open()                      → ✅ ok, 能读 manufacturerName="Xiaomi"
phone.controlTransferIn({         → ❌ controlTransferIn error: invalid state
  requestType: 'vendor',
  recipient: 'device',
  request: 51,                    // GET_PROTOCOL
  ...
})
```

### 测试 3：libusb + detachKernelDriver
```
phone.detachKernelDriver(0..3)    → 成功（但 Windows 上很可能是 no-op）
phone.controlTransferIn(...)       → ❌ 同样 invalid state
```

### 根因（[详见 troubleshooting-windows.md](troubleshooting-windows.md)）

Windows 给 Android 手机加载的 **MTP 驱动 (`wpdmtp.inf`) 不放行 vendor-class 控制传输**。
这是 MTP 设计如此（防止恶意 app 偷传文件）。无论用 Chrome WebUSB（走 WinUSB API）
还是 libusb（同样最终走 WinUSB），只要驱动是 MTP，vendor 请求就会被内核拒绝。

唯一软件层解法：用 **Zadig** 把这台手机这台 PC 的 USB 驱动从 MTP 替换成 WinUSB。
副作用：**这台手机插这台 PC 不再支持文件传输 (MTP)**，每次想传文件得卸载 WinUSB 重装 MTP。

用户的硬性要求：「**我需要这台手机可以文件传输**」，所以 Zadig 不可接受。

## 候选方案对比

| | A. USB tethering | **B. 手机 Wi-Fi 热点** | C. 同 Wi-Fi LAN |
|---|---|---|---|
| 用户操作 | 插线 + 开 USB 网络共享 | 开热点 + PC 切 Wi-Fi | 都连家里 Wi-Fi |
| Windows 驱动 | RNDIS（系统自带） | 0 配置 | 0 配置 |
| 影响 PC 网络 | 多个网卡，原 Wi-Fi 不动 | **PC 切热点期间断主 Wi-Fi** | 0 影响 |
| 物理钥匙语义 | ✅ 必须插线（强） | ⚠️ 10m 内（中） | ❌ 同小区都行（弱） |
| iOS 支持 | ✅ Personal Hotspot via USB | ✅ Personal Hotspot Wi-Fi | ✅ |
| 与 MTP 冲突 | ❌ 共存 | ❌ 共存 | ❌ 共存 |
| 流量/电量 | 极低 | 中等 | 0 |

## 决策

**选 B（手机 Wi-Fi 热点）**。

用户原话决策依据：
1. 不想配置 USB 网络共享（每次开关麻烦）
2. 接受切 Wi-Fi 期间断网（短暂可控）
3. 想保留无线场景（手机不必插线）
4. 物理钥匙语义降级到 ~10m 距离 + 公钥 TOFU 可接受

虽然 A（USB tethering）从工程角度更优，但用户的原话「**电脑连接手机热点和手机APP搭配**」明确选 B。

A 方案保留在 backlog 作为 v0.4+ 增强。

## 影响

### 协议层（M2'）
- **保留**：X25519 + HKDF-SHA256 + AES-256-GCM 算法栈，与原 AOAP 设计一致
- **变更**：传输层从 USB bulk 换为 **WebSocket over TCP**（升级自 HTTP/1.1）
- **简化**：丢弃 TLV 帧层（aoap-design.md §5），WebSocket 自带分帧

### 架构（M1')
- 手机做 server（Ktor Netty 监听 0.0.0.0:9876）
- PC 做 client（Node.js fetch / 浏览器 WebSocket）
- 手机端起前台服务，热点关闭则服务停
- PC 端通过手机网关 IP（典型 Android 热点 192.168.43.1）连

### 物理钥匙语义降级
- AOAP：物理 USB 线 = 0 距离硬连接
- Wi-Fi 热点：~10m 范围 + WPA2 密码 + 6 位 PIN 配对 + 公钥指纹 TOFU

补救：
- 首次配对必须输 PIN（防止热点被窃听后陌生设备配对成功）
- 公钥 TOFU 后所有指令必须 Bio 挑战（手机端弹 BiometricPrompt）
- 短热点超时（默认 5 分钟无 PC 心跳自动关）

### 代码影响
- ⚠️ DEPRECATED 不删（Linux/Mac 仍可用）：
  - `src/public/js/aoap.js`、`aoap-page.js`、`aoap-server.js`
  - `android/.../UsbAccessoryActivity.kt`
- 🆕 新增（M1'~M5'）：
  - `src/lan-server.js`、`src/public/js/lan-pair.js`
  - `android/.../HotspotServerService.kt`、`HotspotPairActivity.kt`
- ♻️ 沿用（M2 设计未变）：
  - 加密通道、配对状态机、设备指纹 TOFU、密码库同步

### 时间影响
- 已花：M1 半天（含 BiometricDemo、AOAP 实证、libusb 探索、文档）
- 新预算：M1' (0.5d) + M2' (1d) + M3' (1.5d) + M4' (1d) + M5' (1d) = **5 天**
- 总耗时仍在原 5~6 天预算内

## 已知风险（v0.3 范围）

| ID | 风险 | 缓解 |
|----|------|------|
| R1 | 部分手机热点会强制走运营商热点限制（Tethering Provisioning Check） | 文档说明 + 提供「开发者模式跳过」开关 |
| R2 | PC 加入手机热点后断主 Wi-Fi → 用户体验差 | UI 显式提示 + 配对完成后立刻断热点回主 Wi-Fi |
| R3 | 企业 Wi-Fi 锁定 PC 不让加入热点 | 兜底方案：USB tethering（Backlog） |
| R4 | 热点 SSID/密码每次重置（部分 ROM 行为） | 手机端持久化 SSID/密码（保存到加密 SharedPrefs） |
| R5 | 公网 IP 暴露：手机热点理论上是 NAT 内，但仍要防止配对协议被路由 | server 仅 bind `192.168.43.1`，拒绝其他 IP |

## 不在本 ADR 范围（v0.4+）

- iOS Personal Hotspot 兼容性（M5' 测一下）
- USB tethering 双路径（让用户选热点或线缆）
- WebRTC P2P / mDNS 自动发现（取代 PIN 输入）
- 多设备同时配对

## 参考

- [troubleshooting-windows.md](troubleshooting-windows.md) — AOAP Win 阻塞复盘 + Zadig 手册（虽不采用）
- [adr-001-aoap.md](adr-001-aoap.md) — 已 Superseded 的 AOAP 选型决策
- Android 热点典型默认网关 IP：[https://source.android.com/docs/core/connect/wifi-tethering](https://source.android.com/docs/core/connect/wifi-tethering)
- Ktor server 文档：[https://ktor.io/docs/server-create-a-new-project.html](https://ktor.io/docs/server-create-a-new-project.html)
