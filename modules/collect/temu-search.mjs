// modules/collect/temu-search.mjs — TEMU 消费者站搜索采集（只读）
// 数据源：https://www.temu.com/search_result.html?search_key=<keyword>
// 采集字段：商品标题（页面本地化中文）/ 主图原图 / goodsId。
// 注意：消费者站列表卡片不显示类目；本库把搜索主题（默认「定制餐巾」）写入 category，
// 真实搜索词保存在 keyword 字段，供后续筛选。
//
// 用法:
//   run temu-search "custom napkin"
//   run temu-search "personalized napkins" --max 120 --category 定制餐巾
//
// 只读声明：只搜索、滚动、点「查看更多」加载列表、读卡片、下载图片，不进商品详情页。
// 产物：modules/collect/data/temu-consumer-<date>.jsonl + data/images-consumer/<goodsId>.<ext>

import path from "node:path";
import { mkdir, appendFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { args, boot, log, nowTs, sleep, today, REPO_ROOT } from "../../lib/common.mjs";

const execFileP = promisify(execFile);
const DATA = path.join(REPO_ROOT, "modules", "collect", "data");
const IMG_DIR = path.join(DATA, "images-consumer");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REF = "https://www.temu.com/";

function opt(name, def) {
  const i = args().indexOf(`--${name}`);
  return i >= 0 ? args()[i + 1] : def;
}
const positional = args().filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));
const keyword = positional[0] || "custom napkin";
const maxItems = Math.max(20, Number(opt("max", 200)));
const category = opt("category", "定制餐巾");
const outFile = opt("out", path.join(DATA, `temu-consumer-${today()}.jsonl`));
const searchUrl = `https://www.temu.com/search_result.html?search_key=${encodeURIComponent(keyword)}`;

function toOriginal(url) {
  return (url || "").split("?")[0];
}

function extOf(url) {
  const m = url.match(/\.(png|jpe?g|webp)(\?|$)/i);
  return m ? m[1].toLowerCase() : "jpg";
}

async function loadExisting(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const txt = await readFile(file, "utf8").catch(() => "");
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(String(r.source_id), r); } catch {}
  }
  return map;
}

async function extractCards(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    // 商品卡片以标题 tooltip 节点为锚点：data-tooltip="goodName-<goodsId>"，
    // 标题全文在 data-tooltip-title；主图在卡片内 src 含 img.kwcdn.com/product 的 img。
    // 2026-11-08 登录后实测：列表不再使用 img.goods-img-external，此写法兼容新旧两版。
    for (const nameEl of document.querySelectorAll("[data-tooltip^='goodName-']")) {
      const m = (nameEl.getAttribute("data-tooltip") || "").match(/^goodName-(\d+)$/);
      if (!m) continue;
      const card = nameEl.closest(".earth-wxt-collect-warp") || nameEl.parentElement?.parentElement;
      if (!card) continue;
      const link = card.querySelector("a[href*='-g-']");
      const title = nameEl.getAttribute("data-tooltip-title") || norm(nameEl.textContent) || "";
      const prodImgs = [...card.querySelectorAll("img")].filter((im) =>
        ((im.currentSrc || im.src) || "").includes("img.kwcdn.com/product"),
      );
      prodImgs.sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
      const img = prodImgs[0];
      const src = img ? (img.currentSrc || img.src || "") : "";
      if (src && title) out.push({ id: m[1], title, img: src, linked: !!link });
    }
    const seen = new Set();
    return out.filter((c) => !seen.has(c.id) && seen.add(c.id));
  });
}

