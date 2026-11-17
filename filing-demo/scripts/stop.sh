#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for name in portal verifier; do
  pidfile="data/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" && echo "已停止 $name ($(cat "$pidfile"))"
  fi
  rm -f "$pidfile"
done
