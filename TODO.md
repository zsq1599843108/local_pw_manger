# 任务清单

> 每完成一项打 [x] 并移到 Done。M1' 起的子任务详见 `docs/wifi-hotspot-roadmap.md`（待 Phase 2 写）。

## 🔥 In Progress

- [ ] **M3'-A — 配对协议**（PIN + 指纹 TOFU + paired_devices 持久化，分支 `feature/m3-pairing-sync`，~2.5h）
- [ ] M2' 等 reviewer 审（分支 `feature/m2-encrypted-channel`，离线 e2e 已通过，待小米 14 Pro 现场联调）

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

### M2' — 加密通道（~1 天） ✅ 离线 e2e 完成
- [x] PC: `secure.js` X25519 + HKDF + AES-GCM
- [x] APK: `Crypto.kt` Tink 镜像同算法
- [x] WebSocket 升级（Ktor `/socket` + Node `lan-ws-client.js` 哑桥）
- [x] PING/PONG over encrypted channel（离线 4/4 通过：握手 / PING-PONG / GCM tamper 拒收 / replay 拒收）
- [ ] 小米 14 Pro 现场联调（等 reviewer 通过后做）

### M3'-A — 配对（PIN + 指纹 TOFU + paired_devices，~2.5h，本里程碑）
- [ ] DB schema：`paired_devices(fingerprint PK, label, pubkey, trusted_at, last_seen)` + migration
- [ ] `secure.js` / `Crypto.kt` 加 `fingerprintHex(pubBytes)`（SHA-256 前 16B → 32 hex，4-4-4 分组显示）
- [ ] 手机端**滚动 PIN**（6 位，30s 窗口，HKDF(rolling_secret, floor(now/30s)) → 6 位 mod 1e6）
- [ ] 加密通道消息层扩展：`PAIR_REQUEST {pin, t}` / `PAIR_OK {peer_fingerprint, peer_label}` / `PAIR_REJECT {reason}`
- [ ] 锁定：5 次错 / 60s 窗口（in-memory，service 重启清零）
- [ ] APK 持久化：`androidx.security:security-crypto` + `TrustStore.kt`
- [ ] 测试：`scripts/test-m3a-pairing.js`（PIN 正/错/锁/过期）+ DB 单测

### M3'-B — 主密码挑战（生物识别，~2.5h）
- [ ] 加密帧 `CHALLENGE {nonce32}` / `RESPONSE {sig}` over established session
- [ ] APK 复用 `BiometricDemoActivity` 模式弹 BiometricPrompt
- [ ] 失败兜底回 4 位码（v0.2 路径已在 aoap-server.js）

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
