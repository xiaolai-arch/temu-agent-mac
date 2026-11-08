# collect/ — 采集模块（店铺数据导出 + 外部商品采集）

## TEMU 前台搜索采集（temu-search.mjs → SQLite 商品库）

从 TEMU 消费者站搜索结果页（`www.temu.com/search_result.html?search_key=...`）采集
**标题 / 主图原图 / goodsId**。列表卡片不显示类目，`category` 写入采集主题
（默认「定制餐巾」），真实搜索词存 `keyword`。

```bash
run temu-search "custom napkin" --max 120
run temu-search "personalized napkins" --max 120 --category 定制餐巾
```

- 翻页 = 点「查看更多」（真实鼠标点击，每次 +20 条）；不进商品详情页
- 主图去 `imageView2` 参数取原图（常见 800/1000px）；`data/images-consumer/`
- 产物：`data/temu-consumer-<date>.jsonl`，与机会商品数据一起由
  `import_catalog.py` 入 `data/temu-catalog.db`
- ⚠ 2026-11-08 实测：连续搜索约 10 次后 TEMU 跳 `login.html` 登录墙；
  需人工在 ego 浏览器登录 www.temu.com 后才能继续（两次采集共 75 条定制餐巾）
- 中文搜索也可用（`run temu-search "定制餐巾"`）；当前 ego 浏览器落地 Temu 英国站
  （简体中文界面），结果按英国站点返回

## 机会商品采集（temu-collect.mjs → SQLite 商品库）

从卖家中心「机会商品」页（/newon/invite-bids/list）按关键词采竞品：**标题 / 完整类目
路径 / 主图**。列表接口带 `Anti-Content` 签名头，脚本先驱动页面自身「查询」捕获签名，
再在同一浏览器会话里用 `page.fetch` 重放翻页（pageSize 100）。

```bash
run temu-collect 餐巾                      # 全量采集（默认每页100，自动翻页）
run temu-collect 定制 --filter "餐巾|鸡尾酒"  # 只保留标题命中正则的条目（省图片下载）
run temu-collect 餐巾 --pages 2 --size 50   # 限量调试
.venv/bin/python modules/collect/import_catalog.py   # 导入 SQLite
.venv/bin/python modules/collect/import_catalog.py --stats
```

- 产物：`data/temu-opportunity-<date>.jsonl`（一行一商品，按 source_id 去重）
- 主图：`data/images/<orderId>.<ext>`（签名 URL 10 分钟过期，取回后立即 curl 下载）
- 数据库：`data/temu-catalog.db`，表 `products`（source/source_id/category/title/img_url/img_file/
  keyword/is_custom），`collect_runs` 记批次；`is_custom` 由标题关键词（定制/刺绣/姓名/
  custom/personalized/monogram…）打标，供「定制餐巾」筛选
- 采集为只读：只设置搜索词/点「查询」/读接口/下图，不点「立即报名」等按钮

## 商品库预览与人工剔除（preview_server.py）

```bash
python3 modules/collect/preview_server.py        # 默认 http://127.0.0.1:8787/
python3 modules/collect/preview_server.py --port 8788
```

- 网格预览类目/标题/主图，支持搜索、类目/来源筛选、只看定制
- **剔除** = 软删除（`products.excluded=1`）：卡片悬停点「剔除」或详情弹窗点
  「剔除此商品」，立即从默认视图消失；底部 Toast 6 秒内可「撤销」
- 勾「显示已剔除」可查看/恢复（重新导入 JSONL 不会复活已剔除项，见
  `import_catalog.py` 的 upsert 不更新 excluded）
- 纯本地只读服务（写操作仅切换 excluded 标记），不改采集数据

## 店铺采集（export-goods.mjs）

商品列表导出（只读）：导航商品列表页 → 关弹窗 → 统计 → 「下载查询结果」→
弹窗「导出」→ `waitForEvent('download')` 直落 `data/`。成功信号 = download 事件
（弹窗不关闭）。

```bash
run export-goods <store-id>   # 产物: data/<store>-goods-<日期>.xlsx + <store>-page.md
```

- 导出复核是 grind/delist 的收尾步骤（调价/下架后等 2-3 分钟再导，否则拿到旧价）
- `data/`：各店商品导出 xlsx、商品列表页快照（*-page.md / *-page-ocr.md）、页面统计

## 速卖通扫描（ali-scan/）

跨平台探测脚本（requests 直拉，无浏览器依赖）：`probe*.py` + 结果
（scan_results.json / stars.json，10-22 扫描）。产出供 xuanpin 模块选品分析。

## 坑

- 短文本精确匹配危险（佳同/忆托面板注入同名「导出」按钮）——一律用
  `lib/common.mjs` 的 `clickButton`，别裸 `page.click(text=)`
- 生成大文件要等几分钟；「下载没触发」先核对弹窗确认按钮是否真点上了
