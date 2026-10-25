# sync/ — 同步模块（每日同步体检）

只读验证「按勾选同步」「忆托ERP同步」双插件的同步链路健康度：
登录态（URL+标题）→ 右上角账号名（对照 local.config.json）→ 插件双按钮存在性 →
截图取证 → 中文报告（logs/report-latest.md，temu-panel 兼容）。

## 用法

```bash
run sync-check <store-id>   # 默认 main；退出码 0=通过 1=异常 3=未登录
```

- skill：`.claude/skills/temu-sync-check/SKILL.md`（agent 解读结果）
- 定时：`bin/daily-sync-check.sh`（launchd/cron 可挂）
- 未登录 → 走 store 模块切店 `run switch-store <store>` 恢复

## 红线

绝不点击「按勾选同步」「忆托ERP同步」——本模块只验证存在性。用户明确要求执行
同步时，先复述将点击的按钮并获确认（真实同步属写操作）。
