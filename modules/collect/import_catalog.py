#!/usr/bin/env python3
"""把采集 JSONL 导入 SQLite 商品库 modules/collect/data/temu-catalog.db。

用法:
  .venv/bin/python modules/collect/import_catalog.py                # 导入 data/temu-opportunity-*.jsonl
  .venv/bin/python modules/collect/import_catalog.py <a.jsonl> ...  # 导入指定文件
  .venv/bin/python modules/collect/import_catalog.py --stats        # 只看库统计

库结构:
  products(source, source_id, category, title, img_url, img_file, keyword,
           is_custom, created_at, updated_at)  唯一键 (source, source_id)
  collect_runs  每批导入的审计记录

is_custom 由标题关键词判定（定制/刺绣/姓名/印字/custom/personalized/monogram…），
只作为筛选标签，不修改原始标题。
"""
import argparse
import glob
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "modules" / "collect" / "data"
DB = DATA / "temu-catalog.db"

CUSTOM_RE = re.compile(
    r"定制|定做|自定义|专属|个性|姓名|名字|印字|印制|照片|来图|"
    r"custom|personali[sz]|monogram|add your|your name|your text|\bdiy\b",
    re.I,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  img_url TEXT,
  img_file TEXT,
  keyword TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_custom ON products(is_custom);
CREATE TABLE IF NOT EXISTS collect_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  keyword TEXT,
  file TEXT,
  total INTEGER,
  inserted INTEGER,
  updated INTEGER,
  images INTEGER,
  imported_at TEXT
);
"""


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure(conn):
    conn.executescript(SCHEMA)
    conn.commit()


def import_file(conn, path: Path):
    inserted = updated = images = total = 0
    keyword = None
    source = None
    stamp = now()
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            total += 1
            keyword = keyword or r.get("keyword")
            source = source or r.get("source", "opportunity")
            img_file = r.get("img_file")
            if img_file and (ROOT / img_file).exists():
                images += 1
            cur = conn.execute(
                "SELECT id FROM products WHERE source=? AND source_id=?",
                (r.get("source", "opportunity"), str(r.get("source_id"))),
            )
            exists = cur.fetchone() is not None
            conn.execute(
                """INSERT INTO products
                   (source, source_id, category, title, img_url, img_file, keyword, is_custom, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(source, source_id) DO UPDATE SET
                     category=excluded.category, title=excluded.title, img_url=excluded.img_url,
                     img_file=COALESCE(excluded.img_file, products.img_file),
                     keyword=excluded.keyword, is_custom=excluded.is_custom, updated_at=excluded.updated_at""",
                (
                    r.get("source", "opportunity"),
                    str(r.get("source_id")),
                    r.get("category"),
                    r.get("title") or "",
                    r.get("img_url"),
                    img_file,
                    r.get("keyword"),
                    1 if CUSTOM_RE.search(r.get("title") or "") else 0,
                    r.get("collected_at") or stamp,
                    stamp,
                ),
            )
            if exists:
                updated += 1
            else:
                inserted += 1
    conn.execute(
        "INSERT INTO collect_runs (source, keyword, file, total, inserted, updated, images, imported_at) VALUES (?,?,?,?,?,?,?,?)",
        (source or "opportunity", keyword, str(path.relative_to(ROOT)), total, inserted, updated, images, stamp),
    )
    conn.commit()
    return total, inserted, updated, images


def stats(conn):
    total = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    custom = conn.execute("SELECT COUNT(*) FROM products WHERE is_custom=1").fetchone()[0]
    with_img = conn.execute("SELECT COUNT(*) FROM products WHERE img_file IS NOT NULL AND img_file<>''").fetchone()[0]
    print(f"总计 {total} 条 | 定制关键词命中 {custom} 条 | 有主图 {with_img} 条")
    for src, n, c, i in conn.execute(
        """SELECT source, COUNT(*), SUM(is_custom),
                  SUM(CASE WHEN img_file IS NOT NULL AND img_file<>'' THEN 1 ELSE 0 END)
           FROM products GROUP BY source ORDER BY COUNT(*) DESC"""
    ):
        print(f"  [{src}] {n} 条（定制 {c or 0}，有图 {i or 0}）")
    print("\n按类目（叶子）统计:")
    for cat, n, c in conn.execute(
        """SELECT category, COUNT(*), SUM(is_custom) FROM products
           GROUP BY category ORDER BY COUNT(*) DESC LIMIT 20"""
    ):
        leaf = (cat or "").split(" > ")[-1]
        print(f"  {n:4d}  (定制 {c or 0:3d})  {leaf}  ←  {cat}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--db", default=str(DB))
    ap.add_argument("--stats", action="store_true")
    a = ap.parse_args()

    conn = sqlite3.connect(a.db)
    ensure(conn)

    if a.stats:
        stats(conn)
        return

    files = a.files or sorted(
        glob.glob(str(DATA / "temu-opportunity-*.jsonl")) + glob.glob(str(DATA / "temu-consumer-*.jsonl"))
    )
    if not files:
        print("没有可导入的 JSONL")
        return

    for f in files:
        p = Path(f).resolve()
        total, ins, upd, images = import_file(conn, p)
        print(f"{p.name}: {total} 条, 新增 {ins}, 更新 {upd}, 有图 {images}")

    print()
    stats(conn)


if __name__ == "__main__":
    main()