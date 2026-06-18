# 本地密码管理器 — 本地记忆索引

## 🔑 关键文件地图（修改前必读）

| 重要度 | 文件 | 角色 |
|--------|------|------|
| ⭐⭐⭐ | `src/index.html` | 主入口页面 |
| ⭐⭐⭐ | `src/js/crypto.js` | 加密核心模块 |
| ⭐⭐ | `src/js/storage.js` | 本地存储管理 |
| ⭐⭐ | `src/js/app.js` | 主应用逻辑 |
| ⭐ | `src/css/style.css` | 样式 |

## 🚫 不要碰

- `node_modules/` — 依赖（在 .gitignore）
- `releases/` — junction，不直接改

## 📚 设计文档索引

- [设计文档 1](.claude/doc1.md) — 简介
- [设计文档 2](.claude/doc2.md) — 简介
