# research/ — 报告与知识库

| 目录 | 内容 |
|---|---|
| `reports/` | 结论性报告（按日期命名）+ `HANDOFF-调价下架任务交接.md`（**当前进行中任务的交接文档，接手先读它**） |
| `linkfox/` | LinkFox 技能盘点（全量清单 json + 盘点报告）。技能本体在 `~/.zcode/skills/linkfox-*`（Mac 上待重装）；旧试跑沙盒副本已清理（git 历史 a3ea58d 可取回） |

> 2026-10-24 模块化重组：原 `store-data/`（商品导出/工单/建议价）与 `scan/`（速卖通
> 扫描）、`analyze_stores.py`、`make_work_orders.py` 已按业务归属迁入 `modules/`——
> 导出与页面快照 → `modules/collect/data/`；调价工单与建议价 → `modules/grind/data/`；
> 下架清单 → `modules/delist/data/`；分析产物与分析脚本 → `modules/ops/`；
> 选品数据 → `modules/xuanpin/data/`；扫描脚本 → `modules/collect/ali-scan/`。

选品结论示例：`reports/2026-10-24-选品-定制餐巾-市场分析.md`（数据在
`modules/xuanpin/data/xuanpin-data-2026-10-24/`）；店群接管全案：
`reports/2026-10-22-店群AI接管工作流设计.md`。
