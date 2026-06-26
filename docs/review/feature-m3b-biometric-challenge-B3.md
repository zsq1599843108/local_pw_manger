# 审查报告: feature/m3b-biometric-challenge — B-3 (+ B-2 must-fix 复核)

分支: `feature/m3b-biometric-challenge` @ `ba7d9ee`
审查基线: B-2 `06489e4`（上次 ⚠️ warn 已记录在 `feature-m3b-biometric-challenge-B2.md`）
本次范围 (3 commits):
- `617f754` feat(m3b): B-3 CHALLENGE dispatcher + biometric prompt host
- `7ed6383` docs: checkpoint（PROGRESS/TODO，纯文档）
- `ba7d9ee` fix(m3b): address reviewer B-2 must-fix (minSdk 30) + cleanups
审查时间: 2026-06-26T10:39Z
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §3/§4/§6/§9/§10/§11/§12

## 结论: ⚠️ 小改后通过 — 1 项 must-fix（lint+运行时同一处），改完即可合

B-3 dispatcher 设计与实现质量高、与 §3/§4/§6/§10 一致；B-2 遗留的 minSdk must-fix 已按推荐方案①修复（21→30），Notes 2/3/4 也一并清理，Note 1 正确延后 B-5。
但**首次跑通 `./gradlew lint` 暴露了一处 fix commit 与 B-2 复审都漏掉的 API-level 错配**：`KeyProtection.Builder#setIsStrongBoxBacked` 实际是 **API 31**，而守卫只有 `SDK_INT >= P`(28)。minSdk 现在正好抬到 30 < 31，于是 **lint NewApi=error 直接让构建失败，且 API 30（新的最低支持机型）真机上该调用会抛 `NoSuchMethodError`**。一行守卫改 `>= S`(31) 即可。**未合并，退回 developer。**

## 跑测试结果（本次首次跑通 Android gradle）

主工作区 `F:/Projects/local_password_manager`（已在 `feature/m3b @ ba7d9ee`，干净）JDK 21 + AndroidSdk：

- **`:app:testDebugUnitTest` → BUILD SUCCESSFUL**
  - `CryptoInteropTest` 4/4 ✅，`CryptoPairingTest` 10/10 ✅ = **14/14，0 failures/errors**
  - `compileDebugKotlin` 通过 → 证明 B-3 三个新文件 + minSdk 30 + 新 import（`StrongBoxUnavailableException`）**主源码全部编译干净**（排除 B-1 复审②那类 `digitToChar` 编译事故）。
- **`:app:lintDebug` → BUILD FAILED（3 errors）**
  1. **`Crypto.kt:428` NewApi**（见 must-fix）— 本分支引入，**blocking**。
  2. `android/gradle.properties:6` PropertyEscape（`org.gradle.java.home=C:/Users/15998/jdk-17.0.13+11` 未转义） — **M1 `a484b32` 引入，非本分支**，见建议项。
  3. `android/local.properties:3` PropertyEscape — **未跟踪文件**（本地 SDK 路径，git 不管），CI 无此问题，仅本机 lint 噪声。

## 逐项检查

