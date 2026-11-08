#!/usr/bin/env python3
"""从 erp-100.json 生成整夜批量上新的商品描述文件（推理字段模板 + 状态账本）。

用法:
  .venv/bin/python modules/listing/gen_batch_plan.py           # 生成/刷新 erp-batch-plan.json
  .venv/bin/python modules/listing/gen_batch_plan.py --reset   # 重置所有未完成商品为 pending
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "modules/listing/data/erp-100.json"
OUT = ROOT / "modules/listing/data/erp-batch-plan.json"

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

# 场合按主题选平台真实选项（前缀匹配）；无对应项用「通用」
OCCASION_OPTION = {
    "Graduation": ["毕业典礼", "生日"],
    "Baby Shower": ["婴儿送礼会", "性别揭示"],
    "Engagement": ["婚礼", "周年纪念日"],
    "Anniversary": ["周年纪念日"],
    "Bridal Shower": ["新娘送礼会", "婚礼"],
    "Wedding": ["婚礼", "周年纪念日"],
    "Birthday": ["生日"],
}


def norm_title(t: str) -> str:
    t = t.replace("搜1688同款", "").replace("1688同款", "")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def cn_units(s: str) -> int:
    return sum(2 if ord(c) > 127 else 1 for c in s)


def clamp_cn(s: str, limit: int = 240) -> str:
    """TEMU 商品名称上限 125 字（250 字符，中文按 2 计），留 10 字符余量。"""
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


def make_names(it):
    title = norm_title(it["title"])
    theme = "Party"
    for name, kws in THEMES:
        if any(k in title for k in kws):
            theme = name
            break
    cn = title
    if "定制" not in cn:
        cn += " 可定制姓名与文字"
    cn = clamp_cn(cn, 240)
    en = (f"Custom {theme} Paper Napkins, Personalized Name & Text Disposable Napkins, "
          f"3-Ply Thick Absorbent Napkins for {theme} Party Decorations, 15/25/52/75 Pcs")
    return cn, en[:250], theme


def main():
    reset = "--reset" in sys.argv
    items = json.loads(SRC.read_text())
    old = {}
    if OUT.exists():
        try:
            old = {x["idx"]: x for x in json.loads(OUT.read_text())}
        except Exception:
            old = {}
    plan = []
    for it in items:
        cat = it.get("cat", "")
        if "身份腕带" in cat or "运动腕带" in cat:
            continue
        if not any(k in cat + it.get("title", "") for k in ("餐巾", "纸巾", "餐纸")):
            continue
        cn, en, theme = make_names(it)
        rec = old.get(it["idx"], {})
        if reset and rec.get("status") != "done":
            rec = {}
        plan.append({
            "idx": it["idx"],
            "title": it["title"],
            "imgHi": it["imgHi"],
            "cat": cat,
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
            "status": rec.get("status", "pending"),
            "draftId": rec.get("draftId"),
            "spu": rec.get("spu"),
            "skc": rec.get("skc"),
            "skus": rec.get("skus"),
            "error": rec.get("error"),
            "updated": rec.get("updated"),
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    done = sum(1 for x in plan if x["status"] == "done")
    pending = [x["idx"] for x in plan if x["status"] != "done"]
    print(f"plan: {len(plan)} napkins, done={done}, pending={len(pending)}")
    print("next pending:", pending[:10])


if __name__ == "__main__":
    main()