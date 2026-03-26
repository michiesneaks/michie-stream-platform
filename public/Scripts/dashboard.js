// Scripts/dashboard.js
// Dashboard page logic for dashboard.html.
// Depends on: common.js, favorites.js, main.js (all loaded before this).
'use strict';

(function () {

  var F = window.MSPFavorites;

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function relativeTime(ts) {
    if (!ts) return '';
    var diff  = Date.now() - ts;
    var mins  = Math.floor(diff / 60000);
    var hours = Math.floor(diff / 3600000);
    var days  = Math.floor(diff / 86400000);
    if (mins  < 1)   return 'just now';
    if (mins  < 60)  return mins + 'm ago';
    if (hours < 24)  return hours + 'h ago';
    if (days  < 30)  return days + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER STAT CARDS
  // ════════════════════════════════════════════════════════════════════════════
  function renderStats(profile, myAssets) {
    var statsEl = document.getElementById('dash-stats');
    if (!statsEl) return;

    var totalPlays    = myAssets.reduce(function (s, a) { return s + (a.plays || 0); }, 0);
    var totalEarned   = myAssets.reduce(function (s, a) { return s + (parseFloat(a.royaltiesEarned) || 0); }, 0);
    var srEnabled     = myAssets.filter(function (a) { return a.supporterRoyaltyEnabled; }).length;
    var favTotal      = F ? F.totalCount() : 0;
    var isCreator     = profile && ['creator', 'platform_nft_creator'].includes(profile.account_type);
    var tier          = profile ? (profile.listener_tier || null) : null;
    var subActive     = profile && profile.subscription_expiry && Date.now() < profile.subscription_expiry;

    var cards = [
      {
        label: 'Subscription',
        value: subActive
          ? (isCreator ? 'Creator' : 'Tier ' + (tier || '—'))
          : 'None',
        colorClass: subActive ? 'teal' : '',
        sub: subActive
          ? 'Active · expires ' + new Date(profile.subscription_expiry).toLocaleDateString()
          : 'No active subscription',
        link: 'listen.html#subscribe',
        linkLabel: 'Subscribe →',
        always: true,
      },
      {
        label: 'Favorites Saved',
        value: favTotal,
        colorClass: favTotal > 0 ? 'ember' : '',
        sub: favTotal > 0 ? F.summary().map(function (s) { return s.meta.icon + ' ' + s.count; }).join('  ') : 'Nothing saved yet',
        link: 'favorites.html',
        linkLabel: 'Manage →',
        always: true,
      },
    ];

    if (isCreator) {
      cards.push(
        {
          label: 'Total Plays',
          value: totalPlays.toLocaleString(),
          colorClass: 'teal',
          sub: myAssets.length + ' asset' + (myAssets.length !== 1 ? 's' : '') + ' uploaded',
          link: 'asset-manager.html',
          linkLabel: 'View Assets →',
          always: false,
        },
        {
          label: 'ETH Royalties Earned',
          value: totalEarned.toFixed(4),
          colorClass: 'gold',
          sub: srEnabled + ' asset' + (srEnabled !== 1 ? 's' : '') + ' with supporter royalties',
          link: 'asset-manager.html',
          linkLabel: 'Manage Royalties →',
          always: false,
        }
      );
    }

    statsEl.innerHTML = cards.map(function (c) {
      return '<div class="stat-card">' +
        '<div class="stat-card-label">' + esc(c.label) + '</div>' +
        '<div class="stat-card-value ' + c.colorClass + '">' + esc(String(c.value)) + '</div>' +
        '<div class="stat-card-sub">' + esc(c.sub) + '</div>' +
        (c.link ? '<a href="' + esc(c.link) + '" class="stat-card-link">' + esc(c.linkLabel) + '</a>' : '') +
      '</div>';
    }).join('');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER EARNINGS PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function renderEarnings(myAssets) {
    var bodyEl = document.getElementById('dash-earnings-body');
    if (!bodyEl) return;

    // Show manage button only for creators
    var manageBtn = document.querySelector('#dash-earnings-panel [data-requires="upload"]');
    if (manageBtn) manageBtn.style.display = '';

    var earners = myAssets
      .filter(function (a) { return (parseFloat(a.royaltiesEarned) || 0) > 0 || a.supporterRoyaltyEnabled; })
      .sort(function (a, b) { return (parseFloat(b.royaltiesEarned) || 0) - (parseFloat(a.royaltiesEarned) || 0); })
      .slice(0, 8);

    if (!earners.length) {
      bodyEl.innerHTML = '<p class="text-muted small py-3">No royalties earned yet. Enable supporter royalties on your assets to start earning.</p>';
      return;
    }

    var maxEarned = earners.reduce(function (m, a) { return Math.max(m, parseFloat(a.royaltiesEarned) || 0); }, 0.0001);

    bodyEl.innerHTML = '<div style="padding-top:10px;">' +
      earners.map(function (a) {
        var earned  = parseFloat(a.royaltiesEarned) || 0;
        var pct     = Math.max(4, (earned / maxEarned) * 100);
        var vinyl   = a.supporterRoyaltyEnabled
          ? '<img src="assets/msp-vinyl.svg" width="11" height="11" style="vertical-align:middle;margin-left:3px;" alt="★">'
          : '';
        return '<div class="earnings-bar-wrap">' +
          '<span class="earnings-bar-label">' + esc((a.title || 'Untitled').slice(0, 14)) + vinyl + '</span>' +
          '<div class="earnings-bar-track"><div class="earnings-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<span class="earnings-bar-val">' + earned.toFixed(4) + ' Ξ</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER FAVORITES SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  function renderFavSummary() {
    var bodyEl = document.getElementById('dash-fav-body');
    if (!bodyEl || !F) return;

    var summary = F.summary();
    if (!summary.length) {
      bodyEl.innerHTML = '<p class="text-muted small py-3">No favorites yet. Browse <a href="listen.html" style="color:var(--teal)">music</a> and tap ♥ to save.</p>';
      return;
    }

    bodyEl.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:12px;">' +
      summary.map(function (s) {
        return '<a href="favorites.html" style="' +
          'align-items:center;background:rgba(0,0,0,.3);border:1px solid ' + s.meta.cssColor + ';' +
          'border-radius:16px;color:' + s.meta.cssColor + ';display:inline-flex;' +
          'font-size:11px;font-weight:600;gap:5px;padding:4px 12px;text-decoration:none;">' +
          s.meta.icon + ' ' + s.meta.label + ' <strong>' + s.count + '</strong>' +
        '</a>';
      }).join('') +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER PLAYLISTS
  // ════════════════════════════════════════════════════════════════════════════
  function renderPlaylists(profile) {
    var panel  = document.getElementById('dash-playlists-panel');
    var bodyEl = document.getElementById('dash-playlists-body');
    if (!panel || !bodyEl) return;

    var playlists = profile ? (profile.playlists || []) : [];
    if (!playlists.length) {
      panel.style.display = '';
      bodyEl.innerHTML = '<p class="text-muted small py-3">No playlists yet. <a href="favorites.html" style="color:var(--teal)">Create one from your favorites →</a></p>';
      return;
    }

    panel.style.display = '';
    bodyEl.innerHTML = playlists.slice(0, 6).map(function (pl) {
      var isPublic = pl.isPublic !== false;
      return '<div class="pl-row">' +
        '<div>' +
          '<div class="pl-name">' + esc(pl.name || 'Untitled Playlist') + '</div>' +
          '<div class="pl-meta">' + (pl.cids ? pl.cids.length : 0) + ' tracks · created ' + relativeTime(pl.createdAt) + '</div>' +
        '</div>' +
        '<span class="pl-badge ' + (isPublic ? 'pub' : 'priv') + '">' + (isPublic ? '🌐 Public' : '🔒 Private') + '</span>' +
      '</div>';
    }).join('');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER RECENT UPLOADS
  // ════════════════════════════════════════════════════════════════════════════
  function renderUploads(myAssets) {
    var panel  = document.getElementById('dash-uploads-panel');
    var bodyEl = document.getElementById('dash-uploads-body');
    if (!panel || !bodyEl) return;

    panel.style.display = '';

    if (!myAssets.length) {
      bodyEl.innerHTML = '<p class="text-muted small py-3">No uploads yet. <a href="creators.html" style="color:var(--teal)">Upload your first track →</a></p>';
      return;
    }

    var typeIcon = { music: '🎵', podcast: '🎙', video: '🎬', art_still: '🖼', art_animated: '🎨' };

    bodyEl.innerHTML = myAssets.slice(0, 5).map(function (item) {
      var icon    = typeIcon[item.contentType] || '🎵';
      var cover   = item.coverUrl
        ? '<img style="border-radius:4px;flex-shrink:0;height:36px;object-fit:cover;width:36px;" src="' + esc(item.coverUrl) + '" alt="">'
        : '<div style="align-items:center;background:var(--bg-raised);border-radius:4px;color:var(--text-muted);display:flex;flex-shrink:0;font-size:14px;height:36px;justify-content:center;width:36px;">' + icon + '</div>';
      var vinyl   = item.supporterRoyaltyEnabled
        ? '<img src="assets/msp-vinyl.svg" width="11" height="11" style="vertical-align:middle;margin-left:3px;" alt="★">'
        : '';
      return '<div style="align-items:center;border-bottom:1px solid var(--border-subtle);display:flex;gap:10px;padding:8px 0;">' +
        cover +
        '<div style="flex:1;min-width:0;">' +
          '<div style="color:var(--text-primary);font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            esc(item.title || 'Untitled') + vinyl +
          '</div>' +
          '<div style="color:var(--text-secondary);font-size:10px;">' +
            esc(item.artistName || '—') + ' · ' + (item.contentType || 'music').toUpperCase() +
            ' · ' + (item.plays || 0) + ' plays' +
          '</div>' +
        '</div>' +
        '<a href="asset-manager.html#' + esc(item.contentId) + '" style="color:var(--text-muted);font-size:11px;text-decoration:none;">Edit</a>' +
      '</div>';
    }).join('');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RENDER SUBSCRIPTION PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function renderSubscription(profile) {
    var bodyEl = document.getElementById('dash-sub-body');
    if (!bodyEl) return;

    if (!profile) {
      bodyEl.innerHTML = '<p class="text-muted small">No profile found.</p>';
      return;
    }

    var subActive = profile.subscription_expiry && Date.now() < profile.subscription_expiry;
    var typeLabel = {
      listener:            'Listener Tier ' + (profile.listener_tier || 1),
      creator:             'Creator',
      platform_nft_creator:'Creator (Platform NFT)',
      admin:               'Admin',
    };
    var label = typeLabel[profile.account_type] || profile.account_type || 'Unknown';
    var color = subActive ? 'var(--teal)' : 'var(--text-muted)';

    bodyEl.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;">' +
        '<div>' +
          '<div style="color:' + color + ';font-size:15px;font-weight:700;">' + esc(label) + '</div>' +
          '<div class="text-muted small">' +
            (subActive
              ? 'Active · expires ' + new Date(profile.subscription_expiry).toLocaleDateString()
              : 'No active subscription') +
          '</div>' +
        '</div>' +
        '<a href="listen.html#subscribe" class="btn btn-sm btn-outline-primary ms-auto">Manage Plan →</a>' +
      '</div>';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SUPPORTER ROYALTY DISABLE NOTIFICATIONS
  //  Show a notice for any asset where the 30-day cooldown is active
  //  (meaning supporter royalties were recently disabled).
  // ════════════════════════════════════════════════════════════════════════════
  function renderNotices(myAssets) {
    var noticesEl = document.getElementById('dash-notices');
    if (!noticesEl || !window.walletAddress) return;

    var notices = [];
    myAssets.forEach(function (item) {
      var lockKey = 'am_sr_lock:' + window.walletAddress.toLowerCase() + ':' + item.contentId;
      var lockUntil = parseInt(localStorage.getItem(lockKey) || '0', 10);
      if (lockUntil > Date.now()) {
        var daysLeft = Math.ceil((lockUntil - Date.now()) / (24 * 60 * 60 * 1000));
        notices.push(
          '<div class="dash-notice">' +
            '<span class="dash-notice-icon">⚠</span>' +
            '<div class="dash-notice-text">' +
              '<strong>' + esc(item.title || 'Untitled') + '</strong> — ' +
              'Supporter royalties disabled. Supporters have been notified. ' +
              'You can re-enable in <strong>' + daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + '</strong>. ' +
              '<a href="asset-manager.html#' + esc(item.contentId) + '" style="color:var(--teal);">Manage asset →</a>' +
            '</div>' +
            '<button class="dash-notice-dismiss" onclick="this.closest(\'.dash-notice\').remove()" title="Dismiss">✕</button>' +
          '</div>'
        );
      }
    });

    noticesEl.innerHTML = notices.join('');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════════════════
  async function boot() {
    if (!window.walletAddress) {
      var prompt = document.getElementById('dash-wallet-prompt');
      if (prompt) prompt.style.display = '';
      document.addEventListener('walletConnected', function () {
        if (prompt) prompt.style.display = 'none';
        boot();
      });
      return;
    }

    var main = document.getElementById('dash-main');
    if (main) main.style.display = '';

    // Fetch profile and catalog in parallel
    var profileData = null;
    var catalogData = [];

    try {
      var results = await Promise.all([
        fetch('/api/profile/' + window.walletAddress).then(function (r) { return r.ok ? r.json() : null; }),
        fetch('/api/catalog').then(function (r) { return r.ok ? r.json() : []; }),
      ]);
      profileData = results[0];
      catalogData = results[1];
    } catch (_) {}

    // Filter catalog to this wallet's assets
    var myAssets = catalogData.filter(function (item) {
      return (item.wallet || '').toLowerCase() === window.walletAddress.toLowerCase();
    });

    var isCreator = profileData && ['creator', 'platform_nft_creator'].includes(profileData.account_type);

    // Page subtitle
    var subtitle = document.getElementById('dash-subtitle');
    if (subtitle) {
      subtitle.textContent = profileData
        ? (profileData.name || 'Welcome') + ' · ' + (isCreator ? 'Creator' : 'Listener')
        : window.walletAddress.slice(0, 10) + '…';
    }

    // Creator-only panels
    if (isCreator) {
      var uploadsPanel = document.getElementById('dash-uploads-panel');
      var earningsCol  = document.getElementById('dash-earnings-col');
      var manageBtn    = document.querySelector('#dash-earnings-panel [data-requires="upload"]');
      if (uploadsPanel) uploadsPanel.style.removeProperty('display');
      if (earningsCol)  earningsCol.style.removeProperty('display');
      if (manageBtn)    manageBtn.style.display = '';
    }

    // Render all panels
    renderStats(profileData, myAssets);
    renderEarnings(myAssets);
    renderFavSummary();
    renderPlaylists(profileData);
    if (isCreator) renderUploads(myAssets);
    renderSubscription(profileData);
    renderNotices(myAssets);
  }

  // Wait for main.js capability gates before booting
  document.addEventListener('walletConnected', function () {
    setTimeout(boot, 300);
  });
  if (window.walletAddress) setTimeout(boot, 300);

})(); // end dashboard.js IIFE
