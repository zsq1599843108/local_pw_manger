# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-22（M2' 已修必改等复审 ✅；m3 rebase 到修好的 M2 上；开补 Kotlin PAIR handler）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~65%
- M2' 进度：**🔄 已修必改等复审**（commit 1988e95：Tink → Cipher + JVM 互测 + Node 字节等价 + host 白名单 + 密钥擦除）
- M3'-A 进度：**🟡 协议层完成（34/34），Kotlin 集成补完中**
  - reviewer 报告 `docs/review/feature-m3-pairing-sync.md` 指出 Kotlin PAIR handler 为空、缺跨语言测试
  - 当前在执行：补 Kotlin `PairAttemptTracker` + PAIR 消息 handler + 集成测试
- 下个里程碑：**补完 Kotlin PAIR handler → 跑通端到端 → 提审**

## 📍 上次离开时停在哪

- **里程碑**：m3 rebase 到 1988e95（含 M2 修复），所有 34 测试仍 pass；但 m3 reviewer 标记 2 个新 blocker（Kotlin PAIR handler 为空、缺跨语言测试）
- **代码状态**：
  - `feature/m2-encrypted-channel` @ 1988e95 — 已修必改项（Cipher + JVM 互测 + host 白名单 + 密钥擦除 + SecureRandom 字段化 + maxFrameSize 64KB）
  - `feature/m3-pairing-sync` — 已 rebase 到 1988e95，Kotlin PAIR handler 还是 stub
- **git 状态**：
  - m3 已 rebase（祖先变了），需 force-push

## ⏭️ 下次回来要做的

**M3'-A 第二批必改项（reviewer 报告 `docs/review/feature-m3-pairing-sync.md`）**：
1. ✅ M2' AesGcmJce bug（rebase 已带入 1988e95 的修复）
2. ⏳ Kotlin PAIR_REQUEST/PAIR_OK/PAIR_REJECT handler 接到 `/socket` 路由
3. ⏳ Kotlin 端 `PairAttemptTracker`（service 级字段，跨连接共享）
4. ⏳ Kotlin 跨语言 round-trip 测试（JS seal → Kotlin open / Kotlin seal → JS open）
5. ⏳ 删除 `@Suppress("UNUSED_VARIABLE") val pairSecret` 死代码

完成后才考虑 M3'-B（主密码挑战）、M3'-C（全量同步）

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
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`