// Scripts/favorites.js
// MSP Shared Favorites Module — loaded on every page.
//
// Exposes: window.MSPFavorites
//
// Content type registry — every favoritable asset type lives here.
// Pages import what they need; nothing is hardcoded outside this file.
//
// localStorage key format: msp_fav_<type>:<walletAddress>
// Each value is a JSON array of opaque ID strings.
//
// Types and their attributes:
//   canPlaylist  — true if this favorites list can be converted to a playlist
//                  (and therefore earn supporter royalties when public)
//   page         — 'listen' | 'market' | 'both' — which page's favorites
//                  management panel hosts this type
//   color        — SIGNAL design system color role name (for CSS var)
//   cssColor     — actual hex value for inline use
//   icon         — emoji shorthand for rendering
//   label        — human-readable section heading

'use strict';

(function (root) {

  // ── Content type registry ────────────────────────────────────────────────
  var FAV_TYPES = {
    // ── Listen page ─────────────────────────────────────────────────────────
    track:          { label: 'Music Tracks',       color: 'ember',  cssColor: '#E85D3A', icon: '🎵', canPlaylist: true,  page: 'listen' },
    video:          { label: 'Music Videos',       color: 'ember',  cssColor: '#E85D3A', icon: '🎬', canPlaylist: true,  page: 'listen' },
    album:          { label: 'Albums',             color: 'gold',   cssColor: '#D4A853', icon: '💿', canPlaylist: false, page: 'listen' },
    artist:         { label: 'Artists',            color: 'gold',   cssColor: '#D4A853', icon: '🎤', canPlaylist: false, page: 'listen' },
    dj:             { label: 'DJs',                color: 'teal',   cssColor: '#00D4BB', icon: '🎧', canPlaylist: false, page: 'listen' },
    podcast:        { label: 'Podcasts',           color: 'violet', cssColor: '#8B5CF6', icon: '🎙', canPlaylist: false, page: 'listen' },
    livestream:     { label: 'Live Streams',       color: 'ember',  cssColor: '#E85D3A', icon: '🔴', canPlaylist: false, page: 'listen' },
    concert:        { label: 'Concerts & Events',  color: 'ember',  cssColor: '#E85D3A', icon: '🎪', canPlaylist: false, page: 'listen' },
    // ── Cross-listed (listen + marketplace) ────────────────────────────────
    nft_music:      { label: 'NFT Music',          color: 'violet', cssColor: '#8B5CF6', icon: '🎵', canPlaylist: true,  page: 'both'   },
    nft_video:      { label: 'NFT Videos',         color: 'violet', cssColor: '#8B5CF6', icon: '🎬', canPlaylist: true,  page: 'both'   },
    // ── Marketplace page only ───────────────────────────────────────────────
    nft_artwork:    { label: 'NFT Artworks',       color: 'violet', cssColor: '#8B5CF6', icon: '🖼', canPlaylist: false, page: 'market' },
    nft_artist:     { label: 'NFT Artists',        color: 'gold',   cssColor: '#D4A853', icon: '🎨', canPlaylist: false, page: 'market' },
    nft_collection: { label: 'NFT Collections',    color: 'violet', cssColor: '#8B5CF6', icon: '📦', canPlaylist: false, page: 'market' },
  };

  // ── localStorage helpers ─────────────────────────────────────────────────
  function walletKey() {
    return (window.walletAddress || 'anon').toLowerCase();
  }

  function storageKey(type) {
    return 'msp_fav_' + type + ':' + walletKey();
  }

  function loadSet(type) {
    try { return new Set(JSON.parse(localStorage.getItem(storageKey(type)) || '[]')); }
    catch (_) { return new Set(); }
  }

  function saveSet(type, set) {
    try { localStorage.setItem(storageKey(type), JSON.stringify(Array.from(set))); }
    catch (_) {}
  }

  // ── Core API ─────────────────────────────────────────────────────────────
  function toggle(type, id) {
    var s = loadSet(type);
    s.has(id) ? s.delete(id) : s.add(id);
    saveSet(type, s);
    return s.has(id); // returns new state: true = now favorited
  }

  function add(type, id) {
    var s = loadSet(type);
    s.add(id);
    saveSet(type, s);
  }

  function remove(type, id) {
    var s = loadSet(type);
    s.delete(id);
    saveSet(type, s);
  }

  function isFav(type, id) {
    return loadSet(type).has(id);
  }

  function getAll(type) {
    return Array.from(loadSet(type));
  }

  function countOf(type) {
    return loadSet(type).size;
  }

  function totalCount() {
    return Object.keys(FAV_TYPES).reduce(function (sum, t) {
      return sum + loadSet(t).size;
    }, 0);
  }

  // Returns { type, count } for every type with count > 0
  function summary() {
    return Object.keys(FAV_TYPES)
      .map(function (t) { return { type: t, meta: FAV_TYPES[t], count: loadSet(t).size }; })
      .filter(function (r) { return r.count > 0; });
  }

  // ── Heart button HTML helper ──────────────────────────────────────────────
  // Renders a ♥ button + popover for any set of types.
  // Caller passes: { id, types: ['track','artist','album'], data: { artist, album, ... } }
  // Returns HTML string.
  function heartButtonHtml(opts) {
    var id    = opts.id    || '';
    var types = opts.types || ['track'];
    var data  = opts.data  || {};

    // Determine heart color from which types are currently active
    var heartClass = '';
    for (var i = 0; i < types.length; i++) {
      var lookupId = types[i] === 'track' ? id
                   : types[i] === 'video' ? id
                   : types[i] === 'nft_music' ? id
                   : types[i] === 'nft_video' ? id
                   : (data[types[i]] || id);
      if (isFav(types[i], lookupId)) {
        heartClass = 'fav-' + types[i].replace('_', '-');
        break;
      }
    }

    var popItems = types.map(function (t) {
      var meta    = FAV_TYPES[t] || {};
      var itemId  = (t === 'track' || t === 'video' || t === 'nft_music' || t === 'nft_video')
                  ? id
                  : (data[t] || id);
      var active  = isFav(t, itemId) ? ' active' : '';
      return '<button class="fav-pop-item' + active + '" data-fav-type="' + _esc(t) + '" data-id="' + _esc(itemId) + '">' +
        '<span class="fav-pop-dot" style="background:' + (meta.cssColor || '#888') + '"></span>' +
        '♥ ' + (meta.label || t) +
      '</button>';
    }).join('');

    return '<div style="position:relative;">' +
      '<button class="fav-heart-btn ' + heartClass + '" data-fav-id="' + _esc(id) + '" title="Favorite" aria-label="Add to favorites">♥</button>' +
      '<div class="fav-popover" data-fav-id="' + _esc(id) + '">' + popItems + '</div>' +
    '</div>';
  }

  // ── CSS class name for a type (used on heart button) ─────────────────────
  // e.g. 'nft_music' → 'fav-nft-music'
  function typeClass(type) {
    return 'fav-' + type.replace(/_/g, '-');
  }

  // ── Internal escape helper ────────────────────────────────────────────────
  function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Expose ───────────────────────────────────────────────────────────────
  root.MSPFavorites = {
    FAV_TYPES:       FAV_TYPES,
    toggle:          toggle,
    add:             add,
    remove:          remove,
    isFav:           isFav,
    getAll:          getAll,
    countOf:         countOf,
    totalCount:      totalCount,
    summary:         summary,
    heartButtonHtml: heartButtonHtml,
    typeClass:       typeClass,
  };

})(window);
