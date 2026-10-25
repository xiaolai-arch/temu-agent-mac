# temu-agent — Agent 驾驶手册（Mac / ego-browser 版）

TEMU 卖家自动化。浏览器层 = **ego-browser**（面向人类+Agent 双用的 Chromium，
复用登录态与插件），经根目录 `run` 任务脚本驱动；写操作（发品/改价/库存/订单）优先
走 LinkFox Temu API 技能，浏览器作兜底与采集。旧 Windows 方案（driver/，日常
Edge + UIA/OCR）已于 2026-10-24 删除（git 提交 a3ea58d 留有全部历史实现）。

## 目录结构（2026-10-24 模块化重组）

- `modules/`：**业务模块层（现役）**——每模块自带脚本 + data/ + README，总览见 **modules/README.md**
  - `sync/` 同步体检 · `collect/` 采集（商品导出+速卖通扫描）· `xuanpin/` 选品 ·
    `grind/` 调价 · `delist/` 下架 · `ops/` 运营分析（工单生成）· `store/` 店铺管理（切店）
- `lib/common.mjs`：跨模块共享库（TaskSpace 引导、报告落盘、点击清障、弹窗关闭）
- `run`：统一任务启动器（task = `modules/<module>/<task>.mjs`）
- `research/`：报告与知识——reports/（含 **HANDOFF-调价下架任务交接.md**）、linkfox/
- `plugin/temu-panel/`：工作台面板（Node，跨平台）
- `.claude/skills/`：temu-sync-check / temu-store-switch / temu-expect-region
- `discoveries/`：交互发现笔记——**ego-browser 实测坑见 2026-10-24-ego-browser-验证.md**
  （笔记内 `ego/…` 为历史路径，对应现在的 `modules/…` + `lib/…` + 根级 `run`）
- `docs/`：phase0 地基验证（历史档案）+ Mac 迁移指南
- `local.config.json`：凭据（gitignored）

## 工作方式

确定性任务跑脚本（首选）：

```
run sync-check <store>     # 只读体检：登录态/账号/插件双按钮
run export-goods <store>   # 只读导出 → modules/collect/data/<store>-goods-<date>.xlsx
run switch-store <store>   # 切店（含登录；--check/--doctor/--verify-all）
run grind-one <SKC> [类目] [关键词]   # 单 SKC 调价（改数据！需用户明确确认）
python3 modules/grind/grind-batch.py <工单.csv> [--limit N]   # 批量调价（改数据！需用户明确确认）
```

探索性/临时浏览器操作：按 `ego-browser skill` 指南写 `ego-browser nodejs` 脚本
（TaskSpace 固定名 `temu-agent`，页面 p1=卖家后台）。约定：
- 选择器优先（snapshot @ref / text= / loc=css:）；截图+坐标只作 canvas 类兜底
- 短文本精确匹配危险（佳同/忆托面板注入同名按钮，如「导出」）——用 `lib/common.mjs`
  的 `clickButton`（清浮层+ref 点击），别裸 `page.click(text=)`
- 动作序列同一脚本轮内完成（popover 点外部会自关）
- **用户接管浏览器时硬停**（"Control … with the user"）——不重试不抢，等用户说继续

## 安全红线（不可违反）

1. **默认只读**：体检/导出只截图/报告/导出，不点改数据按钮。改数据动作（调价/上新/
   同步/下架）必须用户在对话中明确要求才执行，报告如实记录点击了什么。
2. **不用无头模式、不注入自动化启动参数**；操作节奏保留人类化延迟（脚本已内置）。
3. **验证码永远人工**：滑块/拼图/拖拽出现即停手报告，绝不自动求解（采集链路的
   滑块特例见 discoveries 采集笔记）。
4. 凭据只存 `local.config.json`（gitignored）；日志/报告绝不打印密码/Token，只允许
   脱敏手机号和键名。
5. 批量调价运行期间**不要使用 ego 浏览器**（用户接管会让任务硬停）。

## 核心页面知识（沿用，已验证）

- 定制商品页（主战场）：`https://agentseller.temu.com/main/customize-goods`，title「定制商品内容」
- 商品列表/导出：`https://agentseller.temu.com/goods/list`（下载查询结果 → 弹窗确认导出 →
  **成功信号 = download 事件，弹窗不关闭**）
- 调价入口：`https://agentseller.temu.com/newon/product-select`（商品ID查询 → 发起调价）
- 登录页：`https://seller.kuajingmaihuo.com/login`；未登录特征：URL 变 `agentseller.temu.com/auth/authentication?redirectUrl=...`
- 登录态判据：URL 含 `customize-goods` 且快照可见账号名 + 插件双按钮（按勾选同步/忆托ERP同步）
- 良性弹窗：「知道了」「我知道了」直接点掉；消息面板：Esc 或「一键已读所有消息」
- 登录三步：默认扫码 → 点「手机号登录」→（有时）点「密码登录」→ `#usernameId`/`#passwordId`
- 待办弹窗关闭 X = `MDL_iconWrapper` 类 div，悬在面板右上角**外侧**（Esc 关不掉）
- 佳同浮层（welcomePage iframe 等）会拦截点击 → `prepareClick`/`clickButton` 自动清障

## 坑速查

| 症状 | 处理 |
|---|---|
| "Control of this task space is with the user" | 用户在用浏览器——硬停等用户，勿抢 |
| `element is not visible in viewport` | 先 evaluate `scrollIntoView({block:'center'})` 再点（common.clickButton 已内置） |
| `<div> intercepts pointer events` | 插件浮层遮挡——clickButton 会自动隐藏 fixed 浮层并重试 |
| 下载没触发 | 弹窗确认按钮是否真点上了（导出+取消 同排兄弟模式）；生成大文件要等几分钟 |
| 登录态过期 | 跑 `run switch-store <store>` 恢复；或请用户人工登录 |
| 快照里找不到某文本 | `snapshot({scope:"full_page"})`；仍没有则滚动后再截 |

## 任务（skills / 模块）

- `temu-sync-check`：每日同步体检（只读，脚本驱动 → modules/sync/）
- `temu-store-switch`：切店（脚本驱动 → modules/store/，agent 解读结果）
- `temu-expect-region`：期望到货区域批量设为义乌（改数据；需 ego 化移植——坐标段失效，流程纪律有效）
- 调价：modules/grind/（grind-one.mjs + grind-batch.py，改数据，用户确认后跑，导出复核收尾）
- 下架：modules/delist/（工单已备，ego 化脚本待建；流程见 HANDOFF）
- 工单生成：python3 modules/ops/make_work_orders.py <store>（调价+下架一起出）
- 待发现：make-links / compliance / collect-links / new-listing（见 discoveries/）

## LinkFox API 技能（写操作优先走 API）

已装 26 技能（`~/.zcode/skills/linkfox-*`，Mac 上需重装/同步），完整方案见
`research/reports/2026-10-22-店群AI接管工作流设计.md`。要点：

- **写操作（发品/改价/库存/订单/发货）优先用 Temu 官方 API 技能**（`linkfox-temu-*`），
  浏览器点击只作 API 失败的兜底和采集用。
- 认证两样：环境变量 `LINKFOXAGENT_API_KEY` + Temu access_token（每店铺一个；
  授权应用名须为「酷鸟卖家助手」）。
- **算力计费**：数据/合规技能按调用扣费——失败或空结果禁止自动换词重试；批量前先
  小样试。响应落盘后读摘要，别整份进上下文。
- API 写操作仍守红线 1：需用户在对话中明确确认；查询类可直接跑。
