'use strict';
/**
 * MSP — Server additions for GStreamer + Nginx integration
 * Merge into server.cjs.
 *
 * ─── INTEGRATION CHECKLIST ──────────────────────────────────────────────────
 *  [1] Add to requires at top of server.cjs:
 *      const { GstPipeline, detectCapabilities, MODES, STREAMS_ROOT, HLS_ROOT }
 *            = require('./gst_pipeline');
 *
 *  [2] Add to startup (after logger init):
 *      let gstCaps = { gstreamer: false, ffmpeg: true };
 *      detectCapabilities().then(c => {
 *        gstCaps = c;
 *        logger.info({ ...c }, 'Media capabilities');
 *      }).catch(() => {});
 *
 *  [3] Add the routes below before the error handlers.
 *
 *  [4] Add to .env:
 *      STREAMS_ROOT=/var/www/msp/streams
 *      HLS_ROOT=/var/www/msp/live
 *      STREAM_HOST=your-server-ip-or-domain
 *
 *  [5] npm install --save ws node-fetch
 * ────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
//  [A]  CATALOG PIPELINE  —  Your exact proposed flow:
//
//  Artist upload/mint → IPFS CID
//    ↓
//  Backend downloads CID → GStreamer transcodes to HLS variants
//    ↓
//  HLS written to /var/www/msp/streams/{cid}/  (lo/mid/hi + master.m3u8)
//    ↓
//  Nginx serves https://stream.michie.com/{cid}/master.m3u8
//    ↓
//  Frontend hls.js → subscription check → plays
//    ↓
//  Play completes → StreamingRegistry.logPlay() + royalty events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/catalog-transcode
 *
 * Triggered automatically after a successful /api/upload, OR manually
 * by a creator who uploaded content that hasn't been transcoded yet.
 *
 * Body: { cid, wallet, contentType, title, mode? }
 *   cid         — IPFS content ID of the uploaded media
 *   wallet      — creator wallet (for access guard)
 *   contentType — 'music' | 'podcast' | 'video' | 'art_animated'
 *   mode        — 'production' (default) | 'social'
 */
app.post('/api/catalog-transcode', async (req, res) => {
  const { cid, wallet, contentType = 'music', mode = MODES.PRODUCTION } = req.body || {};
  if (!cid || !wallet) return res.status(400).json({ error: 'Missing cid or wallet' });

  // ── Access guard ───────────────────────────────────────────────────────────
  const profiles = await loadProfiles();
  const profile  = profiles[wallet];
  if (!profile) return res.status(403).json({ error: 'Profile not found' });
  if (!['creator', 'platform_nft_creator'].includes(profile.account_type)) {
    return res.status(403).json({ error: 'Creator account required' });
  }

  // ── Check if already transcoded ────────────────────────────────────────────
  const outDir     = path.join(STREAMS_ROOT, cid);
  const masterPath = path.join(outDir, 'master.m3u8');
  if (await fs.pathExists(masterPath)) {
    return res.json({
      success:  true,
      cached:   true,
      hlsUrl:   `/streams/${cid}/master.m3u8`,
      thumbUrl: `/streams/${cid}/thumb.jpg`,
    });
  }

  // ── Reply immediately — transcode is async ─────────────────────────────────
  res.json({
    success:   true,
    queued:    true,
    cid,
    statusUrl: `/api/stream-ready/${cid}`,
    message:   'Transcode queued — poll /api/stream-ready/:cid for status',
  });

  // ── Background: download from IPFS + transcode ─────────────────────────────
  _runCatalogTranscode({ cid, wallet, contentType, mode, profile, profiles }).catch(err => {
    logger.error({ cid, err }, 'Catalog transcode failed');
  });
});

/**
 * Internal — download from IPFS and run GStreamer.
 */
