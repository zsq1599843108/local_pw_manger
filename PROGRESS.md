# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-22（M2' 加密通道 commit + push ✅，开始 M3'-A 配对协议）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~70%
- M2' 进度：**✅ 完成**（X25519 + HKDF + AES-GCM 通道，4/4 离线 e2e 通过；待小米 14 Pro 现场联调）
- 下个里程碑：**M3'-A**（配对 PIN + 指纹 TOFU + paired_devices 持久化，~2.5h）

## 📍 上次离开时停在哪

- **里程碑**：M2' 离线 e2e 全通过 — ECDH 握手 / 加密 PING-PONG / GCM tamper 拒收 / replay 拒收
- **代码状态**：
  - PC：`src/public/js/secure.js`（浏览器 WebCrypto）+ `src/lan-ws-client.js`（Node 哑字节桥）+ `/api/lan/socket` 路由
  - APK：`Crypto.kt`（Tink 镜像）+ `HotspotServerService` 加 Ktor `/socket` 路由 + 握手 FSM
  - UI：`lan-pair.js` probe 成功后自动跑握手 + 加密 PING
  - 测试：`scripts/test-m2-encrypted-channel.js`（mock-phone + 真 bridge）
- **测试状态**：
  - ✅ 4/4 离线 e2e 通过（Node 24 + WebCrypto subtle shim）
  - ⏳ 小米 14 Pro 现场联调待做
- **git 状态**：
  - `feature/m2-encrypted-channel` 已 push（commit 55a6c45），等 reviewer
  - 已切 `feature/m3-pairing-sync` 开 M3'-A

## ⏭️ 下次回来要做的

**M3'-A — 配对协议（~2.5 小时，detail 见 `docs/wifi-hotspot-roadmap.md` §M3'）**

子任务：
1. DB schema：`paired_devices` 表 + migration
2. `secure.js` / `Crypto.kt` 加 `fingerprintHex(pubBytes)`
3. **PIN 设计调整（2026-06-22 决策）**：手机端 TOTP-style 滚动 PIN（6 位，30s 窗口 + 实时倒计时），PC 输入
4. 加密通道之上加消息层：`PAIR_REQUEST { pin }` / `PAIR_OK { peer_fingerprint, peer_label }` / `PAIR_REJECT { reason }`
5. APK 持久化：`androidx.security:security-crypto` + `TrustStore.kt`（`EncryptedSharedPreferences`）
6. 测试：`scripts/test-m3a-pairing.js`（PIN 正/错/锁/过期）+ DB 单测

## 🚧 阻塞 / 待解决

- [x] 确定技术栈（Node.js + Express + SQLite）
- [x] 选定手机配对协议（**AOAP**，2026-06-18）→ ❌ Win 上不可行
- [x] **新协议选定（Wi-Fi hotspot，2026-06-19）**
- [ ] 准备 iPhone 测兼容性（v0.4+ 范畴）

## 📌 决策记录

- 2026-06-16: 项目初始化
- 2026-06-18: v0.2 全部 UI 和代码改为英文，添加导入导出，实现 WebUSB + ADB 手机验证器
- 2026-06-18: 决策切 AOAP（ADR-001）
- 2026-06-19: **M1 部分通过：指纹 demo OK，AOAP 在 Win 死路一条**
  - libusb / Chrome WebUSB 都被 Win MTP 驱动锁 vendor 控制传输
  - 用户拒绝 Zadig（会丢 MTP 文件传输）
- 2026-06-19: **决策切 Wi-Fi 热点（ADR-002）**
  - 用户选 B 路线（手机做热点，PC 加入热点）
  - 复用 M2 加密协议设计，传输层从 USB bulk 换 TCP/HTTP
  - AOAP 代码全部 deprecated 不删，Linux/Mac 仍可走
- 2026-06-19: **M1' Wi-Fi PoC 实测通过**
  - APK 用 Ktor CIO 起 server :9876，PC 通过 `/api/lan/probe` 代理拉 `/ping`
  - 关键坑：API 34+ FGS connectedDevice 需 CHANGE_WIFI_STATE 兜底权限
  - ping/pong 跨 Wi-Fi 热点 LAN 往返 ~50ms，AOAP 死路彻底绕开
- 2026-06-22: **M2' 加密通道离线 e2e 通过**（commit 55a6c45, branch `feature/m2-encrypted-channel`）
  - 算法栈：X25519 ECDH → HKDF-SHA256 → AES-256-GCM，PC/APK 字节兼容
  - Node 哑字节桥 `src/lan-ws-client.js`：不持有密钥，仅转发 ws 帧
  - 测试：mock-phone + 真桥 + 真 secure.js，4/4 通过（含 GCM tamper 拒收 + replay 拒收）
- 2026-06-22: **M3'-A PIN 设计调整**：手机端**滚动 PIN**（6 位，30s 窗口，TOTP 风格 HKDF），PC 输入
  - 静态 PIN 攻击窗口无限；滚动 PIN 把暴力窗口压到 30s，配合 5 次/min 锁定足够
  - 协议帧带 `t` 字段（PIN 派生轮次时间戳）防时钟漂移导致 false reject

## 🔗 关键文档跳转

- AOAP 设计（已 deprecated 留作历史）→ `docs/aoap-design.md`
- AOAP 路线图（已 deprecated）→ `docs/aoap-roadmap.md`
- ADR-001 AOAP 选型（已 Superseded）→ `docs/adr-001-aoap.md`
- **Win AOAP 阻塞复盘** → `docs/troubleshooting-windows.md`
- **现行决策** → `docs/adr-002-wifi-hotspot.md` ✅
- **现行设计** → `docs/wifi-hotspot-design.md` ✅
- **现行路线图** → `docs/wifi-hotspot-roadmap.md` ✅
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`
