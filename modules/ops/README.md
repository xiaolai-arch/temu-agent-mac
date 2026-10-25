# ops/ — 运营分析模块（导出分析 → 工单生成）

连接采集与执行的桥梁：读 collect 模块的商品导出 xlsx，产出各店结构化统计与
grind（调价）/ delist（下架）工单。纯 openpyxl，跨平台直接跑，只读不碰浏览器。

## 脚本

| 文件 | 职责 |
|---|---|
| `analyze_stores.py` | 四店导出解析 → `data/summary.json`（状态/价格分布/餐巾占比/类目TOP5/上架月份/跨店同款） |
| `make_work_orders.py` | 工单生成：现价>建议价 → `../grind/data/adjust-todo-<store>.csv`（倍数降序）；现价<保本价 → `../delist/data/delist-todo-<store>.json`（按 SKC 分组） |

```bash
python3 modules/ops/analyze_stores.py
python3 modules/ops/make_work_orders.py <store> [导出xlsx路径] [--dry] [--force]
```

## 定价模型（用户确认，详见 HANDOFF）

- 成本 = 单件成本 × 数量 + 9（运费+打包+设计/单）；广告抽申报价 20%
- 保本价 = 成本 ÷ 0.8；建议价（30% 净利率）= 成本 ÷ 0.5（向上取整到 0.5 元）
- 单件成本：餐巾类 0.16/张；身份腕带 0.33/条；其余类目成本未知 → 不生成（计 skipped）

## data/

`summary.json`（全店分析）、`work-orders.json`（工单汇总）、
`store-b-today.json`（当日亏损盘点）、`low-price-skus.csv` / `inverted-price-skus.csv`
（低价/倒挂清单）。

⚠ 导出有滞后：执行前弹窗内现价/规格为准（grind 流程天然兼容）。
