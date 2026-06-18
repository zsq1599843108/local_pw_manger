# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-18

## 🎯 当前阶段

正在做：**v0.3 — AOAP 手机配对改造**（设计阶段已完成，进入 M1 实施前）
v0.2 进度：100%（核心功能完整）
v0.3 进度：10%（设计 + 路线图就绪，未开工）

## 📍 上次离开时停在哪

- **里程碑**：刚完成 v0.3 的设计文档化（ADR-001 + design + roadmap）
- **代码状态**：v0.2 代码冻结，无变更；git working tree clean
- **文档状态**：4 个根目录 .md + docs/ 下 3 个新文档全部同步到 2026-06-18
- **决策**：手机配对放弃 WebUSB+ADB，改用 AOAP（详见 `docs/adr-001-aoap.md`）

## ⏭️ 下次回来要做的

**优先级最高（M3 阻塞项）：**
1. 修中文乱码 bug — `title`/`notes` 中文存储显示乱码（UTF-8 问题），不修在 AOAP 同步后会扩散到手机端

**然后按 roadmap 推进：**
2. M1 — AOAP 握手 PoC（0.5 天）：先在 PC 端跑通 `aoap.js` 握手，APK 加最小 `UsbAccessoryActivity` 回显
3. M2 — 协议层（1 天）：TLV 帧 + X25519 + AES-GCM
4. M3~M5 — 详见 `docs/aoap-roadmap.md`

**实施前必做：**
- [ ] 跑 `/install-deps` 确认手机端新依赖（Tink + EncryptedSharedPreferences）的安装方式
- [ ] 准备至少一台真机（建议小米/红米，AOAP 兼容性最好）

## 🚧 阻塞 / 待解决

- [x] 确定技术栈（Node.js + Express + SQLite）
- [x] 选定手机配对协议（**AOAP**，2026-06-18）
- [ ] **中文乱码 bug** — 阻塞 M3，必须 M1 之前或与 M1 并行修
- [ ] 需要采购/借测：除小米外另 2 台不同品牌手机做兼容性测试

## 📌 决策记录

- 2026-06-16: 项目初始化
- 2026-06-18: v0.2 全部 UI 和代码改为英文，添加导入导出功能，实现 WebUSB + ADB 手机验证器，APK 构建链跑通
- 2026-06-18: **决策切换**：手机配对从 WebUSB+ADB 改为 AOAP（详见 ADR-001）
  - 理由：用户要求物理 USB 但不开调试模式
  - 代价：开发周期 5~6 天（已认可）
  - 替代方案均已记录拒绝理由

## 🔗 关键文档跳转

- 协议设计 → `docs/aoap-design.md`
- 任务拆解 → `docs/aoap-roadmap.md`
- 选型理由 → `docs/adr-001-aoap.md`
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`
