'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { STREAM_DURATION_LIMITS } = require('../config/constants');
const { isDevWallet } = require('../middleware/devBypass');
const profileService  = require('../services/profileService');
const sessionStore    = require('../state/liveSessions');

const router = express.Router();

// POST /api/live-start
router.post('/start', async (req, res, next) => {
  try {
    const { wallet, title, artistName, quality = '720p' } = req.body || {};
    if (!wallet || !title || !artistName) {
      return res.status(400).json({ error: 'Missing wallet, title, or artistName' });
    }

    if (!isDevWallet(wallet)) {
      const profiles = await profileService.loadProfiles();
      const level    = profileService.getCapabilityLevel(profiles[wallet]);
      if (!['creator_active', 'nft_creator_active'].includes(level)) {
        return res.status(403).json({ error: 'Active creator subscription required to go live.' });
      }
    }

    const profiles    = await profileService.loadProfiles();
    const accountType = profiles[wallet]?.account_type || 'creator';
    const sessionId   = uuidv4();

    sessionStore.createSession(sessionId, { wallet, title, artistName, quality, accountType });
    logger.info({ sessionId, wallet, title }, 'Live session started');

    res.status(201).json({
      success:      true,
      sessionId,
      hlsUrl:       `/live/${sessionId}/master.m3u8`,
      thumbnailUrl: `/live/${sessionId}/thumbnail.jpg`,
    });
  } catch (err) { next(err); }
});

// POST /api/live-end/:sessionId
router.post('/end/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { wallet }    = req.body || {};
    const session       = sessionStore.getSession(sessionId);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.wallet !== wallet && !isDevWallet(wallet)) {
      return res.status(403).json({ error: 'Not your session' });
    }

    const ended    = sessionStore.endSession(sessionId);
    const duration = Math.floor((ended.endTime - ended.startTime) / 1000);

    logger.info({ sessionId, duration, peakViewers: ended.peakViewers, tipsTotal: ended.tipsTotal }, 'Live session ended');
    res.json({ success: true, sessionId, duration, peakViewers: ended.peakViewers, tipsTotal: ended.tipsTotal });
  } catch (err) { next(err); }
});

// POST /api/live-ingest/:sessionId  (binary chunk upload)
router.post('/ingest/:sessionId',
  express.raw({ type: 'application/octet-stream', limit: '20mb' }),
  (req, res) => {
    const session = sessionStore.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.alive) return res.status(410).json({ status: 'ended_unexpectedly' });

    const elapsed = Date.now() - session.startTime;
    const cap     = STREAM_DURATION_LIMITS[session.accountType] ?? STREAM_DURATION_LIMITS.creator;

    if (elapsed > cap) {
      sessionStore.endSession(req.params.sessionId);
      return res.status(410).json({
        status: 'duration_cap_reached',
        error:  session.accountType === 'creator'
          ? 'Your 3-hour stream limit has been reached. Upgrade to Platform NFT Creator for unlimited streaming.'
          : 'Stream duration limit reached.',
        cap_ms: cap,
      });
    }

    if (req.body?.length) {
      session.chunks.push(req.body);
      session.chunkCount++;
    }
    res.json({ success: true, chunkCount: session.chunkCount });
  }
);

// GET /api/live-concerts
router.get('/concerts', (req, res) => {
  res.json(sessionStore.getAllActive().map((s) => ({
    cid:             s.sessionId,
    sessionId:       s.sessionId,
    artist:          s.artistName,
    artistWallet:    s.wallet,
    title:           s.title,
    contractAddress: null,
    live:            true,
    hlsUrl:          `/live/${s.sessionId}/master.m3u8`,
    viewerCount:     s.viewerCount,
    duration:        Math.floor((Date.now() - s.startTime) / 1000),
    thumbnailUrl:    `/live/${s.sessionId}/thumbnail.jpg`,
  })));
});

// GET /api/live-recording/:sessionId  (download archived stream)
router.get('/recording/:sessionId', (req, res) => {
  const session = sessionStore.getSession(req.params.sessionId);
  const { wallet } = req.query;

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.wallet !== wallet && !isDevWallet(wallet)) {
    return res.status(403).json({ error: 'Not your session' });
  }
  if (session.alive) return res.status(409).json({ error: 'Stream still live — end it first.' });
  if (!session.chunks?.length) return res.status(404).json({ error: 'No recording data available.' });

  const total    = session.chunks.reduce((n, c) => n + c.length, 0);
  const merged   = Buffer.concat(session.chunks, total);
  const safeName = (session.title || 'stream').replace(/[^a-z0-9_\-\s]/gi, '_').replace(/\s+/g, '_');
  const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.webm`;

  logger.info({ sessionId: req.params.sessionId, bytes: total, filename }, 'Live recording download served');
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', total);
  res.send(merged);
});

// POST /api/start-live-encode  (external FFmpeg encoder)
router.post('/start-encode', async (req, res, next) => {
  try {
    const { wallet, eventTitle, artistName, inputSource = 'rtmp://localhost/live/djset' } = req.body || {};
    if (!wallet || !eventTitle || !artistName) {
      return res.status(400).json({ error: 'wallet, eventTitle, and artistName are required' });
    }

    if (!isDevWallet(wallet)) {
      const profiles = await profileService.loadProfiles();
      const level    = profileService.getCapabilityLevel(profiles[wallet]);
      if (!['creator_active', 'nft_creator_active'].includes(level)) {
        return res.status(403).json({ error: 'An active creator subscription is required to host live concerts.' });
      }
    }

    const ffmpegPath  = process.env.FFMPEG_PATH || 'ffmpeg';
    const productionID = `${artistName.replace(/\s+/g, '_')}_${eventTitle.replace(/\s+/g, '_')}_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const outputDir   = path.join(process.cwd(), 'public', 'live', productionID);
    await fs.ensureDir(outputDir);

    const ffmpegArgs = buildLiveEncodeArgs(inputSource, outputDir);
    const { spawn }  = require('child_process');
    const proc       = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stderr.on('data', (d) => logger.debug(`FFmpeg: ${d}`));
    proc.on('error', (err) => logger.error({ productionID, err }, 'FFmpeg error'));
    proc.on('close',  (code) => logger.info({ productionID, code }, 'Live encode closed'));

    logger.info({ productionID, inputSource }, 'Live encode started');
    res.status(201).json({
      success:      true,
      productionID,
      hlsUrl:       `/live/${productionID}/master.m3u8`,
      thumbnailUrl: `/live/${productionID}/thumbnail.jpg`,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start live encode');
    res.status(500).json({ success: false, error: err.message });
  }
});

function buildLiveEncodeArgs(inputSource, outputDir) {
  return [
    '-i', inputSource,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+independent_segments',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0',
    `${outputDir}/v%v.m3u8`,
    '-vf', 'fps=1/10,scale=320:-1', '-update', '1', `${outputDir}/thumbnail.jpg`,
  ];
}

module.exports = router;
