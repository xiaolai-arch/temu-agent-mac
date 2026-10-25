# collect/ — 采集模块（店铺数据导出 + 外部扫描）

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
