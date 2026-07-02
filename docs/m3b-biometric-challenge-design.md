# M3'-B 设计草案 — 生物识别 CHALLENGE / RESPONSE

> 状态：**草案 (draft)**，等用户确认后再实现。
> 父设计：[wifi-hotspot-design.md](wifi-hotspot-design.md)（v0.3 总体协议）
> 前置依赖：M3'-A 配对（`feature/m3-pairing-sync`，等 reviewer 复审③）
> 后续：M3'-C 全量同步（CHALLENGE 通过后才允许 SYNC_*）

## 1. 目标

在「PC 拿不准用户身份」的关键时刻，让**手机背后那个真人**通过指纹证明在场，并把这件事**绑定到一次具体的 PC 请求**上（防重放、防 root 软门）。

应用场景（v0.3 范围内）：
- 解锁 PC 端密码库（替代主密码输入）
- 高敏 sync 操作前（删条目、改主密码、导出明文）

非目标（v0.3 不做）：
- 远程证明（PC 离手机 > 10m 也能用）→ v0.4+
- 多手机投票 → v0.5+
- 离线挑战 → v0.5+（需要 PC 缓存挑战预签）

## 2. 决策：用 Keystore HMAC 硬绑定（方案 B）

已与用户确认（2026-06-23）。

| 备选 | 否决理由 |
|---|---|
| A. 软门（onSuccess 回调里 if-success 发响应） | TEE 不担保；root + Frida hook `BiometricPrompt` 可绕过；reviewer 视角看像"没做" |
| **B. Keystore HMAC + bio gate** ✅ | TEE 担保 biometric_ok；HMAC 计算密钥本身被 `setUserAuthenticationRequired(true)` 锁住，没指纹通过连 HMAC 都算不出 |
| C. Ed25519 设备签名 + bio gate | ECDH+GCM 已防 MITM；HMAC 已防伪造；Ed25519 多一套密钥管理无对应收益；留 v0.4 |

## 3. 协议帧

应用层 JSON over M2' SecureChannel（与 M3'-A 同管道）。

```
PC -> phone     CHALLENGE  { t:"CHALLENGE", id, nonce_b64, purpose }
phone -> PC     RESPONSE   { t:"RESPONSE",  id, hmac_b64, ts, biometric_ok:true }
phone -> PC     RESPONSE_  { t:"RESPONSE", id, error:"bio_failed"|"bio_unavailable"|
                            "user_cancelled"|"unknown_purpose"|"unknown_device"|
                            "key_invalidated"|"bad_nonce" }
phone -> PC     FALLBACK_REQ { t:"FALLBACK_REQ", id, reason:"bio_unavailable" }
PC   -> phone   FALLBACK_PIN { t:"FALLBACK_PIN", id, pin:"1234" }
phone -> PC     RESPONSE      ... biometric_ok:false（同上结构）
```

> **B-3 实现新增两个 error code**（不在初稿 §3 枚举里，实现时发现需要）：
> - `key_invalidated` — 用户改了指纹库 → Keystore key 作废（`KeyPermanentlyInvalidatedException`）→ PC 应提示「设备身份变了，请重新配对」（§9）。
> - `bad_nonce` — CHALLENGE 的 `nonce_b64` 解不出 32B（协议违规，正常不会发生）。

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (16 hex) | PC 生成的本次挑战标识；RESPONSE 必须 echo |
| `nonce_b64` | base64(32B) | PC `crypto.randomBytes(32)`；HMAC 输入；防重放 |
| `purpose` | enum: `unlock` \| `sync_destructive` \| `export_plaintext` | 进 HMAC AAD；防同一 nonce 跨用途换义 |
| `ts` | int64 ms | 手机响应时刻；PC 校验 `\|ts - now\| < 30s` |
| `hmac_b64` | base64(32B) | `HMAC-SHA256(device_hmac_key, AAD)`，AAD 见 §4 |
| `biometric_ok` | bool | **纯展示，PC 不信任**（方案 C）。PC 由「K_bio 还是 K_pin 验过 HMAC」判定 bio/fallback，不读此字段 |

