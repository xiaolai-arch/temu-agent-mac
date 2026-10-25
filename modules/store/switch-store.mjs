// modules/store/switch-store.mjs — 切店（多店铺账号切换，Mac/ego-browser 版）
// 用法: run switch-store <store-id> [--check | --doctor | --verify-all]
// 移植自 driver/switch_store.py。业务链路不变（2026-10-16 定稿）：
//   seller 登录（手机号+密码）→ [授权门过门] → 卖家主页侧边栏
//   「商品管理→定制商品内容」（href 带店铺上下文）→ 内嵌授权卡（勾协议→确认
//   授权并前往）→「确认切换」弹窗 → 定制商品页双按钮验证。
//   ⚠ redirectUrl 直航只刷授权不切身份，永远不作为切店手段。
// 感知层全部换语义快照+选择器：OCR/UIA/像素补丁（_enter_phone 偏移、蓝块
// 检测、像素勾选框、UIA 激活轮换）整体不需要。
// 退出码：0 成功 / 1 异常 / 2 需人工（验证码、账密错）/ 3 验证失败
// 红线：验证码绝不自动处理；凭据绝不打印（日志只出脱敏手机号）。

import path from "node:path";
import { readFile, writeFile, stat, unlink, mkdir } from "node:fs/promises";
import {
  CUSTOMIZE_URL, LOGIN_URL, REPO_ROOT, args, boot, clickButton, findRef, loadConfig,
  log, sleep, snapLines, shot, writeReport,
} from "../../lib/common.mjs";

const SELLER_MAIN_URL = "https://seller.kuajingmaihuo.com/site-main";
const LOCK_FILE = path.join(REPO_ROOT, "modules", "store", ".switch-lock");
const CAPTCHA_WORDS = ["滑块", "拖动", "拼图", "请输入验证码", "发送验证码"];
const AUTHFAIL_WORDS = ["密码错误", "不正确", "账号或密码", "失败"];

// ---------- 锁 / 配置 ----------

async function acquireLock() {
  try {
    const st = await stat(LOCK_FILE);
    if (Date.now() - st.mtimeMs < 15 * 60 * 1000) {
      throw new Error("已有另一个切店进程在运行（锁 modules/store/.switch-lock 未过期）；确认无并发后删除该文件或等 15 分钟");
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  await writeFile(LOCK_FILE, String(process.pid), "utf8");
}

async function releaseLock() {
  await unlink(LOCK_FILE).catch(() => {});
}

function maskPhone(p) {
  return `${p.slice(0, 3)}****${p.slice(-2)}`;
}

function normName(s) {
  return String(s || "").replace(/[\s№]/g, "").toLowerCase();
}

function nameEq(a, b) {
  return !!a && !!b && normName(a) === normName(b);
}

function credsOf(cfg, storeId) {
  const acc = cfg?.accounts?.[storeId];
  if (!acc?.phone || !acc?.password) return null;
  return { phone: String(acc.phone), password: String(acc.password), name: acc.name || null };
}

async function learnName(storeId, name) {
  if (!name) return;
  const p = path.join(REPO_ROOT, "local.config.json");
  try {
    const d = JSON.parse(await readFile(p, "utf8"));
    if (d.accounts?.[storeId] && d.accounts[storeId].name !== name) {
      d.accounts[storeId].name = name;
      await writeFile(p, JSON.stringify(d, null, 2), "utf8");
      log(`→ 已学习店名 ${storeId}=${name}（写入配置，下次严格校验）`);
    }
  } catch (e) {
    log(`⚠ 店名写入失败: ${e.message}`);
  }
}

// ---------- 页面状态探测 ----------

function detectBlock(text) {
  const t = text.replace(/\s+/g, "");
  if (t.includes("无法收到验证码")) {
    // 登录页固有链接，排除
  } else if (CAPTCHA_WORDS.some((k) => t.includes(k))) {
    return "captcha";
  }
  if (AUTHFAIL_WORDS.some((k) => t.includes(k))) return "authfail";
  return null;
}

/** 定制商品页验证：双按钮（插件注入慢，轮询）+ 账号名 + 是否卡授权门。 */
async function checkTarget(page) {
  await page.goto(CUSTOMIZE_URL, { timeout: 60000 });
  await page.waitForLoadState("load").catch(() => {});
  let lines = [];
  let b1 = false, b2 = false;
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 5000 : 3000);
    lines = await snapLines(page, "full_page");
    b1 = lines.some((l) => l.includes("按勾选同步"));
    b2 = lines.some((l) => l.includes("忆托ERP同步"));
    if (b1 && b2) break;
  }
  const url = await page.url();
  const text = lines.join("\n");
  const onAuth = url.includes("auth/authentication") || (!b1 && /中国地区|商家中心/.test(text));
  return { acc: findAccountName(text, await loadConfig()), b1, b2, onAuth, url, lines };
}

