#!/usr/bin/env python3
"""批量上新资产准备：把某商品的主图裂变产物整理成带编号的上传素材，
生成独立尺寸图与包装图（避免素材中心内容去重），并写 ego 配置 JSON。

用法:
  .venv/bin/python modules/listing/batch-prep.py <idx> <fission_dir> [--no-config]
"""
import json, os, sys, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent.parent
PLAN = Path(os.environ.get("LISTING_PLAN", ROOT / "modules/listing/data/erp-batch-plan.json"))
BASE = Path(os.environ.get("LISTING_BATCH_BASE", ROOT / "modules/listing/data/erp-batch"))
SIZE_SRC = ROOT / "modules/image/data/2026-11-07/party-napkin/03-size.png"
PKG_SRC = ROOT / "modules/image/data/2026-11-07/party-napkin/packaging"
CFG_OUT = Path("/tmp/ego-batch-current.json")


def font(size):
    for p in ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def main():
    idx = int(sys.argv[1])
    fission_dir = Path(sys.argv[2])
    no_config = "--no-config" in sys.argv
    plan = {x["idx"]: x for x in json.loads(PLAN.read_text())}
    p = plan[idx]
    work = BASE / f"{idx:02d}"
    carousel = work / "carousel"
    pkg = work / "packaging"
    carousel.mkdir(parents=True, exist_ok=True)
    pkg.mkdir(parents=True, exist_ok=True)

    # 1) 裂变图带编号复制
    names = {
        "variant-01-white.png": f"p{idx:02d}-variant-01-white.png",
        "variant-02-home.png": f"p{idx:02d}-variant-02-home.png",
        "variant-04-detail.png": f"p{idx:02d}-variant-04-detail.png",
        "variant-03-model.png": f"p{idx:02d}-variant-03-model.png",
    }
    for src, dst in names.items():
        s = fission_dir / src
        if not s.exists():
            raise SystemExit(f"missing fission file: {s}")
        shutil.copyfile(s, carousel / dst)

    # 2) 每商品独立尺寸图（加微小批次号规避内容去重）
    im = Image.open(SIZE_SRC).convert("RGB")
    d = ImageDraw.Draw(im)
    d.text((14, im.height - 40), f"B{idx:02d}", fill=(124, 139, 111), font=font(28))
    im.save(carousel / f"p{idx:02d}-size.png")

    # 3) 每商品独立包装图
    for i, name in enumerate(["box-01.png", "box-02.png", "box-03.png"], 1):
        im = Image.open(PKG_SRC / name).convert("RGB")
        d = ImageDraw.Draw(im)
        d.text((6, 6), f"B{idx:03d}{i}", fill=(250, 250, 249))
        im.save(pkg / name)

    # 4) ego 配置
    ladder = p["ladder"]
    cfg = {
        "idx": idx,
        "title": p["title"],
        "names": p["names"],
        "theme": p["theme"],
        "holiday": p["attributes"]["holiday"],
        "occasions": p["attributes"]["occasions"],
        "ladder": ladder,
        "carousel": [
            str(carousel / f"p{idx:02d}-variant-01-white.png"),
            str(carousel / f"p{idx:02d}-variant-02-home.png"),
            str(carousel / f"p{idx:02d}-size.png"),
            str(carousel / f"p{idx:02d}-variant-04-detail.png"),
            str(carousel / f"p{idx:02d}-variant-03-model.png"),
        ],
        "previewStem": f"p{idx:02d}-variant-01-white",
        "sizeStem": f"p{idx:02d}-size",
        "carouselStems": [
            f"p{idx:02d}-variant-01-white",
            f"p{idx:02d}-variant-02-home",
            f"p{idx:02d}-size",
            f"p{idx:02d}-variant-04-detail",
            f"p{idx:02d}-variant-03-model",
        ],
        "packaging": [str(pkg / "box-01.png"), str(pkg / "box-02.png"), str(pkg / "box-03.png")],
    }
    if not no_config:
        CFG_OUT.write_text(json.dumps(cfg, ensure_ascii=False, indent=1))
        print(f"prepared idx {idx}: {carousel} / config -> {CFG_OUT}")
    else:
        print(f"prepared idx {idx} assets only")


if __name__ == "__main__":
    main()