`FALLBACK_PIN` 只在手机端 `BiometricManager.canAuthenticate()` 返回非 SUCCESS 时使用（无硬件 / 未录入指纹 / 临时不可用）。回退是**4 位 PIN**，沿用 v0.2 的 token 路径——与 M3'-A 的 6 位配对 PIN **不同**，目的是给"指纹临时坏了"留生路，不应等价于身份证明。详见 §7。

## 4. HMAC 输入定义

```
AAD = "PassMan-CHAL-v1"               // 15B 协议域分隔，防与其它 HMAC 用途串
    || id           (16B utf8 hex)
    || nonce        (32B raw)
    || purpose_byte (1B: 0x01 unlock / 0x02 sync_destructive / 0x03 export_plaintext)
    || ts_be        (8B, big-endian int64 ms)
    || fingerprint  (32B raw, phone 的 X25519 公钥 SHA-256，与 paired_devices.fingerprint 同源)

hmac = HMAC-SHA256(device_hmac_key, AAD)
```

为什么把 `fingerprint` 放进 AAD：防止「同一 PC 同时被两台已配对手机连」情况下，A 手机签的响应被中间人塞到 B 手机的会话里。PC 验证时取**本次 SecureChannel 协商出的对端 fingerprint**作为预期 fingerprint，不是 RESPONSE 里 echo 回来的——echo 回来的可信度等于 0。

为什么不重用 M3'-A 的 `pairSecret`：`pairSecret` 是每次 ECDH 派生的**会话级**值，重连即变，无法持久化为「设备身份」。`device_hmac_key` 是 paired_devices 行里持久化的，跨连接稳定。

## 5. Android Keystore 密钥规格

```kotlin
val spec = KeyGenParameterSpec.Builder(
    "passman.device_hmac.${fingerprintHex(myPubkey)}",   // 一台手机一对密钥；多 PC 配对共享
    KeyProperties.PURPOSE_SIGN
)
    .setKeySize(256)
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setUserAuthenticationRequired(true)                  // 关键：HMAC 必须先过 bio
    .setUserAuthenticationParameters(
        0,                                                 // timeout=0 → 每次都要 bio
        KeyProperties.AUTH_BIOMETRIC_STRONG
    )
    .setInvalidatedByBiometricEnrollment(true)             // 用户新增/删指纹 → key 作废
    .setIsStrongBoxBacked(strongBoxAvailable())            // 有 StrongBox 走 HW；没有降级 TEE
    .build()

KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore")
    .apply { init(spec) }
    .generateKey()
// ⚠️ 实现偏离：实际未用 generateKey()。Keystore 内生成的 key 不可导出，PC 拿不到
//    对称 HMAC 副本（违反 §6）。改为 SecureRandom 生成 32B raw → KeyStore.setEntry
//    带 bio-gate 的 KeyProtection 导入，同一 raw 也发 PC。详见决策记录 2026-06-25
//    及 Crypto.enrollDeviceHmacKey 注释。上方 spec 的 bio-gate 参数等价迁到 KeyProtection。
```

要点：
- **`PURPOSE_SIGN`** + `KEY_ALGORITHM_HMAC_SHA256`：Keystore 把它当 HMAC，签名输出就是 mac
- **`setUserAuthenticationRequired(true) + timeout=0`**：每次 `Mac.init(key)` 之前必须有 BiometricPrompt 解锁 CryptoObject，否则 init 抛 `UserNotAuthenticatedException`
- **`AUTH_BIOMETRIC_STRONG`（Class 3）**：与 BiometricDemoActivity 的 promptStrong 一致，弱生物识别（人脸 Class 2）走不通
- **`setInvalidatedByBiometricEnrollment(true)`**：用户偷偷加新指纹会让 key 作废，迫使重新配对—— **此情况手机端 verify 抛 `KeyPermanentlyInvalidatedException`，捕获后弹"指纹库变了，请回 PC 重新配对"**
- **StrongBox 可选**：Pixel 6+/小米 14/三星 S22+ 有，降级 TEE 不影响安全模型，只是抗物理拆机弱一些

## 6. 调用顺序图