/** 当前账号名：从配置已知店名里找（DOM 文本精确，无需 OCR 归一化那套）。 */
function findAccountName(text, cfg) {
  if (cfg?.accounts) {
    for (const [sid, acc] of Object.entries(cfg.accounts)) {
      if (acc.name && text.includes(acc.name)) return acc.name;
    }
  }
  return null;
}

// ---------- 登录 ----------

async function ensurePhonePwdMode(page) {
  for (let i = 0; i < 4; i++) {
    const lines = await snapLines(page, "full_page");
    if (lines.some((l) => l.includes("+86"))) return true;
    // 登录 tab 是普通元素（非 button/a）——按文本找任意元素，真实鼠标点击
    const tab = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      for (const w of ["手机号登录", "密码登录"]) {
        const el = [...document.querySelectorAll("*")].find((e) =>
          e.children.length === 0 && norm(e.textContent) === w &&
          e.getBoundingClientRect().width > 0);
        if (el) {
          const r = el.getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2, w];
        }
      }
      return null;
    });
    if (tab) await page.mouse.click(tab[0], tab[1], { label: `点「${tab[2]}」` });
    await sleep(1800);
  }
  const lines = await snapLines(page);
  const ok = lines.some((l) => l.includes("+86"));
  if (!ok) log("⚠ 登录页未出现手机号表单（+86）");
  return ok;
}

async function fillLogin(page, phone, password) {
  // React 受控表单：fill 后回读验证；失败退键盘逐字
  const check = async () => await page.evaluate(() => ({
    u: (document.querySelector("#usernameId")?.value || "").length,
    p: (document.querySelector("#passwordId")?.value || "").length,
  }));
  let st = await check();
  if (st.u !== phone.length) {
    await page.fill("#usernameId", phone).catch(() => {});
    st = await check();
    if (st.u !== phone.length) {
      log("→ fill 手机号未生效，键盘逐字兜底");
      await page.click("#usernameId").catch(() => {});
      await page.keyboard.type(phone, { label: "输入手机号" });
    }
  }
  if (st.p !== password.length) {
    await page.fill("#passwordId", password).catch(() => {});
    st = await check();
    if (st.p !== password.length) {
      log("→ fill 密码未生效，键盘逐字兜底");
      await page.click("#passwordId").catch(() => {});
      await page.keyboard.type(password);
    }
  }
  return await check();
}

/** 恢复页面上所有「弹框已禁用」药丸开关（忆托+佳同各一个，每标签页独立实例）。
 *  开关在禁用态时会用隐形遮罩拦截一切弹窗（SSO 授权卡、调价弹窗全白屏）。
 *  实测：恢复后需 reload 页面拦截才真正解除。 */
