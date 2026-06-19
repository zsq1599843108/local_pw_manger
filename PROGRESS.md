# 当前进度

> Claude 进入项目时**第一个读这个文件**。每次离开前必须更新「上次离开时停在哪」和「下次回来要做的」。

**last update**: 2026-06-19（Phase 2 文档完成，准备开 M1'）

## 🎯 当前阶段

正在做：**v0.3 — Wi-Fi 热点改造**
- v0.3 整体进度：~35%
- M1 进度：**部分通过**（指纹 demo ✅，AOAP 在 Win 死路一条 ❌，Phase 1 commit `a484b32` 已落）
- ADR-002 + 设计 + roadmap：✅ 完成（Phase 2）
- 下个里程碑：**M1'**（Wi-Fi hotspot PoC，0.5 天）

## 📍 上次离开时停在哪

- **里程碑**：Phase 2 文档完成（ADR-002 + design + roadmap），M1' 未开工
- **代码状态**：Phase 1 已 commit；Phase 2 仅文档（无代码改动），待 commit
- **测试状态**：M1 已验证 ✅ 指纹通 / ❌ AOAP 不通；M1' 未开始
- **git working tree**：未 commit Phase 2（3 个新文档 + PROGRESS/TODO/MEMORY 更新）

## ⏭️ 下次回来要做的

**Phase 3：M1' Wi-Fi PoC（~0.5 天）**

实施步骤详见 `docs/wifi-hotspot-roadmap.md` §M1'。摘要：
1. APK：`app/build.gradle.kts` 加 Ktor 依赖（先跑 `/install-deps` 询问用户）
2. APK：`HotspotServerService.kt` 前台服务 + Ktor :9876
3. APK：`HotspotPairActivity.kt` 状态 UI
4. APK：manifest 加 FOREGROUND_SERVICE / POST_NOTIFICATIONS / ACCESS_NETWORK_STATE
5. PC：`src/lan-server.js` + `/api/lan/probe`
6. PC：`src/public/js/lan-pair.js` + phone.html 入口
7. 联调：你开热点 → PC 切 Wi-Fi → ping 通

**实施前必做：**
- [ ] 跑 `/install-deps` 询问用户：手机端 Ktor 依赖如何装
- [ ] 询问：是否要现在就动 v0.4+ Backlog 的 USB tethering 路径作为兜底，还是 v0.3 仅做 Wi-Fi 热点

## 🚧 阻塞 / 待解决

- [x] 确定技术栈（Node.js + Express + SQLite）
- [x] 选定手机配对协议（**AOAP**，2026-06-18）→ ❌ Win 上不可行
- [x] **新协议选定（Wi-Fi hotspot，2026-06-19）**
- [ ] 准备 iPhone 测兼容性（v0.4+ 范畴）

## 📌 决策记录

- 2026-06-16: 项目初始化
- 2026-06-18: v0.2 全部 UI 和代码改为英文，添加导入导出，实现 WebUSB + ADB 手机验证器
- 2026-06-18: 决策切 AOAP（ADR-001）
- 2026-06-19: **M1 部分通过：指纹 demo OK，AOAP 在 Win 死路一条**
  - libusb / Chrome WebUSB 都被 Win MTP 驱动锁 vendor 控制传输
  - 用户拒绝 Zadig（会丢 MTP 文件传输）
- 2026-06-19: **决策切 Wi-Fi 热点（ADR-002 即将写）**
  - 用户选 B 路线（手机做热点，PC 加入热点）
  - 复用 M2 加密协议设计，传输层从 USB bulk 换 TCP/HTTP
  - AOAP 代码全部 deprecated 不删，Linux/Mac 仍可走

## 🔗 关键文档跳转

- AOAP 设计（已 deprecated 留作历史）→ `docs/aoap-design.md`
- AOAP 路线图（已 deprecated）→ `docs/aoap-roadmap.md`
- ADR-001 AOAP 选型（已 Superseded）→ `docs/adr-001-aoap.md`
- **Win AOAP 阻塞复盘** → `docs/troubleshooting-windows.md`
- **现行决策** → `docs/adr-002-wifi-hotspot.md` ✅
- **现行设计** → `docs/wifi-hotspot-design.md` ✅
- **现行路线图** → `docs/wifi-hotspot-roadmap.md` ✅
- 文件地图 → `MEMORY.md`
- 任务清单 → `TODO.md`
