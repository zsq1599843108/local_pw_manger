# 审查报告: feature/m3b-biometric-challenge — B-6/B-7 wrap（amend 复审）

分支: `feature/m3b-biometric-challenge` @ `7b12640`（amend of `f229dec`）
审查基线: B-5 cut2 `408b864`（✅ 已合入本地 main `09afeaa`，**origin/main 仍 `51f3fcf` 未 push**）
本次范围 (1 commit): `7b12640` test/docs(m3b): B-6/B-7 wrap — instrumented ESP test + risk register + testplan
审查时间: 2026-07-02T20:05Z
审查人: reviewer agent
前置报告: `feature-m3b-biometric-challenge-B6-B7.md` @ `f229dec` 版本（结论 ⚠️，`freshStore()` 必改项）

## 结论: ✅ 通过 — `freshStore()` 必改项已按建议修好，6+1 用例语义全部正确；B-7 文档 ✅（未变）

`f229dec` 版的 blocking 项（`freshStore()` 每次 `deleteSharedPreferences` 自毁持久化状态）已修复：amend 把「清状态」与「新实例」拆开——`@Before resetEsp()` 每用例前擦一次（隔离），`newStore()` 普通构造（不擦，用于模拟服务重启）。静态走查 7 个用例（含新增端到端断言）预期现在名副其实，`@Before` 隔离无误，androidTest 编译通过。真机 `:app:connectedDebugAndroidTest` 仍待跑（本环境无 emulator），但逻辑层面 blocking 已清。

B-7（风险登记 §16 + 真机 testplan）在 `f229dec` 已 ✅；amend 未改文档（diff 仅 androidTest + 文件头注释），仍 ✅。

## 改动摘要（amend 相对 `408b864`，即整刀 `7b12640` 的范围）
- `FallbackSecretStoreInstrumentedTest.kt` (androidTest, +171): 6+1 instrumented 用例——K_pin 幂等、K_pin 随机、PIN 校验往返、3 错锁+跨重启持久化、NOT_SET 降级、重设 PIN 清锁、新增 `persisted_pin_key_still_signs_after_restart` 端到端。
- `build.gradle.kts` (+9): `testInstrumentationRunner` + `androidx.test.ext:junit:1.1.5` / `runner:1.5.2` / `core:1.5.0`。
- `docs/m3b-biometric-challenge-design.md` §16 (+18/-3): 加「状态」列，B3/B4/B5 标已实现；新增 B6/B7/B8/B9 风险。
- `docs/m3b-biometric-challenge-testplan.md` (新, +124): §15 六条验收 + §16 风险逐项真机清单。
- `CHANGELOG/MEMORY/PROGRESS/TODO`: 同步。
- **amend 仅改 androidTest 文件**（+44 行：`@Before`/`newStore()` 拆分 + 新端到端用例 + 注释）；docs/build.gradle/CHANGELOG 与 `f229dec` 一致（已核对 diff stat：design +18/-3、testplan +124、build.gradle +9 均不变）。

## 逐项检查

1. **加密/安全: ✅**（本刀不改源码；测试覆盖方向正确且语义已正）
   - instrumented 测试**意图**现已与实现一致：K_pin 跨实例幂等、3 错锁并跨「重启」持久化、NOT_SET 降级、重设 PIN 清锁、持久化 K_pin 仍能签出 PC 接受的 HMAC——正是 B-5 cut2 留给 B-6 的真机验证点。
   - 风险登记 B5/B6/B7/B8/B9 描述准确，与 cut2 实现一致（B6=配对不设 PIN 降级、B7=`pendingFallbacks` 残留、B8=ERROR_LOCKOUT 转 fallback、B9=后台拉 Activity）。
2. **数据本地化: ✅** — 测试与文档均不引入网络/外链。ESP 仅落盘本机。
3. **正确性: ✅** — 见下方「7 用例静态走查」。`@Before resetEsp()` 隔离正确；`newStore()` 不擦，使「模拟重启」名副其实。
4. **测试: ✅（静态）/ ⚠️（真机未跑）**
   - 可跑部分全绿：JS m3b-challenge **33/33**；JVM **24/24**；`:app:lintDebug` **0 error**（约 30 warning，均 Warning 级，含 cut2 引入的 3 个 `UseKtx` 风格提示，无 NewApi）；`:app:compileDebugAndroidTestKotlin` **BUILD SUCCESSFUL**。
   - instrumented 用例**本环境无真机无法实跑**。静态走查 7 个用例预期均正确（见下），真机首跑预期通过；若跨实例用例在慢机上偶发 flake，关注 ESP `.apply()` 异步落盘（见建议项 1）。