1. **加密/安全: ✅** — `BiometricChallengeSigner` 沿用 B-2 的 `CryptoObject(Mac)` 抗 Frida 路径（`doFinal` 仅在真实解锁后；bare success 无 CryptoObject 单独判错）。`handleChallenge` AAD 用 `fingerprintRaw = SHA-256(myPubkey)`，与 Keystore alias 用的 `fingerprintHex = Crypto.fingerprintHex(kp.publicKey) = hex(SHA-256(同一 pubkey))` **同源一致**。ts 由手机选并绑入 AAD，PC 端校验 `|ts-now|<30s`。无硬编码密钥、无明文落盘、无弱随机。
2. **数据本地化: ✅** — 纯本地 SecureChannel 上 CHALLENGE/RESPONSE 收发，无网络上传/telemetry/外链。
3. **正确性: ⚠️**（1 blocking 见下 + 几处非阻断）
   - 校验顺序合理：id（坏 id 直接 drop 不回不可解析的应答）→ purpose → nonce(32B) → `biometricCapable()` → `hasDeviceHmacKey`。
   - `ChallengeBridge` 以 id 为键，`enqueue` 返回的 `CompletableDeferred` 被 Service 直接持有引用 → 即使 `complete()` 已从 map 移除仍能 resolve await；`cancel()` 不 complete，仅在 timeout/启动失败后调用，与 `withTimeoutOrNull` 不冲突；`complete` 对已 cancel 的 id 是 no-op（`results.remove(id)?` 安全）。竞态干净。
   - manifest `configChanges=orientation|screenSize|keyboardHidden|screenLayout` 避免转屏 recreate 中断 prompt；未覆盖 locale/density/uiMode/fontScale 的罕见 recreate 由 `reported` flag + bridge no-op 兜住（最坏多弹一次系统 sheet，不会双 complete）。可接受。
   - **blocking**：`setIsStrongBoxBacked` API-31 守卫错配（见 must-fix）。
4. **测试: ⚠️** — 14/14 既有 JVM 单测全绿，但 **B-3 未补任何自动化测试**。`ChallengeBridge`（纯 JVM：enqueue/peek/complete/cancel + cancel-后-complete no-op 竞态）是可单测的，建议补一个小 JVM 测试；`handleChallenge`/Activity/signer 属 instrumented-only，需 B-6 真机覆盖（Keystore 导入 + BiometricPrompt + JVM 互验向量）。
5. **项目约束: ⚠️** — 分支命名/提交风格 OK；F 盘 gradle cache OK。但 `gradle.properties` committed 了**写死的某用户 JDK 绝对路径**（见建议项，非本分支引入）。

## 必改项 (blocking)

**`android/app/src/main/java/com/passman/pair/Crypto.kt:427-428` — `setIsStrongBoxBacked` 守卫 API 级别错配**

```kotlin
.apply {
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {   // P = 28 ❌
        setIsStrongBoxBacked(true)
    }
}
```

- `KeyGenParameterSpec.Builder#setIsStrongBoxBacked` 确是 API 28，但本处用的是 **`KeyProtection.Builder#setIsStrongBoxBacked`，它是 API 31**（lint 原话：`Call requires API level 31 (current min is 30)`）。B-2 复审把它当「已守卫/OK」是看错了 builder 类型；fix commit 抬 minSdk 到 30 也没盖到这 31 的缺口。
- 后果一（构建）：`./gradlew lintDebug` NewApi=error → **release/lint 构建失败**。
- 后果二（运行时，更严重）：minSdk 现在=30，**API 30 真机进入 `strongBox && 30>=28` 分支 → 调用 31 才有的方法 → `NoSuchMethodError`**。而本次 cleanup 已把 enroll 的 catch 从 `Exception` 收窄到 `StrongBoxUnavailableException`，**接不住 `NoSuchMethodError`（它是 Error）**；只能靠 `HotspotServerService` PAIR_OK 外层 `catch (t: Throwable)` 偶然兜底走 fallback——而 B-5 fallback 还没实现 → 新的最低机型上生物识别主路径静默不可用。
- **修复（一行）**：守卫改 `>= Build.VERSION_CODES.S`（31）。语义也更对：StrongBox 的 `KeyProtection` 支持本就是 31+，<31 退 TEE 即可。改完 lint NewApi 清零、API 30 真机不再崩。

## 建议项 (non-blocking)

