# temu-agent — TEMU 卖家自动化（Mac / ego-browser 版）

操控 **ego-browser**（面向人类+AI Agent 双用的 Chromium，复用登录态与已装插件）
完成 TEMU 卖家重复工作。写操作优先走 LinkFox Temu API，浏览器作兜底与采集。
取代两代旧方案：D:\temu-auto（CDP，被 TEMU 风控判异常）与 driver/（Windows
UIA/OCR 驱动日常 Edge，已随 Windows 机器归档）。

## 目录地图

```
temu-agent/
├── modules/       业务模块层（现役，跨平台）：每模块自带脚本 + data/ + README
│                  ├── sync/     同步体检（sync-check.mjs）
│                  ├── collect/  采集（export-goods.mjs + 速卖通扫描 ali-scan/）
│                  ├── xuanpin/  选品（市场分析数据）
│                  ├── grind/    调价（grind-one.mjs + grind-batch.py + 工单/建议价）
│                  ├── delist/   下架（工单与日志，脚本待建）
│                  ├── ops/      运营分析（analyze_stores.py + make_work_orders.py）
│                  └── store/    店铺管理（switch-store.mjs 切店）
├── lib/           跨模块共享库 common.mjs；run = 统一任务启动器
│                  —— 总览见 modules/README.md
├── research/      报告与知识：reports/（含任务交接 HANDOFF）、linkfox/（技能盘点）
├── plugin/temu-panel/  CloudCLI 工作台面板（Node，跨平台；TEMU_DIR 环境变量可覆盖）
├── .claude/skills/ 3 个 agent 技能：temu-sync-check / temu-store-switch / temu-expect-region
├── discoveries/   交互发现笔记（ego-browser 实测坑：2026-10-24-ego-browser-验证.md）
├── docs/          phase0 地基验证（历史档案）+ Mac 迁移指南
├── bin/           启动器（daily-sync-check.sh / workbench.sh）
├── local.config.json  凭据（gitignored，绝不提交）
└── CLAUDE.md      agent 驾驶手册（安全红线 + 页面知识 + 任务速查）
```

## 架构

```
CloudCLI 工作台（plugin/temu-panel，localhost:3790 或宿主内嵌）
  └─ 任务卡按钮 + 实时日志
        ↓ POST /api/agent → spawn claude CLI
Claude Code CLI（本地已配 API）  ← cwd = 本目录
  └─ ① 确定性任务：run <task>（modules/<module>/<task>.mjs）
     ② 探索性操作：ego-browser nodejs（TaskSpace "temu-agent"）
           ↓ 语义快照 + 选择器 + 下载事件（不再有 OCR/像素坐标层）
ego 浏览器（用户日常同款：登录态、ERP 插件原生保留）
```

## 环境要求

- ego-browser CLI（`ego-browser skill` 可打印用法即已装）
- Node（temu-panel）+ Python 3.10+：`pip install -r requirements.txt`
- 本地 Claude Code CLI（cc-switch 配置供应商）
- LinkFox API 技能（`~/.zcode/skills/linkfox-*`）+ `LINKFOXAGENT_API_KEY`

## 日常使用

在 Claude Code（或工作台）里：
- "跑同步体检" → `run sync-check <store>`（只读，出报告）
- "导出商品" → `run export-goods <store>`（只读）
- "切到店铺B" → `run switch-store store-b`
- 改数据操作（真实调价/上新/同步）需要你明确说出要求并确认，且运行期间别用 ego 浏览器

## 红线

默认只读；不用无头模式；验证码永远人工；凭据只存 local.config.json；报告如实。
