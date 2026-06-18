# AOAP 实施路线图

> 配套设计文档：[aoap-design.md](aoap-design.md)
> 配套决策记录：[adr-001-aoap.md](adr-001-aoap.md)
> 启动日期：2026-06-18

## 总览

5 个阶段，预估 5~6 个开发日（按全职估算，碎片化时间需翻倍）。

```
M1 PoC          M2 协议层      M3 应用层      M4 集成       M5 加固
握手通  ──►   帧+ECDH  ──►  配对+同步  ──►  UI+持久化 ──► 异常+测试
0.5d         1d            1.5d           1d            1d
```

## M1 — PoC：AOAP 握手跑通（0.5 天）

**目标：** PC 端 Chrome 能让任意 Android 手机切到 accessory 模式，bulk 端点能读写一个 hello world。

### PC 端
- [ ] 新建 `src/public/js/aoap.js`
  - [ ] `requestDevice()` — 任意 Android 厂商 VID 过滤
  - [ ] `getProtocol()` — control IN req=51 验证 ≥ 1
  - [ ] `sendString(id, str)` — control OUT req=52
  - [ ] `startAccessory()` — control OUT req=53
  - [ ] 处理设备重枚举 + 重新 claim（VID 0x18D1）
- [ ] 把 `phone.html` 加一个「试用 AOAP 模式」按钮（保留旧 token 流程）

### 手机端
- [ ] 复用现有 APK 项目，新增最小 `UsbAccessoryActivity`
- [ ] `accessory_filter.xml` + manifest intent-filter
- [ ] 收到 accessory → 打开 input/output FileDescriptor → 回显字节
- [ ] 装到真机（红米/小米首选，三星次之，OPPO/VIVO 已知有兼容性坑）

### 验收标准
- 在 Win11 + Chrome 上插线，手机弹「打开 PassMan?」
- 点确认后浏览器 console 打印 `received: hello`
- 拔线插线重复 5 次稳定

### 风险点
- 手机 ROM 默认 USB 模式 — 需文档说明用户怎么切
- WebUSB 在 Windows 部分 USB Hub 上枚举失败 — 直连主板口

---

## M2 — 协议层：帧编码 + 密钥协商（1 天）

### PC 端
- [ ] `src/public/js/frame.js` — TLV 帧编解码器
  - [ ] `encode(type, payload) → Uint8Array`
  - [ ] `decode(stream) → AsyncGenerator<Frame>` （处理粘包/拆包）
  - [ ] Magic + length 校验，错位即丢弃整流
- [ ] `src/public/js/secure.js` — 加密通道
  - [ ] X25519 keygen（WebCrypto）
  - [ ] HKDF 派生 session_key
  - [ ] AES-256-GCM encrypt/decrypt（与 `crypto.js` 复用算法常量）
  - [ ] frame_counter 防重放

### 手机端
- [ ] `Frame.kt` — 镜像 TLV 编解码
- [ ] `Secure.kt` — Tink 库 X25519 + HKDF + AES-GCM
- [ ] `Channel.kt` — 把 FileDescriptor I/O 包成挂起 send/recv

### 验收标准
- PC 发 PING (0xF0)，手机回 PONG (0xF1)，往返延迟 < 50ms
- 故意发坏帧，双方能丢弃并自我恢复
- session_key 协商成功后 encrypt 一段 1KB，对端能解密一致

### 风险点
- WebCrypto X25519 在旧版 Chrome 不支持 — 检查 `caniuse`，必要时回退 P-256 ECDH
- Tink 库体积约 1MB — APK 加 ProGuard 规则裁剪

---

## M3 — 应用层：配对 + 同步（1.5 天）

### 配对（首次）
- [ ] PC 发 HELLO，手机回 HELLO_ACK + 公钥
- [ ] 手机端弹自己 UI：显示 PC 端 display_name 和公钥指纹后 8 位
- [ ] 用户点「信任此设备」→ PC 公钥写入手机 SharedPrefs
- [ ] PC 端把手机公钥指纹存到 sqlite 新表 `paired_devices`

```sql
CREATE TABLE paired_devices (
  id INTEGER PRIMARY KEY,
  phone_pubkey BLOB NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  display_name TEXT,
  paired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sync_at DATETIME
);
```

### 主密码挑战
- [ ] CHALLENGE 帧：PC 用 session_key 加密「请输入主密码哈希」
- [ ] 手机端 UI 输入主密码 → PBKDF2 哈希 → 加密回传 CHALLENGE_RESPONSE
- [ ] PC 端用现有 `/api/auth/verify` 流程验证

### 密码库同步
- [ ] PC 端：`/api/passwords` 现有路径之外，加 `/api/sync/snapshot` 返回完整密码列表（已加密）
- [ ] SYNC_PULL：手机请求 → PC 回完整 dump（v0.3 不做增量）
- [ ] SYNC_PUSH：手机本地新增条目 → PC 接收 → 落 sqlite
- [ ] 冲突策略 v0.3：updated_at 较新者赢（last-write-wins，记 TODO 后续做 CRDT）

