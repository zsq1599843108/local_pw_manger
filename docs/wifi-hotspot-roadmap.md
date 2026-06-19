# Wi-Fi Hotspot 实施路线图

> 配套设计：[wifi-hotspot-design.md](wifi-hotspot-design.md)
> 配套决策：[adr-002-wifi-hotspot.md](adr-002-wifi-hotspot.md)
> 启动日期：2026-06-19（M1 AOAP 路线 deprecated 后转向）

## 总览

5 个里程碑，预估 5 个开发日（与 AOAP 原预算同）。

```
M1' PoC          M2' 协议层     M3' 应用层     M4' UI+持久化   M5' 加固
ping/pong  ──►  加密通道  ──►  配对+同步  ──►   全 UI       ──►  iOS+测试
0.5d           1d             1.5d           1d             1d
```

## M1' — PoC：ping/pong 跑通（0.5 天）

**目标：** 用户开手机热点 → PC 切 Wi-Fi 加入 → 浏览器一键调到 `/api/lan/probe` → Express 拉手机 Ktor `/ping` 拿到 200。

### 手机端
- [ ] `app/build.gradle.kts` 加：
  - `io.ktor:ktor-server-netty:2.3.13`
  - `io.ktor:ktor-server-content-negotiation:2.3.13`
  - `io.ktor:ktor-serialization-kotlinx-json:2.3.13`
- [ ] AndroidManifest 加权限：
  - `<uses-permission android:name="android.permission.INTERNET" />`（Ktor 监听需要）
  - `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`
  - `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`（API 33+）
  - `<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />`
- [ ] 新建 `HotspotServerService.kt`：前台服务，启动 Ktor :9876，路由 `GET /ping → JSON`
- [ ] 新建 `HotspotPairActivity.kt`：UI 包含
  - 手机当前 Wi-Fi 接口 IP 显示（`NetworkInterface.getNetworkInterfaces()` 过滤 `wlan0` / `ap0`）
  - 「启动 server」/「停止 server」按钮
  - 显示 server 当前状态（启动中/已启动/已停止/错误）
  - 启动后显示推荐的 SSID 名（用户去系统设置自己开热点）
- [ ] 注意：Android 8.0+ 起 **禁止 app 直接开热点**，必须由用户在系统设置里开。本 PoC 仅启动 Ktor server，由用户手动开热点。

### PC 端
- [ ] `src/lan-server.js`：导出 `probe(ip, port)` 异步函数（Node fetch + 1.5s timeout）
- [ ] `src/server.js` 加路由 `POST /api/lan/probe`：body `{ip, port}` → 调 `lan-server.probe()` → 返回 `{ok, app, ver, time}` 或 `{ok:false, error}`
- [ ] `src/public/phone.html` 加「Pair via Wi-Fi」按钮 + IP/Port 输入框（默认 `192.168.43.1` / `9876`）
- [ ] `src/public/js/lan-pair.js`：
  - 点按钮 → fetch `/api/lan/probe`
  - 显示 server 端返回的 app/ver/time
  - 失败时显示典型错误码（连接超时/拒绝/手机端未启动）

### 验收标准
- 手机端跑 APK，开热点，启动 server → 状态显示「listening on 192.168.43.1:9876」
- PC 切 Wi-Fi 加入手机热点
- 浏览器点按钮 → 1 秒内显示 `pong: passman v0.3 t=...`
- 拔/重启 server / PC 切回主 Wi-Fi → 错误兜底信息正确

### 风险点
- ⚠️ **Android 系统设置开热点 ≠ Wi-Fi adapter 同时连别的 Wi-Fi**：手机自己开热点会断自己的家用 Wi-Fi。这本来就是热点的设计。手机端同步流量走热点本身的 NAT。
- ⚠️ Ktor server 在前台服务里跑，必须有持久通知，否则系统在 Doze 下杀掉
- ⚠️ 部分 ROM（小米/华为）的「智能 5G」功能会限制 PC 加入手机热点的设备数（默认 8 台）

---

## M2' — 协议层：加密通道（1 天）

**目标：** 在裸 HTTP 上加 WebSocket，跑过 PING/PONG 加密往返。

### 手机端
- [ ] `app/build.gradle.kts` 加：
  - `io.ktor:ktor-server-websockets:2.3.13`
  - `com.google.crypto.tink:tink-android:1.13.0` （X25519 + HKDF）
- [ ] 新建 `Crypto.kt`：
  - `generateKeypair()` — Tink X25519
  - `deriveSessionKey(privKey, peerPub, noncePc, noncePhone)` — HKDF-SHA256
  - `seal(data, sessionKey, frameCtr)` / `open(...)` — AES-GCM
