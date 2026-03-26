'use strict';

const express = require('express');
const logger = require('../config/logger');
const { PLAYLIST_CAPABLE_LEVELS } = require('../config/constants');
const profileService = require('../services/profileService');
const playlistService = require('../services/playlistService');

const router = express.Router();

function normalizeWallet(wallet) {
  return playlistService.normalizeWallet(wallet);
}

async function assertPlaylistCapability(wallet) {
  const profiles = await profileService.loadProfiles();
  const normalizedWallet = normalizeWallet(wallet);
  const profile = profiles[normalizedWallet];

  if (!profile) {
    const err = new Error('Profile not found');
    err.statusCode = 404;
    throw err;
  }

  const level = profileService.getCapabilityLevel(profile);
  if (!PLAYLIST_CAPABLE_LEVELS.has(level)) {
    const err = new Error('Tier 2 or higher subscription required to manage playlists');
    err.statusCode = 403;
    throw err;
  }

  return profile;
}

router.get('/', async (req, res, next) => {
  try {
    const playlists = await playlistService.listPublicPlaylists();
    res.json(playlists);
  } catch (err) {
    next(err);
  }
});

router.get('/mine/:wallet', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.params.wallet);
    const playlists = await playlistService.listPlaylistsForWallet(wallet, { includePrivate: true });
    res.json({ playlists });
  } catch (err) {
    next(err);
  }
});


router.get('/assets/:wallet/analytics', async (req, res, next) => {
  try {
    const wallet = playlistService.normalizeWallet(req.params.wallet);
    const analytics = await playlistService.getCreatorAssetPlaylistAnalytics(wallet);
    res.json(analytics);
  } catch (err) {
    next(err);
  }
});

router.get('/:playlistId/analytics', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.query.wallet || req.body?.wallet || '');
    const playlist = await playlistService.getPlaylistForRead({ wallet, playlistId: req.params.playlistId });
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    res.json({
      playlistId: playlist.id,
      name: playlist.name,
      analytics: playlist.analyticsView,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:playlistId', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.query.wallet || req.body?.wallet || '');
    const playlist = await playlistService.getPlaylistForRead({ wallet, playlistId: req.params.playlistId });
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { wallet, name, description, isPublic = true, sharePercent = 8, cids = [], contentIds = [] } = req.body || {};
    if (!wallet || !name) {
      return res.status(400).json({ error: 'Missing wallet or name' });
    }

    await assertPlaylistCapability(wallet);
    const playlist = await playlistService.createPlaylist({
      wallet,
      name,
      description,
      isPublic,
      sharePercent,
      contentIds: Array.isArray(contentIds) && contentIds.length ? contentIds : cids,
    });

    logger.info({ wallet: normalizeWallet(wallet), playlistId: playlist.id, name: playlist.name }, 'Playlist created');
    res.status(201).json({ success: true, playlist });
  } catch (err) {
    next(err);
  }
});

router.patch('/:playlistId', async (req, res, next) => {
  try {
    const { wallet, name, description, isPublic, sharePercent } = req.body || {};
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    await assertPlaylistCapability(wallet);
    const playlist = await playlistService.patchPlaylist({
      wallet,
      playlistId: req.params.playlistId,
      updates: { name, description, isPublic, sharePercent },
    });

    res.json({ success: true, playlist });
  } catch (err) {
    next(err);
  }
});

router.delete('/:playlistId', async (req, res, next) => {
  try {
    const wallet = normalizeWallet(req.query.wallet || req.body?.wallet || '');
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    await assertPlaylistCapability(wallet);
    await playlistService.deletePlaylist({ wallet, playlistId: req.params.playlistId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:playlistId/add', async (req, res, next) => {
  try {
    const { wallet, contentId, cid } = req.body || {};
    const assetId = contentId || cid;
    if (!wallet || !assetId) {
      return res.status(400).json({ error: 'Missing wallet or contentId' });
    }

    await assertPlaylistCapability(wallet);
    const playlist = await playlistService.addItemToPlaylist({
      wallet,
      playlistId: req.params.playlistId,
      contentId: assetId,
    });

    res.json({ success: true, playlist });
  } catch (err) {
    next(err);
  }
});

router.post('/:playlistId/remove', async (req, res, next) => {
  try {
    const { wallet, contentId, cid } = req.body || {};
    const assetId = contentId || cid;
    if (!wallet || !assetId) {
      return res.status(400).json({ error: 'Missing wallet or contentId' });
    }

    await assertPlaylistCapability(wallet);
    const playlist = await playlistService.removeItemFromPlaylist({
      wallet,
      playlistId: req.params.playlistId,
      contentId: assetId,
    });

    res.json({ success: true, playlist });
  } catch (err) {
    next(err);
  }
});

router.post('/:playlistId/reorder', async (req, res, next) => {
  try {
    const { wallet, orderedContentIds } = req.body || {};
    if (!wallet || !Array.isArray(orderedContentIds) || !orderedContentIds.length) {
      return res.status(400).json({ error: 'Missing wallet or orderedContentIds' });
    }

    await assertPlaylistCapability(wallet);
    const playlist = await playlistService.reorderPlaylistItems({
      wallet,
      playlistId: req.params.playlistId,
      orderedContentIds,
    });

    res.json({ success: true, playlist });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
