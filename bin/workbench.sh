#!/bin/zsh
# 一键启动独立工作台（Windows 旧版 bin/workbench.cmd 的 Mac 等价物）
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PORT="${1:-3790}"
open "http://127.0.0.1:${PORT}"
node "${ROOT}/plugin/temu-panel/server.mjs" --port "${PORT}"
