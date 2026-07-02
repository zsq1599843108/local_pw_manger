# 审查报告: feature/m3b-biometric-challenge — B-5 (2/2) Android 兜底 PIN（方案 C）

分支: `feature/m3b-biometric-challenge` @ `408b864`
审查基线: `8cc24df`（section7 plan-C PC 侧，未单独审查——本次一并做互操作核对）
main 基线: `51f3fcf`（已合入 B-1..B-5 cut1）
本次范围 (1 commit): `408b864` feat(m3b): B-5 cut2 Android fallback PIN — independent K_pin (plan C)
审查时间: 2026-07-02T11:31Z
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §7 方案 C（独立 K_pin，PC 按「哪把 key 验过」判定）/ §8（ESP 持久化 + 24h 锁定）

## 结论: ✅ 通过（cut2 范围内）— 方案 C 在手机侧落地正确，B-3 遗留 blocker 已解，可合入 main（连同 `8cc24df`）

这一刀把 §7 方案 C 在手机侧完整接线：独立 `K_pin`（ESP，无 bio 门）+ 4 位 PIN（PBKDF2 本地校验 + 3/24h 锁定，跨重启持久化）+ `FALLBACK_PIN` 调度 + 用 `K_pin` 签原始 challenge AAD。**`K_bio` 全程未写 ESP**（核验无任何代码把 `deviceHmacKey` 写入 ESP），软门由「哪把 key 验过」密码学强制，受控手机无法谎报 `biometric_ok` 绕过——与 PC 侧 `8cc24df` 的 `verify()`（先试 `K_bio` 全 purpose → 再试 `K_pin` 仅 unlock，忽略 `biometric_ok` 字段）严格对齐。

- **B-3 遗留 blocker 已修**：`Crypto.kt:429` 现为 `Build.VERSION_CODES.S`（API 31），`:app:lintDebug` 0 error 0 issue。
- 测试全绿：JS m3b-challenge **33/33**，JVM **24/24**（含新增 `ChallengeHmacVectorTest` 1/1，AAD/HMAC 与 Node 字节级一致）。
- ESP/PIN-Activity/跨重启锁定属 instrumented-only，留给 B-6 真机（developer 已在主工作区起 B-6 androidTest 脚手架，未提交，不计入本次范围）。

## 改动摘要
- `Crypto.kt` (+20): `computeChallengeHmac(rawKey, aad)` 纯 `SecretKeySpec` HMAC（无 Keystore，K_pin 路径专用），`KEY_SIZE` 改 public 供 ESP 包装用。
- `FallbackSecretStore.kt` (新, +158): ESP 包装——`getOrCreatePinKey`（幂等，不静默轮换）、`setFallbackPin`（新盐+PBKDF2，重置锁定期）、`verifyFallbackPin`（VERIFIED/REJECTED/LOCKED/NOT_SET 四态，锁定时不查 PIN）、`persistLockout`/`restoreLockout`（跨重启保留失败计数）。
- `FallbackPinBridge.kt` (新, +60): Service↔Activity 握手（`CompletableDeferred` keyed by id），SET/VERIFY 两模式。
- `FallbackPinActivity.kt` (新, +173): 4 位 PIN 输入 UI，SET 双确认，VERIFY 单输入；`reported` 防重复 complete；backdrop/返回=取消。
- `HotspotServerService.kt` (+244): PAIR_OK 携带 `device_pin_key_b64` 并提示设置 PIN；`handleFallbackPin` 全流程（stash→锁定期→PIN 输入→PBKDF2 校验→K_pin 签 AAD→RESPONSE `biometric_ok:false`）；`handleChallenge` 在 `!biometricCapable()` 或 `ERROR_LOCKOUT(_PERMANENT)` 时 stash pending 并发 `FALLBACK_REQ`。
- `ChallengeHmacVectorTest.kt` (新, +65): 消费 `m3b_challenge_vectors.json`，Kotlin AAD/HMAC == Node 字节级。
- `build.gradle.kts` (+7): `androidx.security:security-crypto:1.1.0-alpha06`。
- `AndroidManifest.xml` (+14): `FallbackPinActivity`（`exported=false`、`noHistory`、`excludeFromRecents`）。

## 逐项检查

