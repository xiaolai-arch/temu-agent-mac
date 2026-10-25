# Phase 0 地基验证结论（2026-10-12）

## 通过项

| 项 | 结论 |
|---|---|
| 日常 Edge 登录态 | ✅ 完好（账号 boliooZ，卖家中心定制商品页正常），**零重新登录** |
| UIA 壳层 | ✅ 窗口枚举/标题/标签页/地址栏（"地址和搜索栏" Edit）全部可读可写 |
| 地址栏导航 | ✅ Ctrl+L → 输入 → 回车，成功跳转 customize-goods |
| DPI-aware 截图 | ✅ 2582×1550 物理像素（150% 缩放下无虚拟化） |
| OCR | ✅ Windows.Media.Ocr（zh-CN）可用；注意 PS1 必须 UTF-8 BOM、`Add-Type System.Runtime.WindowsRuntime`、Measure-Object 不支持脚本块 |
| 普通参数拉起 Edge | ✅ `start msedge <url>` 无任何自动化 flag |

## 关键发现（改变认知）

1. **用户日常 Edge（Default profile）无任何扩展、开发人员模式=关**。
   旧项目的 3 个 ERP 插件（cross\ 目录）从来只是 `--load-extension` 每次注入，从未常驻。
   → 新方案需要**一次性安装**：开开发人员模式 + 加载解压缩扩展 ×3（此操作本身可作为 computer-use 首个实战）。
   → 红线延续：装好后绝不关开发人员模式、绝不动 cross\ 目录。
2. 截图可见两个官方按钮（批量导出定制内容/批量下载图片压缩包），页面无「按勾选同步」「忆托ERP同步」——与"无扩展"一致。
3. 网页内容默认不在 UIA 树（Agent C 已三路验证）；内容层走 视觉(MiMo)+OCR，`--force-renderer-accessibility`/edge://accessibility 留作后续增强通道。

## 坑速查（新项目）

| 坑 | 处理 |
|---|---|
| PS1 中文乱码 | .ps1 必须存 UTF-8 **带 BOM** |
| WinRT 类型找不到 | `Add-Type -AssemblyName System.Runtime.WindowsRuntime` + 每个命名空间显式加载 |
| Measure-Object -Property 不支持脚本块 | 先 ForEach-Object 展开数组再统计 |
| Git Bash /tmp 与 Windows Python 路径错位 | 一律用 Windows 绝对路径 |
| pip 默认源极慢/清华 403 | 用阿里云镜像 `-i https://mirrors.aliyun.com/pypi/simple/` |
| pywinauto STA 警告 | 无害 |
