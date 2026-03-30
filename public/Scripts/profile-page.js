  (function () {

    // Scripts/profile-page.js
    // Page logic for profile.html only.
    // Depends on: common.js, favorites.js, main.js (all loaded before this file).

    'use strict';

    // Fee row observer (unchanged)
    var feeEl  = document.getElementById('royalty-fee-rate');
    var feeRow = document.getElementById('fee-row');
    if (feeEl && feeRow) {
      new MutationObserver(function () {
        feeRow.style.display = feeEl.textContent.trim() ? '' : 'none';
      }).observe(feeEl, { childList: true, characterData: true, subtree: true });
    }

    // ── Profile boot — runs after wallet connects ──────────────────────
    function bootProfile() {
      var F = window.MSPFavorites;

      // ── Favorites count chip ──────────────────────────────────────────
      var qlFavCount = document.getElementById('ql-fav-count');
      if (qlFavCount && F) {
        var total = F.totalCount();
        qlFavCount.textContent = total > 0
          ? total + ' item' + (total !== 1 ? 's' : '') + ' saved'
          : 'Manage your favorites lists';
      }

      // ── Show creator quick links ──────────────────────────────────────
      var qlAssets   = document.getElementById('ql-assets');
      var qlPlaylists = document.getElementById('ql-playlists');
      var recentSec  = document.getElementById('recent-uploads-section');

      // CAN.upload() is set by main.js capability gates
      if (typeof window.CAN !== 'undefined') {
        if (window.CAN.upload && window.CAN.upload()) {
          if (qlAssets)  qlAssets.style.display   = '';
          if (recentSec) recentSec.style.display  = '';
          loadRecentUploads();
        }
        if (window.CAN.createPlaylist && window.CAN.createPlaylist()) {
          if (qlPlaylists) qlPlaylists.style.display = '';
        }
      }
    }

    // ── Load recent uploads from /api/catalog filtered by wallet ────────
    async function loadRecentUploads() {
      var listEl = document.getElementById('recent-uploads-list');
      if (!listEl || !window.walletAddress) return;

      try {
        var r = await fetch('/api/catalog');
        if (!r.ok) throw new Error('catalog fetch failed');
        var all = await r.json();

        // Filter to this wallet's uploads
        var mine = all.filter(function (item) {
          return (item.wallet || '').toLowerCase() === window.walletAddress.toLowerCase();
        }).slice(0, 5); // show 5 most recent

        var assetCountEl = document.getElementById('ql-asset-count');
        if (assetCountEl) {
          var total = all.filter(function (item) {
            return (item.wallet || '').toLowerCase() === window.walletAddress.toLowerCase();
          }).length;
          assetCountEl.textContent = total + ' asset' + (total !== 1 ? 's' : '') + ' uploaded';
        }

        if (!mine.length) {
          listEl.innerHTML = '<p class="text-muted small mb-0">No uploads yet. ' +
            '<a href="creators.html" style="color:var(--teal);">Upload your first track →</a></p>';
          return;
        }

        listEl.innerHTML = mine.map(function (item) {
          var typeIcon = { music:'🎵', podcast:'🎙', video:'🎬', art_still:'🖼', art_animated:'🎨' };
          var icon = typeIcon[item.contentType] || '🎵';
          var cover = item.coverUrl
            ? '<img class="recent-asset-cover" src="' + item.coverUrl + '" alt="">'
            : '<div class="recent-asset-cover-ph">' + icon + '</div>';
          var royaltyBadge = item.supporterRoyaltyEnabled
            ? '<img src="assets/msp-vinyl.svg" width="12" height="12" style="vertical-align:middle;margin-left:4px;" title="Supporter royalties enabled">'
            : '';
          var plays = item.plays !== undefined ? item.plays : '—';
          return '<div class="recent-asset-row">' +
            cover +
            '<div class="recent-asset-info">' +
              '<div class="recent-asset-title">' + _esc(item.title) + royaltyBadge + '</div>' +
              '<div class="recent-asset-meta">' + _esc(item.artistName || '—') + ' · ' + (item.contentType || 'music').toUpperCase() + '</div>' +
            '</div>' +
            '<span class="recent-asset-plays" title="Plays"> ' + plays + '</span>' +
            '<button class="recent-asset-play" title="Preview"' +
              ' data-hlsurl="' + (item.hlsUrl || '') + '"' +
              ' data-title="' + _esc(item.title) + '"' +
              ' data-artist="' + _esc(item.artistName || '') + '"' +
              ' data-cover="' + (item.coverUrl || '') + '">▶</button>' +
            '<a href="asset-manager.html#' + item.contentId + '" class="btn btn-sm btn-link p-0" style="color:var(--text-muted);font-size:11px;">Edit</a>' +
          '</div>';
        }).join('');
        
        window.wirePlayButtons(listEl, '.recent-asset-play');

      } catch (err) {
        if (listEl) listEl.innerHTML = '<p class="text-muted small mb-0">Could not load uploads.</p>';
      }
    }

    function _esc(str) {
      return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Run after wallet connects (main.js fires walletConnected)
    function tryBoot() {
      // CAN is global (window.CAN), getAccess is NOT — check CAN directly
      if (typeof window.CAN === 'undefined' || typeof window.CAN.upload !== 'function') {
        setTimeout(tryBoot, 100);
        return;
      }
      bootProfile();
  }

    document.addEventListener('walletConnected', function () {
      setTimeout(tryBoot, 100);
    });
    if (window.walletAddress) setTimeout(tryBoot, 100);

  })();