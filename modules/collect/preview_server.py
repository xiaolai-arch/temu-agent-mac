#!/usr/bin/env python3
"""商品库本地预览服务（127.0.0.1；列表只读，支持手动剔除/恢复）。

用法:
  .venv/bin/python modules/collect/preview_server.py [--port 8787]

页面：http://127.0.0.1:8787/
数据：modules/collect/data/temu-catalog.db
剔除：软删除（products.excluded=1），可撤销；重新导入采集数据不会复活剔除项
图片：/img/<products.id>  → 按库内 img_file 落盘路径读取
"""
import argparse
import json
import mimetypes
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "modules" / "collect" / "data" / "temu-catalog.db"
IMG_ROOT = (ROOT / "modules" / "collect" / "data").resolve()

HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TEMU 商品库预览</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --ink:#1f2329; --muted:#6b7280; --line:#e5e7eb;
    --brand:#f97316; --brand-soft:#fff1e6; --ok:#059669; --ok-soft:#ecfdf5;
    --shadow:0 1px 2px rgba(16,24,40,.05), 0 8px 24px rgba(16,24,40,.06);
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  a{color:inherit}
  header{position:sticky;top:0;z-index:20;background:rgba(246,247,249,.9);backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line)}
  .wrap{max-width:1440px;margin:0 auto;padding:0 24px}
  .top{display:flex;align-items:center;gap:14px;padding:16px 0 10px}
  .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#fb923c,#f97316);
    color:#fff;display:grid;place-items:center;font-weight:800;font-size:15px}
  h1{font-size:18px;margin:0;font-weight:700}
  .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .stats{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
  .chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 12px;
    font-size:12px;color:var(--muted);box-shadow:var(--shadow)}
  .chip b{color:var(--ink)}
  .filters{display:flex;gap:10px;align-items:center;padding:10px 0 16px;flex-wrap:wrap}
  .search{flex:1;min-width:240px;position:relative}
  .search input{width:100%;height:40px;border:1px solid var(--line);border-radius:12px;padding:0 14px 0 38px;
    font-size:14px;background:var(--panel);outline:none;box-shadow:var(--shadow)}
  .search input:focus{border-color:#fdba74;box-shadow:0 0 0 3px #ffedd5}
  .search svg{position:absolute;left:12px;top:11px;width:18px;height:18px;color:var(--muted)}
  select{height:40px;border:1px solid var(--line);border-radius:12px;background:var(--panel);
    padding:0 34px 0 12px;font-size:13px;color:var(--ink);box-shadow:var(--shadow);appearance:none;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 12px center;max-width:320px}
  .toggle{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;background:var(--panel);
    border:1px solid var(--line);border-radius:12px;font-size:13px;cursor:pointer;box-shadow:var(--shadow);
    user-select:none;white-space:nowrap}
  .toggle input{accent-color:var(--brand);width:16px;height:16px}
  .toggle.on{border-color:#fdba74;background:var(--brand-soft)}
  main{padding:20px 0 40px}
  .meta{color:var(--muted);font-size:13px;margin:2px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;
    box-shadow:var(--shadow);cursor:zoom-in;transition:transform .15s ease, box-shadow .15s ease;
    display:flex;flex-direction:column;position:relative}
  .card:hover{transform:translateY(-2px);box-shadow:0 4px 8px rgba(16,24,40,.06),0 16px 36px rgba(16,24,40,.10)}
  .card.excluded{opacity:.55;filter:grayscale(.4)}
  .card .del{position:absolute;top:8px;right:8px;z-index:2;height:28px;padding:0 10px;border-radius:999px;
    border:1px solid var(--line);background:rgba(255,255,255,.94);color:#b91c1c;font-size:12px;cursor:pointer;
    box-shadow:var(--shadow);opacity:0;transform:translateY(-2px);transition:opacity .15s ease, transform .15s ease}
  .card:hover .del{opacity:1;transform:none}
  .card .del.restore{color:#047857}
  .card .del:hover{background:#fff}
  .badge.removed{color:#6b7280;background:#f3f4f6;border-color:#d1d5db}
  .thumb{aspect-ratio:1/1;background:#f3f4f6;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;min-height:104px}
  .badges{display:flex;gap:6px;flex-wrap:wrap}
  .badge{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
  .badge.custom{color:#c2410c;background:var(--brand-soft);border-color:#fed7aa}
  .badge.src{color:#4b5563;background:#f3f4f6;border-color:#e5e7eb}
  .badge.leaf{color:#047857;background:var(--ok-soft);border-color:#a7f3d0}
  .title{font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
    overflow:hidden;color:var(--ink)}
  .cat{font-size:11px;color:var(--muted);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;
    -webkit-box-orient:vertical;overflow:hidden;margin-top:auto}
  .empty{padding:80px 0;text-align:center;color:var(--muted)}
  .pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:26px 0 0;flex-wrap:wrap}
  .pager button{height:34px;min-width:34px;padding:0 10px;border-radius:10px;border:1px solid var(--line);
    background:var(--panel);color:var(--ink);font-size:13px;cursor:pointer;box-shadow:var(--shadow)}
  .pager button:disabled{opacity:.45;cursor:not-allowed}
  .pager button.on{background:var(--brand);border-color:var(--brand);color:#fff}
  .pager .info{font-size:13px;color:var(--muted);margin:0 8px}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);z-index:60;
    background:#111827;color:#fff;border-radius:12px;padding:10px 14px;font-size:13px;display:flex;
    align-items:center;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;pointer-events:none;
    transition:opacity .18s ease, transform .18s ease;max-width:min(720px,92vw)}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
  .toast button{border:none;background:transparent;color:#fdba74;font-size:13px;font-weight:600;cursor:pointer;padding:2px 4px}
  .modal .act{margin-top:6px;display:flex;gap:10px}
  .modal .act button{height:38px;padding:0 16px;border-radius:10px;font-size:13px;cursor:pointer;border:1px solid var(--line);background:var(--panel)}
  .modal .act button.danger{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
  .modal .act button.safe{color:#047857;border-color:#a7f3d0;background:var(--ok-soft)}
  dialog{border:none;border-radius:18px;padding:0;max-width:min(1040px,92vw);width:100%;
    box-shadow:0 24px 80px rgba(16,24,40,.30);background:var(--panel)}
  dialog::backdrop{background:rgba(15,23,42,.55);backdrop-filter:blur(3px)}
  .modal{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0}
  .modal .pic{background:#f3f4f6;display:grid;place-items:center;min-height:360px}
  .modal .pic img{width:100%;height:100%;max-height:78vh;object-fit:contain;display:block}
  .modal .info{padding:22px 24px;display:flex;flex-direction:column;gap:12px;max-height:78vh;overflow:auto}
  .modal h2{font-size:18px;line-height:1.5;margin:0}
  .kv{font-size:13px;color:var(--muted);line-height:1.5}
  .kv b{color:var(--ink);font-weight:600}
  .close{position:absolute;top:10px;right:12px;width:34px;height:34px;border-radius:999px;border:none;
    background:rgba(255,255,255,.9);cursor:pointer;font-size:18px;box-shadow:var(--shadow)}
  .modalwrap{position:relative}
  @media (max-width:760px){
    .modal{grid-template-columns:1fr}
    .modal .info{max-height:none}
    .stats{display:none}
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="top">
      <div class="logo">T</div>
      <div>
        <h1>TEMU 商品库预览</h1>
        <div class="sub">类目 · 标题 · 主图（采集自 TEMU 官网，只读）</div>
      </div>
      <div class="stats" id="stats"></div>
    </div>
    <div class="filters">
      <label class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" placeholder="搜索标题 / 关键词，例如：定制、姓名、圣诞…" autocomplete="off">
      </label>
      <select id="category"><option value="">全部类目</option></select>
      <select id="source">
        <option value="">全部来源</option>
        <option value="temu-search">TEMU 消费者站（定制餐巾）</option>
        <option value="opportunity">卖家中心·机会商品</option>
      </select>
      <label class="toggle" id="customToggle"><input type="checkbox" id="custom"> 只看定制</label>
      <label class="toggle" id="showExcludedToggle"><input type="checkbox" id="showExcluded"> 显示已剔除</label>
    </div>
  </div>
</header>
<main class="wrap">
  <div class="meta" id="meta"></div>
  <div class="grid" id="grid"></div>
  <div class="pager" id="pager"></div>
</main>
<div class="toast" id="toast"><span id="toastMsg"></span><button id="undoBtn">撤销</button></div>
<dialog id="dlg">
  <div class="modalwrap">
    <button class="close" id="closeBtn" aria-label="关闭">×</button>
    <div class="modal">
      <div class="pic"><img id="mImg" alt=""></div>
      <div class="info">
        <h2 id="mTitle"></h2>
        <div class="kv" id="mMeta"></div>
        <div class="act">
          <button class="btn-del" id="mAct"></button>
        </div>
      </div>
    </div>
  </div>
</dialog>
<script>
const $ = (s) => document.querySelector(s);
const state = { q: "", category: "", source: "", custom: false, showExcluded: false, page: 1, size: 36, total: 0 };
let metaData = null;
let lastAction = null; // {id, title, excluded} 用于撤销

function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function leaf(cat){ return (cat || "").split(" > ").slice(-1)[0] || "未分类"; }

async function loadMeta(){
  const r = await fetch("/api/meta"); metaData = await r.json();
  $("#stats").innerHTML =
    `<span class="chip">商品 <b>${metaData.total}</b></span>` +
    `<span class="chip">定制 <b>${metaData.custom}</b></span>` +
    `<span class="chip">有主图 <b>${metaData.with_img}</b></span>` +
    (metaData.excluded ? `<span class="chip">已剔除 <b>${metaData.excluded}</b></span>` : "");
  const sel = $("#category");
  sel.innerHTML = `<option value="">全部类目（${metaData.total}）</option>` +
    metaData.categories.map(c => `<option value="${esc(c.category)}">${esc(c.leaf)}（${c.count}）</option>`).join("");
  if (state.category) sel.value = state.category;
}

async function load(){
  const p = new URLSearchParams({
    q: state.q, category: state.category, source: state.source,
    custom: state.custom ? "1" : "", show_excluded: state.showExcluded ? "1" : "",
    page: state.page, size: state.size,
  });
  const r = await fetch("/api/products?" + p);
  const data = await r.json();
  state.total = data.total;
  const grid = $("#grid");
  if (!data.items.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">没有匹配的商品</div>`;
  } else {
    grid.innerHTML = data.items.map(it => `
      <div class="card ${it.excluded ? "excluded" : ""}" data-id="${it.id}">
        <button class="del ${it.excluded ? "restore" : ""}" data-id="${it.id}" data-excluded="${it.excluded ? "1" : ""}">
          ${it.excluded ? "恢复" : "剔除"}</button>
        <div class="thumb">${it.img ? `<img loading="lazy" src="/img/${it.id}" alt="">` : `<div class="empty" style="padding:40px 0">无图</div>`}</div>
        <div class="body">
          <div class="badges">
            ${it.is_custom ? `<span class="badge custom">定制</span>` : ""}
            <span class="badge src">${it.source === "temu-search" ? "消费者站" : "机会商品"}</span>
            <span class="badge leaf">${esc(leaf(it.category))}</span>
            ${it.excluded ? `<span class="badge removed">已剔除</span>` : ""}
          </div>
          <div class="title">${esc(it.title)}</div>
          <div class="cat" title="${esc(it.category)}">${esc(it.category || "")}</div>
        </div>
      </div>`).join("");
  }
  const pages = Math.max(1, Math.ceil(state.total / state.size));
  if (state.page > pages) { state.page = pages; return load(); }
  $("#meta").textContent = `共 ${state.total} 条${metaData?.excluded ? `（已剔除 ${metaData.excluded}）` : ""} · 第 ${state.page} / ${pages} 页`;
  renderPager(pages);
  grid.querySelectorAll(".card").forEach(c => c.addEventListener("click", () => openModal(+c.dataset.id)));
  grid.querySelectorAll(".del").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    exclude(+b.dataset.id, !b.dataset.excluded);
  }));
}

let toastTimer = null;
function showToast(msg, onUndo){
  const t = $("#toast");
  $("#toastMsg").textContent = msg;
  $("#undoBtn").style.display = onUndo ? "" : "none";
  $("#undoBtn").onclick = onUndo || null;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), onUndo ? 6000 : 2600);
}

async function exclude(id, excluded){
  const r = await fetch("/api/exclude", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, excluded }),
  });
  const j = await r.json();
  if (!j.ok) { showToast("操作失败：" + (j.error || r.status)); return; }
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const title = card?.querySelector(".title")?.textContent || `#${id}`;
  lastAction = { id, excluded, title };
  showToast(
    (excluded ? "已剔除：" : "已恢复：") + (title.length > 36 ? title.slice(0, 36) + "…" : title),
    () => exclude(id, !excluded),
  );
  await loadMeta();
  await load();
}

function renderPager(pages){
  const el = $("#pager"); el.innerHTML = "";
  const add = (label, page, disabled, on) => {
    const b = document.createElement("button");
    b.textContent = label; b.disabled = !!disabled;
    if (on) b.classList.add("on");
    b.onclick = () => { state.page = page; load(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    el.appendChild(b);
  };
  add("‹", Math.max(1, state.page - 1), state.page <= 1);
  const nums = new Set([1, pages, state.page - 2, state.page - 1, state.page, state.page + 1, state.page + 2]);
  let last = 0;
  [...nums].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b).forEach(n => {
    if (n - last > 1) { const s = document.createElement("span"); s.className = "info"; s.textContent = "…"; el.appendChild(s); }
    add(String(n), n, false, n === state.page);
    last = n;
  });
  add("›", Math.min(pages, state.page + 1), state.page >= pages);
}

async function openModal(id){
  const r = await fetch("/api/product?id=" + id);
  const it = await r.json();
  $("#mImg").src = it.img ? "/img/" + it.id : "";
  $("#mTitle").textContent = it.title;
  $("#mMeta").innerHTML = `
    <div>类目：<b>${esc(it.category || "—")}</b></div>
    <div>来源：<b>${it.source === "temu-search" ? "TEMU 消费者站" : "卖家中心·机会商品"}</b></div>
    <div>搜索词：<b>${esc(it.keyword || "—")}</b></div>
    <div>定制标记：<b>${it.is_custom ? "是" : "否"}</b></div>
    <div>源 ID：<b>${esc(it.source_id)}</b></div>
    <div>本地图片：<b>${esc(it.img_file || "无")}</b></div>`;
  const act = $("#mAct");
  if (it.excluded) {
    act.textContent = "恢复此商品"; act.className = "safe";
    act.onclick = async () => { await exclude(it.id, false); $("#dlg").close(); };
  } else {
    act.textContent = "剔除此商品";
    act.className = "danger";
    act.onclick = async () => { await exclude(it.id, true); $("#dlg").close(); };
  }
  $("#dlg").showModal();
}

let timer = null;
$("#q").addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; load(); }, 220);
});
$("#category").addEventListener("change", (e) => { state.category = e.target.value; state.page = 1; load(); });
$("#source").addEventListener("change", (e) => { state.source = e.target.value; state.page = 1; load(); });
$("#custom").addEventListener("change", (e) => {
  state.custom = e.target.checked; state.page = 1;
  $("#customToggle").classList.toggle("on", state.custom);
  load();
});
$("#showExcluded").addEventListener("change", (e) => {
  state.showExcluded = e.target.checked; state.page = 1;
  $("#showExcludedToggle").classList.toggle("on", state.showExcluded);
  load();
});
$("#closeBtn").onclick = () => $("#dlg").close();
$("#dlg").addEventListener("click", (e) => { if (e.target === $("#dlg")) $("#dlg").close(); });

loadMeta().then(load);
</script>
</body>
</html>
"""


def db(write=False):
    conn = sqlite3.connect(str(DB), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def migrate():
    """products 增加 excluded（软删除）列；已存在则跳过。"""
    conn = db()
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
        if "excluded" not in cols:
            conn.execute("ALTER TABLE products ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0")
            conn.commit()
            print("migrated: products.excluded added", flush=True)
    finally:
        conn.close()


def query_products(params):
    q = (params.get("q", [""])[0] or "").strip()
    category = params.get("category", [""])[0] or ""
    source = params.get("source", [""])[0] or ""
    custom = params.get("custom", [""])[0] == "1"
    show_excluded = params.get("show_excluded", [""])[0] == "1"
    try:
        page = max(1, int(params.get("page", ["1"])[0]))
    except ValueError:
        page = 1
    try:
        size = min(120, max(1, int(params.get("size", ["36"])[0])))
    except ValueError:
        size = 36

    where, args = [], []
    if not show_excluded:
        where.append("excluded = 0")
    if q:
        where.append("(title LIKE ? OR keyword LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    if category:
        where.append("category = ?")
        args.append(category)
    if source:
        where.append("source = ?")
        args.append(source)
    if custom:
        where.append("is_custom = 1")
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    conn = db()
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM products {clause}", args).fetchone()[0]
        rows = conn.execute(
            f"""SELECT id, source, source_id, category, title, keyword, is_custom, img_file, excluded
                FROM products {clause} ORDER BY id DESC LIMIT ? OFFSET ?""",
            args + [size, (page - 1) * size],
        ).fetchall()
    finally:
        conn.close()
    return {
        "total": total,
        "items": [
            {
                "id": r["id"], "source": r["source"], "source_id": r["source_id"],
                "category": r["category"], "title": r["title"], "keyword": r["keyword"],
                "is_custom": bool(r["is_custom"]), "img": bool(r["img_file"]),
                "excluded": bool(r["excluded"]),
            }
            for r in rows
        ],
    }


def query_meta():
    conn = db()
    try:
        total, custom, with_img = conn.execute(
            """SELECT COUNT(*), SUM(is_custom),
                      SUM(CASE WHEN img_file IS NOT NULL AND img_file<>'' THEN 1 ELSE 0 END)
               FROM products WHERE excluded=0"""
        ).fetchone()
        excluded = conn.execute("SELECT COUNT(*) FROM products WHERE excluded=1").fetchone()[0]
        cats = conn.execute(
            """SELECT category, COUNT(*) AS n FROM products WHERE excluded=0
               GROUP BY category ORDER BY n DESC"""
        ).fetchall()
    finally:
        conn.close()
    return {
        "total": total, "custom": custom or 0, "with_img": with_img or 0, "excluded": excluded,
        "categories": [
            {"category": c["category"] or "", "leaf": (c["category"] or "未分类").split(" > ")[-1], "count": c["n"]}
            for c in cats
        ],
    }


def query_product(pid):
    conn = db()
    try:
        r = conn.execute(
            "SELECT id, source, source_id, category, title, keyword, is_custom, img_file, excluded FROM products WHERE id=?",
            (pid,),
        ).fetchone()
    finally:
        conn.close()
    if not r:
        return None
    return {
        "id": r["id"], "source": r["source"], "source_id": r["source_id"],
        "category": r["category"], "title": r["title"], "keyword": r["keyword"],
        "is_custom": bool(r["is_custom"]), "img": bool(r["img_file"]), "img_file": r["img_file"],
        "excluded": bool(r["excluded"]),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TemuCatalogPreview/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/exclude":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                pid = int(payload.get("id"))
                excluded = 1 if payload.get("excluded", True) else 0
            except Exception:
                return self._send(400, json.dumps({"error": "bad request"}))
            conn = db()
            try:
                conn.execute("UPDATE products SET excluded=? WHERE id=?", (excluded, pid))
                conn.commit()
                row = conn.execute("SELECT id, excluded FROM products WHERE id=?", (pid,)).fetchone()
            finally:
                conn.close()
            if not row:
                return self._send(404, json.dumps({"error": "not found"}))
            return self._send(200, json.dumps({"ok": True, "id": pid, "excluded": bool(row["excluded"])}))
        return self._send(404, "not found", "text/plain; charset=utf-8")

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/":
                return self._send(200, HTML, "text/html; charset=utf-8")
            if u.path == "/api/meta":
                return self._send(200, json.dumps(query_meta(), ensure_ascii=False))
            if u.path == "/api/products":
                return self._send(200, json.dumps(query_products(parse_qs(u.query)), ensure_ascii=False))
            if u.path == "/api/product":
                pid = int(parse_qs(u.query).get("id", ["0"])[0])
                item = query_product(pid)
                return self._send(200, json.dumps(item, ensure_ascii=False)) if item else self._send(404, '{"error":"not found"}')
            if u.path.startswith("/img/"):
                pid = int(u.path.split("/")[-1])
                item = query_product(pid)
                if not item or not item.get("img_file"):
                    return self._send(404, "no image", "text/plain; charset=utf-8")
                p = (ROOT / item["img_file"]).resolve()
                if IMG_ROOT not in p.parents or not p.is_file():
                    return self._send(404, "no image", "text/plain; charset=utf-8")
                ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
                return self._send(200, p.read_bytes(), ctype)
            return self._send(404, "not found", "text/plain; charset=utf-8")
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)[:300]}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    migrate()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"商品库预览: http://{a.host}:{a.port}/  (Ctrl+C 停止)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()