# 复审报告: feature/m3-pairing-sync (fix commit 6501b83)

分支: `feature/m3-pairing-sync` @ 6501b83
基线: `main` @ 00ee8aa（含 M2' fix 1988e95）
复审时间: 2026-06-22
审查人: reviewer agent
前置审查: `docs/review/feature-m3-pairing-sync.md`（⚠️ JS 侧完整，Kotlin PAIR handler 缺失 + 继承 M2' IV bug）

## 结论: ⚠️ 小改后通过

M3' 原报告的两个 blocker 均已落实：
1. ✅ Kotlin PAIR handler 已接入 `/socket` 路由（`HotspotServerService.handlePairRequest`）
2. ✅ 继承的 M2' IV bug 已修（M2' fix 1988e95 已在该分支历史里）

但发现 **1 个新 blocking 编译错误** + **1 个功能性缺口**，需在合并前/合并后处理。

## Blocker（合并前必修）

**`android/app/src/test/java/com/passman/pair/CryptoInteropTest.kt:125` 编译错误**
```kotlin
assertTrue("tampered frame threw unexpected type: ${e.javaClass.name}", ...)
```
该文件仅 import 了 `assertArrayEquals` 和 `assertEquals`（line 30-31），**未 import `org.junit.Assert.assertTrue`**。
- 影响：`./gradlew app:testDebugUnitTest` 编译失败 → 整个 JVM 测试套件（含新增的 `CryptoPairingTest`）跑不起来
- 修法：加一行 `import org.junit.Assert.assertTrue`
- 这是 M2' fix commit 1988e95 引入的，M3 分支继承下来。**1 行修复**。

## 功能性缺口（合并后 M3'-B 必修）

**手机端 UI 未接通 PAIR 流程** — `HotspotPairActivity.kt` 的 `buildUi()` 只有 Start/Stop server + Biometric Demo + Tether Settings 按钮，**没有**：
- 显示当前滚动 PIN 给用户看（用户无从知道往 PC 输什么）
- "Trust this PC" / "Deny" 按钮（`HotspotServerService.userApprovesNext` 永远是 false）

后果：真机上即使 PIN 正确，`handlePairRequest` 走到 `if (!userApproves())` 永远返回 `PAIR_REJECT user_denied`，配对无法完成。
- 定性：M3'-A 定位为"协议后端层"，UI 可拆到 M3'-B。但 **PROGRESS.md / commit message 未明示这一拆分**，易误判 M3' 端到端可用。
- 建议：合并前在 PROGRESS.md / CHANGELOG.md 标注「M3'-A = 后端协议层，UI 在 M3'-B」，避免 main 上的代码被当成可端到端配对。

## 原报告必改项落实

| 项 | 状态 | 证据 |
|---|---|---|
| 必改 1: 修 M2' IV bug | ✅ | M2' fix 1988e95 在分支历史中，`Crypto.kt` 用 `javax.crypto.Cipher` |
| 必改 2: 补 Kotlin PAIR handler | ✅ | `HotspotServerService.kt:303-313` dispatch PAIR_REQUEST → `handlePairRequest` (line 339-394) |
| 必改 3: 跨语言互测 | ✅ | `CryptoPairingTest.kt` (175 行) + `m3_pairing_vectors.json` (21 vectors: 18 rollingPin + 3 fingerprint) |
| 必改 4: 删 `@Suppress("UNUSED_VARIABLE")` 死代码 | ✅ | `pairSecret` 现在喂给 `verifyPin`，`finally` 块还 `Arrays.fill` 擦除 |

## 逐项审查（M3 新增部分）

### 1. 加密/安全: ✅
- `Crypto.PairAttemptTracker` 滑动窗口逻辑与 JS `PairAttemptTracker` 字节对应 ✅
- `Crypto.verifyPin` ±1 窗口 slack + **constant-time 字符串比较**（`constantTimeEquals`，line 323-328）— 比 JS 版还多一层时序侧信道防护 ✅
- `pairSecret` 在 socket 关闭时 `Arrays.fill(it, 0)` 擦除（`HotspotServerService.kt:328`）✅
- `pinTracker` 是 service 级字段（跨连接共享），与 JS mock 测试模型一致 ✅
- `user_denied` 不消耗失败计数（`handlePairRequest:378-386` 不调 `recordFailure`）✅
- 协议违规（缺 pin/w 字段）也不消耗计数（line 357-366）✅ — 防恶意耗尽锁定配额

