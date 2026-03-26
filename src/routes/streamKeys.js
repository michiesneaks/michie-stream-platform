'use strict';

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const profileService = require('../services/profileService');

const router = express.Router();

function buildStreamKeyResponse(profile) {
  const rtmpHost = process.env.RTMP_HOST || 'rtmp://localhost/live';
  return {
    streamKey:   profile.stream_key,
    rtmpUrl:     rtmpHost,
    fullUrl:     `${rtmpHost}/${profile.stream_key}`,
    playbackUrl: `/live/${profile.stream_key}/master.m3u8`,
  };
}

// GET /api/stream-key/:wallet
router.get('/:wallet', async (req, res, next) => {
  try {
    const profiles = await profileService.loadProfiles();
    const profile  = profiles[req.params.wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (!['creator', 'platform_nft_creator'].includes(profile.account_type)) {
      return res.status(403).json({ error: 'Creator account required for stream key' });
    }

    if (!profile.stream_key) {
      profile.stream_key = uuidv4().replace(/-/g, '');
      profiles[req.params.wallet] = profile;
      await profileService.saveProfiles(profiles);
    }

    res.json(buildStreamKeyResponse(profile));
  } catch (err) { next(err); }
});

// POST /api/stream-key/regenerate
router.post('/regenerate', async (req, res, next) => {
  try {
    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    profile.stream_key = uuidv4().replace(/-/g, '');
    profiles[wallet]   = profile;
    await profileService.saveProfiles(profiles);

    logger.info({ wallet }, 'Stream key regenerated');
    res.json(buildStreamKeyResponse(profile));
  } catch (err) { next(err); }
});

module.exports = router;
