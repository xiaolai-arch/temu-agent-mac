# grind/ — 调价模块（改数据！）

单 SKC 调价 + 批量调度。**改数据任务：运行前需用户在对话中明确确认。**

## 脚本

| 文件 | 职责 |
|---|---|
| `grind-one.mjs` | 单 SKC 调价：商品ID查询 → 收集发起调价链接 → 弹窗渲染门控 + SKC-ID 匹配 → 逐行填值（每填即验）→ 确认调价 → 失败自救重试。类目自动识别成本（餐巾 0.16/腕带 0.33，识别不出=中止绝不猜）。退出码 0 成功 / 1 失败 / 2 未找到 / 3 零行可调 |
| `grind-batch.py` | 批量调度：读工单 CSV（倍数降序）→ 逐个调 run → done 断点 + 失败隔离（≥2 次跳过）→ 连续 8 败熔断 |

```bash
run grind-one <SKC> [--dry-run] [--cat 类目] [--ref 建议价]
python3 modules/grind/grind-batch.py <工单.csv> [--limit N]
```

## 三条铁律（不变）

① 勾选行必须填值（空勾选行提交会把原价格作废——禁止）
② 成功唯一信号 = 弹窗关闭（「确认调价」按钮消失）
③ 最终以导出复核为准（`run export-goods`；调价后等 2-3 分钟再导）

## data/

| 文件 | 内容 |
|---|---|
| `adjust-todo-*.csv` | 调价工单（ops 模块 make_work_orders.py 生成；SKC/SKU/现价/建议价/数量/倍数） |
| `adjust-done-*.txt` | 断点记录（skc/rc/说明/输出尾行；rc 0/3 算完成） |
| `adjust-run-*.log` | 批次运行日志 |
| `suggested-prices.csv` | 全量建议价表（定价模型：保本=(成本×数量+9)/0.8，建议30%=成本/0.5） |
| `store-b-price-order.json` / `price-orders-store-b.json` | 调价申报单记录（HJD 单号跟踪） |

⚠ 导出表的「数量/规格」列有滞后（多单实测偏差）——以弹窗 SKU属性集 的规格为准。
⚠ 平台价格只能下调；上调须走「发起调价→误操作降价-调涨」申报（见 HANDOFF）。
