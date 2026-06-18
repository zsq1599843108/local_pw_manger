# 任务清单

> 每完成一项打 [x] 并移到 Done。M1~M5 详细子任务见 `docs/aoap-roadmap.md`。

## 🔥 In Progress

- [ ] **修中文乱码 bug**（M3 阻塞项，必须先修）
  - 复现：`title` 或 `notes` 输入中文 → 显示乱码
  - 排查方向：Express body-parser 编码、SQLite text encoding pragma、HTML meta charset

## ⏭️ Next（v0.3 — AOAP 改造，按 milestone 推进）

### M1 — AOAP 握手 PoC（0.5 天）
- [ ] 新建 `src/public/js/aoap.js`：getProtocol / sendString / startAccessory
- [ ] APK 加 `UsbAccessoryActivity` + `accessory_filter.xml`
- [ ] 真机插线 → 弹「打开 PassMan?」→ console echo 跑通

### M2 — 协议层（1 天）
- [ ] PC: `frame.js` TLV 编解码（处理粘包）
- [ ] PC: `secure.js` X25519 + HKDF + AES-GCM
- [ ] 手机: `Frame.kt` + `Secure.kt`（用 Tink）
- [ ] PING/PONG 往返 < 50ms

### M3 — 应用层（1.5 天）
- [ ] 配对：HELLO / HELLO_ACK / PAIR_REQUEST / PAIR_CONFIRM
- [ ] sqlite 加 `paired_devices` 表 + migration
- [ ] 主密码挑战流程（CHALLENGE / RESPONSE）
- [ ] 全量同步（SYNC_PULL / SYNC_PUSH，last-write-wins）

### M4 — UI + 持久化（1 天）
- [ ] `phone.html` 重做：引导 / 配对 / 已信任设备列表
- [ ] APK 设备管理面板 + 前台服务通知
- [ ] EncryptedSharedPreferences 存 PC 公钥指纹

### M5 — 加固 + 发布（1 天）
- [ ] 异常恢复：拔线 / 帧错 / 协商失败
- [ ] 兼容性测试：3 台不同品牌手机
- [ ] 安全审计自查（重放、签名、明文）
- [ ] README + troubleshooting + CHANGELOG v0.3

## 💡 Backlog（v0.4+ 或想到但不急）

- [ ] 增量同步（v0.3 是全量；引入 CRDT 或时间戳 diff）
- [ ] iOS 配对方案（候选：BLE / 二维码扫描）
- [ ] 密码强度显示（zxcvbn）
- [ ] 分类标签管理 UI
- [ ] 全文搜索
- [ ] 自动锁定（idle 5 分钟清 sessionKey）
- [ ] 浏览器扩展（Chrome MV3）自动填充
- [ ] 多设备冲突处理（双向 sync 时同条目两端都改）

## ✅ Done

- [x] 2026-06-16 项目初始化（Node.js + Express + SQLite）
- [x] 2026-06-18 v0.2：UI 全英文化、导入/导出、4 位码手机验证器、APK 构建
- [x] 2026-06-18 选定 AOAP 方案（ADR-001）+ 完成设计文档/路线图
