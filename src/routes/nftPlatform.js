'use strict';

const express        = require('express');
const logger         = require('../config/logger');
const { FEES }       = require('../config/constants');
const profileService = require('../services/profileService');
const { hasPlatformNft, ADDRESSES } = require('../services/ethService');

const router = express.Router();

// POST /api/claim-platform-nft
router.post('/claim-platform-nft', async (req, res, next) => {
  try {
    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    const holdsNft = await hasPlatformNft(wallet);
    if (!holdsNft) {
      return res.status(403).json({ error: 'Platform NFT not detected in this wallet. Purchase it first.' });
    }

    const profiles   = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    const profile    = profiles[wallet];
    const wasCreator = profile.account_type === 'creator';

    profile.account_type          = 'platform_nft_creator';
    profile.platform_nft_address  = ADDRESSES.platformNft;
    profile.royalty_fee_rate      = FEES.PLATFORM_ROYALTY_NFT;

    if (!profile.supporter_subaccount) {
      profile.supporter_subaccount = {
        enabled:                false,
        linked_creator_wallet:  wallet,
        royalty_beneficiary_of: [],
      };
    }

    profiles[wallet] = profile;
    await profileService.saveProfiles(profiles);

    if (wasCreator && profileService.isSubscriptionActive(profile)) {
      logger.info({ wallet }, 'Creator upgraded to Platform NFT — subscription continues at NFT rate');
    }

    res.json({
      success:          true,
      account_type:     profile.account_type,
      royalty_fee_rate: profile.royalty_fee_rate,
      message:          'Platform NFT claimed. You now have creator capabilities with a 1.5% royalty fee.',
    });
  } catch (err) { next(err); }
});

// POST /api/check-platform-nft
router.post('/check-platform-nft', async (req, res, next) => {
  try {
    const { wallet } = req.body || {};
    if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

    const profiles = await profileService.loadProfiles();
    const profile  = profiles[wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const holdsNft = await hasPlatformNft(wallet);

    if (holdsNft && profile.account_type !== 'platform_nft_creator') {
      profile.account_type          = 'platform_nft_creator';
      profile.royalty_fee_rate      = FEES.PLATFORM_ROYALTY_NFT;
      profile.platform_nft_address  = ADDRESSES.platformNft;
      profiles[wallet] = profile;
      await profileService.saveProfiles(profiles);
    } else if (!holdsNft && profile.account_type === 'platform_nft_creator') {
      profile.account_type          = 'creator';
      profile.royalty_fee_rate      = FEES.PLATFORM_ROYALTY_STANDARD;
      profile.platform_nft_address  = null;
      profiles[wallet] = profile;
      await profileService.saveProfiles(profiles);
    }

    res.json({
      holds_nft:        holdsNft,
      account_type:     profile.account_type,
      royalty_fee_rate: profile.royalty_fee_rate,
    });
  } catch (err) { next(err); }
});

module.exports = router;
