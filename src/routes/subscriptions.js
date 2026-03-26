'use strict';

const express        = require('express');
const logger         = require('../config/logger');
const { SUBSCRIPTION_PLANS } = require('../config/constants');
const profileService = require('../services/profileService');

const router = express.Router();

// POST /api/subscribe
router.post('/', async (req, res, next) => {
  try {
    const { wallet, plan } = req.body || {};
    if (!wallet || !plan) return res.status(400).json({ error: 'Missing wallet or plan' });

    const planDef = SUBSCRIPTION_PLANS[plan];
    if (!planDef) {
      return res.status(400).json({
        error: `Unknown plan. Valid plans: ${Object.keys(SUBSCRIPTION_PLANS).join(', ')}`,
      });
    }

    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    const profile = profiles[wallet];

    if (planDef.type === 'listener' && profile.account_type !== 'listener') {
      return res.status(400).json({ error: 'Listener plans are only for listener accounts' });
    }
    if (planDef.type === 'creator' && profile.account_type !== 'creator') {
      return res.status(400).json({ error: 'Creator plans are only for creator accounts' });
    }
    if (planDef.type === 'nft_creator' && profile.account_type !== 'platform_nft_creator') {
      return res.status(400).json({ error: 'NFT creator plans require a Platform NFT' });
    }

    const now      = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const baseTime = (plan.endsWith('_rolling') || !profileService.isSubscriptionActive(profile))
      ? now
      : profile.subscription_expiry;

    profile.listener_plan       = plan.endsWith('_annual')  ? 'annual'
                                 : plan.endsWith('_rolling') ? 'rolling' : 'monthly';
    profile.subscription_start  = now;
    profile.subscription_expiry = baseTime + planDef.days * msPerDay;
    if (planDef.tier) profile.listener_tier = planDef.tier;
    profile.last_subscription_price_eth = profileService.usdToEth(planDef.price_usd);

    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);

    logger.info({ wallet, plan }, 'Subscription activated');
    res.json({
      success:   true,
      plan,
      tier:      profile.listener_tier,
      expiry:    profile.subscription_expiry,
      price_usd: planDef.price_usd,
      price_eth: profile.last_subscription_price_eth,
    });
  } catch (err) { next(err); }
});

module.exports = router;
