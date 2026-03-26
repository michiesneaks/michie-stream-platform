'use strict';

const express        = require('express');
const { FEES, SUBSCRIPTION_PLANS } = require('../config/constants');
const profileService = require('../services/profileService');

const router = express.Router();

// GET /api/fees
router.get('/fees', (req, res) => {
  res.json({
    royalty_standard_pct:   FEES.PLATFORM_ROYALTY_STANDARD * 100,
    royalty_nft_pct:        FEES.PLATFORM_ROYALTY_NFT * 100,
    tip_pct:                FEES.PLATFORM_TIP * 100,
    nft_sale_pct:           FEES.PLATFORM_NFT_SALE * 100,
    platform_nft_price_usd: FEES.PLATFORM_NFT_PRICE_USD,
    subscription_plans:     SUBSCRIPTION_PLANS,
  });
});

// POST /api/convert-currency
router.post('/convert-currency', (req, res) => {
  const { amountEth, to } = req.body || {};
  const rate     = parseFloat(process.env.ETH_USD_RATE || '2500');
  const ethFloat = parseFloat(amountEth || '0');
  const rates    = { usd: rate, btc: rate / 65000, sol: rate / 150, zec: rate / 20 };
  const amount   = ethFloat * (rates[(to || '').toLowerCase()] || 1);
  res.json({ [`amount${(to || '').toUpperCase()}`]: amount });
});

// GET /api/nfts
router.get('/nfts', async (req, res, next) => {
  try {
    const profiles = await profileService.loadProfiles();
    const nfts = [];
    for (const [wallet, profile] of Object.entries(profiles)) {
      if (!profile.nft_contract_address) continue;
      for (const cid of (profile.playlist_cids || [])) {
        nfts.push({
          metadataCid:     cid,
          contractAddress: profile.nft_contract_address,
          artistWallet:    wallet,
          artist:          profile.name || 'Unknown',
          title:           `Track ${cid.slice(0, 8)}`,
          cover_image:     null,
          price_eth:       null,
          tokenId:         null,
        });
      }
    }
    res.json(nfts);
  } catch (err) { next(err); }
});

module.exports = router;
