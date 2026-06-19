# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-19（M1' Wi-Fi PoC 实测通过 ✅）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~50%
- M1' 进度：**✅ 完成**（小米 14 Pro + Win11 实测 ping/pong 跑通）
- 下个里程碑：**M2'**（加密通道，~1 天）

## 📍 上次离开时停在哪

- **里程碑**：M1' 实测通过 — Win11 Chrome 通过 PC server-side proxy 拉手机 Ktor `/ping` 1 秒内回 pong
- **代码状态**：
  - APK：`HotspotServerService` (Ktor CIO :9876) + `HotspotPairActivity` (UI/状态/IP 列表)
  - PC：`src/lan-server.js` (probe + 错误码) + `/api/lan/probe` 路由 + `lan-pair.js` (浏览器按钮)
  - 关键 fix：API 34+ 必须加 `CHANGE_WIFI_STATE` 才能启 `connectedDevice` 前台服务
- **测试状态**：
  - ✅ phone server 启停稳定
  - ✅ PC 切 Wi-Fi 加入手机热点后 probe 通
  - ✅ pong 含 app/ver/time/uptime，PC 端时钟漂移可视
- **git working tree**：M1' 完成代码 + 文档同步待 commit

## ⏭️ 下次回来要做的

**M2' — 加密通道（~1 天，详见 `docs/wifi-hotspot-roadmap.md` §M2'）**

实施前必做：
- [ ] 跑 `/install-deps` 询问 npm `ws` 包安装方式
- [ ] 跑 `/install-deps` 询问手机端 Tink 依赖安装方式
- [ ] 决定：WebSocket 路由是否用 wss（自签证书）还是先 ws 裸跑（安全靠 AES-GCM 不靠 TLS）

代码大致：
1. APK：加 `io.ktor:ktor-server-websockets` + `tink-android` 依赖
2. APK：`Crypto.kt` (X25519 + HKDF + AES-GCM) + `HotspotServerService` 加 `WEBSOCKET /socket` 路由
3. PC：`src/public/js/secure.js` (WebCrypto subtle 同算法栈)
4. PC：`src/lan-server.js` 加 WebSocket client（npm `ws`）
5. 联调：PC 发 PING 加密帧 → 手机回 PONG，往返 < 50ms

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
