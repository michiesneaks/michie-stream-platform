'use strict';

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { PLAYLIST_CAPABLE_LEVELS } = require('../config/constants');
const profileService = require('../services/profileService');

const router = express.Router();

// GET /api/playlists
router.get('/', async (req, res, next) => {
  try {
    const profiles  = await profileService.loadProfiles();
    const playlists = Object.values(profiles)
      .flatMap((p) => p.playlists || [])
      .filter((pl) => !pl.isPrivate);
    res.json(playlists);
  } catch (err) { next(err); }
});

// POST /api/create-playlist
router.post('/', async (req, res, next) => {
  try {
    const { wallet, name, cids, sharePercent = 8 } = req.body || {};
    if (!wallet || !name || !Array.isArray(cids) || !cids.length) {
      return res.status(400).json({ error: 'Missing wallet, name, or cids' });
    }

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    const level = profileService.getCapabilityLevel(profiles[wallet]);
    if (!PLAYLIST_CAPABLE_LEVELS.has(level)) {
      return res.status(403).json({ error: 'Tier 2 or higher subscription required to create playlists' });
    }

    const playlistId = uuidv4();
    const playlist   = { id: playlistId, name, cids, wallet, sharePercent, createdAt: Date.now() };

    if (!profiles[wallet].playlists) profiles[wallet].playlists = [];
    profiles[wallet].playlists.push(playlist);
    await profileService.saveProfiles(profiles);

    logger.info({ wallet, playlistId, name }, 'Playlist created');
    res.status(201).json({ success: true, playlist });
  } catch (err) { next(err); }
});

module.exports = router;
