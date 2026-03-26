'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs-extra');
const logger         = require('../config/logger');
const catalogService = require('../services/catalogService');
const ownershipGuard = require('../middleware/ownershipGuard');

const router = express.Router();

// GET /api/catalog
router.get('/', async (req, res, next) => {
  try {
    const catalog = await catalogService.loadCatalog();
    const entries = Object.values(catalog).sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(entries);
  } catch { res.json([]); }
});

// GET /api/catalog/:contentId/metadata
router.get('/:contentId/metadata', async (req, res, next) => {
  try {
    const metaPath = path.join(process.cwd(), 'public', 'catalog', req.params.contentId, 'metadata.json');
    const raw      = await fs.readFile(metaPath, 'utf8');
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
    const { enabled }   = req.body || {};

    const updated = await catalogService.patchCatalogEntry(contentId, {
      supporterRoyaltyEnabled:   !!enabled,
      supporterRoyaltyChangedAt: Date.now(),
    });

    logger.info({ contentId, enabled }, 'Supporter royalty flag updated');

    // TODO (production): when enabled === false, notify supporters who have
    // this asset in playlists so they can remove it. Hook in here.

    res.json({ success: true, contentId, supporterRoyaltyEnabled: !!enabled });
  } catch (err) { next(err); }
});

// POST /api/catalog/:contentId/privacy
// Toggles the isPrivate flag on a catalog entry.
router.post('/:contentId/privacy', ownershipGuard, async (req, res, next) => {
  try {
    const { contentId } = req.params;
    const { isPrivate } = req.body || {};

    const updated = await catalogService.patchCatalogEntry(contentId, {
      isPrivate: !!isPrivate,
    });

    logger.info({ contentId, isPrivate }, 'Asset privacy updated');
    res.json({ success: true, contentId, isPrivate: !!isPrivate });
  } catch (err) { next(err); }
});

module.exports = router;
