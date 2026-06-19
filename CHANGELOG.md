# Changelog

按 [Keep a Changelog](https://keepachangelog.com/) 风格。新条目加在最上面。

## [Unreleased] — v0.3-dev (Wi-Fi 热点改造，前身 AOAP 已 deprecated)

### Added (2026-06-19, M1' Wi-Fi PoC 实测通过 ✅)
- 手机端：`HotspotServerService.kt` — 前台服务跑 Ktor CIO server，监听 `0.0.0.0:9876`，路由 `GET /ping → JSON{app,ver,time,uptimeMs}`
- 手机端：`HotspotPairActivity.kt` — Start/Stop 按钮 + 实时 IPv4 列表 + 1Hz 状态轮询，跳系统 tethering 设置入口
- 手机端：Ktor 2.3.13 (CIO + content-negotiation + json) + kotlinx-serialization-json 1.6.3
- 手机端：manifest 加 INTERNET / FOREGROUND_SERVICE / FOREGROUND_SERVICE_CONNECTED_DEVICE / **CHANGE_WIFI_STATE** (API 34+ FGS gate) / POST_NOTIFICATIONS / ACCESS_NETWORK_STATE / WAKE_LOCK
- PC 端：`src/lan-server.js` — `probe(host,port)` 异步函数 + `/api/lan/probe` Express 路由（代理 fetch 绕开浏览器 mixed-content）
- PC 端：`src/public/js/lan-pair.js` — 绿色「Pair via Wi-Fi」按钮 + 错误码映射 + 性能计时
- PC 端：phone.html 加 Wi-Fi 配对入口 + host/port 输入框

### Verified (2026-06-19, 小米 14 Pro + Win11 实测)
- ✅ Ktor server 在前台服务里跑 1+ 分钟稳定
- ✅ PC 切到手机热点后通过 192.168.43.1:9876 拉到 ping/pong
- ✅ 端到端往返 < 1 秒（含 server-side proxy 跳）
- ✅ 时钟漂移可视化（PC 与手机系统时间差）

### Fixed (2026-06-19)
- API 34+ 启动 `connectedDevice` 类型前台服务报 `SecurityException`：必须搭 `CHANGE_WIFI_STATE` / `BLUETOOTH_*` 等其中一项 normal-protection 权限。已加 CHANGE_WIFI_STATE 满足 gate。

### Added (2026-06-19, M1 部分通过)
- PC 端 `src/public/js/aoap.js` — 完整 AOAP 握手实现（pairOverAoap / getProtocol / sendString / startAccessory）⚠️ DEPRECATED
- PC 端 `src/aoap-server.js` — Node 端 libusb 握手 + `/api/aoap/handshake` 路由（绕开 Chrome WebUSB 在 Win 的 access denied）⚠️ DEPRECATED
- PC 端 `src/public/js/aoap-page.js` — 浏览器配对 UI 接 server-side handshake ⚠️ DEPRECATED
- 仓库新增 `android/` 子项目：Gradle 8.14.3 + AGP 8.11.1 + Kotlin 2.0.21，含国内 Maven 镜像
- 手机端 `UsbAccessoryActivity.kt` — USB_ACCESSORY_ATTACHED handler + echo loop ⚠️ DEPRECATED
- 手机端 **`BiometricDemoActivity.kt` — 指纹认证独立 demo Activity**，BiometricPrompt 双模式（STRONG / DEVICE_CREDENTIAL fallback），实测通过
- npm 依赖：`usb@3.0.0`（libusb 绑定，prebuild 二进制无需编译）
- Android 依赖：`androidx.biometric:1.2.0-alpha05`、`androidx.appcompat:1.7.0`、`androidx.core-ktx:1.13.1`

### Verified (2026-06-19, 实测)
- ✅ 指纹 BIOMETRIC_STRONG 在小米 14 Pro 上通过
- ✅ libusb 在 Win11 能 open 小米 + 读 manufacturerName
- ❌ AOAP vendor control transfer (req=51) 报 `invalid state`，Win MTP 驱动锁死
- ❌ Chrome WebUSB 报 `Access denied`，同样原因
- 结论：**Win 上 AOAP 唯一软件层解法是 Zadig 装 WinUSB**，但代价是丢 MTP

### Decision (2026-06-19, ADR-002)
- **抛弃 AOAP**（仅 Linux/Mac 路径保留 deprecated 代码）
- **转向「手机 Wi-Fi 热点 + LAN 加密通道」**：
  - 手机做 Ktor server，PC 加入手机热点后跑 HTTP/WebSocket
  - M2 加密协议（X25519 + AES-GCM）100% 沿用，传输层从 USB bulk 换 TCP
  - 物理钥匙语义：~10m 热点范围 + 公钥指纹 TOFU + BiometricPrompt 挑战

### Documentation
- 新增 `docs/troubleshooting-windows.md` — AOAP Win 阻塞复盘 + Zadig 操作手册（虽不采用）
- AOAP 系列文档保留作历史：`aoap-design.md` / `aoap-roadmap.md` / `adr-001-aoap.md`（标 Superseded）
- **新增 `docs/adr-002-wifi-hotspot.md`** — Wi-Fi 热点路线决策
- **新增 `docs/wifi-hotspot-design.md`** — 协议+架构+加密通道
- **新增 `docs/wifi-hotspot-roadmap.md`** — M1'~M5' 拆解（5 天预算）

### Tested
- 新增 `scripts/test-utf8.js` UTF-8 round-trip 自动化测试 — 7/7 通过
  - 用例覆盖：简体/繁体中文、日文、韩文、emoji、4 字节 CJK 扩展（𠮷 U+20BB7）
- 验证：之前 PROGRESS 标记的「中文乱码 bug」实为测试假阳性
  - 根因：Windows 默认 GBK 控制台直接打印 UTF-8 字节会显示乱码
  - 实际：DB（UTF-8 BLOB）/ HTTP（charset=utf-8）/ HTML（meta UTF-8）三层全程正确

### Deprecated
- AOAP 全套代码（PC + APK + 文档）：标记 deprecated 不删，Linux/Mac 仍可走


---

## [v0.2] - 2026-06-18

### Added
- UI 全英文化（界面 + 代码注释）
- 密码库导入/导出 JSON（`/api/export`、`/api/import`）
- 密码生成器 API（`/api/generate`）
- WebUSB + ADB 手机验证器（`phone.html` + `/api/phone/token`、`/api/phone/verify`）
- 4 位一次性码兜底流程（无 USB 时可用）
- Android APK 构建链（Web 套壳）

### Changed
- 中文 UI 文案全部改为英文
- 数据库 schema 加 `category` / `created_at` / `updated_at` 字段

### Deprecated
- WebUSB + ADB 路径（v0.3 将由 AOAP 取代，现保留兜底）

---

## [v0.1] - 2026-06-16

### Added
- 项目初始化（Node.js + Express + better-sqlite3）
- 主密码设置/验证（PBKDF2 100K + SHA-512）
- 密码 CRUD（AES-256-GCM 加密）
- 基础 Web UI（中文）
- WAL 模式 SQLite 存储
