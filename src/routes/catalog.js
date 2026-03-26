'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs-extra');
const logger         = require('../config/logger');
const catalogService = require('../services/catalogService');
const playlistService = require('../services/playlistService');
const ownershipGuard = require('../middleware/ownershipGuard');

const router = express.Router();

// GET /api/catalog
router.get('/', async (req, res, next) => {
  try {
    const catalog = await catalogService.loadCatalog();
    const entries = Object.values(catalog).sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(entries);
  } catch {
    res.json([]);
  }
});

// GET /api/catalog/:contentId/metadata
router.get('/:contentId/metadata', async (req, res, next) => {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'catalog', req.params.contentId, 'metadata.json');
    const raw = await fs.readFile(metaPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// POST /api/catalog/:contentId/supporter-royalty
// Toggles the supporterRoyaltyEnabled flag on a catalog entry.
// ownershipGuard verifies wallet owns the asset before this handler runs.
router.post('/:contentId/supporter-royalty', ownershipGuard, async (req, res, next) => {
  try {
    const { contentId } = req.params;
    const { enabled } = req.body || {};

    const updated = await catalogService.patchCatalogEntry(contentId, {
      supporterRoyaltyEnabled: !!enabled,
      supporterRoyaltyChangedAt: Date.now(),
    });

    const playlistSync = await playlistService.syncCatalogEntryAcrossPlaylists(contentId, updated);

    logger.info({ contentId, enabled: !!enabled, playlistSync }, 'Supporter royalty flag updated and playlists synced');

    res.json({
      success: true,
      contentId,
      supporterRoyaltyEnabled: !!enabled,
      playlistSync,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/catalog/:contentId/privacy
// Toggles the isPrivate flag on a catalog entry and syncs matching playlist items.
router.post('/:contentId/privacy', ownershipGuard, async (req, res, next) => {
  try {
    const { contentId } = req.params;
    const { isPrivate } = req.body || {};

    const updated = await catalogService.patchCatalogEntry(contentId, {
      isPrivate: !!isPrivate,
      privacyChangedAt: Date.now(),
    });

    const playlistSync = await playlistService.syncCatalogEntryAcrossPlaylists(contentId, updated);

    logger.info({ contentId, isPrivate: !!isPrivate, playlistSync }, 'Asset privacy updated and playlists synced');
    res.json({ success: true, contentId, isPrivate: !!isPrivate, playlistSync });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
