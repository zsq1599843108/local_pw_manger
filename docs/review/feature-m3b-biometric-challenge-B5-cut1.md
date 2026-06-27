# 审查报告: feature/m3b-biometric-challenge — B-5 (1/2) fallback PIN 第一刀

分支: `feature/m3b-biometric-challenge` @ `1090b52`
审查基线: B-4 `0d2b54f`（上次 ✅ 通过，见 `feature-m3b-biometric-challenge-B4.md`）
main 基线: `0f5cba4`
本次范围 (1 commit): `1090b52` feat(m3b): B-5 (1/2) fallback PIN PC-flow + Kotlin tracker/PBKDF2
审查时间: 2026-06-27T12:40Z
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §7/§8（兜底 PIN + 双副本 hmac_key + 24h lockout）

## 结论: ✅ 通过（B-5 第一刀范围内）— 但有一项**需用户拍板的安全设计决策**留给第二刀，且 B-3 blocker 仍未解

这一刀切得干净、范围克制：**纯 crypto helper + tracker（JVM）+ PC 端 plumbing**，未触碰真正削弱安全模型的那块（non-bio key 副本 / ESP 持久化 / PIN 输入 Activity 按注释留给第二刀）。31/31 JS + 23/23 JVM 全绿，pending TTL/cancel 正好补上了我 B-4 报告的建议项 1。

但有三件事必须在**第二刀（Android 端）落地前**讲清：
1. **[需用户确认]** §7「双副本 hmac_key」一旦在第二刀接线，软门的强制力将**完全依赖 PC 信任手机自报的 `biometric_ok`**，无密码学背书。设计文档 line 173 本就标注「此处需要用户确认」——见下方「给用户的决策点」。
2. **[遗留 blocker]** B-3 的 `Crypto.kt:429` StrongBox 守卫 `P`(28)→`S`(31) 连续两刀未修，第二刀重写 Crypto.kt 时**必须顺手补上**，否则整条分支仍不可合并。
3. **[文档/实现不一致]** §8 写 `argon2id`，实现用 PBKDF2——代码注释给了合理理由，但需同步文档（见建议项）。

## 改动摘要
- `android/.../Crypto.kt` (+119): `hashFallbackPin`/`verifyFallbackPin`(PBKDF2-HMAC-SHA256, 120k, 16B salt, 32B, constant-time + `clearPassword`) + `FallbackPinTracker`(3 次/24h 滑窗 + `snapshot`/`restore` 供 ESP 持久化)。**纯 JVM，无 Keystore/ESP 依赖。**
- `FallbackPinTest.kt` (新, +136): 9 个 JVM 测试覆盖 hash 确定性/盐区分/正误 PIN/锁定/重置/24h 解锁/快照恢复/陈旧剪枝。
- `src/lan-challenge.js` (+35): `PENDING_TTL_MS=150s` + `_prunePending()`（register 时调用，界定 pending 内存）+ `cancel(id)`；**FALLBACK_REQ 不再 consume id**（同一 pending 复用给 PIN 后的 RESPONSE）。
- `src/lan-challenge-routes.js` (+11): `POST /api/lan/challenge/cancel { id }`（幂等，未知 id no-op）。
- `src/public/js/challenge-ui.js` (+143): 抽出 `sealSendAwait`/`postVerify`；新增 §7 fallback 完整流程——`confirmFallback` 用户确认模态 → 发 `FALLBACK_PIN` → 等 PIN 后 RESPONSE → verify；拒绝则调 `/cancel`。
- `scripts/test-m3b-challenge.js` (+64): fallback resume / cancel / TTL prune 单测 + HTTP 路由测试。

## 逐项检查

