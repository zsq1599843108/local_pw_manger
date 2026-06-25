# 审查报告: feature/m3b-biometric-challenge — B-1

分支: `feature/m3b-biometric-challenge` @ `074500a`
审查基线: B-1 父提交 `e0d620b`（M3'-A wrap-up），单提交隔离审查
审查时间: 2026-06-25
审查人: reviewer agent
设计依据: `docs/m3b-biometric-challenge-design.md` §8 / §9 / §14（B-1 行）
范围声明: 仅审 B-1 提交（PAIR_OK 线格式扩展 + schema v4），**不含** B-2 起的 Keystore/BiometricPrompt（dev 工作区已在 `06489e4` 推进 B-2，未纳入本次）

## 结论: ✅ 通过

B-1 严格落在设计声明的「wire format and schema only」范围内，未越界做 Keystore/生物识别。
代码、迁移、测试三者一致，三套测试断言全绿（db 27 / routes 34 / pairing 19），与提交信息声明吻合。
未发现 blocker。下列均为可合并后跟进的 minor / 给 B-2 的提示。

## 范围核对（B-1 = §14 第一行）

| 设计要求 | 实现 | 状态 |
|---|---|---|
| PAIR_OK 扩展 `device_hmac_key_b64` + `biometric_capable` | `HotspotServerService` PAIR_OK put 两字段；`lan-pair-protocol.js` 注释同步 | ✅ |
| db schema v4：三列 + v3 原地升级 | `db.js` `addColumnIfMissing()` + `SCHEMA_VERSION=4` | ✅ |
| key 由手机生成（TEE 主人），PAIR_OK 一次性带给 PC | Kotlin `SecureRandom` 32B；PC `/trust` 落库 | ✅ |
| 不允许静默更换已有 key（§9 视为攻击） | `enrollHmacKey` 仅回填 NULL，已有 key 返回 false | ✅ |
| 两端单测 | 三套脚本新增对应断言 | ✅ |

## 验证证据

- **测试**（dev 工作区 `F:/Projects/local_password_manager`，B-1 相关 6 文件与 `074500a` 逐字节一致，B-2 仅新增文件未改动）：
  - `test-m3a-db.js` → 27 passed, 0 failed（含 schema v4 戳记、hmac key 往返、enrollHmacKey 回填/拒换、touch 列隔离、v3→v4 迁移幂等且非破坏）
  - `test-m3a-routes.js` → 34 passed, 0 failed（含 32B key 落库、16B 畸形 → 400 bad_hmac_key 且不落库、re-trust 回填 NULL、GET 暴露 has_hmac_key 而不泄露字节）
  - `test-m3a-pairing.js` → 19 passed, 0 failed（PAIR_OK 含 32B device_hmac_key_b64 + biometric_capable bool）
- **依赖核对**：`androidx.biometric:biometric:1.2.0-alpha05` 已在 `android/app/build.gradle`，Kotlin 新增 `BiometricManager.from(...).canAuthenticate(BIOMETRIC_STRONG)` 可编译。
- **向后兼容**：`trustDevice` 新增 `deviceHmacKey = null` 为对象解构默认值，旧调用方不破坏。

## 设计一致性要点

- HMAC key **持久化跨连接稳定** 这一职责正确落在 paired_devices 行，与 §4「不重用会话级 pairSecret」一致。
- `has_hmac_key` 仅暴露布尔、不泄露密钥字节，符合 §6 PC 端持有对称 key 但 UI 不外泄的意图。
- PC 端（`lan-pair.js` `atob().length===32`）与服务端（`decodeHmacKey` 32B 校验）双重校验，畸形值丢弃而非静默放行，纵深防御到位。

## Minor / 给 B-2 的提示（非 blocker）

1. **Kotlin 注释与 enroll 语义存在潜在不一致（B-2 会自然消解）**
   `HotspotServerService` 注释称「service restart forces a re-ENROLL on the next connection」，但 PC 端 `enrollHmacKey` 对已有非 NULL key 拒绝更换（§9 正确行为）。
   即：手机重启 → in-memory 新 key；PC 仍存旧 key → 二者 desync，回填路径不会触发（因 PC 端非 NULL）。
   B-1 阶段无真实 CHALLENGE，无实际影响；**B-2 把 key 移入 AndroidKeyStore 持久化后此瞬态 desync 消失**。仅提示 B-2 落地时复核这条注释的措辞。

2. **`/trust` re-trust 回填是隐式的**
   设计 §9 描述 ENROLL_HMAC 为「两端 TOFU 确认」流程，而当前 `/trust` 在 re-trust 且原 key 为 NULL 时直接回填、无独立确认。
   实际触发点是「刚完成一次需 6 位 PIN + 手机端 trust 的真实配对」之后，等价 TOFU，可接受。真正的 `ENROLL_HMAC_REQUEST` 独立确认流程留待后续 step；提示别忘了。

3. **`addColumnIfMissing` 用字符串插值拼 SQL 标识符**
   `ALTER TABLE ${table} ADD COLUMN ${column} ${decl}` — 仅因调用方全是 db.js 内硬编码字面量才安全。属内部工具函数，可接受；若将来对外开放需改白名单。

4. **fresh-v4 库的建表路径**
   `CREATE TABLE paired_devices` 未含三新列，靠 `addColumnIfMissing` 在建表后补列（fresh 与升级走同一 ALTER 路径）。功能正确、幂等，测试覆盖；属风格选择，无需改。

## 既有遗留（非 B-1 引入，记录在案）

- **`test-m3a-routes.js` 进程退出码 127（Windows）**：所有断言「34 passed, 0 failed」打印后，better-sqlite3 + http handle 在 `process.exit()` teardown 时触发 libuv `async.c:76` 断言中止，覆盖了正常退出码。
  - 该 harness（`app.listen` + `process.exit`）继承自 M3'-A `2481867`，**非 B-1 引入**；测试逻辑全过。
  - 影响面：若 CI 以退出码判定，Windows 上会误报失败。建议后续把 `process.exit` 前的 DB `close()` + handle 清理补齐（独立小修，不阻塞 B-1）。

## 分支整洁性提示（与 B-1 评审无关，供合并 main 前注意）

本分支领先 main 还含 m3a 提交（`1235c73` / `2481867` / `1781edc` 端到端配对 UI + 持久化 + `e0d620b` 文档）。
这些是 M3'-A 复审③遗留的「UI 在 M3'-B 补」那部分实现，**未在本次 B-1 范围内单独审查**。
合并任何内容到 main 前，应确认这批 m3a 提交已走过审查（或随 M3'-B 完整体一并复审）。
