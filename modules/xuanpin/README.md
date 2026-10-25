# xuanpin/ — 选品模块（新品市场分析）

定制品选品分析与筛选数据。现役为数据 + 结论报告；扫描/抓取脚本在
`../collect/ali-scan/`（速卖通探测），分析脚本待建（可参考 ops/analyze_stores.py 的
openpyxl 路数）。

## 现有数据（data/）

| 文件 | 内容 |
|---|---|
| `xuanpin-data-2026-10-24/` | 定制餐巾市场分析数据：keyword_profile.json（关键词画像）、cards.normalized.json / cards.metrics.json（卡片归一化+指标）、cards.metrics.md |
| `napkin-unit-under05.csv` | 餐巾单价 <0.5 筛选清单 |

## 结论报告

- `research/reports/2026-10-24-选品-定制餐巾-市场分析.md`
- `research/reports/2026-10-24-策略-出单提升与新品.md`

## 待建（见 discoveries/make-links.md）

make-links（1688 链接匹配）/ collect-links / new-listing（发品）——发品属写操作，
落地后需用户明确确认才执行。
