// modules/grind/grind-one.mjs — 单 SKC 调价（改数据！运行前需用户在对话中明确确认）
// 用法: run grind-one <SKC> [--dry-run] [--cat 类目] [--ref 工单建议价]
// 移植自 driver/grind_one.py（git a3ea58d）。业务纪律（三条铁律）不变：
//   ① 勾选行必须填值（空勾选行提交会把原价格作废——禁止）
//   ② 成功唯一信号 = 弹窗关闭（「确认调价」按钮消失）
//   ③ 最终以导出复核为准（run export-goods）
// ego 版改进：
//   - 类目从弹窗文本自动识别（腕带→0.33 / 餐巾→0.16；识别不出=中止，绝不猜成本。
//     旧 grind_batch 硬编码「派对餐巾」的隐患不复制）
//   - 行处理在单次 evaluate 内完成：按 (数量,现价,输入框序号) 签名重定位——
//     等价于旧的「逐行重新 OCR 定位」，但无 OCR 误差
//   - 填值后回读 input.value 验证（React 原生 setter + input/change 事件 + blur）
//   - --dry-run：填好+取消作废行后【取消提交】并截图（上线验证用）
// 退出码：0 提交成功（或 dry-run 完成）/ 1 失败 / 2 未找到目标 / 3 零行可调

import { args, boot, clearBlockersAt, log, restoreDialogSwitch, sleep, shot, writeReport } from "../../lib/common.mjs";

const SELECT_URL = "https://agentseller.temu.com/newon/product-select";
const COST = { 派对餐巾: 0.16, 餐巾: 0.16, 餐巾纸: 0.16, 身份腕带: 0.33 };
const FIXED_PER_ORDER = 9;

/** 建议价（30% 净利率）：(成本×数量 + 9) ÷ 0.5，向上取 0.5 的整数倍。 */
function sug(cost, q) {
  return Math.ceil((cost * q + FIXED_PER_ORDER) / 0.5 * 2) / 2;
}

// ---------- 页内动作（注意：传给 page.evaluate 的是函数源码，正则用单反斜杠） ----------

async function dialogOpen(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    return [...document.querySelectorAll("button")].some((b) => norm(b.textContent) === "确认调价");
  });
}

/** 扫描弹窗：{ text, rows:[{qty,price,checked,value,voided,cbIndex,inputRect,rowRect}] } 或 { err }。
 *  ⚠ 行必须从【勾选框】侧建立且行高 <150px：从价格输入框上溯会命中嵌套表格的
 *  大容器（其文本包含所有行），把表头全选框误认成数据行——点它 = 全表取消勾选
 *  （2026-10-24 实测事故根因）。真行高 67-68px。 */
async function scanRows(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
    if (!btn) return { err: "no_dialog" };
    let box = btn;
    for (let i = 0; i < 15 && box && box !== document.body; i++) {
      box = box.parentElement;
      if (!box) break;
      const hasCancel = [...box.querySelectorAll("button")].some((b) => norm(b.textContent) === "取消");
      if (hasCancel && box.querySelectorAll("input").length >= 2) break;
    }
    if (!box || box === document.body) return { err: "dialog_bounds" };
    const rows = [];
    [...box.querySelectorAll("input[type=checkbox], [role=checkbox]")].forEach((cb, cbIndex) => {
      let row = cb;
      for (let i = 0; i < 10 && row && row !== box; i++) {
        row = row.parentElement;
        if (!row) break;
        const rh = row.getBoundingClientRect().height;
        if (rh > 150) return; // 上溯过头（表头/表体容器），这不是数据行的勾选框
        const t = norm(row.textContent);
        if (/pcs|件|张|片/i.test(t) && /¥\d/.test(t)) {
          const qm = t.match(/(\d{1,3})\s*(?:pcs|件|张|片)/i);
          const pm = t.match(/¥(\d+(?:\.\d{1,2})?)/);
          const input = [...row.querySelectorAll("input")].find((el) => el.type !== "checkbox" &&
            el.getBoundingClientRect().width > 20);
          const ir = input ? input.getBoundingClientRect() : null;
          const rr = row.getBoundingClientRect();
          // 可视勾选框 = 原生 input 的父层 wrapper（input 本身 opacity:0 / 0×0）
          const civ = cb.getBoundingClientRect();
          const cbRect = (civ.width > 4 && civ.height > 4)
            ? [civ.left, civ.top, civ.width, civ.height]
            : (() => { const p = cb.parentElement.getBoundingClientRect(); return [p.left, p.top, p.width, p.height]; })();
          rows.push({
            qty: qm ? parseInt(qm[1], 10) : null,
            price: pm ? parseFloat(pm[1]) : null,
            checked: cb.checked,
            value: input ? input.value : "",
            voided: t.includes("已作废"),
            tag: t.includes("降价"),
            cbIndex,
            cbRect: [Math.round(cbRect[0]), Math.round(cbRect[1]), Math.round(cbRect[2]), Math.round(cbRect[3])],
            inputRect: ir ? [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)] : null,
            rowRect: [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)],
          });
          break;
        }
      }
    });
    return { text: norm(box.textContent).slice(0, 600), rows, vp: [innerWidth, innerHeight] };
  });
}

