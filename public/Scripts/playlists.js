// public/Scripts/playlists.js
'use strict';

(function () {
  var state = {
    profile: null,
    playlists: [],
    catalog: [],
    activePlaylistId: null,
    entitlementLabel: 'Checking playlist access…',
    deepLinkedAssetId: (new URLSearchParams(window.location.search).get('asset') || '').trim(),
    deepLinkNotified: false,
  };

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function relativeTime(ts) {
    if (!ts) return '—';
    var diff = Date.now() - ts;
    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(diff / 3600000);
    var days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (hours < 24) return hours + 'h ago';
    if (days < 30) return days + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function eth(n) {
    var value = Number(n || 0);
    return value.toFixed(4) + ' Ξ';
  }

  function showToast(message, isError) {
    var toast = document.getElementById('playlist-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.borderLeftColor = isError ? '#E85D3A' : '#00d4bb';
    toast.style.opacity = '1';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toast.style.opacity = '0';
    }, 2800);
  }

  async function api(url, options) {
    var res = await fetch(url, options || {});
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      throw new Error((data && data.error) || 'Request failed');
    }
    return data;
  }

  function canCreatePlaylist(profile) {
    if (!profile) return false;
    var active = profile.subscription_expiry && Date.now() < profile.subscription_expiry;
    if (!active) return false;
    if (profile.account_type === 'listener') return (profile.listener_tier || 0) >= 2;
    return profile.account_type === 'creator' || profile.account_type === 'platform_nft_creator';
  }

  function getPlayableCatalog() {
    return (state.catalog || []).filter(function (item) {
      if (!item || item.isPrivate) return false;
      if (item.hlsUrl || item.previewUrl || item.audioUrl || item.videoUrl || item.streamUrl) return true;
      return ['music', 'video', 'podcast', 'nft_music', 'nft_video', 'art_animated'].indexOf(item.contentType) !== -1;
    });
  }

  function selectedPlaylist() {
    return (state.playlists || []).find(function (pl) { return pl.id === state.activePlaylistId; }) || null;
  }

  function renderSummary() {
    var grid = document.getElementById('playlist-summary-grid');
    if (!grid) return;

    var totals = state.playlists.reduce(function (acc, playlist) {
      var analytics = (playlist.analyticsView && playlist.analyticsView.totals) || {};
      acc.playlists += 1;
      acc.items += (playlist.items || []).length;
      acc.collectedEth += Number(analytics.collectedEth || 0);
      acc.totalPlays += Number(analytics.totalPlays || 0);
      acc.eligibleAssets += (playlist.items || []).filter(function (item) { return item.supporterRoyaltyEnabled; }).length;
      return acc;
    }, { playlists: 0, items: 0, collectedEth: 0, totalPlays: 0, eligibleAssets: 0 });

    var cards = [
      { label: 'Playlists', value: totals.playlists, sub: totals.items + ' total curated assets' },
      { label: 'Collected royalties', value: eth(totals.collectedEth), sub: 'Curator share from eligible public playlist plays' },
      { label: 'Completed plays', value: totals.totalPlays, sub: 'Proof-backed playlist plays recorded' },
      { label: 'Eligible assets', value: totals.eligibleAssets, sub: 'Assets with supporter royalties enabled' }
    ];

    grid.innerHTML = cards.map(function (card) {
      return '<div class="summary-card">' +
        '<div class="summary-label">' + esc(card.label) + '</div>' +
        '<div class="summary-value">' + esc(String(card.value)) + '</div>' +
        '<div class="summary-sub">' + esc(card.sub) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderEntitlementChip() {
    var chip = document.getElementById('playlist-entitlement-chip');
    if (!chip) return;
    chip.textContent = state.entitlementLabel;
    chip.className = 'mini-badge ' + (canCreatePlaylist(state.profile) ? 'teal' : '');
  }

  function renderLibrary() {
    var list = document.getElementById('playlist-library-list');
    var targetChip = document.getElementById('playlist-active-target');
    if (!list || !targetChip) return;

    var target = selectedPlaylist();
    targetChip.textContent = target ? ('Adding into: ' + target.name) : 'Pick a playlist first';
    targetChip.className = 'mini-badge ' + (target ? 'teal' : '');

    var query = ((document.getElementById('playlist-library-search') || {}).value || '').trim().toLowerCase();
    var typeFilter = ((document.getElementById('playlist-library-type') || {}).value || 'all');
    var royaltyFilter = ((document.getElementById('playlist-library-royalty') || {}).value || 'all');

    var items = getPlayableCatalog().filter(function (item) {
      var matchesQuery = !query || [item.title, item.artistName, item.contentType, item.contentId].join(' ').toLowerCase().indexOf(query) !== -1;
      var matchesType = typeFilter === 'all' || item.contentType === typeFilter;
      var matchesRoyalty = royaltyFilter === 'all' || (royaltyFilter === 'eligible' ? item.supporterRoyaltyEnabled : !item.supporterRoyaltyEnabled);
      return matchesQuery && matchesType && matchesRoyalty;
    }).slice(0, 40);

    if (!items.length) {
      list.innerHTML = '<div class="empty-state">No playable assets matched this filter.</div>';
      return;
    }

    list.innerHTML = items.map(function (item) {
      var isOwnAsset = (String(item.wallet || '').toLowerCase() === String(window.walletAddress || '').toLowerCase());
      var isAlreadyInTarget = target && (target.items || []).some(function (row) { return row.contentId === item.contentId; });
      var disabled = !target || isOwnAsset || isAlreadyInTarget;
      var cover = item.coverUrl
        ? '<img class="library-cover" src="' + esc(item.coverUrl) + '" alt="">'
        : '<div class="library-cover">🎵</div>';
      var buttonLabel = !target ? 'Select a playlist' : isOwnAsset ? 'Own asset blocked' : isAlreadyInTarget ? 'Already added' : 'Add to playlist';
      return '<div class="library-card">' +
        cover +
        '<div>' +
          '<div class="playlist-item-title">' + esc(item.title || 'Untitled asset') + '</div>' +
          '<div class="playlist-item-sub">' + esc(item.artistName || 'Unknown creator') + ' · ' + esc(item.contentType || 'music') + '</div>' +
          '<div class="d-flex flex-wrap gap-2 mt-2">' +
            '<span class="mini-badge ' + (item.supporterRoyaltyEnabled ? 'gold' : '') + '">' + (item.supporterRoyaltyEnabled ? '★ Supporter royalties enabled' : 'No supporter royalty fee') + '</span>' +
            '<span class="mini-badge">' + (item.isPrivate ? 'Private' : 'Public') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="d-flex flex-column gap-2 align-items-end">' +
          '<button class="btn btn-sm btn-' + (disabled ? 'outline-secondary' : 'primary') + '" data-action="add-library-asset" data-content-id="' + esc(item.contentId) + '" ' + (disabled ? 'disabled' : '') + '>' + esc(buttonLabel) + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderTopAssets(playlist) {
    var topAssets = ((playlist.analyticsView || {}).topAssets || []).slice(0, 3);
    if (!topAssets.length) {
      return '<div class="empty-state">No royalty-driving assets yet. Plays will appear here after proof-backed listens are recorded.</div>';
    }

    var max = topAssets.reduce(function (m, row) { return Math.max(m, Number(row.revenueEth || 0), 0.0001); }, 0.0001);
    return '<div class="top-assets-list">' + topAssets.map(function (row) {
      var width = Math.max(8, (Number(row.revenueEth || 0) / max) * 100);
      return '<div class="top-asset-row">' +
        '<div>' +
          '<div class="playlist-item-title">' + esc(row.title || 'Untitled asset') + '</div>' +
          '<div class="bar-track mt-2"><div class="bar-fill" style="width:' + width.toFixed(1) + '%"></div></div>' +
        '</div>' +
        '<div class="playlist-item-sub">' + Number(row.plays || 0) + ' plays</div>' +
        '<div class="playlist-item-title">' + eth(row.revenueEth || 0) + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderPlaylistItemsTable(playlist) {
    var items = playlist.items || [];
    if (!items.length) {
      return '<div class="empty-state">This playlist is empty. Select this playlist, then add playable assets from the library panel.</div>';
    }

    return '<div class="table-responsive">' +
      '<table class="playlist-items-table">' +
        '<thead><tr><th>Asset</th><th>Royalty</th><th>Revenue</th><th>Actions</th></tr></thead>' +
        '<tbody>' + items.map(function (item, index) {
          var revenueRow = (((playlist.analyticsView || {}).assets || []).find(function (row) { return row.contentId === item.contentId; }) || {});
          return '<tr>' +
            '<td>' +
              '<div class="playlist-item-title">' + esc(item.title || 'Untitled asset') + '</div>' +
              '<div class="playlist-item-sub">' + esc(item.artistName || 'Unknown creator') + ' · ' + esc(item.contentType || 'music') + '</div>' +
            '</td>' +
            '<td>' +
              '<span class="mini-badge ' + (item.supporterRoyaltyEnabled ? 'gold' : '') + '">' + (item.supporterRoyaltyEnabled ? 'Eligible' : 'Ineligible') + '</span>' +
            '</td>' +
            '<td>' +
              '<div class="playlist-item-title">' + eth(revenueRow.revenueEth || 0) + '</div>' +
              '<div class="playlist-item-sub">' + Number(revenueRow.plays || 0) + ' plays</div>' +
            '</td>' +
            '<td>' +
              '<div class="d-flex gap-2 flex-wrap">' +
                '<button class="btn btn-sm btn-outline-secondary" data-action="move-item" data-direction="up" data-playlist-id="' + esc(playlist.id) + '" data-content-id="' + esc(item.contentId) + '" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
                '<button class="btn btn-sm btn-outline-secondary" data-action="move-item" data-direction="down" data-playlist-id="' + esc(playlist.id) + '" data-content-id="' + esc(item.contentId) + '" ' + (index === items.length - 1 ? 'disabled' : '') + '>↓</button>' +
                '<button class="btn btn-sm btn-outline-danger" data-action="remove-item" data-playlist-id="' + esc(playlist.id) + '" data-content-id="' + esc(item.contentId) + '">Remove</button>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('') + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderPlaylists() {
    var container = document.getElementById('playlist-cards');
    if (!container) return;

    if (!state.playlists.length) {
      container.innerHTML = '<div class="empty-state">No playlists yet. Create a playlist here, or convert an eligible public favorites list into one and it will appear here automatically.</div>';
      return;
    }

    container.innerHTML = state.playlists.map(function (playlist) {
      var analytics = (playlist.analyticsView || {}).totals || {};
      var itemCount = (playlist.items || []).length;
      var active = playlist.id === state.activePlaylistId;
      return '<div class="playlist-card ' + (active ? 'active-playlist' : '') + '">' +
        '<div class="playlist-card-head">' +
          '<div class="flex-grow-1">' +
            '<input class="playlist-name-input" data-field="name" data-playlist-id="' + esc(playlist.id) + '" value="' + esc(playlist.name || '') + '" maxlength="80">' +
            '<textarea class="playlist-textarea mt-2" data-field="description" data-playlist-id="' + esc(playlist.id) + '" placeholder="Playlist description">' + esc(playlist.description || '') + '</textarea>' +
          '</div>' +
          '<div class="d-flex flex-column gap-2 align-items-end">' +
            '<span class="mini-badge ' + (playlist.isPublic ? 'teal' : '') + '">' + (playlist.isPublic ? '🌐 Public' : '🔒 Private') + '</span>' +
            '<button class="btn btn-sm ' + (active ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="set-active" data-playlist-id="' + esc(playlist.id) + '">' + (active ? 'Adding here' : 'Add assets') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="playlist-card-body">' +
          '<div class="playlist-controls">' +
            '<select class="playlist-filter-select" data-field="visibility" data-playlist-id="' + esc(playlist.id) + '">' +
              '<option value="public" ' + (playlist.isPublic ? 'selected' : '') + '>Public</option>' +
              '<option value="private" ' + (!playlist.isPublic ? 'selected' : '') + '>Private</option>' +
            '</select>' +
            '<input class="playlist-share-input" data-field="sharePercent" data-playlist-id="' + esc(playlist.id) + '" type="number" min="0" max="100" step="0.1" value="' + esc(String(playlist.sharePercent == null ? 8 : playlist.sharePercent)) + '">' +
            '<div class="d-flex gap-2">' +
              '<button class="btn btn-sm btn-outline-secondary flex-fill" data-action="save-playlist" data-playlist-id="' + esc(playlist.id) + '">Save</button>' +
              '<button class="btn btn-sm btn-outline-danger flex-fill" data-action="delete-playlist" data-playlist-id="' + esc(playlist.id) + '">Delete</button>' +
            '</div>' +
          '</div>' +

          '<div class="playlist-stat-row">' +
            '<div class="playlist-stat"><div class="label">Collected</div><div class="value">' + eth(analytics.collectedEth || 0) + '</div></div>' +
            '<div class="playlist-stat"><div class="label">Assets</div><div class="value">' + itemCount + '</div></div>' +
            '<div class="playlist-stat"><div class="label">Completed plays</div><div class="value">' + Number(analytics.totalPlays || 0) + '</div></div>' +
            '<div class="playlist-stat"><div class="label">Updated</div><div class="value">' + esc(relativeTime(playlist.updatedAt)) + '</div></div>' +
          '</div>' +

          '<div class="mb-3">' +
            '<div class="d-flex justify-content-between align-items-center mb-2"><strong>Top revenue assets</strong><span class="playlist-item-sub">Eligible assets only collect royalties</span></div>' +
            renderTopAssets(playlist) +
          '</div>' +

          '<div class="d-flex justify-content-between align-items-center mb-2"><strong>Playlist assets</strong><span class="playlist-item-sub">Public playlists collect only from supporter-enabled playable assets.</span></div>' +
          renderPlaylistItemsTable(playlist) +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function refreshData(options) {
    options = options || {};
    var wallet = window.walletAddress;
    if (!wallet) return;

    var results = await Promise.all([
      api('/api/profile/' + wallet),
      api('/api/playlists/mine/' + wallet),
      api('/api/catalog')
    ]);

    state.profile = results[0];
    state.playlists = (results[1] && results[1].playlists) || [];
    state.catalog = results[2] || [];

    if (state.deepLinkedAssetId) {
      var searchEl = document.getElementById('playlist-library-search');
      if (searchEl && !searchEl.value) searchEl.value = state.deepLinkedAssetId;
      if (!state.deepLinkNotified) {
        showToast('Playlist manager opened from Asset Manager. Library filtered to the selected asset.');
        state.deepLinkNotified = true;
      }
    }

    if (!state.activePlaylistId && state.playlists.length) {
      state.activePlaylistId = state.playlists[0].id;
    }
    if (state.activePlaylistId && !state.playlists.some(function (pl) { return pl.id === state.activePlaylistId; })) {
      state.activePlaylistId = state.playlists.length ? state.playlists[0].id : null;
    }

    state.entitlementLabel = canCreatePlaylist(state.profile)
      ? 'Playlist management enabled'
      : 'Tier 2+ or active creator plan required';

    renderEntitlementChip();
    renderSummary();
    renderLibrary();
    renderPlaylists();

    if (!options.silent) showToast('Playlist data refreshed');
  }

  async function createPlaylist(event) {
    event.preventDefault();
    if (!canCreatePlaylist(state.profile)) {
      showToast('Tier 2+ or active creator access is required to create playlists.', true);
      return;
    }

    var payload = {
      wallet: window.walletAddress,
      name: (document.getElementById('playlist-create-name') || {}).value || '',
      description: (document.getElementById('playlist-create-description') || {}).value || '',
      isPublic: ((document.getElementById('playlist-create-visibility') || {}).value || 'public') === 'public',
      sharePercent: Number((document.getElementById('playlist-create-share') || {}).value || 8),
      contentIds: []
    };

    if (!payload.name.trim()) {
      showToast('Give the playlist a name first.', true);
      return;
    }

    await api('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    (document.getElementById('playlist-create-form') || {}).reset && document.getElementById('playlist-create-form').reset();
    document.getElementById('playlist-create-visibility').value = 'public';
    document.getElementById('playlist-create-share').value = '8';
    await refreshData({ silent: true });
    showToast('Playlist created. Select it and add assets from the library.');
  }

  async function addLibraryAsset(contentId) {
    var playlist = selectedPlaylist();
    if (!playlist) {
      showToast('Select a playlist first.', true);
      return;
    }
    await api('/api/playlists/' + playlist.id + '/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: window.walletAddress, contentId: contentId })
    });
    await refreshData({ silent: true });
    showToast('Asset added to playlist.');
  }

  async function removePlaylistItem(playlistId, contentId) {
    await api('/api/playlists/' + playlistId + '/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: window.walletAddress, contentId: contentId })
    });
    await refreshData({ silent: true });
    showToast('Asset removed from playlist.');
  }

  async function movePlaylistItem(playlistId, contentId, direction) {
    var playlist = (state.playlists || []).find(function (pl) { return pl.id === playlistId; });
    if (!playlist) return;

    var ids = (playlist.items || []).map(function (item) { return item.contentId; });
    var index = ids.indexOf(contentId);
    if (index === -1) return;
    var swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= ids.length) return;

    var tmp = ids[index];
    ids[index] = ids[swapIndex];
    ids[swapIndex] = tmp;

    await api('/api/playlists/' + playlistId + '/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: window.walletAddress, orderedContentIds: ids })
    });

    await refreshData({ silent: true });
    showToast('Playlist order updated.');
  }

  async function savePlaylist(playlistId) {
    var root = document.querySelector('.playlist-card [data-playlist-id="' + playlistId + '"]');
    var nameEl = document.querySelector('[data-field="name"][data-playlist-id="' + playlistId + '"]');
    var descEl = document.querySelector('[data-field="description"][data-playlist-id="' + playlistId + '"]');
    var visEl = document.querySelector('[data-field="visibility"][data-playlist-id="' + playlistId + '"]');
    var shareEl = document.querySelector('[data-field="sharePercent"][data-playlist-id="' + playlistId + '"]');
    void root;

    await api('/api/playlists/' + playlistId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: window.walletAddress,
        name: nameEl ? nameEl.value : '',
        description: descEl ? descEl.value : '',
        isPublic: visEl ? visEl.value === 'public' : true,
        sharePercent: shareEl ? Number(shareEl.value || 8) : 8
      })
    });

    await refreshData({ silent: true });
    showToast('Playlist settings saved.');
  }

  async function deletePlaylist(playlistId) {
    if (!window.confirm('Delete this playlist? This will remove its stored analytics and item order.')) return;
    await api('/api/playlists/' + playlistId + '?wallet=' + encodeURIComponent(window.walletAddress), {
      method: 'DELETE'
    });
    if (state.activePlaylistId === playlistId) state.activePlaylistId = null;
    await refreshData({ silent: true });
    showToast('Playlist deleted.');
  }

  function wireEvents() {
    var createForm = document.getElementById('playlist-create-form');
    if (createForm) createForm.addEventListener('submit', createPlaylist);

    ['playlist-library-search', 'playlist-library-type', 'playlist-library-royalty'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', renderLibrary);
      el.addEventListener('change', renderLibrary);
    });

    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;

      var action = button.getAttribute('data-action');
      var playlistId = button.getAttribute('data-playlist-id');
      var contentId = button.getAttribute('data-content-id');

      if (action === 'set-active') {
        state.activePlaylistId = playlistId;
        renderLibrary();
        renderPlaylists();
        showToast('Library is now targeting this playlist.');
        return;
      }
      if (action === 'add-library-asset') {
        addLibraryAsset(contentId).catch(function (err) { showToast(err.message || 'Could not add asset.', true); });
        return;
      }
      if (action === 'remove-item') {
        removePlaylistItem(playlistId, contentId).catch(function (err) { showToast(err.message || 'Could not remove asset.', true); });
        return;
      }
      if (action === 'move-item') {
        movePlaylistItem(playlistId, contentId, button.getAttribute('data-direction')).catch(function (err) { showToast(err.message || 'Could not reorder asset.', true); });
        return;
      }
      if (action === 'save-playlist') {
        savePlaylist(playlistId).catch(function (err) { showToast(err.message || 'Could not save playlist.', true); });
        return;
      }
      if (action === 'delete-playlist') {
        deletePlaylist(playlistId).catch(function (err) { showToast(err.message || 'Could not delete playlist.', true); });
      }
    });
  }

  async function boot() {
    if (!window.walletAddress) {
      var prompt = document.getElementById('playlist-wallet-prompt');
      if (prompt) prompt.style.display = '';
      document.addEventListener('walletConnected', function onConnect() {
        document.removeEventListener('walletConnected', onConnect);
        if (prompt) prompt.style.display = 'none';
        boot();
      });
      return;
    }

    var promptEl = document.getElementById('playlist-wallet-prompt');
    var appEl = document.getElementById('playlist-app');
    if (promptEl) promptEl.style.display = 'none';
    if (appEl) appEl.style.display = '';

    try {
      await refreshData({ silent: true });
    } catch (err) {
      showToast(err.message || 'Could not load playlist page.', true);
    }
  }

  wireEvents();
  document.addEventListener('walletConnected', function () {
    setTimeout(boot, 250);
  });
  if (window.walletAddress) setTimeout(boot, 250);
})();
