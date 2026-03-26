#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  /var/www/msp/scripts/gst-transcode.sh
#
#  Called by nginx-rtmp exec_publish when a creator's stream is accepted.
#  Receives: $1 = stream key, $2 = mode (optional, default 'production')
#
#  Workflow:
#    1. POST /api/rtmp-publish → get sessionId, qualities, mode
#    2. Create HLS output directory
#    3. Detect best encoder (NVENC → VAAPI → software)
#    4. Launch appropriate GStreamer pipeline:
#       production → tee-based multi-bitrate (the monster)
#       social     → bare-bones single quality
#    5. Write master.m3u8
#    6. POST /api/rtmp-live-ready → notify Node.js
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

STREAM_KEY="${1:?Stream key required}"
FORCE_MODE="${2:-}"    # optional: 'social' if called from /social app
NODE_URL="http://127.0.0.1:3001"
HLS_ROOT="${HLS_ROOT:-/var/www/msp/live}"
LOG_DIR="/var/log/msp"

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/gst-${STREAM_KEY}.log"
exec >> "$LOG_FILE" 2>&1
echo "[$(date -u +%FT%TZ)] gst-transcode.sh START key=${STREAM_KEY} force_mode=${FORCE_MODE}"

# ── 1. Register with Node.js ─────────────────────────────────────────────────
PAYLOAD="{\"streamKey\":\"${STREAM_KEY}\"$([ -n \"$FORCE_MODE\" ] && echo ",\"mode\":\"$FORCE_MODE\"" || echo '')}"
RESPONSE=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" \
  "${NODE_URL}/api/rtmp-publish" 2>/dev/null || echo '{}')

SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sessionId',''))" 2>/dev/null || echo "")
MODE=$(echo "$RESPONSE"       | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('mode','production'))" 2>/dev/null || echo "production")
AUDIO_ONLY=$(echo "$RESPONSE" | python3 -c "import sys,json;d=json.load(sys.stdin);print('1' if d.get('audioOnly') else '0')" 2>/dev/null || echo "0")
QUALS=$(echo "$RESPONSE"      | python3 -c "import sys,json;d=json.load(sys.stdin);print(','.join(d.get('qualities',['720p','480p'])))" 2>/dev/null || echo "720p,480p")

[ -z "$SESSION_ID" ] && { echo "ERROR: no sessionId from Node.js"; exit 1; }
echo "[$(date -u +%FT%TZ)] session=${SESSION_ID} mode=${MODE} audioOnly=${AUDIO_ONLY} quals=${QUALS}"

HLS_DIR="${HLS_ROOT}/${SESSION_ID}"
mkdir -p "$HLS_DIR"
PID_FILE="${HLS_DIR}/.gst.pid"
RTMP_URL="rtmp://127.0.0.1:1935/live/${STREAM_KEY}"
GST="${GST_LAUNCH_PATH:-gst-launch-1.0}"

# ── 2. Detect video encoder ──────────────────────────────────────────────────
detect_encoder() {
  if gst-inspect-1.0 nvh264enc    >/dev/null 2>&1; then echo "nvh264enc";    return; fi
  if gst-inspect-1.0 vaapih264enc >/dev/null 2>&1; then echo "vaapih264enc"; return; fi
  if gst-inspect-1.0 vtenc_h264   >/dev/null 2>&1; then echo "vtenc_h264";   return; fi
  echo "x264enc"
}

VIDEO_ENC=$(detect_encoder)
echo "[$(date -u +%FT%TZ)] encoder: ${VIDEO_ENC}"

# Build encoder element string
enc_str() {
  local enc="$1" kbps="$2"
  case "$enc" in
    nvh264enc)    echo "nvh264enc bitrate=${kbps} rc-mode=cbr preset=low-latency ! h264parse" ;;
    vaapih264enc) echo "vaapivpp ! vaapih264enc rate-control=cbr bitrate=${kbps} ! h264parse" ;;
    vtenc_h264)   echo "vtenc_h264 bitrate=${kbps} realtime=true ! h264parse" ;;
    *)            echo "x264enc bitrate=${kbps} speed-preset=ultrafast tune=zerolatency key-int-max=30 ! h264parse" ;;
  esac
}

PIDS=()

