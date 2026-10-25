"""四店铺商品导出文件解析 → 结构化统计 JSON（供盘点报告使用）。只读。"""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")                                            # 分析产物输出
GOODS_DATA = os.path.abspath(os.path.join(BASE, "..", "collect", "data"))    # 商品导出（采集模块）
STORES = ["main", "store-b", "store-c", "store-d"]
NAPKIN_KW = ("napkin", "serviette", "餐巾")


def parse(fp):
    wb = openpyxl.load_workbook(fp, read_only=True)
    ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    hdr = [str(h or "") for h in next(it)]
    idx = {h: i for i, h in enumerate(hdr)}
    rows = []
    for r in it:
        if r is None or idx["SKC ID"] >= len(r) or r[idx["SKC ID"]] is None:
            continue
        rows.append(r)
    wb.close()
    return hdr, idx, rows


def med(v):
    v = sorted(v)
    n = len(v)
    return round(v[n // 2], 1) if n else None


def analyze(store, fp):
    hdr, idx, rows = parse(fp)
    g = lambda r, k: r[idx[k]] if idx.get(k, -1) < len(r) else None
    skus = []
    skc = {}  # skc_id -> dict(title, cat, status, create, n_sku, price_min/max)
    for r in rows:
        skc_id = g(r, "SKC ID")
        price = g(r, "申报价格(CNY)")
        try:
            price = float(price) if price is not None else None
        except (TypeError, ValueError):
            price = None
        status = str(g(r, "商品状态") or "")
        cat = str(g(r, "叶子类目名称") or "")
        title = str(g(r, "商品标题") or "")
        created = str(g(r, "创建时间") or "")[:16]
        price_status = str(g(r, "申报价格状态") or "")
        skus.append({"skc": skc_id, "price": price, "status": status,
                     "pstat": price_status, "cat": cat, "created": created})
        d = skc.setdefault(skc_id, {"title": title, "cat": cat, "status": status,
                                    "created": created, "n_sku": 0,
                                    "prices": [], "pstat": Counter()})
        d["n_sku"] += 1
        if price is not None:
            d["prices"].append(price)
        d["pstat"][price_status] += 1

    out = {"store": store, "file": os.path.basename(fp),
           "rows": len(rows), "skc_total": len(skc),
           "status": {}, "categories_top": {}, "created_by_month": {},
           "napkin": {}, "price": {}, "price_status": Counter()}
    # 状态分布（SKC 维度）
    st = Counter(d["status"] for d in skc.values())
    out["status"] = dict(st)
    # 每状态下：SKC 数、SKU 数、价格
    per_status = defaultdict(lambda: {"skc": 0, "sku": 0, "prices": []})
    for d in skc.values():
        s = per_status[d["status"]]
        s["skc"] += 1
        s["sku"] += d["n_sku"]
        s["prices"].extend(d["prices"])
    out["per_status"] = {}
    for s, v in per_status.items():
        p = v["prices"]
        out["per_status"][s] = {
            "skc": v["skc"], "sku": v["sku"],
            "price_min": round(min(p), 1) if p else None,
            "price_med": med(p),
            "price_max": round(max(p), 1) if p else None,
        }
    # 类目 TOP（全部 + 在售中）
    for scope, filt in [("all", None), ("on_sale", "在售中")]:
        c = Counter(d["cat"] for d in skc.values()
                    if filt is None or d["status"] == filt)
        out["categories_top"][scope] = dict(c.most_common(12))
    # 创建时间月度直方（SKC）
    cm = Counter(d["created"][:7] for d in skc.values() if d["created"])
    out["created_by_month"] = dict(sorted(cm.items()))
    # 餐巾 vs 非餐巾（标题含 napkin/serviette/餐巾）
    for scope, filt in [("all", None), ("on_sale", "在售中")]:
        sub = [d for d in skc.values() if filt is None or d["status"] == filt]
        nap = [d for d in sub if any(k in d["title"].lower() for k in NAPKIN_KW)]
        out["napkin"][scope] = {"skc": len(sub), "napkin": len(nap),
                                "ratio": round(len(nap) / len(sub), 3) if sub else None}
    # 价格（全部 SKU）
    prices = [s["price"] for s in skus if s["price"] is not None]
    out["price"] = {"n": len(prices), "min": round(min(prices), 1) if prices else None,
                    "med": med(prices), "max": round(max(prices), 1) if prices else None}
    # 申报价格状态
    out["price_status"] = dict(Counter(s["pstat"] for s in skus))
    # 标题样本（在售前 5 个短标题）
    onsale_titles = [d["title"][:40] for d in skc.values() if d["status"] == "在售中"][:5]
    out["onsale_title_samples"] = onsale_titles
    return out, skc


def main():
    result = {}
    skcs = {}
    for sid in STORES:
        fp = os.path.join(GOODS_DATA, f"{sid}-goods-2026-10-22.xlsx")
        if not os.path.exists(fp):
            print(f"⚠ 缺文件: {fp}")
            continue
        out, skc = analyze(sid, fp)
        result[sid] = out
        skcs[sid] = skc
        print(f"{sid}: SKC={out['skc_total']} rows={out['rows']} 状态={out['status']}")
    # 跨店同款（标题归一化后重复）
    def norm(t):
        return re.sub(r"\s+", "", t).lower()[:60]
    title_stores = defaultdict(set)
    for sid, skc in skcs.items():
        for d in skc.values():
            if d["status"] == "在售中":
                title_stores[norm(d["title"])].add(sid)
    overlap = Counter(frozenset(v) for v in title_stores.values())
    result["_cross"] = {
        "onsale_unique_titles": len(title_stores),
        "titles_in_n_stores": {" + ".join(sorted(k)) if k else "?": v
                               for k, v in overlap.items()},
    }
    # 跨店同 SKC ID（同款铺多店）
    skc_stores = defaultdict(list)
    for sid, skc in skcs.items():
        for skc_id, d in skc.items():
            if d["status"] == "在售中":
                skc_stores[skc_id].append(sid)
    multi = {k: v for k, v in skc_stores.items() if len(v) > 1}
    result["_cross"]["onsale_same_skc_multi_store"] = len(multi)
    with open(os.path.join(DATA, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1, default=str)
    print("✓ summary.json written")
    # 控制台摘要
    for sid in STORES:
        if sid not in result:
            continue
        r = result[sid]
        print(f"\n=== {sid} ===")
        print(" 状态:", r["status"])
        print(" 在售价格:", r["per_status"].get("在售中"))
        print(" 餐巾占比(在售):", r["napkin"]["on_sale"])
        print(" 类目TOP5(在售):", dict(list(r["categories_top"]["on_sale"].items())[:5]))
        print(" 上架月份:", r["created_by_month"])
    print("\n跨店:", result["_cross"]["titles_in_n_stores"])
    print("跨店同SKC在售:", result["_cross"]["onsale_same_skc_multi_store"])


if __name__ == "__main__":
    main()
