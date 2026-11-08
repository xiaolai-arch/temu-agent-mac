// modules/listing/batch-fill-one.mjs — 整夜批量上新：单个商品全流程自动填表
// 由 ego-browser nodejs 执行：ego-browser nodejs < modules/listing/batch-fill-one.mjs
// 读取 /tmp/ego-batch-current.json（由 batch-prep.py 生成）
//
// 红线：不改价/不删商品；验证码出现即停；用户接管浏览器即停（ego 会抛错）。
// 本脚本只做已在本会话验证过的动作序列。

(async () => {
  const fs = await import("node:fs");
  const cfg = JSON.parse(fs.readFileSync("/tmp/ego-batch-current.json", "utf8"));
  const IDX = cfg.idx;
  const task = await taskSpace("temu-agent");
  const p1 = task.page("p1");
  const FLOG = `/tmp/ego-fill-${IDX}.log`;
  try { fs.writeFileSync(FLOG, ""); } catch (e) {}
  const plog = (line) => {
    const t = new Date().toISOString().slice(11, 19);
    try { fs.appendFileSync(FLOG, `[${t}] ${line}\n`); } catch (e) {}
  };
  const step = (s) => { console.log(`STEP ${IDX} ${s}`); plog(`STEP ${s}`); };
  const warn = (o) => { console.log(`WARN ${IDX} ${JSON.stringify(o)}`); plog(`WARN ${JSON.stringify(o)}`); };
  let lastErr = null;

  const esc = async () => { try { await p1.keyboard.press("Escape"); } catch (e) {} await p1.waitForTimeout(200); };

  // TEMU 商品名称上限 125 字（250 字符，中文按 2 计）
  function clampCn(s, limit = 240) {
    s = String(s || "");
    const units = (x) => { let n = 0; for (const c of x) n += c.charCodeAt(0) > 127 ? 2 : 1; return n; };
    if (units(s) <= limit) return s;
    let acc = 0, out = "";
    for (const c of s) { acc += c.charCodeAt(0) > 127 ? 2 : 1; if (acc > limit) break; out += c; }
    for (const sep of ["，", ",", "、", " - ", "-", " "]) {
      const j = out.lastIndexOf(sep);
      if (j >= Math.floor(out.length * 0.6)) return out.slice(0, j).replace(/[，,、\s-]+$/, "");
    }
    return out.replace(/[，,、\s-]+$/, "");
  }
  const cnName = () => clampCn(cfg.names.cn, 240);
  const enName = () => String(cfg.names.en || "").slice(0, 250);

  // 佳同插件的调价/提效强提醒：只关闭提醒、隐藏弹窗与遮罩，
  // 绝不点「确认调整」「确认提交」等任何改价按钮（不改数据）。
  // 2026-11-08 实测：类目页的 grape-price-adjust 与草稿页的 limit-flow-adjust-price
  // 两种全屏 modal 都会挡住表单，右上角提醒卡会盖住右列输入。
  async function dismissPriceAdjustOverlay() {
    return await p1.evaluate(() => {
      const out = { ignore: 0, modal: 0, mask: 0, notice: 0 };
      for (const el of document.querySelectorAll(".jtyt-price-adjust-ignore-btn")) {
        try { el.click(); out.ignore++; } catch (e) {}
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      };
      for (const w of document.querySelectorAll('[class*="MDL_outerWrapper"]')) {
        if (!visible(w)) continue;
        const html = w.innerHTML || "";
        if (/adjust-price|price-adjust/.test(html)) {
          w.style.display = "none";
          out.modal++;
        }
      }
      const notice = document.querySelector("#jtyt-priceAdjust-notice-alert");
      if (notice && visible(notice)) { notice.style.display = "none"; out.notice++; }
      if (out.modal) {
        for (const m of document.querySelectorAll('[class*="MDL_mask"]')) {
          const r = m.getBoundingClientRect();
          if (r.width > 1000 && r.height > 500 && visible(m)) { m.style.display = "none"; out.mask++; }
        }
      }
      return out;
    });
  }

  // 关闭右上「全部消息」popover（不关会遮住右列属性/物流输入）
  async function clearObstructions() {
    await dismissPriceAdjustOverlay();
    for (let a = 0; a < 2; a++) {
      const p = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const panel = [...document.querySelectorAll("div")].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 300 && r.height > 300 && r.x > 400 && norm(e.textContent).includes("全部消息");
        }).sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        })[0];
        if (!panel) return { err: "none" };
        const pr = panel.getBoundingClientRect();
        const svgs = [...panel.querySelectorAll("svg")].filter((s) => {
          const r = s.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.y < pr.top + 90 && r.x > pr.right - 140;
        }).map((s) => {
          const r = s.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), sx: r.x };
        }).sort((a, b) => b.sx - a.sx);
        if (!svgs.length) return { err: "no_x" };
        return svgs[0];
      });
      if (p.err) return;
      await p1.mouse.click(p.x, p.y);
      await p1.waitForTimeout(700);
    }
  }

  // 隐藏右下角满意度评分卡片与佳同「弹框已恢复」圆标（仅前端隐藏，不改数据）
  async function hideNuisance() {
    await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      for (const needle of ["满意度评分", "弹框已恢复"]) {
        const els = [...document.querySelectorAll("div")].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 60 && r.height > 24 && norm(e.textContent).includes(needle);
        }).sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
        if (!els.length) continue;
        let n = els[0];
        let best = n;
        for (let k = 0; k < 8 && n.parentElement; k++) {
          n = n.parentElement;
          const r = n.getBoundingClientRect();
          if (r.width > 700) break;
          best = n;
          if (getComputedStyle(n).position === "fixed") break;
        }
        try { best.style.display = "none"; } catch (e) {}
      }
    });
  }

  // ---------- 基础操作 ----------
  async function findItemPt(label, { input = true, index = 0 } = {}) {
    return await p1.evaluate(({ label, input, index }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
      if (!it) return { err: "no_item" };
      const els = input ? [...it.querySelectorAll("input,textarea")] : [...it.querySelectorAll('[class*=ST_outerWrapper]')];
      const el = els.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !x.disabled; })[index];
      if (!el) return { err: "no_el" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, { label, input, index });
  }

  async function focusItemInput(label, { index = 0 } = {}) {
    return await p1.evaluate(({ label, index }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
      if (!it) return { err: "no_item" };
      const inputs = [...it.querySelectorAll("input,textarea")].filter((x) => {
        const r = x.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !x.disabled;
      });
      const el = inputs[index];
      if (!el) return { err: "no_input", n: inputs.length };
      el.scrollIntoView({ block: "center" });
      el.focus();
      try { el.setSelectionRange(0, (el.value || "").length); } catch (e) {}
      return { ok: true };
    }, { label, index });
  }

  async function readItemValue(label, { index = 0 } = {}) {
    return await p1.evaluate(({ label, index }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
      if (!it) return null;
      const inputs = [...it.querySelectorAll("input,textarea")].filter((x) => x.getBoundingClientRect().width > 0);
      return inputs[index] ? inputs[index].value : null;
    }, { label, index });
  }

  async function fillItem(label, value) {
    const f = await focusItemInput(label, { index: 0 });
    if (f.err) return f;
    await p1.keyboard.insertText(String(value));
    await p1.waitForTimeout(250);
    await p1.keyboard.press("Tab");
    await p1.waitForTimeout(400);
    const v = await readItemValue(label, { index: 0 });
    return { label, value: v, ok: v === String(value) };
  }

  // 在任意容器内按文本找可点元素（坐标）
  async function pointOfText(scopeSel, text, { exact = true } = {}) {
    return await p1.evaluate(({ scopeSel, text, exact }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const roots = scopeSel ? [...document.querySelectorAll(scopeSel)].filter((e) => e.getBoundingClientRect().width > 0) : [document];
      const root = roots[roots.length - 1] || document;
      const els = [...root.querySelectorAll("div,span,button,a,label")].filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = norm(e.textContent);
        return exact ? t === text : t.includes(text);
      });
      els.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const el = els[0];
      if (!el) return { err: "no_text" };
      el.scrollIntoView({ block: "center" });
      return { ok: true };
    }, { scopeSel, text, exact });
  }

  async function clickBtnIn(scopeSel, text) {
    for (let a = 0; a < 3; a++) {
      const s1 = await p1.evaluate(({ scopeSel, text }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const roots = scopeSel ? [...document.querySelectorAll(scopeSel)].filter((e) => e.getBoundingClientRect().width > 0) : [document];
        const root = roots[roots.length - 1] || document;
        const b = [...root.querySelectorAll("button")].find((x) => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && norm(x.textContent) === text;
        });
        if (!b) return { err: "no_btn" };
        b.scrollIntoView({ block: "center" });
        return { ok: true };
      }, { scopeSel, text });
      if (s1.err) return s1;
      await p1.waitForTimeout(350);
      const s2 = await p1.evaluate(({ scopeSel, text }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const roots = scopeSel ? [...document.querySelectorAll(scopeSel)].filter((e) => e.getBoundingClientRect().width > 0) : [document];
        const root = roots[roots.length - 1] || document;
        const b = [...root.querySelectorAll("button")].find((x) => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && norm(x.textContent) === text;
        });
        if (!b) return { err: "no_btn2" };
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, { scopeSel, text });
      if (s2.err) return s2;
      await p1.mouse.click(s2.x, s2.y);
      return { ok: true, x: s2.x, y: s2.y };
    }
    return { err: "click_fail" };
  }

  // 打开下拉并选选项：opener 返回选择器 wrapper 的坐标
  async function pickOption(openerFn, option, { prefix = false } = {}) {
    for (let a = 0; a < 4; a++) {
      await esc();
      await clearObstructions();
      const pt = await openerFn();
      if (!pt || pt.err) return pt;
      if (!pt.dom) await p1.mouse.click(pt.x, pt.y);
      await p1.waitForTimeout(900);
      const has = await p1.evaluate(({ option, prefix }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const els = [...document.querySelectorAll('[class*=cIL_item], li, [role=option]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const m = els.map((e) => ({ e, t: norm(e.textContent) }))
          .filter((x) => (prefix ? x.t.startsWith(option) : x.t === option));
        if (!m.length) return { err: "no_opt" };
        m.sort((x, y) => x.t.length - y.t.length);
        m[0].e.scrollIntoView({ block: "center" });
        return { ok: true };
      }, { option, prefix });
      if (has.err) { await esc(); continue; }
      await p1.waitForTimeout(450);
      const o = await p1.evaluate(({ option, prefix }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const els = [...document.querySelectorAll('[class*=cIL_item], li, [role=option]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const m = els.map((e) => ({ e, t: norm(e.textContent) }))
          .filter((x) => (prefix ? x.t.startsWith(option) : x.t === option));
        if (!m.length) return { err: "no_opt2" };
        m.sort((x, y) => x.t.length - y.t.length);
        const r = m[0].e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, { option, prefix });
      if (o.err) { await esc(); continue; }
      await p1.mouse.click(o.x, o.y);
      await p1.waitForTimeout(700);
      return { ok: true };
    }
    return { err: "pick_fail", option };
  }

  // 属性项下拉（多选/单选都点内部 input，多选 wrapper 中心点不展开）
  async function pickProp(prefixText, option, { starts = true } = {}) {
    // 已选则跳过（重复点击已选项会把值取消）
    const already = await p1.evaluate(({ prefixText, option }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const props = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")].filter((e) => e.getBoundingClientRect().width > 0);
      const p = props.find((e) => norm(e.textContent).startsWith(prefixText) || norm(e.textContent).includes(prefixText));
      if (!p) return false;
      const t = norm(p.textContent);
      // 显示值 = 首个拉丁字母前的部分（纸Paper→纸，3层3-ply→3层）
      const display = (option.match(/^[^A-Za-z]+/) || [option])[0].trim();
      return t.includes(option) || (display.length >= 1 && t.includes(display));
    }, { prefixText, option });
    if (already) return { ok: true, skipped: true };
    return await pickOption(async () => {
      const s1 = await p1.evaluate((prefixText) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const props = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")].filter((e) => e.getBoundingClientRect().width > 0);
        const p = props.find((e) => norm(e.textContent).startsWith(prefixText) || norm(e.textContent).includes(prefixText));
        if (!p) return { err: "no_prop" };
        const sel = p.querySelector('[class*=ST_outerWrapper]');
        if (!sel) return { err: "no_sel" };
        sel.scrollIntoView({ block: "center" });
        return { ok: true };
      }, prefixText);
      if (s1.err) return s1;
      await p1.waitForTimeout(400);
      return await p1.evaluate((prefixText) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const props = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")].filter((e) => e.getBoundingClientRect().width > 0);
        const p = props.find((e) => norm(e.textContent).startsWith(prefixText) || norm(e.textContent).includes(prefixText));
        const sel = p.querySelector('[class*=ST_outerWrapper]');
        const inp = sel.querySelector("input") || sel;
        const r = inp.getBoundingClientRect();
        try { inp.focus(); } catch (e) {}
        inp.click();
        return { x: Math.round(r.x + Math.min(r.width / 2, 80)), y: Math.round(r.y + r.height / 2), dom: true };
      }, prefixText);
    }, option, { prefix: starts });
  }

  async function propText(prefixText) {
    return await p1.evaluate((prefixText) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const props = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")].filter((e) => e.getBoundingClientRect().width > 0);
      const p = props.find((e) => norm(e.textContent).startsWith(prefixText) || norm(e.textContent).includes(prefixText));
      return p ? norm(p.textContent) : null;
    }, prefixText);
  }

  async function clickRadio(text) {
    for (let a = 0; a < 3; a++) {
      const s1 = await p1.evaluate((text) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const l = [...document.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        if (!l) return { err: "no_label" };
        l.scrollIntoView({ block: "center" });
        return { ok: true };
      }, text);
      if (s1.err) return s1;
      await p1.waitForTimeout(350);
      const s2 = await p1.evaluate((text) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const l = [...document.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        const r = l.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, text);
      await p1.mouse.click(s2.x, s2.y);
      await p1.waitForTimeout(450);
      const chk = await p1.evaluate((text) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const l = [...document.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        return l ? l.getAttribute("data-checked") : null;
      }, text);
      if (chk === "true") return { ok: true };
    }
    return { err: "radio_fail", text };
  }

  function tableRowsExpr() {}

  // ---------- 步骤 0：新建草稿 ----------
  async function createDraft() {
    step("create-draft");
    await p1.goto("https://agentseller.temu.com/goods/create/category");
    await p1.waitForTimeout(5000);
    const f = await p1.evaluate(() => {
      const inp = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("搜索分类") && i.getBoundingClientRect().width > 0);
      if (!inp) return { err: "no_input" };
      inp.scrollIntoView({ block: "center" });
      inp.focus();
      return { ok: true };
    });
    if (f.err) throw new Error("category input not found");
    await p1.keyboard.insertText("派对餐巾");
    let r = { err: "no_option" };
    for (let a = 0; a < 12; a++) {
      await p1.waitForTimeout(800);
      r = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll(".category_searchOptionItem__SZLlw")].find((e) => norm(e.textContent) === "家居、厨房用品>活动和派对用品>派对餐具>派对餐巾");
        if (!el) return { err: "no_option" };
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!r.err) break;
    }
    if (r.err) throw new Error("category option not found");
    await p1.mouse.click(r.x, r.y);
    await p1.waitForTimeout(1200);
    await p1.keyboard.press("Escape").catch(() => {});
    await dismissPriceAdjustOverlay();
    await p1.waitForTimeout(300);
    const nx = await clickBtnIn(null, "下一步");
    if (nx.err) throw new Error("next button not found");
    await p1.waitForTimeout(6000);
    const url = await p1.evaluate(() => location.href);
    const m = url.match(/productDraftId=(\d+)/);
    if (!m) throw new Error("draft url missing: " + url);
    return m[1];
  }

  // ---------- 步骤 1：名称/产地 ----------
  async function fillNamesOrigin() {
    step("names");
    await clearObstructions();
    const n1 = await fillItem("商品名称", cnName());
    if (!n1.ok) throw new Error("cn name failed");
    const n2 = await fillItem("英文名称", enName());
    if (!n2.ok) throw new Error("en name failed");
    step("origin");
    const originNow = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "").startsWith("商品产地"));
      return it ? norm(it.textContent) : "";
    });
    const country = originNow.includes("中国大陆")
      ? { ok: true, skipped: true }
      : await pickOption(async () => {
      const s1 = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "").startsWith("商品产地"));
        const sel = it.querySelector('[class*=ST_outerWrapper]');
        sel.scrollIntoView({ block: "center" });
        return { ok: true };
      });
      if (s1.err) return s1;
      await p1.waitForTimeout(400);
      return await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "").startsWith("商品产地"));
        const sel = it.querySelector('[class*=ST_outerWrapper]');
        const r = sel.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
    }, "中国大陆");
    if (country.err) throw new Error("country failed");
    await p1.waitForTimeout(800);
    // 省份
    const provPt = await p1.evaluate(() => {
      const inp = [...document.querySelectorAll("input")].find((i) => i.placeholder === "请选择省份" && i.getBoundingClientRect().width > 0);
      if (!inp) return { err: "no_input" };
      if ((inp.value || "").includes("浙江省")) return { err: "already" };
      inp.scrollIntoView({ block: "center" });
      const r = inp.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!provPt.err) {
      await p1.mouse.click(provPt.x, provPt.y);
      await p1.waitForTimeout(500);
      await p1.keyboard.insertText("浙江");
      await p1.waitForTimeout(1000);
      const zp = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const el = [...document.querySelectorAll('[class*=cIL_item]')].find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && norm(e.textContent) === "浙江省";
        });
        if (!el) return { err: "no_zj" };
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!zp.err) { await p1.mouse.click(zp.x, zp.y); await p1.waitForTimeout(700); }
    }
  }

  // ---------- 步骤 2：属性 ----------
  async function fillAttributes() {
    step("attributes");
    await clearObstructions();
    const r1 = await pickProp("材料Material", "纸Paper", { starts: true });
    if (!r1.ok) throw new Error("material failed");
    await esc();
    for (const occ of cfg.occasions) {
      const r = await pickProp("场合Occasion", occ, { starts: true });
      if (!r.ok) warn({ occ, r });
      await esc();
    }
    let hol = await pickProp("节假日Holidays", cfg.holiday, { starts: true });
    if (!hol.ok) {
      await esc();
      hol = await pickProp("节假日Holidays", "通用", { starts: true });
    }
    await esc();
    const r4 = await pickProp("铺层Ply", "3层", { starts: true });
    if (!r4.ok) throw new Error("ply failed");
    await esc();
    const r5 = await pickProp("主题Theme", "其他主题", { starts: true });
    if (!r5.ok) throw new Error("theme failed");
    await esc();
    const r6 = await pickProp("语言类型Language Type", "英语", { starts: true });
    if (!r6.ok) warn({ lang: r6 });
    await esc();
    const r7 = await pickProp("与食品接触部位材质Food Contact Material", "纸Paper", { starts: true });
    if (!r7.ok) warn({ food: r7 });
    await esc();
  }

  // ---------- 步骤 3：轮播图 ----------
  async function uploadCarousel() {
    step("carousel");
    await clearObstructions();
    const carouselHave = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品轮播图");
      return it ? [...it.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length : 0;
    });
    if (carouselHave >= 5) { warn({ carousel: "skip, already " + carouselHave }); return; }
    // 若素材弹窗已打开（重跑场景），先取消以重置选择状态
    const preCancel = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll("div")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 800 && r.height > 400 && norm(e.textContent).includes("All Materials") && norm(e.textContent).includes("已选");
      }).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
      if (!d) return { err: "none" };
      const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "取消" && x.getBoundingClientRect().width > 0);
      if (!b) return { err: "no_btn" };
      b.click();
      return { ok: true };
    });
    if (preCancel.ok) await p1.waitForTimeout(900);
    // 打开素材中心（DOM click，绕开插件浮层/消息面板遮挡）
    const open = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品轮播图");
      if (!it) return { err: "no_item" };
      const wrap = [...it.querySelectorAll(".upload-trigger_wrap__kMsdx")].find((e) => e.getBoundingClientRect().width > 0);
      if (!wrap) return { err: "no_wrap" };
      wrap.scrollIntoView({ block: "center" });
      wrap.click();
      return { ok: true };
    });
    if (open.err) throw new Error("carousel trigger missing: " + open.err);
    await p1.waitForTimeout(2200);

    // 标记素材中心弹窗根节点（本版弹窗无 role=dialog，用 All Materials 定位）
    const markDlg = async () => await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const leaf = [...document.querySelectorAll("div,span")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(e.textContent).includes("All Materials") && norm(e.textContent).length < 300;
      });
      if (!leaf) return { err: "no_leaf" };
      let box = leaf;
      for (let k = 0; k < 15 && box.parentElement; k++) {
        box = box.parentElement;
        const t = norm(box.textContent);
        if (t.includes("本地上传") && t.includes("确认") && t.includes("已选")) break;
      }
      const r = box.getBoundingClientRect();
      if (r.width < 600) return { err: "too_small" };
      box.setAttribute("data-ego-matdlg", "1");
      return { ok: true, w: Math.round(r.width) };
    });
    const dlg = await markDlg();
    if (dlg.err) throw new Error("material dialog missing: " + dlg.err);

    // 上传 5 张（直接 setInputFiles，绝不点「本地上传」）
    const markInput = await p1.evaluate(() => {
      const d = document.querySelector('[data-ego-matdlg="1"]');
      if (!d) return { err: "no_dlg" };
      const i = d.querySelector('input[type=file]');
      if (!i) return { err: "no_input" };
      i.setAttribute("data-ego-upload", "carousel");
      return { ok: true };
    });
    if (markInput.err) throw new Error("material file input missing: " + markInput.err);
    await p1.setInputFiles('[data-ego-upload="carousel"]', cfg.carousel);
    await p1.waitForTimeout(3000);

    // 等上传完成：轮询首张素材名出现在弹窗内
    let uploaded = false;
    for (let k = 0; k < 30; k++) {
      uploaded = await p1.evaluate((stem) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = document.querySelector('[data-ego-matdlg="1"]');
        return d ? norm(d.textContent).includes(stem) : false;
      }, cfg.carouselStems[0]);
      if (uploaded) break;
      await p1.waitForTimeout(2000);
    }
    if (!uploaded) warn({ carousel: "upload not confirmed in list" });

    // 若出现素材去重弹窗，关闭
    await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll("div")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(e.textContent).includes("无需重复上传") && norm(e.textContent).length < 300;
      })[0];
      if (!d) return;
      let box = d;
      for (let k = 0; k < 8 && box.parentElement; k++) {
        const b = [...box.querySelectorAll("button")].find((x) => norm(x.textContent) === "关闭");
        if (b) { b.click(); return; }
        box = box.parentElement;
      }
    });
    await p1.waitForTimeout(800);

    // 重新标记弹窗（列表刷新可能重建节点）
    const dlg2 = await markDlg();
    if (dlg2.err) throw new Error("material dialog lost: " + dlg2.err);

    // 清空弹窗里遗留的选中项（上一个商品的选择可能残留）
    const cleared = await p1.evaluate(() => {
      const d = document.querySelector('[data-ego-matdlg="1"]');
      if (!d) return { err: "no_dlg" };
      const cards = [...d.querySelectorAll('[class*="index-module_checked__"]')].filter((e) => {
        return /cardContainer/.test(String(e.className)) && e.getBoundingClientRect().width > 20;
      });
      cards.forEach((c) => c.click());
      return { ok: true, n: cards.length };
    });
    if (cleared.n) warn({ carousel: "cleared leftover selections", n: cleared.n });
    await p1.waitForTimeout(800);

    // 滚动素材列表回顶
    await p1.evaluate(() => {
      const d = document.querySelector('[data-ego-matdlg="1"]');
      if (!d) return;
      [...d.querySelectorAll("div")].filter((el) => el.scrollHeight > el.clientHeight + 100).forEach((c) => { c.scrollTop = 0; });
    });
    await p1.waitForTimeout(800);

    // 每个素材：搜索定位 → 检查选中态 → 只在未选中时点击 → 复核
    async function searchStem(stem) {
      const pt = await p1.evaluate(() => {
        const d = document.querySelector('[data-ego-matdlg="1"]');
        const inp = d ? [...d.querySelectorAll("input")].find((i) => (i.placeholder || "") === "请输入素材名称" && i.getBoundingClientRect().width > 0) : null;
        if (!inp) return { err: "no_search" };
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        inp.setSelectionRange(0, (inp.value || "").length);
        const r = inp.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (pt.err) return pt;
      await p1.mouse.click(pt.x, pt.y);
      await p1.waitForTimeout(250);
      await p1.keyboard.insertText(stem);
      await p1.waitForTimeout(300);
      await p1.keyboard.press("Enter");
      await p1.waitForTimeout(1800);
      return { ok: true };
    }

    async function cardState(stem) {
      return await p1.evaluate((stem) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = document.querySelector('[data-ego-matdlg="1"]');
        if (!d) return { err: "no_dlg" };
        const clean = (c) => norm(c.innerText).split("\n")[0].replace(/^\d+\s*/, "").replace(/\s*裁剪美化翻译\s*$/, "").trim();
        const c = [...d.querySelectorAll(".index-module_cardContainer__2K7qO")].filter((x) => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && clean(x) === stem;
        })[0];
        if (!c) return { found: false };
        const cover = c.querySelector(".index-module_cover__D3CAT") || c;
        const r = cover.getBoundingClientRect();
        return { found: true, checked: /index-module_checked__/.test(String(c.className)), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, stem);
    }

    async function pickOne(stem) {
      for (let a = 0; a < 4; a++) {
        await searchStem(stem);
        const st = await cardState(stem);
        if (st.err) return st;
        if (!st.found) { await p1.waitForTimeout(1500); continue; }
        if (st.checked) return { ok: true, already: true };
        await p1.mouse.click(st.x, st.y);
        await p1.waitForTimeout(700);
        const st2 = await cardState(stem);
        if (st2.found && st2.checked) return { ok: true };
        await p1.waitForTimeout(500);
      }
      return { err: "not_selected" };
    }

    for (const stem of cfg.carouselStems) {
      const r = await pickOne(stem);
      if (!r.ok) warn({ carousel: stem, err: r.err });
    }
    let okCount = 0;
    for (const stem of cfg.carouselStems) {
      await searchStem(stem);
      const st = await cardState(stem);
      if (st.found && st.checked) okCount++;
    }
    if (okCount !== 5) throw new Error(`carousel verified ${okCount}/5`);
    const cf = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = document.querySelector('[data-ego-matdlg="1"]');
      if (!d) return { err: "no_dlg" };
      const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "确认" && x.getBoundingClientRect().width > 0);
      if (!b) return { err: "no_btn" };
      b.click();
      return { ok: true };
    });
    if (cf.err) throw new Error("carousel confirm missing");
    await p1.waitForTimeout(3000);
    const n = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品轮播图");
      return it ? [...it.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length : 0;
    });
    if (n < 5) throw new Error(`carousel images ${n}`);
  }

  // ---------- 步骤 4：规格 ----------
  async function fillSpecs() {
    step("specs");
    await clearObstructions();
    const skuExists = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
      return t ? [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0).length : 0;
    });
    if (skuExists >= 4) { warn({ specs: "skip, sku table exists" }); return; }
    // 父规格1 = 尺码
    const r1 = await pickOption(async () => {
      const s1 = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
        const sel = it.querySelector('[class*=ST_outerWrapper]');
        sel.scrollIntoView({ block: "center" });
        return { ok: true };
      });
      if (s1.err) return s1;
      await p1.waitForTimeout(450);
      return await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
        const sel = it.querySelector('[class*=ST_outerWrapper]');
        const r = sel.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
    }, "尺码");
    if (r1.err) throw new Error("parent spec1 failed");

    // 尺码值
    const vf = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
      const inp = [...it.querySelectorAll("input")].find((i) => (i.placeholder || "") === "请输入" && i.getBoundingClientRect().width > 0);
      if (!inp) return { err: "no_input" };
      inp.scrollIntoView({ block: "center" });
      inp.focus();
      return { ok: true };
    });
    if (vf.err) throw new Error("size value input missing");
    await p1.keyboard.insertText("23cm×23cm");
    await p1.waitForTimeout(250);
    await p1.keyboard.press("Enter");
    await p1.keyboard.press("Tab");
    await p1.waitForTimeout(700);

    // 添加父规格 2
    const add2 = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const el = [...document.querySelectorAll("button,div,span,a")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(e.textContent) === "添加父规格 2";
      }).sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      })[0];
      if (!el) return { err: "no_btn" };
      el.click();
      return { ok: true };
    });
    if (add2.err) throw new Error("add spec2 failed");
    await p1.waitForTimeout(900);

    // 父规格2 = 数量
    const r2 = await pickOption(async () => {
      const s1 = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
        const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')].filter((s) => s.getBoundingClientRect().width > 0);
        const sel = sels[sels.length - 1];
        sel.scrollIntoView({ block: "center" });
        return { ok: true };
      });
      if (s1.err) return s1;
      await p1.waitForTimeout(450);
      return await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
        const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')].filter((s) => s.getBoundingClientRect().width > 0);
        const sel = sels[sels.length - 1];
        const r = sel.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
    }, "数量");
    if (r2.err) throw new Error("parent spec2 failed");

    // 数量值 + 继续添加
    const qtys = cfg.ladder.map((x) => `${x.qty}pcs/set`);
    for (let i = 0; i < qtys.length; i++) {
      if (i > 0) {
        const add = await p1.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
          const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
          const btns = [...it.querySelectorAll("button")].filter((b) => norm(b.textContent) === "+ 继续添加子规格");
          const btn = btns[btns.length - 1];
          if (!btn) return { err: "no_btn" };
          btn.click();
          return { ok: true };
        });
        if (add.err) throw new Error("add sub spec failed at " + i);
        await p1.waitForTimeout(900);
      }
      const f = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品规格");
        const ins = [...it.querySelectorAll("input")].filter((i) => i.getBoundingClientRect().width > 0 && (i.placeholder || "") === "请输入" && i.value === "");
        const inp = ins[ins.length - 1];
        if (!inp) return { err: "no_empty" };
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        return { ok: true };
      });
      if (f.err) throw new Error("qty input missing at " + i);
      await p1.keyboard.insertText(qtys[i]);
      await p1.waitForTimeout(250);
      await p1.keyboard.press("Enter");
      await p1.waitForTimeout(250);
      await p1.keyboard.press("Tab");
      await p1.waitForTimeout(500);
    }
    const skuRows = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
      return t ? [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0).length : 0;
    });
    if (skuRows !== 4) throw new Error("sku rows " + skuRows);
  }

  // ---------- 步骤 5：SKU 表 ----------
  async function fillSkuTable() {
    step("sku-table");
    await clearObstructions();
    const cellsOf = (ri) => (ri === 0 ? { p: 2, pv: 3, cls: 4, ret: 5 } : { p: 1, pv: 2, cls: 3, ret: 4 });

    // 申报价
    for (let ri = 0; ri < 4; ri++) {
      const f = await p1.evaluate(({ ri, price }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cells = [...tr.querySelectorAll("td")];
        const cell = (() => { const pi = cells.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? cells[pi] : cells[ri === 0 ? 2 : 1]; })();
        const inp = cell.querySelector("input");
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        inp.setSelectionRange(0, (inp.value || "").length);
        return { ok: true };
      }, { ri, price: cfg.ladder[ri].declared });
      if (f.err) throw new Error("price input missing row " + ri);
      await p1.keyboard.insertText(String(cfg.ladder[ri].declared));
      await p1.waitForTimeout(200);
      await p1.keyboard.press("Tab");
      await p1.waitForTimeout(300);
    }

    // 分类
    for (let ri = 0; ri < 4; ri++) {
      const qty = cfg.ladder[ri].qty;
      const open = async () => {
        const s1 = await p1.evaluate((ri) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
          const sel = cell.querySelector('[class*=ST_outerWrapper]');
          sel.scrollIntoView({ block: "center" });
          return { ok: true };
        }, ri);
        if (s1.err) return s1;
        await p1.waitForTimeout(450);
        return await p1.evaluate((ri) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
          const sel = cell.querySelector('[class*=ST_outerWrapper]');
          const r = sel.getBoundingClientRect();
          sel.click();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
        }, ri);
      };
      const classified = await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
        return norm(cell.textContent).includes("同款多件装");
      }, ri);
      const cls = classified ? { ok: true, skipped: true } : await pickOption(open, "同款多件装", { prefix: true });
      if (!cls.ok) throw new Error("classification failed row " + ri);
      // 数量 / 包装 / 共计
      for (const which of ["qty", "contain"]) {
        const f = await p1.evaluate(({ ri, which }) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
          const ins = [...cell.querySelectorAll("input")].filter((i) => i.getBoundingClientRect().width > 0 && (i.placeholder || "") === "请输入");
          const inp = which === "qty" ? ins[0] : ins[ins.length - 1];
          if (!inp) return { err: "no_input" };
          inp.scrollIntoView({ block: "center" });
          inp.focus();
          inp.setSelectionRange(0, (inp.value || "").length);
          return { ok: true };
        }, { ri, which });
        if (f.err) throw new Error(`${which} input missing row ${ri}`);
        await p1.keyboard.insertText(String(qty));
        await p1.waitForTimeout(200);
        await p1.keyboard.press("Tab");
        await p1.waitForTimeout(300);
        if (which === "qty") {
          // 独立包装
          let done = await p1.evaluate((ri) => {
            const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
            const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
            const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
            const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
            return norm(cell.textContent).includes("不是独立包装");
          }, ri);
          for (let a = 0; a < 4 && !done; a++) {
            const pt = await p1.evaluate((ri) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
              const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
              const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
              const inp = [...cell.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("独立包装") && i.getBoundingClientRect().width > 0);
              if (!inp) return { err: "no_sel" };
              inp.scrollIntoView({ block: "center" });
              return { ok: true };
            }, ri);
            if (pt.err) break;
            await p1.waitForTimeout(450);
            const pt2 = await p1.evaluate((ri) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
              const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
              const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
              const inp = [...cell.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("独立包装") && i.getBoundingClientRect().width > 0);
              const r = inp.getBoundingClientRect();
              try { inp.focus(); } catch (e) {}
              inp.click();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
            }, ri);
            if (!pt2.dom) await p1.mouse.click(pt2.x, pt2.y);
            await p1.waitForTimeout(900);
            const opt = await p1.evaluate(() => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const els = [...document.querySelectorAll('[class*=cIL_item], li, [role=option]')].filter((e) => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && norm(e.textContent) === "不是独立包装";
              });
              if (!els.length) return { err: "no_opt" };
              const r = els[0].getBoundingClientRect();
              els[0].click();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
            });
            if (opt.err) { await esc(); continue; }
            if (!opt.dom) await p1.mouse.click(opt.x, opt.y);
            await p1.waitForTimeout(700);
            const v = await p1.evaluate((ri) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
              const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
              const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 2] : tds[ri === 0 ? 4 : 3]; })();
              return [...cell.querySelectorAll("input")].map((i) => i.value);
            }, ri);
            done = v.includes("不是独立包装");
          }
          if (!done) warn({ packaging: "not set", row: ri });
        }
      }
    }

    // 建议零售价 + 单位 USD
    for (let ri = 0; ri < 4; ri++) {
      const f = await p1.evaluate(({ ri, price }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 3] : tds[ri === 0 ? 5 : 4]; })();
        const inp = [...cell.querySelectorAll("input")].find((i) => i.getBoundingClientRect().width > 0);
        if (!inp) return { err: "no_input" };
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        inp.setSelectionRange(0, (inp.value || "").length);
        return { ok: true };
      }, { ri, price: cfg.ladder[ri].retail });
      if (f.err) throw new Error("retail input missing row " + ri);
      await p1.keyboard.insertText(String(cfg.ladder[ri].retail));
      await p1.waitForTimeout(200);
      await p1.keyboard.press("Tab");
      await p1.waitForTimeout(350);
    }
    for (let ri = 0; ri < 4; ri++) {
      let ok = false;
      for (let a = 0; a < 4 && !ok; a++) {
        const s1 = await p1.evaluate((ri) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 3] : tds[ri === 0 ? 5 : 4]; })();
          const sel = cell.querySelector('[class*=ST_outerWrapper]');
          if (!sel) return { err: "no_sel" };
          sel.scrollIntoView({ block: "center" });
          return { ok: true };
        }, ri);
        if (s1.err) break;
        await p1.waitForTimeout(450);
        const s2 = await p1.evaluate((ri) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 3] : tds[ri === 0 ? 5 : 4]; })();
          const sel = cell.querySelector('[class*=ST_outerWrapper]');
          const r = sel.getBoundingClientRect();
          sel.click();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
        }, ri);
        if (!s2.dom) await p1.mouse.click(s2.x, s2.y);
        await p1.waitForTimeout(900);
        const opt = await p1.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const els = [...document.querySelectorAll('[class*=cIL_item], li, [role=option]')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && norm(e.textContent).startsWith("USD");
          });
          if (!els.length) return { err: "no_opt" };
          const r = els[0].getBoundingClientRect();
          els[0].click();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
        });
        if (opt.err) { await esc(); continue; }
        if (!opt.dom) await p1.mouse.click(opt.x, opt.y);
        await p1.waitForTimeout(700);
        const v = await p1.evaluate((ri) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
          const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 3] : tds[ri === 0 ? 5 : 4]; })();
          return norm(cell.textContent).slice(0, 30);
        }, ri);
        ok = v.includes("USD");
      }
      if (!ok) warn({ unit: "not set", row: ri });
    }

    // SKU 预览图（4 行）：每行打开素材中心 → 搜索白底图 → 选中 → 确认
    for (let ri = 0; ri < 4; ri++) {
      const hasPreview = await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 1] : tds[ri === 0 ? 3 : 2]; })();
        return [...cell.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length > 0;
      }, ri);
      if (hasPreview) { warn({ preview: "skip, already set", row: ri }); continue; }
      const open = await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 1] : tds[ri === 0 ? 3 : 2]; })();
        const el = [...cell.querySelectorAll("div, span, button")].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && norm(e.textContent) === "素材中心";
        }).sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
        if (!el) return { err: "no_btn" };
        el.scrollIntoView({ block: "center" });
        el.click();
        return { ok: true };
      }, ri);
      if (open.err) throw new Error("preview button missing row " + ri);
      await p1.waitForTimeout(2000);
      const dlg = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const leaf = [...document.querySelectorAll("div,span")].find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && norm(e.textContent).includes("All Materials") && norm(e.textContent).length < 300;
        });
        if (!leaf) return { err: "no_leaf" };
        let box = leaf;
        for (let k = 0; k < 15 && box.parentElement; k++) {
          box = box.parentElement;
          const t = norm(box.textContent);
          if (t.includes("本地上传") && t.includes("确认") && t.includes("已选")) break;
        }
        box.setAttribute("data-ego-matdlg", "1");
        return { ok: true };
      });
      if (dlg.err) throw new Error("preview dialog missing row " + ri);
      const sp = await p1.evaluate(() => {
        const d = document.querySelector('[data-ego-matdlg="1"]');
        const inp = d ? [...d.querySelectorAll("input")].find((i) => (i.placeholder || "") === "请输入素材名称" && i.getBoundingClientRect().width > 0) : null;
        if (!inp) return { err: "no_search" };
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        inp.setSelectionRange(0, (inp.value || "").length);
        const r = inp.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (sp.err) throw new Error("preview search missing row " + ri);
      await p1.mouse.click(sp.x, sp.y);
      await p1.waitForTimeout(250);
      await p1.keyboard.insertText(cfg.previewStem);
      await p1.waitForTimeout(300);
      await p1.keyboard.press("Enter");
      await p1.waitForTimeout(2200);
      const cardState = async () => await p1.evaluate((stem) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = document.querySelector('[data-ego-matdlg="1"]');
        if (!d) return { err: "no_dlg" };
        const clean = (c) => norm(c.innerText).split("\n")[0].replace(/^\d+\s*/, "").replace(/\s*裁剪美化翻译\s*$/, "").trim();
        const c = [...d.querySelectorAll(".index-module_cardContainer__2K7qO")].filter((x) => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && clean(x) === stem;
        })[0];
        if (!c) return { found: false };
        const cover = c.querySelector(".index-module_cover__D3CAT") || c;
        const r = cover.getBoundingClientRect();
        return { found: true, checked: /index-module_checked__/.test(String(c.className)), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, cfg.previewStem);
      let st = await cardState();
      for (let a = 0; a < 3 && (!st.found || !st.checked); a++) {
        if (!st.found) {
          // 素材中心搜索偶发未刷新：清空重搜一次
          await p1.mouse.click(sp.x, sp.y);
          await p1.waitForTimeout(200);
          await p1.keyboard.press("ControlOrMeta+A");
          await p1.keyboard.press("Backspace");
          await p1.keyboard.insertText(cfg.previewStem);
          await p1.keyboard.press("Enter");
          await p1.waitForTimeout(2200);
          st = await cardState();
        }
        if (st.found && !st.checked) {
          await p1.mouse.click(st.x, st.y);
          await p1.waitForTimeout(800);
          st = await cardState();
          if (st.found && !st.checked) {
            // 坐标点击未生效时，直接 DOM click 卡片封面兜底
            await p1.evaluate((stem) => {
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const d = document.querySelector('[data-ego-matdlg="1"]');
              if (!d) return;
              const clean = (c) => norm(c.innerText).split("\n")[0].replace(/^\d+\s*/, "").replace(/\s*裁剪美化翻译\s*$/, "").trim();
              const c = [...d.querySelectorAll(".index-module_cardContainer__2K7qO")].find(
                (x) => x.getBoundingClientRect().width > 0 && clean(x) === stem,
              );
              const cover = c && (c.querySelector(".index-module_cover__D3CAT") || c);
              if (cover && typeof cover.click === "function") cover.click();
            }, cfg.previewStem);
            await p1.waitForTimeout(800);
            st = await cardState();
          }
        }
      }
      if (!st.found || !st.checked) throw new Error(`preview select failed row ${ri}`);
      const cf = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = document.querySelector('[data-ego-matdlg="1"]');
        if (!d) return { err: "no_dlg" };
        const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "确认" && x.getBoundingClientRect().width > 0);
        if (!b) return { err: "no_btn" };
        b.click();
        return { ok: true };
      });
      if (cf.err) throw new Error("preview confirm missing row " + ri);
      await p1.waitForTimeout(1500);
      const got = await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const t = [...document.querySelectorAll("table")].filter((t) => t.getBoundingClientRect().width > 0 && norm(t.textContent).includes("申报价格"))[0];
        const tr = [...t.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const cell = (() => { const tds = [...tr.querySelectorAll("td")]; const pi = tds.findIndex((td) => td.textContent.trim().startsWith("￥")); return pi >= 0 ? tds[pi + 1] : tds[ri === 0 ? 3 : 2]; })();
        return [...cell.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length;
      }, ri);
      if (!got) warn({ preview: "no image", row: ri });
    }
  }

  // ---------- 步骤 6：包装 + 物流 ----------
  async function fillPackaging() {
    step("packaging");
    await clearObstructions();
    const pkgCount = async () => await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品包装信息");
      return it ? [...it.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length : 0;
    });
    const pkgHave = await pkgCount();
    if (pkgHave < 3) {
    const mark = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品包装信息");
      if (!it) return { err: "no_item" };
      const inp = it.querySelector('input[type="file"]');
      if (!inp) return { err: "no_input" };
      inp.setAttribute("data-upload-target", "pkg");
      return { ok: true };
    });
    if (mark.err) throw new Error("packaging input missing");
    await p1.setInputFiles('[data-upload-target="pkg"]', cfg.packaging);
    await p1.waitForTimeout(7000);
    await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll('[class*=MDL_outerWrapper]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && norm(e.textContent).includes("无需重复上传");
      }).pop();
      if (!d) return;
      const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "关闭");
      if (b) b.click();
    });
    await p1.waitForTimeout(500);
    const n = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "商品包装信息");
      return it ? [...it.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0).length : 0;
    });
    if (n < 3) throw new Error("packaging images " + n);
    }
    if (pkgHave >= 3) warn({ packaging: "skip upload, already " + pkgHave });
    const r1 = await clickTextInItem("商品包装信息", "硬包装");
    if (!r1.ok) throw new Error("hard packaging radio failed");
    const r2 = await clickTextInItem("商品包装信息", "长方体");
    if (!r2.ok) throw new Error("box shape radio failed");
  }

  async function clickTextInItem(label, text) {
    for (let a = 0; a < 3; a++) {
      const s1 = await p1.evaluate(({ label, text }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
        if (!it) return { err: "no_item" };
        const l = [...it.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        if (!l) return { err: "no_label" };
        l.scrollIntoView({ block: "center" });
        return { ok: true };
      }, { label, text });
      if (s1.err) return s1;
      await p1.waitForTimeout(350);
      const s2 = await p1.evaluate(({ label, text }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
        const l = [...it.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        const r = l.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, { label, text });
      await p1.mouse.click(s2.x, s2.y);
      await p1.waitForTimeout(450);
      const chk = await p1.evaluate(({ label, text }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === label);
        const l = [...it.querySelectorAll('label[data-testid="beast-core-radio"]')].find((l) => {
          const r = l.getBoundingClientRect();
          return r.width > 0 && norm(l.textContent) === text;
        });
        return l ? l.getAttribute("data-checked") : null;
      }, { label, text });
      if (chk === "true") return { ok: true };
    }
    return { err: "text_radio_fail" };
  }

  async function fillLogistics() {
    step("logistics");
    await clearObstructions();
    const numInputs = ["len", "wid", "hei", "weight", "net"];
    for (let ri = 0; ri < 4; ri++) {
      const row = cfg.ladder[ri];
      const vals = [row.len, row.wid, row.hei, row.weight, row.net];
      // 敏感属性 = 否（DOM click 展开，选项取与当前行垂直最近的「否」）
      const readNo = async () => await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "敏感属性与体积重量");
        const tr = [...it.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const sel = tr.querySelector('[class*=ST_outerWrapper]');
        if (!sel) return false;
        const inp = sel.querySelector("input");
        return Boolean((inp && (inp.value || "").includes("否")) || norm(sel.textContent).includes("否"));
      }, ri);
      const queryNo = async () => await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "敏感属性与体积重量");
        const tr = [...it.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const sel = tr.querySelector('[class*=ST_outerWrapper]');
        if (!sel) return { err: "no_sel" };
        const sr = sel.getBoundingClientRect();
        const cands = [...document.querySelectorAll('label[data-testid="beast-core-radio"]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && norm(e.textContent) === "否" && Math.abs(r.y - sr.y) < 360;
        }).map((e) => {
          const r = e.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dy: Math.abs(r.y - sr.y) };
        }).sort((a, b) => a.dy - b.dy);
        return cands[0] || { err: "no_opt" };
      }, ri);
      const openSel = async () => await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "敏感属性与体积重量");
        const tr = [...it.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const sel = tr.querySelector('[class*=ST_outerWrapper]');
        if (!sel) return { err: "no_sel" };
        sel.scrollIntoView({ block: "center" });
        sel.click();
        return { ok: true };
      }, ri);
      const rectSel = async () => await p1.evaluate((ri) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "敏感属性与体积重量");
        const tr = [...it.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
        const sel = tr.querySelector('[class*=ST_outerWrapper]');
        const r = sel.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, ri);
      let no = await readNo();
      for (let a = 0; a < 5 && !no; a++) {
        const open = await openSel();
        if (open.err) break;
        await p1.waitForTimeout(900);
        let opt = await queryNo();
        if (opt.err) {
          const pt = await rectSel();
          await p1.mouse.click(pt.x, pt.y);
          await p1.waitForTimeout(900);
          opt = await queryNo();
        }
        if (opt.err) { await esc(); continue; }
        await p1.mouse.click(opt.x, opt.y);
        await p1.waitForTimeout(700);
        await esc();
        no = await readNo();
      }
      if (!no) warn({ sensitive: "not set", row: ri });
      // 5 个数字
      for (let k = 0; k < 5; k++) {
        const f = await p1.evaluate(({ ri, k }) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
          const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "敏感属性与体积重量");
          const tr = [...it.querySelectorAll("tr")].filter((tr) => tr.getBoundingClientRect().height > 0)[ri];
          const ins = [...tr.querySelectorAll("input")].filter((i) => i.getBoundingClientRect().width > 0 && !i.closest("[class*=ST_outerWrapper]"));
          const inp = ins[k];
          if (!inp) return { err: "no_input", n: ins.length };
          inp.scrollIntoView({ block: "center" });
          inp.focus();
          inp.setSelectionRange(0, (inp.value || "").length);
          return { ok: true };
        }, { ri, k });
        if (f.err) { warn({ logistics: f.err, row: ri, k }); continue; }
        await p1.keyboard.insertText(String(vals[k]));
        await p1.waitForTimeout(150);
        await p1.keyboard.press("Tab");
        await p1.waitForTimeout(220);
      }
    }
  }

  // ---------- 步骤 7：定制工艺 + 组装 ----------
  async function fillCraft() {
    step("craft");
    const readCraft = async () => await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const labels = [...document.querySelectorAll('label[data-testid="beast-core-radio"]')].filter((l) => l.getBoundingClientRect().width > 0);
      const picked = (t) => { const l = labels.find((x) => norm(x.textContent) === t); return l ? l.getAttribute("data-checked") === "true" : false; };
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
      const tags = it ? [...it.querySelectorAll('[data-testid="beast-core-tagGroup-tag"]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => norm(e.textContent)) : [];
      const sels = it ? [...it.querySelectorAll('[class*=ST_outerWrapper]')] : [];
      const l1Val = sels[0] ? (([...sels[0].querySelectorAll("input")][0] || {}).value || "") : "";
      return { custom: picked("定制商品"), combo: picked("组合工艺"), tags, l1Val };
    });
    const pre = await readCraft();
    if (!pre.custom) {
      const r0 = await clickRadio("定制商品");
      if (!r0.ok) throw new Error("custom radio failed");
      await p1.waitForTimeout(700);
    }
    if (!pre.combo) {
      const r1 = await clickRadio("组合工艺");
      if (!r1.ok) throw new Error("combo radio failed");
      await p1.waitForTimeout(900);
    }
    const craftNow = await readCraft();
    const hasL1 = craftNow.l1Val.includes("画布/纸张定制工艺");
    if (!hasL1) {
    const c1 = await pickOption(async () => {
      const s1 = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
        const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')];
        sels[0].scrollIntoView({ block: "center" });
        return { ok: true };
      });
      if (s1.err) return s1;
      await p1.waitForTimeout(450);
      return await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
        const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
        const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')];
        const inp = sels[0].querySelector("input") || sels[0];
        const r = inp.getBoundingClientRect();
        try { inp.focus(); } catch (e) {}
        inp.click();
        return { x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + r.height / 2), dom: true };
      });
    }, "画布/纸张定制工艺", { prefix: true });
    if (!c1.ok) throw new Error("craft level1 failed");
    }
    for (const opt of ["丝网印刷-文字", "丝网印刷-图片"]) {
      if (craftNow.tags.includes(opt)) { continue; }
      let ok = false;
      for (let a = 0; a < 4 && !ok; a++) {
        const s1 = await p1.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
          const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
          const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')];
          sels[1].scrollIntoView({ block: "center" });
          return { ok: true };
        });
        await p1.waitForTimeout(450);
        const s2 = await p1.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
          const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
          const sels = [...it.querySelectorAll('[class*=ST_outerWrapper]')];
          const inp = sels[1].querySelector("input") || sels[1];
          const r = inp.getBoundingClientRect();
          try { inp.focus(); } catch (e) {}
          inp.click();
          return { x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + r.height / 2), dom: true };
        });
        if (!s2.dom) await p1.mouse.click(s2.x, s2.y);
        await p1.waitForTimeout(900);
        const o = await p1.evaluate((opt) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const els = [...document.querySelectorAll('[class*=cIL_item]')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && norm(e.textContent) === opt;
          });
          if (!els.length) return { err: "no_opt" };
          const r = els[0].getBoundingClientRect();
          els[0].click();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dom: true };
        }, opt);
        if (o.err) { await esc(); continue; }
        if (!o.dom) await p1.mouse.click(o.x, o.y);
        await p1.waitForTimeout(700);
        const v = await p1.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter((e) => e.getBoundingClientRect().width > 0);
          const it = items.find((x) => norm(x.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "") === "工艺类型");
          return norm(it.textContent);
        });
        ok = v.includes(opt);
      }
      if (!ok) warn({ craft: opt, ok: false });
    }
    await esc();
    let asm = await clickTextInItem("是否需要组装", "否");
    if (!asm.ok) asm = await clickRadio("否");
    if (!asm.ok) warn({ assembly: "not set" });
  }

  // ---------- 步骤 8：保存 + 创建 ----------
  async function visibleErrors() {
    return await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const out = new Set();
      for (const el of document.querySelectorAll("[class*=Form_itemError], [class*=error], [class*=invalid]")) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const t = norm(el.textContent);
        if (t && t.length < 200) out.add(t);
      }
      return [...out];
    });
  }

  async function saveCreate() {
    step("save");
    const errs = await visibleErrors();
    if (errs.length) warn({ preSave: errs });
    // 保存草稿
    const save = await clickBtnIn(null, "保存草稿");
    if (save.err) throw new Error("save button missing");
    await p1.waitForTimeout(5000);
    const d1 = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      return [...document.querySelectorAll('[role=dialog], [class*=MDL_outerWrapper]')].filter((e) => e.getBoundingClientRect().width > 0).map((d) => norm(d.textContent).slice(0, 120));
    });
    if (d1.some((t) => t.includes("保存成功"))) {
      const cf = await clickBtnIn('[role=dialog], [class*=MDL_outerWrapper]', "确认");
      if (!cf.err) await p1.waitForTimeout(1200);
    } else if (d1.length) {
      warn({ saveDialogs: d1 });
    }
    step("create");
    const create = await clickBtnIn(null, "创建");
    if (create.err) throw new Error("create button missing");
    await p1.waitForTimeout(4500);
    // 报关
    const customs = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll('[role=dialog], [class*=MDL_outerWrapper]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && norm(e.textContent).includes("平台报关");
      }).pop();
      if (!d) return { err: "no_dialog" };
      const opt = [...d.querySelectorAll("label, div")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && norm(e.textContent) === "餐巾";
      }).sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      })[0];
      if (!opt) return { err: "no_opt" };
      const r = opt.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (customs.err) {
      // 也许已直接创建
      warn({ customs: customs.err });
    } else {
      await p1.mouse.click(customs.x, customs.y);
      await p1.waitForTimeout(600);
      const cf = await clickBtnIn('[role=dialog], [class*=MDL_outerWrapper]', "确认");
      if (cf.err) throw new Error("customs confirm missing");
      await p1.waitForTimeout(5000);
    }
    // 合规声明
    const comp = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll('[role=dialog], [class*=MDL_outerWrapper]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && norm(e.textContent).includes("商品合规声明");
      }).pop();
      if (!d) return { err: "no_dialog" };
      const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "已阅读并同意");
      if (!b) return { err: "no_btn" };
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!comp.err) {
      await p1.mouse.click(comp.x, comp.y);
      await p1.waitForTimeout(7000);
    }
    // 成功 → 立即维护
    const succ = await p1.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const d = [...document.querySelectorAll('[role=dialog], [class*=MDL_outerWrapper]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && norm(e.textContent).includes("定制商品创建成功");
      }).pop();
      if (!d) return { err: "no_dialog" };
      const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "立即维护");
      if (!b) return { err: "no_btn" };
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (succ.err) throw new Error("create success dialog missing");
    await p1.mouse.click(succ.x, succ.y);
    await p1.waitForTimeout(7000);
    // 读 SKC/SKU
    let ids = { skc: null, skus: [], spu: null };
    for (let a = 0; a < 4; a++) {
      const got = await p1.evaluate(() => {
        const body = (document.body.innerText || "").replace(/\s+/g, " ");
        const skc = (body.match(/SKC ID：(\d+)/) || [])[1] || null;
        const skus = [...body.matchAll(/SKU ID：(\d+)/g)].map((m) => m[1]).slice(0, 6);
        const spu = (body.match(/productId=(\d+)/) || [])[1] || null;
        return { skc, skus, spu };
      });
      if (got.skc || got.skus.length) { ids = got; break; }
      await p1.waitForTimeout(2500);
    }
    // 兜底：抽屉没出来 → 到商品列表按 SPU 查询并抓 ID
    if (!ids.skc && result.draftId) {
      try {
        const did = String(result.draftId);
        await p1.goto(`https://agentseller.temu.com/goods/list?productId=${did}`);
        await p1.waitForTimeout(5000);
        await p1.evaluate((did) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const inp = [...document.querySelectorAll("input")].find((i) => i.getBoundingClientRect().width > 0 && /查询/.test(i.value || "") === false && (i.value || "") === did);
          const b = [...document.querySelectorAll("button")].find((x) => norm(x.textContent) === "查询" && x.getBoundingClientRect().width > 0);
          if (b) b.click();
        }, did);
        await p1.waitForTimeout(4000);
        ids = await p1.evaluate((did) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const all = [...document.querySelectorAll("tr")].filter((e) => e.getBoundingClientRect().height > 0);
          const i0 = all.findIndex((r) => norm(r.textContent).includes(did));
          if (i0 < 0) return { skc: null, skus: [], spu: did };
          const rowText = norm(all[i0].textContent);
          const skc = (rowText.match(/SKC ID[:：]?(\d{9,})/) || [])[1] || null;
          const group = [all[i0]];
          for (let i = i0 + 1; i < all.length; i++) {
            const t = norm(all[i].textContent);
            if (/SPU ID/.test(t)) break;
            if (/pcs\/set/.test(t)) group.push(all[i]);
          }
          const skus = group.map((r) => {
            const m = norm(r.textContent).match(/\d{12}/g) || [];
            return m.find((x) => x !== skc) || null;
          }).filter(Boolean);
          return { skc, skus, spu: did };
        }, did);
      } catch (e) { warn({ idFallback: String(e).slice(0, 120) }); }
    }
    // 关闭抽屉/待办
    for (let a = 0; a < 3; a++) {
      const todo = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = [...document.querySelectorAll('[class*=MDL_outerWrapper]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && norm(e.textContent).includes("待办任务");
        }).pop();
        if (!d) return { err: "none" };
        const x = d.querySelector('[class*=MDL_iconWrapper]') || d.querySelector('[class*=iconClose]');
        if (x) x.click();
        return { ok: true };
      });
      if (todo.ok) await p1.waitForTimeout(600);
      const drawer = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = [...document.querySelectorAll('[class*=Drawer_outerWrapper]')].filter((e) => e.getBoundingClientRect().width > 0).pop();
        if (!d) return { err: "none" };
        const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "取消");
        if (b) b.click();
        return { ok: true };
      });
      if (drawer.ok) await p1.waitForTimeout(1000);
      const conf = await p1.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const d = [...document.querySelectorAll('[class*=MDL_outerWrapper]')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && norm(e.textContent).includes("确认要退出");
        }).pop();
        if (!d) return { err: "none" };
        const b = [...d.querySelectorAll("button")].find((x) => norm(x.textContent) === "确认");
        if (b) b.click();
        return { ok: true };
      });
      if (conf.ok) await p1.waitForTimeout(1000);
    }
    return ids;
  }

  // ---------- 主流程 ----------
  const result = { idx: IDX, ok: false, draftId: null, skc: null, skus: [], error: null };
  try {
    await esc();
    await esc();
    await clearObstructions();
    // 若当前已在编辑页（中断重跑场景），复用该草稿继续填
    const cur = await p1.evaluate(() => location.href);
    let draftId = null;
    if (cur.includes("goods/edit") && cur.match(/productDraftId=(\d+)/)) {
      const curName = await readItemValue("商品名称");
      const same = !curName || curName.trim() === cnName() || curName.trim() === cfg.names.cn;
      if (same) draftId = cur.match(/productDraftId=(\d+)/)[1];
      else warn({ draft: "current draft belongs to another product, create new" });
    }
    if (!draftId) {
      draftId = await createDraft();
    }
    result.draftId = draftId;
    step("draft " + draftId);
    await fillNamesOrigin();
    await fillAttributes();
    await uploadCarousel();
    await fillSpecs();
    await fillSkuTable();
    await fillPackaging();
    await fillLogistics();
    await fillCraft();
    const ids = await saveCreate();
    result.skc = ids.skc || null;
    result.skus = ids.skus || [];
    result.ok = true;
  } catch (e) {
    result.error = String(e && e.message || e).slice(0, 300);
    try { await p1.screenshot({ path: `/Users/Admin/PycharmProjects/temu-agent-mac/logs/batch-fail-${IDX}.png` }); } catch (e2) {}
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  plog(`RESULT ${JSON.stringify(result)}`);
})()