// modules/listing/helpers.mjs — Agent 实时上新的原子操作（不是全自动脚本）
//
// 定位：只做“手和眼”——找元素、真实点击/输入、读错误/弹窗。业务判断（名称怎么改、
// 属性填什么、价格定多少）永远由 agent 现场推理，本模块不包含任何默认答案。
//
// 用法（ego-browser nodejs 脚本内，绝对路径 import）：
//   const h = await import("file:///Users/Admin/PycharmProjects/temu-agent-mac/modules/listing/helpers.mjs");
//
// 约定：所有函数接收 ego Page，返回 { ok, ... } 或 { err }。
// 红线：验证码不碰；用户接管浏览器时硬停；写操作前由 agent 按 skill 的检查点处理。

/** 在页面里找可见元素并返回中心坐标（精确文本默认取最内层元素）。 */
export async function findPoint(page, { selector = null, text = null, exact = true, tag = null, index = 0 } = {}) {
  return await page.evaluate(({ selector, text, exact, tag, index }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
    };
    const candidates = [...document.querySelectorAll(selector || "*")];
    const matches = [];
    for (const el of candidates) {
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) continue;
      if (!visible(el)) continue;
      if (text !== null) {
        const t = norm(el.textContent);
        if (exact ? t !== norm(text) : !t.includes(norm(text))) continue;
      }
      const r = el.getBoundingClientRect();
      matches.push({ el, r });
    }
    // 精确文本时优先最内层（面积最小），避免点到整块容器
    matches.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
    const m = matches[index];
    if (!m) return { err: "not_found", count: matches.length };
    m.el.scrollIntoView({ block: "center" });
    const rr = m.el.getBoundingClientRect();
    return {
      x: Math.round(rr.x + rr.width / 2),
      y: Math.round(rr.y + rr.height / 2),
      w: Math.round(rr.width),
      h: Math.round(rr.height),
      count: matches.length,
    };
  }, { selector, text, exact, tag, index });
}

/** 按坐标真实鼠标点击。 */
export async function clickPoint(page, pt, label = "点击") {
  if (!pt || pt.err) return pt || { err: "no_point" };
  await page.mouse.click(pt.x, pt.y, { label });
  return { ok: true, x: pt.x, y: pt.y };
}

/** 找到文本/选择器对应的可见元素并真实点击。 */
export async function clickText(page, text, { selector = null, exact = true, tag = null, index = 0, label = "点击" } = {}) {
  const pt = await findPoint(page, { selector, text, exact, tag, index });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label });
  return { ok: true, x: pt.x, y: pt.y, count: pt.count };
}

/**
 * 填 React 受控输入框：真实鼠标聚焦 + 真实键盘 insertText + 失焦/Enter 提交。
 * 关键：JS 直接 set value 不触发 React 状态（规格值/价格等会“有值但不生效”）。
 * selector 必须唯一命中目标 input/textarea。
 */
export async function setReactInput(page, selector, value, { pressEnter = false, blur = true, label = "填写输入框" } = {}) {
  const pt = await findPoint(page, { selector });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label });
  await page.waitForTimeout(150);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    const len = (el.value || "").length;
    try { el.setSelectionRange(0, len); } catch { if (el.select) el.select(); }
  }, selector);
  await page.keyboard.insertText(String(value));
  await page.waitForTimeout(120);
  if (pressEnter) await page.keyboard.press("Enter");
  if (blur) {
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
  }
  await page.waitForTimeout(300);
  const state = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false };
    return { ok: true, value: el.value ?? el.textContent ?? "" };
  }, selector);
  return { ok: state.ok, value: state.value, typed: String(value) };
}

/** 勾选/切换单选（beast-core-radio），返回是否真的 checked。 */
export async function selectRadio(page, text, { label = "选择单选" } = {}) {
  const pt = await findPoint(page, { selector: 'label[data-testid="beast-core-radio"]', text, exact: true });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label });
  await page.waitForTimeout(250);
  const checked = await page.evaluate((t) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('label[data-testid="beast-core-radio"]')]
      .filter((el) => norm(el.textContent) === norm(t))
      .map((el) => el.getAttribute("data-checked"));
  }, text);
  return { ok: checked.some((c) => c === "true"), checked };
}