1. **加密/安全: ✅**
   - 方案 C 落地正确：`K_pin`=`SecureRandom 32B`，ESP 存储，**与 `K_bio` 独立**；`K_bio` 仍只存 Keystore，全文件无任何 `deviceHmacKey`→ESP 写入。PC 按「哪把 key 验过」判定，`biometric_ok:false` 字段降级为展示（PC `verify()` 已忽略，核验 `lan-challenge.js:263-285`）。受控手机无法对 destructive purpose 伪造 `K_bio` HMAC——软门密码学锁死。
   - `getOrCreatePinKey` 幂等（重配对复用同 `K_pin`，PC 存的副本不失效，避免静默轮换强制 re-pair，§9）。
   - PIN 校验走 cut1 已审的 PBKDF2（120k/16B salt/32B/constant-time）；`verifyFallbackPin` 在 `isLocked()` 时**不查 PIN**（锁定通道不可被探测），REJECTED 记失败并 persist，VERIFIED 清零并 persist——每次都 persist，跨重启状态一致。
   - `computeChallengeHmac` 纯 HMAC，无 Keystore，正合 K_pin 无门需求；与 `src/lan-challenge.js#computeChallengeHmac` 字节一致（向量测试 + JS 33/33 互证）。
   - AAD 用**原始** challenge 的 id/nonce/purpose（stash 自 `FALLBACK_REQ`）+ **新 ts**（PC 按 ±30s skew 校验，`lan-challenge.js:243`），重放防御保留。
2. **数据本地化: ✅** — PIN 本地 PBKDF2 比对，PC 只收 HMAC/`biometric_ok`；无网络上传/telemetry/外链。ESP 仅落盘本机。
3. **正确性: ✅**（含若干非阻断小瑕疵，见建议项）
   - 流程分支清晰：`!bio`→FALLBACK_REQ；`ERROR_LOCKOUT(_PERMANENT)`→转 fallback；其余 bio 错误→`bio_failed`。RESPONSE 成功/各错误态都 `pendingFallbacks.remove(id)`，无悬挂。
   - `FallbackPinActivity` SET 模式需双字段一致才启用 submit；VERIFY 模式 4 位即可；`reported` 防双提交；`onBackPressed` 走取消。
   - PAIR_OK 不阻塞于 PIN-set 提示（异步 `ioScope.launch`）；K_pin 在配对时即 mint 并交 PC，PIN 是否已设不影响 K_pin 有效性（后续 setFallbackPin 不动 K_pin）。
   - `pinKeyB64==null`（ESP 失败）时 PAIR_OK 发 `JsonNull`，PC 不存 `device_pin_key` → 该设备 fallback 永不可用，生物路径仍工作。可接受降级。
4. **测试: ✅** — 主工作区实跑（工作区已在 `408b864`，且含 developer 未提交的 B-6 androidTest 脚手架；后者只加 `androidTestImplementation` 依赖与 `testInstrumentationRunner`，不影响 JVM 单测）：
   - `node scripts/test-m3b-challenge.js` → **33 passed, 0 failed**。
   - `:app:testDebugUnitTest` → **BUILD SUCCESSFUL**；JVM **24/24**（Interop 4 + Pairing 10 + FallbackPin 9 + ChallengeHmacVector 1），0 failures。
   - `:app:lintDebug` → **0 error, 0 issue**（B-3 NewApi 清零确认）。
   - ESP/Activity/跨重启锁定为 instrumented-only，须 B-6 真机覆盖。
5. **项目约束: ✅** — 分支/提交风格一致；`FallbackPinBridge` 复用 `ChallengeBridge` 模式；manifest 沿用 prompt Activity 的 `noHistory/excludeFromRecents` 习惯。`security-crypto:1.1.0-alpha06` 为 alpha（见建议项 5）。

## 必改项 (blocking)
无。B-3 遗留 blocker（`Crypto.kt:429` P→S）已于 `2ade2b4` 修复，本次在 `408b864` 上静态 + lint 双重确认。

