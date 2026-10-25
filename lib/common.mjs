// lib/common.mjs — ego-browser 共享库（Mac 版驱动层地基）
//
// 运行环境：ego-browser nodejs（不继承 shell 环境变量/cwd）——路径全部由
// import.meta.url 推导为绝对路径；任务参数经根目录 run 启动器注入的
// globalThis.TEMU_ARGS 传入。
// 交互知识来源：discoveries/2026-10-24-ego-browser-验证.md（Phase 0 实测）。

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // lib/
export const REPO_ROOT = path.resolve(HERE, "..");
export const LOG_DIR = path.join(REPO_ROOT, "logs");
export const SHOT_DIR = path.join(REPO_ROOT, "screenshots");
export const EXPORT_DATA = path.join(REPO_ROOT, "modules", "collect", "data"); // 商品导出/页面快照（采集模块）

export const SPACE_NAME = "temu-agent"; // 固定 TaskSpace，全任务复用（p1=卖家后台主页）
export const GOODS_URL = "https://agentseller.temu.com/goods/list";
export const CUSTOMIZE_URL = "https://agentseller.temu.com/main/customize-goods";
export const LOGIN_URL = "https://seller.kuajingmaihuo.com/";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowTs() {
  const d = new Date();
  return `${today()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function args() {
  return globalThis.TEMU_ARGS || [];
}

export function log(msg) {
  console.log(`[${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}] ${msg}`);
}

/** 读凭据 local.config.json（gitignored，可能不存在——切店等任务才有硬依赖）。 */
export async function loadConfig() {
  try {
    return JSON.parse(await readFile(path.join(REPO_ROOT, "local.config.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 引导：复用固定 TaskSpace，返回 { task, page }，page = p1。 */
export async function boot() {
  const task = await taskSpace(SPACE_NAME);
  return { task, page: task.page("p1") };
}

/** 报告落盘（格式与 driver/report.py 完全一致，temu-panel 兼容）。 */
export async function writeReport(taskName, ok, lines, shots = []) {
  await mkdir(LOG_DIR, { recursive: true });
  const ts = nowTs();
  const body = [
    `# ${taskName} 报告`,
    `- 时间: ${ts}`,
    `- 结果: ${ok ? "✅ 成功" : "❌ 失败"}`,
    ...lines.map((l) => `- ${l}`),
    ...shots.map((s) => `- 截图: ${s}`),
  ];
  const text = body.join("\n") + "\n";
  const latest = path.join(LOG_DIR, "report-latest.md");
  await writeFile(latest, text, "utf8");
  await appendFile(path.join(LOG_DIR, `${taskName}-${today()}.md`), text + "\n", "utf8");
  const status = {
    task: taskName,
    ts,
    ok,
    summary: lines.length ? lines[lines.length - 1] : "",
    report: latest,
    shots,
  };
  await writeFile(path.join(LOG_DIR, "last-status.json"), JSON.stringify(status, null, 2), "utf8");
  return latest;
}

/** 截图到 screenshots/，返回绝对路径。 */
export async function shot(page, name) {
  await mkdir(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, `${name}-${today()}-${pad(new Date().getHours())}${pad(new Date().getMinutes())}${pad(new Date().getSeconds())}.png`);
  await page.screenshot({ path: p });
  return p;
}

/** 快照分行（默认整页；视口外元素也带 ref，配合 scrollIntoView 后可点）。 */
export async function snapLines(page, scope = "full_page") {
  const s = await page.snapshot({ scope });
  return s.split("\n");
}

/**
 * 在快照行里找含 sub 文本的行，向上回溯最近的 [ref=N]。
 * exact=true 时要求该行 trim 后严格等于 `text "<sub>"`。
 */
export function findRef(lines, sub, { exact = false, lookback = 6 } = {}) {
  const target = exact ? `text "${sub}"` : sub;
  for (let i = 0; i < lines.length; i++) {
    const hit = exact ? lines[i].trim() === target : lines[i].includes(sub);
    if (!hit) continue;
    for (let j = i; j >= Math.max(0, i - lookback); j--) {
      const m = lines[j].match(/\[ref=(\d+)\]/);
      if (m) return m[1];
    }
  }
  return null;
}