/** 勾选复选框（beast-core-checkbox）。 */
export async function selectCheckbox(page, text, { label = "勾选复选框" } = {}) {
  const pt = await findPoint(page, { selector: 'label[data-testid="beast-core-checkbox"]', text, exact: false });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label });
  await page.waitForTimeout(200);
  const checked = await page.evaluate((t) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('label[data-testid="beast-core-checkbox"]')]
      .filter((el) => norm(el.textContent).includes(norm(t)))
      .map((el) => el.getAttribute("data-checked"));
  }, text);
  return { ok: checked.some((c) => c === "true"), checked };
}

/** 关掉多选标签（如节假日误加的项目）。 */
export async function closeTag(page, text, { label = "删除标签" } = {}) {
  const pt = await page.evaluate((t) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const tag = [...document.querySelectorAll('[data-testid="beast-core-tagGroup-tag"]')]
      .find((el) => norm(el.textContent) === norm(t) && el.getBoundingClientRect().width > 0);
    if (!tag) return { err: "tag_not_found" };
    const close = tag.querySelector('[data-testid="beast-core-tagGroup-iconClose"]')
      || tag.querySelector('[class*=iconClose]');
    if (!close) return { err: "close_not_found" };
    const r = close.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, text);
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label });
  await page.waitForTimeout(200);
  const left = await page.evaluate((t) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('[data-testid="beast-core-tagGroup-tag"]')]
      .filter((el) => norm(el.textContent) === norm(t) && el.getBoundingClientRect().width > 0).length;
  }, text);
  return { ok: left === 0, remaining: left };
}

/** 收集可见的校验错误文案（红字/error/invalid）。 */
export async function visibleErrors(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    const out = new Set();
    for (const el of document.querySelectorAll('[class*=error], [class*=Error], [class*=invalid], [class*=Invalid]')) {
      if (!visible(el)) continue;
      const t = (el.textContent || "").trim();
      if (t && t.length < 200) out.add(t);
    }
    return [...out];
  });
}

/** 收集可见弹窗标题与正文（判断成功/失败/待办）。 */
export async function visibleDialogs(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('[role=dialog], [class*=MDL_outerWrapper], [class*=Drawer_outerWrapper]')) {
      if (!visible(el)) continue;
      const t = (el.textContent || "").trim().slice(0, 400);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ cls: String(el.className).slice(0, 80), text: t });
    }
    return out;
  });
}

/** 等待任意可见错误/弹窗出现，返回观察结果（用于保存/提交后的判定）。 */
export async function waitForFeedback(page, { timeout = 5000, interval = 500 } = {}) {
  const start = Date.now();
  let last = { errors: [], dialogs: [] };
  while (Date.now() - start < timeout) {
    last = { errors: await visibleErrors(page), dialogs: await visibleDialogs(page) };
    if (last.errors.length || last.dialogs.length) return last;
    await page.waitForTimeout(interval);
  }
  return last;
}

/** 按表单项标签文本定位第 index 个可见输入框，返回坐标与当前值。 */
export async function formItemInput(page, labelIncludes, { index = 0 } = {}) {
  return await page.evaluate(({ labelIncludes, index }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    // 优先：精确标签 > 标签前缀 > 属性子项 > 文本包含（防止「商品规格」误中「商品素材图」）
    const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')];
    const labelOf = (el) => norm(el.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "");
    const exact = items.find((el) => labelOf(el) === norm(labelIncludes));
    const starts = items.find((el) => labelOf(el).startsWith(norm(labelIncludes)));
    const propItems = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")];
    const prop = propItems.find((el) => {
      const t = norm(el.textContent);
      return t.startsWith(norm(labelIncludes)) || t.includes(norm(labelIncludes));
    });
    const item = prop || exact || starts || items.find((el) => norm(el.textContent).includes(norm(labelIncludes)));
    if (!item) return { err: "item_not_found" };
    const inputs = [...item.querySelectorAll("input, textarea")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    });
    const el = inputs[index];
    if (!el) return { err: "input_not_found", count: inputs.length };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      value: el.value ?? "",
      count: inputs.length,
      tag: el.tagName,
    };
  }, { labelIncludes, index });
}