async function restoreDialogSwitch(pg, name) {
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

/** ERP 当前登录身份：'target'=目标店 / 'other'=别的店 / 'none'=未登录。
 *  ERP 首页 account-info 区域显示店名+粉丝数。 */
async function erpSession(page, cred) {
  await page.goto("https://seller.kuajingmaihuo.com/", { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("load").catch(() => {});
  await sleep(4000);
  const text = await page.evaluate(() =>
    (document.querySelector("[class*='account-info']")?.textContent || "").replace(/\s+/g, ""));
  if (cred.name && text.includes(cred.name)) return "target";
  if (text) return "other";
  return "none";
}

/** 退出 ERP 当前账号（seller.kuajingmaihuo.com 头像下拉 → 退出登录 → 确认）。
 *  切店的前提：ERP 会话必须是目标店账号（SSO 授权目标由 ERP 登录会话决定）。 */
async function erpLogout(page) {
  log("→ ERP 已有登录态，退出当前账号");
  await page.goto("https://seller.kuajingmaihuo.com/", { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("load").catch(() => {});
  await sleep(4000);
  await page.evaluate(() => {
    const el = document.querySelector("[class*='account-info_img']") ||
      document.querySelector("[class*='account-info']");
    if (el) (el.closest("[class*='account-info']") || el).click();
  });
  await sleep(1500);
  const c = await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if ((t === "退出登录" || t === "退出")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < 300) return [r.left + r.width / 2, r.top + r.height / 2];
      }
    }
    return null;
  });
  if (!c) { log("⚠ 未找到退出登录入口"); return false; }
  await page.mouse.click(c[0], c[1], { label: "退出登录" });
  await sleep(2000);
  const ok = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) => {
      const t = (b.textContent || "").replace(/\s+/g, "");
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.width < 200 && /确定|确认/.test(t);
    });
    if (!btns.length) return false;
    btns[btns.length - 1].click();
    return true;
  });
  if (!ok) { log("⚠ 未找到退出确认按钮"); return false; }
  await sleep(3000);
  const done = await page.evaluate(() => !document.body.textContent.includes("hpoiZee") ||
    location.href.includes("/login"));
  log(done ? "→ ERP 已退出" : "⚠ 退出后状态异常");
  return done;
}

async function doLogin(page, phone, password) {
  await page.goto(LOGIN_URL, { timeout: 60000 });
  await page.waitForLoadState("load").catch(() => {});
  await sleep(4000);
  // 已登录（/login 被跳转走，无表单）→ 先退出当前 ERP 账号再来
  const hasForm = await page.evaluate(() => !!document.querySelector("#usernameId") ||
    location.href.includes("/login"));
  if (!hasForm) {
    await erpLogout(page);
    await page.goto(LOGIN_URL, { timeout: 60000 });
    await page.waitForLoadState("load").catch(() => {});
    await sleep(4000);
  }
  if (!(await ensurePhonePwdMode(page))) return "failpage";

  const st = await fillLogin(page, phone, password);
  if (st.u !== phone.length || st.p !== password.length) {
    log(`✗ 表单填写不完整（手机号${st.u}/${phone.length}位 密码${st.p}/${password.length}位）`);
    return "failpage";
  }

  // 登录按钮：表单域内精确「登录」（页面其他位置也有"登录"字样）
  const submit = await page.evaluate(() => {
    const u = document.querySelector("#usernameId") || document.querySelector("input[placeholder*='手机']");
    if (!u) return "no_username_input";
    const form = u.closest("form") || document;
    const btn = form.querySelector("button[type=submit]") ||
      [...form.querySelectorAll("button")].find((b) => (b.textContent || "").replace(/\s+/g, "") === "登录");
    if (!btn) return "no_submit_btn";
    btn.click();
    return "clicked";
  });
  if (submit !== "clicked") {
    log(`→ 表单内未找到登录按钮（${submit}），页面级兜底`);
    const fb = await clickButton(page, { text: "登录", exact: true }, { timeout: 8000 });
    if (!fb.ok) return "failpage";
  }
  await sleep(3000);

  // 「同意并登录」确认层
  for (let i = 0; i < 3; i++) {
    const r = await clickButton(page, { text: "同意并登录", exact: true }, { timeout: 4000 }).catch(() => null);
    if (r?.ok) { await sleep(3000); break; }
    await sleep(1500);
  }

  // 结果判定
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 5000 : 3000);
    const lines = await snapLines(page, "full_page");
    const text = lines.join("\n");
    const blocked = detectBlock(text);
    if (blocked) return blocked;
    const url = await page.url();
    const hasForm = !!(await page.evaluate(() => !!document.querySelector("#usernameId")));
    if (!hasForm && !url.includes("/login")) return null; // 表单消失 = 已离开登录页
    if (i === 3) return "failpage";
  }
  return "failpage";
}

