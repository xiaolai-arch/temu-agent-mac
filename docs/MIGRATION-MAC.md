# 迁移指南：Windows → Mac

项目已在 2026-10-24 按模块整理（见根 README 目录地图）。本文说明哪些能直接带走、
哪些带不走、哪些要手动搬。

## 第一步：把所有东西纳入 git（Windows 上做）

大量调研报告、store-data 数据和新驱动脚本目前**未跟踪**（`git status` 里的 `??`）。
不 commit 的话 push/clone 都不会带过去。在 Windows 上：

```bash
git add -A                      # local.config.json / logs/ / screenshots/ 已被 .gitignore 挡住，不会被提交
git commit -m "模块化整理 + 全量入库（Mac 迁移准备）"
git push
```

## 第二步：Mac 上恢复

```bash
git clone <仓库地址> ~/temu-agent
python3 -m pip install pillow openpyxl requests   # 见下方依赖说明
```

## 直接可用（跨平台）

| 模块 | 说明 |
|---|---|
| `research/reports/` `research/linkfox/` | 报告与技能盘点直接带走。分析/工单脚本已迁至 `modules/ops/`（纯 openpyxl 可直接跑）；速卖通扫描脚本在 `modules/collect/ali-scan/`（跨平台可跑） |
| `plugin/temu-panel` | Node 服务，跨平台。启动前 `export TEMU_DIR=~/temu-agent`（不设则默认 Windows 路径）。注意它 spawn 的是 `claude` CLI + cmd.exe，Mac 上需小改 `server.mjs` 的 spawn 段 |
| `.claude/skills/` | 三个技能文档可读，但流程里引用的 driver 脚本在 Mac 上跑不了 |
| `docs/` `discoveries/` | 全部是 markdown 知识，直接带走 |
| LinkFox API 技能 | 技能本体在 `~/.zcode/skills/linkfox-*`（用户目录，**不在本仓库**），Mac 上重新安装/同步；API 本身与平台无关 |

## Windows 专属（Mac 上不可用）——✅ 已于 2026-10-24 清理删除

- **`driver/` 整个目录**（已删除，git 提交 a3ea58d 留有全部历史实现）：pywinauto、UIA、
  ctypes.windll、PowerShell OCR（Media.Ocr）、`start msedge`、`D:\Download` 轮询、
  `C:\Users\...\Desktop\cross` 插件目录——全部 Windows API，业务逻辑已平移至 `modules/`。
  同批清理：`bin/*.cmd`、`scripts/*.ps1`、`scripts/find_blue.py`、
  旧 `research/scan/scan_keywords.py|scan_stars.py`（依赖 driver）、
  `research/linkfox/linkfox_sandbox/`（技能市场可重装的沙盒副本，1345 文件；
  需要时 `git checkout a3ea58d -- research/linkfox/linkfox_sandbox` 取回）。
- `bin/*.cmd`：计划任务启动器（Windows 任务计划 TEMU-Agent-DailySyncCheck 也在 Mac 上不存在，需用 launchd/cron 重做）。
- `scripts/*.ps1`：PowerShell 对话框/截图辅助。
- `.mcp.json`：指向 `D:\temu-agent\driver\server.py`，Mac 上该 server 本身跑不起来，迁移后应删除或注释掉该 MCP 配置。
- `requirements.txt` 里的 `pywinauto`、`comtypes` 在 Mac 上装不上也用不到。

## 必须手动搬运（不在 git 里）

| 东西 | 位置 | 方式 |
|---|---|---|
| `local.config.json` | 项目根（gitignored） | 手动拷贝。含各店账号凭据 + 妙手凭据，**敏感，别走网盘明文** |
| `LINKFOXAGENT_API_KEY` | 环境变量 | Mac 上重新配置 |
| Temu 各店 access_token | LinkFox 技能体系内 | 按技能文档在 Mac 重新授权（应用名须为「酷鸟卖家助手」） |
| Edge 三插件 `cross\` | `C:\Users\34191\Desktop\cross` | Mac Edge 需重新解压加载；**注意插件 ID 由路径决定，ID 变了插件登录态/配置可能重置** |
| Windows 上的 Edge 登录态 | 浏览器 profile | 无法迁移，Mac 上各店重新登录（switch_store 流程会引导） |

## 如果要在 Mac 上继续浏览器自动化 —— ✅ 已定稿：ego-browser 方案（2026-10-24）

原设想的 AppleScript/pyobjc/Vision OCR 重写路线**已被取代**。实际采用
**ego-browser**（面向人类+Agent 双用的 Chromium）：复用登录态与已装 ERP 插件，
语义快照+选择器取代整个 OCR/像素坐标层。现役实现在 `modules/`（见 modules/README.md），
Phase 0 可行性验证见 `discoveries/2026-10-24-ego-browser-验证.md`。

对照表（历史参考）：

| 旧 Windows 层 | ego-browser 对应 |
|---|---|
| winutil/uia_shell（窗口/标签/地址栏） | TaskSpace + Page（固定名 temu-agent，p1=卖家后台） |
| shot.py + ocr.ps1（截图+OCR 行坐标） | `page.snapshot()`（@ref 语义快照）+ `page.screenshot()`（视觉兜底） |
| input.py（人类化鼠标键盘） | `page.click/fill/press`（clickButton 带清浮层） |
| 报告 report.py | `lib/common.mjs writeReport`（格式不变，temu-panel 兼容） |
| 风控要点 | 不用无头、复用日常浏览器登录态、人类化节奏保留 |

## 迁移后 Mac 日常

- 选品分析（modules/xuanpin/ + ops/）与 LinkFox API 写操作立即可用（红线不变：需用户确认）；
- 浏览器任务走 `run`：sync-check / export-goods / switch-store / grind-one；
- ego-browser 被用户使用时任务会硬停（双用浏览器设计）——批量任务运行期间别用浏览器。
