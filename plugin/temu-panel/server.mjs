// temu-panel 后端：任务按钮 → spawn Claude Code CLI（headless，cwd=temu-agent 项目目录）→ 实时日志行。
// 双模式：被 CloudCLI 宿主 spawn（随机端口 + stdout ready 协议）；
//         独立运行 `node server.mjs --port 3790` → 浏览器打开 http://127.0.0.1:3790 即独立工作台。
// 项目目录默认 ~/PycharmProjects/temu-agent-mac（Mac），可用环境变量 TEMU_DIR 覆盖。
// 浏览器自动化已换 ego-browser（根目录 run 启动器 + modules/*/<task>.mjs 任务脚本），Windows/driver 为历史参考。
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const TEMU_DIR = process.env.TEMU_DIR || path.join(os.homedir(), "PycharmProjects", "temu-agent-mac");
const STATUS_FILE = path.join(TEMU_DIR, "logs", "last-status.json");
const REPORT_FILE = path.join(TEMU_DIR, "logs", "report-latest.md");

const portArg = process.argv.indexOf("--port");
const STANDALONE_PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : null;

// 店铺定义（账号切换式多店铺，详见 discoveries/store-switch.md）
// 店铺列表从 local.config.json accounts 动态生成：加新店只需在配置里加一项，
// 工作台自动出现对应任务卡（免改代码）。
function loadPhonePrefixes() {
  try {
    const accs = JSON.parse(fs.readFileSync(path.join(TEMU_DIR, "local.config.json"), "utf-8")).accounts || {};
    const out = {};
    for (const [k, v] of Object.entries(accs)) out[k] = String(v.phone || "").slice(0, 3);
    return out;
  } catch { return {}; }
}
const PHONE3 = loadPhonePrefixes();
const STORE_LABELS = { main: "主店铺", "store-b": "店铺B", "store-c": "店铺C" };
function storeLabel(id) {
  const base = STORE_LABELS[id] || ("店铺" + id.replace(/^store-?/i, "").toUpperCase());
  return base + (PHONE3[id] ? " " + PHONE3[id] : "");
}
const STORES = Object.keys(PHONE3).map((id) => ({ id, label: storeLabel(id) }));

function storeTaskPrompt(storeId, label) {
  const sep = process.platform === "win32" ? "\\" : "/";
  return `先运行确定性切店脚本：${TEMU_DIR}${sep}run switch-store ${storeId}（等待其完成，查看输出与退出码）。` +
    `若退出码 3（验证失败：店名或双按钮没验上，切换链路本身已全自动）：先看截图（screenshots/switch-*.png）核对页面状态并**重跑一次**，通常恢复；连续 2 次失败停手报告用户。` +
    `若退出码 2（验证码/密码问题）：如实报告，绝不代输验证码。` +
    `若输出提示 ego 浏览器被用户接管（task space control）：等待用户空闲后重跑，勿强行接管。` +
    `切店成功后按 .claude/skills/temu-sync-check/SKILL.md 流程做只读体检（登录态+双按钮+截图+报告）。全程不点任何同步按钮。`;
}

const TASKS = {
  "sync-check": {
    label: `体检 · ${STORES[0]?.label || "主店铺"}`,
    desc: "只读体检 · 不点同步按钮",
    warn: "只读体检任务：验证登录态与双同步按钮，截图取证并生成中文报告。不会点击任何同步按钮。",
    prompt: "按照 .claude/skills/temu-sync-check/SKILL.md 定义的流程执行每日同步体检任务（只读，不点任何同步按钮），完成后简短汇报结论。",
  },
  "expect-region": {
    label: "期望到货区域→义乌",
    desc: "改数据 · 分批提交 · 幂等收敛",
    warn: "改数据任务：把当前店铺全部 JIT/定制品的期望到货区域设为义乌（已是义乌的重复设置无副作用）。分批(每页500)提交，全程留截图与报告；遇验证码立即停手。",
    prompt: "按照 .claude/skills/temu-expect-region/SKILL.md 定义的流程，把当前登录店铺的全部 JIT/定制品期望到货区域设为义乌（点击工作台卡片即视为执行授权）。先截图确认账号名写进报告，再分批全选→义乌→确认，最后按 skill 第5步三个筛选验证收尾并写报告。",
  },
};
for (const s of STORES) {
  TASKS[`check:${s.id}`] = {
    label: `${s.id === "main" ? "切回" : "切到"}${s.label} + 体检`,
    desc: "切店（确定性脚本）+ 只读体检 · 不点同步按钮",
    warn: "切店用确定性脚本（约2分钟）；体检只读不点同步按钮；遇验证码/授权卡会暂停等你。",
    prompt: storeTaskPrompt(s.id, s.label),
  };
}

