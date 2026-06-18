# Changelog

按 [Keep a Changelog](https://keepachangelog.com/) 风格。新条目加在最上面。

## [Unreleased] — v0.3-dev (AOAP 改造)

### Planned
- 手机 USB 配对协议从 WebUSB+ADB 切换到 AOAP（不再需要 USB 调试模式）
- X25519 + HKDF + AES-256-GCM 端到端加密通道
- TLV 帧协议 + 设备指纹持久化配对
- `paired_devices` 表 + 主密码挑战流程
- 完整密码库 USB 同步（v0.3 全量；v0.4+ 增量）

### Documentation
- 新增 `docs/aoap-design.md` — AOAP 协议设计 + 架构图
- 新增 `docs/aoap-roadmap.md` — 5 里程碑实施路线
- 新增 `docs/adr-001-aoap.md` — 配对方案选型决策
- 重写 `MEMORY.md` 文件地图（修正 v0.2 后的实际结构）
- 重写 `TODO.md` 按 M1~M5 拆解

### Known Issues（v0.3 前必修）
- 中文 `title` / `notes` 存储显示乱码（UTF-8 编码 bug）

---

## [v0.2] - 2026-06-18

### Added
- UI 全英文化（界面 + 代码注释）
- 密码库导入/导出 JSON（`/api/export`、`/api/import`）
- 密码生成器 API（`/api/generate`）
- WebUSB + ADB 手机验证器（`phone.html` + `/api/phone/token`、`/api/phone/verify`）
- 4 位一次性码兜底流程（无 USB 时可用）
- Android APK 构建链（Web 套壳）

### Changed
- 中文 UI 文案全部改为英文
- 数据库 schema 加 `category` / `created_at` / `updated_at` 字段

### Deprecated
- WebUSB + ADB 路径（v0.3 将由 AOAP 取代，现保留兜底）

---

## [v0.1] - 2026-06-16

### Added
- 项目初始化（Node.js + Express + better-sqlite3）
- 主密码设置/验证（PBKDF2 100K + SHA-512）
- 密码 CRUD（AES-256-GCM 加密）
- 基础 Web UI（中文）
- WAL 模式 SQLite 存储
