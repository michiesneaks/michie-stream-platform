/**
 * MSP LIVE STREAMING ADDITIONS
 * Merge these blocks into server.cjs at the marked positions.
 *
 * NEW DEPENDENCIES (npm install):
 *   ws           — WebSocket server
 *
 * BUILT-IN (no install):
 *   stream.PassThrough
 *   child_process.spawn
 *   http.createServer  (replace app.listen with this)
 *
 * ─── INTEGRATION CHECKLIST ────────────────────────────────────────────────
 *  [1] Add requires at top of server.cjs
 *  [2] Add activeSessions Map after requires
 *  [3] Add WebSocket server setup (replaces app.listen at bottom)
 *  [4] Add all new routes (live-start, live-ingest, live-end, live-archive, live-discard)
 *  [5] Replace /api/live-concerts stub with real /api/live-sessions
 *  [6] Add broadcastToSession and broadcastToAll helpers
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// [1]  NEW REQUIRES — add near top of server.cjs after existing requires
// ═══════════════════════════════════════════════════════════════════════════

const { PassThrough }  = require('stream');
const http             = require('http');
const { WebSocketServer } = require('ws');
const { spawn }        = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════
// [2]  IN-MEMORY SESSION STORE — add after constants (FEES / SUBSCRIPTION_PLANS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * activeSessions — keyed by sessionId (uuid)
 * Each session:
 * {
 *   sessionId, wallet, title, artistName, startTime,
 *   hlsDir, hlsUrl, thumbnailUrl,
 *   passThrough,       ← Node stream piped to ffmpeg stdin
 *   ffmpegProc,        ← spawned ffmpeg child process
 *   viewers: Map(ws → { wallet, name }),
 *   chatHistory: [],   ← last 200 messages, sent to late joiners
 *   tipsTotal: 0,
 *   peakViewers: 0,
 *   status: 'live' | 'ended_clean' | 'ended_unexpectedly' | 'archived' | 'discarded',
 *   archiveCid: null,
 *   endTime: null,
 *   chunkCount: 0,
 * }
 */
const activeSessions = new Map();

// Persist session metadata to disk so recovery survives server restarts
const liveSessionsPath = path.resolve(process.cwd(), 'live_sessions.json');
fs.ensureFileSync(liveSessionsPath);