/**
 * 在最新扫描里按 (数量,现价,cbIndex) 找行。
 * ⚠ TEMU 卖家后台只认 trusted 事件：DOM .click() 不触发查询、合成 input 事件
 * 会被 React 受控组件回滚（2026-10-24 dry-run 实测）——所有动作必须走
 * page.mouse/keyboard 真实事件；本文件所有读状态都来自 scanRows 的重扫结果。
 */
function pickRow(rows, sig, pred) {
  const matches = rows.filter((r) => r.qty === sig.qty && r.price === sig.price);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const byIdx = matches.find((r) => r.cbIndex === sig.cbIndex);
    if (byIdx) return byIdx;
    return matches.find(pred) || null;
  }
  return null;
}

/** 把第 idx 个勾选框滚进视口（弹窗内表格是独立滚动区，视口外的行真实鼠标点不到）。 */
async function scrollCbIntoView(page, cbIndex) {
  await page.evaluate((idx) => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
    let box = btn;
    for (let i = 0; i < 15 && box && box !== document.body; i++) {
      box = box.parentElement;
      if (!box) break;
      const hasCancel = [...box.querySelectorAll("button")].some((b) => norm(b.textContent) === "取消");
      if (hasCancel && box.querySelectorAll("input").length >= 2) break;
    }
    if (!box || box === document.body) return;
    const cb = [...box.querySelectorAll("input[type=checkbox], [role=checkbox]")][idx];
    if (cb) cb.scrollIntoView({ block: "center" });
  }, cbIndex);
  await sleep(600);
}

function inViewport(row, vh) {
  return row.cbRect && row.cbRect[1] >= 60 && row.cbRect[1] + row.cbRect[3] <= vh - 10;
}

/** 取消勾选（组感知）：该签名组内已勾选数减少即成功（重复规格行等价）。 */
async function uncheckRow(page, sig) {
  const checkedCount = async () => {
    const s = await scanRows(page);
    if (s.err) return -1;
    return s.rows.filter((r) => r.qty === sig.qty && r.price === sig.price && r.checked === true).length;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await checkedCount();
    if (before === 0) return { st: "already" };
    if (before < 0) return { st: "no_dialog" };
    const scan = await scanRows(page);
    const vh = scan.vp ? scan.vp[1] : 783;
    const matches = scan.rows.filter((r) => r.qty === sig.qty && r.price === sig.price && r.checked === true);
    let row = matches.find((r) => inViewport(r, vh)) || matches[0];
    if (!row.cbRect || row.cbRect[2] <= 2) return { st: "no_checkbox" };
    if (!inViewport(row, vh)) {
      await scrollCbIntoView(page, row.cbIndex);
      const fresh = await scanRows(page);
      const m2 = fresh.rows.filter((r) => r.qty === sig.qty && r.price === sig.price && r.checked === true);
      row = m2.find((r) => inViewport(r, vh)) || m2[0];
      if (!row) continue;
    }
    await page.mouse.click(row.cbRect[0] + row.cbRect[2] / 2, row.cbRect[1] + row.cbRect[3] / 2,
      { label: "取消勾选" });
    await sleep(700);
    const after = await checkedCount();
    if (after >= 0 && after < before) return { st: "unchecked" };
  }
  return { st: "uncheck_fail" };
}

/** 填建议价（组感知）：优先组内【未填且在视口内】的行；成功 = 组内已填计数增加。
 *  同签名重复行（同规格同现价的不同 SKU）视为等价，逐次填一份。 */