5. **项目约束: ✅** — 测试依赖版本合理；testplan 文档可执行性强（每项有复现步骤 + checkbox）。amend 改写历史（`f229dec`→`7b12640`）：feature 分支为本地私有分支，amend 可接受；reviewer 已以新 hash 为准。

## 7 用例静态走查（`FallbackSecretStoreInstrumentedTest.kt` @ `7b12640`）

`@Before resetEsp()` = `ctx.deleteSharedPreferences("passman_fallback")`（每用例前一次，隔离）；`newStore()` = `FallbackSecretStore(ctx)`（不擦）。

1. **`pinKey_is_idempotent_across_instances`** ✅ — `s1=newStore()` mint k1+persist；`s2=newStore()`（不擦）`loadPinKey()` 读回 k1；`assertNotNull`+`assertArrayEquals(k1,k2)`+`getOrCreate` 复用同 key。**修前必 FAIL（擦了），现正确。**
2. **`fresh_pin_key_is_random`** ✅ — `a=mint`→手动 `resetEsp()`（模拟第二台手机）→`b=mint`；`assertNotEquals(a,b)`。语义清晰（两台独立手机各 mint）。
3. **`setPin_then_correct_pin_verifies_wrong_rejected`** ✅ — setPin 4271→VERIFIED；0000→REJECTED；`assertFalse(isLocked)`（正确 PIN 清零 tracker）。单实例，不涉跨重启。
4. **`three_wrong_pins_lock_and_persists_across_restart`**（B-6 核心交付）✅ — `s1` 3 错→`tr1.isLocked()`；`s2=newStore()`（不擦）+`tr2`→`restoreLockout(tr2)` 读回失败计数→`isLocked()`；`verifyFallbackPin("1234",tr2)==LOCKED`（锁定通道连正确 PIN 也拒）。**修前必 FAIL，现正确——§8「跨重启不赠新尝试」真被测到了。**
5. **`verify_before_pin_set_returns_not_set`** ✅ — 未设 PIN→`NOT_SET`。不涉持久化。
6. **`setting_pin_clears_prior_lockout`** ✅ — `s1` 3 锁→`s2=newStore()`（不擦）`setFallbackPin("9999")`（内部 `.remove(KEY_LOCKOUT)`）→`tr2.restoreLockout()`→`assertFalse(isLocked)`。断言信息「not the restart」现名副其实——清锁是 `setFallbackPin` 的 `.remove` 触发，非文件删除。**修前「通过但理由错」，现真正覆盖 `setFallbackPin` 清锁路径。**
7. **`persisted_pin_key_still_signs_after_restart`**（新增，端到端）✅ — `s1` mint k1→`buildChallengeAad(id=16hex, nonce=32B, "unlock", ts=1, fp=32B)`→`sig1=HMAC(k1,aad)`；`k2=newStore().loadPinKey()`（不擦，读回同 k1）→`sig2=HMAC(k2,aad)`；`assertArrayEquals(sig1,sig2)`。运行时前置条件已逐项核对：`CHAL_ID_HEX_LEN=16`、`CHAL_NONCE_SIZE=32`、`CHAL_FINGERPRINT_RAW_SIZE=32` 均满足 `buildChallengeAad` 的 `require()`。防未来某改动每次实例 mint 新 K_pin 静默打破 PC 副本（§9）。

## 必改项 (blocking)
无。`f229dec` 版的 `freshStore()` 必改项已修复，7 用例语义全部正确。

