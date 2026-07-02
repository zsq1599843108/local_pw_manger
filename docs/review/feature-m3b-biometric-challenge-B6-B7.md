# 审查报告: feature/m3b-biometric-challenge — B-6/B-7 wrap

分支: `feature/m3b-biometric-challenge` @ `f229dec`
审查基线: B-5 cut2 `408b864`（✅ 已合入 main 本地 `09afeaa`，待 push）
本次范围 (1 commit): `f229dec` test/docs(m3b): B-6/B-7 wrap — instrumented ESP test + risk register + testplan
审查时间: 2026-07-02T11:50Z
审查人: reviewer agent

## 结论: ⚠️ 小改后通过 — B-7（文档）✅；B-6 instrumented 测试 `freshStore()` 自毁持久化状态，2 个核心用例真机首跑必 FAIL

源码（`FallbackSecretStore` 等）在 B-5 cut2 已审过、无问题；本刀只加测试 + 文档，不动源码。问题出在 **instrumented 测试的 helper 自相矛盾**：`freshStore()` 每次构造实例前都 `deleteSharedPreferences("passman_fallback")`，而多个用例恰恰是用「第二次调 `freshStore()`」来模拟服务重启——这一删，就把本该验证「跨重启持久化」的 K_pin / 锁定期状态全擦了。本环境无真机无法实跑，developer 也只本地编译通过未实跑，所以没暴露。

B-7 的风险登记 + 真机清单文档质量高，直接 ✅。

## 改动摘要
- `FallbackSecretStoreInstrumentedTest.kt` (新, +127, androidTest): 6 个 instrumented 用例——K_pin 幂等、K_pin 随机、PIN 校验往返、3 错锁+跨重启持久化、NOT_SET 降级、重设 PIN 清锁。
- `build.gradle.kts` (+9): `testInstrumentationRunner` + `androidx.test.ext:junit:1.1.5` / `runner:1.5.2` / `core:1.5.0`。
- `docs/m3b-biometric-challenge-design.md` §16 (+18/-3): 加「状态」列，B3/B4/B5 标已实现；新增 B6/B7/B8/B9 风险。
- `docs/m3b-biometric-challenge-testplan.md` (新, +124): §15 六条验收 + §16 风险逐项真机清单。
- `CHANGELOG/MEMORY/PROGRESS/TODO`: 同步。

## 逐项检查

1. **加密/安全: ✅**（本刀不改源码；测试覆盖方向正确）
   - instrumented 测试**意图**正确：验证 K_pin 跨实例幂等、3 错锁并跨「重启」持久化、NOT_SET 降级、重设 PIN 清锁——正是 B-5 cut2 留给 B-6 的真机验证点。
   - 风险登记 B5/B6/B7/B8/B9 描述准确，与 cut2 实现一致（B6=配对不设 PIN 降级、B7=`pendingFallbacks` 残留、B8=ERROR_LOCKOUT 转 fallback、B9=后台拉 Activity）。
2. **数据本地化: ✅** — 测试与文档均不引入网络/外链。
3. **正确性: ⚠️** — 见必改项。`freshStore()` helper 误删持久化状态。
4. **测试: ⚠️**
   - 可跑部分全绿：JS m3b-challenge **33/33**；JVM **24/24**；`:app:lintDebug` **0 error**；`:app:compileDebugAndroidTestKotlin` **BUILD SUCCESSFUL**（androidTest 编译通过）。
   - instrumented 用例**无法在本环境实跑**（无 emulator/真机）。静态走查发现 2 个用例真机必 FAIL、1 个「通过但理由错」（见必改项）。
5. **项目约束: ✅** — 测试依赖版本合理；testplan 文档可执行性强（每项有复现步骤 + checkbox）。

## 必改项 (blocking)

**`android/app/src/androidTest/java/com/passman/pair/FallbackSecretStoreInstrumentedTest.kt:36-40` — `freshStore()` 自毁持久化状态**

`freshStore()` 每次都执行 `ctx.deleteSharedPreferences("passman_fallback")` 再返回新实例。但「模拟服务重启」的用例正是靠第二次调 `freshStore()` 拿新实例——这次删除把要验证持久化的状态擦了：