async function fillRow(page, sig, target) {
  const filledCount = async () => {
    const s = await scanRows(page);
    if (s.err) return -1;
    return s.rows.filter((r) => r.qty === sig.qty && r.price === sig.price &&
      (r.value === String(target) || r.tag)).length;
  };
  const before = await filledCount();
  if (before < 0) return { st: "no_dialog" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const scan = await scanRows(page);
    if (scan.err) return { st: scan.err };
    const vh = scan.vp[1];
    const matches = scan.rows.filter((r) => r.qty === sig.qty && r.price === sig.price);
    if (!matches.length) return { st: "no_row" };
    let row = matches.find((r) => !r.value && !r.tag);
    if (!row) return { st: "filled" }; // 组内全部已填（重试幂等）
    if (!row.inputRect) return { st: "no_input" };
    if (!inViewport(row, vh)) {
      // 逐个未填行尝试：滚到谁且谁真的进了视口，就用谁（回退不能再选视口外的行）
      const unfilledAll = matches.filter((r) => !r.value && !r.tag);
      let done = false;
      for (const cand of unfilledAll) {
        await scrollCbIntoView(page, cand.cbIndex);
        const fresh = await scanRows(page);
        if (fresh.err) continue;
        const hit = fresh.rows.find((r) => r.qty === sig.qty && r.price === sig.price &&
          !r.value && !r.tag && r.cbIndex === cand.cbIndex);
        if (hit && inViewport(hit, vh)) { row = hit; done = true; break; }
      }
      if (!done) continue;
    }
    if (row.checked === false) {
      const c = await toggleCheck(page, { qty: sig.qty, price: sig.price, cbIndex: row.cbIndex }, true);
      if (c.st !== "checked") return { st: "check_fail" };
      await sleep(400);
      // 勾选可能触发重渲染，重取坐标
      const fresh = await scanRows(page);
      const m2 = fresh.rows.filter((r) => r.qty === sig.qty && r.price === sig.price);
      row = m2.find((r) => !r.value && !r.tag && inViewport(r, vh)) || row;
    }
    await page.mouse.click(row.inputRect[0] + row.inputRect[2] / 2, row.inputRect[1] + row.inputRect[3] / 2,
      { label: "聚焦价格输入框" });
    await sleep(400);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(String(target));
    await sleep(400);
    // 点申报价格类型列失焦（旧流程验证过的做法）
    await page.mouse.click(row.rowRect[0] + 180, row.rowRect[1] + row.rowRect[3] / 2, { label: "失焦" });
    await sleep(900);
    const after = await filledCount();
    if (after > before) return { st: "filled" };
  }
  return { st: "fill_fail" };
}

/** 状态驱动的一轮：扫一行做一个动作。返回 'acted'|'idle'|'done'|'scanErr'。
 *  ctx: { trail, attempted, cat, refSug, counters }（counters: {filled,unchecked,skipped,failed}） */
async function oneRound(page, ctx) {
  const scan = await scanRows(page);
  if (scan.err) return "scanErr";
  const vh = scan.vp[1];
  const rows = scan.rows;
  const badQty = (q) => q === null || q < 10 || q > 999;
  const needUncheck = (r) => r.voided || badQty(r.qty) ||
    (r.qty !== null && r.price !== null && r.price <= sug(COST[ctx.cat], r.qty) * 1.05);
  const needFill = (r) => !r.voided && !badQty(r.qty) && r.price !== null &&
    r.price > sug(COST[ctx.cat], r.qty) * 1.05 && !r.value && !r.tag;

  // ① 失败签名的善后：取消其勾选（空勾选行绝不能留着提交）
  const deadSig = [...ctx.attempted].find((k) => {
    if (k.endsWith("#dead")) return false;
    const [q, p] = k.split("|").map(Number);
    return rows.some((r) => r.qty === q && r.price === p && r.checked === true && !r.value);
  });
  if (deadSig) {
    const [q, p] = deadSig.split("|").map(Number);
    const r = await uncheckRow(page, { qty: q, price: p });
    if (r.st === "unchecked") { ctx.counters.unchecked++; ctx.trail.push(`${q}件¥${p}→善后取消勾选`); log(`  善后：取消失败签名的勾选（${q}件 ¥${p}）`); return "acted"; }
    return "idle"; // 善后未生效，下一轮重试
  }

  const inVP = (r) => r.cbRect && r.cbRect[1] >= 60 && r.cbRect[1] + r.cbRect[3] <= vh - 10;
  const target = rows.find((r) => needUncheck(r) && r.checked === true && inVP(r)) ||
    rows.find((r) => needFill(r) && inVP(r)) ||
    rows.find((r) => (needUncheck(r) && r.checked === true) || needFill(r));
  if (!target) return "done";

  const sig = { qty: target.qty, price: target.price, cbIndex: target.cbIndex };
  const key = `${target.qty}|${target.price}`;
  const label = `${target.qty ?? "?"}件 ¥${target.price ?? "?"}`;

  if (needUncheck(target)) {
    const r = await uncheckRow(page, sig);
    if (r.st === "unchecked") { ctx.counters.unchecked++; ctx.trail.push(`${label}→取消勾选(${target.voided ? "作废" : badQty(target.qty) ? "数量" : "≈建议"})`); log(`  ${label} → 取消勾选`); return "acted"; }
    if (r.st === "already") { ctx.counters.skipped++; ctx.trail.push(`${label}→本就未勾选`); return "acted"; }
    if (ctx.attempted.has(key)) { ctx.counters.failed++; ctx.trail.push(`${label}→取消勾选失败放弃`); log(`  ⚠ ${label} 取消勾选两次失败，放弃该行`); ctx.attempted.add(key + "#dead"); return "acted"; }
    ctx.attempted.add(key);
    log(`  ⚠ ${label} 取消勾选失败(${r.st})，重试`);
    return "acted";
  }
  // 待填行
  if (ctx.attempted.has(key)) { ctx.counters.skipped++; return "acted"; }
  const targetPrice = sug(COST[ctx.cat], target.qty);
  if (ctx.refSug && Math.abs(targetPrice - ctx.refSug) > ctx.refSug * 0.4) {
    log(`  ⚠ ${label}: 按弹窗数量应为 ${targetPrice}，工单建议价 ${ctx.refSug} 偏差>40%（导出规格滞后？），以弹窗为准`);
  }
  const r = await fillRow(page, sig, targetPrice);
  if (r.st === "filled") { ctx.counters.filled++; ctx.trail.push(`${label}→填${targetPrice}`); log(`  ${label} → 填 ${targetPrice} ✓`); return "acted"; }
  if (ctx.attempted.has(key)) {
    ctx.attempted.add(key + "#dead");
    await uncheckRow(page, sig);
    ctx.counters.failed++; ctx.trail.push(`${label}→填${targetPrice}失败(${r.st})放弃并取消勾选`);
    log(`  ✗ ${label} 填 ${targetPrice} 两次失败(${r.st})，取消勾选放弃`);
    return "acted";
  }
  ctx.attempted.add(key);
  log(`  ⚠ ${label} 填 ${targetPrice} 失败(${r.st})，重试`);
  return "acted";
}