## 建议项 (non-blocking)
1. **`pendingFallbacks` 在 socket 结束未清理**：`webSocket` 的 `finally`（`HotspotServerService.kt:435-445`）清了 `pairSecret`/`activePeerFingerprint` 但没清 `pendingFallbacks`。若 `FALLBACK_REQ` 发出后 socket 掉线、PC 未发 `FALLBACK_PIN`，该 entry（按 challenge id 键控）成孤儿，留到进程退出。单条 <100B、且新 challenge 用新 id 不会命中，实际泄漏极小。建议在 `finally` 里清空 `pendingFallbacks`（当前设计单 socket 活跃，可全清），或给 entry 加 TTL sweep。
2. **`ioScope` 未在 `onDestroy` 取消**：`launchSetPinPrompt` 的协程最多挂 120s 等 Activity；service 销毁时不取消会滞留。建议 `onDestroy` 里 `ioScope.cancel()`。
3. **非 unlock purpose 仍走 PIN 输入**：`handleFallbackPin` 不查 `purpose`。当 `sync_destructive`/`export_plaintext` 的 challenge 在 `!bio` 或 `ERROR_LOCKOUT` 时转 fallback，用户输完 PIN 签出 `K_pin` HMAC，但 PC 对这些 purpose 根本不试 `K_pin` → `hmac_mismatch`。安全无误（destructive 被正确拒），但 UX 让用户白输一遍。建议手机侧在 stash/`FALLBACK_REQ` 前判断 `purpose ∉ {unlock}` 直接回 error（如 `fallback_not_allowed`），省去 PIN 往返。
4. **PC pending TTL(150s) vs 手机 PIN 超时(120s)+PC 模态时间**：fallback 往返若用户在 PC 模态 + PIN 输入都慢，累计可能超 150s → PC 已 prune pending → RESPONSE 落 `unknown_challenge`。降级为错误而非安全洞，用户可重试；可考虑把 PC 端 fallback 的 pending TTL 调宽，或在 PC 模态确认时再续期。
5. **`security-crypto:1.1.0-alpha06` 为 alpha**：ESP 目前事实标准版本，但 alpha 有 API 变更风险。B-6 真机验证后可关注是否有 stable。
6. **PIN 以 `String` 入参**（cut1 已记，延续）：`char[]` 副本被 `clearPassword` 擦除但原 String 不可清零。影响有限（PIN 已经明文过线），追求洁净可改 `CharArray`。
7. **`verifyFallbackPin` 抛异常统一映射 `pin_not_set`**（`HotspotServerService.kt:741-746`）：ESP 解析异常等被笼统归为 `pin_not_set`，排查时易误判。可分类型映射或至少日志带类型。

## 8cc24df（PC 侧 plan-C）互操作核对
本次基线 `8cc24df` 此前未单独出审查报告，作为 `408b864` 的对端一并核对：
- `lan-challenge.js#verify`：先 `matches(device_hmac_key)`→`biometricOk=true`（全 purpose）；否则 `FALLBACK_ALLOWED_PURPOSES={unlock}` 命中才试 `device_pin_key`→`biometricOk=false`；都不过 `hmac_mismatch`。**不读 `response.biometric_ok`**。与手机侧 `biometric_ok:false` + K_pin 签名严格对齐。✅
- AAD 重建用 `pending.fingerprint`(hex)→raw，等价于手机侧 `SHA-256(myPubkey)`（`Crypto.fingerprintHex` 即 `hex(SHA-256(pub))`，`Crypto.kt:236`）。✅
- `db.js` schema v5 加 `device_pin_key` 列；`lan-pair.js` 从 PAIR_OK ingest `device_pin_key_b64`；`lan-device-routes.js` 暴露 `has_pin_key`。手机 PAIR_OK 发 `device_pin_key_b64`（或 `JsonNull`）匹配。✅
- JS 33/33 含 `lying-biometric_ok-ignored`、`K_pin-export-denied` 两例，直接证伪「受控手机谎报 bio」。✅
建议：合并时把 `8cc24df` 一并合入（它与 `408b864` 是方案 C 的对端对，单合一侧无意义）。

## 跑测试结果
- `node scripts/test-m3b-challenge.js` → **33 passed, 0 failed**。
- `cd android && ./gradlew :app:testDebugUnitTest` → **BUILD SUCCESSFUL**；JVM **24/24**，0 failures/errors。
- `cd android && ./gradlew :app:lintDebug` → **BUILD SUCCESSFUL**；0 error, 0 issue。
- 未跑 instrumented（B-6 真机）。

## 给 developer 的话
1. cut2 通过，可合入 main（建议连 `8cc24df` 一起）。合并前确认主工作区那两处未提交改动（B-6 androidTest 脚手架：`build.gradle.kts` 加 `testInstrumentationRunner`+androidTest 依赖、`androidTest/...InstrumentedTest.kt`）是否要并入下一刀 B-6 提交——**不要混进本次合并**。
2. B-6 真机重点验证：ESP `K_pin` 跨重启稳定、`FallbackPinTracker` 跨重启锁定期保留、`FallbackPinActivity` 在 Android 12+ 后台启动限制下的行为（当前 catch 异常→`user_cancelled` 降级，需真机确认 pairing 前台豁免覆盖）、`ERROR_LOCKOUT_PERMANENT`→fallback 切换。
3. 建议项 1/2（`pendingFallbacks` 与 `ioScope` 清理）可在 B-6 顺手补；建议项 3（非 unlock purpose 短路）是 UX 改进，可单独一刀。