- **`pinKey_is_idempotent_across_instances` (line 45-57) — 真机必 FAIL**
  `s1.getOrCreatePinKey()` 写入 K_pin → `s2 = freshStore()` 删文件 → `s2.loadPinKey()` 返回 `null` → `assertNotNull("K_pin persisted", k2)` 失败。测试名声称验证「跨重启 K_pin 稳定」，实际删了再读。
- **`three_wrong_pins_lock_and_persists_across_restart` (line 79-94) — 真机必 FAIL**
  3 错 PIN 后 `verifyFallbackPin` 把 lockout persist 到 ESP → `s2 = freshStore()` 删文件 → `s2.restoreLockout(tr2)` 读到空 → `tr2` 未锁 → `assertTrue("lockout persisted across restart", tr2.isLocked())` 失败。**这是 B-6 的核心交付（§8 跨重启锁定），却恰好被测反了。**
- **`setting_pin_clears_prior_lockout` (line 113-127) — 通过但理由错**
  `s2 = freshStore()` 删了 lockout，`assertFalse(...isLocked)` 因删除而成立，**不是**因 `setFallbackPin` 清锁。即 `setFallbackPin` 的「重置锁定期」逻辑（`FallbackSecretStore.kt:91` `.remove(KEY_LOCKOUT)`）没被真正覆盖。
- `fresh_pin_key_is_random` (line 60-64)：两次 `freshStore()` 各删各的、各自 mint，`assertNotEquals` 仍成立——这个碰巧正确（验证两次独立 mint 不同），但 helper 用法同样混淆。

**修复建议**：把「清状态」与「新实例」拆开——
```kotlin
@Before fun resetEsp() {
    ApplicationProvider.getApplicationContext<Context>().deleteSharedPreferences("passman_fallback")
}
private fun newStore() = FallbackSecretStore(ApplicationProvider.getApplicationContext())
```
测试体里「模拟重启」改用 `newStore()`（不删），首实例也用 `newStore()`。这样 K_pin/lockout 才真正跨实例持久，`@Before` 仍保证用例间隔离。
修后这 3 个用例才名副其实；建议补一条「重启后用旧 K_pin 仍能验签」的端到端断言（可选）。

## 建议项 (non-blocking)
1. **testplan AC-5 重放**：步骤 2 让用户从 devtools 抓 RESPONSE 再 `channel.seal(...)` 重发——但 `seal` 会用新 nonce/计数器加密，帧密文变了，PC 解密后 id 仍是被 consume 过的 → `unknown_challenge`。结论对，但「重发同一帧」的措辞容易让人以为是重放密文；建议注明「明文 id 已 consume」是真正的拒因。
2. **B9 风险**：testplan 让测试机「按 Home 后台」测 CHALLENGE——Android 12+ 后台 Service startActivity 多数被静默拦截（非崩溃），`handleFallbackPin` 的 catch 会回 `user_cancelled`。建议 testplan 显式记录「后台时 expected = `user_cancelled` 或无弹窗，不算 bug（M4' 硬化）」，免得测试人误判。
3. **`security-crypto:1.1.0-alpha06`**（cut2 已记，延续）：B-6 真机验过后关注是否有 stable。

## 跑测试结果
- `node scripts/test-m3b-challenge.js` → **33 passed, 0 failed**。
- `:app:testDebugUnitTest` → JVM **24/24**，0 failures。
- `:app:lintDebug` → **0 error, 0 issue**。
- `:app:compileDebugAndroidTestKotlin` → **BUILD SUCCESSFUL**（androidTest 编译通过）。
- `:app:connectedDebugAndroidTest` → **未执行**（本环境无 emulator/真机）。静态走查发现 instrumented 测试逻辑缺陷（见必改项），真机首跑前必须先修。

## 给 developer 的话
1. 修 `freshStore()` helper（必改项），本地至少跑一次 `:app:connectedDebugAndroidTest`（有真机/emulator 的话）或至少再静态走查一遍 6 个用例的预期。
2. 修完 amends 到 `f229dec`（或新 commit），我再复审 B-6 通过后，把 `f229dec` 连同 main 上待 push 的 `09afeaa` 一起处理。
3. **main push 受阻**：B-5 cut2 的 merge commit `09afeaa` 已在本地 main，但 push 到 `origin/main` 被 harness 自动分类器软阻断（"push to default branch bypasses PR review"）。需要用户显式授权 push main，或由用户手动 `git push origin main`。B-6/B-7 通过后建议一并 push。