### 2. 数据本地化: ✅
- 无网络上传，所有状态本地内存 / SQLite
- 滚动 PIN 纯 HKDF 派生，无外呼

### 3. 正确性: ✅
- `verifyPin` 用 `Long`（64-bit），JS 用 BigInt/Number（53-bit safe）— vectors 里 `w=9007199254740992`（2^53）证明 JSON 序列化边界 OK ✅
- `handleEncryptedSocket` 的 `pairSecret!!`（line 307）安全：binary 帧到达前 channel 必已建（handshake 设 channel），而 pairSecret 与 channel 同点赋值 ✅
- `replyEncrypted` helper 正确复用 channel 发加密回复 ✅

### 4. 测试: ✅（JS）/ ⚠️（JVM）
- JS 侧：`test-m3a-pairing.js` 17/17 通过，`test-m3a-db.js` 13/13 通过（review worktree 实跑）
- vectors 可复现：`gen-m3-pairing-vectors.js` 重生成与 committed JSON 内容一致（仅 CRLF 差异）✅
- JVM 侧：`CryptoPairingTest.kt` 逻辑正确（import 齐全），但 **`CryptoInteropTest.kt` 的 import 缺失会编译失败**，导致整个 testDebugUnitTest 跑不起来 → blocker

### 5. 项目约束: ✅
- 分支拓扑清晰（M2' fix → M3' docs → M3' feat）
- commit message 详尽，明示对应 reviewer 报告
- PROGRESS.md 更新了 M3'-A 状态

## 测试结果
- `node scripts/test-m3a-pairing.js` — 17/17 通过
- `node scripts/test-m3a-db.js` — 13/13 通过
- `node scripts/test-m2-encrypted-channel.js` — 4/4 通过（回归）
- `node scripts/test-m2-kotlin-bytes.js` — 8/8 通过
- vectors 可复现性：M3 pairing vectors ✅ 一致；M2 interop vectors 用随机 IV（预期，golden file 即 committed 版本）
- JVM `./gradlew app:testDebugUnitTest` — **未跑**，因 `CryptoInteropTest.kt` 缺 import 编译失败（blocker）

## 合并建议
1. **修 `CryptoInteropTest.kt:125` 的 `assertTrue` import**（1 行）
2. 在 PROGRESS.md / CHANGELOG.md 标注 M3'-A = 后端协议层，UI 在 M3'-B
3. 修完后 rebase 到已合并 M2' 的 main，再 merge → main

---
🤖 Generated with Claude Code (reviewer agent)

---


# 复审报告 ②: feature/m3-pairing-sync (rebase 到 main, M3'-A)

分支: `feature/m3-pairing-sync` @ 40f200f
基线: `main` @ 2815b08（M2' 已 merge，rebase 后祖先从 411ff39 → 2815b08）
审查时间: 2026-06-22
审查人: reviewer agent
前置审查: 本文件上方初审 + 复审①
本次范围: M3' 拆为 A/B/C，**本次仅审 M3'-A**（配对协议）；M3'-B/C 后续单独提审。

## 结论: ❌ 需重做（1 blocker 编译错误，测试跑不起来）

rebase 干净（6 commit、纯 M3'-A、不含已 merge 的 M2），Kotlin PAIR handler 已补齐，JS/Kotlin 密码学镜像字节对齐，Node 测试 30/30 全过。
**但 JVM 测试编译失败** —— developer 声称"16 个 JVM 用例可用 `./gradlew app:testDebugUnitTest` 跑"未达成。上次复审①修的 `assertTrue` import 确实补上了，却暴露同文件第二处编译错误 `digitToChar`。测试无法运行前不合并。

## 改动摘要（M3'-A，6 commit，rebase 后）

