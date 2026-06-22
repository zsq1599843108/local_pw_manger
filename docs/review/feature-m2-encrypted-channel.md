# 审查报告: feature/m2-encrypted-channel

分支: `feature/m2-encrypted-channel` @ 55a6c45
基线: `main` @ 00ee8aa
审查时间: 2026-06-22 (review worktree, detached @ 55a6c45)
审查人: reviewer agent

## 结论: ❌ 需重做

**Blocker**: 手机端 `Crypto.kt` 把 Tink `AesGcmJce` 当作"裸 AES-GCM"使用，但
Tink 的这个原语会自动生成 12 字节 IV 并 **prepend** 到返回值里
（`AesGcmJce.encrypt` 实际返回 `iv(12) || ct || tag(16)`）。Kotlin 代码却又
自己生成一个 IV 写到帧头，并把 Tink 的整个返回值当作"ct||tag"拼上去——
**手机→PC 的实际线缆格式与 secure.js 不匹配，浏览器侧 `open()` 必定 GCM
auth 失败**。同样地，Kotlin `open()` 会把入帧切片后丢给 `aead.decrypt`，
Tink 取该切片前 12 字节当作 IV，但那 12 字节其实是浏览器的密文头部，
解密同样失败。

测试脚本之所以全绿，是因为它用 Node WebCrypto 实现了一个 mock 手机，
**完全没有走 Kotlin/Tink 这条路径**——`AesGcmJce` 这条代码路径从未被
任何测试触达过，到了真机就会立刻爆。

## 改动摘要
- `src/public/js/secure.js` (NEW, 181): 浏览器 WebCrypto crypto + 帧格式（X25519 → HKDF-SHA256 → AES-256-GCM）。
- `android/.../Crypto.kt` (NEW, 147): 手机端 Tink 镜像，**与 JS 不互操作（见 Blocker）**。
- `android/.../HotspotServerService.kt` (+115): 增加 Ktor `/socket` 路由与 handshake FSM。
- `src/lan-ws-client.js` (NEW, 127): Node 透明 ws 桥；明确"不持密钥"。
- `src/server.js` (+46): `/api/lan/socket` upgrade → bridge。
- `src/public/js/lan-pair.js` (+98): 探测成功后跑 handshake + 加密 PING。
- `src/public/phone.html` (+1): 引入 `secure.js`。
- `scripts/test-m2-encrypted-channel.js` (NEW, 245): 端到端测，但只跑 JS 自己，未触及 Kotlin。
- `package.json` / `package-lock.json` (+ws@^8.21.0)。
- `android/app/build.gradle.kts` (+ktor-server-websockets, +tink-android 1.13.0)。

## 逐项检查

### 1. 加密/安全: ❌
- **互操作性 (Blocker)**：见结论。
  - 证据 A — `android/app/src/main/java/com/passman/pair/Crypto.kt:84` 与 `:98`:
    ```kotlin
    private val aead = AesGcmJce(key)
    ...
    val iv = ByteArray(IV_SIZE).also { SecureRandom().nextBytes(it) }
    val ctrBytes = ctrToBytes(ctr)
    val aad = (AAD_PREFIX.toByteArray()) + ctrBytes
    val ct = aead.encrypt(plaintext, aad)   // 注释说 "returns ciphertext || tag(16)"——错误
    return iv + ctrBytes + ct
    ```
    Tink 源码（`com.google.crypto.tink.subtle.AesGcmJce#encrypt(byte[], byte[])`）：
    > Encrypts {@code plaintext} with {@code associatedData}. The resulting ciphertext
    > consists of the **iv** used during the encryption, the **ciphertext** and the **tag**.

    因此 Kotlin seal 实际产物：`random_iv(12) || ctrBytes(8) || tink_iv(12) || ct || tag(16)`，
    而 `secure.js` `SecureChannel.open()` 期望 `iv(12) || ctrBytes(8) || ct || tag(16)`，
    会把 tink_iv 当成密文，GCM 验证必然失败。
  - 证据 B — Kotlin `open()` (`Crypto.kt:108`):
    ```kotlin
    val ct = frame.copyOfRange(IV_SIZE + CTR_SIZE, frame.size)   // 浏览器密文+tag
    ...
    val pt = aead.decrypt(ct, aad)   // Tink 取 ct[0..12] 当 IV → 错位
    ```
    与上对称：Tink 会把浏览器的真实 ciphertext 前 12B 当 IV。
  - **修法**：要么手机端改用 `javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")` 直接控 IV，
    要么去 Tink 的 `Aead` 接口里换一个 IV-外置的实现（如 `Aead`+ `IndCpaCipher` 不太行，
    直接 JCE 最干净）。一并加一个**真机/JVM 跨实现互测**：用 secure.js 在 Node 加密，让
    Kotlin（在 JVM 单元测试里跑同一 `Crypto` object）解密；再反向。