```
PC                                  Phone (Ktor)              Android Keystore
 │   CHALLENGE (over SecureChannel) │
 ├─────────────────────────────────►│
 │                                  │  enqueue (id, nonce, purpose)
 │                                  │  postToUiThread {
 │                                  │    BiometricPrompt
 │                                  │      .authenticate(
 │                                  │        promptInfo,
 │                                  │        CryptoObject(Mac.init(hmacKey))
 │                                  │      )                      │
 │                                  │                              │
 │                                  │                              │  (TEE: verify
 │                                  │                              │   fingerprint
 │                                  │                              │   sensor input;
 │                                  │                              │   unlock key
 │                                  │                              │   for THIS Mac
 │                                  │                              │   instance only)
 │                                  │  ◄─────────────────────────  │
 │                                  │  result.cryptoObject.mac
 │                                  │    .update(AAD).doFinal()
 │                                  │  }
 │   RESPONSE { id, hmac, ts }      │
 │◄─────────────────────────────────┤
 │
 │  PC verify:
 │  - row = paired_devices[fingerprint of channel peer]
 │  - hmac_key = row.device_hmac_key  ── HMAC verify 是对称的
 │  - expected = HMAC-SHA256(hmac_key, AAD-with-stored-fingerprint)
 │  - constant-time compare(hmac, expected)
 │  - |ts - now| < 30s
 │  - id 没在最近 1000 个 used_ids 里出现过（重放短期窗口）
 │
 │  → 通过：进入 unlock 状态 / 允许 sync_destructive
```

**关键：HMAC 是对称的**，PC 端必须存同样的 `device_hmac_key`。M3'-A 的 PAIR_OK 阶段需要扩展为同时交换这个 key——见 §8。

## 7. 4 位码兜底路径

触发条件（手机端）：
- `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` 返回 `NO_HARDWARE` / `HW_UNAVAILABLE` / `NONE_ENROLLED`
- 或前一次 `BiometricPrompt` 抛 `ERROR_LOCKOUT_PERMANENT`（连续多次失败导致系统级锁）

手机端流程：
1. 不要尝试 `BiometricPrompt`，直接发 `FALLBACK_REQ`
2. PC 端 phone.html 弹一个**用户必须手动确认**的 modal：「这台手机指纹临时不可用，是否允许走 4 位 PIN？」
3. 用户确认后 PC 发 `FALLBACK_PIN { id }`（仅「放行」信号，**不带 PIN 值**）；手机端弹输入框，用户输入 4 位 → **手机本地比对**（PBKDF2 哈希，见 §8）
4. 比对通过后，手机用 **K_pin（独立的非 bio-gate 兜底密钥，≠ K_bio）** 对同一 AAD 计算 HMAC，回 `RESPONSE { hmac, ts, biometric_ok:false }`

### 方案 C（加固，2026-06-27 拍板）—— 兜底用独立密钥，软门由密码学强制

配对时手机除 bio-gated 的 **K_bio**（Keystore，CHALLENGE 主路径）外，**另外独立生成一把 K_pin**，存 `EncryptedSharedPreferences`（无 bio gate），并把两把 key 都交给 PC（PAIR_OK 两个字段 + paired_devices 两列）。

- **PC 用「哪把 key 验过」判定 bio/fallback，不信任 `biometric_ok` 字段**：verify() 先试 K_bio（放行全部 purpose），失败且 `purpose=unlock` 时再试 K_pin（仅 unlock）。`biometric_ok` 降级为**纯展示**，不参与鉴权。
- 后果：受控 / root 手机即便谎报 `biometric_ok:true`，也算不出 K_bio 的 HMAC（K_bio 永不出 Keystore，ESP 里没有它的副本），PC 自然落到 K_pin 路径 → 只放行 unlock。`sync_destructive` / `export_plaintext` 的 RESPONSE 根本不会用 K_pin 去试 → 密码学上锁死，软门无法被冒充成强认证。
- K_bio **绝不**写进 ESP（否则 root 读出即可无指纹算出 K_bio HMAC，等于拆掉 bio gate）。这正是放弃早期「双副本方案 A」的原因。

**软门代价仍在**（4 位 PIN 不过 TEE），所以：
- PC 在 paired_devices 标记最近一次走 fallback（`last_fallback_at`），UI 显式提示
- fallback PIN 错 3 次 → 该设备 fallback 通道锁 24 小时（10⁴ 容量，比 6 位配对 PIN 宽松）

