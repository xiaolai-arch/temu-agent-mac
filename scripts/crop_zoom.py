"""裁剪+放大截图局部，便于视觉核对（OCR 盲区/白字按钮）。

用法:
  python scripts/crop_zoom.py <src.png> <out.png> <x1> <y1> <x2> <y2> [scale]

示例:
  python scripts/crop_zoom.py screenshots/a.png screenshots/a-crop.png 1050 1455 2010 1535 2
"""
import sys
from PIL import Image


def main():
    src, dst = sys.argv[1], sys.argv[2]
    x1, y1, x2, y2 = map(int, sys.argv[3:7])
    scale = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
    img = Image.open(src).crop((x1, y1, x2, y2))
    w, h = img.size
    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    img.save(dst)
    print(f"{dst} ({w}x{h} -> {img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
