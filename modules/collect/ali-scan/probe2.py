# -*- coding: utf-8 -*-
import requests, sys
sys.stdout.reconfigure(encoding="utf-8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
     "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
     "Referer": "https://www.aliexpress.com/"}
s = requests.Session()
s.headers.update(H)
variants = [
    "https://www.aliexpress.us/wholesale?SearchText=custom+napkins",
    "https://www.aliexpress.com/w/wholesale-custom-napkins.html",
    "https://www.aliexpress.com/wholesale?SearchText=custom+napkins",
]
for u in variants:
    try:
        r = s.get(u, timeout=25, allow_redirects=True)
        t = r.text
        print(u, "->", r.status_code, len(t), "runParams" in t, "punish" in t.lower() or "captcha" in t.lower() or "verify" in t.lower())
    except Exception as e:
        print(u, "ERR", e)
