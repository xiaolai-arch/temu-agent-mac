// modules/image/fission.mjs — 主图裂变：一张商品主图 → N 张场景/风格变体（Seedream 图生图 API）
// 用法: run fission <主图路径> [--preset home,model,promo | all] [--text "促销文案"]
//                 [--n 5] [--size 1024x1024] [--model doubao-seedream-5.0-flash] [--dry]
// 凭据: local.config.json → { "image": { "arkApiKey": "...", "model": "可选默认模型" } }
//       （ego 运行时不继承 shell 环境变量，key 只走 local.config.json；gitignored，绝不提交）
// 红线：不触碰 TEMU 后台任何数据（纯外部生图 API，无浏览器交互）；生成图只存本模块
//       data/，是否上传上架永远由人工决定——本脚本只做"裂变"，不做"上新"。
//
// 一致性说明：所有变体共用 CONSISTENCY 一致性红线提示词，要求模型严格保留商品本体
// （外观/颜色/材质/logo/比例），只允许重新生成背景与场景——这是"一张主图裂变"的生死线。

import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  REPO_ROOT, args, log, loadConfig, nowTs, writeReport,
} from "../../lib/common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_MODEL = "doubao-seedream-5.0-flash";
const DEFAULT_SIZE = "1024x1024";
const REQUEST_TIMEOUT_MS = 180_000;

const CONSISTENCY =
  "严格保持参考图中商品的外观、颜色、材质、logo、图案文字与比例完全一致，" +
  "不得增删或改变商品本身；仅重新生成背景与场景。" +
  "参考图中若有数量标识、尺寸标注或促销文字叠加（如 50 PCS、100 张、尺寸数字），" +
  "一律不要复现；生成画面中不得出现任何数量或尺寸文字。";

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

async function resolveImagePath(p) {
  const candidates = p.startsWith("/")
    ? [p]
    : [path.join(REPO_ROOT, p), path.resolve(p)];
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isFile()) return c;
    } catch { /* try next */ }
  }
  throw new Error(`找不到主图文件: ${p}`);
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function buildPrompt(scene, promoText) {
  const parts = [CONSISTENCY, scene];
  if (promoText) {
    parts.push(`在画面留白处加入主文案「${promoText}」，使用清晰易读的无衬线中文字体，不遮挡商品主体。`);
  }
  return parts.join("");
}

async function generate({ apiKey, model, prompt, imageDataUrl, size, url }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      image: imageDataUrl,
      size,
      response_format: "url",
      watermark: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const item = json?.data?.[0];
  if (!item?.url) {
    throw new Error(`响应无图片 URL: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return item.url;
}

async function downloadTo(url, filePath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return buf.length;
}

async function main() {
  const argv = args();
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("用法: run fission <主图路径> [--preset all|home,model,...] [--text 文案] [--n 5] [--size 1024x1024] [--dry]");
    return;
  }
  const { positional, flags } = parseArgs(argv);
  const lines = [];

  const presets = JSON.parse(await readFile(path.join(HERE, "presets.json"), "utf8"));
  const wanted = String(flags.preset || "all").split(",").map((s) => s.trim()).filter(Boolean);
  const names = wanted.includes("all") ? presets.all : wanted;
  const unknown = names.filter((n) => !presets.presets[n]);
  if (unknown.length) {
    throw new Error(`未知预设: ${unknown.join(", ")}（可选: ${Object.keys(presets.presets).join(", ")}, all）`);
  }
  const limit = Number.parseInt(String(flags.n ?? names.length), 10);
  const selected = names.slice(0, Number.isFinite(limit) && limit > 0 ? limit : names.length);

  const cfg = await loadConfig();
  const apiKey = cfg?.image?.arkApiKey?.trim() || "";
  const model = String(flags.model || cfg?.image?.model || DEFAULT_MODEL);
  const apiUrl = String(flags["base-url"] || cfg?.image?.baseUrl || ARK_URL);
  const size = String(flags.size || DEFAULT_SIZE);
  const promoText = flags.text ? String(flags.text) : "";
  const dry = flags.dry === true;

  if (!dry && !apiKey) {
    throw new Error(
      "缺少 API key：请在 local.config.json 里加 { \"image\": { \"arkApiKey\": \"...\" } }（火山方舟控制台获取）"
    );
  }
  if (!positional.length) {
    throw new Error("缺少主图路径。用法: run fission <主图路径> [--preset all] [--text 文案] [--dry]");
  }

  const imagePath = await resolveImagePath(positional[0]);
  const b64 = await readFile(imagePath).then((b) => b.toString("base64"));
  const imageDataUrl = `data:${mimeOf(imagePath)};base64,${b64}`;
  log(`主图: ${imagePath}（${(b64.length * 3 / 4 / 1024).toFixed(0)} KB）`);

  const outDir = path.join(DATA_DIR, nowTs().slice(0, 10), nowTs().slice(11).replace(/:/g, ""));
  if (!dry) await mkdir(outDir, { recursive: true });
  lines.push(`模型: ${model} | 尺寸: ${size} | 预设: ${selected.join(", ")}${promoText ? ` | 文案: ${promoText}` : ""}`);
  lines.push(`接口: ${new URL(apiUrl).host}${new URL(apiUrl).pathname}`);

  let okCount = 0;
  for (let i = 0; i < selected.length; i++) {
    const name = selected[i];
    const preset = presets.presets[name];
    const prompt = buildPrompt(preset.scene, promoText);
    const outFile = path.join(outDir, `variant-${String(i + 1).padStart(2, "0")}-${name}.png`);

    if (dry) {
      log(`[dry] ${name}: prompt=${prompt.slice(0, 80)}... → ${outFile}`);
      lines.push(`[dry] ${preset.label}: 请求已构造（未发送）`);
      continue;
    }

    log(`(${i + 1}/${selected.length}) 生成 ${preset.label} ...`);
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = await generate({ apiKey, model, prompt, imageDataUrl, size, url: apiUrl });
        const bytes = await downloadTo(url, outFile);
        okCount += 1;
        lastErr = null;
        log(`✅ ${outFile}（${(bytes / 1024).toFixed(0)} KB）`);
        lines.push(`✅ ${preset.label}: ${path.relative(REPO_ROOT, outFile)}（${(bytes / 1024).toFixed(0)} KB）`);
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) {
          log(`  ↻ ${name} 重试 ${attempt + 1}/2：${String(e.message).slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
    if (lastErr) {
      log(`❌ ${name}: ${lastErr.message}`);
      lines.push(`❌ ${preset.label}: ${String(lastErr.message).slice(0, 200)}`);
    }
  }

  lines.push(`产物目录: ${dry ? "(dry 未生成)" : path.relative(REPO_ROOT, outDir)}`);
  lines.push(`成功 ${okCount}/${selected.length} 张${dry ? "（dry 模式，未实际调用 API）" : `（约 ¥${(okCount * 0.2).toFixed(1)}）`}`);

  const ok = dry || okCount === selected.length;
  await writeReport("image-fission", ok, lines);
  console.log(lines.join("\n"));
}

try {
  await main();
} catch (e) {
  log(`❌ ${e.message}`);
  await writeReport("image-fission", false, [e.message.slice(0, 300)]).catch(() => {});
  process.exitCode = 1;
}