async function loadLiveSessions() {
  try { return JSON.parse(await fs.readFile(liveSessionsPath, 'utf8')); }
  catch { return {}; }
}
async function saveLiveSession(sessionId, meta) {
  const all = await loadLiveSessions();
  all[sessionId] = meta;
  await fs.writeFile(liveSessionsPath, JSON.stringify(all, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// [3]  WEBSOCKET HELPERS — add after activeSessions, before routes
// ═══════════════════════════════════════════════════════════════════════════

// wss is defined in [6] (server startup). Forward-declared here for route use.
let wss = null;

/** Broadcast a JSON message to all viewers in a session */
function broadcastToSession(sessionId, msg) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const payload = JSON.stringify(msg);
  for (const [ws] of session.viewers) {
    if (ws.readyState === 1 /* OPEN */) ws.send(payload);
  }
}

/** Broadcast to ALL connected WebSocket clients (e.g. new session alert) */
function broadcastToAll(msg) {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// [4]  LIVE ROUTES — add before the error handlers at the bottom
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────── Start Live Session ──────────────────────────────

app.post('/api/live-start', async (req, res) => {
  const { wallet, title, artistName, quality = '720p' } = req.body || {};
  if (!wallet || !title || !artistName) {
    return res.status(400).json({ error: 'wallet, title, and artistName are required' });
  }

  // Access guard
  const profiles = await loadProfiles();
  const profile  = profiles[wallet];
  const level    = getCapabilityLevel(profile || {});
  if (!['creator_active', 'nft_creator_active'].includes(level)) {
    return res.status(403).json({ error: 'An active Creator subscription is required to go live.' });
  }

  const sessionId  = uuidv4();
  const hlsDir     = path.join(process.cwd(), 'public', 'live', sessionId);
  await fs.ensureDir(hlsDir);

  // Quality presets
  const qualityMap = {
    '1080p': { w: 1920, h: 1080, vbr: '4500k', preset: 'veryfast' },
    '720p':  { w: 1280, h: 720,  vbr: '2800k', preset: 'veryfast' },
    '480p':  { w: 854,  h: 480,  vbr: '1200k', preset: 'ultrafast' },
    '360p':  { w: 640,  h: 360,  vbr: '600k',  preset: 'ultrafast' },
  };
  const q = qualityMap[quality] || qualityMap['720p'];

  // PassThrough: browser chunks → ffmpeg stdin
  const passThrough = new PassThrough();

  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpegArgs = [
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', 'pipe:0',
    // Video
    '-c:v', 'libx264',
    '-preset', q.preset,
    '-tune', 'zerolatency',
    '-b:v', q.vbr,
    '-maxrate', q.vbr,
    '-bufsize', `${parseInt(q.vbr) * 2}k`,
    '-vf', `scale=${q.w}:${q.h}`,
    '-g', '48', '-keyint_min', '48',
    '-sc_threshold', '0',
    // Audio
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    // HLS
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',         // keep all segments (for full archive)
    '-hls_flags', 'append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${hlsDir}/seg_%05d.ts`,
    // Thumbnail every 10s
    '-vf', `scale=${q.w}:${q.h},fps=1/10`,
    '-update', '1', `${hlsDir}/thumb.jpg`,
    `${hlsDir}/stream.m3u8`,
  ];

  const ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  passThrough.pipe(ffmpegProc.stdin);

  ffmpegProc.stderr.on('data', d => logger.debug({ sessionId }, `FFmpeg: ${d}`));
  ffmpegProc.on('error', err => {
    logger.error({ sessionId, err }, 'FFmpeg error during live session');
    const session = activeSessions.get(sessionId);
    if (session && session.status === 'live') {
      session.status = 'ended_unexpectedly';
      session.endTime = Date.now();
      broadcastToSession(sessionId, { type: 'stream_ended', sessionId, reason: 'encoder_error' });
    }
  });
  ffmpegProc.on('close', code => {
    logger.info({ sessionId, code }, 'FFmpeg process closed');
  });

  const sessionMeta = {
    sessionId,
    wallet,
    title,
    artistName,
    quality,
    startTime: Date.now(),
    hlsDir,
    hlsUrl:        `/live/${sessionId}/stream.m3u8`,
    thumbnailUrl:  `/live/${sessionId}/thumb.jpg`,
    passThrough,
    ffmpegProc,
    viewers:     new Map(),
    chatHistory: [],
    tipsTotal:   0,
    peakViewers: 0,
    status:      'live',
    archiveCid:  null,
    endTime:     null,
    chunkCount:  0,
  };
  activeSessions.set(sessionId, sessionMeta);

  // Persist metadata (sans non-serializable fields)
  await saveLiveSession(sessionId, {
    sessionId, wallet, title, artistName, quality,
    startTime: sessionMeta.startTime,
    hlsUrl: sessionMeta.hlsUrl,
    thumbnailUrl: sessionMeta.thumbnailUrl,
    status: 'live',
  });

  // Notify all connected viewers
  broadcastToAll({
    type:       'session_started',
    sessionId,
    title,
    artistName,
    thumbnailUrl: sessionMeta.thumbnailUrl,
    hlsUrl:       sessionMeta.hlsUrl,
  });

  logger.info({ sessionId, wallet, title, quality }, 'Live session started');
  res.status(201).json({
    sessionId,
    hlsUrl:      sessionMeta.hlsUrl,
    thumbnailUrl: sessionMeta.thumbnailUrl,
  });
});

// ─────────────────────────── Ingest Chunks ───────────────────────────────────

// Raw binary POST — each MediaRecorder chunk pushed here
app.post('/api/live-ingest/:sessionId',
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  async (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or already ended' });
    }
    if (session.status !== 'live') {
      return res.status(409).json({ error: 'Session is not active', status: session.status });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty chunk' });
    }

    try {
      session.passThrough.write(req.body);
      session.chunkCount++;

      // Update viewer count broadcast every 5 chunks (~10s)
      if (session.chunkCount % 5 === 0) {
        broadcastToSession(session.sessionId, {
          type: 'stats',
          sessionId: session.sessionId,
          viewerCount: session.viewers.size,
          duration: Math.floor((Date.now() - session.startTime) / 1000),
          tipsTotal: session.tipsTotal,
        });
      }

      res.json({ ok: true, chunkCount: session.chunkCount });
    } catch (err) {
      logger.error({ sessionId: req.params.sessionId, err }, 'Chunk write error');
      res.status(500).json({ error: 'Chunk write failed' });
    }
  }
);

// ─────────────────────────── End Live Session ────────────────────────────────

app.post('/api/live-end/:sessionId', async (req, res) => {
  const { wallet } = req.body || {};
  const session    = activeSessions.get(req.params.sessionId);

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.wallet !== wallet) return res.status(403).json({ error: 'Not your session' });
  if (session.status !== 'live') return res.status(409).json({ error: 'Session already ended' });

  session.status  = 'ended_clean';
  session.endTime = Date.now();

  // Close the PassThrough — tells FFmpeg stdin to finish
  session.passThrough.end();

  // Wait up to 8s for FFmpeg to flush remaining segments
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 8000);
    session.ffmpegProc.on('close', () => { clearTimeout(timeout); resolve(); });
  });

  const duration = Math.floor((session.endTime - session.startTime) / 1000);

  // Notify viewers
  broadcastToSession(session.sessionId, {
    type:     'stream_ended',
    sessionId: session.sessionId,
    reason:   'creator_ended',
    duration,
  });

  await saveLiveSession(session.sessionId, {
    sessionId:   session.sessionId,
    wallet:      session.wallet,
    title:       session.title,
    artistName:  session.artistName,
    startTime:   session.startTime,
    endTime:     session.endTime,
    duration,
    hlsUrl:      session.hlsUrl,
    thumbnailUrl: session.thumbnailUrl,
    tipsTotal:   session.tipsTotal,
    peakViewers: session.peakViewers,
    status:      'ended_clean',
  });

  broadcastToAll({ type: 'session_ended', sessionId: session.sessionId });

  res.json({
    success:     true,
    duration,
    tipsTotal:   session.tipsTotal,
    peakViewers: session.peakViewers,
    chunkCount:  session.chunkCount,
    hlsDir:      session.hlsDir,
  });
});

