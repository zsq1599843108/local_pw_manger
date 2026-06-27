# 审查报告: feature/m3b-biometric-challenge — B-4 (PC-side challenge verify + challenge-ui)

分支: `feature/m3b-biometric-challenge` @ `0d2b54f`
审查基线: B-3 `ba7d9ee`（上次 ⚠️ small-fix 已记录在 `feature-m3b-biometric-challenge-B3.md`）
main 基线: `0f5cba4`
本次范围 (1 commit): `0d2b54f` feat(m3b): B-4 PC-side challenge verify + challenge-ui
审查时间: 2026-06-27T12:25Z
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §3/§4/§6/§7

## 结论: ✅ 通过（B-4 范围内）— 但整条分支 **不可合并**，B-3 遗留 blocker 仍未修

B-4 是纯 PC 端（Node + 浏览器）的 CHALLENGE/RESPONSE 验证 plumbing：质量高，与 §3/§4/§6/§7 一致，22/22 测试全绿，vectors 单一真源重构干净，无网络/数据外泄、加密路径正确（HMAC + `timingSafeEqual` + 新鲜度 + 重放 + 用途策略）。**B-4 自身可接受。**

但本次审查在 `0d2b54f` 上确认：**B-3 报告的唯一 must-fix（`Crypto.kt:427` StrongBox 守卫 `P`(28)→`S`(31)）至今未修**——B-4 没碰 Android，blocker 原样带过来。主工作区当前有未提交的 `Crypto.kt` 改动，但只是 B-5 的 PBKDF2 import（`SecretKeyFactory`/`PBEKeySpec`），**与该 must-fix 无关**。
→ **B-4 这一步通过，但 feature→main 合并仍被 B-3 blocker 卡住**，须先补那一行再整体合。本次不 merge。

## 改动摘要
- `src/lan-challenge.js` (新, 253): AAD 构造 + HMAC + `ChallengeVerifier`（待验/重放/新鲜度/§7 软门），**字节级单一真源**。
- `src/lan-challenge-routes.js` (新, 82): `/api/lan/challenge/create` + `/verify` 两个路由；`device_hmac_key` 留在 PC。
- `src/public/js/challenge-ui.js` (新, 112): 浏览器 glue，复用 lan-pair 的 live SecureChannel 转发 frame、回收 RESPONSE。
- `src/public/js/lan-pair.js` (+27): onmessage 路由 RESPONSE/FALLBACK_REQ 到 one-shot resolver；暴露 `PassManChannelStash`。
- `scripts/gen-m3b-challenge-vectors.js` (-47): 从「自带 spec」改为 **import** `src/lan-challenge.js` 的 spec，三端（Kotlin/Node verifier/vectors）单一真源。
- `scripts/test-m3b-challenge.js` (新, 260): 16 单测 + 6 路由测试。
- `src/server.js` (+7) / `phone.html` (+1): 接线。

## 逐项检查

1. **加密/安全: ✅** —
   - AAD = `prefix(15)||id(16)||nonce(32)||purpose(1)||ts_be(8)||fp_raw(32) = 104B`，与 Crypto.kt/vectors 字节一致（测试断言 offset 63 purpose、offset 64 ts_be、prefix、总长 104）。
   - HMAC 用 `crypto.timingSafeEqual`，长度先校验 32B 再比较（不会因长度不等抛异常）。
   - **验证只信 PC 侧存储**：AAD 由 `pending.fingerprint`（注册时绑定）+ `pending.nonce/purpose` 重算，手机只能影响 `ts`（绑入 AAD 且 ±30s 新鲜度校验）和 `hmac`。手机**无法**替换 nonce/purpose/fingerprint。
   - 重放防御：成功/失败一律 `_consume(id)`（除 `unknown_challenge` 早返回，避免污染 used set）；replay 测试 first ok → second `unknown_challenge`。
   - `device_hmac_key` 不出进程，浏览器只见 `has_hmac_key` 布尔（与 §设计一致）。无硬编码密钥、无明文落盘、无弱随机（`crypto.randomBytes`）。
2. **数据本地化: ✅** — 全程本地 SecureChannel + localhost API，无网络上传/telemetry/外链。
3. **正确性: ✅**（无 blocking，2 处非阻断见建议项）
   - 校验顺序合理：id 存在性 → FALLBACK_REQ → phone error → 类型 → 设备/key 存在 → §7 软门（`biometric_ok` + purpose）→ 新鲜度 → hmac base64/长度 → AAD 重算 → 常量时间比较 → 成功后盖 `last_challenge_at`/`last_fallback_at`。
   - `touchChallengeAt`/`touchFallbackAt`/`findByFingerprint` 在 `paired-devices.js`(B-1 schema v4) 确实存在，调用签名匹配。
   - challenge-ui `pc_timeout` 兜底：超时 resolve 成 `{t:'RESPONSE',id,error:'pc_timeout'}` → 仍会 POST /verify → 命中 error 分支 consume，**正常 UI 流不会泄漏 pending**。
