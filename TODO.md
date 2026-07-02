# 任务清单

> 每完成一项打 [x] 并移到 Done。M1' 起的子任务详见 `docs/wifi-hotspot-roadmap.md`（待 Phase 2 写）。

## 🔥 In Progress

- [ ] **🔴 reviewer B-2 must-fix（明天第一件）**：`android/app/build.gradle.kts:16` `minSdk = 21` → **`30`**（API 30 的 setUserAuthenticationParameters/AUTH_BIOMETRIC_STRONG 无守卫，lint error + 低版本 NoSuchMethodError）
- [ ] **M3'-B — 生物识别挑战**（分支 `feature/m3b-biometric-challenge` @ 617f754，未 push；B-1/B-2/B-3 done，B-4~B-7 待做）

## ⏭️ Next（v0.3 — Wi-Fi 热点改造，覆盖 AOAP）

### Phase 2 — 文档（~30 min） ✅ 完成
- [x] `docs/adr-002-wifi-hotspot.md` — 决策记录（含 AOAP Win 阻塞复盘）
- [x] `docs/wifi-hotspot-design.md` — 协议 + 流程图 + 加密通道
- [x] `docs/wifi-hotspot-roadmap.md` — M1'~M5' 拆解
- [x] 更新 `MEMORY.md` 文件地图

### M1' — Wi-Fi PoC：ping/pong（~0.5 天） ✅ 完成
- [x] APK：app/build.gradle 加 Ktor (CIO + content-negotiation + json) + kotlinx-serialization plugin
- [x] APK：`HotspotServerService.kt` — 前台服务 + Ktor :9876，路由 GET /ping → JSON
- [x] APK：`HotspotPairActivity.kt` — Start/Stop + 实时 IP 列表 + 状态轮询
- [x] APK：manifest 加 FOREGROUND_SERVICE / FOREGROUND_SERVICE_CONNECTED_DEVICE / POST_NOTIFICATIONS / **CHANGE_WIFI_STATE** (FGS gate) / WAKE_LOCK
- [x] PC：`src/lan-server.js` — probe(host,port) + `/api/lan/probe` 路由
- [x] PC：`src/public/js/lan-pair.js` — 浏览器按钮 + 错误码映射
- [x] PC：phone.html 绿色「Pair via Wi-Fi」入口
- [x] 联调：小米 14 Pro + Win11 实测 ping/pong 通

### M2' — 加密通道（~1 天） ⚠️ 待修复（reviewer 否决，Tink AesGcmJce IV 前置 bug）
- [x] PC: `secure.js` X25519 + HKDF + AES-GCM
- [x] APK: `Crypto.kt` Tink 镜像同算法 **→ 需改用 `javax.crypto.Cipher`**
- [x] WebSocket 升级（Ktor `/socket` + Node `lan-ws-client.js` 哑桥）
- [x] PING/PONG over encrypted channel（离线 4/4 通过，但 mock-phone 不走 Kotlin）
- [ ] **修复：Kotlin 改用 `javax.crypto.Cipher` 自控 IV**（必改 1）
- [ ] **修复：加 JVM 互操作测试验证 Kotlin ↔ JS 字节互通**（必改 2）
- [ ] 建议项：maxFrameSize / close() 擦密钥 / SecureRandom 字段化 / host 白名单