// ─────────────────────────── Archive to IPFS + Catalog ───────────────────────

app.post('/api/live-archive', async (req, res) => {
  const { sessionId, wallet, title, description, tags, mintNft } = req.body || {};
  if (!sessionId || !wallet) return res.status(400).json({ error: 'Missing sessionId or wallet' });

  const session = activeSessions.get(sessionId) || {};
  const savedMeta = (await loadLiveSessions())[sessionId];
  if (!savedMeta) return res.status(404).json({ error: 'Session not found' });
  if (savedMeta.wallet !== wallet) return res.status(403).json({ error: 'Not your session' });

  const hlsDir = session.hlsDir || path.join(process.cwd(), 'public', 'live', sessionId);
  if (!fs.existsSync(hlsDir)) return res.status(404).json({ error: 'Recording files not found' });

  try {
    let archiveCid = null;

    if (ipfs) {
      // Archive the HLS folder to IPFS
      const { folderCid } = await addDirectoryToIpfs(ipfs, hlsDir);
      archiveCid = folderCid;
      logger.info({ sessionId, archiveCid }, 'Live session archived to IPFS');
    } else {
      logger.warn({ sessionId }, 'IPFS not configured — archiving locally only');
      archiveCid = `local:${sessionId}`;
    }

    // Build catalog metadata (same schema as uploaded content)
    const duration  = savedMeta.duration || Math.floor(((session.endTime || Date.now()) - session.startTime) / 1000);
    const parsedTags = (tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const profiles   = await loadProfiles();
    const profile    = profiles[wallet];

    const liveMetadata = {
      id:               sessionId,
      title:            title || savedMeta.title,
      description:      description || '',
      creator: {
        name:           savedMeta.artistName,
        wallet_address: wallet,
      },
      content_type:      'live_recording',
      availability_type: 'on_demand',
      duration_seconds:  duration,
      recorded_live:     true,
      release_date:      new Date().toISOString().split('T')[0],
      tags:              parsedTags.length ? parsedTags : ['live', 'stream'],
      files: {
        hls_url:   archiveCid ? `ipfs://${archiveCid}/stream.m3u8` : session.hlsUrl,
        thumbnail: archiveCid ? `ipfs://${archiveCid}/thumb.jpg`   : session.thumbnailUrl,
      },
      live_stats: {
        peak_viewers: savedMeta.peakViewers || 0,
        tips_total:   savedMeta.tipsTotal   || 0,
        chunk_count:  session.chunkCount    || 0,
      },
      royalty_fee_rate: profile?.royalty_fee_rate || FEES.PLATFORM_ROYALTY_STANDARD,
    };

    let metadataCid = null;
    if (ipfs) {
      const { cid } = await ipfs.add(JSON.stringify(liveMetadata));
      metadataCid = cid.toString();
    }

    // Save to creator's catalog (playlist_cids is the catalog store for now)
    if (profile && metadataCid) {
      profile.playlist_cids = profile.playlist_cids || [];
      if (!profile.playlist_cids.includes(metadataCid)) {
        profile.playlist_cids.push(metadataCid);
      }
      // Also track in a dedicated live_recordings field
      profile.live_recordings = profile.live_recordings || [];
      profile.live_recordings.push({
        sessionId,
        metadataCid,
        archiveCid,
        title: liveMetadata.title,
        date:  new Date().toISOString(),
      });
      profiles[wallet] = profile;
      await saveProfiles(profiles);
    }

    // Update session status
    if (activeSessions.has(sessionId)) {
      activeSessions.get(sessionId).status     = 'archived';
      activeSessions.get(sessionId).archiveCid = archiveCid;
    }
    await saveLiveSession(sessionId, { ...savedMeta, status: 'archived', archiveCid, metadataCid });

    res.json({
      success:     true,
      archiveCid,
      metadataCid,
      hlsUrl:      liveMetadata.files.hls_url,
      mintPending: !!mintNft,
      message:     mintNft
        ? 'Archived to IPFS. Use metadataCid to mint the NFT on-chain.'
        : 'Live recording saved to your catalog.',
    });
  } catch (err) {
    logger.error({ sessionId, err }, 'Archive failed');
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────── Discard Recording ───────────────────────────────

app.post('/api/live-discard', async (req, res) => {
  const { sessionId, wallet } = req.body || {};
  if (!sessionId || !wallet) return res.status(400).json({ error: 'Missing sessionId or wallet' });

  const savedMeta = (await loadLiveSessions())[sessionId];
  if (!savedMeta) return res.status(404).json({ error: 'Session not found' });
  if (savedMeta.wallet !== wallet) return res.status(403).json({ error: 'Not your session' });

  const hlsDir = path.join(process.cwd(), 'public', 'live', sessionId);
  await fs.remove(hlsDir).catch(() => {});

  if (activeSessions.has(sessionId)) {
    activeSessions.get(sessionId).status = 'discarded';
    activeSessions.delete(sessionId);
  }
  await saveLiveSession(sessionId, { ...savedMeta, status: 'discarded' });

  logger.info({ sessionId, wallet }, 'Live recording discarded');
  res.json({ success: true, message: 'Recording deleted.' });
});

// ─────────────────────────── Live Sessions List (replaces stub) ──────────────

// REMOVE the old: app.get('/api/live-concerts', ...) stub and replace with:
app.get('/api/live-sessions', async (req, res) => {
  const sessions = [];
  for (const [id, s] of activeSessions) {
    if (s.status !== 'live') continue;
    sessions.push({
      sessionId:    id,
      title:        s.title,
      artistName:   s.artistName,
      wallet:       s.wallet,
      hlsUrl:       s.hlsUrl,
      thumbnailUrl: s.thumbnailUrl,
      viewerCount:  s.viewers.size,
      startTime:    s.startTime,
      tipsTotal:    s.tipsTotal,
      duration:     Math.floor((Date.now() - s.startTime) / 1000),
    });
  }
  res.json(sessions);
});

// Keep backward compat alias
app.get('/api/live-concerts', async (req, res) => {
  const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/live-sessions`);
  res.json(r.ok ? await r.json() : []);
});

// ═══════════════════════════════════════════════════════════════════════════
// [5]  WEBSOCKET SERVER + SERVER STARTUP
//      Replace the existing app.listen(PORT) block at the bottom of server.cjs
//      with this entire block.
// ═══════════════════════════════════════════════════════════════════════════

const PORT = Number(process.env.PORT || 3001);

(async () => {
  try {
    const httpServer = http.createServer(app);

    // ── WebSocket Server ────────────────────────────────────────────────────
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
      ws._sessionId = null;
      ws._wallet    = null;
      ws._name      = null;

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

          // ── Viewer joins a live session ────────────────────────────────
          case 'join_session': {
            const session = activeSessions.get(msg.sessionId);
            if (!session || session.status !== 'live') {
              ws.send(JSON.stringify({ type: 'error', error: 'Session not found or not live' }));
              return;
            }
            // Leave previous session if any
            if (ws._sessionId && ws._sessionId !== msg.sessionId) {
              const prev = activeSessions.get(ws._sessionId);
              if (prev) prev.viewers.delete(ws);
            }
            ws._sessionId = msg.sessionId;
            ws._wallet    = msg.wallet   || null;
            ws._name      = msg.name     || 'Listener';
            session.viewers.set(ws, { wallet: ws._wallet, name: ws._name });
            session.peakViewers = Math.max(session.peakViewers, session.viewers.size);

            // Send recent chat history + current stats
            ws.send(JSON.stringify({
              type:        'session_state',
              sessionId:   msg.sessionId,
              title:       session.title,
              artistName:  session.artistName,
              hlsUrl:      session.hlsUrl,
              viewerCount: session.viewers.size,
              duration:    Math.floor((Date.now() - session.startTime) / 1000),
              tipsTotal:   session.tipsTotal,
              chatHistory: session.chatHistory.slice(-50),
            }));

            // Broadcast updated count
            broadcastToSession(msg.sessionId, {
              type:        'viewer_count',
              sessionId:   msg.sessionId,
              viewerCount: session.viewers.size,
            });
            break;
          }

          // ── Leave session ──────────────────────────────────────────────
          case 'leave_session': {
            const session = activeSessions.get(ws._sessionId);
            if (session) {
              session.viewers.delete(ws);
              broadcastToSession(ws._sessionId, {
                type:        'viewer_count',
                sessionId:   ws._sessionId,
                viewerCount: session.viewers.size,
              });
            }
            ws._sessionId = null;
            break;
          }

          // ── Chat message ───────────────────────────────────────────────
          case 'chat': {
            if (!ws._sessionId) return;
            const session = activeSessions.get(ws._sessionId);
            if (!session || session.status !== 'live') return;
            const text = String(msg.text || '').trim().slice(0, 300);
            if (!text) return;
            const chatMsg = {
              type:      'chat',
              sessionId: ws._sessionId,
              name:      ws._name     || 'Listener',
              wallet:    ws._wallet   || null,
              text,
              ts:        Date.now(),
            };
            session.chatHistory.push(chatMsg);
            if (session.chatHistory.length > 200) session.chatHistory.shift();
            broadcastToSession(ws._sessionId, chatMsg);
            break;
          }

          // ── Emoji reaction ─────────────────────────────────────────────
          case 'reaction': {
            if (!ws._sessionId) return;
            const ALLOWED_REACTIONS = ['🔥', '❤️', '👏', '🎵', '💎', '🚀'];
            const emoji = ALLOWED_REACTIONS.includes(msg.emoji) ? msg.emoji : '🔥';
            broadcastToSession(ws._sessionId, {
              type:      'reaction',
              sessionId: ws._sessionId,
              emoji,
              name:      ws._name || 'Listener',
            });
            break;
          }

          // ── Tip alert (after tip API call succeeds, client sends this) ──
          case 'tip_alert': {
            if (!ws._sessionId) return;
            const session = activeSessions.get(ws._sessionId);
            if (!session) return;
            const amount = parseFloat(msg.amountEth) || 0;
            session.tipsTotal += amount;
            broadcastToSession(ws._sessionId, {
              type:      'tip_alert',
              sessionId: ws._sessionId,
              name:      ws._name  || 'Listener',
              amountEth: amount,
              tipsTotal: session.tipsTotal,
            });
            break;
          }

          // ── Creator heartbeat (keep session alive) ─────────────────────
          case 'ping': {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;
          }
        }
      });

      ws.on('close', () => {
        if (ws._sessionId) {
          const session = activeSessions.get(ws._sessionId);
          if (session) {
            session.viewers.delete(ws);
            broadcastToSession(ws._sessionId, {
              type:        'viewer_count',
              sessionId:   ws._sessionId,
              viewerCount: session.viewers.size,
            });
          }
        }
      });

      ws.on('error', (err) => logger.warn({ err }, 'WebSocket error'));
    });

    // ── TLS or HTTP ─────────────────────────────────────────────────────────
    if (process.env.TLS_KEY_PATH && process.env.TLS_CERT_PATH) {
      if (fs.existsSync(process.env.TLS_KEY_PATH) && fs.existsSync(process.env.TLS_CERT_PATH)) {
        const tls = require('tls');
        const tlsOptions = {
          key:  fs.readFileSync(process.env.TLS_KEY_PATH),
          cert: fs.readFileSync(process.env.TLS_CERT_PATH),
          minVersion:       'TLSv1.3',
          honorCipherOrder: true,
        };
        require('https').createServer(tlsOptions, app).listen(443, () =>
          logger.info('HTTPS + WSS server on port 443'));
        require('http').createServer((req, res) => {
          res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
          res.end();
        }).listen(80);
        return;
      }
    }

    httpServer.listen(PORT, () => {
      logger.info(`HTTP + WS server on http://localhost:${PORT}`);
      console.log(`[READY] Server running on port ${PORT} — WebSocket at ws://localhost:${PORT}/ws`);
    });

  } catch (e) {
    logger.error({ err: e }, 'Server startup failed');
    console.error('[STARTUP ERROR]', e.message);
    process.exit(1);
  }
})();

module.exports = { app, activeSessions, FEES, SUBSCRIPTION_PLANS };
