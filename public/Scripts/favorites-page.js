// Scripts/favorites-page.js
// Page logic for favorites.html only.
// Depends on: common.js, favorites.js, main.js (all loaded before this file).
// Do NOT load on any other page.



(function () {
  'use strict';

  if (!document.body || !document.body.classList.contains('page-favorites')) return;

  var F = window.MSPFavorites; // shorthand

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Type config for each section — order determines render order ──────────
  var LISTEN_TYPES  = ['track','video','album','artist','dj','podcast','livestream','concert','nft_music','nft_video'];
  var MARKET_TYPES  = ['nft_artwork','nft_artist','nft_collection','nft_music','nft_video'];

  // ── Build one accordion section ───────────────────────────────────────────
  function buildSection(type, catalogData) {
    var meta    = F.FAV_TYPES[type];
    var ids     = F.getAll(type);
    var count   = ids.length;

    // Playlist bar HTML (only for eligible types)
    var playlistBar = '';
    if (meta.canPlaylist) {
      playlistBar =
        '<div class="fav-playlist-bar" id="pbar-' + type + '">' +
          '<input type="text" id="pname-' + type + '" placeholder="Name this playlist…" maxlength="80">' +
          '<div class="fav-visibility-toggle">' +
            '<button class="fav-vis-btn active public"  data-vis="public"  data-type="' + type + '">🌐 Public</button>' +
            '<button class="fav-vis-btn private"        data-vis="private" data-type="' + type + '">🔒 Private</button>' +
          '</div>' +
          '<button class="fav-create-btn" data-type="' + type + '"' + (count === 0 ? ' disabled' : '') + '>Create Playlist</button>' +
          '<p class="fav-royalty-note public-mode" id="rnote-' + type + '">' +
            '🟡 Public playlists earn you <strong>supporter royalties</strong> for plays of tracks enabled by their creators. ' +
            'Look for the ' +
            '<img src="assets/msp-vinyl.svg" width="14" height="14" style="display:inline-block;vertical-align:middle;flex-shrink:0;margin:0 2px;" alt="royalty-enabled">' +
            ' vinyl icon on tracks and videos — those are the ones that will earn you supporter royalties.' +
          '</p>' +
        '</div>';
    }

    // Item rows
    var itemsHtml = '';
    if (!count) {
      itemsHtml = '<div class="fav-empty">Nothing here yet — tap ♥ on any ' + meta.label.toLowerCase().replace(/s$/, '') + ' to save it.</div>';
    } else {
      itemsHtml = '<div class="fav-item-list">';
      ids.forEach(function (id) {
        // Try to look up richer data from catalog if available
        var item    = catalogData ? catalogData.find(function (c) { return c.contentId === id; }) : null;
        var label   = item ? (item.title || item.artistName || id.slice(0,20)) : id.slice(0, 24) + (id.length > 24 ? '…' : '');
        var sub     = item ? (item.artistName || '') : '';
        var coverUrl = item ? (item.coverUrl || '') : '';

        var cover = coverUrl
          ? '<img class="fav-item-cover" src="' + esc(coverUrl) + '" alt="">'
          : '<div class="fav-item-cover-placeholder">' + meta.icon + '</div>';

        var playBtn = (item && item.hlsUrl)
          ? '<button class="fav-item-play" data-hlsurl="' + esc(item.hlsUrl) + '" data-metaurl="' + esc(item.metadataUrl||'') + '" data-title="' + esc(item.title||'') + '" data-artist="' + esc(item.artistName||'') + '" data-cover="' + esc(coverUrl) + '" title="Play">▶</button>'
          : '';

        itemsHtml +=
          '<div class="fav-item" data-fav-type="' + esc(type) + '" data-fav-id="' + esc(id) + '">' +
            '<span class="fav-item-dot" style="background:' + meta.cssColor + ';"></span>' +
            cover +
            '<div class="fav-item-text">' +
              '<div class="fav-item-label">' + esc(label) + '</div>' +
              (sub ? '<div class="fav-item-sub">' + esc(sub) + '</div>' : '') +
            '</div>' +
            playBtn +
            '<button class="fav-item-remove" data-fav-type="' + esc(type) + '" data-fav-id="' + esc(id) + '" title="Remove from favorites">✕</button>' +
          '</div>';
      });
      itemsHtml += '</div>';
    }

    return '<div class="fav-section" data-color="' + meta.color + '" data-type="' + type + '" id="fsec-' + type + '">' +
      '<div class="fav-section-head" data-type="' + type + '">' +
        '<span class="fav-section-icon">' + meta.icon + '</span>' +
        '<span class="fav-section-label">' + esc(meta.label) + '</span>' +
        '<span class="fav-section-count" id="fcnt-' + type + '">' + count + '</span>' +
        '<span class="fav-section-chevron">▾</span>' +
      '</div>' +
      '<div class="fav-section-body" id="fbody-' + type + '">' +
        playlistBar +
        itemsHtml +
      '</div>' +
    '</div>';
  }

  // ── Render all sections ───────────────────────────────────────────────────
  function renderAll(catalogData) {
    var listenEl = document.getElementById('fav-sections-listen');
    var marketEl = document.getElementById('fav-sections-market');
    var listenGroup = document.getElementById('fav-listen-group');
    var marketGroup = document.getElementById('fav-market-group');
    var emptyState  = document.getElementById('fav-empty-state');
    var totalEl     = document.getElementById('fav-total-count');

    if (listenEl) listenEl.innerHTML = LISTEN_TYPES.map(function (t) { return buildSection(t, catalogData); }).join('');
    if (marketEl) marketEl.innerHTML = MARKET_TYPES.map(function (t) { return buildSection(t, catalogData); }).join('');

    var total = F.totalCount();
    if (totalEl) totalEl.textContent = total;

    var listenHasAny = LISTEN_TYPES.some(function (t) { return F.countOf(t) > 0; });
    var marketHasAny = MARKET_TYPES.some(function (t) { return F.countOf(t) > 0; });
    if (listenGroup) listenGroup.style.display = listenHasAny ? '' : 'none';
    if (marketGroup) marketGroup.style.display = marketHasAny ? '' : 'none';
    if (emptyState)  emptyState.style.display  = (!listenHasAny && !marketHasAny) ? '' : 'none';

    wireAll();
  }

  // ── Wire accordion toggles ────────────────────────────────────────────────
  function wireAll() {
    // Accordion toggle
    document.querySelectorAll('.fav-section-head').forEach(function (head) {
      head.addEventListener('click', function () {
        var type = head.dataset.type;
        var body = document.getElementById('fbody-' + type);
        if (!body) return;
        var isOpen = body.classList.contains('open');
        body.classList.toggle('open', !isOpen);
        head.setAttribute('aria-expanded', String(!isOpen));
      });
    });

    // Remove buttons
    document.querySelectorAll('.fav-item-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        F.remove(btn.dataset.favType, btn.dataset.favId);
        // Re-render just the body of this section
        var sec  = btn.closest('.fav-section');
        var type = sec ? sec.dataset.type : null;
        if (!type) return;
        var body = document.getElementById('fbody-' + type);
        var wasOpen = body && body.classList.contains('open');
        renderAll(window._favCatalogCache);
        // Re-open the section that was open
        if (wasOpen && type) {
          var newBody = document.getElementById('fbody-' + type);
          if (newBody) newBody.classList.add('open');
        }
      });
    });

    // Play buttons
    document.querySelectorAll('.fav-item-play').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof window.playHls === 'function') {
          window.playHls(btn.dataset.hlsurl, btn.dataset.metaurl || '');
          // Update player bar if elements exist
          var tn = document.getElementById('track-name');
          var an = document.getElementById('player-artist-name');
          var vi = document.getElementById('vinyl-icon');
          if (tn) { tn.textContent = btn.dataset.title || ''; tn.style.fontStyle = ''; }
          if (an) an.textContent = btn.dataset.artist || '';
          if (vi && btn.dataset.cover) vi.src = btn.dataset.cover;
        }
      });
    });

    // Visibility toggle buttons
    document.querySelectorAll('.fav-vis-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type    = btn.dataset.type;
        var vis     = btn.dataset.vis;
        var bar     = document.getElementById('pbar-' + type);
        if (!bar) return;
        bar.querySelectorAll('.fav-vis-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var note = document.getElementById('rnote-' + type);
        var vinylSvg = '<img src="assets/msp-vinyl.svg" width="14" height="14" style="display:inline-block;vertical-align:middle;flex-shrink:0;margin:0 2px;" alt="royalty-enabled">';
        if (note) {
          note.classList.toggle('public-mode', vis === 'public');
          note.innerHTML = vis === 'public'
            ? '🟡 Public playlists earn you <strong>supporter royalties</strong> for plays of tracks enabled by their creators. Look for the ' + vinylSvg + ' vinyl icon on tracks and videos — those are the ones that will earn you supporter royalties.'
            : '🔒 Private playlists do not earn royalties and are only visible to you.';
        }
      });
    });

    // Create playlist buttons
    document.querySelectorAll('.fav-create-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var type    = btn.dataset.type;
        var nameEl  = document.getElementById('pname-' + type);
        var bar     = document.getElementById('pbar-' + type);
        var name    = nameEl ? nameEl.value.trim() : '';
        if (!name) { if (nameEl) nameEl.focus(); return; }

        var visBtn  = bar ? bar.querySelector('.fav-vis-btn.active') : null;
        var isPublic = visBtn ? visBtn.dataset.vis === 'public' : true;
        var ids      = F.getAll(type);
        if (!ids.length) return;

        btn.disabled    = true;
        btn.textContent = 'Creating…';

        try {
          var res = await fetch('/api/favorites/convert-to-playlist', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              wallet:    window.walletAddress,
              name:      name,
              cids:      ids,
              isPublic:  isPublic,
              type:      type,
              royaltyEligible: isPublic, // backend gates actual royalties
            }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed');
          btn.textContent = '✔ Created — open Playlists';
          btn.style.background = 'var(--teal)';
          if (nameEl) nameEl.value = '';
          setTimeout(function () {
            window.location.href = 'playlists.html';
          }, 900);
          setTimeout(function () {
            btn.textContent = 'Create Playlist';
            btn.style.background = '';
            btn.disabled = false;
          }, 2500);
        } catch (err) {
          btn.textContent = 'Error: ' + err.message;
          btn.style.background = 'var(--ember)';
          setTimeout(function () {
            btn.textContent = 'Create Playlist';
            btn.style.background = '';
            btn.disabled = false;
          }, 3000);
        }
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  async function boot() {
    if (!window.walletAddress) {
      var prompt = document.getElementById('fav-wallet-prompt');
      if (prompt) prompt.style.display = '';
      // Re-check when wallet connects
      document.addEventListener('walletConnected', function () {
        if (prompt) prompt.style.display = 'none';
        boot();
      });
      return;
    }

    // Fetch catalog for richer item display
    var catalog = [];
    try {
      var r = await fetch('/api/catalog');
      if (r.ok) catalog = await r.json();
    } catch (_) {}
    window._favCatalogCache = catalog;

    renderAll(catalog);

    // Auto-open sections that have items
    Object.keys(F.FAV_TYPES).forEach(function (type) {
      if (F.countOf(type) > 0) {
        var body = document.getElementById('fbody-' + type);
        if (body) body.classList.add('open');
      }
    });
  }

  // Wait for wallet module to fire before booting, but also try immediately
  document.addEventListener('walletConnected', function (e) {
    boot();
  });
  // If wallet already connected (page reload with session)
  if (window.walletAddress) boot();

})();