1. **加密/安全: ⚠️**（这一刀实现无缺陷；⚠️ 指向第二刀的设计决策）
   - PBKDF2 helper 正确：`clearPassword()` 在 finally 擦 char[]；`verifyFallbackPin` 用自实现 `constantTimeEquals`（先比长度再异或累加，无短路）。盐 `SecureRandom` 16B。120k 迭代对 10⁴ 键空间 + 锁定足够（注释论证合理）。
   - `FallbackPinTracker`：`@Synchronized` 全覆盖；`unlockInMs` 取 `failures[size-maxFailures]+window` 是正确的滑窗解锁时点；`snapshot/restore` + `prune` 保证重启不发新 tries（设计 §8 要求，已测）。
   - PC 端 fallback resume 正确：FALLBACK_REQ 保留 pending → PIN RESPONSE 复用 → 成功后 consume（重放防御仍在，已测「resumed fallback id consumed」）。cancel 与 TTL prune 兜住未应答 pending。
   - **⚠️ 第二刀的设计风险**：`biometric_ok` **未绑入 AAD**（AAD=prefix|id|nonce|purpose|ts|fp），且 §7 双副本让 bio 路径与 fallback 路径**用同一把 device_hmac_key**。一旦第二刀把 non-bio 副本写进 ESP，PC 将**无法从密码学上区分**一个 RESPONSE 是真指纹还是 PIN——只能信手机明文上报的 `biometric_ok`。完全受控/被 root 的手机可对任意 purpose 算出合法 HMAC 并谎报 `biometric_ok=true`，绕过「fallback 只许 unlock」的软门。设计 §7 已自述此代价并留 v0.4 升级路径（line 299），line 173 明确要用户确认。**这一刀本身没踩雷（副本未接线），但第二刀会让它生效**——见决策点。
2. **数据本地化: ✅** — fallback 全程本地：PIN 在手机本地比对，PC 只收 HMAC/`biometric_ok`；无网络上传/telemetry/外链。
3. **正确性: ✅** — pending TTL（150s > 60s UI 上限 + fallback 往返，注释论证）；cancel 幂等；challenge-ui 流程分支清晰（ok / 非 fallback 拒绝 / fallback 确认 / 拒绝→cancel / PIN→verify），`confirmFallback` 模态 `done` 标志防重复 resolve，backdrop 点击=deny。`sealSendAwait` 超时仍未 `clearTimeout`（B-4 已记，无害）。
4. **测试: ✅** — 主工作区实跑：
   - `node scripts/test-m3b-challenge.js` → **31 passed, 0 failed**（含 fallback resume / cancel / TTL prune / HTTP 路由）。
   - `:app:testDebugUnitTest` → **BUILD SUCCESSFUL**，CryptoInteropTest 4/4 + CryptoPairingTest 10/10 + **FallbackPinTest 9/9 = 23/23，0 failures**。
   - `node scripts/gen-m3b-challenge-vectors.js` 自检 EXIT 0。
   - 第二刀的 ESP 持久化 / PIN Activity / 跨重启 lockout 属 instrumented-only，须真机覆盖（B-6）。
5. **项目约束: ⚠️** — 分支/提交风格 OK；`FallbackPinTracker` 复用 `PairAttemptTracker` 滑窗模式，一致性好。⚠️ ① §8 文档 `argon2id` vs 实现 PBKDF2（见建议项 1）；② B-3 lint NewApi blocker 仍在（见必改项）。

## 必改项 (blocking — 阻断 feature→main 合并)

**[遗留自 B-3，连续两刀未修] `android/.../Crypto.kt:429` — StrongBox 守卫仍 `P`(28)，应 `S`(31)**
- `1090b52` 上仍 `if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)`。`KeyProtection.Builder#setIsStrongBoxBacked` 是 API 31，minSdk=30 → lint NewApi=error + API 30 真机 `NoSuchMethodError`（详见 B-3/B-4 报告）。
- 第二刀本就重写 Crypto.kt，**请一并把这行改 `>= Build.VERSION_CODES.S`**。B-5 第一刀未引入新 API-level 问题（`PBKDF2WithHmacSHA256`=API26 < minSdk30 OK）。

## ✅ 决策已定（2026-06-27，用户拍板）：§7 走**方案 C（加固）**

用户在本次审查后明确选择 **方案 C**——fallback 不复用 `device_hmac_key`，改用**独立的 PIN-key `K_pin`**：
- 手机：`K_bio`（Keystore，bio-gated）+ `K_pin`（EncryptedSharedPreferences，PIN-gated）两把独立 key。
- PC：`paired_devices` 同存两把。`verify()` 先试 `K_bio` → 命中=biometric（允许全 purpose）；再试 `K_pin` → 命中=fallback（仅 unlock）；都不过 → reject。
- **`biometric_ok` 字段降级为纯展示，不参与鉴权**——软门由「哪把 key 验过」密码学强制，受控手机无法谎报绕过。
> 第二刀必须按此实现，**不要按下面原始 A/B/C 选项默认走 A**。下面三方案对照保留作背景。

