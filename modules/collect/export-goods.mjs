// modules/collect/export-goods.mjs — 商品列表导出（只读）
// 用法: run export-goods <store-id>
// 移植自 driver/export_goods.py；差异：下载不轮询目录，直接 waitForEvent('download')；
// 统计从快照文本抽取（原 OCR）；成功信号 = 下载事件（弹窗点击确认后不关闭）。
//
// 只读声明：全程只 导航/关闭弹窗/导出查询结果，绝不点同步、上新、改价、批量删除。

import path from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import {
  GOODS_URL, EXPORT_DATA, args, boot, clickButton, closeModals, findRef,
  log, parseGoodsStats, sleep, snapLines, shot, today, writeReport,
} from "../../lib/common.mjs";

async function ensureGlobalScope(page) {
  // 语义快照里没有「商品列表·全球」标题（那是 OCR 视角的文案）。
  // 全球/美区/欧区 chip 里当前选中项无状态标记 → 用 evaluate 读触发器文本判断。
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const els = [...document.querySelectorAll("*")].filter((e) => {
      const t = norm(e.textContent);
      return e.children.length === 0 && (t === "全球" || t === "美区" || t === "欧区");
    });
    if (!els.length) return "unknown";
    // 取最靠右上且可见的一个作为当前范围显示
    const visible = els.filter((e) => e.getBoundingClientRect().width > 0);
    const el = (visible.length ? visible : els)[0];
    const t = norm(el.textContent);
    if (t === "全球") return "全球";
    // 非全球 → 点开范围下拉，选全球
    el.click();
    return t;
  });
}

async function doExport(page, store) {
  // 1) 滚到位、清浮层、点「下载查询结果」（避开佳同/忆托的导出类按钮）
  await page.keyboard.press("Escape").catch(() => {}); // 先关掉可能残留的 popover
  await sleep(600);
  const open = await clickButton(page, { text: "下载查询结果" }, { label: "打开导出弹窗" });
  if (!open.ok) throw new Error(`打开导出弹窗失败: ${JSON.stringify(open)}`);
  if (open.hidden?.length) log(`已隐藏遮挡浮层: ${open.hidden.join(", ")}`);

  // 2) 等弹窗渲染（共查询到 N 个SKC）
  let dialogOk = false;
  for (let i = 0; i < 8; i++) {
    const lines = await snapLines(page);
    if (lines.some((l) => l.includes("共查询到"))) { dialogOk = true; break; }
    await sleep(800);
  }
  if (!dialogOk) throw new Error("导出弹窗未出现（共查询到）");

  // 3) 确认按钮 = 「导出」+「取消」同排兄弟；成功信号 = download 事件（弹窗不关闭）
  const lines = await snapLines(page);
  let confirmRef = null;
  let cancelRef = null;
  for (let i = 0; i < lines.length - 3; i++) {
    if (/\[ref=\d+\]/.test(lines[i]) && lines[i + 1].trim() === 'text "导出"' &&
        /\[ref=\d+\]/.test(lines[i + 2]) && lines[i + 3].trim() === 'text "取消"') {
      confirmRef = lines[i].match(/\[ref=(\d+)\]/)[1];
      cancelRef = lines[i + 2].match(/\[ref=(\d+)\]/)[1];
      break;
    }
  }
  if (!confirmRef) throw new Error("未找到导出确认按钮（导出+取消 模式）");

  const prep = await page.evaluate((ref) => {
    // 用取消按钮定位弹窗区域，清掉挡在确认按钮上的浮层
    const cancel = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "取消");
    if (!cancel) return { err: "no_cancel" };
    const exp = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent || "").trim() === "导出" &&
      Math.abs(b.getBoundingClientRect().top - cancel.getBoundingClientRect().top) < 40);
    if (!exp) return { err: "no_confirm" };
    const r = exp.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hidden = [];
    for (let i = 0; i < 3; i++) {
      const blocker = document.elementFromPoint(cx, cy);
      if (!blocker || blocker === exp || exp.contains(blocker)) break;
      let done = false;
      let t = blocker;
      for (let k = 0; k < 8 && t; k++) {
        const st = getComputedStyle(t);
        const rr = t.getBoundingClientRect();
        if ((st.position === "fixed" || st.position === "absolute") && rr.width > 150 && rr.height > 100) {
          t.style.display = "none";
          hidden.push(((t.className || "").toString() || t.tagName).slice(0, 40));
          done = true;
          break;
        }
        t = t.parentElement;
      }
      if (!done) break;
    }
    return { hidden };
  }, confirmRef);
  if (prep.hidden?.length) log(`确认按钮前隐藏浮层: ${prep.hidden.join(", ")}`);

  const dlPromise = page.waitForEvent("download", { timeout: 420000 });
  await page.click("@" + confirmRef, { label: "确认导出", timeout: 10000 });
  log("已点确认导出，等待文件生成+下载…");

  const dl = await dlPromise;
  const dest = path.join(EXPORT_DATA, `${store}-goods-${today()}.xlsx`);
  await dl.saveAs(dest);
  const bytes = (await stat(dest)).size;
  log(`✓ 下载完成 ${dl.suggestedFilename()} → ${dest}（${bytes} bytes）`);

  // 4) 收尾：关掉残留的导出弹窗（点取消）
  await sleep(800);
  const closeLines = await snapLines(page);
  if (closeLines.some((l) => l.includes("共查询到"))) {
    const cRef = findRef(closeLines, "取消", { exact: true });
    if (cRef) await page.click("@" + cRef, { timeout: 5000 }).catch(() => {});
  }
  return { dest, bytes, suggested: dl.suggestedFilename() };
}

