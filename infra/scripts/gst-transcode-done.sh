#!/usr/bin/env bash
# /var/www/msp/scripts/gst-transcode-done.sh
set -euo pipefail
STREAM_KEY="${1:?}"
NODE_URL="http://127.0.0.1:3001"
HLS_ROOT="${HLS_ROOT:-/var/www/msp/live}"
LOG_DIR="/var/log/msp"

exec >> "${LOG_DIR}/gst-${STREAM_KEY}.log" 2>&1
echo "[$(date -u +%FT%TZ)] gst-transcode-done.sh key=${STREAM_KEY}"

RESPONSE=$(curl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"streamKey\":\"${STREAM_KEY}\"}" "${NODE_URL}/api/rtmp-done" 2>/dev/null || echo '{}')
SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sessionId',''))" 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ]; then
  PID_FILE="${HLS_ROOT}/${SESSION_ID}/.gst.pid"
  if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
      kill -0 "$pid" 2>/dev/null && kill -SIGINT "$pid" 2>/dev/null \
        && echo "[$(date -u +%FT%TZ)] SIGINT → PID ${pid}" || true
    done < "$PID_FILE"
    sleep 8
    while IFS= read -r pid; do
      kill -0 "$pid" 2>/dev/null && kill -SIGKILL "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
fi
echo "[$(date -u +%FT%TZ)] done"
