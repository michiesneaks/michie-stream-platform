'use strict';

const fs = require('fs-extra');
const path = require('path');
const profileService = require('./profileService');
const catalogService = require('./catalogService');

const DEFAULT_SHARE_PERCENT = 8;
const PLAYABLE_TYPES = new Set([
  'music',
  'video',
  'podcast',
  'nft_music',
  'nft_video',
  'art_animated',
]);

function normalizeWallet(wallet) {
  return String(wallet || '').trim().toLowerCase();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyAnalytics() {
  return {
    totals: {
      collectedEth: 0,
      totalPlays: 0,
      eligiblePlays: 0,
      ineligiblePlays: 0,
      lastPlayAt: null,
    },
    perAsset: {},
  };
}

function normalizeSharePercent(raw) {
  const share = safeNumber(raw, DEFAULT_SHARE_PERCENT);
  return Math.max(0, Math.min(100, share));
}

function syncLegacyCidArray(playlist) {
  playlist.cids = (playlist.items || []).map((item) => item.contentId).filter(Boolean);
  return playlist;
}

function isPlayableCatalogEntry(entry) {
  if (!entry) return false;
  if (entry.isPrivate) return false;
  if (PLAYABLE_TYPES.has(entry.contentType)) return true;
  return !!(entry.hlsUrl || entry.previewUrl || entry.audioUrl || entry.videoUrl || entry.streamUrl);
}

async function loadCatalogMap() {
  try {
    return await catalogService.loadCatalog();
  } catch (_) {
    return {};
  }
}

async function readLocalMetadata(contentId) {
  if (!contentId) return null;
  const metaPath = path.join(process.cwd(), 'public', 'catalog', contentId, 'metadata.json');
  try {
    return await fs.readJson(metaPath);
  } catch (_) {
    return null;
  }
}

function findCatalogEntry(catalogMap, contentId) {
  if (!contentId || !catalogMap) return null;
  if (catalogMap[contentId]) return catalogMap[contentId];
  return Object.values(catalogMap).find((entry) => {
    return entry && (
      entry.contentId === contentId ||
      entry.cid === contentId ||
      entry.ipfsCid === contentId ||
      entry.ipfs_audio_url === contentId
    );
  }) || null;
}

async function buildPlaylistItemFromContentId(contentId, catalogMap, overrides = {}) {
  const entry = findCatalogEntry(catalogMap, contentId);
  if (!entry) return null;

  const metadata = await readLocalMetadata(entry.contentId || contentId);
  const creatorWallet = normalizeWallet(
    entry.wallet ||
    metadata?.creator?.wallet_address ||
    metadata?.creator?.wallet ||
    overrides.wallet
  );

  return {
    contentId: entry.contentId || contentId,
    cid: entry.cid || entry.contentId || contentId,
    title: entry.title || metadata?.title || 'Untitled asset',
    artistName: entry.artistName || metadata?.creator?.name || metadata?.artistName || 'Unknown creator',
    wallet: creatorWallet,
    contentType: entry.contentType || metadata?.content_type || 'music',
    coverUrl: entry.coverUrl || metadata?.cover_image || metadata?.coverUrl || '',
    previewUrl: entry.previewUrl || metadata?.preview_url || metadata?.previewUrl || '',
    hlsUrl: entry.hlsUrl || metadata?.hls_master_url || metadata?.stream_url || '',
    supporterRoyaltyEnabled: !!entry.supporterRoyaltyEnabled,
    royaltyFeeRate: safeNumber(
      entry.royalty_fee_rate ?? metadata?.royalty_fee_rate ?? overrides.royaltyFeeRate,
      0
    ),
    isPrivate: !!entry.isPrivate,
    addedAt: overrides.addedAt || Date.now(),
    addedFrom: overrides.addedFrom || 'manual',
    sortOrder: safeNumber(overrides.sortOrder, 0),
  };
}

async function refreshItemFromCatalog(item, index, playlist, catalogMap) {
  const contentId = item?.contentId || item?.cid;
  const hydrated = contentId
    ? await buildPlaylistItemFromContentId(contentId, catalogMap, {
        addedAt: item?.addedAt || playlist.createdAt || Date.now(),
        addedFrom: item?.addedFrom || 'manual',
        sortOrder: item?.sortOrder ?? index,
        royaltyFeeRate: item?.royaltyFeeRate,
        wallet: item?.wallet,
      })
    : null;

  return {
    ...(item || {}),
    ...(hydrated || {}),
    contentId: hydrated?.contentId || contentId,
    cid: hydrated?.cid || contentId,
    title: hydrated?.title || item?.title || 'Untitled asset',
    artistName: hydrated?.artistName || item?.artistName || 'Unknown creator',
    wallet: normalizeWallet(hydrated?.wallet || item?.wallet),
    contentType: hydrated?.contentType || item?.contentType || 'music',
    coverUrl: hydrated?.coverUrl || item?.coverUrl || '',
    previewUrl: hydrated?.previewUrl || item?.previewUrl || '',
    hlsUrl: hydrated?.hlsUrl || item?.hlsUrl || '',
    supporterRoyaltyEnabled: hydrated ? !!hydrated.supporterRoyaltyEnabled : !!item?.supporterRoyaltyEnabled,
    royaltyFeeRate: hydrated ? safeNumber(hydrated.royaltyFeeRate, 0) : safeNumber(item?.royaltyFeeRate, 0),
    isPrivate: hydrated ? !!hydrated.isPrivate : !!item?.isPrivate,
    addedAt: item?.addedAt || hydrated?.addedAt || playlist.createdAt || Date.now(),
    addedFrom: item?.addedFrom || hydrated?.addedFrom || 'manual',
    sortOrder: index,
  };
}

async function hydrateLegacyItems(playlist, catalogMap) {
  const existingItems = Array.isArray(playlist.items) ? playlist.items.filter(Boolean) : [];
  if (existingItems.length) {
    const refreshed = [];
    for (let index = 0; index < existingItems.length; index += 1) {
      refreshed.push(await refreshItemFromCatalog(existingItems[index], index, playlist, catalogMap));
    }
    playlist.items = refreshed;
    return syncLegacyCidArray(playlist);
  }

  const legacyCids = Array.isArray(playlist.cids) ? playlist.cids.filter(Boolean) : [];
  if (!legacyCids.length) {
    playlist.items = [];
    return syncLegacyCidArray(playlist);
  }

  const items = [];
  for (let i = 0; i < legacyCids.length; i += 1) {
    const item = await buildPlaylistItemFromContentId(legacyCids[i], catalogMap, {
      addedAt: playlist.createdAt || Date.now(),
      addedFrom: playlist.fromFavorites ? 'favorites' : 'legacy',
      sortOrder: i,
    });
    if (item) items.push(item);
  }

  playlist.items = items;
  return syncLegacyCidArray(playlist);
}

async function ensurePlaylistShape(playlist, catalogMap) {
  if (!playlist || typeof playlist !== 'object') return null;

  playlist.wallet = normalizeWallet(playlist.wallet || playlist.curator || playlist.ownerWallet);
  playlist.name = String(playlist.name || 'Untitled Playlist').trim();
  playlist.description = String(playlist.description || '').trim();
  playlist.createdAt = playlist.createdAt || Date.now();
  playlist.updatedAt = playlist.updatedAt || playlist.createdAt;
  playlist.isPublic = playlist.isPublic !== false && playlist.isPrivate !== true;
  playlist.isPrivate = !playlist.isPublic;
  playlist.royaltyEligible = playlist.isPublic;
  playlist.sharePercent = normalizeSharePercent(playlist.sharePercent);
  playlist.analytics = playlist.analytics && typeof playlist.analytics === 'object'
    ? {
        totals: {
          collectedEth: safeNumber(playlist.analytics?.totals?.collectedEth, 0),
          totalPlays: safeNumber(playlist.analytics?.totals?.totalPlays, 0),
          eligiblePlays: safeNumber(playlist.analytics?.totals?.eligiblePlays, 0),
          ineligiblePlays: safeNumber(playlist.analytics?.totals?.ineligiblePlays, 0),
          lastPlayAt: playlist.analytics?.totals?.lastPlayAt || null,
        },
        perAsset: playlist.analytics?.perAsset || {},
      }
    : emptyAnalytics();

  await hydrateLegacyItems(playlist, catalogMap);
  return syncLegacyCidArray(playlist);
}

function buildAnalyticsView(playlist) {
  const analytics = playlist.analytics || emptyAnalytics();
  const analyticsRows = analytics.perAsset || {};
  const assets = [];
  const seen = new Set();

  for (const item of (playlist.items || [])) {
    const key = item.contentId || item.cid;
    const row = analyticsRows[key] || {};
    assets.push({
      contentId: key,
      title: item.title || row.title || 'Untitled asset',
      artistName: item.artistName || row.artistName || '',
      contentType: item.contentType || row.contentType || 'music',
      coverUrl: item.coverUrl || row.coverUrl || '',
      plays: safeNumber(row.plays, 0),
      eligiblePlays: safeNumber(row.eligiblePlays, 0),
      ineligiblePlays: safeNumber(row.ineligiblePlays, 0),
      revenueEth: safeNumber(row.revenueEth, 0),
      lastPlayedAt: row.lastPlayedAt || null,
      supporterRoyaltyEnabled: !!item.supporterRoyaltyEnabled,
      isPrivate: !!item.isPrivate,
      currentlyEarning: !!playlist.isPublic && !!item.supporterRoyaltyEnabled && !item.isPrivate,
    });
    seen.add(key);
  }

  for (const row of Object.values(analyticsRows)) {
    if (seen.has(row.contentId)) continue;
    assets.push({
      contentId: row.contentId,
      title: row.title || 'Untitled asset',
      artistName: row.artistName || '',
      contentType: row.contentType || 'music',
      coverUrl: row.coverUrl || '',
      plays: safeNumber(row.plays, 0),
      eligiblePlays: safeNumber(row.eligiblePlays, 0),
      ineligiblePlays: safeNumber(row.ineligiblePlays, 0),
      revenueEth: safeNumber(row.revenueEth, 0),
      lastPlayedAt: row.lastPlayedAt || null,
      supporterRoyaltyEnabled: false,
      isPrivate: false,
      currentlyEarning: false,
    });
  }

  assets.sort((a, b) => {
    if (b.revenueEth !== a.revenueEth) return b.revenueEth - a.revenueEth;
    return b.plays - a.plays;
  });

  return {
    totals: {
      collectedEth: safeNumber(analytics.totals?.collectedEth, 0),
      totalPlays: safeNumber(analytics.totals?.totalPlays, 0),
      eligiblePlays: safeNumber(analytics.totals?.eligiblePlays, 0),
      ineligiblePlays: safeNumber(analytics.totals?.ineligiblePlays, 0),
      lastPlayAt: analytics.totals?.lastPlayAt || null,
    },
    topAssets: assets.slice(0, 5),
    assets,
  };
}

function withAnalyticsView(playlist) {
  return {
    ...playlist,
    items: (playlist.items || []).slice().sort((a, b) => safeNumber(a.sortOrder, 0) - safeNumber(b.sortOrder, 0)),
    analyticsView: buildAnalyticsView(playlist),
  };
}

async function getPlaylistContext(playlistId) {
  const profiles = await profileService.loadProfiles();
  const catalogMap = await loadCatalogMap();

  for (const [wallet, profile] of Object.entries(profiles)) {
    const playlists = Array.isArray(profile.playlists) ? profile.playlists : [];
    for (let i = 0; i < playlists.length; i += 1) {
      const playlist = playlists[i];
      if (playlist && playlist.id === playlistId) {
        await ensurePlaylistShape(playlist, catalogMap);
        profile.playlists = playlists;
        profiles[wallet] = profile;
        return {
          profiles,
          profile,
          ownerWallet: normalizeWallet(wallet),
          playlist,
          playlistIndex: i,
          catalogMap,
        };
      }
    }
  }

  return null;
}

async function persistContext(ctx) {
  ctx.profile.playlists[ctx.playlistIndex] = syncLegacyCidArray(ctx.playlist);
  ctx.profiles[ctx.ownerWallet] = ctx.profile;
  await profileService.saveProfiles(ctx.profiles);
  return withAnalyticsView(ctx.playlist);
}

async function listPlaylistsForWallet(wallet, { includePrivate = true } = {}) {
  const normalizedWallet = normalizeWallet(wallet);
  const profiles = await profileService.loadProfiles();
  const profile = profiles[normalizedWallet];
  if (!profile) return [];

  const catalogMap = await loadCatalogMap();
  profile.playlists = Array.isArray(profile.playlists) ? profile.playlists : [];

  for (let i = 0; i < profile.playlists.length; i += 1) {
    await ensurePlaylistShape(profile.playlists[i], catalogMap);
  }

  profiles[normalizedWallet] = profile;
  await profileService.saveProfiles(profiles);

  const playlists = profile.playlists
    .filter((playlist) => includePrivate || playlist.isPublic)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(withAnalyticsView);

  return playlists;
}

async function listPublicPlaylists() {
  const profiles = await profileService.loadProfiles();
  const catalogMap = await loadCatalogMap();
  const playlists = [];

  for (const [wallet, profile] of Object.entries(profiles)) {
    const rows = Array.isArray(profile.playlists) ? profile.playlists : [];
    for (const playlist of rows) {
      await ensurePlaylistShape(playlist, catalogMap);
      if (playlist.isPublic) playlists.push(withAnalyticsView(playlist));
    }
  }

  return playlists.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function createPlaylist({ wallet, name, description = '', isPublic = true, sharePercent = DEFAULT_SHARE_PERCENT, contentIds = [], addedFrom = 'manual' }) {
  const normalizedWallet = normalizeWallet(wallet);
  const profiles = await profileService.loadProfiles();
  const profile = profiles[normalizedWallet];
  if (!profile) {
    const err = new Error('Profile not found');
    err.statusCode = 404;
    throw err;
  }

  const catalogMap = await loadCatalogMap();
  const playlist = {
    id: require('uuid').v4(),
    wallet: normalizedWallet,
    name: String(name || '').trim() || 'Untitled Playlist',
    description: String(description || '').trim(),
    isPublic: !!isPublic,
    isPrivate: !isPublic,
    royaltyEligible: !!isPublic,
    sharePercent: normalizeSharePercent(sharePercent),
    fromFavorites: addedFrom === 'favorites',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: [],
    analytics: emptyAnalytics(),
  };

  const uniqueIds = Array.from(new Set((contentIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const item = await buildPlaylistItemFromContentId(uniqueIds[i], catalogMap, {
      addedAt: Date.now(),
      addedFrom,
      sortOrder: i,
    });
    if (!item) continue;
    playlist.items.push(item);
  }

  syncLegacyCidArray(playlist);

  profile.playlists = Array.isArray(profile.playlists) ? profile.playlists : [];
  profile.playlists.push(playlist);
  profiles[normalizedWallet] = profile;
  await profileService.saveProfiles(profiles);

  return withAnalyticsView(playlist);
}

async function patchPlaylist({ wallet, playlistId, updates = {} }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }
  if (normalizeWallet(wallet) !== ctx.ownerWallet) {
    const err = new Error('Not your playlist');
    err.statusCode = 403;
    throw err;
  }

  if (typeof updates.name === 'string') ctx.playlist.name = updates.name.trim() || ctx.playlist.name;
  if (typeof updates.description === 'string') ctx.playlist.description = updates.description.trim();
  if (typeof updates.isPublic === 'boolean') {
    ctx.playlist.isPublic = updates.isPublic;
    ctx.playlist.isPrivate = !updates.isPublic;
    ctx.playlist.royaltyEligible = !!updates.isPublic;
  }
  if (updates.sharePercent != null) {
    ctx.playlist.sharePercent = normalizeSharePercent(updates.sharePercent);
  }
  ctx.playlist.updatedAt = Date.now();

  return persistContext(ctx);
}

async function deletePlaylist({ wallet, playlistId }) {
  const normalizedWallet = normalizeWallet(wallet);
  const profiles = await profileService.loadProfiles();
  const profile = profiles[normalizedWallet];
  if (!profile) {
    const err = new Error('Profile not found');
    err.statusCode = 404;
    throw err;
  }

  profile.playlists = Array.isArray(profile.playlists) ? profile.playlists : [];
  const before = profile.playlists.length;
  profile.playlists = profile.playlists.filter((playlist) => playlist && playlist.id !== playlistId);
  if (profile.playlists.length === before) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }

  profiles[normalizedWallet] = profile;
  await profileService.saveProfiles(profiles);
}

async function addItemToPlaylist({ wallet, playlistId, contentId }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }
  if (normalizeWallet(wallet) !== ctx.ownerWallet) {
    const err = new Error('Not your playlist');
    err.statusCode = 403;
    throw err;
  }

  const existing = (ctx.playlist.items || []).find((item) => item.contentId === contentId);
  if (existing) return withAnalyticsView(ctx.playlist);

  const entry = findCatalogEntry(ctx.catalogMap, contentId);
  if (!entry) {
    const err = new Error('Asset not found');
    err.statusCode = 404;
    throw err;
  }
  if (!isPlayableCatalogEntry(entry)) {
    const err = new Error('Only playable public assets can be added to playlists');
    err.statusCode = 400;
    throw err;
  }
  if (normalizeWallet(entry.wallet) === ctx.ownerWallet) {
    const err = new Error('You cannot add your own asset to your own royalty playlist');
    err.statusCode = 400;
    throw err;
  }

  const item = await buildPlaylistItemFromContentId(contentId, ctx.catalogMap, {
    addedAt: Date.now(),
    addedFrom: 'manual',
    sortOrder: (ctx.playlist.items || []).length,
  });
  if (!item) {
    const err = new Error('Asset metadata unavailable');
    err.statusCode = 400;
    throw err;
  }

  ctx.playlist.items = Array.isArray(ctx.playlist.items) ? ctx.playlist.items : [];
  ctx.playlist.items.push(item);
  ctx.playlist.updatedAt = Date.now();
  return persistContext(ctx);
}

async function removeItemFromPlaylist({ wallet, playlistId, contentId }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }
  if (normalizeWallet(wallet) !== ctx.ownerWallet) {
    const err = new Error('Not your playlist');
    err.statusCode = 403;
    throw err;
  }

  ctx.playlist.items = (ctx.playlist.items || []).filter((item) => item.contentId !== contentId);
  ctx.playlist.items.forEach((item, index) => { item.sortOrder = index; });
  ctx.playlist.updatedAt = Date.now();
  return persistContext(ctx);
}

