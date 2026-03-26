'use strict';

const express        = require('express');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { FEES }       = require('../config/constants');
const profileService = require('../services/profileService');
const { hasPlatformNft } = require('../services/ethService');

const router = express.Router();

// GET /api/profile/:wallet
router.get('/:wallet', async (req, res, next) => {
  try {
    const profiles = await profileService.loadProfiles();
    const profile  = profiles[req.params.wallet];
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Auto-downgrade if Platform NFT was sold
    if (profile.account_type === 'platform_nft_creator') {
      const stillHolds = await hasPlatformNft(req.params.wallet);
      if (!stillHolds) {
        profile.account_type      = 'creator';
        profile.royalty_fee_rate  = FEES.PLATFORM_ROYALTY_STANDARD;
        profile.platform_nft_address = null;
        profiles[req.params.wallet] = profile;
        await profileService.saveProfiles(profiles);
        logger.info({ wallet: req.params.wallet }, 'Platform NFT no longer held — downgraded to creator');
      }
    }

    res.json(profile);
  } catch (err) { next(err); }
});

// POST /api/create-profile
router.post('/create-profile', async (req, res, next) => {
  try {
    const { wallet: rawWallet, name, account_type = 'listener' } = req.body || {};
    if (!rawWallet || !name) return res.status(400).json({ error: 'Missing wallet or name' });
    if (!['listener', 'creator'].includes(account_type)) {
      return res.status(400).json({ error: 'account_type must be listener or creator' });
    }

    const wallet   = rawWallet.toLowerCase();
    const profiles = await profileService.loadProfiles();
    if (profiles[wallet]) return res.status(409).json({ error: 'Profile already exists' });

    profiles[wallet] = profileService.createProfile(wallet, name, account_type);
    await profileService.saveProfiles(profiles);
    res.json(profiles[wallet]);
  } catch (err) { next(err); }
});

// POST /api/update-profile
router.post('/update-profile', async (req, res, next) => {
  try {
    const { wallet, nftContractAddress, playlistCid, djTipsDefault, name } = req.body || {};
    const profiles = await profileService.loadProfiles();
    if (!profiles[wallet]) return res.status(404).json({ error: 'Profile not found' });

    if (nftContractAddress) profiles[wallet].nft_contract_address = nftContractAddress;
    if (playlistCid) profiles[wallet].playlist_cids = (profiles[wallet].playlist_cids || []).concat(playlistCid);
    if (typeof djTipsDefault === 'boolean') profiles[wallet].dj_settings.tips_enabled_default = djTipsDefault;
    if (name) profiles[wallet].name = name;

    await profileService.saveProfiles(profiles);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
