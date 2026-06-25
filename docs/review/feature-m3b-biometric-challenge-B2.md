# 审查报告: feature/m3b-biometric-challenge — B-2

分支: `feature/m3b-biometric-challenge` @ `06489e4`
审查基线: B-2 父提交 `074500a`（B-1），单提交隔离审查
审查时间: 2026-06-25
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §4 / §5 / §6 / §11 / §12 / §14（B-2 行）
范围声明: 仅审 B-2 提交（Crypto.kt AAD+Keystore、BiometricChallengeSigner、PAIR_OK enroll、Node 参考向量）。
　　　　　工作区另有未提交的 `ChallengeBridge.kt` / `ChallengePromptActivity.kt` / Service dispatcher / manifest / themes 改动 = **B-3 在途，不在本次范围**。

## 结论: ⚠️ 通过 — 但 1 项 must-fix 须在 B-3 端到端前解决

代码质量高，加密设计正确，跨语言 AAD/HMAC 已逐字节核验一致，Node 自检与向量确定性全绿。
唯一实质问题是 **minSdk 与所用 Keystore/biometric API 级别不匹配**（详见 must-fix）。
该问题不导致编译失败、不导致单测失败、运行时也有兜底降级，故定为「B-3 接入真实 CHALLENGE 前必修」而非阻断 B-2 入 feature 分支。

## 验证证据

- **Node 参考实现自检**（`scripts/gen-m3b-challenge-vectors.js`）：6/6 全绿，exit 0
  - every AAD is 104 bytes / every HMAC is 32 bytes / inputs 确定性复现 aad+hmac / purpose byte @offset 63 / ts big-endian @offset 64 / purpose 绑入 HMAC
- **向量确定性**：重新生成的 JSON 与提交的 `m3b_challenge_vectors.json` **逐字节一致**（9 个向量，含 ts=0 / ts=max-safe-int / 全零 nonce 边界）
- **跨语言 AAD 逐字段核对**（Crypto.kt#buildChallengeAad ↔ gen-m3b#buildChallengeAad）：
  | 字段 | Node | Kotlin | 一致 |
  |---|---|---|---|
  | prefix | `'PassMan-CHAL-v1'` 15B utf8 | `CHAL_AAD_PREFIX` 15B utf8 | ✅ |
  | id | utf8, require 16 | `toByteArray(UTF_8)`, require 16 | ✅ |
  | nonce | 32B raw | require 32 | ✅ |
  | purpose | 0x01/0x02/0x03 | `challengePurposeByte` 同值 | ✅ |
  | ts | `writeBigInt64BE` 8B | `ByteBuffer.putLong`（默认 BE）8B | ✅ |
  | fingerprint | 32B raw digest | require 32 raw | ✅ |
  | 拼接顺序/总长 | 104B | 104B 同序 | ✅ |
  - 运行时互验（JVM 消费 `m3b_challenge_vectors.json`）按设计排在 **B-6**，本次以人工逐字节核对替代。

## 设计一致性要点（做得好的）

1. **§5 偏离判断正确且已记录**：设计 §5 字面写 `KeyGenerator.generateKey()`，但 Keystore 自生成的密钥不可导出，PC 端无法持有同一把对称 HMAC key（与 §6 矛盾）。开发者改为 `SecureRandom` 生成 + `KeyStore.setEntry(SecretKeyEntry, KeyProtection)` **导入**，两端字节相同、Keystore 副本只多一道 bio gate。**这是对设计自身一处内部矛盾的正确修正**，并在 commit/代码注释中显式说明。
2. **§5 Keystore 规格齐全**：`PURPOSE_SIGN` + `DIGEST_SHA256` + `setUserAuthenticationRequired(true)` + `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`（timeout=0 每次需现场指纹）+ `setInvalidatedByBiometricEnrollment(true)`（§9 偷加指纹作废）。StrongBox best-effort，缺失则 TEE 重试（风险 B3）。
3. **§11 抗 Frida 落到实处**：`BiometricChallengeSigner` 用 `CryptoObject(Mac)`，HMAC 仅在 `onAuthenticationSucceeded` 后 `doFinal`；伪造 onSuccess 但 Mac 未真正解锁 → `doFinal` 抛异常 → 算不出 HMAC。`onAuthenticationSucceeded` 里还对「success 但无 CryptoObject」单独判错（never trust bare success）。
4. **异常映射正确**：`KeyPermanentlyInvalidatedException` 在 `initChallengeMac` 与 `doFinal` 两处都捕获 → `KeyInvalidated`（重配对，§9）；`onResult` 保证主线程恰好回调一次。
5. **B-1 mint 竞态已消除**：Service 把 `hmacKeyB64` 提前算一次，既用于 enroll 又用于下发，保证 Keystore 副本与发给 PC 的 key 字节相同（修正了 B-1 评审里两次 `deviceHmacKeyB64()` 的潜在不一致）。

## Must-fix（B-3 接入真实 CHALLENGE 前必修）

**`android/app/build.gradle` `minSdk = 21` 与 B-2 所用 API 级别冲突，且与设计 §12（minSdk 30）矛盾**

B-2 在 `Crypto.kt#enrollDeviceHmacKey` 无条件调用：
- `setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)` — **API 30**
- `KeyProperties.AUTH_BIOMETRIC_STRONG` 常量 — **API 30**

