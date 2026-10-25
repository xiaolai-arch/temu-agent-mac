# modules/ — 业务模块层（2026-10-24 模块化重组）

按业务功能分层，每个模块自带脚本 + `data/` 数据 + README。跨模块共享库在根级
`lib/common.mjs`，统一入口是根级 `run` 启动器（task = `modules/<module>/<task>.mjs`）。

| 模块 | 职责 | 现役脚本 |
|---|---|---|
| `sync/` | 同步：每日同步体检（登录态/账号/插件双按钮验证） | `sync-check.mjs` |
| `collect/` | 采集：店铺商品导出 + 页面快照；速卖通选品扫描（ali-scan/） | `export-goods.mjs` |
| `xuanpin/` | 选品：新品市场分析与筛选数据（脚本待建，数据已入库） | — |
| `grind/` | 调价：单 SKC 调价 + 批量调度（工单→执行→断点→复核） | `grind-one.mjs`、`grind-batch.py` |
| `delist/` | 下架：亏损 SKU 下架清单与日志（脚本待建，流程见 HANDOFF） | — |
| `ops/` | 运营分析：全店导出分析 → 调价/下架工单生成 | `analyze_stores.py`、`make_work_orders.py` |
| `store/` | 店铺管理：切店/登录态（多店账号切换） | `switch-store.mjs` |

## 用法

```bash
run sync-check main            # 同步体检（只读）
run export-goods main          # 采集：导出商品列表（只读）
run switch-store store-b       # 店铺管理：切店
run grind-one <SKC>            # 调价（改数据！需用户确认）
python3 modules/grind/grind-batch.py <工单.csv>   # 批量调价（改数据！需用户确认）
```

## 数据流向

```
collect（导出 xlsx）→ ops（分析→工单）→ grind（调价执行）/ delist（下架执行）
                                    ↑ xuanpin（新品选品）→ 上新模块（待建）
store（切店）为所有模块的前置；sync（体检）为每日例行
```

## 约定（沿自 ego/README.md，2026-10-24 模块化时平移）

- **成功信号**：下载/导出类 = download 事件或产物文件；弹窗"关闭"不可作为成功判据。
- **点击前清障**：佳同插件浮层会拦截指针——一律走 `clickButton`/`prepareClick`，
  不要裸 `page.click(text=)`（短文本会误中插件同名按钮）。
- **动作序列同轮完成**：popover 类弹窗点外部会自关，跨脚本轮次不保险。
- **报告**：任务结束必须 `writeReport`（temu-panel 靠 logs/last-status.json 展示）。
- **凭据**：只读根级 `local.config.json`（gitignored），绝不打印。
- TaskSpace 不 `finish()`：固定空间跨任务复用，页签只占用 p1。
- 交互知识实测笔记：`discoveries/2026-10-24-ego-browser-验证.md`（笔记内 `ego/`
  为历史路径，对应现在的 `modules/` + `lib/` + 根级 `run`）。
