# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-23（M3'-A merged main; M3'-A 收尾 3 项完成；feature/m3b-biometric-challenge 准备进 B-1）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~75%
- M3'-A：**✅ merged main** @ 712bf39（PIN 配对 + paired_devices TOFU）
- M3'-A 收尾三项：**✅ 完成**（user-approve reset / REST 持久化 / 两端 UI），在 feature/m3b-biometric-challenge 分支
- M3'-B 设计：**✅ 设计稿 0f5cba4 已上 main** (`docs/m3b-biometric-challenge-design.md`)
- M3'-B 实施：**⏳ 待用户确认 §7 fallback 取舍后开 B-1**
- 下个里程碑：**用户确认 M3'-B fallback 方案 → 开 B-1**

## 📍 上次离开时停在哪

- **里程碑**：开 feature/m3b-biometric-challenge，先把 M3'-A 收尾三项作前置 commit 处理（commits 1235c73 / 2481867 / 1781edc）
- **代码状态**：
  - `main` @ `0f5cba4` — M3'-A merge + M3'-B 设计稿
  - `feature/m3b-biometric-challenge` @ `1781edc` — 3 个收尾 commit，未 push（M3'-B 本体未开工）
- **git 状态**：
  - 旧分支 feature/m3-pairing-sync 本地+远端均已删
  - 当前分支落后 push（M3'-A 收尾 commit 等 M3'-B 实施完一起走 PR 或独立小 PR，看后续）

## ⏭️ 下次回来要做的

1. **用户确认 M3'-B 设计稿 §7**：fallback PIN 路径双副本 hmac_key 方案是否可接受
2. 通过后开 **B-1**：PAIR_OK 帧扩展 `device_hmac_key_b64` + db schema v4 migration
3. 之后 B-2 ~ B-7 按设计稿顺序推

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