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
                            "user_cancelled"|"unknown_purpose"|"unknown_device" }
phone -> PC     FALLBACK_REQ { t:"FALLBACK_REQ", id, reason:"bio_unavailable" }
PC   -> phone   FALLBACK_PIN { t:"FALLBACK_PIN", id, pin:"1234" }
phone -> PC     RESPONSE      ... biometric_ok:false（同上结构）
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string (16 hex) | PC 生成的本次挑战标识；RESPONSE 必须 echo |
| `nonce_b64` | base64(32B) | PC `crypto.randomBytes(32)`；HMAC 输入；防重放 |
| `purpose` | enum: `unlock` \| `sync_destructive` \| `export_plaintext` | 进 HMAC AAD；防同一 nonce 跨用途换义 |
| `ts` | int64 ms | 手机响应时刻；PC 校验 `\|ts - now\| < 30s` |
| `hmac_b64` | base64(32B) | `HMAC-SHA256(device_hmac_key, AAD)`，AAD 见 §4 |
| `biometric_ok` | bool | TEE 担保；走 Keystore 时只能是 true（false 走 fallback 路径） |

`FALLBACK_PIN` 只在手机端 `BiometricManager.canAuthenticate()` 返回非 SUCCESS 时使用（无硬件 / 未录入指纹 / 临时不可用）。回退是**4 位 PIN**，沿用 v0.2 的 token 路径——与 M3'-A 的 6 位配对 PIN **不同**，目的是给"指纹临时坏了"留生路，不应等价于身份证明。详见 §7。

## 4. HMAC 输入定义

```
AAD = "PassMan-CHAL-v1"               // 14B 协议域分隔，防与其它 HMAC 用途串
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
3. 用户确认后 PC 发 `FALLBACK_PIN`，手机端在 UI 弹输入框，用户输入 4 位 → 手机本地比对
4. 手机回 `RESPONSE { biometric_ok: false, hmac... }`，HMAC 仍然计算（用同一个 hmac_key，但 key 此时没法用 Keystore 解锁，所以兜底路径下 hmac_key 必须**有第二份不带 bio gate 的副本**——见下）

**这是兜底路径的"软门"代价**：4 位 PIN 不通过 TEE，等价于 v0.2 token。所以：
- PC 端必须在 paired_devices 标记「该设备最近一次走的是 fallback」，UI 显式提示
- `purpose=sync_destructive`/`export_plaintext` 在 fallback 路径下**一律拒绝**，只允许 `unlock`
- fallback PIN 错 3 次 → 该设备 fallback 通道锁 24 小时（远比 6 位 PIN 配对宽松，因为只剩 4 位 = 10⁴ 容量）

**hmac_key 的双副本**：Keystore 里那把是 bio-gated；同时把同一把 key 用 `EncryptedSharedPreferences` 存一份（无 bio gate），仅供 fallback 路径计算 HMAC 用。这看似削弱安全，但**真正的访问控制点不在手机本地**——是 PC 端对 `biometric_ok` 字段的 trust 决策（fallback 路径下 PC 拒绝高敏 purpose）。Keystore 副本仍然是主路径，硬件保护原值。

> **此处需要用户确认**：双副本方案可接受吗？或者更保守的"指纹坏掉 → 完全不让连，必须回到 PC 端原 4 位 token 流程"。后者实现简单但 UX 较糟。

## 8. 持久化变更

### PC 端 sqlite — schema v4

```sql
-- v4 migration (M3'-B): 给已配对设备多一列 HMAC 密钥
ALTER TABLE paired_devices ADD COLUMN device_hmac_key BLOB;
ALTER TABLE paired_devices ADD COLUMN last_challenge_at INTEGER;
ALTER TABLE paired_devices ADD COLUMN last_fallback_at INTEGER;

-- 兼容性：v3 已有的行 device_hmac_key 为 NULL；下次 CHALLENGE 时手机端会
-- 重新走一次 ENROLL_HMAC 流程把它补上（详见 §9 升级路径）
```

`device_hmac_key` 是 32B 随机字节，由**手机端**生成（手机是 TEE 主人）：
- 配对时手机端 `SecureRandom.nextBytes(32)` → 存 Keystore（HMAC import）+ 存 EncryptedSharedPreferences 副本
- 通过 `PAIR_OK` 帧的扩展字段 `device_hmac_key_b64` 一次性传给 PC（在已加密 SecureChannel 内），PC 落 paired_devices.device_hmac_key

### 手机端 EncryptedSharedPreferences

```
device_hmac_key.fallback   -> 32B raw (FALLBACK_PIN 路径用)
device_hmac_key.bio_gated  -> 上面那把 key 的 Keystore alias 名 (字符串)
fallback_pin.hash          -> argon2id(4-digit-pin, salt)  // 抗暴力破解
fallback_pin.salt          -> 16B
fallback_lockout.failures  -> 数组: [ts1, ts2, ts3]
```

## 9. 与 M3'-A 的对接（升级路径）

PAIR_OK 帧扩展（**M3'-B 实现时改 M3'-A 的 Kotlin/JS 两端**）：

```
现 PAIR_OK:  { t:"PAIR_OK", fingerprint, label }
M3'-B 之后:  { t:"PAIR_OK", fingerprint, label,
              device_hmac_key_b64,        // 32B 新生成
              biometric_capable: bool     // canAuthenticate 状态快照
            }
```

升级语义：
- 新装手机 + 新 PC → PAIR_OK 自带 hmac_key，schema_version=4，正常
- v3 数据库 + v0.3-late 升级：迁移把 device_hmac_key 留 NULL；下次该设备连进来时，PC 端发 `ENROLL_HMAC_REQUEST`（只对已知 fingerprint）→ 手机端生成 + 回 `ENROLL_HMAC` 填空；用户在两端都确认（与首次配对同样的 TOFU 体验）
- 不允许 hmac_key 静默更换：任何已有 hmac_key 的设备发 `ENROLL_HMAC` 都视作攻击，拒绝并提示用户「设备身份变了，请确认」

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

| ID | 风险 | 缓解 |
|---|---|---|
| B1 | 用户加新指纹 → key 作废 → 必须重配对 → 抱怨 | UI 明示「为防偷加指纹，新增指纹需重新配对」 |
| B2 | 部分国产 ROM 的 BiometricPrompt 弹出延迟 5s+ | 测试范围加 MIUI/HyperOS/HarmonyOS/ColorOS 各一台 |
| B3 | StrongBox 在某些设备上不可用导致 KeyGen 抛异常 | try / fallback 到 TEE，不抛失败 |
| B4 | 系统更新后 Keystore key 失效（罕见） | 捕获 `KeyPermanentlyInvalidatedException`，提示重配对 |
| B5 | Fallback PIN 双副本 hmac_key 削弱安全感 | §7 已论证 + 文档警示；保留 v0.4 升级到「无 fallback hmac_key，错指纹直接拒」 |

## 17. 与 M3'-C 的边界

`grant(purpose)` 是 M3'-B 输出，是 M3'-C 的输入：
- `SYNC_PULL` 不需要 grant（只读）
- `SYNC_PUSH` 需要 `grant(unlock)` 在有效期内
- `SYNC_SNAPSHOT export-mode` 需要 `grant(export_plaintext)`

M3'-C 设计稿（v0.3 后续）再细化这块。
