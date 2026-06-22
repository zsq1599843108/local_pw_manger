# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-22（M2' 收到 reviewer 必改意见 ❌，M3'-A 配对协议层先行完成）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~60%
- M2' 进度：**❌ 审查未过**（Tink `AesGcmJce` 自动前置 IV 导致 wire 布局与 secure.js 不互通，离线测试因 mock-phone 用 Node WebCrypto 而漏检；需切到 `javax.crypto.Cipher` + 补 JVM 互操作测试）
- M3'-A 进度：**✅ 协议层完成**（DB schema + fingerprint + rolling PIN + 锁定追踪器，34/34 测试，但需等 M2' 修复合并后再继续 APK UI）
- 下个里程碑：**回 `feature/m2-encrypted-channel` 修必改 → reviewer 复审 → 合并 → 回 m3 续 APK UI**

## 📍 上次离开时停在哪

- **里程碑**：M3'-A 协议层 34/34 测试通过（DB 13 + 配对 17 + M2 旧 4）— 但**底层 M2 在真机上必坏**
- **代码状态**：
  - `feature/m2-encrypted-channel` (commit 55a6c45) — Tink `AesGcmJce` 误用，wire 布局错位（reviewer 报告 `docs/review/feature-m2-encrypted-channel.md`）
  - `feature/m3-pairing-sync` (commit fcf1cbd) — 协议层代码 OK，但依赖未修复的 M2
- **git 状态**：
  - `feature/m2-encrypted-channel` 已 push，待 developer 修必改项 1+2
  - `feature/m3-pairing-sync` 已 push，**暂停 APK UI 工作**，等 M2 合并后回来

## ⏭️ 下次回来要做的

**优先级 1：修 M2'（详见 `docs/review/feature-m2-encrypted-channel.md` 必改项）**
1. Kotlin `Crypto.kt` 改用 `javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")` 自控 IV（约 30 行）
2. 新增 JVM 单元测试，让 Kotlin Crypto 与 secure.js 字节互操作（脱离这个测试，类似问题以后还会出）
3. 顺手做建议项：`maxFrameSize` 限上限 / `close()` 擦密钥 / `SecureRandom` 字段化 / host 加白名单
4. push 后通知 reviewer 复审

**优先级 2：M2' 合并到 main 后**
- 回 `feature/m3-pairing-sync`，`git rebase origin/main` 带入 M2 修复
- 继续 M3'-A 待做：APK PIN UI（`HotspotPairActivity` 滚动 PIN 显示 + PC 指纹弹窗）+ APK 持久化（`TrustStore.kt` + `EncryptedSharedPreferences`）+ PC UI（`lan-pair.js` 接 PIN 输入流程）

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
- 2026-06-22: **M2' 加密通道首次提交**（commit 55a6c45, branch `feature/m2-encrypted-channel`）
  - 算法栈：X25519 ECDH → HKDF-SHA256 → AES-256-GCM，PC/APK **设计上**字节兼容
  - Node 哑字节桥 `src/lan-ws-client.js`：不持有密钥，仅转发 ws 帧
  - 离线测试：mock-phone（Node WebCrypto）+ 真桥 + 真 secure.js，4/4 通过
  - ⚠️ **2026-06-22 reviewer 否决**：手机端 Tink `AesGcmJce.encrypt()` 会自动前置 12B IV，wire 实际是 `iv || ctr || tink_iv || ct || tag` 而非约定的 `iv || ctr || ct || tag`，手机↔PC 在真机上必定 GCM auth 失败；测试因 mock-phone 不走 Kotlin 路径而漏检
  - 修复方向：Kotlin 改 `javax.crypto.Cipher` 自控 IV + 加 JVM 互操作测试，详见 `docs/review/feature-m2-encrypted-channel.md`
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