- **算法选择**：X25519 + HKDF-SHA256 + AES-256-GCM 合理，匹配项目 CLAUDE.md「Web Crypto API」要求。
- **AAD/info/salt 设计**：✅ AAD 绑 frame counter 防错位攻击；HKDF salt = `noncePc||noncePhone` 保证双向 nonce 注入；info 字符串带版本号 `v1` 便于未来轮换。
- **重放防御**：✅ `lastRecvCtr` 单调递增，初值 -1n / -1L，首帧 ctr=0 可过；JS 端用 BigInt 8 字节 BE 与 Kotlin `ByteBuffer.putLong` 字节序一致。
- **IV 随机性**：浏览器侧用 `crypto.getRandomValues`、Kotlin 侧用 `SecureRandom()`，都是 CSPRNG ✅。
  ⚠️ 旁注：Kotlin 端 **每次** `seal` 都 `new SecureRandom()`，性能/熵池上虽然 OK（Android `SecureRandom` 内部走 `/dev/urandom`），但**习惯性反模式**，建议提到字段级。
- **密钥生命周期**：`SecureChannel.close()` 仅置 closed=true，**未清零 `key`/`aead`**。当前是内存里就死，但作为加密代码以后会被拷贝。⚠️ 建议项。
- **TOFU / 身份**：M2' 范围内 PC 接受任意公钥即握手——没有 pin/binding。预期由 M3' (pair PIN) 解决，README 也这么说。✅（在本里程碑范围内 OK，但合并消息里建议明示「无身份验证，假设 LAN 私密」）。
- **handshake 重入**：✅ 第二条 HELLO 被拒（`channel != null`），双侧都有；HELLO 之后未握手就发 binary 也被拒。
- **JSON 解析**：Kotlin 用 `ignoreUnknownKeys = true`、`buildJsonObject`，没用反射动态类型，无 gadget 风险。✅。
- **WS upgrade 路径检查**：`src/server.js:37` 只接受 `/api/lan/socket`，其它路径 `socket.destroy()`。✅。
- **port 校验**：`src/server.js:49` 拒绝非 1..65535 整数。✅。⚠️ 但 `host` 没做白名单/正则——任何字符串都会被丢给 `openBridge`。攻击面是「localhost 上的某个其它服务被当成手机端被探测」，影响有限（只是 ws 文本帧 + 二进制帧），但密码管理器整体应更保守：建议加 RFC1918/IPv4 字面量校验（**非 blocking**，可在 M5 收口）。

### 2. 数据本地化: ✅
- 全部流量在 LAN：浏览器→`localhost:3000`→Node→`ws://<phone>:9876`。无第三方域名、telemetry、CDN。
- secure.js 是纯本地脚本，未引入外链。
- 测试脚本只起本地 wss。
- ⚠️ 旁注：`package-lock.json` resolved 字段是 `registry.npmmirror.com`，遵循 CLAUDE.md「国内镜像优先」约束 ✅。

### 3. 正确性: ⚠️
- **互操作 Bug**：见 1.（重复列入这里以示严重程度）。
- **Kotlin `bytesToCtr` 与 Long 上限**：`ByteBuffer.getLong` 在 `frame_ctr` 高位是 1 时会得到**负数**——`lastRecvCtr` 也是 `Long`，比较仍是带符号的，所以 ctr 超过 `Long.MAX_VALUE` 时单调递增性会跳到负数空间然后失败重放检测。
  浏览器端用 BigInt 没这个上限。**实际不会触发**（达 2^63 帧需要不可能的连接寿命），但**写法不一致**值得注意；建议项。
- **frame 入站没做长度上限**：`Frame.Binary` 没限制大小，恶意端可发非常大的 frame 让手机 OOM。Ktor `WebSockets` 默认 `maxFrameSize = Long.MAX_VALUE`。⚠️ 建议在 `install(WebSockets) { maxFrameSize = 64 * 1024 }`。
- **`HotspotServerService.handleEncryptedSocket` 处理 close**：`finally { channel?.close() }` 仅 close 标志位，未清密钥（参 1.）。
- **`lan-ws-client.js` 错误码映射**：`mapWsError` 看 message 子串，`'404'`/`'unexpected response'` 是 ws 库目前的措辞，未来升级若变化会回落到 `NETWORK`——可接受 ✅。
- **`runClient` 测试代码 race**：脚本里 `bridge.upstream.close()` 紧跟着 `new WebSocket(...)`，没等 close 完成；和注释一致是「我们另开一条直连」，不影响结论但有点别扭，**非 blocking**。
- **第二条 HELLO 拒绝逻辑**（Kotlin）会发 `Close` 然后 `return`，但握手已在第一次完成时把 `channel` 置位——保留了 channel 不立即销毁，依赖 `finally` 才 close；OK ✅。
- **`handleEncryptedSocket` 的 channel `var`**：单协程 + Ktor `incoming` 串行消费，没竞争 ✅。

