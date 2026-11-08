# modules/listing — 上新（Agent 实时接管）

**不是一键填表脚本。** 本模块只提供 agent 在现场驾驶 ego 浏览器时用的原子操作；
名称、属性、规格、价格、工艺、报关类型等判断，由 agent 按
`.claude/skills/temu-listing/SKILL.md` 实时推理。

## 组成

| 文件 | 作用 |
|---|---|
| `.claude/skills/temu-listing/SKILL.md` | **主入口**：操作流程 + 推理规则 + 验证/检查点/坑速查 |
| `helpers.mjs` | 原子操作：找元素、真实点击、React 输入、单选/复选/标签、读错误/弹窗 |
| `../../lib/common.mjs` | 通用层：TaskSpace 引导、`clickButton`、`closeModals`、截图、报告 |

## 在 ego 脚本里使用

```js
const c = await import("file:///Users/Admin/PycharmProjects/temu-agent-mac/lib/common.mjs");
const h = await import("file:///Users/Admin/PycharmProjects/temu-agent-mac/modules/listing/helpers.mjs");
const { task, page } = await c.boot();          // 固定 TaskSpace temu-agent / p1

await h.setReactInput(page, '#someInput', "值");  // 真实键盘输入，触发 React
await h.clickText(page, "创建", { tag: "BUTTON" });
console.log(await h.visibleErrors(page));
console.log(await h.visibleDialogs(page));
```

## 红线

- 推理字段由 agent 自己填、自己验；不逐项打断用户。
- 创建/上架、定制信息保存、库存提交等写操作按 skill 检查点确认。
- 验证码永远人工；用户接管浏览器即硬停。
- 不虚构属性/材质/认证；没有如实选项就留空并记录原因。

## 与其他模块的关系

```
store（切店）→ sync（体检）→ image（生图）→ listing（Agent 实时上新）
                                      ↑ grind/suggested-prices.csv（定价参考）
```