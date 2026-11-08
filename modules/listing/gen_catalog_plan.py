#!/usr/bin/env python3
"""从采集商品库（temu-catalog.db）生成批量上新计划。

用法:
  .venv/bin/python modules/listing/gen_catalog_plan.py              # 生成 catalog-batch-plan.json
  .venv/bin/python modules/listing/gen_catalog_plan.py --reset      # 未完成项重置为 pending
  .venv/bin/python modules/listing/gen_catalog_plan.py --limit 20   # 只取前 20 条（按 id 升序）

规则与 erp-batch-plan 一致（2026-11-08 用户确认）：
- 只取 excluded=0 的消费者站采集商品（定制餐巾）
- 标题清洗掉数量/尺寸片段（60pcs、40/80/120张、4.53英寸等），避免与 SKU 档位冲突
- 名称 CN ≤ 240 字符（TEMU 上限 250），EN 用主题模板
- 四档 SKU：15/25/52/75 pcs，价格与包装阶梯沿用上一批
- imgFile 指向采集库本地主图（batch-run 直接复制，不再下载）
"""
import argparse
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "modules" / "collect" / "data" / "temu-catalog.db"
OUT = ROOT / "modules" / "listing" / "data" / "catalog-batch-plan.json"

LADDER = [
    {"qty": 15, "declared": 39.9, "retail": 79.9, "len": 12, "wid": 12, "hei": 3, "weight": 75, "net": 40},
    {"qty": 25, "declared": 45, "retail": 89.9, "len": 12.5, "wid": 12.5, "hei": 4, "weight": 100, "net": 60},
    {"qty": 52, "declared": 60.9, "retail": 119.9, "len": 13, "wid": 13, "hei": 6, "weight": 170, "net": 125},
    {"qty": 75, "declared": 72.9, "retail": 149.9, "len": 13, "wid": 13, "hei": 8, "weight": 230, "net": 180},
]

THEMES = [
    ("Christmas", ["圣诞"]),
    ("Halloween", ["万圣"]),
    ("Thanksgiving", ["感恩节"]),
    ("Easter", ["复活节"]),
    ("Valentine's Day", ["情人节"]),
    ("St. Patrick's Day", ["圣帕特里克", "三叶草"]),
    ("Patriotic", ["独立日", "7月4", "美国国旗", "国庆"]),
    ("New Year", ["新年", "跨年"]),
    ("Graduation", ["毕业"]),
    ("Baby Shower", ["宝宝", "婴儿", "洗礼", "满月", "新生儿"]),
    ("Engagement", ["订婚", "求婚"]),
    ("Anniversary", ["周年"]),
    ("Bridal Shower", ["单身派对", "新娘"]),
    ("Wedding", ["婚礼", "结婚", "新郎"]),
    ("Birthday", ["生日"]),
    ("Cocktail", ["鸡尾酒", "调酒"]),
]

HOLIDAY_OPTION = {
    "Christmas": "圣诞节", "Halloween": "万圣节", "Thanksgiving": "感恩节",
    "Easter": "复活节", "Valentine's Day": "情人节", "St. Patrick's Day": "圣帕特里克节",
    "Patriotic": "独立日", "New Year": "新年", "Graduation": "毕业季",
}
OCCASION_OPTION = {
    "Graduation": ["毕业典礼", "生日"],
    "Baby Shower": ["婴儿送礼会", "性别揭示"],
    "Engagement": ["婚礼", "周年纪念日"],
    "Anniversary": ["周年纪念日"],
    "Bridal Shower": ["新娘送礼会", "婚礼"],
    "Wedding": ["婚礼", "周年纪念日"],
    "Birthday": ["生日"],
}

