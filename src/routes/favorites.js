'use strict';

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { PLAYLIST_CAPABLE_LEVELS } = require('../config/constants');
const profileService = require('../services/profileService');

const router = express.Router();

// SPEC: Favorites are available to ALL user roles — no subscription gate.
// Favoriting alone generates NO royalty event.
// Any complete playthrough of a favorited track IS royalty-eligible (same as any play).

// GET /api/favorites/:wallet
router.get('/:wallet', async (req, res, next) => {
  try {
    const profiles = await profileService.loadProfiles();
    const profile  = profiles[req.params.wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ favorites: profile.favorites || [] });
  } catch (err) { next(err); }
});

// POST /api/favorites/add
router.post('/add', async (req, res, next) => {
  try {
    const { wallet, cid } = req.body || {};
    if (!wallet || !cid) return res.status(400).json({ error: 'Missing wallet or cid' });

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    if (!profiles[wallet].favorites) profiles[wallet].favorites = [];
    if (!profiles[wallet].favorites.includes(cid)) {
      profiles[wallet].favorites.push(cid);
      await profileService.saveProfiles(profiles);
    }

    res.json({ success: true, favorites: profiles[wallet].favorites });
  } catch (err) { next(err); }
});

// POST /api/favorites/remove
router.post('/remove', async (req, res, next) => {
  try {
    const { wallet, cid } = req.body || {};
    if (!wallet || !cid) return res.status(400).json({ error: 'Missing wallet or cid' });

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    profiles[wallet].favorites = (profiles[wallet].favorites || []).filter((c) => c !== cid);
    await profileService.saveProfiles(profiles);
    res.json({ success: true, favorites: profiles[wallet].favorites });
  } catch (err) { next(err); }
});

// POST /api/favorites/convert-to-playlist
router.post('/convert-to-playlist', async (req, res, next) => {
  try {
    const { wallet, name, cids, isPublic = true } = req.body || {};
    if (!wallet || !name || !Array.isArray(cids) || !cids.length) {
      return res.status(400).json({ error: 'Missing wallet, name, or cids' });
    }

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    const level = profileService.getCapabilityLevel(profiles[wallet]);
    if (!PLAYLIST_CAPABLE_LEVELS.has(level)) {
      return res.status(403).json({ error: 'Tier 2 or higher required to create playlists from Favorites' });
    }

    const playlistId = uuidv4();
    const playlist   = {
      id:           playlistId,
      name,
      cids,
      wallet,
      sharePercent:    8,
      isPublic:        !!isPublic,
      royaltyEligible: !!isPublic,
      fromFavorites:   true,
      createdAt:       Date.now(),
    };

    if (!profiles[wallet].playlists) profiles[wallet].playlists = [];
    profiles[wallet].playlists.push(playlist);
    await profileService.saveProfiles(profiles);

    logger.info({ wallet, playlistId, name, cidsCount: cids.length, isPublic }, 'Favorites converted to playlist');
    res.status(201).json({ success: true, playlist });
  } catch (err) { next(err); }
});

module.exports = router;