### 验收标准
- 首次配对：用户点 1 次「信任」即建立配对
- 二次连接：插线 → 自动认证 → 进入 ACTIVE 状态 < 2 秒
- 1000 条记录全量同步 < 2 秒

### 风险点
- 手机端 sqlite 与 PC schema 不一致需 migration
- 中文乱码 bug 仍未修（PROGRESS 遗留）— **必须在 M3 前修**，否则同步后扩散

---

## M4 — 集成 + UI（1 天）

### PC 端
- [ ] `phone.html` 重做
  - [ ] 引导面板：检测 USB → 连线提示 → 等待握手
  - [ ] 配对面板：显示手机指纹 + 「已信任」列表
  - [ ] 状态徽标：DISCONNECTED / PAIRING / ACTIVE
  - [ ] 出错时降级到 4 位码 token 流程
- [ ] `app.js` 新增「USB 同步」入口

### 手机端
- [ ] `MainActivity` 加「设备管理」面板
- [ ] 通知栏前台服务：「USB 配件已连接 — PassMan」
- [ ] 配对二次确认弹窗（防被 silent 配对）

### 持久化
- [ ] PC 端 sqlite 加 `paired_devices` 表 + migration（检查现有 schema 升级方式）
- [ ] 手机端 SharedPrefs 加密存储 PC 公钥（用 EncryptedSharedPreferences）

---

## M5 — 加固 + 测试（1 天）

### 异常处理
- [ ] 拔线 → 双方 5 秒内进入 DISCONNECTED
- [ ] 帧解析错误 → 重置通道但不杀进程
- [ ] session_key 协商失败 → 回到 HELLO 重试 1 次
- [ ] 手机睡眠 → wake lock 维持 USB 服务

### 兼容性测试
- [ ] Win11 + Chrome 130
- [ ] Win11 + Edge 130
- [ ] Win10 + Chrome
- [ ] macOS + Chrome（如有 Mac）
- [ ] Linux + Chrome（次要）
- [ ] 手机至少 3 台：小米、三星、其他国产

### 安全审计自查
- [ ] 主密码哈希永不过 USB 明文
- [ ] session_key 仅留内存，断线即销毁
- [ ] 重放攻击模拟：录帧重发 → 必须被丢弃
- [ ] 手机端 APK 签名校验（防被替换）

### 文档
- [ ] `README.md` 加 AOAP 使用章节
- [ ] `docs/troubleshooting.md` 列各品牌手机已知坑
- [ ] CHANGELOG 写 v0.3 完整 release notes

---

## 风险登记

| ID | 风险 | 影响 | 缓解 | 状态 |
|----|------|------|------|------|
| R1 | iOS 不支持 AOAP | 用户群受限 | 文档说明仅 Android；二期做 BLE/QR | 接受 |
| R2 | 部分手机 USB 模式默认仅充电 | 配对失败 | 文档+UI 提示切「USB 配件」 | 待 M5 测 |
| R3 | WebUSB 兼容性 | 部分浏览器不可用 | 仅声明支持 Chrome/Edge | 接受 |
| R4 | 中文乱码 bug 同步会扩散 | 数据一致性 | M3 前必须修 | **阻塞** |
| R5 | APK 签名/构建链改动 | 现有 release 流失 | 用现有 v1.0 APK 增量改 | 待 M1 |
| R6 | AOAP 协议有新版 v3 | 设计需调整 | 锁 v2，足够够用 | 接受 |

## 依赖

**新增 PC 端依赖：** 无（WebCrypto/WebUSB 都是浏览器原生）
**新增手机端依赖：**
- `com.google.crypto.tink:tink-android:1.13.x`（X25519 + HKDF）
- `androidx.security:security-crypto:1.1.x`（EncryptedSharedPreferences）

依赖安装走 `/install-deps` 流程，先问用户。

## 里程碑提交策略

每个 M 完成提交一次：
- M1 → `feat(aoap): handshake PoC`
- M2 → `feat(aoap): framing + key agreement`
- M3 → `feat(aoap): pairing + sync`
- M4 → `feat(aoap): UI + persistence`
- M5 → `chore(aoap): hardening + docs`

每次提交前更新 `PROGRESS.md` + `CHANGELOG.md` Unreleased 段。

## 回滚预案

如果某个 M 卡住超 2 倍预估时间：
1. M1 卡住 → 退到 USB 网络共享方案（roadmap 重写）
2. M2/M3 卡住 → 简化协议，去掉 ECDH 改预共享密钥（用配对码派生）
3. M4/M5 卡住 → 砍 UI 美化，先发 v0.3-beta 收反馈

## 完成定义 (DoD)

v0.3 发布需满足：
- ✅ 3 台不同品牌手机能成功配对+同步
- ✅ 首次配对 ≤ 3 步用户操作
- ✅ 二次连接全程自动 ≤ 3 秒
- ✅ 拔线/异常不丢数据
- ✅ APK 体积增量 ≤ 2 MB
- ✅ 文档完整（README + troubleshooting + 本路线图归档为「已完成」）