async function _runCatalogTranscode({ cid, wallet, contentType, mode, profile, profiles }) {
  const outDir  = path.join(STREAMS_ROOT, cid);
  const tempDir = path.join(__dirname, '../temp', `transcode_${cid}`);
  await fs.ensureDir(outDir);
  await fs.ensureDir(tempDir);

  const gateway    = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
  const mediaUrl   = gateway + cid;
  const localFile  = path.join(tempDir, `source${_extForType(contentType)}`);

  logger.info({ cid, contentType, mode }, 'Catalog transcode: downloading from IPFS');

  // Download the file
  const { default: nodeFetch } = require('node-fetch').catch ? { default: require('node-fetch') } : require('node-fetch');
  try {
    const resp = await nodeFetch(mediaUrl, { timeout: 120000 });
    if (!resp.ok) throw new Error(`IPFS download failed: ${resp.status}`);
    const dest = require('fs').createWriteStream(localFile);
    await new Promise((res, rej) => {
      resp.body.pipe(dest);
      resp.body.on('error', rej);
      dest.on('finish', res);
    });
  } catch (err) {
    logger.error({ cid, err }, 'IPFS download failed — catalog transcode aborted');
    await fs.remove(tempDir);
    return;
  }

  logger.info({ cid, localFile }, 'IPFS download complete — starting GStreamer');

  // Detect source height (for video)
  let sourceHeight = 0;
  if (contentType === 'video' || contentType === 'art_animated') {
    try {
      const probeOut = await _probeVideo(localFile);
      sourceHeight   = probeOut.height || 720;
    } catch (_) {
      sourceHeight = 720;
    }
  }

  // Run pipeline
  const pipe = new GstPipeline({
    id:     cid,
    mode,
    hlsDir: outDir,
    caps:   gstCaps,
    logger,
  });

  try {
    await pipe.transcodeFile({ inputPath: localFile, contentType, sourceHeight });
  } catch (err) {
    logger.error({ cid, err }, 'GStreamer transcode error');
    await fs.remove(tempDir);
    return;
  }

  // Cleanup temp download
  await fs.remove(tempDir);

  logger.info({ cid, outDir }, 'Catalog transcode complete — HLS ready');

  // Emit notification if WebSocket server is available
  if (typeof broadcastToAll === 'function') {
    broadcastToAll({ type: 'transcode_complete', cid, hlsUrl: `/streams/${cid}/master.m3u8` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  [B]  STREAM READY CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/stream-ready/:cid
 *
 * Returns whether the HLS output for a given CID is ready to serve.
 * The frontend polls this after triggering a transcode, or calls it
 * before attempting to play a catalog asset.
 */
app.get('/api/stream-ready/:cid', async (req, res) => {
  const { cid } = req.params;
  const masterPath = path.join(STREAMS_ROOT, cid, 'master.m3u8');
  const thumbPath  = path.join(STREAMS_ROOT, cid, 'thumb.jpg');
  const ready      = await fs.pathExists(masterPath);

  // Check how many segments are available (rough progress indicator)
  let segCount = 0;
  if (ready) {
    try {
      const files = await fs.readdir(path.join(STREAMS_ROOT, cid));
      segCount = files.filter(f => f.endsWith('.ts')).length;
    } catch (_) {}
  }

  res.json({
    cid,
    ready,
    hlsUrl:   ready ? `/streams/${cid}/master.m3u8` : null,
    thumbUrl: (await fs.pathExists(thumbPath)) ? `/streams/${cid}/thumb.jpg` : null,
    segCount,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  [C]  DUAL-MODE LIVE  —  Replaces the single-mode /api/live-start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/live-start
 *
 * Body: {
 *   wallet,
 *   title,
 *   artistName,
 *   mode:    'production' | 'social'   ← NEW: creator chooses
 *   quality: '1080p' | '720p' | '480p' | '360p'
 *   audioOnly: boolean
 * }
 *
 * Mode implications:
 *   production — multi-bitrate, tee pipeline, archived to IPFS on end, royalty-eligible
 *   social     — single quality, 1s segments, no archive by default, fast
 */
app.post('/api/live-start', async (req, res) => {
  const {
    wallet, title, artistName,
    mode     = MODES.PRODUCTION,
    quality  = '720p',
    audioOnly = false,
  } = req.body || {};

  if (!wallet || !title || !artistName) {
    return res.status(400).json({ error: 'wallet, title, and artistName are required' });
  }

  const profiles = await loadProfiles();
  const profile  = profiles[wallet];
  const level    = getCapabilityLevel(profile || {});

  if (!['creator_active', 'nft_creator_active'].includes(level)) {
    return res.status(403).json({ error: 'Active creator subscription required' });
  }

  const sessionId  = uuidv4();
  const hlsDir     = path.join(HLS_ROOT, sessionId);
  await fs.ensureDir(hlsDir);

  // Quality → rung list
  const qualityOrder = ['1080p', '720p', '480p', '360p'];
  const qi           = qualityOrder.indexOf(quality);
  const qualities    = mode === MODES.SOCIAL
    ? [quality]
    : qualityOrder.slice(Math.max(0, qi));   // production: quality + all below

  const hlsUrl   = `/live/${sessionId}/master.m3u8`;
  const thumbUrl = `/live/${sessionId}/thumb.jpg`;

  // Build GstPipeline — will be used by the ingest path
  const { PassThrough } = require('stream');
  const passThrough = new PassThrough();

  const gstPipe = new GstPipeline({
    id:     sessionId,
    mode,
    hlsDir,
    caps:   gstCaps,
    logger,
  });

  // Start browser-pipe path immediately
  gstPipe.startBrowserLive({ passThrough, audioOnly, qualities });
  gstPipe.on('error',          err  => logger.error({ sessionId, err }, 'Pipeline error'));
  gstPipe.on('pipeline_closed', e   => logger.warn({ sessionId, ...e }, 'Pipeline closed unexpectedly'));
  gstPipe.on('all_dead',        ()  => {
    const s = activeSessions.get(sessionId);
    if (s && s.status === 'live') {
      s.status = 'ended_unexpectedly';
      broadcastToSession(sessionId, { type: 'stream_ended', sessionId, reason: 'pipeline_error' });
    }
  });

  const sessionMeta = {
    sessionId, wallet, title, artistName,
    mode, quality, audioOnly, qualities,
    startTime: Date.now(),
    hlsDir, hlsUrl, thumbnailUrl: thumbUrl,
    passThrough,
    gstPipe,
    ffmpegProc: null,
    viewers:    new Map(),
    chatHistory: [],
    tipsTotal:  0,
    peakViewers: 0,
    chunkCount: 0,
    status:     'live',
    archiveCid: null,
    endTime:    null,
    source:     'browser',
  };

  activeSessions.set(sessionId, sessionMeta);

  await saveLiveSession(sessionId, {
    sessionId, wallet, title, artistName,
    mode, source: 'browser',
    startTime: sessionMeta.startTime,
    hlsUrl, thumbnailUrl: thumbUrl,
    status: 'live',
  });

  broadcastToAll({
    type: 'session_started',
    sessionId, title, artistName,
    mode,
    thumbnailUrl: thumbUrl,
    hlsUrl,
    isSocial: mode === MODES.SOCIAL,
  });

  logger.info({
    sessionId, wallet, mode,
    engine: gstCaps.gstreamer ? 'gstreamer' : 'ffmpeg',
    qualities,
  }, 'Live session started');

  res.status(201).json({
    sessionId,
    hlsUrl,
    thumbnailUrl: thumbUrl,
    mode,
    qualities,
    engine: gstCaps.gstreamer ? 'gstreamer' : 'ffmpeg',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  [D]  STREAM KEY + RTMP ROUTES  (unchanged from previous version)
//       These power OBS/Larix/Streamlabs ingest → nginx-rtmp → gst-transcode.sh
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/stream-key/:wallet', async (req, res) => {
  const { wallet } = req.params;
  const profiles   = await loadProfiles();
  const profile    = profiles[wallet];
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const level = getCapabilityLevel(profile);
  if (!['creator_active', 'nft_creator_active'].includes(level)) {
    return res.status(403).json({ error: 'Active creator subscription required' });
  }

  if (!profile.stream_key) {
    profile.stream_key = uuidv4();
    profiles[wallet]   = profile;
    await saveProfiles(profiles);
  }

  const host = process.env.STREAM_HOST || 'YOUR_SERVER_IP';
  res.json({
    stream_key:  profile.stream_key,
    rtmp_server: `rtmp://${host}:1935/live`,
    rtmp_url:    `rtmp://${host}:1935/live/${profile.stream_key}`,
    hls_preview: `https://${host}/live/[sessionId]/master.m3u8`,
    instructions: {
      obs:       `Settings → Stream → Service: Custom RTMP | Server: rtmp://${host}:1935/live | Key: ${profile.stream_key}`,
      larix:     `Connections → Add → URL: rtmp://${host}:1935/live/${profile.stream_key}`,
      streamlabs:`RTMP Server: rtmp://${host}:1935/live | Stream Key: ${profile.stream_key}`,
    },
  });
});

app.post('/api/stream-key/regenerate', async (req, res) => {
  const { wallet } = req.body || {};
  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });
  const profiles = await loadProfiles();
  const profile  = profiles[wallet];
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const level = getCapabilityLevel(profile);
  if (!['creator_active', 'nft_creator_active'].includes(level)) {
    return res.status(403).json({ error: 'Active creator subscription required' });
  }

  const oldKey       = profile.stream_key;
  profile.stream_key = uuidv4();
  profiles[wallet]   = profile;
  await saveProfiles(profiles);

  if (oldKey && rtmpSessions && rtmpSessions.has(oldKey)) {
    const s = rtmpSessions.get(oldKey);
    if (s) broadcastToSession(s.sessionId, { type: 'stream_ended', reason: 'key_regenerated' });
    rtmpSessions.delete(oldKey);
  }

  logger.info({ wallet }, 'Stream key regenerated');
  res.json({ stream_key: profile.stream_key });
});

// nginx-rtmp on_publish — validate stream key, allow or deny
app.post('/api/rtmp-auth', async (req, res) => {
  const streamKey = req.body?.name || req.query?.name;
  if (!streamKey) return res.status(403).send('DENY: no stream key');

  const profiles = await loadProfiles();
  const entry    = Object.entries(profiles).find(([, p]) => p.stream_key === streamKey);
  if (!entry) return res.status(403).send('DENY: unknown key');

  const [wallet, profile] = entry;
  const level             = getCapabilityLevel(profile);
  if (!['creator_active', 'nft_creator_active'].includes(level)) {
    logger.warn({ wallet }, 'RTMP auth denied: subscription inactive');
    return res.status(403).send('DENY: subscription inactive');
  }

  logger.info({ wallet, streamKey }, 'RTMP auth: ALLOW');
  res.status(200).send('OK');
});

// gst-transcode.sh calls this after nginx-rtmp accepts the stream
app.post('/api/rtmp-publish', async (req, res) => {
  const { streamKey, mode = MODES.PRODUCTION } = req.body || {};
  if (!streamKey) return res.status(400).json({ error: 'Missing streamKey' });

  const profiles = await loadProfiles();
  const entry    = Object.entries(profiles).find(([, p]) => p.stream_key === streamKey);
  if (!entry) return res.status(403).json({ error: 'Invalid stream key' });

  const [wallet, profile] = entry;
  const sessionId         = uuidv4();
  const hlsDir            = path.join(HLS_ROOT, sessionId);
  await fs.ensureDir(hlsDir);

  const sessionMeta = {
    sessionId, wallet,
    artistName:  profile.name || 'Creator',
    title:       `Live — ${profile.name || 'Creator'}`,
    mode,
    startTime:   Date.now(),
    hlsDir,
    hlsUrl:      `/live/${sessionId}/master.m3u8`,
    thumbnailUrl: `/live/${sessionId}/thumb.jpg`,
    source:      'rtmp',
    passThrough: null,
    gstPipe:     null,
    viewers:     new Map(),
    chatHistory: [],
    tipsTotal:   0,
    peakViewers: 0,
    chunkCount:  0,
    status:      'starting',
    archiveCid:  null,
    endTime:     null,
  };

  activeSessions.set(sessionId, sessionMeta);
  if (typeof rtmpSessions !== 'undefined') rtmpSessions.set(streamKey, { sessionId, wallet, startedAt: Date.now() });

  await saveLiveSession(sessionId, {
    sessionId, wallet, title: sessionMeta.title,
    artistName: sessionMeta.artistName, mode, source: 'rtmp',
    startTime: sessionMeta.startTime, hlsUrl: sessionMeta.hlsUrl,
    thumbnailUrl: sessionMeta.thumbnailUrl, status: 'starting',
  });

  broadcastToAll({ type: 'session_started', sessionId, title: sessionMeta.title,
    artistName: sessionMeta.artistName, thumbnailUrl: sessionMeta.thumbnailUrl,
    hlsUrl: sessionMeta.hlsUrl, mode });

  logger.info({ sessionId, wallet, mode }, 'RTMP publish session created');
  res.json({
    sessionId,
    hlsDir,
    qualities: mode === MODES.SOCIAL ? ['480p'] : ['720p', '480p'],
    audioOnly: false,
    mode,
  });
});

// gst-transcode.sh calls this when GStreamer pipelines are running
app.post('/api/rtmp-live-ready', async (req, res) => {
  const { sessionId } = req.body || {};
  const session = activeSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.status = 'live';
  await saveLiveSession(sessionId, { ...((await loadLiveSessions())[sessionId] || {}), status: 'live' });
  broadcastToSession(sessionId, { type: 'stream_ready', sessionId, hlsUrl: session.hlsUrl });
  res.json({ success: true });
});

// nginx-rtmp on_done + gst-transcode-done.sh
app.post('/api/rtmp-done', async (req, res) => {
  const streamKey = req.body?.name || req.body?.streamKey;
  if (!streamKey) return res.status(400).json({ error: 'Missing stream key' });

  const rtmpInfo  = typeof rtmpSessions !== 'undefined' ? rtmpSessions.get(streamKey) : null;
  if (!rtmpInfo) return res.json({ success: true, sessionId: null });

  const { sessionId, wallet } = rtmpInfo;
  const session               = activeSessions.get(sessionId);

  if (session && session.status === 'live') {
    session.status  = 'ended_clean';
    session.endTime = Date.now();
    const duration  = Math.floor((session.endTime - session.startTime) / 1000);

    broadcastToSession(sessionId, { type: 'stream_ended', sessionId, reason: 'creator_ended', duration });
    await saveLiveSession(sessionId, {
      sessionId, wallet, title: session.title, artistName: session.artistName,
      startTime: session.startTime, endTime: session.endTime, duration,
      hlsUrl: session.hlsUrl, tipsTotal: session.tipsTotal,
      peakViewers: session.peakViewers, status: 'ended_clean', mode: session.mode,
    });
    broadcastToAll({ type: 'session_ended', sessionId });
  }

  if (typeof rtmpSessions !== 'undefined') rtmpSessions.delete(streamKey);
  logger.info({ sessionId, wallet }, 'RTMP done');
  res.json({ success: true, sessionId });
});

// ─────────────────────────────────────────────────────────────────────────────
//  [E]  MEDIA CAPABILITIES endpoint
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/media-capabilities', (req, res) => {
  res.json({
    gstreamer:   gstCaps.gstreamer   || false,
    gstVersion:  gstCaps.gstVersion  || null,
    hwAccel:     gstCaps.nvenc       ? 'nvidia'
               : gstCaps.vaapi       ? 'vaapi'
               : gstCaps.videotoolbox ? 'videotoolbox'
               : 'software',
    hlssink2:    gstCaps.hlssink2    || false,
    level:       gstCaps.level       || false,
    jpegenc:     gstCaps.jpegenc     || false,
    rtmpsrc:     gstCaps.rtmpsrc     || false,
    ffmpeg:      gstCaps.ffmpeg      || false,
    ffmpegVersion: gstCaps.ffmpegVersion || null,
    liveEngine:  gstCaps.gstreamer   ? 'gstreamer' : 'ffmpeg',
    catalogEngine: gstCaps.gstreamer ? 'gstreamer' : 'ffmpeg',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _extForType(contentType) {
  switch (contentType) {
    case 'music':        return '.mp3';
    case 'podcast':      return '.mp3';
    case 'video':        return '.mp4';
    case 'art_animated': return '.mp4';
    default:             return '.bin';
  }
}

async function _probeVideo(filePath) {
  const { default: nodeFetch } = require('node-fetch');
  // Use ffprobe for height detection
  const { spawn: _spawn } = require('child_process');
  return new Promise((resolve) => {
    const chunks = [];
    const p = _spawn(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => chunks.push(d));
    p.on('close', () => {
      try {
        const data    = JSON.parse(Buffer.concat(chunks).toString());
        const vStream = data.streams?.find(s => s.codec_type === 'video');
        resolve({ height: vStream?.height || 720, width: vStream?.width || 1280 });
      } catch (_) {
        resolve({ height: 720, width: 1280 });
      }
    });
    p.on('error', () => resolve({ height: 720, width: 1280 }));
  });
}
