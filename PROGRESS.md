# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-19（M1 收尾，AOAP 在 Win 上死路一条，已转 ADR-002）

## 🎯 当前阶段

正在做：**v0.3 — 配对协议大改**
- v0.3 整体进度：~30%
- M1 进度：**部分通过**（指纹 demo ✅，AOAP 协议在 Win11 上被 MTP 驱动锁死 ❌）
- ADR-002 决策：**抛弃 AOAP，改走「手机 Wi-Fi 热点 + LAN 加密通道」**（用户选 B 路线）
- 下个里程碑：**M1'**（Wi-Fi hotspot PoC，0.5~1 天）

## 📍 上次离开时停在哪

- **里程碑**：M1 收尾 commit。AOAP 实证不通后留 deprecated 不删，转 ADR-002 设计中
- **代码状态**：
  - PC 端：`src/public/js/aoap.js`、`aoap-page.js`、`aoap-server.js` 全部加 deprecated 头注释
  - APK 端：`UsbAccessoryActivity.kt` 加 deprecated 头；`BiometricDemoActivity.kt` 已实测可用
  - 手机端 APK：`com.passman.pair v0.3-m1`，3.6MB，含指纹 demo + AOAP USB handler
  - server 端：`src/aoap-server.js` 已挂在 `/api/aoap/handshake`（Linux/Mac 仍可用）
- **测试状态**：
  - ✅ 指纹 BIOMETRIC_STRONG 在小米 14 Pro 上通过
  - ✅ libusb 在 Win11 能 open 小米 + 读 manufacturerName
  - ❌ vendor control transfer (req=51) 报 `invalid state`，MTP 驱动锁死
  - ❌ Chrome WebUSB 报 `Access denied`，同样原因
- **关键澄清**：Windows AOAP 路线**唯一软件层解法是 Zadig 装 WinUSB**，但代价是丢 MTP 文件传输 → 用户拒绝 → 转向 Wi-Fi 热点
- **git working tree**：M1 commit 待推

## ⏭️ 下次回来要做的

**Phase 2（先做，~30 min）：写 ADR-002 + 新 roadmap**
1. `docs/adr-002-wifi-hotspot.md` — 决策 + AOAP 的 Win 阻塞证据 + 选 B 路线的理由
2. `docs/wifi-hotspot-design.md` — 协议（手机做 Ktor server、PC 当客户端、PIN 配对、X25519 + AES-GCM 加密通道）
3. `docs/wifi-hotspot-roadmap.md` — M1'~M5' 拆分（M1' = ping/pong PoC）
4. 更新 `MEMORY.md` 文件地图（标 deprecated 文件 + 新增文件）

**Phase 3：M1' Wi-Fi PoC（~2-3 hour）**
1. APK 加 Ktor 依赖 + `HotspotServerService.kt` 前台服务（端口 9876，监听 `/ping`）
2. APK 加 `HotspotPairActivity.kt`：屏幕显示 SSID/密码/IP/PIN
3. PC 端 `src/public/js/lan-pair.js` + `src/lan-server.js`（Node 拉 `http://192.168.43.1:9876/ping`）
4. 联调：你开热点 → PC 切 Wi-Fi 加入 → ping 通

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
- 2026-06-19: **决策切 Wi-Fi 热点（ADR-002 即将写）**
  - 用户选 B 路线（手机做热点，PC 加入热点）
  - 复用 M2 加密协议设计，传输层从 USB bulk 换 TCP/HTTP
  - AOAP 代码全部 deprecated 不删，Linux/Mac 仍可走

## 🔗 关键文档跳转

- AOAP 设计（已 deprecated 留作历史）→ `docs/aoap-design.md`
- AOAP 路线图（已 deprecated）→ `docs/aoap-roadmap.md`
- ADR-001 AOAP 选型（已 deprecated）→ `docs/adr-001-aoap.md`
- **Win AOAP 阻塞复盘** → `docs/troubleshooting-windows.md`
- **新决策（待写）** → `docs/adr-002-wifi-hotspot.md`
- **新设计（待写）** → `docs/wifi-hotspot-design.md`
- **新路线图（待写）** → `docs/wifi-hotspot-roadmap.md`
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`
