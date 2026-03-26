'use strict';

const catalogService = require('../services/catalogService');
const { isDevWallet } = require('./devBypass');

/**
 * Express middleware — verifies that req.body.wallet owns the catalog asset
 * identified by req.params.contentId.
 *
 * Usage: router.post('/:contentId/something', ownershipGuard, handler)
 */
async function ownershipGuard(req, res, next) {
  const { contentId } = req.params;
  const { wallet }    = req.body || {};

  if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

  // DEV_WALLET bypasses ownership check
  if (isDevWallet(wallet)) return next();

  try {
    const catalog = await catalogService.loadCatalog();
    const entry   = catalog[contentId];
    if (!entry) return res.status(404).json({ error: 'Asset not found' });
    if ((entry.wallet || '').toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Not your asset' });
    }
    // Attach the entry to the request so handlers don't re-read the catalog
    req.catalogEntry = entry;
    req.catalog      = catalog;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = ownershipGuard;
