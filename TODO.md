# 任务清单

> 每完成一项打 [x] 并移到 Done。M1' 起的子任务详见 `docs/wifi-hotspot-roadmap.md`（待 Phase 2 写）。

## 🔥 In Progress

- [ ] M1' — Wi-Fi PoC：手机端 Ktor server + PC 端 ping/pong（详见 `docs/wifi-hotspot-roadmap.md` §M1'）

## ⏭️ Next（v0.3 — Wi-Fi 热点改造，覆盖 AOAP）

### Phase 2 — 文档（~30 min） ✅ 完成
- [x] `docs/adr-002-wifi-hotspot.md` — 决策记录（含 AOAP Win 阻塞复盘）
- [x] `docs/wifi-hotspot-design.md` — 协议 + 流程图 + 加密通道
- [x] `docs/wifi-hotspot-roadmap.md` — M1'~M5' 拆解
- [x] 更新 `MEMORY.md` 文件地图

### M1' — Wi-Fi PoC：ping/pong（~0.5~1 天）
- [ ] APK：app/build.gradle 加 `io.ktor:ktor-server-netty:2.3.x`
- [ ] APK：`HotspotServerService.kt` — 前台服务，Ktor server 端口 9876，路由 `GET /ping → "pong"`
- [ ] APK：`HotspotPairActivity.kt` — 显示 SSID/密码/PIN，启动/停止热点开关
- [ ] APK：manifest 加 `FOREGROUND_SERVICE`、`POST_NOTIFICATIONS`、（可选）`CHANGE_NETWORK_STATE`
- [ ] PC：`phone.html` 加「Wi-Fi 配对」入口
- [ ] PC：`src/public/js/lan-pair.js` 浏览器端逻辑
- [ ] PC：`src/lan-server.js` + server.js 加 `/api/lan/probe` 端点
- [ ] 联调：你开热点 → PC 切 Wi-Fi → ping 通

### M2' — 加密通道（沿用原 M2 设计 ~1 天）
- [ ] PC: `secure.js` X25519 + HKDF + AES-GCM
- [ ] APK: Tink 镜像同算法
- [ ] WebSocket 升级（替代裸 HTTP）
- [ ] PING/PONG over encrypted channel

### M3' — 应用层（沿用原 M3 ~1.5 天）
- [ ] 配对：PIN 校验 + 公钥指纹 TOFU
- [ ] paired_devices 表 + migration
- [ ] 主密码挑战（**用上 BiometricPrompt**）
- [ ] 全量同步

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
