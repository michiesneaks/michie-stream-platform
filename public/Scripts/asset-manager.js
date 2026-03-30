// Scripts/asset-manager.js
// Asset management page logic for asset-manager.html.
// Depends on: common.js, favorites.js, main.js (all loaded before this file).
(function () {
  'use strict';

  var allAssets    = [];
  var currentTab   = 'all';
  var openSplits   = null;
  var playlistAssetAnalytics = {
    totals: { placementCount:0, publicPlacementCount:0, playlistPlays:0, eligiblePlaylistPlays:0, ineligiblePlaylistPlays:0, curatorPayoutGeneratedEth:0 },
    assets: {},
    topAssets: [],
  };

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  var toastTimer;
  function toast(msg, warn) {
    var el = document.getElementById('am-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'show' + (warn ? ' warn' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 3500);
  }

  // ── 30-day cooldown (localStorage) ────────────────────────────────────────
  function lockKey(cid) { return 'am_sr_lock:' + (window.walletAddress||'anon').toLowerCase() + ':' + cid; }
  function getLock(cid) { var v = localStorage.getItem(lockKey(cid)); return v ? parseInt(v,10) : 0; }
  function setLock(cid) { localStorage.setItem(lockKey(cid), String(Date.now() + 30*24*60*60*1000)); }
  function isLocked(cid) { return getLock(cid) > Date.now(); }
  function daysLeft(cid) { return Math.ceil((getLock(cid) - Date.now()) / (24*60*60*1000)); }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function ethFmt(v) { return (parseFloat(v)||0).toFixed(4) + ' ETH'; }

  function formatDurationString(totalSeconds) {
    if (!totalSeconds) return '0s';
    if (totalSeconds < 60) return totalSeconds + 's';
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    if (minutes < 60) return minutes + 'm ' + seconds + 's';
    var hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    return hours + 'h ' + minutes + 'm';
  }

  // ── Tab wiring ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.am-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.am-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentTab = btn.dataset.amTab;
      renderList();
    });
  });

  function filtered() {
    if (currentTab === 'all') return allAssets;
    if (currentTab === 'art') return allAssets.filter(function (a) { return a.contentType==='art_still'||a.contentType==='art_animated'; });
    return allAssets.filter(function (a) { return (a.contentType||'music') === currentTab; });
  }

  // ── Playlist metrics helpers ──────────────────────────────────────────────
  function getPlaylistMetrics(item) {
    return (playlistAssetAnalytics.assets && playlistAssetAnalytics.assets[item.contentId]) || {
      placementCount: 0,
      publicPlacementCount: 0,
      playlistPlays: 0,
      eligiblePlaylistPlays: 0,
      ineligiblePlaylistPlays: 0,
      curatorPayoutGeneratedEth: 0,
      topPlaylist: null,
    };
  }

  function renderPlaylistAnalyticsPanel() {
    var panel = document.getElementById('am-playlist-panel');
    var kpis  = document.getElementById('am-playlist-kpis');
    var top   = document.getElementById('am-top-assets');
    if (!panel || !kpis || !top) return;

    var totals = playlistAssetAnalytics.totals || {};
    if (!(totals.placementCount || totals.playlistPlays || totals.curatorPayoutGeneratedEth)) {
      panel.style.display = '';
      kpis.innerHTML = '<div class="am-playlist-kpi"><div class="label">No playlist activity yet</div><div class="value">0</div></div>';
      top.innerHTML = '<div class="am-empty" style="padding:18px 0 0;">Once your assets appear in playlists, their playlist plays and generated curator payouts will show up here.</div>';
      return;
    }

    panel.style.display = '';
    kpis.innerHTML = [
      { label: 'Placements',                value: totals.placementCount || 0 },
      { label: 'Public placements',          value: totals.publicPlacementCount || 0 },
      { label: 'Playlist plays',             value: totals.playlistPlays || 0 },
      { label: 'Curator payouts generated',  value: ethFmt(totals.curatorPayoutGeneratedEth || 0) },
    ].map(function (card) {
      return '<div class="am-playlist-kpi"><div class="label">' + esc(card.label) + '</div><div class="value">' + esc(String(card.value)) + '</div></div>';
    }).join('');

    var rows = (playlistAssetAnalytics.topAssets || []).slice(0, 5);
    if (!rows.length) { top.innerHTML = ''; return; }

    top.innerHTML =
      '<div class="d-flex justify-content-between align-items-center mb-2">' +
        '<strong>Top playlist-driving assets</strong>' +
        '<span class="text-muted" style="font-size:11px;">Ranked by curator payouts generated, then playlist plays.</span>' +
      '</div>' +
      '<div class="am-top-assets">' + rows.map(function (row) {
        var topPlaylist = row.topPlaylist ? ('Top playlist: ' + row.topPlaylist.name) : 'No top playlist yet';
        return '<div class="am-top-asset">' +
          '<div><div class="title">' + esc(row.title||'Untitled') + '</div><div class="sub">' + esc(topPlaylist) + '</div></div>' +
          '<div class="sub">' + Number(row.playlistPlays||0) + ' playlist plays</div>' +
          '<div class="title">' + ethFmt(row.curatorPayoutGeneratedEth||0) + '</div>' +
        '</div>';
      }).join('') + '</div>';
  }

  // ── Telemetry batch loader ────────────────────────────────────────────────
  async function loadTelemetryForItems(items) {
    if (!items.length) return;
    var cids = items.map(function (i) { return i.contentId; }).join(',');
    try {
      var r   = await fetch('/api/analytics/assets/batch?cids=' + cids);
      var map = r.ok ? await r.json() : {};
      items.forEach(function (item) {
        item.analytics = map[item.contentId] || { totalPlays: 0, averagePlayTimeSeconds: 0, totalTimeSeconds: 0 };
      });
    } catch (_) {
      items.forEach(function (item) {
        item.analytics = { totalPlays: 0, averagePlayTimeSeconds: 0, totalTimeSeconds: 0 };
      });
    }
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────
  function renderLeaderboard(items) {
    var leaderboardEl   = document.getElementById('am-leaderboard');
    var leaderboardList = document.getElementById('am-leaderboard-list');
    var sortedAssets    = items
      .filter(function (i) { return i.analytics && i.analytics.totalTimeSeconds > 0; })
      .sort(function (a, b) { return b.analytics.totalTimeSeconds - a.analytics.totalTimeSeconds; })
      .slice(0, 3);

    if (!sortedAssets.length) { if (leaderboardEl) leaderboardEl.style.display = 'none'; return; }
    if (leaderboardEl) leaderboardEl.style.display = 'block';
    if (!leaderboardList) return;

    var medals = ['🥇', '🥈', '🥉'];
    leaderboardList.innerHTML = sortedAssets.map(function (item, index) {
      return '<div class="d-flex justify-content-between align-items-center p-2 mb-2" style="background:var(--bg-surface);border-radius:6px;">' +
        '<div class="d-flex align-items-center gap-3">' +
          '<span style="font-size:18px;">' + medals[index] + '</span>' +
          '<span style="color:var(--text-primary);font-weight:600;font-size:13px;">' + esc(item.title||'Untitled') + '</span>' +
        '</div>' +
        '<div class="am-col-metric">' +
          '<span style="color:var(--teal);margin-right:12px;">' + item.analytics.totalPlays + ' plays</span>' +
          '<span style="color:var(--gold);">' + formatDurationString(item.analytics.totalTimeSeconds) + ' total</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Render asset list ──────────────────────────────────────────────────────
  async function renderList() {
    var c = document.getElementById('am-list-container');
    if (!c) return;
    var items = filtered();
    if (!items.length) {
      c.innerHTML = '<div class="am-empty">No assets in this category. <a href="creators.html">Upload →</a></div>';
      renderLeaderboard([]);
      return;
    }

    // Load telemetry for all visible items before rendering
    await loadTelemetryForItems(items);

    var icons = { music:'🎵', podcast:'🎙', video:'🎬', art_still:'🖼', art_animated:'🎨' };

    c.innerHTML = '<div class="am-list">' + items.map(function (item) {
      var ct       = item.contentType || 'music';
      var icon     = icons[ct] || '🎵';
      var cover    = item.coverUrl
        ? '<img class="am-cover" src="' + esc(item.coverUrl) + '" alt="">'
        : '<div class="am-cover-ph">' + icon + '</div>';
      var srOn     = !!item.supporterRoyaltyEnabled;
      var locked   = isLocked(item.contentId);
      var isPriv   = !!item.isPrivate;
      var vinyl    = srOn ? '<img src="assets/msp-vinyl.svg" width="13" height="13" title="Supporter royalties enabled" style="flex-shrink:0;">' : '';
      var privBadge = '<span class="priv-badge ' + (isPriv?'priv':'pub') + '">' + (isPriv?'🔒 Private':'🌐 Public') + '</span>';
      var plays    = item.plays !== undefined ? item.plays : '—';
      var earned   = item.royaltiesEarned ? parseFloat(item.royaltiesEarned).toFixed(4)+' ETH' : '0.0000 ETH';
      var plx      = getPlaylistMetrics(item);
      var topPlaylistText = plx.topPlaylist && plx.topPlaylist.name ? ('Top playlist: ' + plx.topPlaylist.name) : '';
      var playlistChips =
        '<div class="am-chip-row">' +
          '<span class="am-chip teal">🎛 ' + Number(plx.placementCount||0) + ' placements</span>' +
          '<span class="am-chip">▶ ' + Number(plx.playlistPlays||0) + ' playlist plays</span>' +
          '<span class="am-chip gold">💸 ' + ethFmt(plx.curatorPayoutGeneratedEth||0) + '</span>' +
          (topPlaylistText ? ('<span class="am-chip">' + esc(topPlaylistText) + '</span>') : '') +
        '</div>';

      // Telemetry columns
      var analytics  = item.analytics || { totalPlays:0, averagePlayTimeSeconds:0, totalTimeSeconds:0 };
      var avgTime    = formatDurationString(analytics.averagePlayTimeSeconds);
      var totalTime  = formatDurationString(analytics.totalTimeSeconds);

      var coolNote = locked ? '<div class="sr-cooldown">' + daysLeft(item.contentId) + ' days locked</div>' : '';
      var srBlock =
        '<div class="sr-wrap">' +
          '<div class="form-check form-switch mb-0">' +
            '<input class="form-check-input" type="checkbox" role="switch"' +
              ' id="sr-' + esc(item.contentId) + '"' +
              (srOn?' checked':'') + (locked?' disabled':'') +
              ' data-contentid="' + esc(item.contentId) + '">' +
          '</div>' +
          '<label class="sr-label' + (srOn?' on':'') + '" for="sr-' + esc(item.contentId) + '">' + (srOn?'★ Supporter':'Supporter') + '</label>' +
          coolNote +
        '</div>';

      return (
        '<div class="am-row" id="row-' + esc(item.contentId) + '">' +
          cover +
          '<div class="am-info">' +
            '<div class="am-title-text">' + esc(item.title||'Untitled') + vinyl + '</div>' +
            '<div class="am-meta">' + esc(item.artistName||'—') + ' · ' + ct.toUpperCase() + ' · ' + privBadge + '</div>' +
            playlistChips +
          '</div>' +
          '<div class="am-col-plays">' + plays + '<br><span style="font-size:9px;color:var(--text-muted)">PLAYS</span></div>' +
          '<div class="am-col-metric am-col-avgtime">' + avgTime + '<br><span style="font-size:9px">AVG</span></div>' +
          '<div class="am-col-metric am-col-totaltime">' + totalTime + '<br><span style="font-size:9px">TOTAL</span></div>' +
          '<div class="am-col-royalties">' + earned + '<br><span style="font-size:9px">EARNED</span></div>' +
          srBlock +
          '<div class="am-actions">' +
            '<button class="am-btn play" data-action="play"' +
              ' data-hlsurl="' + esc(item.hlsUrl||'') + '"' +
              ' data-title="' + esc(item.title||'') + '"' +
              ' data-artist="' + esc(item.artistName||'') + '"' +
              ' data-cover="' + esc(item.coverUrl||'') + '">▶ Play</button>' +
            '<button class="am-btn splits" data-action="splits" data-contentid="' + esc(item.contentId) + '">💸 Splits</button>' +
            '<button class="am-btn privacy" data-action="privacy" data-contentid="' + esc(item.contentId) + '" data-private="' + (isPriv?'1':'0') + '">' +
              (isPriv?'🌐 Make Public':'🔒 Make Private') + '</button>' +
            '<a class="am-btn playlists" href="playlists.html?asset=' + encodeURIComponent(item.contentId||'') + '">🎛 Playlists</a>' +
          '</div>' +
        '</div>' +
        // Splits panel
        '<div class="splits-panel" id="splits-' + esc(item.contentId) + '">' +
          '<h6 class="mb-3" style="color:var(--gold)">💸 Royalty Splits — ' + esc(item.title||'Untitled') + '</h6>' +
          '<p class="text-muted small mb-3">All splits must total 100%. Supporter royalties flow to curators only when Supporter Royalty toggle is enabled above and the asset is in a public playlist.</p>' +
          '<div class="splits-grid">' +
            '<div class="split-field"><label>Artist %</label><input type="number" min="0" max="100" value="' + ((item.splits&&item.splits.artist)||70) + '" data-split="artist" data-contentid="' + esc(item.contentId) + '"></div>' +
            '<div class="split-field"><label>NFT Holders %</label><input type="number" min="0" max="100" value="' + ((item.splits&&item.splits.nft_holders)||10) + '" data-split="nft_holders" data-contentid="' + esc(item.contentId) + '"></div>' +
            '<div class="split-field"><label>Activity Pool %</label><input type="number" min="0" max="100" value="' + ((item.splits&&item.splits.activity_pool)||15) + '" data-split="activity_pool" data-contentid="' + esc(item.contentId) + '"></div>' +
            '<div class="split-field"><label>Supporter %</label><input type="number" min="0" max="100" value="' + ((item.splits&&item.splits.supporter)||5) + '" data-split="supporter" data-contentid="' + esc(item.contentId) + '"></div>' +
          '</div>' +
          '<div class="d-flex gap-2 mt-3">' +
            '<button class="btn btn-sm btn-warning text-dark" data-action="save-splits" data-contentid="' + esc(item.contentId) + '">Save Splits</button>' +
            '<button class="btn btn-sm btn-outline-secondary" data-action="close-splits" data-contentid="' + esc(item.contentId) + '">Cancel</button>' +
          '</div>' +
        '</div>'
      );
    }).join('') + '</div>';

    wireActions();
    renderLeaderboard(items);
  }

  // ── Event delegation ───────────────────────────────────────────────────────
  function wireActions() {
    var c = document.getElementById('am-list-container');
    if (!c) return;

    // SR toggles
    c.querySelectorAll('.form-check-input[data-contentid]').forEach(function (chk) {
      chk.addEventListener('change', function () {
        var cid = chk.dataset.contentid;
        var on  = chk.checked;
        if (isLocked(cid)) { chk.checked = !on; toast('Asset is in 30-day cooldown — cannot change.', true); return; }
        if (!on) {
          if (!confirm('Disabling Supporter Royalties notifies all supporters who have this track in playlists and gives them the option to remove it.\n\nYou cannot re-enable for 30 days. Continue?')) { chk.checked = true; return; }
          setLock(cid);
        }
        var label = c.querySelector('label[for="sr-' + cid + '"]');
        if (label) { label.textContent = on ? '★ Supporter' : 'Supporter'; label.className = 'sr-label' + (on?' on':''); }
        var title = c.querySelector('#row-' + cid + ' .am-title-text');
        if (title) {
          var existing = title.querySelector('img');
          if (on && !existing) {
            var img = document.createElement('img');
            img.src = 'assets/msp-vinyl.svg'; img.width = 13; img.height = 13;
            img.title = 'Supporter royalties enabled'; img.style.flexShrink = '0';
            title.appendChild(img);
          } else if (!on && existing) { existing.remove(); }
        }
        var item = allAssets.find(function (a) { return a.contentId===cid; });
        if (item) item.supporterRoyaltyEnabled = on;
        updateStats();
        apiSR(cid, on);
      });
    });

    c.addEventListener('click', function (e) {
      var btn    = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var cid    = btn.dataset.contentid;

       // ── play is handled by wirePlayButtons below, skip here ──
      if (action === 'play') return;
	  
      if (action === 'splits') {
        var p = document.getElementById('splits-' + cid); if (!p) return;
        if (openSplits && openSplits !== cid) { var prev = document.getElementById('splits-' + openSplits); if (prev) prev.classList.remove('open'); }
        var wasOpen = p.classList.contains('open');
        p.classList.toggle('open', !wasOpen);
        openSplits = wasOpen ? null : cid;
        return;
      }
	  
      if (action === 'close-splits') {
        var p2 = document.getElementById('splits-' + cid); if (p2) p2.classList.remove('open'); openSplits = null; return;
      }
	  
      if (action === 'save-splits') {
        var inputs = c.querySelectorAll('[data-split][data-contentid="' + cid + '"]');
        var splits = {}; var total = 0;
        inputs.forEach(function (inp) { splits[inp.dataset.split] = parseFloat(inp.value)||0; total += splits[inp.dataset.split]; });
        if (Math.abs(total-100) > 0.01) { toast('Splits must total 100%. Currently: ' + total.toFixed(1) + '%', true); return; }
        var p3 = document.getElementById('splits-' + cid); if (p3) p3.classList.remove('open'); openSplits = null;
        var splitItem = allAssets.find(function (a) { return a.contentId===cid; }); if (splitItem) splitItem.splits = splits;
        apiSplits(cid, splits);
        toast('✔ Royalty splits saved.');
        return;
      }
      if (action === 'privacy') {
        var isP  = btn.dataset.private === '1';
        var newP = !isP;
        btn.dataset.private = newP ? '1' : '0';
        btn.textContent = newP ? '🌐 Make Public' : '🔒 Make Private';
        var badge = c.querySelector('#row-' + cid + ' .priv-badge');
        if (badge) { badge.className = 'priv-badge ' + (newP?'priv':'pub'); badge.textContent = newP?'🔒 Private':'🌐 Public'; }
        var privItem = allAssets.find(function (a) { return a.contentId===cid; }); if (privItem) privItem.isPrivate = newP;
        apiPrivacy(cid, newP);
        toast(newP ? '🔒 Set to Private.' : '🌐 Set to Public.');
        return;
      }
    });

     // Wire play buttons directly with toggle support
    window.wirePlayButtons(c, '.am-btn.play');
  }

  // ── Playlist analytics loader ─────────────────────────────────────────────
  async function loadPlaylistAnalytics(wallet) {
    try {
      var r = await fetch('/api/playlists/assets/' + encodeURIComponent(wallet) + '/analytics');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (_) {
      return {
        totals: { placementCount:0, publicPlacementCount:0, playlistPlays:0, eligiblePlaylistPlays:0, ineligiblePlaylistPlays:0, curatorPayoutGeneratedEth:0 },
        assets: {},
        topAssets: [],
      };
    }
  }

  // ── API calls ─────────────────────────────────────────────────────────────
  async function apiSR(cid, enabled) {
    try {
      await fetch('/api/catalog/' + cid + '/supporter-royalty', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled: enabled, wallet: window.walletAddress }),
      });
    } catch (_) {}
  }

  async function apiSplits(cid, splits) {
    try {
      await fetch('/api/royalty-splits', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cid: cid, wallet: window.walletAddress, splits: splits }),
      });
    } catch (_) {}
  }

  async function apiPrivacy(cid, isPrivate) {
    try {
      await fetch('/api/catalog/' + cid + '/privacy', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ isPrivate: isPrivate, wallet: window.walletAddress }),
      });
    } catch (_) {}
  }

  // ── Stats bar + tab counts ────────────────────────────────────────────────
  function updateStats() {
    var totalP = allAssets.reduce(function (s,a) { return s+(a.plays||0); }, 0);
    var totalR = allAssets.reduce(function (s,a) { return s+(parseFloat(a.royaltiesEarned)||0); }, 0);
    var srCnt  = allAssets.filter(function (a) { return a.supporterRoyaltyEnabled; }).length;
    var totals = playlistAssetAnalytics.totals || {};
    var values = {
      'stat-total':              allAssets.length,
      'stat-plays':              totalP,
      'stat-royalties':          totalR.toFixed(4),
      'stat-sr':                 srCnt,
      'stat-playlist-placements':totals.placementCount || 0,
      'stat-playlist-plays':     totals.playlistPlays || 0,
      'stat-playlist-revenue':   (parseFloat(totals.curatorPayoutGeneratedEth)||0).toFixed(4),
    };
    Object.keys(values).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = values[id];
    });
    renderPlaylistAnalyticsPanel();
  }

  function updateTabCounts() {
    var counts = { all: allAssets.length, music:0, video:0, podcast:0, art:0 };
    allAssets.forEach(function (a) {
      var ct = a.contentType || 'music';
      if (ct === 'art_still' || ct === 'art_animated') counts.art++;
      else if (counts[ct] !== undefined) counts[ct]++;
    });
    Object.keys(counts).forEach(function (k) {
      var el = document.getElementById('tc-' + k);
      if (el) el.textContent = counts[k];
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    if (!window.walletAddress) {
      var prompt = document.getElementById('am-wallet-prompt');
      var loader = document.getElementById('am-list-container');
      if (prompt) prompt.style.display = '';
      if (loader) loader.innerHTML = '';
      document.addEventListener('walletConnected', function () {
        if (prompt) prompt.style.display = 'none';
        boot();
      });
      return;
    }

    try {
      var results = await Promise.all([
        fetch('/api/catalog'),
        loadPlaylistAnalytics(window.walletAddress),
      ]);
      var r = results[0];
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var all = await r.json();
      playlistAssetAnalytics = results[1] || playlistAssetAnalytics;
      allAssets = all.filter(function (item) {
        return (item.wallet||'').toLowerCase() === window.walletAddress.toLowerCase();
      });

      var statsEl = document.getElementById('am-stats');
      var tabsEl  = document.getElementById('am-tabs');
      if (statsEl) statsEl.style.display = allAssets.length ? '' : 'none';
      if (tabsEl)  tabsEl.style.display  = allAssets.length ? '' : 'none';

      updateTabCounts();
      updateStats();

      // Handle deep-link anchor (#contentId from profile.html)
      var anchor = window.location.hash.slice(1);
      if (anchor) {
        var found = allAssets.find(function (a) { return a.contentId===anchor; });
        if (found) currentTab = found.contentType || 'music';
        document.querySelectorAll('.am-tab').forEach(function (b) {
          b.classList.toggle('active', b.dataset.amTab===currentTab || (!found && b.dataset.amTab==='all'));
        });
      }

      await renderList();

      if (anchor) {
        setTimeout(function () {
          var el = document.getElementById('row-' + anchor);
          if (el) el.scrollIntoView({ behavior:'smooth', block:'center' });
        }, 300);
      }

    } catch (err) {
      var c = document.getElementById('am-list-container');
      if (c) c.innerHTML = '<div class="am-empty">Failed to load: ' + err.message + '</div>';
    }
  }

  document.addEventListener('walletConnected', function () { boot(); });
  if (window.walletAddress) boot();

})(); // end asset-manager.js
