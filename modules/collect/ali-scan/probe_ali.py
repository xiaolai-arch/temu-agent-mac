# -*- coding: utf-8 -*-
"""探测：requests 直拉速卖通搜索页，确认可提取 字段（标题/价格/销量）"""
import os, re, json, requests, sys
sys.stdout.reconfigure(encoding="utf-8")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}

url = "https://www.aliexpress.com/w/wholesale-custom-napkins.html?g=y&SearchText=custom+napkins"
r = requests.get(url, headers=H, timeout=25)
print("status", r.status_code, "bytes", len(r.text))
t = r.text
# 常见 SSR 数据锚点
for anchor in ["runParams", "salePrice", "tradeQuantity", "soldCount", "evaluationCount",
               "x_object_id", "formatedAmount", "item Moffat", "search-result", "smartSalePrice"]:
    print(f"{anchor!r:24} count={t.count(anchor)}")
m = re.search(r'"itemId":\s*(\d+)', t)
print("itemId sample:", m.group(1) if m else None)
# 存盘供后续分析
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe_custom_napkins.html"), "w", encoding="utf-8").write(t)
