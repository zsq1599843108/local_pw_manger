# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-18 (晚)

## 🎯 当前阶段

正在做：**v0.3 — AOAP 手机配对改造**（设计完成 + 阻塞项已澄清，可直接开 M1）
v0.2 进度：100%（核心功能完整）
v0.3 进度：12%（设计 ✅ + roadmap ✅ + UTF-8 阻塞项澄清 ✅，未开工 M1）

## 📍 上次离开时停在哪

- **里程碑**：完成 v0.3 设计文档（ADR-001 + design + roadmap）+ 澄清 UTF-8 阻塞项
- **代码状态**：v0.2 代码无变更；新增 `scripts/test-utf8.js` 自动化测试
- **测试状态**：UTF-8 round-trip 7/7 通过（含简繁中日韩、emoji、4 字节 CJK 扩展）
- **关键澄清**：之前标记的「中文乱码 bug」是**测试假阳性** — Windows GBK 控制台显示 UTF-8 字节本来就乱，DB/HTTP/HTML 三层全程 UTF-8 正确，浏览器实际显示无问题。详见 `CHANGELOG.md` v0.3 Unreleased 段
- **git working tree clean**

## ⏭️ 下次回来要做的

**直接开 M1（无阻塞）：**
1. M1 — AOAP 握手 PoC（0.5 天）：
   - 新建 `src/public/js/aoap.js`（getProtocol / sendString / startAccessory）
   - APK 加最小 `UsbAccessoryActivity` 回显
   - 真机插线 → 弹「打开 PassMan?」→ console echo 跑通

**M2~M5 详见 `docs/aoap-roadmap.md`**

**实施前必做：**
- [ ] 跑 `/install-deps` 确认手机端新依赖（Tink + EncryptedSharedPreferences）的安装方式
- [ ] 准备至少一台真机（建议小米/红米，AOAP 兼容性最好）

## 🚧 阻塞 / 待解决

- [x] 确定技术栈（Node.js + Express + SQLite）
- [x] 选定手机配对协议（**AOAP**，2026-06-18）
- [x] ~~中文乱码 bug~~ — **2026-06-18 验证为测试假阳性**，无需修复
- [ ] 需要采购/借测：除小米外另 2 台不同品牌手机做兼容性测试

## 📌 决策记录

- 2026-06-16: 项目初始化
- 2026-06-18: v0.2 全部 UI 和代码改为英文，添加导入导出功能，实现 WebUSB + ADB 手机验证器，APK 构建链跑通
- 2026-06-18: **决策切换**：手机配对从 WebUSB+ADB 改为 AOAP（详见 ADR-001）
  - 理由：用户要求物理 USB 但不开调试模式
  - 代价：开发周期 5~6 天（已认可）
- 2026-06-18: **阻塞项澄清**：中文乱码不是 bug，验证用例 `scripts/test-utf8.js` 7/7 通过
  - 教训：以后用 PowerShell/curl 测中文必须看字节而非控制台显示

## 🔗 关键文档跳转

- 协议设计 → `docs/aoap-design.md`
- 任务拆解 → `docs/aoap-roadmap.md`
- 选型理由 → `docs/adr-001-aoap.md`
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`
- UTF-8 验证 → `scripts/test-utf8.js`（`node src/server.js` 起服后跑）
