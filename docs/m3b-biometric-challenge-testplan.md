# M3'-B 真机实测清单（B-6 / B-7）

> 本环境（Win11，无 emulator/真机连接）无法执行 instrumented/真机测试。本文档是**交付给真机执行的清单**，对照设计 §15 验收标准 + §16 风险登记。每项执行后填结果。

**环境要求**：
- 一台 PC（Win11，跑 `node src/server.js`，浏览器开 `localhost:3000`）
- 一台 Android 11+（minSdk 30）测试机，已录指纹；推荐覆盖 MIUI/HyperOS、ColorOS、原生各一台（风险 B2）
- 手机开 Wi-Fi 热点，PC 加入热点

**前置构建**：
```bash
# PC 端
node scripts/test-m3b-challenge.js          # 必须 33/33
node scripts/gen-m3b-challenge-vectors.js   # 必须 EXIT 0

# 手机端（android/）
./gradlew.bat :app:testDebugUnitTest        # 必须 JVM 24/24
./gradlew.bat :app:lintDebug                # 必须 0 error
./gradlew.bat :app:connectedDebugAndroidTest # instrumented ESP/lockout（需真机）
adb install app/build/outputs/apk/debug/app-debug.apk
```

---

## §15 验收标准逐项

### AC-1 配对 → 弹指纹 → 解锁 ≤ 5s
1. 手机打开 PassMan → Start server（看到 ✅ Listening on :9876）
2. PC `phone.html` → Pair via Wi-Fi → 输入手机 IP + 手机屏上 6 位滚动 PIN → 手机按 Trust
3. PAIR_OK 完成（PC 日志见 `device_hmac_key_b64` + `device_pin_key_b64` + `biometric_capable:true`）
4. 配对后手机**应弹出「Set a 4-digit fallback PIN」**（B-5 配对即设定）；设定并确认
5. PC 触发 `runChallenge('unlock')` → 手机弹指纹 → 触摸 → PC 显示 `✓ challenge OK — biometric=true`
6. 计时：PAIR_OK 到 PC verify OK 应 ≤ 5s
- [ ] 通过 / [ ] 失败（耗时 ____s）

### AC-2 指纹不可用走 fallback 4 位 PIN 完成 unlock
1. 在 AC-1 配对完成后，关闭手机指纹（设置 → 生物识别 → 关闭指纹，或擦除全部指纹）
2. PC 触发 `runChallenge('unlock')` → 手机 `biometricCapable()` 返回 false → 回 `FALLBACK_REQ`
3. PC 浏览器弹「Fingerprint unavailable」modal → 点 Allow PIN
4. PC 发 `FALLBACK_PIN` → 手机弹「Enter your fallback PIN」→ 输入 AC-1 步骤 4 设定的 PIN
5. PC 显示 `✓ fallback OK — purpose=unlock, biometric=false`
6. DB 检查：`SELECT last_fallback_at FROM paired_devices` 应被戳记，`last_challenge_at` 不变
- [ ] 通过 / [ ] 失败

### AC-3 fallback 路径下 export_plaintext 被拒绝
1. 延续 AC-2 状态（指纹不可用）
2. PC 触发 `runChallenge('export_plaintext')` → 手机回 `FALLBACK_REQ`（bio 不可用）
3. **关键**：PC 的 `verify()` 对 `export_plaintext` **不试 K_pin**（设计 §7），即使手机用 K_pin 签也应 `hmac_mismatch`
4. 验证：即便用户走完 PIN 流程，PC 必须拒绝（`hmac_mismatch`，不是 ok）
5. （离线已测：`test-m3b-challenge.js` 的「K_pin export_plaintext denied」用例 33/33 含此）
- [ ] 通过 / [ ] 失败

### AC-4 录新指纹后该手机再次 CHALLENGE 必须显式重配对
1. 重新打开手机指纹，**录入一枚新指纹**（不删除旧的）
2. PC 触发 `runChallenge('unlock')` → 手机 `BiometricPrompt` 触发 → 因 `setInvalidatedByBiometricEnrollment(true)`，Keystore key 已作废
3. 期望：手机回 `RESPONSE { error: "key_invalidated" }` → PC 提示「设备身份变了，请重新配对」
4. 重新配对（重走 AC-1）后 CHALLENGE 恢复正常
- [ ] 通过 / [ ] 失败