## 8. 持久化变更

### PC 端 sqlite — schema v4

```sql
-- v4 migration (M3'-B): 给已配对设备多一列 HMAC 密钥
ALTER TABLE paired_devices ADD COLUMN device_hmac_key BLOB;   -- K_bio
ALTER TABLE paired_devices ADD COLUMN last_challenge_at INTEGER;
ALTER TABLE paired_devices ADD COLUMN last_fallback_at INTEGER;

-- v5 migration (M3'-B 方案 C): fallback 用独立的 K_pin（≠ K_bio）
ALTER TABLE paired_devices ADD COLUMN device_pin_key BLOB;    -- K_pin

-- 兼容性：v3 已有的行 device_hmac_key/device_pin_key 为 NULL；下次 CHALLENGE 时手机端会
-- 重新走一次 ENROLL 流程把它补上（详见 §9 升级路径）
```

`device_hmac_key`（K_bio）/ `device_pin_key`（K_pin）都是 32B 随机字节，由**手机端**生成（手机是 TEE 主人），两把**互相独立**：
- 配对时手机端 `SecureRandom.nextBytes(32)` 各生成一把：K_bio 存 Keystore（HMAC import，bio-gated）；K_pin 存 EncryptedSharedPreferences（无 bio gate，仅 fallback 用）
- 通过 `PAIR_OK` 帧的扩展字段 `device_hmac_key_b64` / `device_pin_key_b64` 一次性传给 PC（在已加密 SecureChannel 内），PC 落 paired_devices 两列
- **K_bio 绝不写 ESP**；K_pin 绝不进 Keystore bio-gate（它本就是给指纹不可用时用的）

### 手机端 EncryptedSharedPreferences

```
device_pin_key             -> 32B raw K_pin（FALLBACK_PIN 路径计算 HMAC 用；≠ K_bio）
fallback_pin.hash          -> PBKDF2-HMAC-SHA256(4-digit-pin, salt, 120k)  // 见下注
fallback_pin.salt          -> 16B
fallback_lockout.failures  -> 数组: [ts1, ts2, ts3]
```

> **实现偏离（2026-06-27）**：§8 原写 `argon2id`，实现改用 **PBKDF2-HMAC-SHA256**（JCE 内置，免第三方依赖）。理由：4 位 PIN 的密钥空间只有 10⁴，真正防线是「3 次错 → 24h 锁」而非哈希成本；argon2 在此 purpose 下收益约等于零，却要多引一个库。详见 `Crypto.hashFallbackPin` 注释。

## 9. 与 M3'-A 的对接（升级路径）

PAIR_OK 帧扩展（**M3'-B 实现时改 M3'-A 的 Kotlin/JS 两端**）：

```
现 PAIR_OK:  { t:"PAIR_OK", fingerprint, label }
M3'-B 之后:  { t:"PAIR_OK", fingerprint, label,
              device_hmac_key_b64,        // 32B K_bio（bio-gated CHALLENGE）
              device_pin_key_b64,         // 32B K_pin（方案 C 兜底，独立于 K_bio）
              biometric_capable: bool     // canAuthenticate 状态快照
            }
```

升级语义：
- 新装手机 + 新 PC → PAIR_OK 自带 K_bio + K_pin，schema_version=5，正常
- v3 数据库 + v0.3-late 升级：迁移把 device_hmac_key / device_pin_key 留 NULL；下次该设备连进来时走 ENROLL 回填（只对已知 fingerprint），用户两端确认（与首次配对同样的 TOFU 体验）
- 不允许 key 静默更换：任何已有 K_bio/K_pin 的设备发 ENROLL 换 key 都视作攻击，拒绝并提示「设备身份变了，请确认」（PC 端 `enrollHmacKey`/`enrollPinKey` 仅在列为 NULL 时写入）

## 10. 状态机（M3'-A ACTIVE 内的子状态）