async function main() {
  const [store = "main"] = args();
  const lines = [];
  const shots = [];
  let ok = false;
  const { page } = await boot();
  try {
    log(`→ 导航商品列表（店铺 ${store}）`);
    await page.goto(GOODS_URL, { timeout: 60000 });
    await page.waitForLoadState("load").catch(() => {});
    await sleep(6000);

    const closed = await closeModals(page);
    if (closed.length) lines.push(`关闭弹窗: ${closed.join("、")}`);

    const scope = await ensureGlobalScope(page);
    lines.push(`视图范围: ${scope}`);
    await sleep(1500);

    const snap = await snapLines(page);
    const stats = parseGoodsStats(snap);
    lines.push(`页面统计: ${JSON.stringify(stats.counts)} 待办: ${JSON.stringify(stats.todo)}`);
    await mkdir(EXPORT_DATA, { recursive: true });
    await writeFile(
      path.join(EXPORT_DATA, `${store}-page.md`),
      `# ${store} 商品列表页快照（ego-browser 语义） ${today()}\n\n\`\`\`\n${snap.join("\n")}\n\`\`\`\n`,
      "utf8",
    );

    let result = null;
    let lastErr = null;
    for (let att = 1; att <= 3; att++) {
      try {
        result = await doExport(page, store);
        break;
      } catch (e) {
        lastErr = e;
        log(`导出尝试 ${att} 失败: ${e.message}`);
        await closeModals(page);
        await sleep(2000);
      }
    }
    if (!result) throw lastErr;

    shots.push(await shot(page, `export-${store}`));
    lines.push(`✓ 已归档 ${result.dest}（${result.bytes} bytes，${result.suggested}）`);
    ok = true;
  } catch (e) {
    lines.push(`✗ 失败: ${e.message}`);
    try { shots.push(await shot(page, `export-${store}-fail`)); } catch {}
  }
  await writeReport("export-goods", ok, lines, shots);
  log(ok ? "✅ 导出完成" : "❌ 导出失败");
  process.exitCode = ok ? 0 : 1;
}

main().catch(async (e) => {
  console.error("FATAL", e);
  try { await writeReport("export-goods", false, [`✗ 异常: ${e.message}`]); } catch {}
  process.exitCode = 1;
});