1. **补 `ChallengeBridge` JVM 单测**：enqueue→peek→complete 正常路径、cancel 后 complete 应 no-op、并发不同 id 不串。纯逻辑、零 instrumentation 成本，能锁住唯一可单测的 B-3 逻辑。（与 §4 测试维度呼应）
2. **`gradle.properties:6` 写死 JDK 绝对路径 `C:/Users/15998/jdk-17.0.13+11`**（M1 `a484b32` 引入，**非本分支责任**，故不阻断本次）：① PropertyEscape lint error（应写 `C\:/...`）；② 换机/CI 上路径不存在会断。说明：lint 自 M1 起就因这两条 PropertyEscape 一直 FAILED，故本项目历史上 **lint 并非硬门禁**——这也是 must-fix 的 NewApi 此前一直没被发现的原因。建议另开 chore 把 `org.gradle.java.home` 从 committed `gradle.properties` 挪到本地 `gradle.properties`/环境，或删掉（JDK 21 已在 PATH，AGP 实测可跑）。
3. `handleChallenge` 里 `buildChallengeAad` 抛异常一律映射成 `bad_nonce`，但理论上 id 含非 ASCII 致 UTF-8 字节数>16 也会进这分支（标签略误导）。PC 生成的是 ascii hex id，无害，留意即可。
4. `mapBiometricError`：`ERROR_LOCKOUT_PERMANENT → bio_failed`，应切 fallback PIN——已标 `TODO(B-5)`，OK。
5. **PC 端尚无 CHALLENGE 发送方**（review 工作区全仓 grep 无 `CHALLENGE`/`hmac_b64`/`FALLBACK_REQ`）。B-3 dispatcher 目前端到端**不可被触发**（plumbing step 预期状态，PC sender 属后续步骤）。叠加 M3'-A 每连接重生 keypair 的 `unknown_device` 限制（已在 commit/代码/决策记录留痕，延后 M4'），B-3 真正端到端验证须等 PC sender + 持久身份。本次仅静态 + 单测 + lint 验证。

## 设计一致性要点（做得好的）

- **B-2 must-fix 主体已正确修**：`minSdk 21→30`（采纳推荐方案①，注释点明「30 是硬下限不是图省事」），与设计 §12 一致；`setUserAuthenticationParameters` / `AUTH_BIOMETRIC_STRONG`（均 API 30）随之合法。
- **Note 4 已修**：StrongBox 重试 catch 从 `Exception` 收窄到 `StrongBoxUnavailableException`（minSdk 30 下可 import）——方向对（仅与上面的 must-fix 叠加产生了「接不住 NoSuchMethodError」的副作用，修完守卫即解）。
- **Note 2/3 已修**：`HotspotServerService` 过时的 `TODO(B-2)` 注释刷新为「B-2 done / TODO(B-5) EncryptedSharedPreferences mirror」；design §4 `14B→15B`、§5 `generateKey()` 实现偏离已在 doc 标注。
- **Note 1（§8 EncryptedSharedPreferences 无 bio-gate 副本）正确延后 B-5**，且 developer 已在 PROGRESS 记录 2026-06-26 §7 fallback 方案 A 决策，闭环清晰。
- Activity 卫生到位：`exported=false` + `noHistory` + `excludeFromRecents` + 透明 theme（只露系统指纹 sheet）+ `configChanges`。
- `withTimeoutOrNull(60s)` 给 prompt 留余量，真实 30s 新鲜度由 PC 校 ts 把关，分层正确。

## 本次未做的验证（如实记录）

- 未跑 instrumented 测试（Keystore 导入 / BiometricPrompt / Service→Activity 拉起 / 跨连接 unknown_device）——JVM 无法覆盖，须 B-6 真机。
- 未端到端验证 CHALLENGE/RESPONSE（PC sender 未实现）。
- 主工作区 `PROGRESS.md` 有 developer 未提交的在途改动（2026-06-26 §7 决策 + must-fix 复核标记），**非本次 review 产物、未触碰**。

## 给 developer 的话

只差一行（`Crypto.kt:428` 守卫 `P`→`S`）。改完建议本机或 CI 再跑一次 `:app:lintDebug` 确认 NewApi 清零（PropertyEscape 那两条属历史/本地，可单独处理或本次顺手把 committed JDK 路径挪走），然后回 reviewer 复核即可合并入 main。