```
ACTIVE
  └─► CHALLENGE_PENDING   (PC 发了 CHALLENGE, 等 RESPONSE)
        ├── RESPONSE ok → ACTIVE + grant(purpose)
        ├── RESPONSE error → ACTIVE + UI 提示
        ├── FALLBACK_REQ → ACTIVE_FALLBACK_PENDING
        │                       ├── 用户允许 → 发 FALLBACK_PIN → ACTIVE_FALLBACK_WAIT
        │                       │                ├── RESPONSE ok (bio=false) → grant(限制 purpose)
        │                       │                └── 3 次错 → 该设备 fallback 锁 24h，回 ACTIVE
        │                       └── 用户拒绝 → ACTIVE (无 grant)
        └── 30s 超时 → ACTIVE (无 grant)
```

`grant(purpose)` 是 PC 端内存中的短期会话许可：默认 5 分钟；解锁 purpose 续 30 分钟（同 v0.2 主密码超时）；sync_destructive/export_plaintext 一次性消费即过期。

## 11. 安全模型

| 威胁 | 缓解 |
|---|---|
| 偷手机（已解锁） | `setUserAuthenticationRequired` + `timeout=0`：每次 HMAC 都要现场指纹；锁屏后 bio key 不可用 |
| 偷手机（已 root） | StrongBox / TEE 隔离 hmac_key 私钥；root 也读不出；只能现场骗指纹（攻击成本高） |
| 偷手机（同卵双胞胎 / 高仿指纹） | 出本设计范围（v0.5 加 face + voice 多模态） |
| MITM 在 LAN 内 | M2' SecureChannel 已防（AES-GCM + ECDH） |
| 重放整个 RESPONSE | nonce 是 PC 端 random；id 进短期 dedup；ts 校验 30s 窗口 |
| 重放 RESPONSE 到不同 purpose | purpose 进 HMAC AAD，跨用途 HMAC 不一致 |
| 重放 RESPONSE 到不同手机 | fingerprint 进 HMAC AAD，PC 端用 channel 协商的 fingerprint，不信 echo |
| Frida hook BiometricPrompt 假报 onSuccess | Keystore key 实际未解锁，`Mac.doFinal` 抛 `IllegalBlockSizeException`；hmac 算不出来；biometric_ok=true 但 hmac 不对 → PC 端 verify 失败 |
| 用户偷偷加新指纹给小偷 | `setInvalidatedByBiometricEnrollment(true)` → key 作废 → 必须回 PC 重新配对，PC 端能看见这件事 |
| Fallback PIN 暴力 | argon2id + 3 次 24h 锁 + fallback 不允许高敏 purpose |
| PC 端 Web 调用 LAN | M2' 已加 host 白名单 + localhost-only |

## 12. 已知限制

- **指纹注册变更触发的 key 作废 + 用户体验差**：用户每加一个新指纹都要重新配对所有设备。这是设计取舍——便利换不了 `setInvalidatedByBiometricEnrollment`。
- **Keystore HMAC 性能开销**：每次 `Mac.init` 触发一次 TEE 切换 ~ 5–20ms（实测因 SOC 而异），不影响 UX。
- **API 30 以下不支持 `setUserAuthenticationParameters`**：M3'-B 设 `minSdk=30`（实际项目已经在 31+）。
- **iOS 不在范围**：iOS 走 Secure Enclave + LocalAuthentication，是 v0.4+ 的事。

## 13. 性能预估

- BiometricPrompt 弹出 → 用户按指纹 → onSuccess：典型 1–3 秒
- Mac.doFinal 计算 HMAC：< 1ms
- PC 端 verify：< 1ms
- 端到端 CHALLENGE → 看到 unlock UI：典型 1.5–4 秒

## 14. 实施拆分（写设计稿不实现，但先列好）

| Step | 模块 | 预估 |
|---|---|---|
| B-1 | M3'-A PAIR_OK 扩展 `device_hmac_key_b64` + db schema v4 + 两端单测 | 0.2d |
| B-2 | `Crypto.kt` 加 `enrollDeviceHmacKey()` (Keystore 写入) + `signChallenge()` (含 BiometricPrompt) | 0.3d |
| B-3 | `HotspotServerService` 加 CHALLENGE / FALLBACK_* dispatcher | 0.15d |
| B-4 | PC 端 `src/lan-challenge.js` + `src/public/js/challenge-ui.js` | 0.15d |
| B-5 | Fallback 4 位 PIN 路径 + 24h lockout | 0.15d |
| B-6 | 跨语言测试向量（HMAC AAD 字节级） + JVM/Node 互验 | 0.2d |
| B-7 | 风险登记 + CHANGELOG + 风险点实测（指纹注册变更、StrongBox 缺失降级） | 0.1d |
| **总计** | | **~1.25d** |