### AC-5 重放攻击（录 RESPONSE 帧重发）→ PC verify 失败
1. 正常完成一次 `runChallenge('unlock')`，从浏览器 devtools 抓到 RESPONSE 帧
2. 用浏览器控制台 `window.PassManChannelStash()` 拿到 channel，`channel.seal(<抓到的 RESPONSE JSON>)` 重发同一帧
3. PC `verify()` 应返回 `unknown_challenge`（id 已被 consume）
- [ ] 通过 / [ ] 失败

### AC-6 跨 purpose 重放 → HMAC 不匹配
1. 完成 `runChallenge('unlock')` 抓 RESPONSE（含 hmac）
2. 构造一个 `export_plaintext` 的 CHALLENGE，但把 unlock 的 RESPONSE hmac 塞进去转发
3. PC `verify()` 应 `hmac_mismatch`（AAD 里 purpose 字节不同 → HMAC 不同）
- [ ] 通过 / [ ] 失败

---

## §16 风险登记验证

### B1 指纹作废提示
- AC-4 覆盖。补充：确认 PC UI 文案明示「为防偷加指纹，新增指纹需重新配对」
- [ ] 文案到位 / [ ] 缺失

### B2 国产 ROM BiometricPrompt 延迟
- 每台测试机测 AC-1 步骤 6 计时；若 >5s 记录 ROM + 耗时
- MIUI/HyperOS：____s | ColorOS：____s | 原生：____s

### B3 StrongBox 缺失降级
1. 在无 StrongBox 的设备（或用 `allowStrongBox=false`）配对
2. 期望：`enrollDeviceHmacKey` 回退 TEE 不抛异常，PAIR_OK 正常，CHALLENGE 正常
3. logcat 不应有未捕获的 `StrongBoxUnavailableException`
- [ ] 通过 / [ ] 失败

### B5 方案 C 软门（核心安全验证）
1. **谎报 biometric_ok**：在受控/根手机上 hook `handleFallbackPin`，让它签 K_pin 后回 `biometric_ok:true`
2. PC `verify()` 仍应判 `biometricOk=false`（不信字段，按 key 判定）→ `last_fallback_at` 戳记
3. 离线已测：`test-m3b-challenge.js`「lying biometric_ok:true with K_pin still fallback」✅
- [ ] 真机复现确认

### B6 配对不设 PIN 的降级
1. 配对完成、弹出 SET PIN 时直接按返回取消（不设 PIN）
2. 触发 fallback（AC-2 流程）→ 手机 `verifyFallbackPin` 返回 `NOT_SET` → PC 收 `pin_not_set` error
3. 确认 bio 主路径不受影响（重新录指纹后 CHALLENGE 仍正常）
- [ ] 通过 / [ ] 失败

### B7 lockout 持久化（跨服务重启）
1. fallback 流程连输 3 次错 PIN → `pin_rejected` ×3 → 第 4 次应直接 `pin_locked`
2. **Stop server → Start server**（模拟服务重启）
3. 再次触发 fallback → 应仍为 `pin_locked`（lockout 从 ESP 恢复，不给新 tries）
4. instrumented 测试 `FallbackSecretStoreInstrumentedTest.three_wrong_pins_lock_and_persists_across_restart` 覆盖此逻辑
- [ ] 通过 / [ ] 失败

### B9 Android 12+ 后台拉 Activity
1. 配对完成后按 Home 把 PassMan 退到后台
2. PC 触发 CHALLENGE → 期望：前台时正常弹指纹；后台时可能受系统限制
3. 记录：前台 OK / 后台是否需要 full-screen-intent（M4' 硬化项）
- [ ] 前台通过 / [ ] 后台行为：____

---

## 回归
- [ ] `node scripts/test-m3a-pairing.js` 全绿（M3'-A 配对未回归）
- [ ] `node scripts/test-m2-interop.js` 全绿（M2' 加密通道未回归）
- [ ] 配对/挑战全程无中文乱码（UTF-8）

## 完成签字
- 测试人：____ 日期：____
- 发现的问题 → 记入 issue / PROGRESS.md
