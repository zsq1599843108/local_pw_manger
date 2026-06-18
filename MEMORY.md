# 本地密码管理器 — 本地记忆索引

## 🔑 关键文件地图（修改前必读）

### 后端（Node.js）
| 重要度 | 文件 | 角色 |
|--------|------|------|
| ⭐⭐⭐ | `src/server.js` | Express 主服务，所有 `/api/*` 路由 |
| ⭐⭐⭐ | `src/crypto.js` | AES-256-GCM + PBKDF2 加密核心 |
| ⭐⭐ | `src/db.js` | SQLite (better-sqlite3) 初始化 + schema |
| — | `data/passwords.db` | 用户密码库（勿提交，已 .gitignore） |

### 前端（静态文件）
| 重要度 | 文件 | 角色 |
|--------|------|------|
| ⭐⭐⭐ | `src/public/index.html` | 主 UI |
| ⭐⭐⭐ | `src/public/js/app.js` | 主应用逻辑 + API 调用 |
| ⭐⭐ | `src/public/phone.html` | 手机验证器/配对页（v0.3 重写为 AOAP） |
| ⭐ | `src/public/css/style.css` | 全局样式 |

### v0.3 新增（AOAP 改造期，待实施）
| 计划 | 文件 | 角色 |
|--------|------|------|
| 🔨 | `src/public/js/aoap.js` | AOAP 握手 + WebUSB |
| 🔨 | `src/public/js/frame.js` | TLV 帧编解码 |
| 🔨 | `src/public/js/secure.js` | X25519 + HKDF + AES-GCM |
| 🔨 | `src/public/js/pair.js` | 配对状态机 |

## 🚫 不要碰

- `node_modules/` — 依赖（在 .gitignore）
- `data/passwords.db*` — 用户数据
- `releases/` — junction，不直接改

## 📚 设计文档索引

- [AOAP 设计文档](docs/aoap-design.md) — v0.3 手机 USB 配对的协议+架构+流程图（开发期主参考）
- [AOAP 实施路线图](docs/aoap-roadmap.md) — 5 个里程碑任务拆解，每天对照执行
- [ADR-001：选用 AOAP](docs/adr-001-aoap.md) — 为什么选 AOAP 而非 USB 网络共享/QR/BLE

## ⚠️ 已知遗留问题

- **中文乱码**：`title` / `notes` 字段存中文显示乱码（UTF-8 编码 bug）—  M3 同步前必须修，否则会扩散到手机端
- **MEMORY/TODO/CHANGELOG 同步过迟**：v0.2 大更新（英文化+导入导出+APK）当时未及时记账，2026-06-18 补齐

## 🔧 技术栈

- 后端：Node.js + Express 4 + better-sqlite3 11
- 前端：原生 HTML/JS/CSS（无框架）
- 加密：Node `crypto` 模块（PBKDF2 100K + AES-256-GCM）
- 端口：`localhost:3000`
- v0.3 新增：WebUSB / WebCrypto（PC）+ Tink + AndroidKeyStore（手机）