（路线图原 M3' 预算 1.5d，B 占 ~5/6，与"复用 BiometricDemoActivity 模式"一致。）

## 15. 验收标准

- 配对完成后端到端弹指纹 → 解锁 PC 密码库 ≤ 5s
- 指纹不可用走 fallback 4 位 PIN，用户能完成 unlock
- fallback 路径下 `purpose=export_plaintext` 被拒绝
- 录新指纹后该手机再次 CHALLENGE 必须显式重配对（key 作废检测）
- 重放攻击（录 RESPONSE 帧重发） → PC verify 失败
- 跨 purpose 重放（CHALLENGE purpose=unlock 的响应被中间人改成 purpose=export_plaintext 转发） → HMAC 不匹配

## 16. 风险登记

| ID | 风险 | 缓解 | 状态 |
|---|---|---|---|
| B1 | 用户加新指纹 → key 作废 → 必须重配对 → 抱怨 | UI 明示「为防偷加指纹，新增指纹需重新配对」 | 待 B-7 真机验 |
| B2 | 部分国产 ROM 的 BiometricPrompt 弹出延迟 5s+ | 测试范围加 MIUI/HyperOS/HarmonyOS/ColorOS 各一台 | 待 B-7 真机验 |
| B3 | StrongBox 在某些设备上不可用导致 KeyGen 抛异常 | try / fallback 到 TEE，不抛失败（`enrollDeviceHmacKey` 守卫 API31 + `StrongBoxUnavailableException` 回退） | ✅ 已实现 |
| B4 | 系统更新后 Keystore key 失效（罕见） | 捕获 `KeyPermanentlyInvalidatedException`，提示重配对（`key_invalidated` error） | ✅ 已实现 |
| B5 | Fallback PIN 路径弱于生物识别（4 位、不过 TEE） | 方案 C：用独立 K_pin（非 K_bio 副本），PC 按「哪把 key 验过」判定且 K_pin 仅放行 unlock；biometric_ok 不参与鉴权，受控手机无法冒充强认证。仍保留 v0.4 升级到「错指纹直接拒、无 fallback」选项 | ✅ 已实现 |
| B6 | 配对即引导设定 PIN 是非阻塞的——用户可关闭 Activity 不设 PIN；后续 fallback 命中 `NOT_SET` → RESPONSE error | 可接受：bio 主路径仍可用，下次配对再提示；v0.4 可改为「PAIR_OK 后强制设 PIN 才完成配对」 | ✅ 已实现（接受该代价） |
| B7 | `pendingFallbacks` 是 service 级共享 Map，socket 异常断开时残留 entry 不会被主动清理 | 由 PC 端 pending TTL（150s）+ RESPONSE/cancel 自然回收；单个 entry ≤ 104B，泄漏有界。v0.4 可在 socket finally 按 id 清 | ✅ 已实现（接受该代价） |
| B8 | `ERROR_LOCKOUT`（临时锁定，非 PERMANENT）当前也转 fallback——理论上用户多试几次指纹会恢复，转 PIN 是保守但 UX 略损 | 保守正确：锁定期间无法用 bio，PIN 是唯一生路；锁定恢复后下次 CHALLENGE 自然回 bio 路径 | ✅ 已实现 |
| B9 | Android 12+ 后台 Service 拉 Activity 受限（`handleChallenge`/`handleFallbackPin` 都 startActivity） | 配对/挑战是交互场景，前台 app 豁免通常适用；真正后台化需 full-screen-intent 通知（M4' 硬化） | ⚠️ 待 M4' 硬化 |

## 17. 与 M3'-C 的边界

`grant(purpose)` 是 M3'-B 输出，是 M3'-C 的输入：
- `SYNC_PULL` 不需要 grant（只读）
- `SYNC_PUSH` 需要 `grant(unlock)` 在有效期内
- `SYNC_SNAPSHOT export-mode` 需要 `grant(export_plaintext)`

M3'-C 设计稿（v0.3 后续）再细化这块。