### M3'-A — 配对（PIN + 指纹 TOFU + paired_devices，~2.5h）🟡 等 reviewer 复审
- [x] DB schema：`paired_devices(fingerprint PK, label, pubkey, trusted_at, last_seen)` + migration
- [x] `secure.js` / `Crypto.kt` 加 `fingerprintHex(pubBytes)`（SHA-256 64 hex，4-4-4 分组显示前 32 字符）
- [x] 手机端**滚动 PIN**（6 位，30s 窗口，HKDF(pair_secret, floor(now/30s)) → 6 位 mod 1e6）
- [x] 加密通道消息层扩展：`PAIR_REQUEST {pin, w}` / `PAIR_OK {fingerprint, label}` / `PAIR_REJECT {reason}`
- [x] 锁定：5 次错 / 60s 窗口（in-memory `PairAttemptTracker`，service 重启清零）
- [x] Kotlin handler 接到 `/socket` 路由（`handlePairRequest` 状态机）
- [x] 跨语言 JVM 测试：`CryptoPairingTest.kt`（rollingPin 18 向量 / verifyPin / tracker / fingerprintHex）
- [ ] APK 持久化：`androidx.security:security-crypto` + `TrustStore.kt`（移到 M4' — 当前 PC 端已落 sqlite，APK 端目前不持久化已配对 PC，下次连仍需重 PIN，可接受）
- [x] APK UI：`HotspotPairActivity` 显示滚动 PIN + 用户确认按钮接 `userApprovesNext`（commit 1781edc）
- [x] PC UI：`lan-pair.js` 接 PIN 输入框流程 + POST /api/lan/devices/trust 持久化（commit 1781edc）
- [x] PC 端 `/api/lan/devices/*` REST 端点（trust/list/revoke）+ 24 个路由集成测试（commit 2481867）
- [x] `userApprovesNext` per-socket reset + PAIR_OK 后消费（commit 1235c73）

### M3'-B — 主密码挑战（生物识别）分支 `feature/m3b-biometric-challenge`
设计稿：`docs/m3b-biometric-challenge-design.md`（§14 拆 B-1~B-7）
- [x] **B-1** @ 074500a — PAIR_OK 扩展 `device_hmac_key_b64`/`biometric_capable` + db schema v4（device_hmac_key/last_challenge_at/last_fallback_at）+ 两端单测（db 27/routes 34/pairing 19 全绿）
- [x] **B-2** @ 06489e4 — `Crypto.kt` 字节级 `buildChallengeAad` + Keystore 助手（**导入**而非 generateKey，偏离 §5 已记决策）+ `BiometricChallengeSigner` + Node 向量生成器自检 6/6（reviewer ⚠️通过 + 1 must-fix）
- [x] **B-3** @ 617f754 — `HotspotServerService.handleChallenge` dispatcher + `ChallengeBridge` + 透明 `ChallengePromptActivity` + manifest/theme
- [ ] **reviewer B-2 待办**（清理）：#2 过时注释（service 顶部 TODO(B-2)）/ #3 文档 §4「15B」§5「import」/ #4 catch 窄化到 StrongBoxUnavailableException
- [ ] **B-4** — PC 端 `src/lan-challenge.js`（verify hmac/ts/nonce/purpose/fingerprint）+ `src/public/js/challenge-ui.js` + Node 测试
- [x] **B-5** — fallback 4 位 PIN + 24h lockout（方案 C 独立 K_pin）+ reviewer 待办 #1（ESP 持久化）
  - 第一刀（PC + Kotlin tracker/PBKDF2）@ 1090b52 ✅
  - 第二刀（Android 端）✅ 本地绿：`computeChallengeHmac` + `FallbackSecretStore`(ESP) + `FallbackPinBridge`/`FallbackPinActivity` + Service 接线（PAIR_OK 带 `device_pin_key_b64` + 配对即设定 PIN + `handleFallbackPin` + `ERROR_LOCKOUT(_PERMANENT)`→FALLBACK_REQ）。JVM 24/24 / lint 0 / JS 33/33
- [x] **B-6** — 跨语言互验（代码侧）：`ChallengeHmacVectorTest` 消费向量 + PC `test-m3b-challenge.js` 33/33 覆盖 fallback 全验收点；instrumented `FallbackSecretStoreInstrumentedTest`（ESP round-trip + lockout 重启持久化，编译过运行留真机）
- [x] **B-7** — 风险登记 §16 加状态列 + 新风险 B6-B9；真机实测清单 `docs/m3b-biometric-challenge-testplan.md`；CHANGELOG 同步。余下纯真机验证
- [ ] **真机执行** `docs/m3b-biometric-challenge-testplan.md`（§15 六验收 + §16 风险 + `:app:connectedDebugAndroidTest`）→ 通过后 merge feature→main

