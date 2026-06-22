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