async function clickMore(page) {
  const box = await page.evaluate(() => {
    const els = [...document.querySelectorAll("div,button,span")].filter(
      (e) => (e.textContent || "").trim() === "查看更多" && e.getBoundingClientRect().width > 500,
    );
    if (!els.length) return null;
    els[0].scrollIntoView({ block: "center" });
    const r = els[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!box) return false;
  await sleep(300);
  await page.mouse.click(box.x, box.y);
  return true;
}

async function downloadImage(url, file) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await execFileP(
        "/usr/bin/curl",
        ["-sS", "--max-time", "40", "-o", file, "-w", "%{http_code} %{size_download}",
          "-A", UA, "-e", REF, url],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      const size = (await stat(file)).size;
      if (size < 3000) throw new Error(`too small: ${size}B`);
      return size;
    } catch (e) {
      last = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { it.__err = String(e).slice(0, 140); }
    }
  }));
}

async function main() {
  const t0 = Date.now();
  await mkdir(IMG_DIR, { recursive: true });
  log(`采集开始 keyword="${keyword}" max=${maxItems} category=${category}`);
  const { page } = await boot();

  log(`搜索 keyword="${keyword}"`);
  // 2026-11-08 登录后实测：直接 goto search_result.html 会渲染空白（结果区不加载），
  // 走首页搜索框输入提交正常。URL 直航保留为回退。
  await page.goto("https://www.temu.com/", { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await sleep(3500);
  let uiOk = false;
  try {
    const input = 'input[aria-label*="搜索框"]';
    await page.waitForSelector(input, { state: "visible", timeout: 12000 });
    await page.fill(input, keyword);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => location.href.includes("search_result") && document.querySelectorAll(".earth-wxt-collect-warp").length > 0,
      undefined,
      { timeout: 25000 },
    );
    uiOk = true;
    log("搜索框检索成功");
  } catch (e) {
    log(`搜索框检索失败，回退 URL 直航: ${String((e && e.message) || e).slice(0, 120)}`);
  }
  if (!uiOk) {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await sleep(2500);

  const existing = await loadExisting(outFile);
  const found = new Map();
  let idle = 0;

  for (let round = 0; round < 80; round++) {
    const cards = await extractCards(page);
    let added = 0;
    for (const c of cards) if (!found.has(c.id)) { found.set(c.id, c); added++; }
    log(`round ${round + 1}: 页面 ${cards.length}，新增 ${added}，累计 ${found.size}`);
    if (found.size >= maxItems) break;
    if (added === 0) idle++; else idle = 0;
    if (idle >= 2) break;
    const ok = await clickMore(page);
    if (!ok) { log("没有「查看更多」按钮，列表到底"); break; }
    await sleep(2200 + Math.floor(Math.random() * 900));
  }

  const todo = [...found.values()].slice(0, maxItems).filter((c) => !existing.has(c.id) || !existing.get(c.id).img_file);
  log(`待入库 ${todo.length} 条（新 ${todo.filter((c) => !existing.has(c.id)).length}）`);

  // 并发下载主图
  await pool(todo, 4, async (c) => {
    const imgUrl = toOriginal(c.img);
    const ext = extOf(imgUrl);
    c.abs = path.join(IMG_DIR, `${c.id}.${ext}`);
    c.imgUrl = imgUrl;
    if (existsSync(c.abs) && (await stat(c.abs)).size > 3000) { c.imgFile = path.relative(REPO_ROOT, c.abs); return; }
    await downloadImage(imgUrl, c.abs);
    c.imgFile = path.relative(REPO_ROOT, c.abs);
  });

  let ok = 0, fail = 0, written = 0;
  for (const c of todo) {
    if (c.imgFile) ok++; else { fail++; log(`图片失败 ${c.id}: ${c.__err || "unknown"}`); }
    const row = {
      source: "temu-search",
      source_id: c.id,
      keyword,
      title: c.title,
      category,
      img_url: c.imgUrl || toOriginal(c.img),
      img_file: c.imgFile || null,
      collected_at: nowTs(),
    };
    await appendFile(outFile, JSON.stringify(row) + "\n");
    written++;
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log("RESULT " + JSON.stringify({ keyword, found: found.size, written, imgOk: ok, imgFail: fail, out: outFile, secs }));
}

main().catch((e) => {
  console.error("ERROR " + String((e && e.stack) || e).slice(0, 600));
  process.exitCode = 1;
});