/** 在指定表单项的输入框里真实键盘输入（用于名称/价格等文本字段）。 */
export async function fillFormItem(page, labelIncludes, value, { index = 0, pressEnter = false, blur = true } = {}) {
  const pt = await formItemInput(page, labelIncludes, { index });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label: "聚焦字段" });
  await page.waitForTimeout(150);
  await page.evaluate(({ labelIncludes, index }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')];
    const labelOf = (el) => norm(el.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "");
    const exact = items.find((el) => labelOf(el) === norm(labelIncludes));
    const starts = items.find((el) => labelOf(el).startsWith(norm(labelIncludes)));
    const prop = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")]
      .find((el) => {
        const t = norm(el.textContent);
        return t.startsWith(norm(labelIncludes)) || t.includes(norm(labelIncludes));
      });
    const item = prop || exact || starts || items
      .find((el) => norm(el.textContent).includes(norm(labelIncludes)));
    const el = item && [...item.querySelectorAll("input, textarea")].filter((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !x.disabled;
    })[index];
    if (el) {
      el.focus();
      const len = (el.value || "").length;
      try { el.setSelectionRange(0, len); } catch { if (el.select) el.select(); }
    }
  }, { labelIncludes, index });
  await page.keyboard.insertText(String(value));
  await page.waitForTimeout(120);
  if (pressEnter) await page.keyboard.press("Enter");
  if (blur) {
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  }
  await page.waitForTimeout(300);
  const after = await formItemInput(page, labelIncludes, { index });
  return { ok: after.value === String(value) || (after.value || "").includes(String(value)), value: after.value, typed: String(value) };
}

/**
 * 在下拉类表单项里搜索并选择选项（单选/多选通用）。
 * searchText 用于过滤长列表；optionText 用包含匹配。
 * 多选时传 options 数组；选择后按 Escape 关闭。
 */
export async function selectFormOptions(page, labelIncludes, options, { index = 0, searchText = null, keepOpen = false } = {}) {
  const pt = await formItemInput(page, labelIncludes, { index });
  if (pt.err) return pt;
  await page.mouse.click(pt.x, pt.y, { label: "打开下拉" });
  await page.waitForTimeout(400);
  if (searchText) {
    await page.keyboard.insertText(String(searchText));
    await page.waitForTimeout(500);
  }
  const picked = [];
  for (const opt of options) {
    const o = await page.evaluate((text) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      // 只点选项行本身（li / role=option），不要点内部 span
      const els = [...document.querySelectorAll('li, [role=option]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const t = norm(el.textContent);
          return t.includes(norm(text)) && t.length < 80;
        });
      els.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const el = els[0];
      if (!el) return { err: "option_not_found" };
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (el.textContent || "").trim().slice(0, 60) };
    }, opt);
    if (o.err) { picked.push({ option: opt, err: o.err }); continue; }
    await page.mouse.click(o.x, o.y, { label: `选择 ${opt}` });
    await page.waitForTimeout(450);
    // 校验：tag 出现，或该表单项输入框值包含选项
    const ok = await page.evaluate(({ text, labelIncludes }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const tags = [...document.querySelectorAll('[data-testid="beast-core-tagGroup-tag"]')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => norm(el.textContent));
      if (tags.some((t) => t.includes(norm(text)))) return true;
      const items = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')];
      const labelOf = (el) => norm(el.querySelector(".Form_itemLabelContent_5-125-0")?.textContent || "");
      const exact = items.find((el) => labelOf(el) === norm(labelIncludes));
      const starts = items.find((el) => labelOf(el).startsWith(norm(labelIncludes)));
      const prop = [...document.querySelectorAll(".product-property_propertyItem__ebeQc")]
        .find((el) => {
          const t = norm(el.textContent);
          return t.startsWith(norm(labelIncludes)) || t.includes(norm(labelIncludes));
        });
      const item = prop || exact || starts || items
        .find((el) => norm(el.textContent).includes(norm(labelIncludes)));
      if (!item) return false;
      return [...item.querySelectorAll("input")].some((i) => norm(i.value).includes(norm(text)));
    }, { text: opt, labelIncludes });
    picked.push({ option: opt, ok, text: o.text });
  }
  if (!keepOpen) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
  return { ok: picked.every((p) => p.ok), picked };
}

/** 把本地文件塞进当前页面唯一可见的 file input。 */
export async function uploadFiles(page, paths, { selector = 'input[type="file"]' } = {}) {
  const inputs = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, accept: el.accept, multiple: el.multiple, disabled: el.disabled };
    });
  }, selector);
  if (!inputs.length) return { err: "no_file_input" };
  await page.setInputFiles(selector, paths);
  return { ok: true, inputs };
}