#!/bin/bash
# 推上 Google Apps Script
#
# 前置：
#   1) 已執行 `npx @google/clasp login`（token 只存本機 ~/.clasprc.json）
#   2) 已把 .clasp.json.tmpl 改名為 .clasp.json 並填入你的 scriptId
#
# 用法：
#   ./deploy.sh                 只 push（更新雲端 HEAD，不碰既有部署）
#   ./deploy.sh <deploymentId>  push + redeploy（更新既有部署，**原 /exec 網址不變**）
#
# ❗clasp v3 的 `deploy` 是「建立新部署」→ 會產生**新 /exec 網址**，手機舊網址不會更新！
#   更新既有部署請用 `redeploy <deploymentId>`。
set -e
cd "$(dirname "$0")"

npx @google/clasp push --force

if [ -n "$1" ]; then
  npx @google/clasp redeploy "$1"
else
  echo "（未指定 deploymentId → 只 push，未更新任何部署）"
  echo "要更新既有部署請執行：./deploy.sh <你的deploymentId>"
fi
