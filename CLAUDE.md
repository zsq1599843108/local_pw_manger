# 本地密码管理器

> 本地加密存储密码的 Web 应用，数据完全离线不上传

## 关键事实

- **类型**: web
- **状态**: in-progress
- **项目目录**: `F:\Projects\local_password_manager\`
- **发布目录**: `F:\Releases\local_password_manager\`

## 加载本地记忆

进入此项目后，按顺序读取：
1. `PROGRESS.md` — 当前快照（最重要）
2. `MEMORY.md` — 关键文件地图 + 设计文档索引
3. `CHANGELOG.md` 最新一行 — 上次里程碑

## 项目本地约束

- 所有数据本地加密存储，不上传任何服务器
- 使用 Web Crypto API 进行加密
- 主密码派生密钥使用 PBKDF2

## 相关全局记忆

- 详见全局 `~/.claude/CLAUDE.md` 强制约束
