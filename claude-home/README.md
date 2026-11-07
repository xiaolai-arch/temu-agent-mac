# claude-home — temu-agent 专属 claude 配置

给 temu-agent 的 `claude` CLI 一个**独立的供应商配置**，与全局
`~/.claude`（cc-switch 管理的 DeepSeek 中转）完全隔离，互不抢额度。

## 启用（一次性，1 分钟）

1. `cp settings.example.json settings.json`
2. 编辑 `settings.json`：
   - `ANTHROPIC_AUTH_TOKEN` 换成你的真实 key
   - `ANTHROPIC_BASE_URL` / 模型名按你的供应商改：
     - **Z.ai GLM**（Anthropic 兼容端点）：`https://api.z.ai/api/anthropic`，
       模型 `glm-5.3` / 快模型 `glm-5.3-flash`
     - **DeepSeek 官方**：`https://api.deepseek.com/anthropic`，
       模型 `deepseek-chat` / `deepseek-chat`
     - **官方 Anthropic**：删掉 `ANTHROPIC_BASE_URL` 行，只留 key
3. 冒烟测试（不用等定时任务）：

   ```bash
   CLAUDE_CONFIG_DIR="$PWD/claude-home" claude -p "回复 ok 两个字母即可" --output-format text
   ```

## 生效机制

- `plugin/temu-panel/server.mjs` 与 `bin/daily-sync-check.sh` 在 spawn
  `claude` 前检测本目录的 `settings.json`：存在且 token 非空 → 注入
  `CLAUDE_CONFIG_DIR` 指向本目录；否则维持全局配置（现状不变）。
- `settings.json` 已 gitignore；`settings.example.json` 入库作为模板。
- 回滚：删掉 `settings.json` 即回到全局配置。

## 红线

key 只存本目录 `settings.json`（gitignored），不进代码、日志、报告。
