'use strict';

const path = require('path');
const fs   = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { FEES } = require('../config/constants');

const PROFILES_PATH = path.resolve(process.cwd(), 'profiles.json');
fs.ensureFileSync(PROFILES_PATH);

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadProfiles() {
  try {
    const raw = JSON.parse(await fs.readFile(PROFILES_PATH, 'utf8'));
    // Normalize all keys to lowercase so mixed-case checksummed addresses always match
    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  } catch {
    return {};
  }
}

async function saveProfiles(profiles) {
  await fs.writeFile(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

// ── Profile factory ───────────────────────────────────────────────────────────

function createProfile(wallet, name, accountType) {
  return {
    user_id:              uuidv4(),
    name,
    wallet_address:       wallet,
    account_type:         accountType,
    listener_tier:        accountType === 'listener' ? 1 : null,
    listener_plan:        null,
    subscription_start:   null,
    subscription_expiry:  null,
    platform_nft_address: null,
    royalty_fee_rate:     accountType === 'creator' ? FEES.PLATFORM_ROYALTY_STANDARD : null,
    nft_contract_address: null,
    playlist_cids:        [],
    favorites:            [],
    dj_settings: { tips_enabled_default: true },
    supporter_subaccount: {
      enabled:                false,
      linked_creator_wallet:  wallet,
      royalty_beneficiary_of: [],
    },
  };
}

// ── Capability helpers ────────────────────────────────────────────────────────

function isSubscriptionActive(profile) {
  if (!profile) return false;
  return !!(profile.subscription_expiry && Date.now() < profile.subscription_expiry);
}

function getListenerTier(profile) {
  if (!profile || profile.account_type !== 'listener') return 0;
  if (!isSubscriptionActive(profile)) return 0;
  return profile.listener_tier || 0;
}

function getCapabilityLevel(profile) {
  if (!profile) return 'none';
  const { account_type: type } = profile;
  const active = isSubscriptionActive(profile);

  if (type === 'platform_nft_creator') return active ? 'nft_creator_active' : 'nft_creator_passive';
  if (type === 'creator')              return active ? 'creator_active'      : 'creator_inactive';
  if (type === 'listener') {
    const tier = active ? (profile.listener_tier || 1) : 0;
    return tier > 0 ? `listener_${tier}` : 'none';
  }
  if (type === 'admin') return 'admin';
  return 'none';
}

// ── Currency helper ───────────────────────────────────────────────────────────

function usdToEth(usdAmount) {
  const rate = parseFloat(process.env.ETH_USD_RATE || '2500');
  return (usdAmount / rate).toFixed(8);
}

module.exports = {
  loadProfiles,
  saveProfiles,
  createProfile,
  isSubscriptionActive,
  getListenerTier,
  getCapabilityLevel,
  usdToEth,
};
