// temu-panel 前端（零构建原生 ESM）：任务卡片 + 实时日志 + 报告查看。
// 宿主协议：export mount(container, api) / unmount(container)；api.rpc(method, path, body)。

const PLACEHOLDER_TASKS = [
  { id: "make-links", label: "插件做链接", desc: "待发现会话" },
  { id: "compliance", label: "合规填写", desc: "待发现会话" },
  { id: "collect-links", label: "商品采集", desc: "待发现会话" },
  { id: "price-review", label: "价格报表", desc: "待发现会话" },
  { id: "new-listing", label: "上新", desc: "待发现会话" },
];

let timer = null;
let lineCount = 0;
let api = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function refresh(root) {
  try {
    const st = await api.rpc("GET", "/status");
    root.querySelector("#tp-state").textContent = st.running
      ? `🟢 运行中: ${st.task} (${new Date(st.startedAt).toLocaleTimeString()} 起)`
      : `⚪ 空闲 (上次 exit=${st.exitCode ?? "-"} ${st.finishedAt ? new Date(st.finishedAt).toLocaleTimeString() : ""})`;
    const data = await api.rpc("GET", `/lines?since=${lineCount}`);
    if (data.lines.length) {
      const pre = root.querySelector("#tp-log");
      for (const l of data.lines) pre.textContent += l + "\n";
      lineCount = data.total;
      pre.scrollTop = pre.scrollHeight;
    }
    if (st.lastStatus) {
      root.querySelector("#tp-last").textContent =
        `上次: ${st.lastStatus.task} ${st.lastStatus.ok ? "✅" : "❌"} ${st.lastStatus.ts}`;
    }
  } catch (e) {
    root.querySelector("#tp-state").textContent = `状态获取失败: ${e?.message || e}`;
  }
}

export function mount(container, hostApi) {
  api = hostApi;
  const root = el("div", "tp-root");
  root.innerHTML = `
    <style>
      .tp-root { font-family: system-ui, sans-serif; padding: 16px; color: #ddd; max-width: 900px; }
      .tp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin: 12px 0; }
      .tp-card { border: 1px solid #444; border-radius: 8px; padding: 12px; cursor: pointer; }
      .tp-card:hover { border-color: #4a9eff; }
      .tp-card.disabled { opacity: 0.4; cursor: not-allowed; }
      .tp-card h4 { margin: 0 0 4px; font-size: 14px; }
      .tp-card p { margin: 0; font-size: 12px; color: #999; }
      #tp-log { background: #111; color: #9f9; border-radius: 6px; padding: 10px; height: 260px;
                overflow-y: auto; font-size: 12px; white-space: pre-wrap; font-family: Consolas, monospace; }
      #tp-state { font-size: 14px; }
      #tp-last { font-size: 12px; color: #999; }
      .tp-sec { margin-top: 14px; }
      .tp-btn { background: #2b6cb0; color: #fff; border: 0; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
      #tp-report { background: #161616; border-radius: 6px; padding: 10px; font-size: 12px;
                   white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
    </style>
    <h3 style="margin:4px 0">TEMU 工作台</h3>
    <div id="tp-state">…</div>
    <div id="tp-last"></div>
    <div class="tp-grid" id="tp-grid"></div>
    <div class="tp-sec"><b>运行日志</b> <button class="tp-btn" id="tp-stop">停止</button></div>
    <pre id="tp-log"></pre>
    <div class="tp-sec"><b>最近报告</b> <button class="tp-btn" id="tp-load-report">刷新</button></div>
    <div id="tp-report">（点"刷新"加载）</div>
  `;
  container.appendChild(root);

  const grid = root.querySelector("#tp-grid");
  const card = ({ id, label, desc, enabled }) => {
    const c = el("div", "tp-card" + (enabled ? "" : " disabled"));
    c.appendChild(el("h4", null, label));
    c.appendChild(el("p", null, desc));
    if (enabled) c.onclick = async () => {
      const msg = `运行「${label}」？\n\n${desc}\n\n只读任务不点同步按钮；改数据任务分批提交并留报告；遇验证码一律停手。`;
      if (!confirm(msg)) return;
      lineCount = 0; root.querySelector("#tp-log").textContent = "";
      await api.rpc("POST", "/run", { task: id });
      refresh(root);
    };
    return c;
  };
  // 任务按钮从 /status 动态渲染（含各店切店+体检）
  api.rpc("GET", "/status").then((st) => {
    for (const t of [...(st.tasks || [])].reverse())
      grid.insertBefore(card({ id: t.id, label: t.label, desc: t.desc || "只读体检 · 不点同步按钮", enabled: true }), grid.firstChild);
  }).catch(() => {});
  for (const t of PLACEHOLDER_TASKS) grid.appendChild(card({ ...t, enabled: false }));

  root.querySelector("#tp-stop").onclick = () => api.rpc("POST", "/stop", {});
  root.querySelector("#tp-load-report").onclick = async () => {
    const r = await api.rpc("GET", "/report");
    root.querySelector("#tp-report").textContent = r.report;
  };

  refresh(root);
  timer = setInterval(() => refresh(root), 1500);
}

export function unmount(container) {
  if (timer) clearInterval(timer);
  container.querySelector(".tp-root")?.remove();
}
