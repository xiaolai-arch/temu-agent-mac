# -*- coding: utf-8 -*-
import requests, sys, time
sys.stdout.reconfigure(encoding="utf-8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
s = requests.Session()
s.headers.update({
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})
# 1) 首页
r1 = s.get("https://www.aliexpress.com/", timeout=25)
print("home:", r1.status_code, len(r1.text), "wall:", "login_jump" in r1.text or "_____tmd_____" in r1.text)
print("cookies:", list(s.cookies.keys()))
time.sleep(1.5)
# 2) 带会话搜索
r2 = s.get("https://www.aliexpress.com/w/wholesale-custom-napkins.html", timeout=25)
t = r2.text
print("search:", r2.status_code, len(t), "wall:", "login_jump" in t or "_____tmd_____" in t, "runParams:", "runParams" in t)
