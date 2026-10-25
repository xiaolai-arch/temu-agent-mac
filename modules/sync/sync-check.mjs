// modules/sync/sync-check.mjs — 每日同步体检（只读）
// 用法: run sync-check [store-id]
// 移植自 .claude/skills/temu-sync-check（原 edge_navigate/ocr_last 流程 → ego-browser 语义快照）。
// 验证：① 登录态（URL+标题）② 右上角账号名（对照 local.config.json 各店名）③ 插件双按钮。
// 退出码：0=通过 1=异常 3=未登录（对齐旧 switch_store 语义）。

import {
  CUSTOMIZE_URL, args, boot, closeModals, loadConfig, log, sleep,
  snapLines, shot, writeReport,
} from "../../lib/common.mjs";

async function main() {
  const [store = "main"] = args();
  const lines = [];
  const shots = [];
  const { page } = await boot();
  let ok = false;
  let rc = 1;
  try {
    log(`→ 导航定制商品页（期望店铺 ${store}）`);
    await page.goto(CUSTOMIZE_URL, { timeout: 60000 });
    await page.waitForLoadState("load").catch(() => {});
    await sleep(6000);
    await closeModals(page);

    const url = await page.url();
    const title = await page.title();
    const snap = await snapLines(page, "full_page");
    const text = snap.join("\n");

    // 1) 登录态
    if (url.includes("auth/authentication")) {
      lines.push(`未登录：跳转到 ${url}`);
      lines.push("恢复方式：人工在 ego 浏览器登录，或跑切店脚本（run switch-store）");
      ok = false;
      rc = 3;
    } else if (url.includes("customize-goods") && title.includes("定制商品内容")) {
      lines.push(`登录态正常：${title}`);
    } else {
      lines.push(`页面异常：url=${url} title=${title}`);
      ok = false;
      rc = 1;
    }

    // 2) 账号名（当前是哪个店）
    const cfg = await loadConfig();
    const names = {};
    if (cfg?.accounts) {
      for (const [sid, acc] of Object.entries(cfg.accounts)) {
        if (acc.name) names[acc.name] = sid;
      }
    }
    const hit = Object.keys(names).find((n) => text.includes(n));
    if (hit) {
      lines.push(`当前账号: ${hit}（${names[hit]}）${names[hit] === store ? "✓ 与期望一致" : `⚠ 期望 ${store}`}`);
    } else if (cfg) {
      lines.push("⚠ 快照中未识别到已知店名（可能登录态异常或店名未学习）");
    } else {
      lines.push("（无 local.config.json，跳过店名比对）");
    }

    // 3) 插件双按钮（忆托 ERP 注入；只验证存在，绝不点击）
    const syncBtn = snap.some((l) => l.includes("按勾选同步"));
    const erpBtn = snap.some((l) => l.includes("忆托ERP同步"));
    lines.push(`插件按钮: 按勾选同步${syncBtn ? "✓" : "✗缺失"} 忆托ERP同步${erpBtn ? "✓" : "✗缺失"}`);

    shots.push(await shot(page, "sync-check"));
    lines.push("未执行任何同步点击（只读任务）");

    // 汇总判定（未登录 rc=3 已在上方设定）
    if (rc === 1) {
      const loginOk = lines.some((l) => l.startsWith("登录态正常"));
      const storeOk = cfg ? !!hit && names[hit] === store : true;
      ok = loginOk && syncBtn && erpBtn && storeOk;
      rc = ok ? 0 : 1;
    } else {
      ok = false;
    }
  } catch (e) {
    lines.push(`✗ 异常: ${e.message}`);
    try { shots.push(await shot(page, "sync-check-fail")); } catch {}
    rc = 1;
    ok = false;
  }
  await writeReport("sync-check", ok, lines, shots);
  log(ok ? "✅ 体检通过" : `❌ 体检未通过（rc=${rc}）`);
  process.exitCode = rc;
}

main().catch(async (e) => {
  console.error("FATAL", e);
  try { await writeReport("sync-check", false, [`✗ 异常: ${e.message}`]); } catch {}
  process.exitCode = 1;
});
