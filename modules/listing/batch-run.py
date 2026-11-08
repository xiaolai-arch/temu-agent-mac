#!/usr/bin/env python3
"""整夜批量上新驱动：按 erp-batch-plan.json 中 pending 的 idx 依次
下载主图 → 裂变 → 资产准备 → ego 填表创建 → 更新账本。

用法:
  python3 modules/listing/batch-run.py [--limit N] [--start IDX] [--dry-run]

安全：
- 遇到 ego「Control of this task space is with the user」立即整体停止（用户接管浏览器）。
- 单个商品失败记 failed 并继续下一个；连续 3 个失败则停止，等人工检查。
- 每步日志落 logs/batch-<date>.log；单商品 ego 输出落 logs/batch-<date>/<idx>.log。
"""
import json, os, re, shutil, subprocess, sys, time
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen, Request

ROOT = Path(__file__).resolve().parent.parent.parent
PLAN = Path(os.environ.get("LISTING_PLAN", ROOT / "modules/listing/data/erp-batch-plan.json"))
BASE = Path(os.environ.get("LISTING_BATCH_BASE", ROOT / "modules/listing/data/erp-batch"))
FILL = ROOT / "modules/listing/batch-fill-one.mjs"
PREP = ROOT / "modules/listing/batch-prep.py"
PY = ROOT / ".venv/bin/python"
EGO = "ego-browser"

DATE = datetime.now().strftime("%Y-%m-%d")
LOGDIR = ROOT / "logs" / f"batch-{DATE}"
LOGDIR.mkdir(parents=True, exist_ok=True)
BATCHLOG = ROOT / "logs" / f"batch-{DATE}.log"


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with BATCHLOG.open("a") as f:
        f.write(line + "\n")


def load_plan():
    return json.loads(PLAN.read_text())


def save_plan(plan):
    PLAN.write_text(json.dumps(plan, ensure_ascii=False, indent=1))


def update(plan, idx, **kw):
    for rec in plan:
        if rec["idx"] == idx:
            rec.update(kw)
            rec["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
            break
    save_plan(plan)


def download_main(rec):
    out = BASE / f"{rec['idx']:02d}" / "main.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_size > 10000:
        return out
    # 采集商品库：优先用本地已下载主图（imgFile），无需再下载
    local = rec.get("imgFile")
    if local:
        src = Path(local)
        if not src.is_absolute():
            src = ROOT / src
        if src.exists() and src.stat().st_size > 5000:
            shutil.copyfile(src, out)
            return out
    req = Request(rec["imgHi"], headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": "https://www.aliexpress.com/",
    })
    last = None
    for attempt in range(3):
        try:
            data = urlopen(req, timeout=60).read()
            break
        except Exception as e:
            last = e
            time.sleep(20 * (attempt + 1))
    else:
        raise RuntimeError(f"main image download failed: {last}")
    if len(data) < 5000:
        raise RuntimeError(f"main image too small: {len(data)}")
    out.write_bytes(data)
    return out


def run_fission(main):
    p = subprocess.run(
        [str(ROOT / "run"), "fission", str(main), "--preset", "all"],
        capture_output=True, text=True, cwd=str(ROOT), timeout=600,
    )
    out = p.stdout + "\n" + p.stderr
    m = re.search(r"产物目录:\s*(\S+)", out)
    if p.returncode != 0 or not m:
        raise RuntimeError("fission failed: " + out[-400:])
    d = Path(m.group(1))
    if not d.is_absolute():
        d = ROOT / d
    # 校验 5 张
    need = ["variant-01-white.png", "variant-02-home.png", "variant-03-model.png",
            "variant-04-detail.png", "variant-05-promo.png"]
    missing = [n for n in need if not (d / n).exists()]
    if missing:
        raise RuntimeError(f"fission missing {missing}")
    return d


def run_prep(idx, fission_dir):
    p = subprocess.run(
        [str(PY), str(PREP), str(idx), str(fission_dir)],
        capture_output=True, text=True, cwd=str(ROOT), timeout=120,
    )
    if p.returncode != 0:
        raise RuntimeError("prep failed: " + (p.stdout + p.stderr)[-300:])
    return p.stdout.strip()


def run_fill(idx):
    """返回 (result_dict|None, raw_output, takeover)"""
    outpath = LOGDIR / f"{idx:02d}.log"
    with FILL.open("rb") as fin, outpath.open("wb") as fout:
        p = subprocess.Popen([EGO, "nodejs"], stdin=fin, stdout=fout,
                             stderr=subprocess.STDOUT, cwd=str(ROOT))
        try:
            p.wait(timeout=1800)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            raise RuntimeError("fill timeout 30min")
    raw = outpath.read_text(errors="replace")
    takeover = "Control of this task space is with the user" in raw or "control of this task space is with the user" in raw.lower()
    result = None
    for line in raw.splitlines()[::-1]:
        if line.startswith("RESULT "):
            try:
                result = json.loads(line[len("RESULT "):])
            except Exception:
                pass
            break
    return result, raw, takeover


def main():
    args = sys.argv[1:]
    limit = None
    start = None
    dry = "--dry-run" in args
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--start" in args:
        start = int(args[args.index("--start") + 1])

    plan = load_plan()
    pending = [r for r in plan if r.get("status") != "done"]
    pending.sort(key=lambda r: r["idx"])
    if start is not None:
        pending = [r for r in pending if r["idx"] >= start]
    if limit:
        pending = pending[:limit]
    log(f"batch start: {len(pending)} pending -> {[r['idx'] for r in pending][:20]}")

    fails_in_row = 0
    for rec in pending:
        idx = rec["idx"]
        log(f"=== idx {idx}: {rec['title'][:40]}")
        if dry:
            log("dry-run: skip")
            continue
        t0 = time.time()
        try:
            main_img = download_main(rec)
            log(f"[{idx}] main image ok ({main_img.stat().st_size} bytes)")
            fission_dir = run_fission(main_img)
            log(f"[{idx}] fission ok: {fission_dir}")
            prep_out = run_prep(idx, fission_dir)
            log(f"[{idx}] prep ok")
            result, raw, takeover = run_fill(idx)
            if takeover:
                log("STOP: user took control of the task space")
                save_plan(plan)
                sys.exit(3)
            if result is None:
                raise RuntimeError("no RESULT line from fill script")
            if result.get("ok"):
                update(plan, idx, status="done", draftId=result.get("draftId"),
                       spu=result.get("draftId"), skc=result.get("skc"),
                       skus=result.get("skus"), error=None)
                fails_in_row = 0
                log(f"[{idx}] DONE spu={result.get('draftId')} skc={result.get('skc')} skus={result.get('skus')} ({int(time.time()-t0)}s)")
            else:
                raise RuntimeError(result.get("error") or "unknown fill error")
        except Exception as e:
            fails_in_row += 1
            err = str(e)[:300]
            update(plan, idx, status="failed", error=err)
            log(f"[{idx}] FAILED: {err}")
            if fails_in_row >= 3:
                log("STOP: 3 consecutive failures — need human check")
                save_plan(plan)
                sys.exit(4)
        time.sleep(2)

    done = sum(1 for r in plan if r.get("status") == "done")
    failed = [r["idx"] for r in plan if r.get("status") == "failed"]
    left = [r["idx"] for r in plan if r.get("status") not in ("done", "failed")]
    log(f"batch finished: done={done} failed={failed} left={left}")


if __name__ == "__main__":
    main()