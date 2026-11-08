// modules/collect/temu-collect.mjs — TEMU 机会商品采集（只读）
// 数据源：卖家中心「机会商品」页（/newon/invite-bids/list）的内部列表接口。
// 采集字段：商品标题 / 完整类目路径 / 主图（首图）。
// 该接口带 Anti-Content 签名头，无法在页面外直接调用：
// 先驱动页面自身「查询」捕获一次签名请求，再在同一浏览器会话内用 page.fetch 重放翻页。
//
// 用法:
//   run temu-collect 餐巾                # 默认每页 100，自动翻页取全量
//   run temu-collect 餐巾 --size 50 --pages 3
//   run temu-collect 餐巾 --out /path/to/file.jsonl
//
// 只读声明：仅设置搜索词/点「查询」/读接口返回/下载商品图，不点报名等任何写操作。
// 产物：
//   modules/collect/data/temu-opportunity-<date>.jsonl   每行一个商品
//   modules/collect/data/images/<orderId>.<ext>          主图
// 导入数据库：.venv/bin/python modules/collect/import_catalog.py

import path from "node:path";
import { mkdir, appendFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { args, boot, log, nowTs, sleep, today, REPO_ROOT } from "../../lib/common.mjs";

const execFileP = promisify(execFile);

const DATA = path.join(REPO_ROOT, "modules", "collect", "data");
const IMG_DIR = path.join(DATA, "images");
const API = "/api/kiana/ace/biddingInvitationSupplierRpcService/pageQueryBiddingInvitationOrderList";
const LIST_URL = "https://agentseller.temu.com/newon/invite-bids/list";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function opt(name, def) {
  const i = args().indexOf(`--${name}`);
  return i >= 0 ? args()[i + 1] : def;
}
const positional = args().filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));
const keyword = positional[0] || "餐巾";
const pageSize = Math.max(1, Number(opt("size", 100)));
const maxPages = Number(opt("pages", 0)) || Infinity;
const filterArg = opt("filter", "");
const titleFilter = filterArg ? new RegExp(filterArg, "i") : null;
const outFile = opt("out", path.join(DATA, `temu-opportunity-${today()}.jsonl`));

function isSearchInput(e) {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.y > 330 && r.y < 480 && r.x > 600 && (e.placeholder || "") === "请输入";
}

async function setKeyword(page, kw) {
  return await page.evaluate((kw) => {
    const inp = [...document.querySelectorAll("input")].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.y > 330 && r.y < 480 && r.x > 600 && (e.placeholder || "") === "请输入";
    });
    if (!inp) return { err: "no_input" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inp, kw);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }, kw);
}

async function clickButton(page, text) {
  return await page.evaluate((text) => {
    const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === text && e.getBoundingClientRect().width > 0);
    if (!b) return { ok: false };
    b.click();
    return { ok: true };
  }, text);
}

/** 驱动页面自身查询，捕获最近一次列表请求的签名头 + 原始 payload。 */
async function captureSigned(page) {
  await page.cdp("Network.enable").catch(() => {});
  await page.events();
  const set = await setKeyword(page, keyword);
  if (!set.ok) throw new Error("找不到机会商品名称输入框");
  await sleep(400);
  const clk = await clickButton(page, "查询");
  if (!clk.ok) throw new Error("找不到查询按钮");

  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const evs = (await page.events()) || [];
    const hit = evs.find(
      (e) => /requestWillBeSent$/.test(e.method || "") &&
        /pageQueryBiddingInvitationOrderList/.test((e.params && e.params.request && e.params.request.url) || ""),
    );
    if (!hit) continue;
    const headers = (hit.params.request && hit.params.request.headers) || {};
    if (!headers["Anti-Content"] || !headers["mallid"]) continue;
    let postData = null;
    try {
      postData = (await page.cdp("Network.getRequestPostData", { requestId: hit.params.requestId })).postData;
    } catch {}
    if (!postData) continue;
    return { mallid: headers["mallid"], anti: headers["Anti-Content"], payload: JSON.parse(postData) };
  }
  // 同词重复查询可能被前端缓存跳过：重置后再试一次
  log("未捕获到签名请求，重置后重试");
  await clickButton(page, "重置");
  await sleep(1200);
  await setKeyword(page, keyword);
  await sleep(300);
  await clickButton(page, "查询");
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const evs = (await page.events()) || [];
    const hit = evs.find(
      (e) => /requestWillBeSent$/.test(e.method || "") &&
        /pageQueryBiddingInvitationOrderList/.test((e.params && e.params.request && e.params.request.url) || ""),
    );
    if (!hit) continue;
    const headers = (hit.params.request && hit.params.request.headers) || {};
    let postData = null;
    try {
      postData = (await page.cdp("Network.getRequestPostData", { requestId: hit.params.requestId })).postData;
    } catch {}
    if (headers["Anti-Content"] && postData) {
      return { mallid: headers["mallid"], anti: headers["Anti-Content"], payload: JSON.parse(postData) };
    }
  }
  throw new Error("捕获签名请求失败（页面结构可能已改版）");
}

async function loadExisting(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const txt = await readFile(file, "utf8").catch(() => "");
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      map.set(String(r.source_id), r);
    } catch {}
  }
  return map;
}

