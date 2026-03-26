# Michie Stream Platform

Blockchain music & NFT streaming — catalog upload, live streaming, royalties on-chain.

---

## Prerequisites

Install these before anything else.

| Tool | Version | Download |
|---|---|---|
| Node.js | 18 LTS or higher | https://nodejs.org |
| Git | Any recent | https://git-scm.com |
| Redis | 7+ (Windows) | https://github.com/microsoftarchive/redis/releases — or use Docker |

**Optional (for media encoding):**

| Tool | Purpose | Notes |
|---|---|---|
| FFmpeg | VOD transcoding, HLS encode | Already in your old project at `C:\DMZ_Work\...` |
| GStreamer | Dual-mode live pipelines | Windows installer at https://gstreamer.freedesktop.org/download/ |

---

## First-Time Setup

### 1. Create the folder structure

```powershell
cd C:\michie-stream-platform
powershell -ExecutionPolicy Bypass -File scaffold.ps1
```

### 2. Copy your built files

Download all output files from Claude into one folder (e.g. `C:\Users\YourName\Downloads\msp-outputs\`), then:

```powershell
powershell -ExecutionPolicy Bypass -File copy-outputs.ps1 -From "C:\Users\YourName\Downloads\msp-outputs"
```

### 3. Copy these manually from your old project

```
[Old project]\contracts\          → C:\michie-stream-platform\contracts\
[Old project]\public\vendor\      → C:\michie-stream-platform\public\vendor\
[Old project]\src\module_aws.js   → C:\michie-stream-platform\src\module_aws.js
[Old project]\public\Scripts\common.js  → C:\michie-stream-platform\public\Scripts\common.js
[Old project]\public\Scripts\wallet-boot.js → public\Scripts\wallet-boot.js
[Old project]\public\styles\styles.css  → C:\michie-stream-platform\public\styles\styles.css
```

Your FFmpeg binaries don't need to move — just point `.env` at the old path.

### 4. Install Node dependencies

```powershell
cd C:\michie-stream-platform
npm install
```

`blake3` is optional and may show a build warning on Windows — that's fine, the server falls back to SHA-256 automatically.

### 5. Configure environment

```powershell
copy .env.example .env
notepad .env
```

Minimum required before first boot:

```env
PORT=3001
PLAY_TOKEN_SECRET=change-this-to-something-random
FFMPEG_PATH=C:\DMZ_Work\Michie_Stream_Platform\ffmpeg\ffmpeg.exe
FFPROBE_PATH=C:\DMZ_Work\Michie_Stream_Platform\ffmpeg\ffprobe.exe
IPFS_GATEWAY=https://ipfs.io/ipfs/
```

Everything else (ETH_RPC, contract addresses, AWS, etc.) can be left at defaults for local dev — the server runs in **DEV_MODE** and skips all blockchain calls gracefully.

### 6. Start Redis

If you have Redis for Windows installed:
```powershell
redis-server
```

Or with Docker:
```powershell
docker run -d -p 6379:6379 redis:7
```

Redis is optional too — server logs a warning and continues without it.

### 7. Start the server

```powershell
cd C:\michie-stream-platform
npm run dev
```

You should see:
```
[READY] Server running on port 3001 — WebSocket at ws://localhost:3001/ws
```

Open `http://localhost:3001` in your browser.

---

## Project Structure

```
C:\michie-stream-platform\
│
├── public\                  Static files served by Express (dev) / Nginx (prod)
│   ├── Scripts\
│   │   ├── main.js          Main browser logic — capabilities, favorites, upload, live
│   │   ├── wallets.js       Wallet connect (MetaMask, Coinbase, Phantom, Solflare)
│   │   ├── router.js        Page routing guard
│   │   ├── live_broadcast.js  MSPLive broadcaster + viewer + post-stream modal
│   │   ├── common.js        playHls, IPFS gateway helpers
│   │   └── wallet-boot.js   Wallet bootstrap helper
│   ├── styles\styles.css    SIGNAL design system CSS
│   ├── vendor\              Third-party bundles (ethers, hls.js, bootstrap, ipfs)
│   ├── index.html           Landing page
│   ├── listen.html          Streaming + subscriptions + favorites + live concerts
│   ├── creators.html        Upload, DJ sets, live studio
│   ├── marketplace.html     NFT marketplace
│   ├── profile.html         Account, royalty splits, favorites panel
│   └── live_studio.html     Live broadcaster / viewer UI reference
│
├── src\
│   ├── server.cjs           Express server — 21 routes, DEV_MODE, all business logic
│   ├── validator.js         JSON Schema metadata validation
│   ├── module_aws.js        AWS KMS signing, DynamoDB, S3, CloudFront
│   ├── gst_pipeline.js      GStreamer pipeline manager (PRODUCTION + SOCIAL modes)
│   ├── server_gst_additions.js  Merge into server.cjs — catalog flow, RTMP auth
│   ├── server_live.js       Merge into server.cjs — WebSocket, live session routes
│   └── python\
│       └── demucs_script.py  Stem separation (API update pending)
│
├── contracts\               Solidity smart contracts
│   ├── ContentCA.sol        EIP-712 content certification
│   ├── Escrow.sol           Subscription + tip escrow
│   ├── MusicNFT.sol         NFT with royalty enforcement
│   ├── NFTMetadataContract.sol
│   ├── RoyaltyPayout.sol    Royalty distribution
│   └── StreamingRegistry.sol  On-chain play logging
│
├── infra\                   Production server configuration
│   ├── nginx.conf           Nginx: stream.michie.com, RTMP :1935, HLS, SSL
│   ├── install-media.sh     One-command GStreamer + Nginx install (Linux/Ubuntu)
│   └── scripts\
│       ├── gst-transcode.sh        nginx-rtmp → GStreamer pipeline launcher
│       └── gst-transcode-done.sh   Graceful pipeline shutdown on stream end
│
├── schemas\                 JSON Schema definitions for all content types
├── docs\                    Technical docs, design system, feature specs
├── certs\                   TLS certificates (gitignored)
├── logs\                    Pino log output (gitignored)
├── temp\                    Upload temp files (gitignored)
│
├── .env                     Your secrets — NEVER commit (gitignored)
├── .env.example             All env vars documented
├── .gitignore
├── package.json
├── scaffold.ps1             First-time folder creation script
└── copy-outputs.ps1         Copy Claude output files to correct locations
```

---

## Routes Reference

| Method | Route | What it does |
|---|---|---|
| GET | `/api/profile/:wallet` | Fetch profile |
| POST | `/api/create-profile` | Create new profile |
| POST | `/api/subscribe` | Subscribe to a plan |
| GET | `/api/access/:wallet` | Get capability level |
| GET | `/api/fees` | Fee schedule |
| POST | `/api/upload` | Upload media (music/podcast/video/art) |
| POST | `/api/catalog-transcode` | Trigger IPFS→HLS transcode for a CID |
| GET | `/api/stream-ready/:cid` | Poll: is HLS ready to serve? |
| GET | `/api/favorites/:wallet` | Get favorites list |
| POST | `/api/favorites/add` | Add to favorites |
| POST | `/api/favorites/remove` | Remove from favorites |
| POST | `/api/favorites/convert-to-playlist` | Promote favorites → playlist |
| POST | `/api/create-playlist` | Create a playlist |
| POST | `/api/live-start` | Start live stream (PRODUCTION or SOCIAL mode) |
| POST | `/api/live-ingest/:id` | Push MediaRecorder chunk |
| POST | `/api/live-end/:id` | End live stream |
| POST | `/api/live-archive` | Archive to IPFS + catalog |
| POST | `/api/live-discard` | Delete recording |
| GET | `/api/live-sessions` | Active live sessions |
| GET | `/api/stream-key/:wallet` | Get RTMP stream key |
| POST | `/api/rtmp-auth` | nginx-rtmp auth callback |
| POST | `/api/tip` | Send a tip |
| POST | `/api/set-royalty-splits` | Set royalty split config |
| GET | `/api/media-capabilities` | GStreamer/FFmpeg detection status |

---

## Live Streaming Modes

**PRODUCTION** — multi-bitrate, tee-based GStreamer pipeline, archives to IPFS, royalty-eligible
- Use for: catalog content, concerts, anything you want fans to replay

**SOCIAL** — single 480p quality, 1-second segments, ephemeral (no archive by default)
- Use for: fan Q&A, casual DJ sets, quick check-ins

Set via `mode: 'production'` or `mode: 'social'` in the `/api/live-start` request, or by choosing in the Live Studio UI.

---

## DEV_MODE

If `ETH_RPC` or `MSP_PRIVATE_KEY` are missing or invalid, the server boots in **DEV_MODE**:
- All 21 routes work normally
- Blockchain calls (logPlay, EIP-712 cert signing) are skipped with a log warning
- Profiles saved to `profiles.json` locally
- GStreamer/FFmpeg falls back gracefully if not installed

This means you can develop the full platform on a Windows laptop with no ETH node, no contracts deployed, and no GStreamer installed.

---

## Git Setup

```powershell
cd C:\michie-stream-platform
git init
git add .
git commit -m "feat: initial MSP project structure"
git remote add origin https://github.com/YOUR_USERNAME/michie-stream-platform.git
git push -u origin main
```

---

## Production Deployment

When ready to deploy to a Linux server (Ubuntu 22.04 recommended):

```bash
# On the server
git clone https://github.com/YOUR_USERNAME/michie-stream-platform.git
cd michie-stream-platform
sudo bash infra/install-media.sh      # installs Nginx + GStreamer + FFmpeg
npm install
cp .env.example .env
nano .env                              # fill in real values
node src/server.cjs
```

Then:
- Point DNS: `michie.com` and `stream.michie.com` to your server IP
- `sudo certbot --nginx -d michie.com -d stream.michie.com`
- Set up a process manager: `npm install -g pm2 && pm2 start src/server.cjs`

---

*Michie Stream Platform — SIGNAL Design System — built session by session*
