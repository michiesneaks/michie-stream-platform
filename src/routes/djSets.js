'use strict';

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { DJ_CAPABLE_LEVELS } = require('../config/constants');
const { isDevWallet } = require('../middleware/devBypass');
const profileService  = require('../services/profileService');
const djService       = require('../services/djService');

const router = express.Router();

// POST /api/start-dj-set
router.post('/start', async (req, res, next) => {
  try {
    const { wallet, set_name, tips_enabled, dj_percent, artist_splits } = req.body || {};
    if (!wallet || !set_name) return res.status(400).json({ error: 'Missing wallet or set_name' });

    if (!isDevWallet(wallet)) {
      const profiles = await profileService.loadProfiles();
      const profile  = profiles[wallet];
      if (!profile) return res.status(403).json({ error: 'Profile not found' });

      const level = profileService.getCapabilityLevel(profile);
      const canDj = DJ_CAPABLE_LEVELS.has(level)
        || (profile.supporter_subaccount?.enabled && profileService.isSubscriptionActive(profile));
      if (!canDj) {
        return res.status(403).json({ error: 'A Tier 2 or higher subscription is required to host DJ sets.' });
      }
    }

    const profiles       = await profileService.loadProfiles();
    const profile        = profiles[wallet] || {};
    const tipsForThisSet = typeof tips_enabled === 'boolean'
      ? tips_enabled
      : (profile.dj_settings?.tips_enabled_default ?? true);

    const setId = uuidv4();
    const sets  = await djService.loadDjSets();
    sets[setId] = {
      set_id:        setId,
      dj_wallet:     wallet,
      set_name,
      tips_enabled:  tipsForThisSet,
      dj_percent:    dj_percent ?? 100,
      artist_splits: artist_splits || [],
      created_at:    Date.now(),
      active:        true,
    };
    await djService.saveDjSets(sets);

    res.status(201).json({ success: true, set_id: setId, tips_enabled: tipsForThisSet });
  } catch (err) { next(err); }
});

// POST /api/end-dj-set
router.post('/end', async (req, res, next) => {
  try {
    const { wallet, set_id } = req.body || {};
    const sets = await djService.loadDjSets();
    if (!sets[set_id] || sets[set_id].dj_wallet !== wallet) {
      return res.status(403).json({ error: 'Set not found or not owned by this wallet' });
    }
    sets[set_id].active = false;
    await djService.saveDjSets(sets);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
