'use strict';

const express        = require('express');
const logger         = require('../config/logger');
const { FEES }       = require('../config/constants');
const profileService = require('../services/profileService');
const djService      = require('../services/djService');

const router = express.Router();

// POST /api/set-royalty-splits
router.post('/set-royalty-splits', async (req, res, next) => {
  try {
    const { wallet, cid, splits } = req.body || {};
    if (!wallet || !cid || !splits) return res.status(400).json({ error: 'Missing fields' });

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (!['creator', 'platform_nft_creator'].includes(profile.account_type)) {
      return res.status(403).json({ error: 'Only creators can set royalty splits' });
    }

    const passiveTotal = (splits.passive || []).reduce((sum, p) => sum + (p.percent || 0), 0);
    const total = (splits.artist || 0) + (splits.nft_holders || 0) +
                  (splits.activity_pool || 0) + passiveTotal;

    if (Math.abs(total - 100) > 0.01) {
      return res.status(400).json({ error: `Splits must sum to 100%. Got: ${total}%` });
    }

    for (const recipient of (splits.passive || [])) {
      const recipientProfile = profiles[recipient.wallet];
      if (!recipientProfile) continue;
      const level       = profileService.getCapabilityLevel(recipientProfile);
      const isTier3     = level === 'listener_3';
      const isSupporter = recipientProfile.supporter_subaccount?.enabled;
      if (!isTier3 && !isSupporter) {
        return res.status(400).json({
          error: `Passive split recipient ${recipient.wallet} must be a Tier 3 listener or active supporter.`,
        });
      }
    }

    if (!profile.royalty_splits) profile.royalty_splits = {};
    profile.royalty_splits[cid] = splits;
    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);

    res.json({ success: true, splits });
  } catch (err) { next(err); }
});

// POST /api/royalty-splits  (asset-manager.html uses this endpoint)
router.post('/royalty-splits', async (req, res, next) => {
  try {
    const { wallet, cid, splits } = req.body || {};
    if (!wallet || !cid || !splits) return res.status(400).json({ error: 'Missing fields' });

    const total = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(total - 100) > 0.01) {
      return res.status(400).json({ error: `Splits must sum to 100%. Got: ${total.toFixed(1)}%` });
    }

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (!profile.royalty_splits) profile.royalty_splits = {};
    profile.royalty_splits[cid] = splits;
    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);

    logger.info({ wallet, cid }, 'Royalty splits saved');
    res.json({ success: true, splits });
  } catch (err) { next(err); }
});

// POST /api/tip
router.post('/tip', async (req, res, next) => {
  try {
    const { from_wallet, to_wallet, tip_type, amount_eth, dj_set_id, artist_splits, dj_percent } = req.body || {};

    if (!from_wallet || !tip_type || !amount_eth) {
      return res.status(400).json({ error: 'Missing from_wallet, tip_type, or amount_eth' });
    }

    const grossEth    = parseFloat(amount_eth);
    const platformCut = grossEth * FEES.PLATFORM_TIP;
    const remaining   = grossEth - platformCut;
    const distribution = [];

    if (tip_type === 'artist') {
      if (!to_wallet) return res.status(400).json({ error: 'Missing to_wallet for artist tip' });
      distribution.push({ wallet: to_wallet, amount_eth: remaining, role: 'artist' });

    } else if (tip_type === 'dj') {
      if (!dj_set_id) return res.status(400).json({ error: 'Missing dj_set_id for DJ tip' });

      const djSets = await djService.loadDjSets();
      const set    = djSets[dj_set_id];
      if (set?.tips_enabled === false) {
        return res.status(403).json({ error: 'This DJ set has tips disabled.' });
      }

      const djCut         = remaining * ((dj_percent || 100) / 100);
      const artistPoolCut = remaining - djCut;
      distribution.push({ wallet: to_wallet || set?.dj_wallet, amount_eth: djCut, role: 'dj' });

      if (artistPoolCut > 0 && artist_splits?.length) {
        const totalArtistPct = artist_splits.reduce((s, a) => s + (a.percent || 0), 0);
        for (const a of artist_splits) {
          distribution.push({
            wallet:     a.wallet,
            amount_eth: artistPoolCut * ((a.percent || 0) / totalArtistPct),
            role:       'artist_from_dj_tip',
          });
        }
      }
    } else {
      return res.status(400).json({ error: 'tip_type must be artist or dj' });
    }

    const profiles   = await profileService.loadProfiles();
    const tipper     = profiles[from_wallet];
    const recognized = tipper && tipper.account_type !== null && profileService.isSubscriptionActive(tipper);

    logger.info({ tip_type, from_wallet, gross_eth: grossEth, platform_cut_eth: platformCut, distribution }, 'Tip processed');

    res.json({
      success:      true,
      gross_eth:    grossEth,
      platform_cut: platformCut,
      distribution,
      recognized,
      message: recognized ? 'Tip sent — you will be credited as a supporter.' : 'Tip sent anonymously.',
    });
  } catch (err) { next(err); }
});

// POST /api/nft-sale-fee
router.post('/nft-sale-fee', async (req, res, next) => {
  try {
    const { sale_price_eth, nft_type, seller_wallet, is_primary } = req.body || {};
    if (!sale_price_eth || !nft_type || !seller_wallet) {
      return res.status(400).json({ error: 'Missing sale_price_eth, nft_type, or seller_wallet' });
    }

    const priceEth = parseFloat(sale_price_eth);

    if (nft_type === 'platform' && is_primary === true) {
      return res.json({ success: true, platform_fee: 0, seller_gets: priceEth, note: 'Platform NFT primary sale — no platform fee.' });
    }

    if (nft_type === 'platform') {
      const floorEth = parseFloat(profileService.usdToEth(FEES.PLATFORM_NFT_PRICE_USD));
      if (priceEth < floorEth) {
        return res.status(400).json({
          error:     `Platform NFT cannot be sold below $${FEES.PLATFORM_NFT_PRICE_USD} USD (${floorEth} ETH).`,
          floor_eth: floorEth,
        });
      }
    }

    const platformFee = priceEth * FEES.PLATFORM_NFT_SALE;
    const sellerGets  = priceEth - platformFee;

    logger.info({ nft_type, seller_wallet, sale_price_eth, platform_fee: platformFee }, 'NFT sale fee calculated');
    res.json({
      success:          true,
      sale_price_eth:   priceEth,
      platform_fee_pct: FEES.PLATFORM_NFT_SALE * 100,
      platform_fee_eth: platformFee,
      seller_gets_eth:  sellerGets,
    });
  } catch (err) { next(err); }
});

module.exports = router;