## 建议项 (non-blocking)
1. **ESP `.apply()` 异步落盘**：`FallbackSecretStore` 全用 `.apply()`（异步写盘，内存缓存同步更新）。同进程内 Android 按 filename 共享 `SharedPreferencesImpl` 缓存，故 `newStore()` 读同文件通常命中内存缓存、无 race。但 `EncryptedSharedPreferences` 包装层行为在极端慢机上未 100% 验证；若真机跨实例用例偶发 flake（读回 null），考虑把生产代码写盘改 `.commit()`（同步）或在测试间加 flush 屏障。**非阻断**——逻辑正确，仅作真机观察点。
2. **testplan AC-5 重放**（沿用 f229dec 版建议）：步骤 2 让用户从 devtools 抓 RESPONSE 再 `channel.seal(...)` 重发——`seal` 用新 nonce/计数器加密，帧密文变了，PC 解密后 id 仍是被 consume 过的 → `unknown_challenge`。结论对，但「重发同一帧」措辞易误读；建议注明「明文 id 已 consume」是真正拒因。
3. **B9 风险**（沿用）：testplan 让测试机「按 Home 后台」测 CHALLENGE——Android 12+ 后台 Service startActivity 多被静默拦截，`handleFallbackPin` catch 回 `user_cancelled`。建议 testplan 显式记「后台 expected=`user_cancelled` 或无弹窗，非 bug（M4' 硬化）」。
4. **`security-crypto:1.1.0-alpha06`**（cut2 已记，延续）：B-6 真机验过后关注是否有 stable。

## 跑测试结果（主工作区 @ `7b12640`，干净）
- `node scripts/test-m3b-challenge.js` → **33 passed, 0 failed**（amend 不动 JS，与 f229dec 同）。
- `:app:testDebugUnitTest` → JVM **24/24**（Interop 4 + Pairing 10 + FallbackPin 9 + ChallengeHmacVector 1），0 failures（amend 不动 JVM 测试）。
- `:app:lintDebug` → **0 error**；约 30 warning（均 Warning 级：SetTextI18n/GradleDependency/OldTargetApi + cut2 引入的 3 个 `UseKtx` 风格提示）。**无 NewApi**（B-3 blocker 保持清零）。
- `node scripts/gen-m3b-challenge-vectors.js` 自检 → EXIT 0。
- `:app:compileDebugAndroidTestKotlin` → **BUILD SUCCESSFUL**（amend 后重验）。
- `:app:connectedDebugAndroidTest` → **未执行**（本环境无 emulator/真机）。静态走查 7 用例预期均正确，真机首跑预期通过（仅 `.apply()` 落盘为观察点，见建议项 1）。

## 合并建议：可合并（含状态澄清）

**B-6/B-7（`7b12640`）✅ 可合入 main。** amend 仅改 androidTest（+docs/build 同 f229dec），不动生产源码；`freshStore()` blocking 已清；JVM/JS/lint/compile 全绿。

**仓库状态澄清（重要，请用户核对）**：
- 本地 `main` = `09afeaa`（merge of `408b864` cut2 + `8cc24df` plan-C，**已含 B-5 cut2**）。
- `origin/main` = `51f3fcf`（**仍未 push**——cut2 的 merge commit `09afeaa` 尚未推到远端）。
- 即：协调方转述的「cut2 + 8cc24df 已 merge main 并 push origin」**前半句成立（本地已 merge）、后半句不成立（origin 未 push）**。reviewer 以 `git rev-parse origin/main` = `51f3fcf` 为准。
- 合 `7b12640` 入 main 会在本地 `09afeaa` 之上加 B-6/B-7；之后 main 的 push（含 `09afeaa` + `7b12640` 合并）由用户显式授权决定。

**M3'-B 真机实测未做** —— ESP `K_pin` 跨重启稳定、`FallbackPinTracker` 跨重启锁定期保留、`FallbackPinActivity` 在 Android 12+ 后台启动限制下的行为、`ERROR_LOCKOUT_PERMANENT`→fallback 切换、6+1 instrumented 用例实跑，均留作 release gate 由用户真机跟踪（见 `docs/m3b-biometric-challenge-testplan.md`）。

**reviewer 不执行 merge / push**——决定权与执行权在用户。

## 给 developer 的话
1. amend 修得好，`@Before resetEsp()` + `newStore()` 拆分正是对症；新端到端用例 `persisted_pin_key_still_signs_after_restart` 是好补充（防 §9 静默轮换）。
2. 真机跑 `:app:connectedDebugAndroidTest` 时关注建议项 1（`.apply()` 跨实例读回），若 flake 再议。
3. main 的 push（`09afeaa` + 本次 `7b12640` 合并）由用户授权；你这边保持 feature 分支不动，等用户拍板。