async function reorderPlaylistItems({ wallet, playlistId, orderedContentIds = [] }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }
  if (normalizeWallet(wallet) !== ctx.ownerWallet) {
    const err = new Error('Not your playlist');
    err.statusCode = 403;
    throw err;
  }

  const lookup = new Map((ctx.playlist.items || []).map((item) => [item.contentId, item]));
  const ordered = [];

  for (const id of orderedContentIds) {
    if (lookup.has(id)) ordered.push(lookup.get(id));
  }
  for (const item of (ctx.playlist.items || [])) {
    if (!ordered.find((row) => row.contentId === item.contentId)) ordered.push(item);
  }

  ordered.forEach((item, index) => { item.sortOrder = index; });
  ctx.playlist.items = ordered;
  ctx.playlist.updatedAt = Date.now();
  return persistContext(ctx);
}

async function getPlaylistForRead({ wallet, playlistId }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) return null;
  const viewerWallet = normalizeWallet(wallet);
  if (!ctx.playlist.isPublic && viewerWallet !== ctx.ownerWallet) {
    const err = new Error('Playlist not found');
    err.statusCode = 404;
    throw err;
  }
  return withAnalyticsView(ctx.playlist);
}

async function recordPlaylistPlay({ playlistId, contentId, listener, grossRoyaltyEth = 0 }) {
  const ctx = await getPlaylistContext(playlistId);
  if (!ctx) return null;

  const item = (ctx.playlist.items || []).find((row) => row.contentId === contentId || row.cid === contentId);
  if (!item) return null;

  ctx.playlist.analytics = ctx.playlist.analytics || emptyAnalytics();
  ctx.playlist.analytics.totals = ctx.playlist.analytics.totals || emptyAnalytics().totals;
  ctx.playlist.analytics.perAsset = ctx.playlist.analytics.perAsset || {};

  const isEligible = !!ctx.playlist.isPublic && !!item.supporterRoyaltyEnabled;
  const payoutEth = isEligible ? safeNumber(grossRoyaltyEth, 0) * (normalizeSharePercent(ctx.playlist.sharePercent) / 100) : 0;
  const now = Date.now();

  const row = ctx.playlist.analytics.perAsset[item.contentId] || {
    contentId: item.contentId,
    title: item.title,
    artistName: item.artistName,
    contentType: item.contentType,
    coverUrl: item.coverUrl,
    plays: 0,
    eligiblePlays: 0,
    ineligiblePlays: 0,
    revenueEth: 0,
    lastPlayedAt: null,
  };

  row.plays += 1;
  row.lastPlayedAt = now;
  if (isEligible) {
    row.eligiblePlays += 1;
    row.revenueEth = safeNumber(row.revenueEth, 0) + payoutEth;
  } else {
    row.ineligiblePlays += 1;
  }

  ctx.playlist.analytics.perAsset[item.contentId] = row;
  ctx.playlist.analytics.totals.totalPlays += 1;
  ctx.playlist.analytics.totals.lastPlayAt = now;
  if (isEligible) {
    ctx.playlist.analytics.totals.eligiblePlays += 1;
    ctx.playlist.analytics.totals.collectedEth = safeNumber(ctx.playlist.analytics.totals.collectedEth, 0) + payoutEth;
  } else {
    ctx.playlist.analytics.totals.ineligiblePlays += 1;
  }

  ctx.playlist.updatedAt = now;
  await persistContext(ctx);

  return {
    playlistId,
    contentId: item.contentId,
    listener: normalizeWallet(listener),
    eligible: isEligible,
    payoutEth,
  };
}