而 `KeyProtection`（API 23）、`setInvalidatedByBiometricEnrollment`（API 24）也都高于 minSdk 21。
仅 `setIsStrongBoxBacked` 做了 `SDK_INT >= P`(28) 守卫，API-30 调用**完全没守卫**。

影响：
- **编译/单测不受影响**（compileSdk=35 的 android.jar 有这些方法，`testDebugUnitTest` 照常通过，B-6 JVM 互验也能跑）。
- **Android Lint `NewApi`** 默认 error，`./gradlew lint` 或 release 构建会报错（除非显式抑制）。
- **运行时**：API 21–29 真机上 `setUserAuthenticationParameters` 抛 `NoSuchMethodError`。当前侥幸被 `HotspotServerService` 的 `catch (t: Throwable)` 兜住 → 记日志 → 走 fallback；但 `enrollDeviceHmacKey` 内部的 `catch (e: Exception)` **接不住 `NoSuchMethodError`**（它是 Error 不是 Exception），是靠外层 Throwable 偶然兜底，机制脆弱。
- 后果：API<30 设备上生物识别主路径**静默不可用**，没有任何显式 gating，是个 footgun。

建议（任选，推荐①）：
1. **把 `minSdk` 提到 30**（与设计 §12「minSdk=30」一致，项目设计本就这么打算）——一行改动，所有上述 API 立即合法。
2. 或保留低 minSdk，但给 `enrollDeviceHmacKey` 加 `@RequiresApi(30)` / `SDK_INT >= 30` 显式守卫，并在 `biometric_capable` / UI 层明示「本机系统过低，仅 PIN 兜底」。

定性：非单测失败、运行时有降级，故不阻断 B-2 入 feature 分支；但 **B-3 把 CHALLENGE 真正接通前必须解决**，否则目标机型矩阵上生物识别行为不可控。

## Notes（非阻断，给后续 step）

1. **手机端缺少 raw key 持久化（设计 §8 的 EncryptedSharedPreferences 副本未实现）**
   B-1 的 `deviceHmacKey` 仍是「按 service 生命周期内存惰性生成」。B-2 把它 enroll 进 Keystore（可跨重启），但 in-memory 原始字节 **未落 EncryptedSharedPreferences**。后果：
   - service 重启后再次 PAIR_OK 会 mint 新 key、覆盖 Keystore、发新 key 给 PC；而 PC 端 `enrollHmacKey` 拒绝换 key（B-1 §9）→ **re-pair-without-revoke 场景 key desync，CHALLENGE HMAC 必失败**。
   - 稳态（配对一次后只 CHALLENGE 不 re-pair）不受影响，因 `initChallengeMac` 直接读 Keystore。
   - §7/§8 的 fallback PIN 路径还需要一份**无 bio gate 的 raw 副本**——也正是这块。
   建议在 **B-5（fallback）** 一并补上 EncryptedSharedPreferences raw 副本，并以它作为 PAIR_OK 下发与 fallback 计算的同一来源。

2. **B-1 遗留 TODO 注释已过时**：`HotspotServerService` 顶部 `TODO(B-2): replace this in-memory mint with AndroidKeyStore enrollment …` 中 Keystore 部分已在本提交完成，注释应更新（保留「EncryptedSharedPreferences 副本未做」即可，见 Note 1）。

3. **设计 §4 注释 `14B` 笔误**：实际前缀 `PassMan-CHAL-v1` = 15 字节。代码（Kotlin 与 Node）均已用 15B 且自洽，开发者也在 Crypto.kt 注释里点明。建议顺手把 `docs/m3b-biometric-challenge-design.md` §4 的「14B」改成「15B」，并把 §5 的 `generateKey()` 更新为「import（见实现偏离说明）」，避免后人误读。

4. **`enrollDeviceHmacKey` 的 `catch (e: Exception)` 偏宽**：第一次 `setEntry` 失败一律 TEE 重试。StrongBox 不可用之外的真实错误（如无安全锁屏）也会触发一次注定再失败的重试，最终异常仍上抛、语义无误，仅略浪费。可缩窄到 `StrongBoxUnavailableException`，非必须。

5. **`BiometricChallengeSigner` 在 B-2 为未被调用的「死代码」**：调用方（B-3 的 ChallengePromptActivity/Bridge）尚未提交，属 plumbing step 预期状态，合理。`setConfirmationRequired(false)` 对高敏 purpose 是否要求二次确认，留待 B-3/B-4 结合 purpose 决策。

## 本次未做的验证（如实记录）

- **未跑 `./gradlew` 编译/JVM 单测/lint**：本审查环境为 PC 侧 review 工作区，未触发 Android 构建。Kotlin 编译性正确性靠人工核对 import 与 API 签名（未见缺失 import，对照 B-1 复审②的 `digitToChar` 类问题做了排查）。**强烈建议 B-6 落地时在真机/CI 跑 `app:testDebugUnitTest`（互验向量）+ `lint`（暴露上面的 NewApi must-fix）+ 一次 instrumented 测试覆盖 Keystore/BiometricPrompt（JVM 单测无法覆盖）。**
- Keystore 导入、BiometricPrompt 流程为 instrumented-only，无法在 JVM 单测验证，本次仅静态审查。
