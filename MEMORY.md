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

### v0.3 新增（AOAP 改造期，已 deprecated 不删）
| 计划 | 文件 | 角色 |
|--------|------|------|
| ⚠️ DEPRECATED | `src/public/js/aoap.js` | AOAP 握手 + WebUSB（仅 Linux/Mac 可用，Win 被 MTP 驱动锁） |
| ⚠️ DEPRECATED | `src/public/js/aoap-page.js` | 浏览器 AOAP UI |
| ⚠️ DEPRECATED | `src/aoap-server.js` | Node 端 libusb 握手 + `/api/aoap/handshake` |
| 🔨 | `src/public/js/frame.js` | TLV 帧编解码（M2'/M3' 沿用） |
| 🔨 | `src/public/js/secure.js` | X25519 + HKDF + AES-GCM（M2' 沿用） |

### v0.3 现行（Wi-Fi 热点路线，M1' GA）
| 重要度 | 文件 | 角色 |
|--------|------|------|
| ⭐⭐⭐ | `src/lan-server.js` | PC 端代理 fetch 手机 Ktor server，导出 probe + `/api/lan/probe` |
| ⭐⭐⭐ | `src/public/js/lan-pair.js` | 浏览器「Pair via Wi-Fi」按钮逻辑 |
| 🔨 | (待 M2') `src/public/js/lan-secure.js` | WebSocket + X25519 + AES-GCM |
| 🔨 | (待 M2') `src/lan-ws-client.js` | Node ws client 包 |

### Android 子项目（v0.3-m1 起，仓库内 `android/`）
| 重要度 | 文件 | 角色 |
|--------|------|------|
| ⭐⭐⭐ | `android/app/build.gradle.kts` | Kotlin/AGP 8.11.1 配置，含 biometric / appcompat / **Ktor 2.3.13 + kotlinx-serialization** |
| ⭐⭐⭐ | `android/app/src/main/AndroidManifest.xml` | activities + service + accessory_filter meta + FGS 权限链（**含 CHANGE_WIFI_STATE，API 34+ FGS gate**） |
| ⭐⭐⭐ | `.../HotspotPairActivity.kt` | **M1' 主 Launcher**：Start/Stop server + 实时 IP 列表 |
| ⭐⭐⭐ | `.../HotspotServerService.kt` | **M1' Ktor 前台服务**：监听 :9876，路由 `/ping` |
| ⭐⭐ | `.../BiometricDemoActivity.kt` | 指纹认证 demo（M1 实测通过） |
| ⭐⭐⭐ | `.../FallbackSecretStore.kt` | **B-5** ESP 封装：K_pin + PIN hash/salt + lockout 持久化 |
| ⭐⭐⭐ | `.../FallbackPinBridge.kt` + `FallbackPinActivity.kt` | **B-5** PIN 输入 Activity（SET/VERIFY）+ service 桥 |
| ⚠️ | `.../UsbAccessoryActivity.kt` | AOAP USB handler（Win 不可用，DEPRECATED） |
| ⭐⭐ | `android/app/src/main/res/xml/accessory_filter.xml` | AOAP manufacturer/model 匹配（DEPRECATED 但留给 Linux/Mac） |
| ⭐ | `android/settings.gradle.kts` | 含国内镜像（aliyun + 华为云） |
| ⭐ | `android/gradle.properties` | JDK 17 home + worker=1（Win Gradle 8.14 死锁规避） |

## 🚫 不要碰

- `node_modules/` — 依赖（在 .gitignore）
- `data/passwords.db*` — 用户数据
- `releases/` — junction，不直接改

## 📚 设计文档索引

### 现行（Wi-Fi 热点路线）
- [ADR-002 Wi-Fi 热点](docs/adr-002-wifi-hotspot.md) — 选型决策（B 路线，2026-06-19）
- [wifi-hotspot-design.md](docs/wifi-hotspot-design.md) — 协议 + 流程图 + 加密通道
- [wifi-hotspot-roadmap.md](docs/wifi-hotspot-roadmap.md) — M1'~M5' 拆解（5 天预算）

### 已 deprecated（保留作历史 + Linux/Mac 备选）
- [AOAP 设计文档](docs/aoap-design.md) — v0.3 第一版（USB AOAP）
- [AOAP 实施路线图](docs/aoap-roadmap.md) — 5 里程碑（M1 跑了一半）
- [ADR-001：选用 AOAP](docs/adr-001-aoap.md) — 第一次选型理由（已 Superseded by ADR-002）
- [Win AOAP 阻塞复盘](docs/troubleshooting-windows.md) — MTP 驱动锁死 vendor 控制传输

## ⚠️ 已知遗留问题

- ~~中文乱码~~：2026-06-18 验证为测试假阳性（Windows GBK 控制台），代码全程 UTF-8 正确
- **MEMORY/TODO/CHANGELOG 同步过迟**：v0.2 大更新（英文化+导入导出+APK）当时未及时记账，2026-06-18 补齐

## 🧪 测试

- `scripts/test-utf8.js` — UTF-8 round-trip 验证（先 `node src/server.js` 起服）
  - 教训：以后测中文不能看 PowerShell/curl 在 GBK 控制台的输出，必须看字节 hex 或浏览器实际渲染

## 🔧 技术栈

- 后端：Node.js + Express 4 + better-sqlite3 11
- 前端：原生 HTML/JS/CSS（无框架）
- 加密：Node `crypto` 模块（PBKDF2 100K + AES-256-GCM）
- 端口：`localhost:3000`
- v0.3 新增：WebUSB / WebCrypto（PC）+ Tink + AndroidKeyStore（手机）