async function downloadImage(url, file) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await execFileP(
        "/usr/bin/curl",
        ["-sS", "--max-time", "30", "-o", file, "-w", "%{http_code} %{size_download}",
          "-A", UA, "-e", LIST_URL, url],
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

/** 简单并发池 */
async function pool(items, limit, fn) {
  let i = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { it.__err = String(e).slice(0, 160); }
    }
  }));
}

async function main() {
  const t0 = Date.now();
  await mkdir(IMG_DIR, { recursive: true });
  await mkdir(path.dirname(outFile), { recursive: true });
  log(`采集开始 keyword="${keyword}" size=${pageSize} out=${path.relative(REPO_ROOT, outFile)}`);

  const { page } = await boot();
  if (!/invite-bids/.test(page.url())) {
    log("导航到机会商品页…");
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(5000);
  }

  let signed = await captureSigned(page);
  log(`签名已捕获 payload=${JSON.stringify(signed.payload).slice(0, 160)}`);

  const existing = await loadExisting(outFile);
  const seen = new Set();
  let total = null;
  let collected = 0, skipped = 0, filtered = 0, retried = 0, imgOk = 0, imgFail = 0;
  const pageLimit = Math.min(maxPages, 1000);

  for (let pn = 1; pn <= pageLimit; pn++) {
    const post = JSON.parse(JSON.stringify(signed.payload));
    post.pageInfo = { pageNo: pn, pageSize };
    let j = null;
    for (let attempt = 0; attempt < 3 && !j; attempt++) {
      const res = await page.fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", mallid: signed.mallid, "Anti-Content": signed.anti },
        body: JSON.stringify(post),
        timeout: 20000,
      }).catch((e) => ({ ok: false, status: 0, err: String(e).slice(0, 160) }));
      if (!res.ok) {
        log(`page ${pn} 请求失败 status=${res.status} ${res.err || ""}`);
        if (res.status === 403) {
          signed = await captureSigned(page);
          log("签名刷新完成");
        }
        await sleep(1500 * (attempt + 1));
        continue;
      }
      try {
        const body = JSON.parse(res.body);
        if (!body.success) throw new Error(body.errorMsg || "success=false");
        j = body;
      } catch (e) {
        log(`page ${pn} 响应解析失败: ${String(e).slice(0, 160)}`);
        await sleep(1200);
      }
    }
    if (!j) throw new Error(`page ${pn} 重试后仍失败`);

    if (total === null) {
      total = j.result.total;
      log(`共 ${total} 条，计划 ${Math.min(Math.ceil(total / pageSize), pageLimit)} 页`);
    }
    const list = (j.result && j.result.list) || [];
    if (!list.length) break;

    // 先整理本页待处理条目
    const batch = [];
    for (const it of list) {
      const o = it.biddingInvitationOrder || {};
      const id = String(o.bidingInvitationOrderId || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = o.name || "";
      if (titleFilter && !titleFilter.test(title)) { filtered++; continue; }

      const prev = existing.get(id);
      const prevAbs = prev && prev.img_file ? path.join(REPO_ROOT, prev.img_file) : null;
      const hasImg = prevAbs && existsSync(prevAbs) && (await stat(prevAbs)).size > 3000;
      if (prev && hasImg) { skipped++; continue; }

      const imgs = o.imageUrlList || [];
      const imgUrl = imgs[0] || null;
      if (!imgUrl) { skipped++; continue; }
      const m = imgUrl.match(/\.(png|jpe?g|webp)(\?|$)/i);
      const ext = m ? m[1].toLowerCase() : "png";
      batch.push({
        id, title, o, imgUrl,
        abs: path.join(IMG_DIR, `${id}.${ext}`),
        isRetry: !!prev,
      });
    }

    // 并发下载图片（签名 URL 有效期约 10 分钟，取回后立即 download）
    await pool(batch, 4, async (b) => {
      await downloadImage(b.imgUrl, b.abs);
      b.imgFile = path.relative(REPO_ROOT, b.abs);
    });

    for (const b of batch) {
      const o = b.o;
      if (b.imgFile) imgOk++;
      else { imgFail++; log(`图片下载失败 ${b.id}: ${b.__err || "unknown"}`); }
      if (b.isRetry) retried++;
      const row = {
        source: "opportunity",
        source_id: b.id,
        keyword,
        title: b.title,
        category: (o.catNameList || []).join(" > "),
        cat_ids: (o.catIdList || []).join(","),
        img_url: b.imgUrl,
        img_file: b.imgFile || null,
        requirement: (o.requirement || []).join(","),
        collected_at: nowTs(),
      };
      await appendFile(outFile, JSON.stringify(row) + "\n");
      collected++;
    }

    log(`page ${pn}: +${batch.length}（本批累计 ${collected}，跳过 ${skipped}，过滤 ${filtered}）`);
    if (total !== null && pn * pageSize >= total) break;
    await sleep(900 + Math.floor(Math.random() * 500));
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  log("采集完成");
  console.log("RESULT " + JSON.stringify({
    keyword, total, collected, skipped, filtered, retried, imgOk, imgFail, out: outFile, secs,
  }));
}

main().catch((e) => {
  console.error("ERROR " + String(e && e.stack || e).slice(0, 600));
  process.exitCode = 1;
});