### 4. 测试: ⚠️
- 自动化测试存在 (`scripts/test-m2-encrypted-channel.js`)，4 个用例（握手 / round-trip / 篡改 / 重放）。
- **本次跑测**：从 review 工作区跑（借主工作区 `node_modules` 解决 ws 依赖），**4/4 通过**。
- **覆盖盲区（关键）**：mock 手机是 Node WebCrypto 自己实现的协议镜像，**完全没运行 Kotlin/Tink 这条路径**。互操作 bug 全员被此盲区掩盖。
  → **必加**：JVM 单元测试，让 Kotlin `Crypto` 与 secure.js 互相产物互解（或起码：用 `javax.crypto.Cipher` AES/GCM 解密 Kotlin 输出，验证字节布局是 `iv||ctr||ct||tag`）。
- 现有用例的"篡改"与"重放"是在客户端自己的 SecureChannel 上验的，没经过完整 wire；改进空间。

### 5. 项目约束: ✅
- 分支名 `feature/m2-encrypted-channel` 符合 `feature/<name>` 约定。
- Commit message 风格规范（feat(m2): …），含 Co-Authored-By、附完整设计说明、明示线缆格式与算法。✅
- 没有硬编码绝对路径、没有 C 盘安装。
- 引入依赖（`ws`、`tink-android`、`ktor-server-websockets`）已在 commit message 与 build.gradle.kts 注释里说明，npm 走的是 `npmmirror.com`。✅
- 与 ADR-002 §M2' 一致；wire format 与 CHANGELOG/PROGRESS 同步是 developer 在 M3 分支的事，本分支只把代码交付了。

## 必改项 (blocking)
1. **`android/app/src/main/java/com/passman/pair/Crypto.kt:84,98,108,116`** — `AesGcmJce` 自动 prepend IV，导致 wire 格式与 secure.js 不匹配。**修法二选一**：
   - (推荐) 改用 `javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")`，手动控 IV，对应 `seal`/`open` 重写约 30 行；
   - 或在 seal 后 `drop(12)` Tink 的 IV、open 前 `prepend(iv)` 给 Tink，但**别这么干**：脆弱，且 IV 同步反而更难推理。
2. **测试必须覆盖 Kotlin 路径** — 新增一个 JVM 单元测试或一个对接 mock JS 客户端的 Kotlin 测试，端到端验证「Kotlin seal → JS open」与「JS seal → Kotlin open」字节互通。

## 建议项 (non-blocking)
1. `install(WebSockets) { maxFrameSize = 64 * 1024 }`（或合理上限）防 OOM/DoS。
2. `SecureChannel.close()` 真正擦除 `key`（`Arrays.fill(key, 0)`）— 习惯性安全卫生。
3. `SecureRandom` 提到 `Crypto.SecureChannel` 字段级，避免每帧 `new`。
4. `handleLanSocket` 的 `host` 加 RFC1918/IPv4 字面量校验（可 M5'收口）。
5. Kotlin `bytesToCtr` / `lastRecvCtr` 改用 `BigInteger` 或显式注释 2^63 上限—走 unsigned 比较；纯防御性。
6. 合并 commit message 或 ADR-002 §M2' 末尾加一句「M2' 信任 LAN 内任意公钥，身份绑定在 M3' 由 PIN 解决」。

## 跑测试结果
- `node scripts/test-m2-encrypted-channel.js` (review worktree, NODE_PATH 借自主工作区):
  ```
  M2' encrypted channel tests:
    ✓ ECDH handshake completes
    ✓ encrypted PING → PONG round-trip
    ✓ tampered ciphertext rejected (GCM auth)
    ✓ replayed frame counter rejected
  4 passed, 0 failed
  ```
  全绿，但**测试不覆盖 Kotlin 端真实代码路径** → 见必改项 2。
- 静态读源码 + 对照 Tink 1.13.0 `AesGcmJce` 公开 API 文档进行的互操作分析。
- 未在真机上跑（无设备），但 wire 布局推理可独立得出结论：失配是确定性的，不需要真机就能确认。

---

🤖 Generated with Claude Code (reviewer agent)
