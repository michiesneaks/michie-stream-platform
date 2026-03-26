#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  MSP — Media Infrastructure Install Script
#  sudo bash install-media.sh
#  Tested: Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()   { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root: sudo bash $0"
SRC="$(cd "$(dirname "$0")" && pwd)"

info "=== MSP Media Infrastructure Install ==="

# 1. Nginx + RTMP module
info "Installing Nginx + nginx-rtmp-module..."
apt-get update -qq
apt-get install -y nginx libnginx-mod-rtmp curl python3
ok "Nginx $(nginx -v 2>&1 | grep -oP '[\d.]+')"

# 2. GStreamer
info "Installing GStreamer (full stack)..."
apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev
ok "GStreamer $(gst-launch-1.0 --version | head -1)"

# 3. Hardware acceleration (auto-detect, non-fatal)
info "Checking hardware acceleration..."
HW=0
if lspci 2>/dev/null | grep -qi 'intel\|amd'; then
  apt-get install -y gstreamer1.0-vaapi vainfo 2>/dev/null && {
    gst-inspect-1.0 vaapih264enc >/dev/null 2>&1 && { ok "VAAPI (vaapih264enc)"; HW=1; } \
      || warn "VAAPI driver installed but vaapih264enc not found"
  } || warn "VAAPI packages unavailable in current repo"
fi
if lspci 2>/dev/null | grep -qi nvidia; then
  gst-inspect-1.0 nvh264enc >/dev/null 2>&1 \
    && { ok "NVIDIA NVENC (nvh264enc)"; HW=1; } \
    || warn "NVIDIA GPU found but nvh264enc unavailable — install NVIDIA drivers first"
fi
[[ $HW -eq 0 ]] && warn "No HW accel — using software x264enc (fine for < 4 streams)"

# 4. FFmpeg (fallback)
info "Installing FFmpeg..."
apt-get install -y ffmpeg
ok "FFmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# 5. Node.js ws + node-fetch
info "Installing Node.js dependencies..."
MSP_DIR="/var/www/msp"
[[ -f "./package.json" ]] && MSP_DIR="$(pwd)"
if [[ -f "${MSP_DIR}/package.json" ]]; then
  cd "$MSP_DIR"
  npm install --save ws node-fetch
  ok "ws + node-fetch installed"
else
  warn "package.json not found — run: npm install --save ws node-fetch"
fi

# 6. Directory layout
info "Creating directory layout..."
mkdir -p /var/www/msp/{public,live,streams,scripts,certs,vod_recordings}
mkdir -p /var/log/msp
chown -R www-data:www-data /var/www/msp/live /var/www/msp/streams /var/www/msp/vod_recordings
chmod 755 /var/www/msp/scripts
ok "Directories created"

# 7. Install scripts
for f in gst-transcode.sh gst-transcode-done.sh; do
  [[ -f "${SRC}/${f}" ]] && {
    cp "${SRC}/${f}" /var/www/msp/scripts/
    chmod +x /var/www/msp/scripts/${f}
    ok "Installed ${f}"
  } || warn "${f} not found — copy manually"
done

# 8. Install gst_pipeline.js
[[ -f "${SRC}/gst_pipeline.js" ]] && {
  cp "${SRC}/gst_pipeline.js" "${MSP_DIR}/src/"
  ok "gst_pipeline.js installed to src/"
} || warn "gst_pipeline.js not found — copy manually to src/"

# 9. Nginx config
if [[ -f "${SRC}/nginx.conf" ]]; then
  [[ -f /etc/nginx/nginx.conf ]] && cp /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.bak.$(date +%Y%m%d_%H%M%S)"
  cp "${SRC}/nginx.conf" /etc/nginx/nginx.conf
  nginx -t && { systemctl reload nginx; ok "Nginx reloaded"; } || die "nginx config test FAILED"
else
  warn "nginx.conf not found — copy manually"
fi

# 10. Firewall
command -v ufw &>/dev/null && {
  ufw allow 80/tcp  comment "HTTP"  >/dev/null
  ufw allow 443/tcp comment "HTTPS" >/dev/null
  ufw allow 1935/tcp comment "RTMP" >/dev/null
  ok "Firewall: 80, 443, 1935 open"
} || warn "ufw not found — open ports 80, 443, 1935 manually"

echo ""
echo "══════════════════════════════════════════════════════"
echo -e "  ${GREEN}MSP Media Infrastructure — Complete${NC}"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  GStreamer: $(gst-launch-1.0 --version | head -1)"
echo "  FFmpeg:    $(ffmpeg -version 2>&1 | head -1 | awk '{print $1,$2,$3}')"
echo ""
echo "  Catalog HLS:  https://stream.michie.com/{cid}/master.m3u8"
echo "  Live HLS:     https://michie.com/live/{sessionId}/master.m3u8"
echo "  RTMP ingest:  rtmp://michie.com:1935/live/{stream_key}"
echo "  RTMP social:  rtmp://michie.com:1935/social/{stream_key}"
echo ""
echo "  Next steps:"
echo "  1. Add TLS: certbot --nginx -d michie.com -d stream.michie.com"
echo "  2. Add to .env:"
echo "       STREAMS_ROOT=/var/www/msp/streams"
echo "       HLS_ROOT=/var/www/msp/live"
echo "       STREAM_HOST=michie.com"
echo "  3. Merge server_gst_additions.js into server.cjs"
echo "  4. Add to server.cjs requires:"
echo "       const { GstPipeline, detectCapabilities, MODES, STREAMS_ROOT, HLS_ROOT }"
echo "             = require('./gst_pipeline');"
echo "  5. Restart: node src/server.cjs"
echo "  6. Verify:  curl localhost:3001/api/media-capabilities"
echo ""
