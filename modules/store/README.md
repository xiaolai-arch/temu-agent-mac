# store/ — 店铺管理模块（切店/登录态）

多店铺账号切换：seller 登录（手机号+密码）→ [授权门过门] → 卖家主页侧边栏
「商品管理→定制商品内容」（href 带店铺上下文）→ 内嵌授权卡 →「确认切换」弹窗 →
店名 + 双按钮验证 → 中文报告。全程自动，业务链路 2026-10-16 定稿。

## 用法

```bash
run switch-store <store-id>    # main / store-b / store-c / …（配置里的都行）
run switch-store --check       # 只看当前在哪店（不登录不动数据）
run switch-store --doctor      # 环境自检（凭据/ego 运行时/当前登录态）
run switch-store --verify-all  # 全店轮回实测（加新店后必跑）
```

退出码：0 成功 / 1 页面异常 / 2 验证码或账密错 / 3 验证失败（重跑一次通常恢复）。
skill：`.claude/skills/temu-store-switch/SKILL.md`（agent 解读结果与兜底）。

## 要点

- **文件锁** `modules/store/.switch-lock`（15 分钟过期）：同一时刻只允许一个切店进程
- 凭据只读根级 `local.config.json`（gitignored）——**加新店免改代码**：accounts 加一项
  → `--doctor` 全绿 → 首切 → `--verify-all`
- ⚠ SSO 授权目标 = ERP 当前登录账号（详见
  `discoveries/2026-10-24-ego-并行挂载与多店边界.md`）；ego-browser 被用户接管时任务
  硬停——不重试不抢，等用户说继续
- 连续 2 次失败 → 停手报告用户，勿反复重试（防触发风控）
- 店铺级其他操作：temu-expect-region skill（期望到货区域设义乌，ego 化移植待做）