- [ ] `HotspotServerService.kt` 加路由 `WEBSOCKET /socket`
- [ ] WebSocket onConnection：协商完 session_key → 启动 PING 心跳（30s）

### PC 端
- [ ] `src/public/js/secure.js`（沿用原 M2 设计）：
  - `generateKeypair()` — WebCrypto subtle
  - `deriveSessionKey(...)` — HKDF
  - `seal/open` — AES-GCM
  - frame_ctr 单调递增防重放
- [ ] `src/lan-server.js` 加 WebSocket client 包装（Node `ws` 包，可能要 npm install）
- [ ] 浏览器端可选直连 `wss://`（M2' 跳过，M5' 再考虑自签证书）

### 验收标准
- 手机 + PC 协商 session_key 成功
- PC 发 PING，手机回 PONG，双向加密往返延迟 < 50ms
- 故意发坏密文 → 双方丢包并恢复
- 杀掉 server / 拔 Wi-Fi → 双方 5 秒内重置状态机

### 风险点
- WebSocket Java 端 / WebCrypto JS 端 X25519 不一定原生支持 → 准备 P-256 ECDH 兜底
- npm `ws` 包安装走 `/install-deps`

---

## M3' — 应用层：配对 + 同步（1.5 天）

### 配对（首次）
- [ ] 手机端 `HotspotPairActivity.kt` 显示 6 位 PIN（每次重新生成）
- [ ] PC 端 phone.html 加输入 PIN 框
- [ ] `POST /pair` 路由：手机端校验 PIN（5 次错锁 1 分钟）
- [ ] 配对成功：互换公钥 + 显示双方指纹后 8 位
- [ ] 用户在两端都「确认指纹一致」即建立配对

### 持久化
- [ ] PC 端 sqlite 加 `paired_devices` 表 + migration（详见 design §8）
- [ ] 手机端 `EncryptedSharedPreferences` 存 PC 公钥指纹
- [ ] APK 加依赖 `androidx.security:security-crypto:1.1.0-alpha06`

### 主密码挑战（用上 BiometricPrompt）
- [ ] 复用 M1 跑通的 `BiometricDemoActivity` 的 BiometricPrompt 调用模式
- [ ] CHALLENGE 帧到达 → 弹指纹框 → 通过后才解 challenge → 加密回 RESPONSE
- [ ] 失败：手机端拒绝，PC 端回 4 位码兜底（v0.2 路径）

### 密码库同步
- [ ] PC `/api/sync/snapshot` 端点返回完整加密密码列表
- [ ] SYNC_PULL → 手机请求，PC 回完整 dump
- [ ] SYNC_PUSH → 手机本地新增 → PC 接收落 sqlite
- [ ] 冲突策略：updated_at 较新者赢

### 验收标准
- 首次配对：用户点 1 次「信任」即建立
- 二次连接：自动认证 → 进入 ACTIVE 状态 < 3 秒
- 1000 条记录全量同步 < 1 秒
- 指纹挑战失败兜底回 4 位码

### 风险点
- 双向 sync 时同条目两端都改 → 暂用 last-write-wins，标记到 backlog 上 CRDT
- 手机端 sqlite 与 PC schema 演进可能不一致 → 写 schema 版本号

---

## M4' — UI + 集成（1 天）

### PC 端
- [ ] `phone.html` 重做布局：
  - 顶部状态条：DISCONNECTED / PROBING / PAIRING / ACTIVE
  - 主区：当前页面（介绍 / 输 PIN / 已配对设备列表 / 同步进度）
  - 底部 hint：「请先在手机上开热点 + 启动 PassMan server」
- [ ] 切 Wi-Fi 显式提示：弹一个 modal「即将断开主 Wi-Fi 加入手机热点，确认？」
- [ ] 配对完成后弹「请切回主 Wi-Fi」提示
- [ ] 已配对设备列表：图标 + 名称 + 上次同步时间 + 解除按钮

### 手机端
- [ ] `HotspotPairActivity` 重做：
  - server 状态卡片
  - 已信任 PC 列表
  - 二次确认弹窗（防被 silent 配对）
- [ ] 前台服务通知：「USB 配件已连接 — PassMan」改为「PassMan 同步通道运行中（点击进入）」

---

## M5' — 加固 + 测试（1 天）

### 异常处理
- [ ] WS 关闭 → 双方 5 秒内进入 DISCONNECTED
- [ ] 加密协商失败 → 回 PROBING 重试 1 次
- [ ] 手机端 server 异常崩溃 → 前台服务自动重启
- [ ] PC 端 fetch 超时（手机突然关热点） → UI 显式提示

