'use strict';

const express        = require('express');
const profileService = require('../services/profileService');

const router = express.Router();

// GET /api/access/:wallet
router.get('/:wallet', async (req, res, next) => {
  try {
    const profiles = await profileService.loadProfiles();
    const profile  = profiles[req.params.wallet];
    const level    = profileService.getCapabilityLevel(profile);
    const tier     = profileService.getListenerTier(profile);

    res.json({
      level,
      tier,
      account_type:        profile?.account_type      || null,
      subscription_expiry: profile?.subscription_expiry || null,
      active:              profileService.isSubscriptionActive(profile),
      royalty_fee_rate:    profile?.royalty_fee_rate   || null,
      dj_tips_default:     profile?.dj_settings?.tips_enabled_default ?? true,
      supporter_enabled:   profile?.supporter_subaccount?.enabled || false,
    });
  } catch (err) { next(err); }
});

// POST /api/add-supporter-subaccount
router.post('/add-supporter-subaccount', async (req, res, next) => {
  try {
    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (!['creator', 'platform_nft_creator'].includes(profile.account_type)) {
      return res.status(403).json({ error: 'Only creator accounts can add a supporter sub-account' });
    }

    profile.supporter_subaccount = {
      enabled:                true,
      linked_creator_wallet:  wallet,
      royalty_beneficiary_of: profile.supporter_subaccount?.royalty_beneficiary_of || [],
    };

    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);
    res.json({ success: true, supporter_subaccount: profile.supporter_subaccount });
  } catch (err) { next(err); }
});

// POST /api/toggle-supporter-subaccount
router.post('/toggle-supporter-subaccount', async (req, res, next) => {
  try {
    const { wallet, enabled } = req.body || {};
    if (!wallet || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Missing wallet or enabled flag' });
    }

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (!profile.supporter_subaccount) {
      return res.status(400).json({ error: 'No supporter sub-account. Call /api/add-supporter-subaccount first.' });
    }

    profile.supporter_subaccount.enabled = enabled;
    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);
    res.json({ success: true, enabled });
  } catch (err) { next(err); }
});

module.exports = router;