const state = {
  running: false,
  task: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  lines: [],
  proc: null,
};

function push(line) {
  state.lines.push(line);
  if (state.lines.length > 2000) state.lines.splice(0, state.lines.length - 2000);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function startTask(task) {
  if (state.running) return { ok: false, error: "已有任务在运行" };
  const def = TASKS[task];
  if (!def) return { ok: false, error: `未知任务: ${task}` };

  state.running = true;
  state.task = task;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.lines = [];
  push(`▶ 启动任务 ${def.label} @ ${new Date().toLocaleString()}`);

  const env = { ...process.env };
  let cmd;
  let cmdArgs;
  if (process.platform === "win32") {
    // Windows 旧路径（历史兼容）：cmd /c claude …
    cmd = process.env.ComSpec || "cmd.exe";
    cmdArgs = ["/c", "claude", "-p", def.prompt,
      "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json",
      "--verbose"];
    const npmGlobal = path.join(os.homedir(), "AppData", "Roaming", "npm");
    env.PATH = `${npmGlobal};${env.PATH || ""}`;
  } else {
    // macOS/Linux：直接 spawn claude（PATH 里找）
    cmd = "claude";
    cmdArgs = ["-p", def.prompt,
      "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json",
      "--verbose"];
  }

  const child = spawn(cmd, cmdArgs, { env, cwd: TEMU_DIR });
  state.proc = child;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (raw) => {
    try {
      const ev = JSON.parse(raw);
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) push(block.text);
          if (block.type === "tool_use") push(`🔧 ${block.name} ${JSON.stringify(block.input || {}).slice(0, 160)}`);
        }
      } else if (ev.type === "result") {
        push(ev.result ? String(ev.result).slice(0, 2000) : "(空结果)");
      }
    } catch {
      push(raw.slice(0, 500));
    }
  });
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (l) => push(`⚠ ${l.slice(0, 300)}`));

  child.on("close", (code) => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.exitCode = code;
    push(`■ 任务结束 exit=${code}`);
    const st = readJson(STATUS_FILE);
    if (st) push(`📄 报告: ${st.report} | ok=${st.ok} | ${st.summary || ""}`);
  });

  return { ok: true };
}

