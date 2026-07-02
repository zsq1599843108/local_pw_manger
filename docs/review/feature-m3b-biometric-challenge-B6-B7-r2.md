# 审查报告（复审）: feature/m3b-biometric-challenge — B-6/B-7 wrap (修复后)

分支: `feature/m3b-biometric-challenge` @ `7b12640`（amend 自原 `f229dec`）
审查基线: B-5 cut2 `408b864`（已合入 main `09afeaa`，origin/main 已同步）
复审范围: `f229dec` → `7b12640` 的差异（仅 instrumented 测试文件 `FallbackSecretStoreInstrumentedTest.kt` 改动）
前次报告: `docs/review/feature-m3b-biometric-challenge-B6-B7.md`（⚠️ 小改后通过，必改项 = `freshStore()` 自毁持久化）
审查时间: 2026-07-02T12:10Z
审查人: reviewer agent

## 结论: ✅ 通过 — 必改项已正确修复，原 3 个问题用例名副其实，新增端到端用例补强

修复方向与建议完全一致：把「清状态」(`@Before resetEsp()`，每测试一次) 与「新实例」(`newStore()`，普通构造不删) 拆开。「模拟服务重启」改用 `newStore()`，K_pin / 锁定期真正跨实例持久，原 3 个被测反的用例现在测对了。额外补了一个端到端「重启后 K_pin 仍能验签」用例，覆盖 §9 静默轮换风险。

源码未动（cut2 已审），B-7 文档未变（已 ✅）。

## 改动摘要（相对前次 `f229dec`）
- `FallbackSecretStoreInstrumentedTest.kt` (+44)：拆 helper（`@Before resetEsp()` + `newStore()`）；5 个原用例 `freshStore()`→`newStore()`；`fresh_pin_key_is_random` 中间显式 `resetEsp()` 模拟第二台手机；新增 `persisted_pin_key_still_signs_after_restart`（重启后 K_pin 签名一致）；类注释记录修复理由。

## 逐项检查

1. **加密/安全: ✅** — 测试意图与 cut2 实现对齐，覆盖方向正确（K_pin 幂等/持久、lockout 跨重启、NOT_SET 降级、重设清锁、K_bio 不入 ESP）。
2. **数据本地化: ✅** — 仅测试 + 文档，无网络/外链。
3. **正确性: ✅** — 走查新 helper 下原 3 个问题用例的预期：
   - `pinKey_is_idempotent_across_instances`：s1 写 K_pin → s2=`newStore()` 不删 → `loadPinKey()` 读回同一 K_pin → `assertNotNull`+`assertArrayEquals` 真验证持久化（原前次这里读到 null 会 FAIL）。✅
   - `three_wrong_pins_lock_and_persists_across_restart`：3 错 persist 到 ESP → s2 不删 → `restoreLockout` 读回 → `isLocked()` 真（B-6 §8 核心交付，原前次测反）。✅
   - `setting_pin_clears_prior_lockout`：s2=`newStore()` 不删 → `setFallbackPin("9999")` 内部 `.remove(KEY_LOCKOUT)` 清锁 → `restoreLockout` 读到空 → 未锁。**现在通过理由正确**（setFallbackPin 清的，不是删除），原前次理由错。✅
   - `fresh_pin_key_is_random`：mint a → `resetEsp()` 清 → mint b，两次独立 mint 不同。✅
   - 新增 `persisted_pin_key_still_signs_after_restart`：s1 mint K_pin 签 AAD → s2 读回 K_pin 签同 AAD → `assertArrayEquals`，端到端证 K_pin 跨重启是 live key 不是 stale copy。✅
4. **测试: ✅** — 可跑部分全绿：JS m3b-challenge **33/33**；JVM **24/24**；`:app:lintDebug` **0 error**；`:app:compileDebugAndroidTestKotlin` **BUILD SUCCESSFUL**（含新增 `persisted_pin_key_still_signs_after_restart`）。instrumented 须 B-6 真机实跑（本环境无设备），但逻辑已静态走查无误。
5. **项目约束: ✅** — amend 进原 commit 保持历史整洁；helper 拆分符合 JUnit 惯例。

## 必改项 (blocking)
无。前次必改项（`freshStore()` 自毁持久化）已修。

## 建议项 (non-blocking)
1. 前次报告的建议项 1/2/3（testplan AC-5 措辞、B9 后台 expected 文案、security-crypto alpha）仍未并入，属文档润色，可后续或 B-6 真机实测时顺手补。
2. **amend 未推送**：`7b12640` 在本地 feature，`origin/feature/m3b-biometric-challenge` 仍指向旧 `8cc24df`（pre-amend）。合并前需 developer force-push feature，或由合并者直接用本地 `7b12640`。

## 跑测试结果
- `node scripts/test-m3b-challenge.js` → **33 passed, 0 failed**。
- `:app:testDebugUnitTest` → JVM **24/24**，0 failures。
- `:app:lintDebug` → **0 error, 0 issue**。
- `:app:compileDebugAndroidTestKotlin` → **BUILD SUCCESSFUL**。
- `:app:connectedDebugAndroidTest` → 未执行（无 emulator/真机）；instrumented 逻辑已静态走查。

## 给 developer 的话
1. B-6/B-7 复审通过，可合并。**注意 `7b12640` 是 amend、未推 origin**：合并前请 force-push feature（`git push --force-with-lease origin feature/m3b-biometric-challenge`），否则 origin 上仍是旧 `f229dec`→`8cc24df` 状态。
2. 合并方式建议：`git merge --no-ff 7b12640`（连同已合的 cut2，本次只增量 B-6/B-7 这一个 commit）。
3. instrumented 真机实跑（`connectedDebugAndroidTest`）+ testplan 六条 AC 仍是 B-6 的最终签字项，留真机环境执行。
