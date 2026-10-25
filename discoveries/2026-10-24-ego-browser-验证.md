# ego-browser 环境验证（Phase 0，2026-10-24）

Mac 迁移后用 ego-browser 替换 Windows Edge + UIA/OCR 驱动层的可行性实测。
结论：**全部通过，方案成立**。约 30 分钟自动化导航/点击，未触发任何验证码/风控弹窗。

## 验证清单

| 项 | 结果 |
|---|---|
| `ego-browser nodejs` 运行时 + TaskSpace | ✅ spaceId=2（名 `temu-agent`，跨轮次复用 p1） |
| TEMU 卖家后台语义 DOM 可达 | ✅ anchor 带 href/ref、table_row/table_cell、checkbox、radio、switch 全暴露，无 canvas 墙、未发现 shadow DOM 阻挡 |
| 登录态识别 | ✅ 右上角账号名在快照直接可读：**当前登录 main 店（hpoiZee）** |
| 插件注入可见 | ✅ `button 按勾选同步`、`button 忆托ERP同步`（带 ref 可点）、佳同 `switch 弹框已恢复`、佳同侧栏（【佳同】保存当前查询条件等） |
| 下载事件 | ✅ 全流程跑通：导出 8162 SKC → `waitForEvent('download')` → `商品基础信息.xlsx` 3.6MB → openpyxl 读出 55,755 行 × 13 列，格式与 Windows 导出一致 |

main 店商品列表页快照读数：全部 8162（SKC），草稿箱 968。

## 关键交互知识（本次实测踩坑，ego/ 层直接引用）

1. **TEMU 弹窗关闭 X = `MDL_iconWrapper` 类的 div**（TEMU 弹窗组件 MDL_ 前缀），
   且 X 悬在**面板右上角外侧**（约 right+12, top-11），不在面板 DOM 子树内——
   「必须元素在弹窗容器内」的扫描永远找不到它。定位法：
   ① 容器内 `querySelectorAll` 找 `/MDL_iconWrapper/` 直接 click（实测有效）；
   ② 兜底：弹窗 rect 右上角外围 `elementFromPoint` 扫小元素。
   Esc 关不掉待办任务弹窗；class/aria 含 close 的搜索也找不到。
2. **导出弹窗是 popover 不是 modal**：点到外部会自动关。动作序列必须在一个脚本轮内完成
   （打开→确认→等下载），跨轮次 popover 可能已自关。
3. **导出成功信号 = download 事件**，弹窗点完确认后**不会关闭**（与 Windows 行为不同，
   旧脚本以「弹窗关闭=成功」的判据在 ego 下不成立）。确认按钮识别模式：
   `button[ref] / text "导出"` 紧跟 `button[ref] / text "取消"`（同排兄弟）。
4. **`text="导出"` 精确匹配不可靠**：一次点击"成功"返回却无效果（疑似命中隐藏同文本节点），
   一次被 `<div> intercepts pointer events` 拦截。可靠路径：新快照拿 ref → 点击前
   `elementFromPoint(按钮中心)` 诊断拦截链 → 若是 fixed 定位插件浮层（佳同
   welcomePage iframe，jiatongkuajing.com，动态注入）`style.display='none'` 隐藏 →
   再点。DOM `.click()` 兜底可用但本次未需要。
5. **视口外元素**：`click()` 自带滚屏对部分按钮失效（element not visible in viewport）；
   先 `evaluate(() => el.scrollIntoView({block:'center'}))` 再点。
   `snapshot({scope:'full_page'})` 能拿到折叠线下元素 ref。
6. 佳同面板注入的同名干扰按钮：`导出重复检测商品数据`/`导出商品列表数据`/`导出 ID`/
   `【忆托工具箱】导出商品列表`——与平台按钮「下载查询结果」不同名，按文本区分即可；
   `text="导出"` 这类短精确匹配反而危险（见 4）。
7. 消息面板自动弹出（快照见「一键已读所有消息」），不阻挡 DOM 操作，现阶段忽略。
8. 快照文本直接可读的信息（原 OCR 层职责）：账号名、tab 计数、按钮徽标数量、
   待办弹窗条目明细——**OCR 层整体不再需要**。
9. 「单品优惠券」等运营欢迎浮窗会动态出现/消失，处理顺序：先关它再操作目标弹窗。

## 对后续 Phase 的指导

- Phase 1（导出）：流程已全通，`export-goods.mjs` 打包本轮验证的序列即可；
  统计抽取从 OCR 正则改为快照文本正则（同款正则可平移）。
- Phase 2（切店）：登录表单/侧边栏链接/授权卡均为 DOM，预期比 Windows 版大幅缩短。
- Phase 3（调价）：customize-goods 页快照已见 radio（自定义/维持原价）与价格文本，
  逐行填写可走 DOM ref；虚拟滚动待实测。
- 风险确认：佳同浮层拦截是高频坑，ego/ 层需内置「点击前拦截诊断+隐藏浮层」公共件。