const STANDALONE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TEMU 工作台</title>
<style>
  :root {
    --bg0: #f6f8fb; --bg1: #ffffff; --card: #ffffff; --card-hi: #ffffff;
    --line: #e4e9f2; --txt: #1f2733; --dim: #6b7688; --faint: #9aa5b8;
    --acc: #f26a0c; --acc2: #d95a08; --ok: #0f9d6e; --warn: #c77700; --err: #dc2626;
    --mono: "Cascadia Code", Consolas, "Courier New", monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--txt);
    font-family: system-ui, "Microsoft YaHei", "Segoe UI", sans-serif;
    background: radial-gradient(1200px 600px at 85% -10%, #e9f0fa 0%, var(--bg0) 55%) fixed;
    min-height: 100vh;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 32px 40px; }

  /* ── 顶栏 ── */
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 26px; }
  .logo {
    width: 46px; height: 46px; border-radius: 13px; flex: none;
    background: linear-gradient(135deg, #ff9440, #ff5c00);
    display: grid; place-items: center; font-weight: 800; font-size: 22px; color: #fff;
    box-shadow: 0 6px 18px rgba(255,110,20,.35);
  }
  .brand h1 { margin: 0; font-size: 20px; letter-spacing: .5px; }
  .brand p { margin: 3px 0 0; font-size: 12px; color: var(--dim); }
  .top-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px;
    border: 1px solid var(--line); border-radius: 999px; background: #ffffff;
    font-size: 13px; color: var(--dim); box-shadow: 0 1px 3px rgba(15,23,42,.06);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b768e; }
  .badge.run { color: var(--ok); border-color: rgba(52,211,153,.4); }
  .badge.run .dot { background: var(--ok); animation: pulse 1.4s infinite; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(52,211,153,.5);} 50% { box-shadow: 0 0 0 6px rgba(52,211,153,0);} }
  button {
    border: 0; border-radius: 9px; padding: 8px 16px; font-size: 13px; cursor: pointer;
    background: #eef2f8; color: var(--txt); transition: .18s;
  }
  button:hover { background: #e2e8f2; transform: translateY(-1px); }
  button.danger { background: transparent; border: 1px solid rgba(248,113,113,.5); color: var(--err); display: none; }
  button.danger:hover { background: rgba(248,113,113,.12); }
  body.running button.danger { display: inline-block; }

  /* ── 概要条 ── */
  .summary { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .chip {
    font-size: 12px; color: var(--dim); padding: 6px 12px; border-radius: 8px;
    background: #ffffff; border: 1px solid var(--line);
  }
  .chip b { color: var(--txt); font-weight: 600; }

  /* ── 任务卡片 ── */
  h2.sec { font-size: 13px; color: var(--dim); font-weight: 600; letter-spacing: 2px; margin: 26px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
  .card {
    position: relative; display: flex; gap: 14px; align-items: center;
    background: #ffffff;
    border: 1px solid var(--line); border-radius: 14px; padding: 16px; cursor: pointer;
    transition: .18s; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,.05);
  }
  .card:hover:not(.disabled) { border-color: rgba(242,106,12,.55); transform: translateY(-2px);
    box-shadow: 0 10px 24px rgba(15,23,42,.10), 0 0 0 3px rgba(242,106,12,.10); }
  .card.running { border-color: var(--acc); box-shadow: 0 0 18px rgba(255,122,26,.25); }
  .card.running::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(90deg, transparent, rgba(255,122,26,.08), transparent);
    animation: sweep 1.6s infinite;
  }
  @keyframes sweep { from { transform: translateX(-100%);} to { transform: translateX(100%);} }
  .card.disabled { opacity: .38; cursor: not-allowed; filter: saturate(.4); }
  .ava {
    width: 42px; height: 42px; border-radius: 12px; flex: none; display: grid; place-items: center;
    font-weight: 700; font-size: 17px; color: #fff;
  }
  .ava.a1 { background: linear-gradient(135deg, #ffa04d, #ff5c00); }
  .ava.a2 { background: linear-gradient(135deg, #6ea8ff, #3b6fe0); }
  .ava.a3 { background: linear-gradient(135deg, #7ee0b8, #1fa877); }
  .ava.ghost { background: #eef2f8; color: var(--dim); }
  .card h4 { margin: 0; font-size: 15px; }
  .card .phone { font-size: 11px; color: var(--acc2); font-family: var(--mono); }
  .card p { margin: 4px 0 0; font-size: 12px; color: var(--dim); }
  .tag { position: absolute; top: 10px; right: 12px; font-size: 10px; color: var(--dim);
         border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; letter-spacing: 1px; }

  /* ── 面板 ── */
  .panels { display: grid; grid-template-columns: 1.5fr 1fr; gap: 14px; margin-top: 6px; }
  @media (max-width: 980px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--bg1); border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
           display: flex; flex-direction: column; min-height: 380px; }
  .panel-head {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    border-bottom: 1px solid var(--line); background: #f8fafc;
    font-size: 12px; color: var(--dim); letter-spacing: 1.5px;
  }
  .panel-head .dots { display: flex; gap: 5px; margin-right: 4px; }
  .panel-head .dots i { width: 9px; height: 9px; border-radius: 50%; background: #d7deea; }
  .panel-head .dots i:nth-child(1) { background: #ff5f57; } .panel-head .dots i:nth-child(2) { background: #febc2e; } .panel-head .dots i:nth-child(3) { background: #28c840; }
  .panel-head button { margin-left: auto; padding: 4px 12px; font-size: 12px; }
  #log {
    flex: 1; margin: 0; padding: 14px 16px; overflow-y: auto; background: #0b0e15;
    font: 12.5px/1.7 var(--mono); white-space: pre-wrap; word-break: break-all;
  }
  #log .ln { display: block; }
  #log .ln.start { color: #7db4ff; } #log .ln.tool { color: #9fd49f; }
  #log .ln.warn { color: var(--warn); } #log .ln.end { color: var(--dim); } #log .ln.doc { color: #67e8f9; }
  #log .ln.plain { color: #c3cbdc; }
  #log .empty { color: #525d75; font-style: italic; }
  #report { flex: 1; margin: 0; padding: 14px 16px; overflow-y: auto; white-space: pre-wrap;
            font: 12.5px/1.8 var(--mono); color: #374151; }
  #report .h { color: var(--acc2); font-weight: 700; }
  #report .fail { color: var(--err); } #report .okl { color: var(--ok); }

  /* ── 模态 ── */
  .mask { position: fixed; inset: 0; background: rgba(15,23,42,.35); backdrop-filter: blur(3px);
          display: none; place-items: center; z-index: 50; }
  .mask.show { display: grid; }
  .modal { width: 380px; background: #ffffff; border: 1px solid var(--line); border-radius: 16px;
           padding: 24px; animation: pop .18s ease; box-shadow: 0 24px 48px rgba(15,23,42,.18); }
  @keyframes pop { from { transform: scale(.94); opacity: 0; } }
  .modal h3 { margin: 0 0 8px; font-size: 16px; }
  .modal p { margin: 0 0 20px; font-size: 13px; color: var(--dim); line-height: 1.7; }
  .modal .row { display: flex; gap: 10px; justify-content: flex-end; }
  .btn-acc { background: linear-gradient(135deg, #ff9440, #ff5c00); color: #fff; }
  .btn-acc:hover { background: linear-gradient(135deg, #ffa558, #ff6a1a); }

  footer { margin-top: 22px; text-align: center; font-size: 11px; color: #a3adc2; }
  ::-webkit-scrollbar { width: 9px; } ::-webkit-scrollbar-thumb { background: #d3dbe8; border-radius: 5px; }
</style></head><body>
<div class="wrap">
  <header>
    <div class="logo">T</div>
    <div class="brand">
      <h1>TEMU 工作台</h1>
      <p>ego-browser 驱动（Mac） · 复用登录态 · 验证码永远人工</p>
    </div>
    <div class="top-right">
      <div class="badge" id="state"><span class="dot"></span><span id="stateText">连接中…</span></div>
      <button class="danger" onclick="stop()">■ 停止任务</button>
    </div>
  </header>

  <div class="summary">
    <div class="chip" id="last"></div>
    <div class="chip" id="runtime"></div>
    <div class="chip">改数据任务 <b>卡片点击即授权</b>（分批提交+报告留痕）</div>
  </div>

  <h2 class="sec">店铺任务</h2>
  <div class="grid" id="grid"></div>

  <h2 class="sec">运行与报告</h2>
  <div class="panels">
    <div class="panel">
      <div class="panel-head"><span class="dots"><i></i><i></i><i></i></span>实时日志</div>
      <pre id="log"><span class="empty">尚无日志 — 点击上方任务卡片开始</span></pre>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="dots"><i></i><i></i><i></i></span>最近报告
        <button onclick="loadReport()">刷新</button></div>
      <pre id="report"><span class="empty">点「刷新」加载最新报告</span></pre>
    </div>
  </div>

  <footer>temu-agent · CloudCLI 插件同源 · 本地 127.0.0.1 独立运行</footer>
</div>

<div class="mask" id="mask">
  <div class="modal">
    <h3 id="mTitle">运行任务</h3>
    <p id="mDesc"></p>
    <div class="row">
      <button onclick="closeModal()">取消</button>
      <button class="btn-acc" onclick="confirmRun()">开始运行</button>
    </div>
  </div>
</div>

<script>
var PLACEHOLDERS = [["make-links","插件做链接"],["compliance","合规填写"],["collect-links","商品采集"],["price-review","价格报表"],["new-listing","上新"]];
var lineCount = 0, pendingTask = null, taskMap = {};

function esc(s) { var d = document.createElement("i"); d.textContent = s; return d.innerHTML; }
function badge(el) { return document.body.classList; }

function renderState(st) {
  var b = document.getElementById("state"), t = document.getElementById("stateText");
  if (st.running) {
    b.className = "badge run"; badge().add("running");
    t.textContent = "运行中 · " + (taskMap[st.task] || st.task);
  } else {
    b.className = "badge"; badge().remove("running");
    t.textContent = "空闲" + (st.finishedAt ? " · 上次 exit " + (st.exitCode ?? "-") : "");
  }
  document.getElementById("last").innerHTML = st.lastStatus
    ? "上次任务 <b>" + esc(st.lastStatus.task) + "</b> " + (st.lastStatus.ok ? "✅" : "❌") + " " + esc(st.lastStatus.ts)
    : "尚无运行记录";
  document.getElementById("runtime").innerHTML = st.running
    ? "已运行 <b id='rt'>–</b>"
    : (st.startedAt ? "上次启动 " + esc(st.startedAt.replace("T", " ")) : "");
  if (st.running) tick(st.startedAt);
  markRunningCard(st.running ? st.task : null);
}
function markRunningCard(task) {
  document.querySelectorAll(".card[data-task]").forEach(function (c) {
    c.classList.toggle("running", c.getAttribute("data-task") === task);
    c.classList.toggle("disabled", !!task && c.getAttribute("data-task") !== task);
  });
}
function tick(startedAt) {
  var el = document.getElementById("rt"); if (!el) return;
  var s = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  var m = Math.floor(s / 60);
  el.textContent = (m >= 1 ? m + " 分 " : "") + (s % 60) + " 秒";
}

function appendLine(text) {
  var log = document.getElementById("log");
  var empty = log.querySelector(".empty"); if (empty) empty.remove();
  var cls = "plain";
  if (text.indexOf("▶") === 0) cls = "start";
  else if (text.indexOf("🔧") === 0) cls = "tool";
  else if (text.indexOf("⚠") === 0) cls = "warn";
  else if (text.indexOf("■") === 0) cls = "end";
  else if (text.indexOf("📄") === 0) cls = "doc";
  var span = document.createElement("span");
  span.className = "ln " + cls; span.textContent = text;
  log.appendChild(span); log.scrollTop = log.scrollHeight;
}

async function refresh() {
  try {
    var st = await (await fetch("/status")).json();
    renderState(st);
    var data = await (await fetch("/lines?since=" + lineCount)).json();
    if (data.lines && data.lines.length) {
      data.lines.forEach(appendLine); lineCount = data.total;
    }
  } catch (e) {
    document.getElementById("stateText").textContent = "服务不可达";
  }
}

function askRun(task, label, desc, warn) {
  pendingTask = task;
  document.getElementById("mTitle").textContent = "运行「" + label + "」";
  document.getElementById("mDesc").innerHTML = esc(desc || "") + "<br>" +
    "<b style='color:var(--warn)'>" + esc(warn || "只读体检任务：不会点击任何同步按钮；切店任务遇到验证码会暂停等你。") + "</b>";
  document.getElementById("mask").classList.add("show");
}
function closeModal() { document.getElementById("mask").classList.remove("show"); pendingTask = null; }
async function confirmRun() {
  var t = pendingTask; closeModal();
  if (!t) return;
  lineCount = 0;
  var log = document.getElementById("log");
  log.innerHTML = "";
  await fetch("/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: t }) });
  refresh();
}
async function stop() { if (confirm("确定停止当前任务？")) { await fetch("/stop", { method: "POST" }); refresh(); } }

async function loadReport() {
  var r = await (await fetch("/report")).json();
  var el = document.getElementById("report"); el.innerHTML = "";
  String(r.report).split("\\n").forEach(function (line) {
    var span = document.createElement("span");
    if (line.indexOf("# ") === 0) span.className = "h";
    else if (line.indexOf("✅") >= 0) span.className = "okl";
    else if (line.indexOf("❌") >= 0) span.className = "fail";
    span.textContent = line; el.appendChild(span);
    el.appendChild(document.createTextNode("\\n"));
  });
}

function card(task, label, desc, enabled, avClass, ghost, warn) {
  var c = document.createElement("div");
  c.className = "card" + (enabled ? "" : " disabled");
  if (task) c.setAttribute("data-task", task);
  var name = label.split(" ")[0], phone = label.split(" ")[1] || "";
  c.innerHTML = '<div class="ava ' + (ghost ? "ghost" : avClass) + '">' + esc(name.charAt(0)) + '</div>' +
    '<div><h4>' + esc(name) + " " + (phone ? '<span class="phone">' + esc(phone) + "</span>" : "") + "</h4>" +
    "<p>" + esc(desc) + "</p></div>" +
    (ghost ? '<span class="tag">待发现</span>' : "");
  if (enabled && task) c.onclick = function () { askRun(task, label, desc, warn); };
  return c;
}

var grid = document.getElementById("grid");
var AVA = ["a1", "a2", "a3"];
(async function () {
  try {
    var st = await (await fetch("/status")).json();
    (st.tasks || []).forEach(function (t, i) {
      taskMap[t.id] = t.label;
      grid.insertBefore(card(t.id, t.label, t.desc || "只读体检 · 不点同步按钮", true, AVA[i % 3], false, t.warn), grid.firstChild);
    });
  } catch (e) {}
  PLACEHOLDERS.forEach(function (p) { grid.appendChild(card(null, p[1], "流程待发现会话", false, "", true)); });
})();

refresh(); setInterval(refresh, 1500);
setInterval(function () {
  fetch("/status").then(function (r) { return r.json(); }).then(function (st) { if (st.running) tick(st.startedAt); }).catch(function () {});
}, 1000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(STANDALONE_HTML);
  }
  if (req.method === "GET" && url.pathname === "/status") {
    return send(200, {
      running: state.running,
      task: state.task,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      exitCode: state.exitCode,
      lines: state.lines.length,
      tasks: Object.entries(TASKS).map(([id, t]) => ({ id, label: t.label, desc: t.desc, warn: t.warn })),
      lastStatus: readJson(STATUS_FILE),
    });
  }
  if (req.method === "GET" && url.pathname === "/lines") {
    const since = Number(url.searchParams.get("since") || 0);
    return send(200, { lines: state.lines.slice(since), total: state.lines.length });
  }
  if (req.method === "GET" && url.pathname === "/report") {
    try {
      return send(200, { report: fs.readFileSync(REPORT_FILE, "utf-8") });
    } catch {
      return send(200, { report: "(尚无报告)" });
    }
  }
  if (req.method === "POST" && url.pathname === "/run") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        return send(200, startTask(JSON.parse(body).task));
      } catch (e) {
        return send(400, { ok: false, error: String(e) });
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/stop") {
    if (state.proc) {
      state.proc.kill();
      push("⛔ 手动停止");
    }
    return send(200, { ok: true });
  }
  send(404, { error: "not found" });
});

if (STANDALONE_PORT) {
  server.listen(STANDALONE_PORT, "127.0.0.1", () => {
    console.log(`TEMU 工作台（独立版）: http://127.0.0.1:${STANDALONE_PORT}`);
  });
} else {
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
  });
}