async function getWalletPlaylistRevenueSummary(wallet) {
  const playlists = await listPlaylistsForWallet(wallet, { includePrivate: true });
  const totals = playlists.reduce((acc, playlist) => {
    const summary = playlist.analyticsView || buildAnalyticsView(playlist);
    acc.collectedEth += safeNumber(summary.totals.collectedEth, 0);
    acc.totalPlays += safeNumber(summary.totals.totalPlays, 0);
    acc.eligiblePlays += safeNumber(summary.totals.eligiblePlays, 0);
    return acc;
  }, {
    collectedEth: 0,
    totalPlays: 0,
    eligiblePlays: 0,
  });

  return {
    totals,
    playlists: playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      isPublic: playlist.isPublic,
      itemCount: (playlist.items || []).length,
      analytics: playlist.analyticsView,
    })),
  };
}



async function syncCatalogEntryAcrossPlaylists(contentId, patch = {}) {
  const normalizedContentId = String(contentId || '').trim();
  if (!normalizedContentId) {
    return { updatedPlaylists: 0, updatedItems: 0 };
  }

  const profiles = await profileService.loadProfiles();
  const catalogMap = await loadCatalogMap();
  const entry = findCatalogEntry(catalogMap, normalizedContentId) || patch || {};

  let updatedPlaylists = 0;
  let updatedItems = 0;
  let didChange = false;

  for (const [wallet, profile] of Object.entries(profiles)) {
    const playlists = Array.isArray(profile?.playlists) ? profile.playlists : [];
    let profileChanged = false;

    for (let i = 0; i < playlists.length; i += 1) {
      const playlist = playlists[i];
      if (!playlist) continue;

      await ensurePlaylistShape(playlist, catalogMap);
      let playlistTouched = false;

      playlist.items = (playlist.items || []).map((item, index) => {
        const itemId = item?.contentId || item?.cid;
        if (itemId !== normalizedContentId) return item;

        updatedItems += 1;
        playlistTouched = true;
        return {
          ...item,
          title: entry.title || item.title,
          artistName: entry.artistName || item.artistName,
          contentType: entry.contentType || item.contentType,
          coverUrl: entry.coverUrl || item.coverUrl,
          previewUrl: entry.previewUrl || item.previewUrl,
          hlsUrl: entry.hlsUrl || item.hlsUrl,
          wallet: normalizeWallet(entry.wallet || item.wallet),
          supporterRoyaltyEnabled: entry.supporterRoyaltyEnabled != null ? !!entry.supporterRoyaltyEnabled : !!item.supporterRoyaltyEnabled,
          royaltyFeeRate: entry.royalty_fee_rate != null ? safeNumber(entry.royalty_fee_rate, 0) : safeNumber(item.royaltyFeeRate, 0),
          isPrivate: entry.isPrivate != null ? !!entry.isPrivate : !!item.isPrivate,
          sortOrder: index,
        };
      });

      if (playlistTouched) {
        playlist.updatedAt = Date.now();
        syncLegacyCidArray(playlist);
        updatedPlaylists += 1;
        profileChanged = true;
        didChange = true;
      }
    }

    if (profileChanged) {
      profiles[wallet] = profile;
    }
  }

  if (didChange) {
    await profileService.saveProfiles(profiles);
  }

  return { updatedPlaylists, updatedItems };
}