/** 清掉挡在坐标点上的 fixed/absolute 浮层（消息面板/佳同 iframe 等）。返回隐藏的浮层描述。 */
export async function clearBlockersAt(page, x, y) {
  return await page.evaluate(([px, py]) => {
    const hidden = [];
    for (let i = 0; i < 3; i++) {
      const b = document.elementFromPoint(px, py);
      if (!b) break;
      let done = false;
      let t = b;
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
    return hidden;
  }, [x, y]);
}

/**
 * 把目标按钮滚进视口并清掉挡路的 fixed/absolute 浮层（佳同 welcomePage iframe、
 * 运营欢迎浮窗等——Phase 0 实测高频坑）。desc: { text, exact }。
 * 返回 { rect, hidden } 或 { err }。
 */
export async function prepareClick(page, desc) {
  return await page.evaluate((d) => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const cands = [...document.querySelectorAll("button, [role=button], a, .MDL_iconWrapper")];
    const el = d.exact
      ? cands.find((b) => norm(b.textContent) === norm(d.text))
      : cands.find((b) => norm(b.textContent).includes(norm(d.text)));
    if (!el) return { err: "not_found" };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { err: "invisible" };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hidden = [];
    for (let i = 0; i < 3; i++) {
      const b = document.elementFromPoint(cx, cy);
      if (!b || b === el || el.contains(b)) break;
      let hid = false;
      let t = b;
      for (let k = 0; k < 8 && t; k++) {
        const st = getComputedStyle(t);
        const rr = t.getBoundingClientRect();
        if ((st.position === "fixed" || st.position === "absolute") && rr.width > 150 && rr.height > 100) {
          t.style.display = "none";
          hidden.push(((t.className || "").toString() || t.tagName).slice(0, 50));
          hid = true;
          break;
        }
        t = t.parentElement;
      }
      if (!hid) break; // 拦截者不是可隐藏的浮层，交给调用方决定
    }
    const b2 = document.elementFromPoint(cx, cy);
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      hidden,
      clear: !b2 || b2 === el || el.contains(b2),
    };
  }, desc);
}

/**
 * 智能点击：prepareClick 清障 → 新快照拿 ref → 点 @ref；仍失败则 DOM .click() 兜底。
 */
export async function clickButton(page, desc, { label = "", timeout = 10000 } = {}) {
  const prep = await prepareClick(page, desc);
  if (prep.err) return { err: prep.err };
  const lines = await snapLines(page);
  const ref = findRef(lines, desc.text, { exact: !!desc.exact });
  if (ref) {
    try {
      await page.click("@" + ref, { timeout, ...(label ? { label } : {}) });
      return { ok: true, via: "ref", rect: prep.rect, hidden: prep.hidden };
    } catch (e) {
      log(`ref 点击失败（${String(e.message).slice(0, 80)}），转 DOM click`);
    }
  }
  const dom = await page.evaluate((d) => {
    const norm = (s) => (s || "").replace(/\s+/g, "");
    const cands = [...document.querySelectorAll("button, [role=button], a, .MDL_iconWrapper")];
    const el = d.exact
      ? cands.find((b) => norm(b.textContent) === norm(d.text))
      : cands.find((b) => norm(b.textContent).includes(norm(d.text)));
    if (!el) return "not_found";
    el.click();
    return "clicked";
  }, desc);
  if (dom !== "clicked") return { err: dom };
  return { ok: true, via: "dom", rect: prep.rect, hidden: prep.hidden };
}

/**
 * 关 TEMU 弹窗：待办任务弹窗 / 运营欢迎浮窗（按标题关键词定位容器，
 * X = 容器内 MDL_iconWrapper；X 悬在面板外侧，兜底右上角外围几何扫描）。
 * 良性 toast（知道了/我知道了）顺带点掉。返回关闭了的弹窗标题列表。
 */
