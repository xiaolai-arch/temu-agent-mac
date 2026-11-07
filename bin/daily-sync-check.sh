#!/bin/zsh
# 每日同步体检（launchd/cron 可调用；也可手动跑）
# Windows 旧版 bin/daily-sync-check.cmd 的 Mac 等价物。
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "${ROOT}/logs"
cd "${ROOT}"

# 专属供应商配置（见 claude-home/README.md）：settings.json 存在、token 非空且非占位符才启用隔离
CLAUDE_HOME="${ROOT}/claude-home"
if [[ -s "${CLAUDE_HOME}/settings.json" ]] \
   && grep -Eq '"ANTHROPIC_AUTH_TOKEN"[[:space:]]*:[[:space:]]*"[^"]' "${CLAUDE_HOME}/settings.json" \
   && ! grep -q '粘贴' "${CLAUDE_HOME}/settings.json"; then
  export CLAUDE_CONFIG_DIR="${CLAUDE_HOME}"
fi
claude -p "按照 .claude/skills/temu-sync-check/SKILL.md 执行每日同步体检（只读），完成后简短汇报结论。" \
  --permission-mode bypassPermissions --output-format text \
  >> "logs/daily-scheduled.log" 2>&1
