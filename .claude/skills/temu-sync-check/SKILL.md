---
name: temu-sync-check
description: TEMU 每日同步体检（只读）：脚本驱动 ego-browser 导航到定制商品页，验证登录态与「按勾选同步」「忆托ERP同步」两个插件按钮，截图取证并写中文报告。不点击任何改数据的按钮。用户要求"跑同步体检/每日体检/sync-check"时使用。
---

# temu-sync-check — 每日同步体检（只读，Mac/ego-browser 版）

## 执行

```bash
run sync-check <store-id>   # 默认 main；返回码 0=通过 1=异常 3=未登录
```

脚本（modules/sync/sync-check.mjs）自动完成：导航定制商品页 → 关良性弹窗 →
登录态判断（URL 含 customize-goods + 标题「定制商品内容」；跳 auth/authentication = 未登录）→
账号名识别（对照 local.config.json 各店名）→ 插件双按钮验证（语义快照搜文本）→
截图取证 → 写 logs/report-latest.md（temu-panel 兼容格式）。

## 结果解读

读 `logs/report-latest.md`（或 `logs/last-status.json`），向用户复述三行结论：
登录态 / 当前账号 / 插件按钮。**必须如实说明"未执行任何同步点击"。**

## 未登录 / 停在别店（rc=3）

- 首选：跑切店脚本恢复 `run switch-store <store-id>`（全程自动
  到同步页，含登录与身份切换）。
- 切店脚本不可用时：请用户在 ego 浏览器人工登录目标店，然后重跑本体检。
- **不要**手动点授权卡、也不要直航 `auth/authentication?redirectUrl=...`——
  那只刷新授权不切身份（2026-10-16 实测）。

## 红线

- 绝不点击「按勾选同步」「忆托ERP同步」——本任务只验证存在性
- 用户明确要求执行同步时，先复述将点击的按钮并获确认，另走同步执行流程