/** 找弹窗表格的滚动容器；返回 { el, scrollHeight, clientHeight } 或 null。 */
const FN_SCROLL_CONTAINER = `
  () => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
    if (!btn) return null;
    let box = btn;
    for (let i = 0; i < 15 && box && box !== document.body; i++) {
      box = box.parentElement;
      if (!box) break;
      const hasCancel = [...box.querySelectorAll("button")].some((b) => norm(b.textContent) === "取消");
      if (hasCancel && box.querySelectorAll("input").length >= 2) break;
    }
    if (!box || box === document.body) return null;
    const cb = box.querySelector("input[type=checkbox]");
    if (!cb) return null;
    let el = cb;
    for (let i = 0; i < 12 && el && el !== box; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.scrollHeight > el.clientHeight + 60 && el.clientHeight > 120) {
        return { found: true, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
    }
    return { found: false };
  }`;

async function sweepTable(page, ctx) {
  const meta = await page.evaluate(new Function("return (" + FN_SCROLL_CONTAINER + ")")());
  if (!meta || !meta.found) return 0;
  let actedTotal = 0;
  const step = Math.max(meta.clientHeight - 60, 200);
  for (let top = 0; top <= meta.scrollHeight; top += step) {
    await page.evaluate((t) => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
      let box = btn;
      for (let i = 0; i < 15 && box && box !== document.body; i++) {
        box = box.parentElement;
        if (!box) break;
        const hasCancel = [...box.querySelectorAll("button")].some((b) => norm(b.textContent) === "取消");
        if (hasCancel && box.querySelectorAll("input").length >= 2) break;
      }
      const cb = box.querySelector("input[type=checkbox]");
      let el = cb;
      for (let i = 0; i < 12 && el && el !== box; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.scrollHeight > el.clientHeight + 60 && el.clientHeight > 120) { el.scrollTop = t; return; }
      }
    }, top);
    await sleep(700);
    for (let i = 0; i < 30; i++) {
      const r = await oneRound(page, ctx);
      if (r === "acted") actedTotal++;
      else break;
    }
  }
  return actedTotal;
}

async function cancelDialog(page) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      const c = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "取消");
      if (c) c.click();
    });
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(1500);
    if (!(await dialogOpen(page))) return true;
  }
  return !(await dialogOpen(page));
}

