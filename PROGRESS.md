# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-07-02（B-5 第二刀 Android 端落地：K_pin 走 ESP、`computeChallengeHmac`、`FallbackSecretStore`、`FallbackPinBridge`+`FallbackPinActivity`、Service 接线 PAIR_OK 带 `device_pin_key_b64` + 配对即设定 PIN、`handleFallbackPin` 全流程、`ERROR_LOCKOUT(_PERMANENT)`→FALLBACK_REQ。JVM 24/24、lint 0 error、JS 33/33。ESP/Activity/Service 集成留 B-6 真机）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~82%
- M3'-A：**✅ merged main** @ 712bf39（PIN 配对 + paired_devices TOFU）
- M3'-B 设计：**✅ 设计稿已上 main**；§7 已翻案方案 C、§8 argon2id→PBKDF2（本轮同步）
- M3'-B 实施（分支 `feature/m3b-biometric-challenge`）：
  - **B-1/B-2/B-3 ✅**（B-3 P→S blocker 已修 @2ade2b4）
  - **B-4 ✅** — PC 端 verify + challenge-ui
  - **B-5 ✅ 第一刀（PC + Kotlin tracker）+ 第二刀（Android 端）** — 见下
  - B-6/B-7 ⏳ 未开（B-6 真机 + 跨语言 JVM 互验消费向量）
- 下个动作：**B-6 真机实测 + 跨语言互验收尾**

## 🔨 B-5 / 方案 C（2026-06-27）

**§7 决策：方案 C（加固）** —— fallback 用独立 `K_pin`（≠ K_bio 副本），PC 同存两把，按「哪把 key 验过 HMAC」判定 bio/fallback；`biometric_ok` 降级纯展示、不参与鉴权。K_bio 永不出 Keystore/ESP，受控手机算不出 → 软门由密码学强制，无法冒充强认证。

**已完成（PC 端 + 文档，本环境测绿）：**
- db.js schema v4→**v5** 加 `device_pin_key` 列；paired-devices `trustDevice` 收 K_pin + `enrollPinKey` 回填；lan-device-routes `/trust` 收 `device_pin_key_b64` + GET `has_pin_key`。
- **lan-challenge.js verify() 重写**：先试 K_bio(全 purpose) 再试 K_pin(仅 unlock)，删掉对 `response.biometric_ok` 的信任；biometricOk 由匹配的 key 推导。
- lan-pair.js PAIR_OK 摄入 `device_pin_key_b64` → /trust。
- 测试：m3b-challenge **33 绿**（含「谎报 biometric_ok 无效」「K_pin 不放行 export」关键用例）；m3a-db 27 / m3a-routes 34 / gen-vectors 全绿。
- 文档：§3/§7/§8/§9/§16 已同步方案 C + PBKDF2。
- 早先：B-3 P→S @2ade2b4（lint NewApi=0）；JDK 路径移到 ~/.gradle @b66d265。
- 纯 Kotlin `FallbackPinTracker` + PBKDF2 助手 + FallbackPinTest（9 绿）已在 1090b52。

**剩余（第二刀，Android-only，本环境无法编译/单测，真机验证留 B-6）：**
- 加依赖 `androidx.security:security-crypto`（ESP，已决策自动加）。
- Crypto：K_pin 的纯 HMAC 计算（SecretKeySpec，不走 Keystore）。
- HotspotServerService：配对时**独立生成 K_pin** 存 ESP + PAIR_OK 带 `device_pin_key_b64`；收 `FALLBACK_PIN` → PIN Activity → 比对(PBKDF2) → 用 K_pin 算 HMAC → 回 RESPONSE；`ERROR_LOCKOUT_PERMANENT`→FALLBACK_REQ。
- ESP 持久化（K_pin + PIN hash/salt + tracker failures snapshot/restore）+ PIN 输入 Activity（首次设定 + 验证）。
- ⚠️ K_bio 仍**只**进 Keystore，绝不写 ESP。

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

- **里程碑**：M3'-B B-5 第二刀（Android 端）代码完成并本地编译/测试通过，待 commit
- **代码状态**：
  - `main` @ `51f3fcf`
  - `feature/m3b-biometric-challenge` @ `8cc24df`（+ 本轮 B-5 第二刀未提交改动）
  - 工作区：B-5 第二刀改动（Crypto/Service/FallbackSecretStore/FallbackPinBridge/FallbackPinActivity/Manifest/build.gradle + ChallengeHmacVectorTest）
- **测试**：JVM 24/24、lint 0 error、JS 33/33、向量自检 0（本环境全绿）
- **reviewer 状态**：B-5 第一刀 ✅；第二刀待审（ESP/Activity/Service 集成本环境无法 instrumented 测，留 B-6 真机）

## ⏭️ 下次回来要做的

1. **commit B-5 第二刀**到 `feature/m3b-biometric-challenge`（不 push，交 reviewer）
2. **B-6**：真机实测 fallback 全流程（指纹不可用 → FALLBACK_REQ → PC modal → FALLBACK_PIN → 手机 PIN 输入 → K_pin RESPONSE → PC verify biometricOk=false 仅 unlock）；跨语言 JVM 互验已部分（ChallengeHmacVectorTest 消费向量），补 instrumented ESP/lockout 重启测试
3. **B-7**：风险登记 + CHANGELOG + 真机覆盖（指纹注册变更 / StrongBox 缺失降级 / Android 12+ 后台拉 Activity）
4. reviewer 复核通过后 merge feature→main

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