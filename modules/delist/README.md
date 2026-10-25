# delist/ — 下架模块（改数据！）

亏损 SKU 下架。**改数据任务：运行前需用户在对话中明确确认。** 现役为工单数据 +
已验证流程；ego 化脚本待建（Windows 版 driver/csx_delist.py 见 git 历史 a3ea58d）。

## 已验证流程（客服自助工具，flaky）

入口：右上角客服 → 联系官方客服 → 自助工具 → 商品下架 → 发商品 → 表单
（SKU/SKC ID + 下架原因「亏损下架」）→ 申请下架 → 确认 → **弹窗关闭=提交**。

- **当日限额约 2 笔，按钮灰色=额度用尽**；空提交会把原价格作废——禁止空提交
- 客服机器人「已下架」回复有假阳性，**每笔必须导出复核**（collect 模块 export-goods）

## data/

| 文件 | 内容 |
|---|---|
| `delist-todo-*.json` | 下架工单（ops 模块生成：亏损 SKU 按 SKC 分组） |
| `delist-store-b.txt` | store-b 下架 SKU 清单 |
| `delist-log.txt` | 下架执行日志 |

工单生成：`python3 modules/ops/make_work_orders.py <store>`（调价+下架一起出）。
