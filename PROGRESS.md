# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-22（M2' 已 merge main ✅；m3 rebase 到 main；M3' 拆 A/B/C；等复审 M3'-A）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~70%
- M2' 进度：**✅ 已 merge main**（commit 2815b08，含 reviewer 必改修复 1988e95）
- M3' 拆分：**M3'-A 配对 / M3'-B 生物识别挑战 / M3'-C 全量同步**（详见 CHANGELOG 2026-06-22 Decision）
- M3'-A 进度：**🟡 等 reviewer 复审**（Kotlin PAIR handler + 跨语言 JVM 测试已 push，commit 6501b83）
- 下个里程碑：**M3'-A 复审通过 → merge → 开 M3'-B**

## 📍 上次离开时停在哪

- **里程碑**：m3 rebase 到 main (2815b08)，修了 `CryptoInteropTest.kt` import，PROGRESS/CHANGELOG 标了 A/B/C 拆分
- **代码状态**：
  - `main` @ 2815b08 — 含 M2' 全套（加密通道 + 修复 + 互操作测试 + host 白名单）
  - `feature/m3-pairing-sync` @ 6501b83 — rebase 到 main，Kotlin PAIR handler 全接，跨语言测试向量齐
- **git 状态**：
  - m3 force-push 完成（祖先从 411ff39 变为 6501b83）
  - 等 reviewer 复审 → 通过则 merge → main

## ⏭️ 下次回来要做的

**M3'-A 复审通过后**：
1. merge `feature/m3-pairing-sync` → main
2. 开 M3'-B：`CHALLENGE/RESPONSE` over established session（**设计稿已就位**：`docs/m3b-biometric-challenge-design.md`）
   - 决策：方案 B — Android Keystore HMAC + bio gate（TEE 担保 biometric_ok）
   - PAIR_OK 帧扩展 `device_hmac_key_b64` + db schema v4
   - 失败兜底回 4 位码（v0.2 路径已在 aoap-server.js）+ fallback 路径下禁用高敏 purpose
3. M3'-C：全量同步 `SYNC_PULL/SNAPSHOT/SYNC_PUSH`，last-write-wins

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
- 2026-06-22: **M2' 加密通道首次提交**（commit 55a6c45）
  - 算法栈：X25519 ECDH → HKDF-SHA256 → AES-256-GCM
  - ⚠️ **2026-06-22 reviewer 否决**：手机端 Tink `AesGcmJce.encrypt()` 会自动前置 12B IV，wire 实际是 `iv || ctr || tink_iv || ct || tag`
- 2026-06-22: **M2' 必改项修完**（commit 1988e95）
  - Kotlin 改 `javax.crypto.Cipher` 自控 IV；加 JVM 互操作测试 + Node 字节等价验证（8/8）
  - 建议项 4 条：maxFrameSize 64KB / close() 擦密钥 / SecureRandom 字段化 / host 白名单
- 2026-06-22: **M3' reviewer 标记 2 blocker**：Kotlin PAIR handler + 跨语言测试
- 2026-06-22: **m3 rebase 到 1988e95**，开补 Kotlin PAIR handler

## 🔗 关键文档跳转

- AOAP 设计（已 deprecated 留作历史）→ `docs/aoap-design.md`
- AOAP 路线图（已 deprecated）→ `docs/aoap-roadmap.md`
- ADR-001 AOAP 选型（已 Superseded）→ `docs/adr-001-aoap.md`
- **Win AOAP 阻塞复盘** → `docs/troubleshooting-windows.md`
- **现行决策** → `docs/adr-002-wifi-hotspot.md` ✅
- **现行设计** → `docs/wifi-hotspot-design.md` ✅
- **现行路线图** → `docs/wifi-hotspot-roadmap.md` ✅
- **M3'-B 设计草案（待 M3'-A merge 后实施）** → `docs/m3b-biometric-challenge-design.md` 📝
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`