# 数量片段：60pcs / 40/80/120张 / 300 pcs / 50 pieces / 3 packs
QTY_RE = re.compile(
    r"(?:\d+\s*[/、\-]\s*)*\d+\s*(?:pcs|pc|pieces?|packs?|张|片|件|个|只|套)", re.I
)
# 尺寸片段：4.53x4.53 英寸 / 16.5cm / 6.5inch / 5×5 in
SIZE_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*(?:x|×|\*)\s*\d+(?:\.\d+)?\s*(?:cm|mm|inch|in|英寸|厘米)?)"
    r"|(?:\d+(?:\.\d+)?\s*(?:cm|mm|inch|in|英寸|厘米))",
    re.I,
)


def norm_title(t: str) -> str:
    t = t.replace("搜1688同款", "").replace("1688同款", "")
    t = QTY_RE.sub(" ", t)
    t = SIZE_RE.sub(" ", t)
    t = re.sub(r"[，,]\s*(?=[，,])", "", t)
    t = re.sub(r"\s+", " ", t).strip(" ，,、-")
    return t


def cn_units(s: str) -> int:
    return sum(2 if ord(c) > 127 else 1 for c in s)


def clamp_cn(s: str, limit: int = 240) -> str:
    if cn_units(s) <= limit:
        return s
    acc, cut = 0, s
    for i, c in enumerate(s):
        acc += 2 if ord(c) > 127 else 1
        if acc > limit:
            cut = s[:i]
            break
    for sep in ("，", ",", "、", " - ", "-", " "):
        j = cut.rfind(sep)
        if j >= int(len(cut) * 0.6):
            return cut[:j].rstrip("，,、 -")
    return cut.rstrip("，,、 -")


def make_names(title: str):
    theme = "Party"
    for name, kws in THEMES:
        if any(k in title for k in kws):
            theme = name
            break
    cn = title
    if "定制" not in cn and "定做" not in cn:
        cn += " 可定制姓名与文字"
    cn = clamp_cn(cn, 240)
    en = (f"Custom {theme} Paper Napkins, Personalized Name & Text Disposable Napkins, "
          f"3-Ply Thick Absorbent Napkins for {theme} Party Decorations, 15/25/52/75 Pcs")
    return cn, en[:250], theme


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT id, source_id, title, img_file, img_url
           FROM products
           WHERE excluded=0 AND source='temu-search'
           ORDER BY id"""
    ).fetchall()
    conn.close()
    if a.limit:
        rows = rows[: a.limit]

    old = {}
    if OUT.exists():
        try:
            old = {x["source_id"]: x for x in json.loads(OUT.read_text())}
        except Exception:
            old = {}

    plan = []
    for i, r in enumerate(rows, 1):
        rec_old = old.get(str(r["source_id"]), {})
        if a.reset and rec_old.get("status") != "done":
            rec_old = {}
        title = norm_title(r["title"] or "")
        cn, en, theme = make_names(title)
        plan.append({
            "idx": i,
            "source_id": str(r["source_id"]),
            "title": r["title"],
            "titleClean": title,
            "imgHi": r["img_url"],
            "imgFile": r["img_file"],
            "theme": theme,
            "names": {"cn": cn, "en": en},
            "attributes": {
                "occasions": OCCASION_OPTION.get(theme, ["通用"]),
                "holiday": HOLIDAY_OPTION.get(theme, "通用"),
                "material": "纸",
                "ply": "3层",
                "theme": "其他主题",
                "language": "英语",
                "foodContact": "纸",
            },
            "ladder": LADDER,
            "status": rec_old.get("status", "pending"),
            "draftId": rec_old.get("draftId"),
            "spu": rec_old.get("spu"),
            "skc": rec_old.get("skc"),
            "skus": rec_old.get("skus"),
            "error": rec_old.get("error"),
            "updated": rec_old.get("updated"),
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    done = sum(1 for x in plan if x["status"] == "done")
    pending = [x["idx"] for x in plan if x["status"] != "done"]
    print(f"plan: {len(plan)} napkins, done={done}, pending={len(pending)}")
    print("next pending:", pending[:10])
    print("sample CN:", plan[0]["names"]["cn"] if plan else "-")


if __name__ == "__main__":
    main()