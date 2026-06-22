# 审查报告: feature/m3-pairing-sync

分支: `feature/m3-pairing-sync` @ fcf1cbd
基线: `main` @ 00ee8aa
审查时间: 2026-06-22
审查人: reviewer agent

## 结论: ⚠️ 部分完成，需补全后才可合并

**状态定位**：M3' 是**半截 prototype**，而非可交付里程碑。JS/Node 侧完整（协议、DB、测试全绿），但
Kotlin/手机侧仅完成 crypto primitives stub，PAIR_REQUEST 握手 handler 没接进 `/socket` route。
**真机不可能完成配对**——只能在 JS mock-phone 测试里跑。

### 继承自 M2' 的 blocker（未修）
- **`Crypto.kt` AesGcmJce auto-prepend IV bug**（`AesGcmJce.encrypt` 返回 `iv||ct||tag`，
  Kotlin 又拼了一层自己的 IV）→ 与 `secure.js` 字节不兼容，真机上任何加密消息无法解密。
  M3 分支仅改了 `deriveSessionKey` 返回值类型（`ByteArray` → `DerivedSecrets`），但 `seal/open` 没动。

## 改动摘要

### JS/Node 侧（✅ 完整、有测试）
- `src/public/js/secure.js`：
  - `deriveSessionKey` 改为双输出（`aesKey: CryptoKey`, `pairSecret: Uint8Array(32)`）
  - 新增 `rollingPin(pairSecret, w)` / `pinWindow(nowMs)`：HKDF-derived 6 位滚动 PIN，TOTP 风格
  - 新增 `fingerprintHex(pubBytes)` / `fingerprintShort`：SHA256(pubkey) 64 hex 大写，TOFU 身份
- `src/lan-pair-protocol.js`（NEW, 131）：协议消息枚举 + JSON encode/decode + `PairAttemptTracker`
  滑动窗口速率限制 + `verifyPin`（±1 窗口 slack）
- `src/paired-devices.js`（NEW, 73）：`paired_devices` 表 repository，`trustDevice` / `findByFingerprint`
  / `listDevices` / `touchLastSeen` / `revoke`
- `src/db.js`：schema 升级到 v3，新增 `paired_devices` 表 + `schema_meta` 版本戳
- `scripts/test-m3a-db.js`（NEW, 118）：7 个 DB 用例（schema 戳、round-trip、constraint、ordering、touch、
  revoke、fingerprintHex 正确性）
- `scripts/test-m3a-pairing.js`（NEW, 362）：端到端配对握手测试，5 个用例（正 PIN / 错 PIN / 5 次锁 /
  超窗口 / 用户拒绝）

### Kotlin/手机侧（⚠️ 仅 crypto  primitives，未集成）
- `android/.../Crypto.kt`：
  - `deriveSessionKey` 从 `ByteArray` 改为 `DerivedSecrets(val aesKey, val pairSecret)`，OKM 拆 0-32/32-64
  - 新增 `pinWindow(nowMs)` / `rollingPin(pairSecret, w)`，与 JS `rollingPin` 字节对应
  - 新增 `fingerprintHex(pub)` / `fingerprintShort`，与 JS / Node 三者一致
- `android/.../HotspotServerService.kt`（+2 行）：
  - 仅存 `@Suppress("UNUSED_VARIABLE") val pairSecret = derived.pairSecret` 声明，**完全没接**
    PairAttemptTracker / PAIR_REQUEST handler / 加密回复 → M3 协议在手机侧是空的

### 项目文档
- `CHANGELOG.md`：M2' & M3' 改动摘要 + 决策记录
- `PROGRESS.md`：更新 M2' 状态为 ✅ 完成，M3' 任务清单 + M3'-A rolling PIN 设计决策
- `TODO.md`：未细查（非交付关键）

## 逐项审查

### 1. 加密/安全: ✅（JS）/ ⚠️（Kotlin 集成不足）
- **双 HKDF 输出设计**：OKM[0:32] = AES 密钥，OKM[32:64] = pair_secret，两者同源但不同域，
  协议分层干净 ✅
- **滚动 PIN 设计**：`HKDF-SHA256(pair_secret, salt=window, info=passman-pair-pin-v1, out=4)`
  → big-endian u32 % 1_000_000 → 6 位。时间窗口 30s，攻击窗口 30-90s，搭配 5 次/60s 锁定，
  暴力破解成本足够 ✅
- **TOFU fingerprint**：完整 SHA256（64 hex）做 DB PK，显示时取前 32 字符分 4 组显示，
  碰撞抗性充足 ✅
- **fingerprint 三方一致性**：JS (`secure.js`) / Node (`paired-devices.js`) / Kotlin (`Crypto.kt`)
  都实现了 SHA256(pubbytes).toUpperCaseHex，可互操作 ✅（静态审查通过，无跨语言互跑测试）
- **⚠️ 继承 Bug**：`Crypto.kt` `SecureChannel.seal/open` 仍有 AesGcmJce double-IV 问题（见 M2' 报告）
- **⚠️ Kotlin 侧 lockout tracker 未实现**：仅 JS/Node 有 `PairAttemptTracker`，Kotlin 代码里没定义，
  更没绑到 service 级字段

