# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-27（B-4 已提交并 push；B-5 第一刀完成：PC 端 fallback 流 + 纯 Kotlin FallbackPinTracker/PBKDF2 已测，待 Android ESP/PIN-Activity 接线）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~80%
- M3'-A：**✅ merged main** @ 712bf39（PIN 配对 + paired_devices TOFU）
- M3'-B 设计：**✅ 设计稿 0f5cba4 已上 main** (`docs/m3b-biometric-challenge-design.md`)
- M3'-B 实施（分支 `feature/m3b-biometric-challenge`）：
  - **B-1 ✅** @ 074500a — PAIR_OK 扩展 device_hmac_key + db schema v4
  - **B-2 ✅** @ 06489e4 — Keystore HMAC 导入 + BiometricChallengeSigner（reviewer ⚠️通过，1 must-fix）
  - **B-3 ✅** @ 617f754 — CHALLENGE dispatcher + 透明 prompt Activity + ChallengeBridge
  - **B-4 ✅** (已 push) — PC 端 lan-challenge.js verify + challenge-ui.js（22 单测）
  - **B-5 🔨 进行中** — 第一刀已完成（见下）；剩 Android 端
  - B-6/B-7 ⏳ 未开
- 下个动作：**B-5 第二刀（Android 端，本环境无法编译/单测，交真机+reviewer）**

## 🔨 B-5 拆分（2026-06-27 决策）

**已完成（本 commit，可测）：**
- 设计 §3 vs §7 矛盾已拍板：**PIN 在手机输 + 手机本地比对**；`FALLBACK_PIN` 帧仅作 PC 的「用户已同意，去弹 PIN」信号（无 pin 值）；PIN 首次设定放「首次走 fallback 时手机引导」。
- PIN 哈希用 **PBKDF2**（JCE 内置，非 argon2 —— 4 位 PIN 真正防线是 3次/24h 锁）。
- `Crypto.FallbackPinTracker`（3次/24h + snapshot/restore 供下刀 ESP 持久化）+ `hashFallbackPin`/`verifyFallbackPin` → `FallbackPinTest.kt` 9 单测绿。
- PC 端：`lan-challenge.js` FALLBACK_REQ 不再消费（留 pending 供 PIN 后 RESPONSE）+ `cancel(id)` + pending TTL 清理；`/api/lan/challenge/cancel` 路由；`challenge-ui.js` fallback modal → 发 FALLBACK_PIN → 收最终 RESPONSE。Node 测 31 绿。

**剩余（下一 commit，Android-only，本环境无法编译/单测）：**
- 加依赖 `androidx.security:security-crypto`（ESP，已决策自动加）。
- `DeviceKeyStore`(EncryptedSharedPreferences)：raw key 无 bio-gate 副本 = PAIR_OK 下发 + fallback HMAC 同一来源（**修 reviewer 待办 #1**）+ PIN hash/salt/lockout failures 持久化。
- HotspotServerService：收 `FALLBACK_PIN` → 弹 PIN 输入 Activity → 比对 → 用副本算 HMAC → 回 RESPONSE{bio:false}；`ERROR_LOCKOUT_PERMANENT`→FALLBACK_REQ（line 607 TODO）。
- PIN 输入 Activity（首次设定 + 后续验证）。

## 🔴 明天首要：reviewer B-2 反馈（必须先修）

**Must-fix（B-3 真接通 CHALLENGE 前必修）：**
- `android/app/build.gradle.kts:16` `minSdk = 21` 与 B-2 用的 API 30 冲突（设计 §12 本就要 minSdk 30）。
  - `enrollDeviceHmacKey` 无守卫地调了 API 30 的 `setUserAuthenticationParameters(...)` + `KeyProperties.AUTH_BIOMETRIC_STRONG`（只有 StrongBox 那行守了 API 28）。
  - 后果：lint NewApi=error → release 构建挂；API<30 真机抛 `NoSuchMethodError`（是 Error，内层 `catch(Exception)` 接不住，靠外层 catch(Throwable) 偶然兜）。
  - **改法（采纳①）：`minSdk = 30`**（一行，设计本意，全部 API 立即合法）。

