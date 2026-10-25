"""打印 screenshots/ 下匹配子串的最新 PNG 路径（供 bash $() 拼接用）。

用法: python scripts/latest.py <substr>
"""
import glob
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sub = sys.argv[1]
cands = sorted(glob.glob(os.path.join(BASE, "screenshots", f"*{sub}*.png")))
if not cands:
    sys.exit(f"没有匹配 {sub} 的截图")
print(cands[-1])