### 2. 数据本地化: ✅
- 所有配对、TOFU 记录存本地 SQLite，不上传任何服务器
- fingerprint 是公钥哈希（完全离线，无外部依赖）
- 测试仅用 localhost WebSocket 桥，无出站请求
- ✅ 无 telemetry / CDN

### 3. 正确性: ✅（JS）/ ⚠️（Kotlin）
- **`PairAttemptTracker` 滑动窗口**：`_prune()` 取 `now - windowMs` 为 cutoff，每次 `isLocked()`
  或 `recordFailure()` 前剪枝，窗口边界行为合理 ✅
- **`verifyPin` 窗口 slack**：检查 w-1, w, w+1，覆盖 ±45s 时钟漂移（普通 consumer device 水平），
  不会因手机/PC 时间不同步导致 false reject ✅
- **window 字段类型一致性**：Kotlin `pinWindow` 返回 `Long`（64-bit），JS `pinWindow` 返回 `Number`（53-bit，
  够 ~28 亿年）。`PAIR_REQUEST` 用 `Number(w)` 发 JSON——可接受，但 Kotlin 方接收时需小心
  `jsonPrimitive.long` 而非 `int`（当前 Kotlin 没接 handler，所以没问题，但以后要注意）
- **`trustDevice` constraint**：SQLite fingerprint UNIQUE PK 防止同一手机重复 trust ✅
- **用户拒绝不计入失败**：`user_denied` 不调用 `recordFailure()`，防止恶意用户通过狂点拒绝把服务锁死 ✅

### 4. 测试: ⚠️ 测试覆盖仅 JS 侧，缺跨语言与真机
- **`test-m3a-db.js`**：7/7 用例，覆盖 `paired_devices` 表 CRUD 全路径 ✅
- **`test-m3a-pairing.js`**：5 个端到端用例全绿（mock-phone + 真 bridge + 真 secure.js）：
  - 正确 PIN → PAIR_OK
  - 错误 PIN → PAIR_REJECT bad_pin
  - 5 次错误后锁定 → PAIR_REJECT locked
  - out-of-slack 窗口 PIN → PAIR_REJECT bad_pin
  - 用户拒绝 → PAIR_REJECT user_denied，且不消耗失败计数
- **测试盲区**（critical）：
  - 🚨 Kotlin Crypto.kt 功能（rollingPin / fingerprintHex）与 JS 方从未在同一测试里互跑过
  - 🚨 Kotlin 方完全缺 `PairAttemptTracker` 实现 + 接入 `/socket` 路由 handler
  - 🚨 真机上 `HotspotServerService` 只懂 PING/PONG，不懂 PAIR_REQUEST

### 5. 项目约束: ✅
- 分支命名 `feature/m3-pairing-sync` 符合约定
- PROGRESS.md 明确标了「M2' 完成，M3' 开始」，CHANGELOG.md M3' 条目已写 ✅
- npm 依赖无新增（复用 M2' 的 ws@^8.21.0）；Gradle 无新增（复用 M2' 的 tink + ktor-websockets）
- 与 M3'-A 设计文档（wifi-hotspot-design.md / roadmap）一致 ✅

## 必改项（blocking，合并前必须完成）
1. **修 M2' blocker**：`Crypto.kt` `SecureChannel.seal/open` — 换 `javax.crypto.Cipher` 或
   对 Tink 输出做 `drop(12)` / `prepend(iv)` 修正，直到与 JS `SecureChannel` 真正互操作
2. **补 Kotlin PAIR 握手 handler**：在 `HotspotServerService.kt` `/socket` WebSocket
   路由里实现 PAIR_REQUEST / PAIR_OK / PAIR_REJECT，搭配 `PairAttemptTracker`，与 JS 侧协议严格对应
3. **补 Kotlin 单元测试**：至少一个「Kotlin Crypto 加密 → JS secure.js 解密」跨语言 round-trip 测试，
   或用 Ktor test engine 打 `/socket` 握手端到端
4. **移除 `@Suppress("UNUSED_VARIABLE") val pairSecret`** 死代码，把 `pairSecret` 真正用起来

## 建议项（非 blocking，可 M3'-B 收口）
1. `HotspotServerService.kt` `PairAttemptTracker` 应是 service 级字段（跨所有连接共享），
   不是 per-connection——当前 JS mock 测试里是跨连接传 tracker 引用，Kotlin 也应同模型
2. `window` 字段类型：在协议文档里明确 `w` 最大可能值，或 Kotlin 接收时用 `jsonPrimitive.long`
   而不是 `int` 防 2038 问题（low priority）
3. `paired_devices` 表 UI：当前只存不读，M3'-B 应加「已配对设备列表」「撤销配对」页面
4. `fingerprintShort` 显示：当前 PC 侧 UI 还没展示 TOFU fingerprint 给用户对比

## 测试结果
- `node scripts/test-m3a-db.js`：7 passed, 0 failed（review worktree 运行通过）
- `node scripts/test-m3a-pairing.js`：全用例通过（review worktree 运行通过）
- 注意：两测试跑的都是 JS mock phone，**完全没涉及 Kotlin 代码**——手机端路径从未被任何测试触达

---
🤖 Generated with Claude Code (reviewer agent)