### 兼容性测试
- [ ] Win11 + Chrome 130
- [ ] Win11 + Edge 130
- [ ] macOS + Safari（Wi-Fi 切换体验测）
- [ ] 手机至少 3 台：小米、三星、其他国产
- [ ] **iOS Personal Hotspot 配对**（用户的 iPhone 临时借测）

### 安全审计自查
- [ ] 主密码哈希永不过 LAN 明文
- [ ] session_key 仅留内存，断 ws 即销毁
- [ ] 重放攻击模拟：录 ws 帧重发 → 必须被丢弃
- [ ] PIN 暴力破解：5 次错锁 1 分钟（实测）
- [ ] PC 端 server bind localhost-only（不可远程攻击）

### 文档
- [ ] `README.md` 加 Wi-Fi 配对使用章节
- [ ] `docs/troubleshooting.md` 列各品牌手机已知坑（合并 troubleshooting-windows.md）
- [ ] CHANGELOG 写 v0.3 完整 release notes
- [ ] `MEMORY.md` 文件地图终态化（删 deprecated 旁注，标 production-ready）

---

## 风险登记

| ID | 风险 | 影响 | 缓解 | 状态 |
|----|------|------|------|------|
| R1 | 部分手机热点会强制走运营商 Tethering Provisioning Check | 配对失败 | 文档说明 + 提供「关 Provisioning Check」开关 | 待 M5' 测 |
| R2 | PC 切热点期间断主网 | 用户体验差 | UI 强提示 + 短热点超时（5 分钟） | 接受 |
| R3 | 企业 Wi-Fi 锁定 PC | 部分用户不可用 | 兜底 USB tethering（v0.4+） | 接受 |
| R4 | iOS Personal Hotspot IP 段不同（172.20.10.x） | 默认 IP 探测失败 | 多 IP 试探 + UI 让用户输 | 待 M5' 测 |
| R5 | 部分 ROM 强制热点 SSID 每次变 | 自动重连失败 | 凭公钥指纹认设备，不依赖 SSID | 接受 |
| R6 | Ktor server 在 Doze 下被杀 | server 突然 down | 前台服务 + WAKE_LOCK | 待 M1' 实测 |

## 依赖

**新增 PC 端依赖：**
- `ws@8.x`（Node WebSocket client，M2' 加，走 npmmirror）

**新增手机端依赖（M1'）：**
- `io.ktor:ktor-server-netty:2.3.13` (~3MB)
- `io.ktor:ktor-server-content-negotiation:2.3.13`
- `io.ktor:ktor-serialization-kotlinx-json:2.3.13`

**新增手机端依赖（M2' 起）：**
- `io.ktor:ktor-server-websockets:2.3.13`
- `com.google.crypto.tink:tink-android:1.13.0` (~1MB)
- `androidx.security:security-crypto:1.1.0-alpha06`

**所有 npm/maven 依赖安装走 `/install-deps` 流程。**

## 里程碑提交策略

每个 M' 完成提交一次：
- M1' → `feat(lan): hotspot ping/pong PoC`
- M2' → `feat(lan): encrypted channel (X25519+AES-GCM)`
- M3' → `feat(lan): pairing + sync + biometric challenge`
- M4' → `feat(lan): UI + persistence`
- M5' → `chore(lan): hardening + iOS + docs`

每次提交前更新 `PROGRESS.md` + `CHANGELOG.md` Unreleased 段。

## 回滚预案

如果某个 M' 卡住超 2 倍预估时间：
1. M1' 卡住 → 退回到 v0.2 + 4 位码 token 路径，关闭 v0.3 整个分支
2. M2' 卡住 → 简化协议，去掉 ECDH 改 PIN 派生 PSK（HKDF(PIN, salt)）
3. M3' 卡住 → 砍指纹挑战，仅做 PIN 一次性验证
4. M4'/M5' 卡住 → 砍 UI 美化，发 v0.3-beta 收反馈

## 完成定义 (DoD)

v0.3 发布需满足：
- ✅ 3 台不同品牌手机能成功配对+同步
- ✅ 首次配对 ≤ 5 步用户操作（含切 Wi-Fi）
- ✅ 二次连接全程自动 ≤ 5 秒（不含切 Wi-Fi）
- ✅ 拔线/异常不丢数据
- ✅ APK 体积增量 ≤ 6 MB（Ktor + Tink + biometric）
- ✅ 文档完整（README + troubleshooting + 本路线图归档为「已完成」）
- ✅ 至少在小米 14 Pro 上端到端跑通