## 决策点原始三方案（背景，已选 C）

**§7 fallback「双副本 hmac_key」是否按原设计接线？**
- **方案 A（原设计，双副本）**：Keystore 存 bio-gated 主副本 + EncryptedSharedPreferences 存 non-bio 副本供 PIN 路径算 HMAC。软门强制力 = PC 信任 `biometric_ok` + 拒高敏 purpose。代价：受控手机可谎报绕过软门（已文档化，v0.4 可升级）。UX 好。
- **方案 B（更保守）**：不存 fallback hmac_key 副本，指纹坏掉直接拒绝生物通道，回退到 PC 端原 4 位 token 流程。无软门密码学缺口，但 UX 较糟、且与已写的 PC fallback plumbing/PIN tracker 部分重叠浪费。
- **方案 C（折中，加固）**：fallback 用**独立的** PIN-key（非 device_hmac_key 副本），PC 同存两把、按「哪把 key 验过」判定 bio/fallback，purpose 策略由验证密钥强制而非信 `biometric_ok` 字段。密码学上锁死软门，工作量略增。
> 我（reviewer）的建议：若坚持要 fallback，倾向 C（把软门做成密码学强制，而非信明文字段）；若可接受 UX 代价，B 最稳。A 是设计原案但安全最弱。请用户定夺后再开第二刀。

## 建议项 (non-blocking)
1. **文档 §8 `argon2id` → 实现 PBKDF2 不一致**：代码注释论证合理（无依赖、10⁴ 键空间下锁定才是墙），但 design §8 line 198 + 威胁表 line 250 仍写 argon2id。请同步设计文档，免得后人以为漏实现。
2. **PIN 以 `String` 入参** (`hashFallbackPin(pin: String, ...)`)：`toCharArray()` 副本被 `clearPassword` 擦了，但原 `String` 不可变、无法清零，会在堆里残留至 GC。PIN 本就经明文 JSON 过线，影响有限；若要更干净可改收 `CharArray`。
3. `sealSendAwait` 超时不 `clearTimeout`（B-4 已记）：真实 reply 先到时 60s timer 仍 fire，Promise 已 resolve → no-op，无害。

## 跑测试结果
- `node scripts/test-m3b-challenge.js` → **31 passed, 0 failed**。
- `cd android && ./gradlew :app:testDebugUnitTest` → **BUILD SUCCESSFUL**；JVM **23/23**（Interop 4 + Pairing 10 + FallbackPin 9），0 failures/errors。
- `node scripts/gen-m3b-challenge-vectors.js` 自检 → EXIT 0。
- 未跑 `:app:lintDebug`：B-3 NewApi blocker 状态已静态确认（line 429 仍 `P`）；本刀未新增 API-level 调用。

## 给 developer 的话（第二刀清单，按方案 C）
1. **先解 B-3**：`Crypto.kt:429` 守卫 `P`→`S`，跑 `:app:lintDebug` 确认 NewApi 清零。
2. **fallback 走方案 C（独立 K_pin）**：
   - 手机：配对时除现有 bio-gated `K_bio` 外，再 `SecureRandom.nextBytes(32)` 生成**独立** `K_pin`，存 EncryptedSharedPreferences（PIN-gated，不入 Keystore bio）。PIN 校验通过后用 `K_pin` 算 challenge HMAC。
   - PAIR_OK/ENROLL：把 `K_pin` 也交给 PC（schema 加列，如 `device_pin_hmac_key`）。
   - PC `verify()`：先用 `K_bio`(`device_hmac_key`) 试 → 过则 `biometricOk=true`、允许全 purpose；不过再用 `K_pin` 试 → 过则 `biometricOk=false`、**仅 unlock**；都不过 reject。**purpose 策略改为由「哪把 key 验过」强制，删掉对 `response.biometric_ok` 字段的信任**（字段保留作展示/日志）。
3. ESP 持久化（`device_hmac_key.fallback`→改为独立 `K_pin` / `fallback_pin.{hash,salt}` / `fallback_lockout.failures`）+ PIN 输入 Activity + `FallbackPinTracker.snapshot/restore` 接线，按 §8；instrumented，B-6 真机覆盖。
4. 同步设计文档：argon2id→PBKDF2，并把 §7 双副本原案改记为「方案 C 独立 K_pin（2026-06-27 定）」。