**待办（非阻断，安排到对应 step）：**
1. 手机端 raw key 持久化缺失（设计 §8 的 EncryptedSharedPreferences 副本没做）→ **B-5 一并补**，让它成为 PAIR_OK 下发 + fallback 计算的**同一来源**（否则重启 mint 新 key 覆盖 Keystore，PC 拒换 key → CHALLENGE 必失败）。
2. 过时注释：`HotspotServerService` 顶部 `TODO(B-2): replace this in-memory mint…` 的 Keystore 部分已完成，更新它（保留「EncryptedSharedPreferences 副本未做」）。
3. 文档同步：`docs/m3b-biometric-challenge-design.md` §4「14B」→「15B」；§5 `generateKey()` 标注为「import（见实现偏离说明）」。
4. 小优化（可选）：`enrollDeviceHmacKey` 的 `catch(Exception)` 缩窄到 `StrongBoxUnavailableException`。

## 📍 上次离开时停在哪

- **里程碑**：M3'-B B-1~B-3 三个 commit 完成并提交到 `feature/m3b-biometric-challenge`（未 push）
- **代码状态**：
  - `main` @ `0f5cba4`
  - `feature/m3b-biometric-challenge` @ `617f754`（含 B-1/B-2/B-3 + 之前 3 个 M3'-A 收尾 commit，均未 push）
  - 工作区干净
- **reviewer 状态**：正在审 B-1；B-2 已给结论（⚠️通过 + 1 must-fix，见上）

## ⏭️ 下次回来要做的

1. **先修 reviewer must-fix**：`minSdk = 30`（build.gradle.kts）
2. 顺手清 reviewer 待办 #2（过时注释）+ #3（文档 §4/§5）+ #4（窄化 catch）
3. **§7 fallback 双副本方案待用户拍板** → 通过后 B-5 一并做 reviewer 待办 #1（EncryptedSharedPreferences 持久化）
4. 开 **B-4**：PC 端 `src/lan-challenge.js`（verify HMAC/ts/nonce/purpose/fingerprint）+ `src/public/js/challenge-ui.js`，可跑 Node 测试
5. B-6 跨语言互验（消费 `m3b_challenge_vectors.json`）、B-7 风险收尾

## 🚧 阻塞 / 待解决

- [x] **§7 fallback 双副本方案已拍板（2026-06-26）：采用方案 A（EncryptedSharedPreferences 无 bio-gate 副本 + PC 端 purpose 限制）** → 解除 B-5 阻塞
- [ ] reviewer B-2 must-fix（minSdk 30）→ **✅ 已修 @ ba7d9ee**（待 reviewer 复核）
- [x] 确定技术栈（Node.js + Express + SQLite）
- [x] 选定手机配对协议（**AOAP**，2026-06-18）→ ❌ Win 上不可行
- [x] **新协议选定（Wi-Fi hotspot，2026-06-19）**
- [ ] 准备 iPhone 测兼容性（v0.4+ 范畴）

## 📌 决策记录

- 2026-06-26: **§7 fallback 采用方案 A（双副本）** —— 指纹临时不可用时，用 EncryptedSharedPreferences 里的无 bio-gate key 副本算 HMAC；安全靠 PC 端对 `biometric_ok:false` 的 purpose 限制（只放行 unlock，拒 sync_destructive/export_plaintext，标记+24h 锁）。论点：HMAC 对称、PC 已持明文 key，手机多存副本未下放秘密。B-5 据此实现 §8 的 EncryptedSharedPreferences 持久化（同时作 PAIR_OK 下发 + fallback 计算的同一来源，修 reviewer 待办 #1）。

- 2026-06-25: **M3'-B Keystore key 用「导入」而非 §5 字面的 `generateKey()`** —— Keystore 内生成的 key 不可导出，PC 拿不到对称 HMAC 副本（违反 §6）。故 `SecureRandom` 生成 32B → `KeyStore.setEntry` 导入带 bio-gate 保护；同一 raw 也发 PC。已落 Crypto.kt 注释 + B-2 commit。
- 2026-06-25: **M3'-B B-3 新增 2 个 RESPONSE error code**：`key_invalidated`（指纹库变→重配对）/ `bad_nonce`（nonce 非 32B）。已记 design §3。
- 2026-06-25: **已知依赖**：M3'-A 每连接重生 X25519 keypair（持久身份留 M4'）→ CHALLENGE 只在配对同连接上 Keystore alias 匹配；换连接返回 `unknown_device`。Service 后台拉起 prompt Activity 受 Android 12+ 限制，依赖交互配对前台豁免（硬化 TODO：full-screen-intent 通知）。

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