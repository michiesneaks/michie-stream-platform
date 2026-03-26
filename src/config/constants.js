'use strict';

// ── Platform fee rates ────────────────────────────────────────────────────────
const FEES = {
  PLATFORM_ROYALTY_STANDARD:  0.05,    // 5%   — standard creator royalty fee
  PLATFORM_ROYALTY_NFT:       0.015,   // 1.5% — Platform NFT holder royalty fee
  PLATFORM_TIP:               0.03,    // 3%   — platform cut of all tips
  PLATFORM_NFT_SALE:          0.025,   // 2.5% — platform cut of all NFT sales
  PLATFORM_NFT_PRICE_USD:     10000,   // $10,000 USD — Platform NFT price floor
};

// ── Subscription plan definitions ────────────────────────────────────────────
const SUBSCRIPTION_PLANS = {
  listener_tier1_monthly: { price_usd: 10.99,   days: 30,  type: 'listener',     tier: 1 },
  listener_tier1_annual:  { price_usd: 131.88,  days: 365, type: 'listener',     tier: 1 },
  listener_tier1_rolling: { price_usd: 10.99,   days: 3,   type: 'listener',     tier: 1 },
  listener_tier2_monthly: { price_usd: 19.99,   days: 30,  type: 'listener',     tier: 2 },
  listener_tier2_annual:  { price_usd: 239.88,  days: 365, type: 'listener',     tier: 2 },
  listener_tier2_rolling: { price_usd: 19.99,   days: 3,   type: 'listener',     tier: 2 },
  listener_tier3_monthly: { price_usd: 34.99,   days: 30,  type: 'listener',     tier: 3 },
  listener_tier3_annual:  { price_usd: 419.88,  days: 365, type: 'listener',     tier: 3 },
  listener_tier3_rolling: { price_usd: 34.99,   days: 3,   type: 'listener',     tier: 3 },
  creator_monthly:        { price_usd: 29.99,   days: 30,  type: 'creator',      tier: null },
  creator_annual:         { price_usd: 299.88,  days: 365, type: 'creator',      tier: null },
  nft_creator_monthly:    { price_usd: 14.99,   days: 30,  type: 'nft_creator',  tier: null },
  nft_creator_annual:     { price_usd: 179.88,  days: 365, type: 'nft_creator',  tier: null },
};

// ── Stream duration caps (milliseconds) ──────────────────────────────────────
const STREAM_DURATION_LIMITS = {
  creator:               3 * 60 * 60 * 1000,  // 3 hours
  platform_nft_creator:  Infinity,             // unlimited
};

// ── Valid content types ───────────────────────────────────────────────────────
const VALID_CONTENT_TYPES = ['music', 'podcast', 'video', 'art_still', 'art_animated'];

// ── Capability levels that can DJ ────────────────────────────────────────────
const DJ_CAPABLE_LEVELS = new Set([
  'listener_2', 'listener_3', 'creator_active', 'nft_creator_active',
]);

// ── Capability levels that can create playlists ───────────────────────────────
const PLAYLIST_CAPABLE_LEVELS = new Set([
  'listener_2', 'listener_3', 'creator_active', 'nft_creator_active',
]);

module.exports = {
  FEES,
  SUBSCRIPTION_PLANS,
  STREAM_DURATION_LIMITS,
  VALID_CONTENT_TYPES,
  DJ_CAPABLE_LEVELS,
  PLAYLIST_CAPABLE_LEVELS,
};
