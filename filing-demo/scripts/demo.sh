#!/usr/bin/env bash
# 一键演示：启动门户与核对服务 → 重置并预置场景 → 运行自动填写程序
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

PORTAL_URL="${PORTAL_URL:-http://127.0.0.1:4101}"
VERIFIER_URL="${VERIFIER_URL:-http://127.0.0.1:4102}"

if ! curl -sf "$PORTAL_URL/api/health" >/dev/null 2>&1; then
  echo "启动门户…"
  nohup node portal/server.js > data/portal.log 2>&1 &
  echo $! > data/portal.pid
fi
if ! curl -sf "$VERIFIER_URL/api/health" >/dev/null 2>&1; then
  echo "启动核对服务…"
  nohup node verifier/server.js > data/verifier.log 2>&1 &
  echo $! > data/verifier.pid
fi

for i in $(seq 1 40); do
  if curl -sf "$PORTAL_URL/api/health" >/dev/null 2>&1 && curl -sf "$VERIFIER_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "重置场景数据…"
node scripts/seed.mjs

echo "运行自动填写程序（账号 alpha）…"
node automation/run.js --account alpha "$@"

echo ""
echo "======================================================"
echo " 门户（人工视角）:   $PORTAL_URL   (alpha / demo1234)"
echo " 结果看板（核对侧）: $VERIFIER_URL"
echo " 停止服务:           npm run stop"
echo "======================================================"
