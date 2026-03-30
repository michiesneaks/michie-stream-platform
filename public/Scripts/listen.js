// Scripts/listen.js
// All page logic for listen.html.
// Depends on: common.js, favorites.js, main.js (all loaded before this file).
'use strict';

(function () {

  // ── Audio element — declared first to prevent hoisting bug ────────────────
  var audio = document.getElementById('audio-player');

  // ── MSPFavorites — always read lazily so load-order never causes stale null
  function F()                      { return window.MSPFavorites || null; }
  function isLocalFav(type, id)     { var m = F(); return m ? m.isFav(type, id)    : false; }
  function toggleLocalFav(type, id) { var m = F(); return m ? m.toggle(type, id)   : false; }

  // ── Vinyl badge HTML ───────────────────────────────────────────────────────
  var VINYL_BADGE_COVER =
    '<img src="assets/msp-vinyl.svg" width="10" height="10"' +
    ' class="vinyl-cover-badge" title="Supporter royalties enabled" alt="">';
  var VINYL_BADGE_INLINE =
    '<img src="assets/msp-vinyl.svg" width="11" height="11"' +
    ' class="vinyl-inline-badge" title="Supporter royalties enabled" alt=""' +
    ' style="display:inline-block;vertical-align:middle;flex-shrink:0;margin-left:3px;">';

  // ── State ──────────────────────────────────────────────────────────────────
  var catalogData   = [];
  var currentFilter = 'all';
  var currentView   = 'list';
  var activeMenuCid = null;

  // ════════════════════════════════════════════════════════════════════════════
  //  CONTENT TYPE TABS
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll('.ct-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.ct-tab').forEach(function (t) {
        t.classList.remove('active'); t.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
      document.querySelectorAll('.tab-pane').forEach(function (p) { p.style.display = 'none'; });
      var pane = document.getElementById('tab-' + btn.dataset.ctTab);
      if (pane) pane.style.display = '';
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  MUSIC SUB-FILTER PILLS
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll('[data-music-filter]').forEach(function (pill) {
    pill.addEventListener('click', function () {
      document.querySelectorAll('[data-music-filter]').forEach(function (p) { p.classList.remove('active'); });
      pill.classList.add('active');
      currentFilter = pill.dataset.musicFilter;
      var catalogEl  = document.getElementById('msp-catalog');
      var favSection = document.getElementById('favorites-section');
      if (currentFilter === 'favorites') {
        if (catalogEl)  catalogEl.style.display  = 'none';
        if (favSection) favSection.style.display = '';
        renderFavoritesPanel();
      } else {
        if (catalogEl)  catalogEl.style.display  = '';
        if (favSection) favSection.style.display = 'none';
        renderCatalog(currentFilter);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  VIEW TOGGLE (list / grid)
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll('[data-view]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentView = btn.dataset.view;
      renderCatalog(currentFilter);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  CATALOG FETCH
  // ════════════════════════════════════════════════════════════════════════════
  async function fetchCatalog() {
    try { var r = await fetch('/api/catalog'); return r.ok ? await r.json() : []; }
    catch (_) { return []; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER CATALOG
  // ════════════════════════════════════════════════════════════════════════════
  function renderCatalog(filter) {
    var el = document.getElementById('msp-catalog');
    if (!el) return;
    var items = filterCatalog(catalogData, filter);
    if (!items.length) {
      el.innerHTML = '<div class="catalog-empty">No tracks yet. <a href="creators.html">Upload your first track</a>.</div>';
      return;
    }
    el.innerHTML = currentView === 'list'
      ? '<div class="track-list">' + items.map(function (item, idx) { return buildTrackRow(item, idx + 1); }).join('') + '</div>'
      : '<div class="track-grid">'  + items.map(function (item) { return buildTrackTile(item); }).join('') + '</div>';
    wireInteractions(el);
    loadDurations(items);
  }

  function filterCatalog(data, filter) {
    if (filter === 'videos') return data.filter(function (i) { return i.contentType === 'video' || i.contentType === 'art_animated'; });
    return data.filter(function (i) { return i.contentType === 'music' || !filter || filter === 'all'; });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BUILD LIST ROW
  //  Grid columns: num | cover-wrap | info | tags | duration+vinyl | heart | ⋮
  // ════════════════════════════════════════════════════════════════════════════
  function buildTrackRow(item, num) {
    var ct          = item.contentType || 'music';
    var primaryType = ct === 'video' ? 'video' : 'track';
    var isRoyalty   = !!item.supporterRoyaltyEnabled;

    var cover = '<div class="track-cover-wrap">' +
      (item.coverUrl
        ? '<img class="track-cover" src="' + esc(item.coverUrl) + '" alt="' + esc(item.title) + '">'
        : '<div class="track-cover-placeholder">🎵</div>') +
      (isRoyalty ? VINYL_BADGE_COVER : '') +
    ' </div>';

    var tags = (item.tags || []).slice(0, 3).map(function (t) {
      return '<span class="track-tag">' + esc(t) + '</span>';
    }).join('');

    var heartClass = computeHeartClass(primaryType, item);
    var typeBadge  = buildTypeBadge(ct);
    var durCell    = '<span class="track-duration" data-dur-id="' + esc(item.contentId) + '">—</span>' +
                     (isRoyalty ? VINYL_BADGE_INLINE : '');

    return '<div class="track-row"' + dataAttrs(item, ct) + '>' +
      '<span class="track-num">' + num + '</span>' +
      cover +
      '<div class="track-info">' +
        '<div class="track-title">'  + esc(item.title || 'Untitled') + '</div>' +
        '<div class="track-artist">' + esc(item.artistName || '—') + ' ' + typeBadge + '</div>' +
      '</div>' +
      '<div class="track-tags">' + tags + '</div>' +
  
       '<span class="track-duration" data-dur-id="' + esc(item.contentId) + '">—</span>' +
      (isRoyalty ? VINYL_BADGE_INLINE : '') +
      '<button class="track-play-inline" title="Play">▶</button>' +
      '<button class="fav-heart-btn ' + heartClass + '" data-contentid="' + esc(item.contentId) + '" title="Favorite" aria-label="Favorite">♥</button>' +
      '<button class="track-options-btn" data-contentid="' + esc(item.contentId) + '" title="More options"    aria-label="More options">⋮</button>' +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BUILD GRID TILE
  //  Structure: cover-wrap (full-width square) | title/artist | footer (heart · dur · ⋮)
  // ════════════════════════════════════════════════════════════════════════════
  function buildTrackTile(item) {
    var ct          = item.contentType || 'music';
    var primaryType = ct === 'video' ? 'video' : 'track';
    var isRoyalty   = !!item.supporterRoyaltyEnabled;
    var heartClass  = computeHeartClass(primaryType, item);

    var cover = '<div class="track-cover-wrap">' +
      (item.coverUrl
        ? '<img src="' + esc(item.coverUrl) + '" alt="' + esc(item.title) + '">'
        : '<div class="track-tile-placeholder">🎵</div>') +
      (isRoyalty ? VINYL_BADGE_COVER : '') +
      '<button class="track-tile-play" title="Play">▶</button>' +
    '</div>';

    return '<div class="track-tile"' + dataAttrs(item, ct) + '>' +
      cover +
      '<div class="track-tile-info">' +
        '<div class="track-tile-title">'  + esc(item.title || 'Untitled') + '</div>' +
        '<div class="track-tile-artist">' + esc(item.artistName || '—') + '</div>' +
      '</div>' +
      '<div class="track-tile-footer">' +
        '<button class="fav-heart-btn ' + heartClass + '" data-contentid="' + esc(item.contentId) + '" title="Favorite" aria-label="Favorite">♥</button>' +
        '<span class="track-duration" data-dur-id="' + esc(item.contentId) + '">—</span>' +
        '<button class="track-options-btn" data-contentid="' + esc(item.contentId) + '" title="More options" aria-label="More options">⋮</button>' +
      '</div>' +
    '</div>';
  }

  // ── Shared builders ────────────────────────────────────────────────────────
  function dataAttrs(item, ct) {
    return ' data-contentid="' + esc(item.contentId)                  + '"' +
           ' data-hlsurl="'    + esc(item.hlsUrl || '')               + '"' +
           ' data-metaurl="'   + esc(item.metadataUrl || '')          + '"' +
           ' data-title="'     + esc(item.title || '')                + '"' +
           ' data-artist="'    + esc(item.artistName || '')           + '"' +
           ' data-cover="'     + esc(item.coverUrl || '')             + '"' +
           ' data-album="'     + esc(item.album || item.title || '')  + '"' +
           ' data-type="'      + esc(ct)                              + '"';
  }

  function computeHeartClass(primaryType, item) {
    if (isLocalFav(primaryType, item.contentId))              return 'fav-' + primaryType;
    if (isLocalFav('artist', item.artistName || ''))          return 'fav-artist';
    if (isLocalFav('album',  item.album || item.title || '')) return 'fav-album';
    return '';
  }

  function buildTypeBadge(ct) {
    var typeMap   = { music:'MUSIC', podcast:'PODCAST', video:'VIDEO', art_still:'ART', art_animated:'ART' };
    var typeClass = { music:'type-music', podcast:'type-podcast', video:'type-video', art_still:'type-art', art_animated:'type-art' };
    return '<span class="track-type-badge ' + (typeClass[ct] || 'type-music') + '">' + (typeMap[ct] || 'MUSIC') + '</span>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  EVENT DELEGATION — single listener on container handles everything
  // ════════════════════════════════════════════════════════════════════════════
  function wireInteractions(container) {
    container.addEventListener('click', function (e) {

      // Play inline button (list)
      if (e.target.closest('.track-play-inline')) {
        e.stopPropagation();
        playItem(e.target.closest('.track-row'));
        return;
      }
      // Play button (tile)
      if (e.target.closest('.track-tile-play')) {
        e.stopPropagation();
        playItem(e.target.closest('.track-tile'));
        return;
      }
      // Click info or cover → play
      if (e.target.closest('.track-info') || e.target.closest('.track-cover')) {
        playItem(e.target.closest('.track-row'));
        return;
      }

      // Heart — quick-favorite the track
      if (e.target.closest('.fav-heart-btn')) {
        e.stopPropagation();
        closeOptionsMenu();
        var heartBtn = e.target.closest('.fav-heart-btn');
        var cid      = heartBtn.dataset.contentid;
        var row      = container.querySelector('[data-contentid="' + cid + '"]');
        var ct       = row ? (row.dataset.type || 'music') : 'music';
        var favType  = ct === 'video' ? 'video' : 'track';
        var nowFav   = toggleLocalFav(favType, cid);
        // Update every heart for this cid on the whole page
        document.querySelectorAll('.fav-heart-btn[data-contentid="' + cid + '"]').forEach(function (h) {
          h.classList.remove('fav-track', 'fav-video', 'fav-artist', 'fav-album');
          if (nowFav) h.classList.add('fav-' + favType);
        });
        return;
      }

      // Three-dot menu button
      if (e.target.closest('.track-options-btn')) {
        e.stopPropagation();
        var optBtn = e.target.closest('.track-options-btn');
        var cid2   = optBtn.dataset.contentid;
        if (activeMenuCid === cid2) { closeOptionsMenu(); return; }
        openOptionsMenu(optBtn, cid2);
        return;
      }
    });

    // Double-click to play
    container.addEventListener('dblclick', function (e) {
      var row  = e.target.closest('.track-row');
      var tile = e.target.closest('.track-tile');
      if (row)  playItem(row);
      if (tile) playItem(tile);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  OPTIONS MENU
  // ════════════════════════════════════════════════════════════════════════════
  var optionsMenu  = document.getElementById('track-options-menu');
  var _menuWired   = false;

  function openOptionsMenu(triggerBtn, cid) {
    if (!optionsMenu) return;
    activeMenuCid = cid;

    var item      = catalogData.find(function (i) { return i.contentId === cid; }) || {};
    var ct        = item.contentType || 'music';
    var favType   = ct === 'video' ? 'video' : 'track';
    var isFavNow  = isLocalFav(favType, cid);
    var isFavArt  = isLocalFav('artist', item.artistName || '');

    // Update fav button labels
    var favTBtn = optionsMenu.querySelector('[data-opt="fav-track"]');
    var favABtn = optionsMenu.querySelector('[data-opt="fav-artist"]');
    if (favTBtn) {
      favTBtn.innerHTML = '<i class="opt-icon">♥</i> ' + (isFavNow ? '✔ ' : '') + (ct === 'video' ? 'Favorite Video' : 'Favorite Track');
      favTBtn.classList.toggle('fav-active-track', isFavNow);
    }
    if (favABtn) {
      favABtn.innerHTML = '<i class="opt-icon">★</i> ' + (isFavArt ? '✔ ' : '') + 'Favorite Artist';
      favABtn.classList.toggle('fav-active-artist', isFavArt);
    }

    // Populate playlist submenu
    var plListEl = optionsMenu.querySelector('#opt-playlist-list');
    if (plListEl) plListEl.innerHTML = buildPlaylistSubmenu(item);

    // Download gating
    var canDl   = window.CAN && window.CAN.download && window.CAN.download();
    var dlBtn   = optionsMenu.querySelector('[data-opt="download"]');
    var dlBadge = optionsMenu.querySelector('#opt-download-badge');
    if (dlBtn)   dlBtn.classList.toggle('opt-disabled', !canDl);
    if (dlBadge) dlBadge.style.display = canDl ? 'none' : '';

    // Store context on menu element for the handler
    optionsMenu.dataset.cid    = cid;
    optionsMenu.dataset.ct     = ct;
    optionsMenu.dataset.hlsurl = item.hlsUrl || '';
    optionsMenu.dataset.title  = item.title  || '';
    optionsMenu.dataset.artist = item.artistName || '';

    // Position near trigger
    var rect  = triggerBtn.getBoundingClientRect();
    var left  = Math.max(8, rect.right - 220);
    var top   = rect.bottom + 4;
    if (top + 340 > window.innerHeight) top = Math.max(8, rect.top - 340);
    optionsMenu.style.left = left + 'px';
    optionsMenu.style.top  = top  + 'px';
    optionsMenu.classList.add('open');

    if (!_menuWired) wireMenuHandlers();
  }

  function closeOptionsMenu() {
    if (optionsMenu) optionsMenu.classList.remove('open');
    activeMenuCid = null;
  }

  function buildPlaylistSubmenu(item) {
    var canPlaylist = window.CAN && window.CAN.createPlaylist && window.CAN.createPlaylist();
    if (!canPlaylist) return '<span class="opt-pl-empty">Tier 2+ required to use playlists</span>';

    var profile   = window.userProfile || null;
    var playlists = (profile && profile.playlists) || [];
    var myWallet  = (window.walletAddress || '').toLowerCase();
    var itemOwner = (item.wallet || '').toLowerCase();

    // Creators cannot add their own assets to their own playlists
    var eligible = playlists.filter(function () {
      return itemOwner !== myWallet;
    });

    var rows = eligible.slice(0, 8).map(function (pl) {
      return '<button class="opt-pl-item" data-opt="add-to-playlist" data-playlist-id="' + esc(pl.id) + '">' +
        '<i class="opt-icon">🎵</i> ' + esc(pl.name || 'Playlist') + '</button>';
    }).join('');

    rows += '<button class="opt-pl-item" data-opt="new-playlist"><i class="opt-icon">＋</i> New Playlist</button>';
    return rows;
  }

  function wireMenuHandlers() {
    _menuWired = true;
    optionsMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-opt]');
      if (!btn) return;
      e.stopPropagation();

      var opt     = btn.dataset.opt;
      var cid     = optionsMenu.dataset.cid;
      var ct      = optionsMenu.dataset.ct     || 'music';
      var hlsUrl  = optionsMenu.dataset.hlsurl || '';
      var title   = optionsMenu.dataset.title  || '';
      var artist  = optionsMenu.dataset.artist || '';
      var favType = ct === 'video' ? 'video' : 'track';
      var item    = catalogData.find(function (i) { return i.contentId === cid; }) || {};

      if (opt === 'fav-track') {
        var nowFav = toggleLocalFav(favType, cid);
        document.querySelectorAll('.fav-heart-btn[data-contentid="' + cid + '"]').forEach(function (h) {
          h.classList.remove('fav-track', 'fav-video', 'fav-artist', 'fav-album');
          if (nowFav) h.classList.add('fav-' + favType);
        });
        btn.innerHTML = '<i class="opt-icon">♥</i> ' + (nowFav ? '✔ ' : '') + (ct === 'video' ? 'Favorite Video' : 'Favorite Track');
        btn.classList.toggle('fav-active-track', nowFav);
        return;
      }

      if (opt === 'fav-artist') {
        var nowFavA = toggleLocalFav('artist', item.artistName || '');
        btn.innerHTML = '<i class="opt-icon">★</i> ' + (nowFavA ? '✔ ' : '') + 'Favorite Artist';
        btn.classList.toggle('fav-active-artist', nowFavA);
        closeOptionsMenu();
        return;
      }

      if (opt === 'share') {
        var url = window.location.origin + '/listen.html?cid=' + cid;
        if (navigator.share) {
          navigator.share({ title: title, text: title + ' by ' + artist, url: url }).catch(function () {});
        } else {
          navigator.clipboard.writeText(url)
            .then(function () { showToast('Link copied to clipboard'); })
            .catch(function () { showToast('Could not copy link'); });
        }
        closeOptionsMenu(); return;
      }

      if (opt === 'download') {
        if (btn.classList.contains('opt-disabled')) { showToast('Tier 2+ subscription required to download'); return; }
        if (hlsUrl) window.open(hlsUrl, '_blank');
        closeOptionsMenu(); return;
      }

      if (opt === 'lyrics') {
        showToast('Lyrics not yet available for this track.');
        closeOptionsMenu(); return;
      }

      if (opt === 'info') {
        showTrackInfo(item);
        closeOptionsMenu(); return;
      }

      if (opt === 'add-to-playlist') {
        addToPlaylist(cid, btn.dataset.playlistId, title);
        closeOptionsMenu(); return;
      }

      if (opt === 'new-playlist') {
        // Playlist creation and management live on playlists page
        window.location.href = 'playlists.html';
        closeOptionsMenu(); return;
      }
    });
  }

  async function addToPlaylist(cid, playlistId, title) {
    if (!window.walletAddress) { showToast('Connect wallet first'); return; }
    try {
      var r = await fetch('/api/playlists/' + playlistId + '/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ wallet: window.walletAddress, contentId: cid }),
      });
      var data = null;
      try { data = await r.json(); } catch (_) {}
      showToast(r.ok ? '✔ Added to playlist' : ((data && data.error) || 'Could not add to playlist'));
    } catch (_) {
      showToast('Could not add to playlist');
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  var _toastEl, _toastTimer;
  function showToast(msg) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.style.cssText =
        'background:var(--bg-raised);border:1px solid var(--border-mid);border-left:3px solid var(--teal);' +
        'border-radius:8px;bottom:96px;box-shadow:0 8px 32px rgba(0,0,0,.6);color:var(--text-primary);' +
        'font-size:13px;padding:10px 16px;position:fixed;right:20px;z-index:4000;transition:opacity .2s;';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { _toastEl.style.opacity = '0'; }, 3000);
  }

  function showTrackInfo(item) {
    var lines = [
      'Title: '     + (item.title || '—'),
      'Artist: '    + (item.artistName || '—'),
      'Type: '      + (item.contentType || '—'),
      'Content ID: '+ (item.contentId || '—'),
    ];
    if (item.supporterRoyaltyEnabled) lines.push('★ Supporter royalties enabled');
    alert(lines.join('\n'));
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PLAY AN ITEM
  // ════════════════════════════════════════════════════════════════════════════
  function playItem(el) {
    if (!el) return;
    var hlsUrl   = el.dataset.hlsurl  || '';
    console.log('[playItem] called. hlsUrl:', hlsUrl, 'element:', el); 
    if (!hlsUrl) { console.warn('[playItem] hlsUrl is empty — aborting'); return; }
    var metaUrl  = el.dataset.metaurl || '';
    var title    = el.dataset.title   || 'Unknown Track';
    var artist   = el.dataset.artist  || '—';
    var coverUrl = el.dataset.cover   || '';
    if (!hlsUrl) return;

    var nameEl   = document.getElementById('track-name');
    var artistEl = document.getElementById('player-artist-name');
    var vinylEl  = document.getElementById('vinyl-icon');
    if (nameEl)   { nameEl.textContent = title; nameEl.style.color = ''; nameEl.style.fontStyle = ''; }
    if (artistEl)   artistEl.textContent = artist;
    if (vinylEl && coverUrl) vinylEl.src = coverUrl;

    document.querySelectorAll('.track-row.is-playing, .track-tile.is-playing').forEach(function (r) { r.classList.remove('is-playing'); });
    el.classList.add('is-playing');

    window.currentPlayingCid = el.dataset.contentid || null;

    if (typeof window.playHls === 'function') window.playHls(hlsUrl, metaUrl);
  }


  // ════════════════════════════════════════════════════════════════════════════
  //  CLOSE MENU on outside click / Escape
  // ════════════════════════════════════════════════════════════════════════════
  document.addEventListener('click', function () { closeOptionsMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOptionsMenu(); });

  // ════════════════════════════════════════════════════════════════════════════
  //  BILLING PERIOD TOGGLE
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll('input[name="billing-period"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      var period = this.value;
      var prices = { monthly:['$10.99','$19.99','$34.99'], annual:['$131.88/yr','$239.88/yr','$419.88/yr'], rolling:['$10.99','$19.99','$34.99'] };
      var labels = { monthly:'/mo', annual:'/yr', rolling:'/3 days' };
      var p = prices[period];
      var t1 = document.querySelector('.price-t1'); if (t1) t1.textContent = p[0];
      var t2 = document.querySelector('.price-t2'); if (t2) t2.textContent = p[1];
      var t3 = document.querySelector('.price-t3'); if (t3) t3.textContent = p[2];
      document.querySelectorAll('.period-label').forEach(function (el) { el.textContent = labels[period]; });
      document.querySelectorAll('[data-plan-monthly]').forEach(function (btn) {
        var key = 'plan' + period.charAt(0).toUpperCase() + period.slice(1);
        btn.dataset.subscribePlan = btn.dataset[key];
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  DURATION HELPERS
  // ════════════════════════════════════════════════════════════════════════════
  function fmtDuration(secs) {
    if (!secs || !isFinite(secs)) return '—';
    var s = Math.round(secs);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }

  function loadDurations(items) {
    items.forEach(function (item) {
      if (!item.metadataUrl) return;
      fetch(item.metadataUrl)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (meta) {
          if (!meta) return;
          var dur = meta.duration
            || (meta.files && meta.files.duration)
            || (meta.video && meta.video.duration)
            || (meta.audio && meta.audio.duration);
          if (!dur) return;
          var formatted = fmtDuration(parseFloat(dur));
          // Update all spans for this contentId (list + tile both rendered)
          document.querySelectorAll('[data-dur-id="' + item.contentId + '"]').forEach(function (span) {
            span.textContent = formatted;
          });
        })
        .catch(function () {});
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  FAVORITES PANEL (compact, listen.html only — management is on profile.html)
  // ════════════════════════════════════════════════════════════════════════════
  function renderFavoritesPanel() {
    var chipsEl = document.getElementById('fav-summary-chips');
    var listEl  = document.getElementById('favorites-list');
    var fav     = F();

    if (chipsEl && fav) {
      var chips = Object.keys(fav.FAV_TYPES).map(function (t) {
        var count = fav.countOf(t);
        if (!count) return '';
        var meta = fav.FAV_TYPES[t];
        return '<a href="favorites.html" style="align-items:center;background:rgba(0,0,0,.3);border:1px solid ' + meta.cssColor + ';' +
          'border-radius:16px;color:' + meta.cssColor + ';display:inline-flex;font-size:11px;font-weight:600;gap:5px;padding:3px 10px;text-decoration:none;">' +
          meta.icon + ' ' + meta.label + ' <strong>' + count + '</strong></a>';
      }).join('');
      chipsEl.innerHTML = chips || '<span class="text-muted small">No favorites yet.</span>';
    }

    if (!listEl) return;
    var fav2     = F();
    var playable = [];
    ['track', 'video', 'nft_music', 'nft_video'].forEach(function (t) {
      (fav2 ? fav2.getAll(t) : []).forEach(function (cid) {
        var item = catalogData.find(function (c) { return c.contentId === cid; });
        if (item) playable.push(item);
      });
    });

    if (!playable.length) {
      listEl.innerHTML = '<p class="text-muted small py-2">No favorited tracks yet. Tap ♥ on any track to save it here.</p>';
      return;
    }

    listEl.innerHTML = '<div class="track-list">' +
      playable.map(function (item, idx) { return buildTrackRow(item, idx + 1); }).join('') +
      '</div>';
    wireInteractions(listEl);
    loadDurations(playable);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  HTML ESCAPE
  // ════════════════════════════════════════════════════════════════════════════
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════════════════
  (async function boot() {
    var catalogEl = document.getElementById('msp-catalog');
    catalogData   = await fetchCatalog();

    if (catalogData.length) {
      renderCatalog('all');
    } else {
      if (catalogEl) {
        catalogEl.innerHTML = '<div class="catalog-empty">No tracks yet.<br>' +
          '<a href="creators.html">Upload your first track on Creators Corner</a>.</div>';
      }
    }

    // Podcasts tab
    var podcastItems = catalogData.filter(function (i) { return i.contentType === 'podcast'; });
    var podList      = document.getElementById('podcast-list');
    if (podList && podcastItems.length) {
      podList.innerHTML = podcastItems.map(function (item) {
        var isRoyalty = !!item.supporterRoyaltyEnabled;
        return '<div class="podcast-tile">' +
          (item.coverUrl
            ? '<img src="' + esc(item.coverUrl) + '" alt="' + esc(item.title) + '">'
            : '<div style="aspect-ratio:1;background:var(--bg-raised);display:flex;align-items:center;justify-content:center;font-size:40px;">🎙</div>') +
          '<div class="podcast-tile-info">' +
            '<div class="podcast-tile-title">' + esc(item.title) + (isRoyalty ? VINYL_BADGE_INLINE : '') + '</div>' +
            '<div class="podcast-tile-meta">'  + esc(item.artistName || '—') + '</div>' +
            '<button class="podcast-tile-play"' +
              ' data-hlsurl="'  + esc(item.hlsUrl || '')     + '"' +
              ' data-metaurl="' + esc(item.metadataUrl || '') + '"' +
              ' data-title="'   + esc(item.title || '')      + '"' +
              ' data-artist="'  + esc(item.artistName || '') + '"' +
              ' data-cover="'   + esc(item.coverUrl || '')   + '">▶ Play Episode</button>' +
          '</div></div>';
      }).join('');
      podList.querySelectorAll('.podcast-tile-play').forEach(function (btn) {
        btn.addEventListener('click', function () { playItem(btn); });
      });
    }
  })();

})(); // end listen.js
