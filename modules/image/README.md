# modules/image — 生图：主图裂变

**一张商品主图 → N 张场景/风格变体**（白底精修、家居、模特、户外、节日、促销
Banner……），基于火山方舟 Seedream 图生图 API。

## 用法

```bash
run fission <主图路径>                    # 默认 5 张（每产品 5 张）
run fission main.png --preset home,promo --text "限时立减30%"
run fission main.png --preset promo --text "黑五5折" --size 1024x1024   # 默认 1K；需要大图再覆盖
run fission main.png --dry                # 只构造请求不发送（无 key 也能测）
run fission                               # --help
```

产物写在本模块 `data/<日期>/<时间>/variant-NN-<preset>.png`，每次运行结束写
`logs/last-status.json`（面板可展示）。

## 预设

见 `presets.json`。默认 `all` = white, home, model, detail, promo（5 张）；
outdoor（户外）、festival（节日）、flatlay（平铺）可按名选。想加场景就往 presets.json 里添。

## 配置（一次性）

`local.config.json` 加一段（key 在火山方舟控制台获取；Seedream 5.0 flash 1K 约 ¥0.12/张）：

```json
{
  "image": {
    "arkApiKey": "你的火山方舟 API key",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    "model": "doubao-seedream-5.0-flash"
  }
}
```

## 一致性（裂变的生死线）

每个变体的 prompt 都以同一段**一致性红线**开头：商品的外观/颜色/材质/logo/
比例不得改变，只允许重新生成背景与场景。即使如此，复杂商品（印花、异形）仍
建议人工抽查每张图，**有货不对板的图绝不上架**。

## 红线

- 不触碰 TEMU 后台任何数据：本模块零浏览器交互、零店铺读写。
- 只做"裂变"，不做"上新"：生成图只落 `data/`，选图、上传、上架由人工完成。
- key 只存 `local.config.json`（gitignored），不进代码、日志、报告。