- `src/db.js` — schema v3：新增 `paired_devices` + `schema_meta` 表，`SCHEMA_VERSION` 常量
- `src/lan-pair-protocol.js`（新）— 消息类型常量 + `PairAttemptTracker` 滑动窗口锁定 + `verifyPin`（±1 skew）
- `src/paired-devices.js`（新）— TOFU 仓库：`fingerprintHex` / `trustDevice` / `findByFingerprint` / `listDevices` / `touchLastSeen` / `revoke`
- `src/public/js/secure.js` — `deriveSessionKey` 改返回 `{aesKey, pairSecret}`（HKDF 一次出 64B）；新增 `rollingPin` / `pinWindow` / `fingerprintHex` / `fingerprintShort`
- `src/public/js/lan-pair.js` — 适配 `deriveSessionKey` 新返回结构（取 `aesKey`）
- `android/.../Crypto.kt` — 镜像 JS：`DerivedSecrets` / `rollingPin` / `pinWindow` / `fingerprintHex` / `fingerprintShort` / `PairAttemptTracker`（@Synchronized）/ `verifyPin`（常量时间比较）
- `android/.../HotspotServerService.kt` — service 级 `pinTracker` + `userApprovesNext` 标志 + `handlePairRequest` 状态机（lockout→PIN→user→PAIR_OK/REJECT）+ `pairSecret` 擦零
- `android/.../CryptoInteropTest.kt` — 补 `assertTrue` import（复审① blocker 修复）
- `android/.../CryptoPairingTest.kt`（新）— JVM 配对测试，加载 `m3_pairing_vectors.json`
- 测试向量 `m3_pairing_vectors.json` + 生成器 `scripts/gen-m3-pairing-vectors.js` + `scripts/test-m3a-db.js` + `scripts/test-m3a-pairing.js`
- `CHANGELOG.md` / `PROGRESS.md` / `TODO.md` — 标 M3'-A/B/C 边界

## 逐项检查

1. **加密/安全**: ✅
   - 算法栈正确：X25519 ECDH → HKDF-SHA256(64B, info=`passman-lan-v1`) → aesKey(32B) + pairSecret(32B) 两域分离；PIN = HKDF-SHA256(pairSecret, floor(now/30s), info=`passman-pair-pin-v1`, 4B) % 1e6。
   - JS `okm.slice(32,64)` 正确 copy 出独立 pairSecret buffer；Kotlin `copyOfRange` 对应。
   - PIN 大端 u32 取法两端一致（JS `>>>0`，Kotlin `and 0xFF shl`）。
   - `verifyPin` Kotlin 用 `constantTimeEquals` 常量时间比较；JS 侧仅 `===`（浏览器、30s 短命 PIN，可接受，non-blocking）。
   - `pairSecret` socket 关闭 `Arrays.fill(0)` 擦零 ✅。
   - 无硬编码密钥、无明文落盘、`SecureRandom` 字段化（M2' 修复继承）。
   - TOFU 指纹 SHA-256 全 64 hex 落库（非截断），显示层才截 32，PK 碰撞安全 ✅。
   - SQL 全参数化（`paired-devices.js` 用 `db.prepare(...).run(?,...)`）✅。

2. **数据本地化**: ✅ 无任何网络上传 / telemetry / 外链 CDN。配对走 LAN 热点，密钥不出端。

3. **正确性**: ⚠️（见 blocker）
   - `PairAttemptTracker` 滑动窗口逻辑 JS/Kotlin 镜像一致：`unlockInMs` 取 `failures[size-maxFailures]`，正确。
   - `handlePairRequest` 状态机顺序合理：先查 lockout（不消耗 slot）→ PIN 不匹配才 `recordFailure` → PIN 对但用户拒不消耗 slot → 成功 `reset`。恶意 PAIR_REQUEST 无 PIN 字段走"协议违规"路径不消耗 slot，设计合理。
   - **❌ blocker 见下**：测试编译失败，无法在 JVM 上验证上述逻辑。
   - 潜在 race（non-blocking）：`userApprovesNext` 是 service 级 `@Volatile var`，多 socket 共享读，但无"每 socket 重置"实现（注释承诺 reset，代码无）。M3'-A 范围内 `userApprovesNext` 恒 false（无 UI setter），PAIR 永走 `user_denied`——**预期范围**（TODO 明确 APK UI 接 `userApprovesNext` 列为"M3'-A 收尾或 M4' 做"），不阻塞本批，但 M3'-B/UI 阶段必须补 setter + 每 socket 重置。

4. **测试**: ❌
   - Node 测试 ✅：`test-m3a-db.js` 13/13、`test-m3a-pairing.js` 17/17，全过。
   - **JVM 测试 ❌**：`./gradlew app:testDebugUnitTest` 在 `:app:compileDebugUnitTestKotlin` 失败，详见 blocker。M3'-A 核心 Kotlin↔JS 向量互操作验证未能在 CI 跑通。
   - 测试向量来源可信：`gen-m3-pairing-vectors.js` 用 Node WebCrypto 从 `secure.js` 生成，Kotlin 测试加载同文件比对，跨语言对齐设计正确——只差编译通过。
   - **文档数量不符**（non-blocking）：CHANGELOG/PROGRESS 称 CryptoPairingTest "12 个 JVM 用例"、"16 个用例（M2 的 4 + M3 的 12）"；实测 `CryptoPairingTest.kt` 含 10 个 `@Test`，`CryptoInteropTest.kt` 含 4 个，合计 14，非 16。

