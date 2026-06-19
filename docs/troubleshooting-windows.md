# Windows AOAP Troubleshooting

> 配套设计：[aoap-design.md](aoap-design.md)
> 启动日期：2026-06-19（M1 联调遇到 Windows 限制后补写）

## TL;DR

**Windows 上手机第一次插这台 PC 之前，必须用 Zadig 装一次 WinUSB 驱动。**
之后这台手机插这台 PC，AOAP 配对就正常了。
**副作用**：装 WinUSB 之后，这台手机插这台 PC 不能用「文件传输 (MTP)」。可以随时回滚。

---

## 为什么需要这一步

AOAP 协议的握手要发**vendor-class control transfer (req=51/52/53)**给整个设备。
Windows 默认给 Android 手机分配的 **MTP 驱动 (`wpdmtp.inf`) 不放行 vendor 请求**——这是 MTP 设计的初衷。结果：

| 工具 | open() | controlTransferIn(req=51) |
|------|--------|---------------------------|
| Chrome WebUSB on Windows | ❌ Access denied | — |
| `usb` npm (libusb) on Windows | ✅ ok | ❌ invalid state |
| Chrome WebUSB on Linux/macOS | ✅ ok | ✅ ok |
| `usb` npm (libusb) on Linux/macOS | ✅ ok | ✅ ok |

Linux 用户 / Mac 用户 **不需要看本文档**——它们的 USB 栈不锁 vendor 请求。

Windows 上唯一软件层的解法：用 [Zadig](https://zadig.akeo.ie/) 把这个特定 VID/PID 的驱动从 MTP 替换成 WinUSB。

---

## 实操（5 分钟）

### 1. 找出你手机的 VID/PID

把手机插好（USB 模式选「文件传输」），打开 PowerShell 跑：

```powershell
Get-PnpDevice -PresentOnly |
  Where-Object { $_.InstanceId -match "USB\\VID_" } |
  Select-Object Status, Class, FriendlyName, InstanceId
```

或者跑项目自带工具：

```bash
"C:/Program Files/nodejs/node.exe" -e "const u = require('usb'); u.usb.loadDevices().then(async () => { (await u.usb.getDevices()).forEach(d => console.log(d.vendorId.toString(16), d.productId.toString(16), d.manufacturerName, '/', d.productName)); });"
```

记下你手机的 4 位十六进制 VID 和 PID。常见：

| 厂商 | VID |
|------|-----|
| 小米 / 红米 | `2717` |
| 华为 | `12d1` |
| 三星 | `04e8` |
| OPPO | `22d9` |
| VIVO | `2d95` |
| OnePlus | `2a70` |

### 2. 下载 Zadig

国内镜像：
```
https://github.com/pbatard/libwdi/releases  ← 用 ghproxy: https://ghproxy.com/https://github.com/...
```
或直接：[zadig.akeo.ie](https://zadig.akeo.ie/)

下载 `zadig-2.x.exe`（约 5 MB），不需要安装直接运行。

### 3. 用 Zadig 装 WinUSB

1. 跑 `zadig-2.x.exe`（管理员权限）
2. 顶部菜单 **Options → List All Devices** 勾选
3. 下拉框找到你的手机（按 VID/PID 对，不要选错——通常名字带「Xiaomi」「OPPO」之类）
4. **重要**：右侧 Driver 选 **`WinUSB (v6.x.x.x)`**，不要选 libusb-win32 / libusbK
5. 点 **Replace Driver** 按钮 → 等 30 秒
6. 状态栏显示 `Driver Installation: SUCCESS` 即可

### 4. 重新跑 AOAP 配对

1. 拔手机重插
2. 浏览器打开 http://localhost:3000/phone.html
3. 点橙色 **Pair via USB (AOAP)** 按钮
4. 这次应该能跑通完整握手

### 5. 顺便（建议但非必须）：accessory 模式 PID

握手成功后手机会切到 `0x18D1:0x2D00`，理论上 Android 的 WCID 描述符会让 Windows 自动加载 WinUSB。如果发现这一步还是 Access denied，把 Zadig 步骤对 `0x18D1:0x2D00` 再做一次。

---

## 回滚（如果想恢复 MTP 文件传输）

1. **设备管理器** → 找到你的手机（在「USB 设备」类目下）
2. 右键 → **卸载设备** → **勾选「删除此设备的驱动程序软件」** → 确定
3. 拔插手机一次，Windows 会自动重新装 MTP 驱动

---

## 替代方案（不想用 Zadig）

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. 永远用 Linux/Mac** | 0 配置 | 多平台支持差 |
| **B. 退回 ADB token** (v0.2 那套) | Windows 上不需要驱动改造 | 用户必须开 USB 调试 |
| **C. 改用 BLE / Wi-Fi 配对** | 完全跨平台不碰 USB | 需要重写传输层（M2-M3 推倒） |
| **D. 写 Windows 服务 + 自定义 INF 包** | 用户体验最好 | 开发 + 签名成本数千美元 |

ADR-002 待补：是否在 Windows 平台默认走方案 B 兜底，AOAP 仅在 Linux/Mac 启用。

---

## 最近一次实测（参考）

| 日期 | 平台 | 手机 | 结果 |
|------|------|------|------|
| 2026-06-19 | Win11 + Chrome 130 | 小米 14 Pro (`2717:ff40`) | 装 WinUSB 前：libusb invalid state；装后：(待补) |