4. **测试: ✅** — 主工作区 `node scripts/test-m3b-challenge.js` → **22 passed, 0 failed**（16 单测含 happy/wrong-key/stale/replay/fallback 三用途/phone-error/FALLBACK_REQ/unknown-id/AAD 字节；6 路由含 create-ok/verify-ok/no_hmac_key-409/unknown-404/bad_purpose-400/stale）。`node scripts/gen-m3b-challenge-vectors.js` 自检 **EXIT 0**（证明 import 重构后 Node verifier 仍复现 vectors）。注入时钟/randomBytes 使测试确定性，做法干净。
5. **项目约束: ✅** — 分支命名/提交风格 OK；B-4 无新 npm 依赖（复用 express/better-sqlite3/crypto）；路由拆出 server.js 便于挂 in-memory sqlite 测试，工程化好。

## 必改项 (blocking — 阻断 feature→main 合并，非 B-4 引入)

**[遗留自 B-3] `android/app/src/main/java/com/passman/pair/Crypto.kt:427` — `setIsStrongBoxBacked` 守卫仍是 `P`(28)，应为 `S`(31)**
- `0d2b54f` 上 `if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)` 原样未改。该处是 `KeyProtection.Builder#setIsStrongBoxBacked`（API 31），minSdk=30 < 31 → ① `lintDebug` NewApi=error 构建失败；② API 30 真机进分支抛 `NoSuchMethodError`（详见 B-3 报告 §必改项）。
- 一行修复：守卫改 `>= Build.VERSION_CODES.S`。**B-4 不含 Android 改动，故此项不计入 B-4 评级**，但合并前必须解决。

## 建议项 (non-blocking)

1. **`ChallengeVerifier._pending` 无 TTL/上限**（`src/lan-challenge.js` `register`/`_consume`）：`_usedIds` 有 `REPLAY_WINDOW` 上限，但 `_pending` 仅在 verify 时删除。正常 UI 流靠 `pc_timeout` 回收；若直接打 `/create` 而从不 `/verify`（攻击者具备 localhost API 访问 / 浏览器异常关闭），`_pending` 无界增长 → 低危内存 DoS。建议给 pending 加按 `createdAt` 的 TTL 清理或条数上限。
2. **PC 信任手机自报的 `biometric_ok` 布尔来执行 §7 软门**（`verify` 里 `biometricOk = response.biometric_ok === true`）：目前安全，**前提是 `device_hmac_key` 严格生物识别门禁**（B-2 Keystore `AUTH_BIOMETRIC_STRONG`）——有效 HMAC 即证明发生了生物解锁，PIN fallback 物理上产不出有效 HMAC，故无法伪报 `biometric_ok=true` 绕过 destructive/export。**给 B-5 的提醒**：若 PIN fallback 路径将来拿到同一把 HMAC key，软门即失效；fallback 必须用独立密钥/独立判定。
3. **`challenge-ui.js` 超时不 `clearTimeout`**：真实 reply 先到时 60s timer 仍会 fire，但 Promise 已 resolve → no-op；同时 timeout 先到时 lan-pair 的 `_challengeReplyResolver` 残留未清（晚到 reply 调它也是 no-op）。无害，留意即可。

## 跑测试结果
- `node scripts/test-m3b-challenge.js`（主工作区 @0d2b54f）→ **22 passed, 0 failed**。
- `node scripts/gen-m3b-challenge-vectors.js`（self-check）→ **EXIT 0**（vectors 单一真源复现通过）。
- 未跑 Android gradle/lint：B-4 无 Android 改动；B-3 的 lint NewApi blocker 状态已在上方静态确认（`Crypto.kt:427` 仍 `P`）。

## 给 developer 的话
B-4 本身可以收下。只剩 B-3 那一行（`Crypto.kt:427` 守卫 `P`→`S`）没补——把它补上、本机或 CI 再跑一次 `:app:lintDebug` 确认 NewApi 清零，整条 `feature/m3b-biometric-challenge` 即可回 reviewer 复核后合并入 main。建议项 1/2 可在 B-5 一并处理。