5. **项目约束**: ✅ 分支命名合规；rebase 干净无 M2 残留；commit message 风格统一（`feat(m3):` / `docs(m3):`）；子里程碑 A/B/C 边界在 CHANGELOG/PROGRESS/TODO 三处一致。F 盘/镜像约束未触发（无新外部依赖下载）。

## 必改项 (blocking)

1. **`android/app/src/test/java/com/passman/pair/CryptoPairingTest.kt:100` 编译错误**
   ```kotlin
   val tampered = (real.first() + 1).digitToChar().let { c ->
   ```
   `real.first()` 是 `Char`，`Char + Int` 结果仍是 `Char`，但 Kotlin stdlib **只有 `Int.digitToChar()`，没有 `Char.digitToChar()`**（`Char` 上的扩展是 `digitToInt()`）。编译器报 `Unresolved reference 'digitToChar'` + 两条级联类型推断错误，`:app:compileDebugUnitTestKotlin` FAILED。
   实测复现：`cd F:/Projects/local_password_manager/android && ./gradlew.bat app:testDebugUnitTest` → BUILD FAILED in 49s。
   建议改写为不依赖 `digitToChar` 的翻转逻辑：
   ```kotlin
   val real = Crypto.rollingPin(secret, w)
   val c0 = real.first()
   val c0p = if (c0 == '9') '0' else (c0 + 1)
   val tampered = c0p + real.substring(1)
   ```
   修复后必须重跑 `./gradlew app:testDebugUnitTest` 确认 14 个用例全过再提审。

## 建议项 (non-blocking)

- **`userApprovesNext` 生命周期**（HotspotServerService.kt:105）：注释承诺"每 socket 重置为 false"，但 `handleEncryptedSocket` 内无重置语句，也无 `setUserApproves()` setter。M3'-A 范围内可接受（UI 未接），但 M3'-B/UI 阶段须补：每条 socket 开始时置 false + UI 提供原子 setter，否则多 PC 抢配对时标志串味。
- **`paired-devices.js` 未接服务端**：目前仅 `scripts/test-m3a-db.js` 调用，PC 收到 PAIR_OK 后未调用 `trustDevice` 持久化。属 TODO 明示的"M3'-A 收尾/M4'"，不阻塞本批；但 M3'-A 的 TOFU 持久化尚未端到端打通，仅 DB 层 + 仓库层 + 测试层就绪。
- **JS `verifyPin` 非常量时间**：`lan-pair-protocol.js` `verifyPin` 用 `expected === submittedPin`，与 Kotlin `constantTimeEquals` 不对称。浏览器侧 6 位短命 PIN 风险低，但既然 Kotlin 已做，JS 侧对称实现更稳（M3'-B 顺手补）。
- **文档测试数量**：CHANGELOG "12 个 JVM 用例" → 实际 10；"16 个用例" → 实际 14。更正以免后续误判测试覆盖。
- **`scripts/test-m2-encrypted-channel.js`** 有 9 行改动（diff stat 可见），本次未深审，建议 M3'-B 时一并复核是否仍 4/4 通过。

## 跑测试结果

| 命令 | 结果 |
|------|------|
| `node scripts/test-m3a-db.js` | ✅ 13 passed, 0 failed |
| `node scripts/test-m3a-pairing.js` | ✅ 17 passed, 0 failed |
| `./gradlew app:testDebugUnitTest` | ❌ BUILD FAILED — `:app:compileDebugUnitTestKotlin` 编译错误，`CryptoPairingTest.kt:100` `Unresolved reference 'digitToChar'`，0 用例执行 |

测试在主工作区 `F:/Projects/local_password_manager`（分支 `feature/m3-pairing-sync`，工作树干净）跑；review 工作区未单独装 node_modules/gradle 依赖。

## 下一步

- ❌ **不合并**（审查未通过）。
- 交回 developer 修 blocker：`CryptoPairingTest.kt:100` 的 `digitToChar` 编译错误，重跑 `./gradlew app:testDebugUnitTest` 至全绿。
- 顺手更正文档测试数量（建议项）。
- 修完 re-push `feature/m3-pairing-sync`，reviewer 复审③只验编译 + JVM 测试通过即可放行 merge。

---
🤖 Generated with Claude Code (reviewer agent)