# ── 3a. SOCIAL mode pipeline  ────────────────────────────────────────────────
#  Single quality, 1s segments, ephemeral
launch_social() {
  local w=854 h=480 vbr=1200
  echo "[$(date -u +%FT%TZ)] SOCIAL pipeline: ${w}x${h} ${vbr}kbps"

  if [ "$AUDIO_ONLY" = "1" ]; then
    "$GST" -e \
      "rtmpsrc location=\"${RTMP_URL} live=1\" ! flvdemux name=d \
       d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample \
       ! avenc_aac bitrate=131072 compliance=-2 ! aacparse \
       ! hlssink2 location=\"${HLS_DIR}/stream_%05d.ts\" \
                  playlist-location=\"${HLS_DIR}/stream.m3u8\" \
                  target-duration=1 max-files=10" \
      >> "${LOG_DIR}/gst-${STREAM_KEY}-social-audio.log" 2>&1 &
    PIDS+=("$!")
  else
    local enc
    enc=$(enc_str "$VIDEO_ENC" "$vbr")
    "$GST" -e \
      "rtmpsrc location=\"${RTMP_URL} live=1\" ! flvdemux name=d \
       d. ! queue max-size-time=2000000000 ! h264parse ! avdec_h264 ! videoconvert \
       ! videoscale ! video/x-raw,width=${w},height=${h} \
       ! ${enc} \
       ! mpegtsmux name=mux \
       ! hlssink2 location=\"${HLS_DIR}/stream_%05d.ts\" \
                  playlist-location=\"${HLS_DIR}/stream.m3u8\" \
                  target-duration=1 max-files=10 \
       d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample \
       ! avenc_aac bitrate=131072 compliance=-2 ! aacparse ! mux." \
      >> "${LOG_DIR}/gst-${STREAM_KEY}-social.log" 2>&1 &
    PIDS+=("$!")
  fi

  cat > "${HLS_DIR}/master.m3u8" << EOF
#EXTM3U
#EXT-X-VERSION:3
$([ "$AUDIO_ONLY" = "1" ] && echo '#EXT-X-STREAM-INF:BANDWIDTH=131000,CODECS="mp4a.40.2"
stream.m3u8' || echo "#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=${w}x${h},CODECS=\"avc1.42e01e,mp4a.40.2\"
stream.m3u8")
EOF
}

# ── 3b. PRODUCTION mode pipeline  ────────────────────────────────────────────
#  Multi-bitrate tee fan-out, 2s segments
launch_production() {
  echo "[$(date -u +%FT%TZ)] PRODUCTION pipeline: quals=${QUALS} audioOnly=${AUDIO_ONLY}"

  if [ "$AUDIO_ONLY" = "1" ]; then
    # Multi-bitrate audio tee
    "$GST" -e \
      "rtmpsrc location=\"${RTMP_URL} live=1\" ! flvdemux name=d \
       d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample \
       ! audio/x-raw,rate=44100,channels=2 ! tee name=atee \
       atee. ! queue ! avenc_aac bitrate=320000 compliance=-2 ! aacparse \
       ! hlssink2 location=\"${HLS_DIR}/hi_%05d.ts\" \
                  playlist-location=\"${HLS_DIR}/hi.m3u8\" \
                  target-duration=2 max-files=16 \
       atee. ! queue ! avenc_aac bitrate=256000 compliance=-2 ! aacparse \
       ! hlssink2 location=\"${HLS_DIR}/mid_%05d.ts\" \
                  playlist-location=\"${HLS_DIR}/mid.m3u8\" \
                  target-duration=2 max-files=16 \
       atee. ! queue ! avenc_aac bitrate=128000 compliance=-2 ! aacparse \
       ! hlssink2 location=\"${HLS_DIR}/lo_%05d.ts\" \
                  playlist-location=\"${HLS_DIR}/lo.m3u8\" \
                  target-duration=2 max-files=16" \
      >> "${LOG_DIR}/gst-${STREAM_KEY}-prod-audio.log" 2>&1 &
    PIDS+=("$!")

    cat > "${HLS_DIR}/master.m3u8" << 'EOF'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
lo.m3u8
EOF
    return
  fi

  # ── Video tee pipeline ───────────────────────────────────────────────────
  # Build one giant GStreamer pipeline string with all rungs as branches of vtee
  local PIPELINE=""
  PIPELINE+="rtmpsrc location=\"${RTMP_URL} live=1\" ! flvdemux name=d "
  PIPELINE+="d. ! queue max-size-bytes=0 max-size-time=2000000000 "
  PIPELINE+="! h264parse ! avdec_h264 ! videoconvert ! videorate "
  PIPELINE+="! video/x-raw,framerate=30/1 ! tee name=vtee "
  PIPELINE+="d. ! queue max-size-bytes=0 max-size-time=2000000000 "
  PIPELINE+="! aacparse ! avdec_aac ! audioconvert ! audioresample "
  PIPELINE+="! audio/x-raw,rate=44100,channels=2 ! tee name=atee "

  local MASTER_LINES=("#EXTM3U" "#EXT-X-VERSION:3")

  IFS=',' read -ra QUALITY_LIST <<< "$QUALS"
  for q in "${QUALITY_LIST[@]}"; do
    local w h vbr abr bw
    case "$q" in
      1080p) w=1920; h=1080; vbr=4500; abr=192; bw=4700000 ;;
      720p)  w=1280; h=720;  vbr=2800; abr=128; bw=2950000 ;;
      480p)  w=854;  h=480;  vbr=1400; abr=128; bw=1550000 ;;
      360p)  w=640;  h=360;  vbr=700;  abr=96;  bw=810000  ;;
      *) continue ;;
    esac

    local enc
    enc=$(enc_str "$VIDEO_ENC" "$vbr")
    PIPELINE+="vtee. ! queue max-size-bytes=0 max-size-time=0 leaky=downstream "
    PIPELINE+="! videoscale method=bilinear add-borders=true "
    PIPELINE+="! video/x-raw,width=${w},height=${h} "
    PIPELINE+="! ${enc} "
    PIPELINE+="! mpegtsmux name=mux${q} "
    PIPELINE+="! hlssink2 location=\"${HLS_DIR}/${q}_%05d.ts\" "
    PIPELINE+="           playlist-location=\"${HLS_DIR}/${q}.m3u8\" "
    PIPELINE+="           target-duration=2 max-files=16 "
    PIPELINE+="atee. ! queue ! avenc_aac bitrate=$(( abr * 1000 )) compliance=-2 ! aacparse "
    PIPELINE+="! mux${q}. "

    MASTER_LINES+=("#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},CODECS=\"avc1.42e01e,mp4a.40.2\"")
    MASTER_LINES+=("${q}.m3u8")
  done

  echo "[$(date -u +%FT%TZ)] Launching PRODUCTION pipeline (${#QUALITY_LIST[@]} rungs)"
  "$GST" -e "$PIPELINE" \
    >> "${LOG_DIR}/gst-${STREAM_KEY}-prod-video.log" 2>&1 &
  PIDS+=("$!")

  # Write master playlist
  printf '%s\n' "${MASTER_LINES[@]}" > "${HLS_DIR}/master.m3u8"
}

# ── 4. Launch the right pipeline ─────────────────────────────────────────────
if [ "$MODE" = "social" ]; then
  launch_social
else
  launch_production
fi

# ── 5. Write PID file ────────────────────────────────────────────────────────
printf '%s\n' "${PIDS[@]}" > "$PID_FILE"
echo "[$(date -u +%FT%TZ)] PIDs: ${PIDS[*]}"

# ── 6. Notify Node.js that pipelines are live ─────────────────────────────────
sleep 2    # brief pause for GStreamer to start writing segments
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"hlsUrl\":\"/live/${SESSION_ID}/master.m3u8\"}" \
  "${NODE_URL}/api/rtmp-live-ready" 2>/dev/null \
  && echo "[$(date -u +%FT%TZ)] live-ready notified" \
  || echo "[$(date -u +%FT%TZ)] WARNING: live-ready notify failed"

echo "[$(date -u +%FT%TZ)] gst-transcode.sh complete — ${#PIDS[@]} pipeline(s) running"

# ── 7. Wait (keeps nginx-rtmp exec_publish alive until stream ends) ──────────
wait
echo "[$(date -u +%FT%TZ)] All pipelines exited"
