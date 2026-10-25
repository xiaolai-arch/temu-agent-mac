---
name: temu-store-switch
description: TEMU 店铺切换（账号切换式多店铺）。核心是运行确定性脚本 modules/store/switch-store.mjs（根目录 run 启动器），agent 负责解读结果与兜底。用户要求"切店/切到某店/去店铺B"或某店体检前使用。
---

# temu-store-switch — 店铺切换（Mac/ego-browser 版）

## 首选：直接跑脚本

```
run switch-store <store-id>    # main / store-b / store-c / …（配置里的都行）
run switch-store --check       # 只看当前在哪店（不登录不动数据）
run switch-store --doctor      # 环境自检（凭据/ego 运行时/当前登录态）
run switch-store --verify-all  # 全店轮回实测（加新店后必跑）
```

脚本内含完整流程（业务链路自 driver/switch_store.py 平移，2026-10-16 定稿）：
登录（手机号登录→密码登录→fill #usernameId/#passwordId→同意并登录）
→ [授权门自动过门：商家中心卡片 → SSO 弹窗授权]
→ **侧边栏联动切身份（主链路）**：卖家主页 商品管理 → 定制商品内容（href 自带店铺
   上下文）→ 内嵌授权卡（勾协议→确认授权并前往）→「确认切换」弹窗
→ 店名 + 双按钮验证 → 中文报告（logs/report-latest.md）。
同一时刻只允许一个切店进程（文件锁 modules/store/.switch-lock，15 分钟过期）。

退出码：0 成功 / 1 页面异常 / 2 验证码或账密错 / 3 验证失败（重跑一次通常恢复）。

## ⚠ ego 特有：浏览器被用户接管

ego-browser 是双用浏览器——用户正在用它时任务会硬停（"Control of this task
space is with the user"）。此时**不重试、不强行接管**，告知用户空闲后再跑。

## 加新店铺（免改代码）

1. `local.config.json` → `accounts` 加 `"store-e": {"phone": "...", "password": "..."}`（name 留空自动学）
2. `run switch-store --doctor` 全绿 → 3. 首切 `store-e` → 4. `--verify-all` 全店矩阵全 ✅
（工作台店铺卡从配置动态生成；详见 discoveries/store-switch.md「新店接入 SOP」）

## 结果处理

- **exit 0**：完成，直接引用报告（logs/report-latest.md）
- **exit 2**：滑块验证码或密码错 → 告知用户（验证码绝不由 agent 处理；密码核对 local.config.json）
- **exit 3**：验证失败 → 先看截图（screenshots/switch-*.png）核对页面状态，**重跑一次**通常恢复
- **exit 1**：看脚本最后截图诊断，重跑一次
- 连续 2 次失败 → 停手报告用户，勿反复重试（防触发风控）

## 原理速查（业务链路不变；Windows/UIA/OCR 细节已随 driver/ 删除，git 历史可查）

- seller 与 Agent Center 会话独立；**切店 = 侧边栏入口**（定制商品内容 href 自带店铺上下文）
- **授权门 redirectUrl 直航/弹窗授权只刷新授权、绝不切身份**——确认后仍是旧店且永不弹
  「确认切换」（2026-10-16 反复实测）；门页可自动过（登录落地卡门时用）
- 「确认切换」后整页重载慢，侧边栏「定制商品内容」最多点 3 次防打断导航
- 未知店读到别家店名必须走联动（防跑错店）；首登成功自动学习店名回写配置
- 弹窗关闭 X 是 `MDL_iconWrapper` 类、悬在面板右上角**外侧**（见
  discoveries/2026-10-24-ego-browser-验证.md）
- 全程不点「按勾选同步」「忆托ERP同步」，不碰任何验证码