⚠️ 已知依赖（非 B 缺陷）：M3'-A 每连接重生 keypair → CHALLENGE 仅同连接 Keystore 命中（持久身份 M4'）；Service 后台拉 prompt Activity 受 Android 12+ 限，依赖交互前台豁免

### M3'-C — 全量同步（~3h）
- [ ] PC `/api/sync/snapshot` 返回已加密密码列表（不解密）
- [ ] 加密帧 `SYNC_PULL` / `SNAPSHOT {items[]}` / `SYNC_PUSH {items[]}`
- [ ] 冲突策略：updated_at 较新者赢，写 schema_version
- [ ] 1000 条 < 1s 性能测试

### M4' — UI + 持久化（沿用原 M4 ~1 天）
- [ ] phone.html 重做：引导 / 配对 / 已信任设备
- [ ] APK 设备管理面板 + 前台服务通知
- [ ] EncryptedSharedPreferences 存 PC 公钥指纹

### M5' — 加固 + 发布（沿用原 M5 ~1 天）
- [ ] PC 切 Wi-Fi 失败兜底（多网卡 / 企业 Wi-Fi 锁定）
- [ ] iOS 兼容性（iPhone 个人热点）
- [ ] 安全审计自查
- [ ] README + troubleshooting + CHANGELOG v0.3

## 💡 Backlog（v0.4+ 或想到但不急）

- [ ] **AOAP 重启**：等 Linux/Mac 用户量大或 Win 出 Zadig 替代后，把 deprecated 模块复活
- [ ] **USB tethering 路径**（推荐替代 Wi-Fi 热点）：iOS 也支持，PC 不需切 Wi-Fi
- [ ] 增量同步（v0.3 是全量；引入 CRDT 或时间戳 diff）
- [ ] 密码强度显示（zxcvbn）
- [ ] 分类标签管理 UI
- [ ] 全文搜索
- [ ] 自动锁定（idle 5 分钟清 sessionKey）
- [ ] 浏览器扩展（Chrome MV3）自动填充
- [ ] 多设备冲突处理

## ✅ Done

- [x] 2026-06-16 项目初始化（Node.js + Express + SQLite）
- [x] 2026-06-18 v0.2：UI 英文化、导入/导出、4 位码手机验证器、APK 构建
- [x] 2026-06-18 选定 AOAP 方案（ADR-001）+ 完成设计文档/路线图
- [x] 2026-06-18 中文乱码 bug 验证为测试假阳性
- [x] 2026-06-19 **M1 部分通过**：
  - PC 端 `src/public/js/aoap.js` 完整 AOAP 握手实现（已 deprecated）
  - 仓库新增 `android/` 子项目（Gradle + Kotlin + AGP 8.11.1）
  - `UsbAccessoryActivity.kt` USB_ACCESSORY_ATTACHED handler（已 deprecated）
  - **`BiometricDemoActivity.kt` 指纹认证 demo 在小米 14 Pro 实测通过**
  - server 端 `src/aoap-server.js` libusb 握手（已 deprecated）
  - **AOAP 在 Windows MTP 模式下不可行复盘**：`docs/troubleshooting-windows.md`
- [x] 2026-06-19 ADR-002 决策：转向 Wi-Fi 热点路线（B 方案）
- [x] 2026-06-19 **M1' Wi-Fi PoC 实测通过**：
  - 手机端 Ktor CIO server (`HotspotServerService` :9876) 启停稳定
  - 前端 UI (`HotspotPairActivity`) 显示实时 IP 列表 + 服务状态
  - PC 端 `lan-server.js` 通过 `/api/lan/probe` 代理 fetch（绕开浏览器 mixed-content / CORS）
  - 关键坑：API 34+ FGS `connectedDevice` 类型必须搭配 CHANGE_WIFI_STATE 等权限之一
  - 实测：小米 14 Pro + Win11 Chrome ping/pong < 1s 完成