// ---------- 授权门 / 侧边栏联动 ----------

/** 授权卡处理：勾协议（已阅读并同意…）→ 确认授权并前往。返回 'ok'|'captcha'|null。
 *  ⚠ SSO 弹窗卡片渲染需数秒——先轮询等卡片出现再读（过早扫描会扑空）。 */
async function handleAuthCard(hostPage, label) {
  let lines = [];
  let ready = false;
  for (let i = 0; i < 10; i++) {
    lines = await snapLines(hostPage).catch(() => []);
    const text = lines.join("\n");
    if (/已阅读并同意|板块共享|您授权/.test(text) && text.includes("确认授权并前往")) { ready = true; break; }
    await sleep(1500);
  }
  if (!ready) { log(`  ${label}：卡片未渲染出来`); return null; }
  const text = lines.join("\n");
  const blocked = detectBlock(text);
  if (blocked === "captcha") return "captcha";
  const hasPolicy = /已阅读并同意|板块共享|您授权/.test(text);
  const hasBtn = text.includes("确认授权并前往");
  if (!hasPolicy || !hasBtn) return null;
  log(`→ ${label}：勾选授权协议`);
  // 勾选框是隐藏原生 input（可视方块是父层 wrapper）——点 wrapper 中心并验证勾选态
  const cbBox = await hostPage.evaluate(() => {
    const cbs = [...document.querySelectorAll("input[type=checkbox], [role=checkbox]")];
    for (const cb of cbs) {
      const r0 = cb.getBoundingClientRect();
      const box = (r0.width > 4 && r0.height > 4) ? r0 : cb.parentElement.getBoundingClientRect();
      if (box.width > 4 && box.height > 4) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  });
  let checkedOk = false;
  if (cbBox) {
    for (let a = 0; a < 2 && !checkedOk; a++) {
      await hostPage.mouse.click(cbBox.x, cbBox.y, { label: "勾选授权协议" });
      await sleep(900);
      checkedOk = await hostPage.evaluate(() =>
        [...document.querySelectorAll("input[type=checkbox], [role=checkbox]")]
          .some((cb) => cb.checked === true || cb.getAttribute("aria-checked") === "true"));
    }
  }
  if (!checkedOk) {
    log(`  ${label}：勾选框未验证勾上，点协议文字兜底`);
    await clickButton(hostPage, { text: "已阅读并同意" }, { timeout: 8000 }).catch(() => {});
    await sleep(900);
  }
  await sleep(1000);
  // 确认按钮：定位坐标+真实鼠标点击（prepareClick 对该按钮误报 invisible）
  let confirmed = false;
  for (let a = 0; a < 3 && !confirmed; a++) {
    const pos = await hostPage.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, "");
      const el = [...document.querySelectorAll("button, [role=button], a, div, span")].find((e) =>
        e.children.length === 0 && norm(e.textContent) === "确认授权并前往" &&
        e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    if (!pos) { await sleep(1500); continue; }
    await hostPage.mouse.click(pos[0], pos[1], { label: "确认授权并前往" });
    await sleep(2500);
    // 成功信号：卡片消失（弹窗自关或内容翻页）
    confirmed = await hostPage.evaluate(() =>
      ![...document.querySelectorAll("button, div, span")].some((e) =>
        (e.textContent || "").replace(/\s+/g, "") === "确认授权并前往" && e.getBoundingClientRect().width > 0));
    if (confirmed) log(`  ${label}：已确认授权`);
  }
  if (!confirmed) {
    log(`→ 确认授权并前往点击失败`);
    return null;
  }
  return "ok";
}

/** 授权门过门：点「商家中心」卡片 → SSO 弹窗授权 → 等主窗回跳。 */
async function passAuthGate(task, page) {
  log("→ 卡授权门，自动过门（商家中心 → SSO 弹窗）");
  await restoreDialogSwitch(page, "主窗");
  await page.reload({ timeout: 30000 }).catch(() => {});
  await sleep(6000);
  // 清残留弹窗
  try {
    for (const t of await task.tabs()) {
      if ((t.url || "").includes("seller-login")) {
        const pg = t.label ? task.page(t.label) : await task.adopt(t.page);
        await pg.close().catch(() => {});
      }
    }
  } catch {}
  for (let attempt = 1; attempt <= 2; attempt++) {
    const popupPromise = page.waitForEvent("popup", { timeout: 15000 });
    const card = await page.evaluate(() => {
      const el = document.querySelector("div[class*='authentication_goto']");
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    if (!card) { await sleep(2500); continue; }
    await page.mouse.click(card[0], card[1], { label: "打开商家中心" });
    let popup = await popupPromise.catch(() => null);
    if (!popup) {
      try {
        for (const t of await task.tabs()) {
          if ((t.url || "").includes("seller-login")) popup = t.label ? task.page(t.label) : await task.adopt(t.page);
        }
      } catch {}
    }
    if (!popup) { log(`  第${attempt}次弹窗未打开`); await sleep(2500); continue; }
    await sleep(5000);
    await restoreDialogSwitch(popup, "弹窗");
    await popup.reload({ timeout: 30000 }).catch(() => {});
    await sleep(6000);
    // 等授权卡渲染
    let ready = false;
    for (let i = 0; i < 8; i++) {
      ready = await popup.evaluate(() =>
        [...document.querySelectorAll("*")].some((e) =>
          (e.textContent || "").replace(/\s+/g, "") === "确认授权并前往" && e.getBoundingClientRect().width > 0)).catch(() => false);
      if (ready) break;
      await sleep(1800);
    }
    if (!ready) { log(`  第${attempt}次授权卡未渲染`); await popup.close().catch(() => {}); continue; }
    // 勾协议（可视 wrapper 真实点击）
    const cbPos = await popup.evaluate(() => {
      const cb = document.querySelector("input[type=checkbox]");
      if (!cb) return null;
      const r0 = cb.getBoundingClientRect();
      const box = r0.width > 4 ? r0 : cb.parentElement.getBoundingClientRect();
      return { checked: cb.checked, x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    if (cbPos && !cbPos.checked) {
      await popup.mouse.click(cbPos.x, cbPos.y, { label: "勾选授权协议" });
      await sleep(1000);
    }
    // 确认授权并前往
    const pos = await popup.evaluate(() => {
      const el = [...document.querySelectorAll("button, div, span")].find((e) =>
        e.children.length === 0 && (e.textContent || "").replace(/\s+/g, "") === "确认授权并前往");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    if (!pos) { await popup.close().catch(() => {}); continue; }
    await popup.mouse.click(pos[0], pos[1], { label: "确认授权并前往" });
    // 等弹窗自关 + 主窗跳转
    for (let w = 0; w < 12; w++) {
      await sleep(2500);
      const mu = await page.url().catch(() => "");
      if (!mu.includes("auth/authentication")) {
        log("→ 授权完成，主窗已跳转");
        return true;
      }
    }
    log(`  第${attempt}次授权后主窗未跳转`);
  }
  return false;
}

/** 侧边栏联动切身份（主链路）。返回 'ok'|'captcha'|'fail'。 */
async function linkAgentCenter(page, cfg) {
  log("→ 侧边栏联动：商品管理 → 定制商品内容");
  let storeName = null;
  await page.goto(SELLER_MAIN_URL, { timeout: 60000 });
  await page.waitForLoadState("load").catch(() => {});
  await sleep(5000);

  for (let i = 0; i < 12; i++) {
    const lines = await snapLines(page, "full_page");
    const text = lines.join("\n");
    if (detectBlock(text) === "captcha") {
      log("✋ 出现滑块验证码（红线：不自动处理）");
      return { rc: "captcha", storeName };
    }
    // 目标店名（授权卡「…的「X」店铺」）
    if (!storeName) {
      const m = text.replace(/\s+/g, "").match(/的「([A-Za-z0-9]{2,16})」店/);
      if (m) { storeName = m[1]; log(`→ 授权卡读到目标店名: ${storeName}`); }
    }
    // ① 内嵌授权卡
    if (/已阅读并同意|板块共享|您授权/.test(text) && text.includes("确认授权并前往")) {
      const r = await handleAuthCard(page, "内嵌授权卡");
      if (r === "captcha") return { rc: "captcha", storeName };
      await sleep(4000);
      continue;
    }
    // ② 「确认切换」弹窗（绝不点「不切换」）
    if (text.includes("确认切换")) {
      log("→ 「确认切换」弹窗，点确认");
      await clickButton(page, { text: "确认切换", exact: true }, { label: "确认切换店铺", timeout: 10000 });
      await sleep(8000); // 切店整页重载较慢
      continue;
    }
    // ③ 侧边栏：先「定制商品内容」，没有则展开「商品管理」
    const sub = findRef(lines, "定制商品内容");
    if (sub) {
      log("→ 点侧边栏「定制商品内容」");
      await page.click("@" + sub, { label: "进入定制商品内容", timeout: 10000 }).catch(() => {});
      await sleep(4000);
      const now = await snapLines(page, "full_page");
      if (now.some((l) => l.includes("按勾选同步")) || now.join("\n").includes("确认切换")) continue;
      continue;
    }
    const gm = findRef(lines, "商品管理");
    if (gm) {
      log("→ 展开侧边栏「商品管理」");
      await page.click("@" + gm, { label: "展开商品管理", timeout: 10000 }).catch(() => {});
      await sleep(2500);
      continue;
    }
    // ④ 已在定制商品页
    if (text.includes("按勾选同步") || text.includes("忆托ERP同步")) {
      log("→ 已在定制商品页（双按钮可见）");
      return { rc: "ok", storeName };
    }
    await sleep(1500);
  }
  // 联动后终验
  const t = await checkTarget(page);
  if (t.b1 || t.b2) return { rc: "ok", storeName: storeName || t.acc };
  return { rc: "fail", storeName };
}

// ---------- 主编排 ----------

async function runStore(storeId) {
  const cfg = await loadConfig();
  if (!cfg) throw new Error("缺 local.config.json（gitignored，需从 Windows 手动拷贝）");
  const cred = credsOf(cfg, storeId);
  if (!cred) throw new Error(`local.config.json 无 ${storeId} 凭据（accounts.${storeId}.phone/password）`);
  const expected = cred.name;
  log(`== 切换到 ${storeId}（手机号 ${maskPhone(cred.phone)}）==`);
  const t0 = Date.now();
  const { page } = await boot();
  const lines = [];
  const shots = [];

  // 已在目标店？免登录直达
  const cur = await checkTarget(page);
  if (expected && nameEq(cur.acc, expected) && cur.b1 && cur.b2) {
    log(`已在目标店（${cur.acc}，双按钮✅），免登录直达`);
    lines.push(`店铺: ${storeId}（已在目标店，未重新登录）`, `账号: ${cur.acc}`,
      "双按钮: 按勾选同步✅ 忆托ERP同步✅", "未执行任何同步点击");
    await writeReport("store-switch", true, lines);
    return 0;
  }
  log(`当前账号: ${cur.acc || "未识别"} → 开始登录切换`);

  // ERP 会话识别：目标店已登录就跳过登录（重复登出登录既慢又多一次风控暴露）
  const erpState = await erpSession(page, cred);
  log(`→ ERP 会话: ${erpState}`);
  let rcLogin = null;
  if (erpState === "target") {
    log("→ ERP 已是目标店会话，跳过登录");
  } else {
    if (erpState === "other") await erpLogout(page);
    rcLogin = await doLogin(page, cred.phone, cred.password);
  }
  if (rcLogin === null) {
    // 跳过登录，直接进入授权门/联动
  } else if (rcLogin === "captcha" || rcLogin === "authfail") {
    shots.push(await shot(page, `switch-${storeId}-blocked`));
    lines.push(`店铺: ${storeId}`, `结果: ${rcLogin === "captcha" ? "登录出现验证码，需人工" : "账号或密码错误"}`,
      "人工完成后重跑本任务即可");
    await writeReport("store-switch", false, lines, shots);
    return 2;
  }
  if (rcLogin) {
    shots.push(await shot(page, `switch-${storeId}-loginfail`));
    lines.push(`店铺: ${storeId}`, `结果: 登录异常(${rcLogin})`);
    await writeReport("store-switch", false, lines, shots);
    return 1;
  }
  if (rcLogin !== null) log("seller 登录成功");

  // 授权门 + 是否需要联动切换
  let t = await checkTarget(page);
  if (t.onAuth) {
    log("→ 卡授权门（auth/authentication）");
    const { task } = await boot();
    if (await passAuthGate(task, page)) t = await checkTarget(page);
  }
  const knownOthers = new Set(
    Object.entries(cfg.accounts || {}).filter(([sid]) => sid !== storeId)
      .map(([, a]) => a.name).filter(Boolean));
  const need = t.onAuth || (expected ? !nameEq(t.acc, expected) : knownOthers.has(t.acc));
  let linkedName = null;
  if (need) {
    log(`→ 需要切换授权（on_auth=${t.onAuth}, acc=${t.acc}, expected=${expected}）`);
    let r = await linkAgentCenter(page, cfg);
    if (r.rc === "fail") {
      log("→ 联动失败，重试一次");
      r = await linkAgentCenter(page, cfg);
    }
    linkedName = r.storeName;
    if (r.rc === "captcha") {
      shots.push(await shot(page, `switch-${storeId}-captcha`));
      lines.push(`店铺: ${storeId}`, "结果: 重授权出现滑块验证码，需人工滑一次",
        "人工完成后重跑本任务即可（红线：程序绝不碰验证码）");
      await writeReport("store-switch", false, lines, shots);
      return 2;
    }
    await sleep(2000);
    t = await checkTarget(page);
    if (!t.acc && linkedName) t.acc = linkedName;
  }

  // 终验兜底：主窗直接导航定制商品页（会话已切新店即直达）
  const pass = expected ? nameEq(t.acc, expected) : !knownOthers.has(t.acc);
  if (!pass || !(t.b1 && t.b2)) {
    log(`→ 终验未过（acc=${t.acc} 双按钮=${t.b1},${t.b2}），导航定制商品页兜底`);
    t = await checkTarget(page);
  }

  if (expected && !nameEq(t.acc, expected)) {
    shots.push(await shot(page, `switch-${storeId}-verifyfail`));
    lines.push(`店铺: ${storeId}`,
      `结果: seller 已登录但 Agent Center 仍为 ${t.acc || "未知"}（预期 ${expected}）`,
      "请看截图核对页面状态；重跑一次本任务通常可恢复");
    await writeReport("store-switch", false, lines, shots);
    return 3;
  }
  const ok = !!(t.b1 && t.b2);
  if (!ok) {
    shots.push(await shot(page, `switch-${storeId}-nobtn`));
    lines.push(`店铺: ${storeId}`, "结果: 双按钮未出现（页面状态异常，见截图）");
    await writeReport("store-switch", false, lines, shots);
    return 3;
  }
  if (!expected) await learnName(storeId, t.acc || linkedName);
  lines.push(`店铺: ${storeId}`, `账号: ${t.acc || expected || "新店（账号名见截图）"}`,
    `双按钮: 按勾选同步${t.b1 ? "✅" : "❌"} 忆托ERP同步${t.b2 ? "✅" : "❌"}`,
    `耗时: ${Math.round((Date.now() - t0) / 1000)}s`, "未执行任何同步点击（只读验证）");
  shots.push(await shot(page, `switch-${storeId}-ok`));
  await writeReport("store-switch", true, lines, shots);
  log(`== 完成 ok 账号=${t.acc} 耗时 ${Math.round((Date.now() - t0) / 1000)}s ==`);
  return 0;
}

async function checkOnly() {
  const cfg = await loadConfig();
  const { page } = await boot();
  const t = await checkTarget(page);
  const shots = [await shot(page, "switch-check")];
  const lines = [
    `当前账号: ${t.acc || "未识别"}（配置已知店名比对）`,
    `双按钮: 按勾选同步${t.b1 ? "✅" : "✗"} 忆托ERP同步${t.b2 ? "✅" : "✗"}`,
    `授权门: ${t.onAuth ? "卡门" : "未卡"}`,
    `URL: ${t.url}`,
  ];
  await writeReport("store-check", t.b1 && t.b2 && !t.onAuth, lines, shots);
  console.log(lines.join("\n"));
  return t.b1 && t.b2 ? 0 : 3;
}

async function doctor() {
  const lines = [];
  let ok = true;
  const cfg = await loadConfig();
  if (!cfg) {
    lines.push("✗ local.config.json 缺失（gitignored；从 Windows 拷贝到项目根）");
    ok = false;
  } else {
    const accs = Object.entries(cfg.accounts || {});
    if (!accs.length) { lines.push("✗ accounts 为空"); ok = false; }
    for (const [sid, a] of accs) {
      const has = !!(a.phone && a.password);
      if (!has) ok = false;
      lines.push(`${has ? "✓" : "✗"} ${sid}: phone/password${has ? "齐" : "缺"}${a.name ? `（店名 ${a.name}）` : "（店名未学习）"}`);
    }
  }
  const { page } = await boot();
  lines.push(`✓ ego-browser 运行时正常（space temu-agent）`);
  const t = await checkTarget(page);
  lines.push(`${t.b1 && t.b2 ? "✓" : "⚠"} 当前登录态: ${t.acc || "未识别"}${t.onAuth ? "（卡授权门）" : ""}`);
  await writeReport("store-doctor", ok, lines, [await shot(page, "doctor")]);
  console.log(lines.join("\n"));
  return ok ? 0 : 1;
}

async function verifyAll() {
  const cfg = await loadConfig();
  if (!cfg) { console.error("缺 local.config.json"); return 1; }
  const stores = Object.keys(cfg.accounts || {}).filter((s) => credsOf(cfg, s));
  log(`逐店验证: ${stores.join(" → ")}`);
  let rc = 0;
  for (const s of stores) {
    log(`\n===== ${s} =====`);
    const r = await runStore(s);
    if (r !== 0) rc = r;
  }
  return rc;
}

async function main() {
  const a = args();
  if (a.includes("--check")) { process.exitCode = await checkOnly(); return; }
  if (a.includes("--doctor")) { process.exitCode = await doctor(); return; }
  if (a.includes("--verify-all")) {
    await acquireLock();
    try { process.exitCode = await verifyAll(); }
    finally { await releaseLock(); }
    return;
  }
  const storeId = a.find((x) => !x.startsWith("--"));
  if (!storeId) {
    console.error("用法: run switch-store <store-id> [--check|--doctor|--verify-all]");
    process.exitCode = 64;
    return;
  }
  await acquireLock();
  try {
    process.exitCode = await runStore(storeId);
  } catch (e) {
    console.error("FATAL", e.message);
    try {
      const { page } = await boot();
      await writeReport("store-switch", false, [`✗ 异常: ${e.message}`], [await shot(page, "switch-fatal")]);
    } catch {}
    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main();