async function getCreatorAssetPlaylistAnalytics(wallet) {
  const normalizedWallet = normalizeWallet(wallet);
  const profiles = await profileService.loadProfiles();
  const catalogMap = await loadCatalogMap();

  const ownedEntries = Object.values(catalogMap || {}).filter((entry) => {
    return normalizeWallet(entry && entry.wallet) === normalizedWallet;
  });

  const assetMap = {};
  ownedEntries.forEach((entry) => {
    const contentId = entry.contentId || entry.cid;
    if (!contentId) return;
    assetMap[contentId] = {
      contentId,
      title: entry.title || 'Untitled asset',
      artistName: entry.artistName || 'Unknown creator',
      contentType: entry.contentType || 'music',
      coverUrl: entry.coverUrl || '',
      placementCount: 0,
      publicPlacementCount: 0,
      playlistPlays: 0,
      eligiblePlaylistPlays: 0,
      ineligiblePlaylistPlays: 0,
      curatorPayoutGeneratedEth: 0,
      topPlaylist: null,
      playlists: [],
    };
  });

  for (const profile of Object.values(profiles)) {
    const playlists = Array.isArray(profile && profile.playlists) ? profile.playlists : [];
    for (let i = 0; i < playlists.length; i += 1) {
      const playlist = playlists[i];
      if (!playlist) continue;
      await ensurePlaylistShape(playlist, catalogMap);

      const analyticsAssets = buildAnalyticsView(playlist).assets || [];
      const analyticsIndex = {};
      analyticsAssets.forEach((row) => { analyticsIndex[row.contentId] = row; });

      (playlist.items || []).forEach((item) => {
        const contentId = item.contentId || item.cid;
        if (!contentId) return;
        if (normalizeWallet(item.wallet) !== normalizedWallet && !assetMap[contentId]) return;

        const row = assetMap[contentId] || {
          contentId,
          title: item.title || 'Untitled asset',
          artistName: item.artistName || 'Unknown creator',
          contentType: item.contentType || 'music',
          coverUrl: item.coverUrl || '',
          placementCount: 0,
          publicPlacementCount: 0,
          playlistPlays: 0,
          eligiblePlaylistPlays: 0,
          ineligiblePlaylistPlays: 0,
          curatorPayoutGeneratedEth: 0,
          topPlaylist: null,
          playlists: [],
        };

        const revenueRow = analyticsIndex[contentId] || {
          contentId,
          plays: 0,
          eligiblePlays: 0,
          ineligiblePlays: 0,
          revenueEth: 0,
        };

        row.placementCount += 1;
        if (playlist.isPublic) row.publicPlacementCount += 1;
        row.playlistPlays += safeNumber(revenueRow.plays, 0);
        row.eligiblePlaylistPlays += safeNumber(revenueRow.eligiblePlays, 0);
        row.ineligiblePlaylistPlays += safeNumber(revenueRow.ineligiblePlays, 0);
        row.curatorPayoutGeneratedEth += safeNumber(revenueRow.revenueEth, 0);

        const playlistSummary = {
          id: playlist.id,
          name: playlist.name,
          isPublic: !!playlist.isPublic,
          plays: safeNumber(revenueRow.plays, 0),
          eligiblePlays: safeNumber(revenueRow.eligiblePlays, 0),
          revenueEth: safeNumber(revenueRow.revenueEth, 0),
        };
        row.playlists.push(playlistSummary);

        if (
          !row.topPlaylist ||
          playlistSummary.revenueEth > safeNumber(row.topPlaylist.revenueEth, 0) ||
          (
            playlistSummary.revenueEth === safeNumber(row.topPlaylist.revenueEth, 0) &&
            playlistSummary.plays > safeNumber(row.topPlaylist.plays, 0)
          )
        ) {
          row.topPlaylist = playlistSummary;
        }

        assetMap[contentId] = row;
      });
    }
  }

  const assets = Object.values(assetMap).map((row) => {
    row.playlists.sort((a, b) => {
      if (b.revenueEth !== a.revenueEth) return b.revenueEth - a.revenueEth;
      return b.plays - a.plays;
    });
    return row;
  });

  assets.sort((a, b) => {
    if (b.curatorPayoutGeneratedEth !== a.curatorPayoutGeneratedEth) {
      return b.curatorPayoutGeneratedEth - a.curatorPayoutGeneratedEth;
    }
    if (b.playlistPlays !== a.playlistPlays) return b.playlistPlays - a.playlistPlays;
    return b.placementCount - a.placementCount;
  });

  const totals = assets.reduce((acc, row) => {
    acc.assetCount += 1;
    acc.placementCount += safeNumber(row.placementCount, 0);
    acc.publicPlacementCount += safeNumber(row.publicPlacementCount, 0);
    acc.playlistPlays += safeNumber(row.playlistPlays, 0);
    acc.eligiblePlaylistPlays += safeNumber(row.eligiblePlaylistPlays, 0);
    acc.ineligiblePlaylistPlays += safeNumber(row.ineligiblePlaylistPlays, 0);
    acc.curatorPayoutGeneratedEth += safeNumber(row.curatorPayoutGeneratedEth, 0);
    return acc;
  }, {
    assetCount: 0,
    placementCount: 0,
    publicPlacementCount: 0,
    playlistPlays: 0,
    eligiblePlaylistPlays: 0,
    ineligiblePlaylistPlays: 0,
    curatorPayoutGeneratedEth: 0,
  });

  const assetsById = {};
  assets.forEach((row) => { assetsById[row.contentId] = row; });

  return {
    wallet: normalizedWallet,
    totals,
    assets: assetsById,
    topAssets: assets.slice(0, 5),
  };
}

module.exports = {
  DEFAULT_SHARE_PERCENT,
  normalizeWallet,
  isPlayableCatalogEntry,
  listPublicPlaylists,
  listPlaylistsForWallet,
  createPlaylist,
  patchPlaylist,
  deletePlaylist,
  addItemToPlaylist,
  removeItemFromPlaylist,
  reorderPlaylistItems,
  getPlaylistForRead,
  recordPlaylistPlay,
  getWalletPlaylistRevenueSummary,
  getCreatorAssetPlaylistAnalytics,
  syncCatalogEntryAcrossPlaylists,
};