/** 一键已读 + 活动邀请「暂不调整」。 */
async function settleOverlays(page) {
  const r = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const acted = [];
    for (const btn of [...document.querySelectorAll("button, a, span")]) {
      if (norm(btn.textContent).includes("一键已读所有消息")) { btn.click(); acted.push("一键已读"); break; }
    }
    for (const btn of [...document.querySelectorAll("button")]) {
      if (norm(btn.textContent) === "暂不调整") { btn.click(); acted.push("暂不调整"); break; }
    }
    return acted;
  });
  if (r.length) log(`→ 浮层处理: ${r.join("、")}`);
  await sleep(1500);
  // 前置不变量：插件「弹框已禁用」会隐形拦截一切弹窗（2026-10-24 切店连败总根源）
  const restored = await restoreDialogSwitch(page, "调价页");
  if (!restored) log("⚠ 弹框开关未能全部恢复，弹窗操作可能受阻");
  // 消息面板（PP_popoverMain portal + new-bell_）会盖住右侧「发起调价」入口，
  // 且 Esc 关不掉——点它自己的 X（真实鼠标点击）
  const x = await page.evaluate(() => {
    const portal = [...document.querySelectorAll("[class*='PP_popoverMain']")]
      .find((p) => p.querySelector("[class*='new-bell_']") && p.getBoundingClientRect().width > 300);
    if (!portal) return null;
    const r = portal.getBoundingClientRect();
    const el = document.elementFromPoint(r.right - 30, r.top + 28);
    if (!el) return null;
    const er = el.getBoundingClientRect();
    return [er.left + er.width / 2, er.top + er.height / 2];
  });
  if (x) {
    await page.mouse.click(x[0], x[1], { label: "关闭消息面板" });
    await sleep(1000);
    log("→ 已关闭消息面板");
  }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(800);
  // 佳同「待确认调价」提醒：10 分钟会重新弹——点「已读 & 今日不再提示」根治
  // （插件元素 DOM click 无效，必须按文本定位真实鼠标点击；绝不点「点击前往」）
  for (let i = 0; i < 3; i++) {
    const still = await page.evaluate(() =>
      [...document.querySelectorAll("*")].some((e) =>
        e.children.length === 0 && (e.textContent || "").includes("佳同跨境插件提醒")));
    if (!still) break;
    const pos = await page.evaluate(() => {
      const leaf = [...document.querySelectorAll("*")].find((e) =>
        e.children.length === 0 && /已读\s*&\s*今日不再提示/.test(e.textContent || ""));
      if (!leaf) return null;
      const r = leaf.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    if (!pos) { log("⚠ 提醒在但找不到「已读&今日不再提示」按钮"); break; }
    await page.mouse.click(pos[0], pos[1], { label: "已读今日不再提示" });
    await sleep(1500);
  }
}

// ---------- 主流程 ----------

async function main() {
  const a = args();
  const dryRun = a.includes("--dry-run");
  const flagVal = (name) => {
    const i = a.indexOf(name);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : null;
  };
  const catArg = flagVal("--cat");
  const refRaw = flagVal("--ref");
  const refSug = refRaw ? parseFloat(refRaw) : null;
  let skc = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--cat" || a[i] === "--ref") { i++; continue; }
    if (a[i].startsWith("--")) continue;
    skc = a[i];
    break;
  }
  if (!skc) {
    console.error("用法: run grind-one <SKC> [--dry-run] [--cat 类目] [--ref 工单建议价]");
    process.exitCode = 64;
    return;
  }

  const lines = [];
  const { page } = await boot();
  let rc = 1;

  try {
    await page.goto(SELECT_URL, { timeout: 60000 });
    await page.waitForLoadState("load").catch(() => {});
    await sleep(8000);
    await settleOverlays(page);
    // ⚠ 待办筛选重置：页面 reload 后默认「商品信息待确认」=勾选（用户实测知识：
    //   该筛选勾着时查询只显示待确认商品，其他 SKC 一律 0 条）。重载到已知默认态
    //   再精确点掉这一个 chip，其余 chip 不碰（盲点会误勾其他筛选）。
    await page.reload({ timeout: 30000 }).catch(() => {});
    await sleep(8000);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(800);
    const chipPos = await page.evaluate(() => {
      const leaf = [...document.querySelectorAll("*")].find((e) =>
        e.children.length === 0 && (e.textContent || "").replace(/\s+/g, "").startsWith("商品信息待确认"));
      if (!leaf) return null;
      // ⚠ 切换热区 = 整个 chip 卡片，必须点卡片中心（点文本中心/角标常不生效，2026-10-25 store-d）
      let box = leaf.parentElement;
      for (let k = 0; k < 5 && box; k++) {
        const r = box.getBoundingClientRect();
        if (r.width > 60 && r.height > 25) return [r.left + r.width / 2, r.top + r.height / 2];
        box = box.parentElement;
      }
      const r = leaf.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    if (chipPos) {
      for (let a = 0; a < 2; a++) {
        await page.mouse.click(chipPos[0], chipPos[1], { label: "取消商品信息待确认筛选" });
        await sleep(2000);
        // 视觉校验：勾角标消失（chip 文本行内不再有蓝色选中样式元素）——简化：再查一次蓝勾 SVG/角标
        const stillChecked = await page.evaluate(() => {
          const leaf = [...document.querySelectorAll("*")].find((e) =>
            e.children.length === 0 && (e.textContent || "").replace(/\s+/g, "").startsWith("商品信息待确认"));
          if (!leaf) return false;
          let box = leaf.parentElement;
          for (let k = 0; k < 5 && box; k++) {
            const r = box.getBoundingClientRect();
            if (r.width > 60 && r.height > 25) {
              // 选中态卡片有蓝色边框
              const bc = getComputedStyle(box).borderColor.match(/rgba?\((\d+), (\d+), (\d+)/);
              if (bc) { const [r0, g0, b0] = [+bc[1], +bc[2], +bc[3]]; return b0 > 150 && b0 - r0 > 30; }
              return false;
            }
            box = box.parentElement;
          }
          return false;
        });
        if (!stillChecked) { log("→ 已取消「商品信息待确认」筛选"); break; }
        log(`  ⚠ 筛选仍勾选（第${a + 1}次点击未生效），重试`);
      }
    } else {
      log("⚠ 未找到待办筛选 chip（页面结构变化？）");
    }

    // 1) 商品ID查询：label 作用域找输入框 → 容器内「查询」按钮
    const q = await page.evaluate((skc) => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      let input = null;
      const hint = [...document.querySelectorAll("input")].find((i) =>
        (i.placeholder || "").includes("多个查询") || (i.placeholder || "").includes("依次输入"));
      if (hint) input = hint;
      if (!input) {
        const lbl = [...document.querySelectorAll("*")].find((e) =>
          e.children.length === 0 && norm(e.textContent) === "商品ID查询");
        if (lbl) {
          let box = lbl;
          for (let i = 0; i < 6 && box && !input; i++) {
            box = box.parentElement;
            if (box) input = box.querySelector("input");
          }
        }
      }
      if (!input) return { err: "no_input" };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      input.focus();
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(input, skc);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      let btn = null;
      let box = input;
      for (let i = 0; i < 15 && box && !btn; i++) {
        box = box.parentElement;
        if (box) btn = [...box.querySelectorAll("button")].find((b) => norm(b.textContent) === "查询");
      }
      return { ok: input.value === skc, hasBtn: !!btn };
    }, skc);
    if (q.err) throw new Error(`查询输入框未找到(${q.err})`);
    if (!q.ok) throw new Error("查询框填写失败");

    // 查询按钮必须真实鼠标点击（DOM .click() 实测不触发搜索，2026-10-24）
    if (q.hasBtn) {
      const pos = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "查询");
        if (!btn) return null;
        btn.scrollIntoView({ block: "center" });
        return { cx: Math.round(btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2),
                 cy: Math.round(btn.getBoundingClientRect().top + btn.getBoundingClientRect().height / 2) };
      });
      if (pos) {
        await page.evaluate(() => {
          const input = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("多个查询"));
          if (input) input.focus();
        });
        await sleep(400);
        await page.mouse.click(pos.cx, pos.cy, { label: "点击查询" });
        log("→ 已点击查询");
      } else {
        log("⚠ 查询按钮定位失败，回车提交");
        await page.keyboard.press("Enter").catch(() => {});
      }
    } else {
      log("⚠ 未找到查询按钮，回车提交");
      await page.keyboard.press("Enter").catch(() => {});
    }
    await sleep(8000);
    // 查询生效校验：为 0 时自愈 = reload 重置筛选 + 取消商品信息待确认 + 重查
    const filtered = await page.evaluate((skc) =>
      document.body.innerText.replace(/\s+/g, "").includes(skc), skc);
    if (!filtered) {
      log("→ 查询为 0，重载重置筛选后重查");
      await page.reload({ timeout: 30000 }).catch(() => {});
      await sleep(8000);
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(800);
      const chipPos = await page.evaluate(() => {
        const leaf = [...document.querySelectorAll("*")].find((e) =>
          e.children.length === 0 && (e.textContent || "").replace(/\s+/g, "").startsWith("商品信息待确认"));
        if (!leaf) return null;
        const r = leaf.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      });
      if (chipPos) { await page.mouse.click(chipPos[0], chipPos[1], { label: "取消筛选" }); await sleep(2000); }
      await page.evaluate((id) => {
        const input = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("多个查询"));
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        input.focus();
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(input, id);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, skc);
      const pos2 = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const el = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "查询" && b.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      });
      if (pos2) {
        await page.mouse.click(pos2[0], pos2[1], { label: "重查" });
        await sleep(9000);
      }
      const filtered2 = await page.evaluate((skc) =>
        document.body.innerText.replace(/\s+/g, "").includes(skc), skc);
      if (!filtered2) throw new Error("查询未生效（目标 SKC 不在结果页，检查输入/按钮/待办筛选）");
      log("→ 自愈重查成功");
    }
    log("→ 查询已过滤出目标商品");

    // 2) 逐个打开「发起调价」并按 SKC-ID 匹配（渲染门控：等「确认调价」出现）
    let matched = false;
    let dialogText = "";
    for (let n = 0; n < 8 && !matched; n++) {
      const opened = await page.evaluate((n) => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const els = [...document.querySelectorAll("button, a, span")]
          .filter((e) => norm(e.textContent) === "发起调价" && e.getBoundingClientRect().width > 0);
        if (n >= els.length) return "exhausted";
        els[n].scrollIntoView({ block: "center" });
        const r = els[n].getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }, n);
      if (opened === "exhausted") break;
      await clearBlockersAt(page, opened[0], opened[1]);
      await page.mouse.click(opened[0], opened[1], { label: "打开发起调价" });
      let open = false;
      for (let i = 0; i < 5; i++) {
        await sleep(1800);
        if (await dialogOpen(page)) { open = true; break; }
      }
      if (!open) {
        log(`  第${n + 1}个入口弹窗未渲染，跳过`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(1000);
        continue;
      }
      await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        for (const btn of [...document.querySelectorAll("button")]) {
          const t = norm(btn.textContent);
          if (t === "我知道了" || t === "知道了") { btn.click(); break; }
        }
      });
      await sleep(800);
      const scan = await scanRows(page);
      if (scan.err) { log(`  弹窗扫描失败(${scan.err})，关闭重试`); await cancelDialog(page); continue; }
      dialogText = scan.text;
      if (new RegExp(`SKC[^0-9]{0,6}${skc}`).test(dialogText)) {
        matched = true;
        log(`✓ 匹配目标弹窗（第${n + 1}个入口）`);
        break;
      }
      log("  非目标弹窗，取消");
      await cancelDialog(page);
    }
    if (!matched) { rc = 2; throw new Error(`未找到目标 SKC ${skc} 的调价弹窗`); }

    // 3) 类目自动识别（绝不猜成本）
    let cat = null;
    if (dialogText.includes("腕带")) cat = "身份腕带";
    else if (dialogText.includes("餐巾")) cat = "派对餐巾";
    else if (catArg && COST[catArg]) cat = catArg;
    if (!cat || !COST[cat]) { rc = 1; throw new Error(`类目无法识别（弹窗文本无 腕带/餐巾，arg=${catArg}），中止`); }
    if (catArg && COST[catArg] && catArg !== cat) log(`⚠ 类目冲突：arg=${catArg}，弹窗识别=${cat}（以弹窗为准）`);
    log(`→ 类目: ${cat}（成本 ${COST[cat]}/件）`);

    // 4) 状态驱动循环 + 虚拟滚动全表扫荡（弹窗表格虚拟化：从未滚到的行不在 DOM，
    //    app 侧却勾选着——不扫全表就会卡提交。2026-10-24 实测）
    let filled = 0, unchecked = 0, skipped = 0, failed = 0;
    const ctx = { trail: [], attempted: new Set(), cat, refSug,
      counters: { filled: 0, unchecked: 0, skipped: 0, failed: 0 } };
    {
      let first = true;
      for (let round = 0; round < 120; round++) {
        const scan = await scanRows(page);
        if (!first && scan.err) break;
        if (first) {
          if (scan.err) { ctx.counters.failed++; lines.push(`✗ 弹窗扫描失败(${scan.err})`); break; }
          first = false;
          log(`弹窗 ${scan.rows.length} 行可见：${scan.rows.filter((r) => r.voided).length} 作废 / ${scan.rows.filter((r) => r.qty !== null).length} 数量可解析`);
        }
        const r = await oneRound(page, ctx);
        if (r !== "acted") break;
      }
      // 全表扫荡：分步滚动，让虚拟化的行渲染出来并处理
      for (let sweep = 0; sweep < 3; sweep++) {
        const acted = await sweepTable(page, ctx);
        log(`  全表扫荡第${sweep + 1}遍：处理 ${acted} 行`);
        if (acted === 0) break;
      }
      log(`结果：填 ${ctx.counters.filled} / 取消勾选 ${ctx.counters.unchecked} / 跳过 ${ctx.counters.skipped} / 失败 ${ctx.counters.failed}`);
      if (ctx.trail.length) lines.push(`行明细: ${ctx.trail.join("; ")}`);
      filled = ctx.counters.filled; unchecked = ctx.counters.unchecked; failed = ctx.counters.failed;
    }

    if (dryRun) {
      const p = await shot(page, `grind-${skc}-dryrun`);
      const closed = await cancelDialog(page);
      lines.push(`SKC ${skc}（${cat}）dry-run: 填 ${filled} / 取消勾选 ${unchecked} / 跳过 ${skipped} / 失败 ${failed}`,
        closed ? "已取消提交（dry-run，无数据变更）" : "⚠ 弹窗未关干净，需人工确认",
        `截图: ${p}`);
      await writeReport("grind-one", closed && failed === 0, lines);
      log(closed ? "✅ dry-run 完成（未提交）" : "⚠ dry-run 弹窗未关闭");
      process.exitCode = closed && failed === 0 ? 0 : 1;
      return;
    }

    // 5) 提交（铁律①②：先自救空勾选行；成功=弹窗关闭）
    if (filled === 0) {
      log("⚠ 0 行可调，取消");
      await cancelDialog(page);
      rc = 3;
      lines.push(`SKC ${skc}: 0 行可调（现价已被平台调平/作废）`);
      await writeReport("grind-one", true, lines, [await shot(page, `grind-${skc}-noop`)]);
      process.exitCode = 3;
      return;
    }
    if (failed > 0) {
      await cancelDialog(page);
      rc = 1;
      throw new Error(`${failed} 行处理失败——绝不半填提交`);
    }
    let submitted = false;
    for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
      const fresh = await scanRows(page);
      if (!fresh.err) {
        for (const row of fresh.rows) {
          if (row.checked === true && !row.value) {
            const r = await uncheckRow(page, { qty: row.qty, price: row.price, cbIndex: row.cbIndex });
            if (r.st === "unchecked") log(`  自救：取消空勾选行（${row.qty ?? "?"}件）`);
          }
        }
        await sleep(800);
      }
      const clicked = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, "");
        const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!clicked) { rc = 1; throw new Error("确认调价按钮未找到"); }
      // 提交是服务器往返：按钮会进入 loading 禁用态数秒——轮询等关闭（最多 40s），
      // 别急着判失败（曾因 3s 就放弃还点了取消，2026-10-24 实测）
      let closed = false;
      for (let w = 0; w < 20; w++) {
        await sleep(2000);
        if (!(await dialogOpen(page))) { closed = true; break; }
      }
      if (closed) { submitted = true; log("✅ 弹窗关闭，调价已提交（待导出复核）"); }
      else {
        const errText = await page.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, "");
          const btn = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "确认调价");
          let box = btn;
          for (let i = 0; i < 15 && box && box !== document.body; i++) {
            box = box.parentElement;
            if (!box) break;
            const hasCancel = [...box.querySelectorAll("button")].some((b) => norm(b.textContent) === "取消");
            if (hasCancel && box.querySelectorAll("input").length >= 2) break;
          }
          return box && box !== document.body ? norm(box.textContent).slice(0, 200) : "";
        });
        lines.push(`第${attempt + 1}次提交未关闭，弹窗文本: ${errText}`);
        lines.push(`提交受阻截图: ${await shot(page, `grind-submit-blocked-${attempt}`)}`);
        log(`  第${attempt + 1}次提交弹窗未关，弹窗文本: ${errText.slice(0, 80)}`);
      }
    }
    if (!submitted) { await cancelDialog(page); rc = 1; throw new Error("提交失败（弹窗未关闭）"); }
    lines.push(`SKC ${skc}（${cat}）: 填 ${filled} 行、取消勾选 ${unchecked} 行 → 已提交，待导出复核`);
    await writeReport("grind-one", true, lines, [await shot(page, `grind-${skc}-done`)]);
    process.exitCode = 0;
  } catch (e) {
    lines.push(`SKC ${skc ?? "?"}: ✗ ${e.message}`);
    try { lines.push(`截图: ${await shot(page, `grind-${skc}-fail`)}`); } catch {}
    await writeReport("grind-one", false, lines);
    log(`✗ ${e.message}`);
    process.exitCode = rc;
  }
}

main();
