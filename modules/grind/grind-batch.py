#!/usr/bin/env python3
"""批量调价调度（Mac/ego-browser 版）：读工单 CSV（按倍数降序），逐个跑
modules/grind/grind-one.mjs，断点续跑。移植自 driver/grind_batch.py，调度纪律不变：
- done 文件 modules/grind/data/adjust-done-<日期>.txt 记录 skc/rc/说明/输出尾行
- rc=0 提交成功；rc=3 表示 0 行可调（现价已被平台调平/作废），均算完成
- 连续 8 个失败（rc=1/2/9）自动停止——大概率浏览器状态坏了（弹窗/登录/插件开关）
- 每个超时 600s；CSV 无关键字列，grind-one 靠弹窗 SKC-ID 匹配
⚠ 改数据任务：运行前需用户在对话中明确确认。

用法: python3 modules/grind/grind-batch.py <worklist.csv> [--limit N] [--cat 派对餐巾]
"""
import csv
import os
import subprocess
import sys
import time
from datetime import date

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, "..", ".."))
DATA = os.path.join(ROOT, "modules", "grind", "data")
RUN = os.path.join(ROOT, "run")


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    wl = sys.argv[1]
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 10 ** 9
    cat = sys.argv[sys.argv.index("--cat") + 1] if "--cat" in sys.argv else "派对餐巾"
    if not os.path.isfile(wl):
        sys.exit(f"工单不存在: {wl}")

    # done 文件按工单区分（不同店铺/批次的工单互不污染；旧版按日期共用一个文件是坑）
    stem = os.path.splitext(os.path.basename(wl))[0].replace("adjust-todo-", "")
    done_path = os.path.join(DATA, f"adjust-done-{stem}-{date.today()}.txt")
    done = set()
    fail_count = {}
    try:
        for line in open(done_path, encoding="utf-8"):
            parts = line.strip().split("\t")
            # 只有 0（提交成功）/3（0行可调）算完成；1/2/9 失败下轮重试
            if parts and parts[1] in ("0", "3"):
                done.add(parts[0])
            elif parts and parts[0]:
                fail_count[parts[0]] = fail_count.get(parts[0], 0) + 1
    except FileNotFoundError:
        pass
    # 失败 ≥2 次的 SKC 隔离（大弹窗会被应用整体重置回服务端状态——2026-10-24 实测，
    # 反复重试零收益且空耗批次时间），留待人工/API 通道处理
    quarantined = {s for s, n in fail_count.items() if n >= 2 and s not in done}

    rows = list(csv.DictReader(open(wl, encoding="utf-8-sig")))
    skcs = []
    for r in rows:
        s = str(r["SKC"])
        if s not in skcs:
            skcs.append(s)
    sug_of = {str(r["SKC"]): str(r.get("建议价", "")) for r in rows}
    todo = [s for s in skcs if s not in done and s not in quarantined]
    log(f"工单共 {len(skcs)} SKC，已完成 {len(done & set(skcs))}，隔离 {len(quarantined & set(skcs))}（失败≥3次），本次待跑 {min(len(todo), limit)}")

    consec_fail = 0
    ran = ok = noop = fail = 0
    with open(done_path, "a", encoding="utf-8") as df:
        for s in todo:
            if ran >= limit:
                log(f"达到本次 limit={limit}，停止")
                break
            if consec_fail >= 8:
                log("连续 8 次失败，停止（人工检查浏览器状态/登录态/插件）")
                break
            log(f"== [{ran + 1}/{len(todo)}] SKC {s}")
            cmd = [RUN, "grind-one", s]
            if sug_of.get(s):
                cmd += ["--ref", sug_of[s]]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
                rc, out = p.returncode, (p.stdout or "") + (p.stderr or "")
            except subprocess.TimeoutExpired:
                rc, out = 9, "(timeout 600s)"
            tail = " | ".join(l.strip() for l in out.strip().splitlines()[-2:]) if out.strip() else ""
            note = {0: "OK", 2: "未找到目标", 3: "0行可调"}.get(rc, f"rc={rc}")
            df.write(f"{s}\t{rc}\t{note}\t{tail[:150]}\n")
            df.flush()
            log(f"   -> {note}  {tail[:110]}")
            ran += 1
            if rc in (0, 3):
                consec_fail = 0
                ok += rc == 0
                noop += rc == 3
            else:
                consec_fail += 1
                fail += 1
                if "task space" in tail.lower() or "control" in tail.lower():
                    log("   ✗ ego 浏览器被用户接管/不可用，停止（勿在批量运行时使用浏览器）")
                    break
    log(f"批次结束：成功 {ok}，0行可调 {noop}，失败 {fail}")


if __name__ == "__main__":
    main()
