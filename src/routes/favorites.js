'use strict';

const express = require('express');
const logger = require('../config/logger');
const { PLAYLIST_CAPABLE_LEVELS } = require('../config/constants');
const profileService = require('../services/profileService');
const playlistService = require('../services/playlistService');

const router = express.Router();

// SPEC: Favorites are available to ALL user roles — no subscription gate.
// Favoriting alone generates NO royalty event.
// Any complete playthrough of a favorited track IS royalty-eligible (same as any play).

function normalizeWallet(wallet) {
  return playlistService.normalizeWallet(wallet);
}

// GET /api/favorites/:wallet
router.get('/:wallet', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.params.wallet);
    const profiles = await profileService.loadProfiles();
    const profile = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ favorites: profile.favorites || [] });
  } catch (err) { next(err); }
});

// POST /api/favorites/add
router.post('/add', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.body?.wallet);
    const cid = req.body?.cid;
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
    const wallet = normalizeWallet(req.body?.wallet);
    const cid = req.body?.cid;
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
    const wallet = normalizeWallet(req.body?.wallet);
    const name = req.body?.name;
    const cids = req.body?.cids;
    const isPublic = req.body?.isPublic !== false;
    if (!wallet || !name || !Array.isArray(cids) || !cids.length) {
      return res.status(400).json({ error: 'Missing wallet, name, or cids' });
    }

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    const level = profileService.getCapabilityLevel(profiles[wallet]);
    if (!PLAYLIST_CAPABLE_LEVELS.has(level)) {
      return res.status(403).json({ error: 'Tier 2 or higher required to create playlists from Favorites' });
    }

    const playlist = await playlistService.createPlaylist({
      wallet,
      name,
      description: 'Converted from public favorites list',
      isPublic,
      sharePercent: 8,
      contentIds: cids,
      addedFrom: 'favorites',
    });

    logger.info({ wallet, playlistId: playlist.id, name, cidsCount: cids.length, isPublic }, 'Favorites converted to rich playlist');
    res.status(201).json({ success: true, playlist });
  } catch (err) { next(err); }
});

module.exports = router;