export async function closeModals(page, { rounds = 3 } = {}) {
  const closed = [];
  for (let i = 0; i < rounds; i++) {
    const r = await page.evaluate(() => {
      const kill = (kw) => {
        const leaf = [...document.querySelectorAll("*")].find((e) =>
          e.children.length === 0 && (e.textContent || "").includes(kw));
        if (!leaf) return null;
        let box = leaf;
        for (let k = 0; k < 12 && box.parentElement; k++) {
          box = box.parentElement;
          const r0 = box.getBoundingClientRect();
          if (r0.width > 200 && r0.height > 80) break;
        }
        const x = [...box.querySelectorAll("*")].find((el) =>
          /MDL_iconWrapper/i.test((el.className || "").toString()));
        if (x && typeof x.click === "function") { x.click(); return kw; }
        if (x) {
          // SVG 等无 .click 的元素：坐标点击
          const xr = x.getBoundingClientRect();
          if (xr.width > 0) {
            const cx = xr.left + xr.width / 2, cy = xr.top + xr.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            if (hit && typeof hit.click === "function") { hit.click(); return kw; }
          }
        }
        const br = box.getBoundingClientRect();
        for (const [dx, dy] of [[-16, 30], [-30, 30], [0, 30], [-16, 10], [-30, 10], [10, -10]]) {
          const el = document.elementFromPoint(br.right + dx, br.top + dy);
          if (!el) continue;
          const er = el.getBoundingClientRect();
          const cls = (el.className || "").toString();
          if (er.width > 0 && er.width < 60 && er.height > 0 && er.height < 60 &&
              (/icon|close|guanbi|MDL/i.test(cls) || el.tagName.toLowerCase() === "svg")) {
            if (typeof el.click === "function") { el.click(); return kw + "(geo)"; }
            // SVG 无 .click：派发真实鼠标事件序列
            const cx = er.left + er.width / 2, cy = er.top + er.height / 2;
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
            }
            return kw + "(geo-dispatch)";
          }
        }
        return null;
      };
      for (const kw of ["您有以下待办任务需要尽快处理", "欢迎使用单品优惠券功能", "活动邀请"]) {
        const done = kill(kw);
        if (done) return done;
      }
      // 良性 toast
      for (const btn of [...document.querySelectorAll("button")]) {
        const t = (btn.textContent || "").trim();
        if (t === "知道了" || t === "我知道了" && typeof btn.click === "function") { btn.click(); return t; }
      }
      return null;
    });
    if (!r) break;
    closed.push(r);
    await sleep(1200);
  }
  return closed;
}

/**
 * 商品列表页统计（正则自 driver/export_goods.py grab_stats 平移，输入改为快照行）。
 */
export function parseGoodsStats(lines) {
  const text = lines.map((l) => l.replace(/\s+/g, "")).join(" ");
  const stats = { counts: {}, todo: {} };
  const countPats = [
    ["全部", /全部(\d+)/], ["在售中", /在售中(\d+)/], ["未发布到站点", /未发布到站点(\d+)/],
    ["已下架/已终止", /已下架.?已终止(\d+)/], ["已删除", /已删除(\d+)/], ["草稿箱", /草稿箱.(\d+)/],
  ];
  const todoPats = [
    ["商品信息", /商品信息(\d+)/], ["商品属性", /商品属性(\d+)/], ["商品SKU", /商品SKU(\d+)/],
    ["建议零售价", /建议零售价(\d+)/], ["图片/视频", /图片.?视频(\d+)/],
  ];
  for (const [name, pat] of countPats) {
    const m = text.match(pat);
    if (m) stats.counts[name] = parseInt(m[1], 10);
  }
  for (const [name, pat] of todoPats) {
    const m = text.match(pat);
    if (m) stats.todo[name] = m[1];
  }
  return stats;
}

/** 恢复页面上所有「弹框已禁用」药丸开关（忆托+佳同各一个，每标签页独立实例）。
 *  禁用态会用隐形遮罩拦截一切弹窗—— grind/settle 的前置不变量。 */
export async function restoreDialogSwitch(pg, name = "页面") {
  for (let round = 0; round < 3; round++) {
    const pills = await pg.evaluate(() => {
      const out = [];
      for (const leaf of [...document.querySelectorAll("*")]) {
        if (leaf.children.length === 0 && (leaf.textContent || "").includes("弹框已禁用")) {
          const r = leaf.getBoundingClientRect();
          if (r.width > 0) out.push([r.left + r.width + 14, r.top + r.height / 2]);
        }
      }
      return out;
    }).catch(() => []);
    if (!pills.length) return true;
    for (const pos of pills) await pg.mouse.click(pos[0], pos[1], { label: `${name}恢复弹框开关` }).catch(() => {});
    await sleep(1500);
  }
  const left = await pg.evaluate(() =>
    [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent || "").includes("弹框已禁用")).length).catch(() => 0);
  if (left > 0) log(`⚠ ${name} 仍有 ${left} 个弹框开关处于禁用态`);
  return left === 0;
}
