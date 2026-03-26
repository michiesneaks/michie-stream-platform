// public/Scripts/main.js
'use strict';

/**
 * Michie Stream Platform — main browser script
 *
 * Globals expected (set by vendor scripts + wallets.js):
 *   window.ethers           — ethers v5 UMD
 *   window.MSP_CONFIG       — { contentCAAddress, royaltyPayoutAddress, escrowAddress, mspAdminAddress, abis:{} }
 *   window.MSP_NFT_BYTECODE — bytecode for user NFT contract (optional)
 *   window.IPFS_GATEWAY     — e.g. 'https://ipfs.io/ipfs/' (common.js sets default)
 *   window.playHls          — function(url, metaUrl) from common.js
 *   window.openWalletModal  — from wallets.js
 *   window.walletAddress    — set by wallets.js after connect
 *   window.ethersSigner     — set by wallets.js after connect
 *   window.ethersProvider   — set by wallets.js after connect
 */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var GATEWAY = function () { return window.IPFS_GATEWAY || 'https://ipfs.io/ipfs/'; };

  // ═══════════════════════════════════════════════════════════
  //  CONFIG
  // ═══════════════════════════════════════════════════════════
  var CFG                  = window.MSP_CONFIG || {};
  var ABIS                 = CFG.abis           || {};
  var contentCAAddress     = CFG.contentCAAddress;
  var royaltyPayoutAddress = CFG.royaltyPayoutAddress;
  var escrowAddress        = CFG.escrowAddress;
  var mspAdminAddress      = CFG.mspAdminAddress;

  if (!window.ethers) { console.warn('MSP: ethers not found — load ethers UMD before main.js'); }

  // ═══════════════════════════════════════════════════════════
  //  SESSION STATE
  // ═══════════════════════════════════════════════════════════
  var _access    = null;
  var _profile   = null;
  var _favorites = null;   // Set of CIDs the current user has favorited

  function getAccess()    { return _access  || {}; }
  function getProfile()   { return _profile || JSON.parse(localStorage.getItem('profile') || '{}'); }
  function getFavorites() { return _favorites || new Set(); }

  // ── Favorites API helpers ──────────────────────────────────────────────────
  async function loadFavorites(address) {
    if (!address) return;
    try {
      var res = await fetch('/api/favorites/' + address);
      if (res.ok) {
        var data = await res.json();
        _favorites = new Set(data.favorites || []);
        _syncHeartButtons();
      }
    } catch (e) { console.debug('loadFavorites failed:', e.message); }
  }

  async function toggleFavorite(cid) {
    var addr = window.walletAddress;
    if (!addr) throw new Error('Connect your wallet first.');
    var isFav = getFavorites().has(cid);
    var endpoint = isFav ? '/api/favorites/remove' : '/api/favorites/add';
    var res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: addr, cid: cid }),
    });
    if (!res.ok) { throw new Error(await safeApiError(res, 'Failed to update favorites')); }
    var data = await res.json();
    _favorites = new Set(data.favorites || []);
    _syncHeartButtons();
    return !isFav;  // returns new state: true = now favorited
  }

  function _syncHeartButtons() {
    document.querySelectorAll('[data-fav-cid]').forEach(function (btn) {
      var cid = btn.dataset.favCid;
      var active = getFavorites().has(cid);
      btn.classList.toggle('fav-active', active);
      btn.setAttribute('aria-label', active ? 'Remove from Favorites' : 'Add to Favorites');
      btn.textContent = active ? '♥' : '♡';
    });
  }

  function makeFavButton(cid) {
    var btn = document.createElement('button');
    btn.className    = 'fav-btn';
    btn.dataset.favCid = cid;
    btn.textContent  = getFavorites().has(cid) ? '♥' : '♡';
    btn.setAttribute('aria-label', getFavorites().has(cid) ? 'Remove from Favorites' : 'Add to Favorites');
    btn.addEventListener('click', async function (e) {
      e.stopPropagation();
      if (!window.walletAddress) {
        if (typeof window.openWalletModal === 'function') window.openWalletModal();
        return;
      }
      btn.disabled = true;
      try {
        var nowFav = await toggleFavorite(cid);
        btn.classList.toggle('fav-active', nowFav);
        btn.textContent = nowFav ? '♥' : '♡';
      } catch (err) {
        console.warn('toggleFavorite:', err.message);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  // ═══════════════════════════════════════════════════════════
  //  CAPABILITY CHECKS
  // ═══════════════════════════════════════════════════════════
  var CAN = {
    stream:         function () { return ['listener_1','listener_2','listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    browseNFTs:     function () { return !!getAccess().level && getAccess().level !== 'none'; },
    buyNFTs:        function () { return CAN.browseNFTs(); },
    watchConcerts:  function () { return true; },
    concertChat:    function () { return ['listener_2','listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    tipAnonymous:   function () { return true; },
    tipRecognized:  function () { return CAN.stream(); },
    createPlaylist: function () { return ['listener_2','listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    hostDjSet:      function () { return ['listener_2','listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    upload:         function () { return ['creator_active','nft_creator_active','nft_creator_passive'].indexOf(getAccess().level) !== -1; },
    mintNFT:        function () { return CAN.upload(); },
    hostConcert:    function () { return ['creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    createAds:      function () { return ['creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    setSplits:      function () { return ['creator_active','nft_creator_active','nft_creator_passive'].indexOf(getAccess().level) !== -1; },
    earnPassive:    function () { return ['listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    earnActivity:   function () { return ['listener_2','listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    downloads:      function () { return ['listener_3','creator_active','nft_creator_active'].indexOf(getAccess().level) !== -1; },
    favorite:       function () { return true; },  // All user roles — no subscription gate (MSP spec)
    supporterSub:   function () { return CAN.upload(); }
  };

  // ═══════════════════════════════════════════════════════════
  //  WALLET HELPERS
  // ═══════════════════════════════════════════════════════════
  function requireSigner() {
    var signer = window.ethersSigner;
    var addr   = window.walletAddress;
    if (!signer || !addr) { throw new Error('Wallet not connected. Please connect your wallet first.'); }
    return { signer: signer, address: addr };
  }

  function requireProvider() {
    var provider = window.ethersProvider;
    if (!provider) { throw new Error('Wallet provider not available. Connect your wallet first.'); }
    return provider;
  }

  function getContract(address, abi, signerOrProvider) {
    if (!window.ethers) { throw new Error('ethers not loaded'); }
    return new window.ethers.Contract(address, abi, signerOrProvider);
  }

  // ═══════════════════════════════════════════════════════════
  //  PROFILE CACHE  (address-scoped localStorage)
  // ═══════════════════════════════════════════════════════════

  function profileCacheKey(address) {
    return 'msp_profile_' + address.toLowerCase();
  }

  function saveProfileCache(address, data) {
    _profile = data;
    localStorage.setItem(profileCacheKey(address), JSON.stringify(data));
    localStorage.setItem('profile', JSON.stringify(data)); // keep legacy key in sync
  }

  function loadProfileCache(address) {
    try {
      var raw = localStorage.getItem(profileCacheKey(address));
      if (raw) { return JSON.parse(raw); }
    } catch (_) {}
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  DISPLAY NAME  — propagate to all .user-name-display elements
  // ═══════════════════════════════════════════════════════════
  function applyUserName(name) {
    if (!name) { return; }
    document.querySelectorAll('.user-name-display').forEach(function (el) {
      el.textContent = name;
    });
    // Pre-fill artist name on creators page if the field is still blank
    var artistInput = $('artist-name');
    if (artistInput && !artistInput.value) { artistInput.value = name; }
  }

  // ═══════════════════════════════════════════════════════════
  //  PROFILE + ACCESS
  // ═══════════════════════════════════════════════════════════
  async function fetchAccess(address) {
    try {
      var res = await fetch('/api/access/' + address);
      if (res.ok) { _access = await res.json(); return _access; }
    } catch (e) { console.warn('fetchAccess failed:', e.message); }
    _access = { level: 'none', tier: 0, active: false };
    return _access;
  }

  /**
   * fetchOrCreateProfile — the only place a name prompt ever appears.
   *
   * Order:
   *   1. Hit localStorage first (address-scoped key).  Instant, no network, no prompt.
   *      A background fetch silently refreshes the cache.
   *   2. Cache miss → fetch /api/profile/:address.
   *      Success → save to cache, return.
   *      404     → this is a brand-new user; show the name prompt exactly once.
   *      Other error / network fail → use legacy 'profile' key if present, else throw.
   *   3. On prompt: create profile via POST, save to cache, never prompt again.
   */
  async function fetchOrCreateProfile(address) {

    // ── Step 1: local cache hit ───────────────────────────────────────────────
    var cached = loadProfileCache(address);
    if (cached && cached.user_id) {
      _profile = cached;
      applyUserName(cached.name);

      if (cached._pending) {
        // Profile was saved locally when the server was unreachable.
        // Retry creation in the background — once it succeeds the real profile
        // replaces the pending one and the _pending flag is gone.
        fetch('/api/create-profile', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ wallet: address, name: cached.name, account_type: cached.account_type })
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.user_id) {
              saveProfileCache(address, data);
              applyUserName(data.name);
            }
          }).catch(function () {});
      } else {
        // Regular background refresh to pick up server-side changes
        fetch('/api/profile/' + address)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.user_id) {
              saveProfileCache(address, data);
              applyUserName(data.name);
            }
          }).catch(function () {});
      }
      return _profile;
    }

    // ── Step 2: cache miss — ask the server ──────────────────────────────────
    var serverStatus = 0;
    var serverData   = null;
    var serverReachable = true;
    try {
      var res = await fetch('/api/profile/' + address);
      serverStatus = res.status;
      if (res.ok) {
        var data = await res.json();
        if (data && data.user_id) { serverData = data; }
      }
    } catch (e) {
      // fetch() threw — backend is not running (e.g. VS Code Live Server).
      // Fall back to the legacy 'profile' key if it exists, otherwise treat
      // this wallet as having no profile yet but don't prompt — wait until
      // the backend is reachable.
      serverReachable = false;
      var legacyRaw = localStorage.getItem('profile');
      if (legacyRaw) {
        try {
          var legacy = JSON.parse(legacyRaw);
          if (legacy && legacy.user_id) {
            saveProfileCache(address, legacy);
            applyUserName(legacy.name);
            return _profile;
          }
        } catch (_) {}
      }
      // No legacy data either — treat as new user but still show the prompt
      // so they can interact with the UI. serverReachable=false means the
      // profile will be saved locally and creation retried when server is up.
    }

    if (serverData) {
      saveProfileCache(address, serverData);
      applyUserName(serverData.name);
      return _profile;
    }

    // Non-404 server error — don't prompt, surface the error
    if (serverReachable && serverStatus !== 0 && serverStatus !== 404) {
      throw new Error('Profile server error: ' + serverStatus);
    }

    // If server is unreachable AND there's no legacy data, the code falls
    // through to Step 3 which will save a pending profile locally.

    // ── Step 3: true 404 — brand-new user, prompt exactly once ───────────────
    //
    // IMPORTANT: We save a local "pending" profile to localStorage BEFORE the
    // server call. This means even if the backend is unavailable (e.g. VS Code
    // Live Server with no running Node server), the user is only ever asked for
    // their name once. The pending profile is replaced by the real server
    // profile as soon as the backend becomes reachable.

    var name = prompt('Welcome to Michie Stream!\n\nEnter your display name:');
    if (!name || !name.trim()) {
      throw new Error('A display name is required to create your profile.');
    }

    var isCreator    = confirm('Signing up as a Creator or Artist?\n\nOK = Creator  |  Cancel = Listener');
    var account_type = isCreator ? 'creator' : 'listener';

    // Persist immediately — guarantees the cache hit on every subsequent load
    var pendingProfile = {
      user_id:       'pending_' + address.toLowerCase(),
      wallet_address: address,
      name:          name.trim(),
      account_type:  account_type,
      _pending:      true   // flag so background refresh knows to retry creation
    };
    saveProfileCache(address, pendingProfile);
    applyUserName(pendingProfile.name);

    // Best-effort server creation — failure is silent, pending profile stays in cache
    try {
      var createRes = await fetch('/api/create-profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ wallet: address, name: name.trim(), account_type: account_type })
      });
      if (createRes.ok) {
        var created = await createRes.json();
        saveProfileCache(address, created);  // overwrite pending with real profile
        applyUserName(created.name);
      } else {
        console.warn('Profile creation returned', createRes.status, '— using local pending profile until server is reachable.');
      }
    } catch (netErr) {
      console.warn('Profile creation network error — using local pending profile:', netErr.message);
    }

    return _profile;
  }

  // ═══════════════════════════════════════════════════════════
  //  UI GATES
  // ═══════════════════════════════════════════════════════════
  function applyCapabilityGates() {
    var level  = getAccess().level || 'none';
    var active = getAccess().active;

    document.querySelectorAll('[data-requires]').forEach(function (el) {
      var cap = el.dataset.requires;
      el.style.display = (typeof CAN[cap] === 'function' && CAN[cap]()) ? '' : 'none';
    });

    var chatInput = $('concert-chat-input');
    if (chatInput) { chatInput.style.display = CAN.concertChat() ? '' : 'none'; }

    var expiryEl = $('subscription-expiry');
    if (expiryEl && getAccess().subscription_expiry) {
      var days = Math.max(0, Math.floor((getAccess().subscription_expiry - Date.now()) / 86400000));
      expiryEl.textContent = active
        ? ('Access expires in ' + days + ' day' + (days !== 1 ? 's' : ''))
        : 'Subscription expired';
      expiryEl.className = active ? 'text-success small' : 'text-danger small';
    }

    var nftBadge = $('platform-nft-badge');
    if (nftBadge) {
      var isPlatformNft = ['nft_creator_active','nft_creator_passive'].indexOf(level) !== -1;
      nftBadge.style.display = isPlatformNft ? '' : 'none';
      if (isPlatformNft) {
        nftBadge.textContent = 'Platform NFT \u00b7 ' + (getAccess().royalty_fee_rate * 100).toFixed(1) + '% fee';
        nftBadge.className   = 'badge bg-warning text-dark';
      }
    }

    var feeEl = $('royalty-fee-rate');
    if (feeEl && getAccess().royalty_fee_rate != null) {
      feeEl.textContent = (getAccess().royalty_fee_rate * 100).toFixed(1) + '%';
    }

    var uploadBtn = $('upload-btn');
    if (uploadBtn) { uploadBtn.textContent = CAN.mintNFT() ? 'Upload & Mint' : 'Upload'; }

    var mktSection = $('marketplace-section');
    if (mktSection && !CAN.browseNFTs()) {
      mktSection.innerHTML =
        '<div class="text-center py-5">' +
        '<h4>NFT Marketplace</h4>' +
        '<p class="text-muted">Subscribe to browse and purchase NFTs.</p>' +
        '<a href="listen.html#subscribe" class="btn btn-primary">Subscribe Now</a>' +
        '</div>';
    }

    // Show/hide the royalty fee row on creators page
    var feeRow = $('fee-row');
    if (feeRow) { feeRow.style.display = (feeEl && feeEl.textContent.trim()) ? '' : 'none'; }
  }

  // ═══════════════════════════════════════════════════════════
  //  API ERROR HELPER
  // ═══════════════════════════════════════════════════════════
  async function safeApiError(res, fallback) {
    try {
      var ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        var j = await res.json();
        return j.error || j.message || fallback || ('Server error ' + res.status);
      }
    } catch (_) {}
    return fallback || ('Server error ' + res.status);
  }

  // ═══════════════════════════════════════════════════════════
  //  SUBSCRIPTION
  // ═══════════════════════════════════════════════════════════
  async function subscribePlan(plan) {
    var addr = requireSigner().address;
    var profile = getProfile();
    if (!profile || !profile.user_id) { throw new Error('Profile not found. Reconnect your wallet.'); }

    try {
      var feesData = await fetch('/api/fees').then(function (r) { return r.ok ? r.json() : {}; });
      var planDef  = feesData.subscription_plans && feesData.subscription_plans[plan];
      if (planDef && planDef.price_eth) {
        var signer = requireSigner().signer;
        var esc    = getContract(escrowAddress, ABIS.escrow, signer);
        var tx     = await esc.subscribe({ value: window.ethers.utils.parseEther(String(planDef.price_eth)) });
        await tx.wait();
      }
    } catch (e) { console.warn('On-chain subscription payment skipped (ok in dev):', e.message); }

    var res = await fetch('/api/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: addr, plan: plan })
    });
    if (!res.ok) { throw new Error(await safeApiError(res, 'Subscription failed. Please try again.')); }
    var data = await res.json();

    _access = await fetchAccess(addr);
    _profile = await fetchOrCreateProfile(addr);
    applyCapabilityGates();
    // Notify live_studio.html that access level changed (e.g. after subscribing)
    window.dispatchEvent(new CustomEvent('msp:accessChanged'));
    return data;
  }

  // ═══════════════════════════════════════════════════════════
  //  TIPS
  // ═══════════════════════════════════════════════════════════
  async function sendTip(params) {
    var toWallet    = params.toWallet;
    var tipType     = params.tipType;
    var amountEth   = params.amountEth;
    var djSetId     = params.djSetId;
    var artistSplits = params.artistSplits;
    var djPercent   = params.djPercent;
    var s           = requireSigner();
    var tx = await s.signer.sendTransaction({
      to:    toWallet,
      value: window.ethers.utils.parseEther(String(amountEth))
    });
    await tx.wait();
    var res = await fetch('/api/tip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from_wallet:   s.address,
        to_wallet:     toWallet,
        tip_type:      tipType,
        amount_eth:    amountEth,
        dj_set_id:     djSetId       || null,
        artist_splits: artistSplits  || [],
        dj_percent:    (djPercent != null) ? djPercent : 100
      })
    });
    if (!res.ok) { throw new Error(await safeApiError(res)); }
    return res.json();
  }

  function renderTipButton(container, opts) {
    if (!container || !opts.toWallet) { return; }
    var btn = document.createElement('button');
    btn.className   = 'btn btn-sm btn-outline-warning ms-2 tip-btn';
    btn.textContent = '\uD83D\uDCB0 ' + (opts.label || 'Tip');
    btn.addEventListener('click', async function () {
      var amt = prompt('Enter tip amount in ETH (e.g. 0.001):');
      if (!amt || isNaN(parseFloat(amt))) { return; }
      btn.disabled    = true;
      btn.textContent = 'Sending\u2026';
      try {
        var result = await sendTip({ toWallet: opts.toWallet, tipType: opts.tipType, amountEth: parseFloat(amt), djSetId: opts.djSetId });
        btn.textContent = result.recognized ? '\u2714 Tipped!' : '\u2714 Tipped (anonymous)';
        btn.className   = 'btn btn-sm btn-success ms-2';
      } catch (err) {
        btn.disabled    = false;
        btn.textContent = opts.label || 'Tip';
        alert('Tip failed: ' + err.message);
      }
    });
    container.appendChild(btn);
  }

  // ═══════════════════════════════════════════════════════════
  //  CONTENT PLAYBACK
  // ═══════════════════════════════════════════════════════════
  async function playContent(metadataCid, nftContractAddress, tokenId, opts) {
    opts = opts || {};
    var live       = opts.live       || false;
    var playlistId = opts.playlistId || null;
    var addr       = window.walletAddress;

    var isOwner = false;
    if (addr && nftContractAddress && tokenId != null) {
      try {
        var nft   = getContract(nftContractAddress, ABIS.nftMetadata, requireProvider());
        var owner = await nft.ownerOf(tokenId);
        isOwner   = owner.toLowerCase() === addr.toLowerCase();
      } catch (e) { console.debug('ownerOf check skipped:', e.message); }
    }

    var profile = getProfile();
    if (profile && profile.supporter_subaccount && profile.supporter_subaccount.enabled && nftContractAddress) {
      var creatorContract = profile.nft_contract_address || profile.nftContractAddress;
      if (creatorContract && nftContractAddress.toLowerCase() === creatorContract.toLowerCase()) {
        throw new Error('Your supporter account cannot stream your own creator content.');
      }
    }

    var tokenRes  = await fetch('/api/request-play-token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cid: metadataCid, listener: addr, live: live, playlistId: playlistId })
    });
    var tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      if (tokenData.pay_per_play) {
        var doPPP = confirm('You need a subscription to stream.\n\nOK = Pay 0.001 ETH per play  |  Cancel = Go to Subscribe page');
        if (!doPPP) { window.location.href = 'listen.html#subscribe'; return; }
        var signer2 = requireSigner().signer;
        var esc2 = getContract(escrowAddress, ABIS.escrow, signer2);
        var tx2  = await esc2.depositForPlay(metadataCid, { value: window.ethers.utils.parseEther('0.001') });
        await tx2.wait();
      } else {
        throw new Error(tokenData.error || 'Could not get play token.');
      }
    }

    var playToken = tokenData.playToken;
    var metaUrl   = GATEWAY() + metadataCid;
    var metadata  = await (await fetch(metaUrl)).json();
    var url       = (isOwner || CAN.stream()) ? metadata.ipfs_audio_url : metadata.files && metadata.files.preview_url;
    if (!url) { throw new Error('No playable URL found in metadata.'); }
    if (typeof window.playHls !== 'function') { throw new Error('playHls not available. Load common.js first.'); }
    window.playHls(url.replace('ipfs://', GATEWAY()), metaUrl);

    if (playToken) {
      var audioEl = $('audio-player');
      if (audioEl) {
        audioEl.addEventListener('ended', function () {
          fetch('/api/submit-play-proof', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ playToken: playToken })
          }).catch(function (e) { console.warn('Play proof failed:', e.message); });
        }, { once: true });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  NFT MINTING
  // ═══════════════════════════════════════════════════════════
  async function ensureUserNftContract(profile) {
    var existing = profile.nft_contract_address || profile.nftContractAddress;
    if (existing) { return existing; }
    var bytecode = window.MSP_NFT_BYTECODE;
    if (!bytecode) { throw new Error('NFT bytecode (MSP_NFT_BYTECODE) not provided.'); }
    var signer  = requireSigner().signer;
    var factory = new window.ethers.ContractFactory(ABIS.nftMetadata, bytecode, signer);
    var contract = await factory.deploy(profile.name + "'s NFTs", 'MNFT', mspAdminAddress);
    await contract.deployed();
    var addr = contract.address;
    await fetch('/api/update-profile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: window.walletAddress, nftContractAddress: addr })
    });
    if (_profile) {
      _profile.nft_contract_address = addr;
      saveProfileCache(window.walletAddress, _profile);
    }
    return addr;
  }

  async function registerCertificate(metadataCid, contentType, caSignature) {
    var signer = requireSigner().signer;
    var ca = getContract(contentCAAddress, ABIS.contentCA, signer);
    var tx = await ca.registerCertificate(metadataCid, contentType, caSignature);
    await tx.wait();
  }

  async function mintNftEth(profile, params) {
    var contractAddr = await ensureUserNftContract(profile);
    var signer       = requireSigner().signer;
    var nft          = getContract(contractAddr, ABIS.nftMetadata, signer);
    var est          = await nft.mintNFT.estimateGas(params.songTitle, params.artistName, params.year, params.metadataUrl).catch(function () { return null; });
    var gas          = est ? est.mul(120).div(100) : undefined;
    var tx           = await nft.mintNFT(params.songTitle, params.artistName, params.year, params.metadataUrl, gas ? { gasLimit: gas } : {});
    await tx.wait();
    return contractAddr;
  }

  // ═══════════════════════════════════════════════════════════
  //  NFT MARKETPLACE
  // ═══════════════════════════════════════════════════════════
  async function loadNFTs(containerId) {
    var container = $(containerId);
    if (!container) { return; }

    if (!CAN.browseNFTs()) {
      container.innerHTML =
        '<div class="col-12 text-center py-4">' +
        '<p class="text-muted">Subscribe to browse and purchase NFTs.</p>' +
        '<a href="listen.html#subscribe" class="btn btn-primary btn-sm">Subscribe</a>' +
        '</div>';
      return;
    }

    try {
      var nfts = await fetch('/api/nfts').then(function (r) { return r.ok ? r.json() : []; });
      if (!Array.isArray(nfts) || !nfts.length) {
        container.innerHTML = '<p class="text-muted text-center py-4">No NFTs available yet.</p>';
        return;
      }

      container.innerHTML = nfts.map(function (nft) {
        var imgSrc = (nft.cover_image || '').replace('ipfs://', GATEWAY());
        return '<div class="col-md-4 mb-3">' +
          '<div class="nft-card h-100">' +
          '<img src="' + imgSrc + '" alt="' + (nft.title || '') + '" style="width:100%;aspect-ratio:1/1;object-fit:cover;">' +
          '<div class="p-2">' +
          '<h5 class="mb-1">' + (nft.title || 'Untitled') + '</h5>' +
          '<p class="mb-1 small text-muted">Artist: ' + (nft.artist || 'Unknown') + '</p>' +
          (nft.price_eth ? '<p class="mb-2 small">Price: ' + nft.price_eth + ' ETH</p>' : '') +
          '<div class="d-flex gap-1 flex-wrap">' +
          '<button class="btn btn-primary btn-sm play-nft"' +
            ' data-cid="' + (nft.metadataCid || '') + '"' +
            ' data-contract="' + (nft.contractAddress || '') + '"' +
            ' data-tokenid="' + (nft.tokenId || '') + '"' +
            ' data-artist="' + (nft.artistWallet || '') + '">\u25B6 Play</button>' +
          '<button class="btn btn-outline-primary btn-sm buy-nft"' +
            ' data-price="' + (nft.price_eth || '0') + '"' +
            ' data-contract="' + (nft.contractAddress || '') + '"' +
            ' data-tokenid="' + (nft.tokenId || '') + '">Buy NFT</button>' +
          '</div></div></div></div>';
      }).join('');

      container.querySelectorAll('.play-nft').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          try {
            await playContent(btn.dataset.cid, btn.dataset.contract || null, btn.dataset.tokenid || null, { live: false });
            if (btn.dataset.artist) {
              renderTipButton(btn.closest('.d-flex'), { toWallet: btn.dataset.artist, tipType: 'artist', label: 'Tip Artist' });
            }
          } catch (e) { alert(e.message); }
          finally { btn.disabled = false; }
        });
      });

      container.querySelectorAll('.buy-nft').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          if (!CAN.buyNFTs()) { return alert('Subscribe to purchase NFTs.'); }
          var price = btn.dataset.price;
          if (!price || price === '0') { return alert('This NFT has no listing price.'); }
          btn.disabled = true;
          try {
            var feeRes  = await fetch('/api/nft-sale-fee', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ sale_price_eth: price, nft_type: 'music', seller_wallet: btn.dataset.contract, is_primary: false })
            });
            var feeData = feeRes.ok ? await feeRes.json() : {};
            var ok = confirm(
              'Buy NFT for ' + price + ' ETH?\n' +
              'Platform fee: ' + (feeData.platform_fee_eth || '?') + ' ETH\n' +
              'Seller receives: ' + (feeData.seller_gets_eth || '?') + ' ETH'
            );
            if (!ok) { btn.disabled = false; return; }
            var signer      = requireSigner().signer;
            var nftContract = getContract(btn.dataset.contract, ABIS.nftMetadata, signer);
            var tx          = await nftContract.purchase(btn.dataset.tokenid, { value: window.ethers.utils.parseEther(String(price)) });
            await tx.wait();
            btn.textContent = '\u2714 Purchased';
            btn.className   = 'btn btn-sm btn-success';
          } catch (e) { alert('Purchase failed: ' + e.message); btn.disabled = false; }
        });
      });
    } catch (e) {
      console.error('loadNFTs failed:', e);
      container.innerHTML = '<p class="text-danger text-center">Failed to load NFTs. Try again later.</p>';
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  ROYALTY SPLITS
  // ═══════════════════════════════════════════════════════════
  async function submitRoyaltySplits(cid, splits) {
    var addr = requireSigner().address;
    var res = await fetch('/api/set-royalty-splits', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: addr, cid: cid, splits: splits })
    });
    if (!res.ok) { throw new Error(await safeApiError(res)); }
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════
  //  DJ SET
  // ═══════════════════════════════════════════════════════════
  async function startDjSet(params) {
    var addr = requireSigner().address;
    var res = await fetch('/api/start-dj-set', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        wallet:        addr,
        set_name:      params.setName,
        tips_enabled:  params.tipsEnabled,
        dj_percent:    params.djPercent,
        artist_splits: params.artistSplits || []
      })
    });
    if (!res.ok) { throw new Error(await safeApiError(res)); }
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════
  //  LIVE ENCODE
  // ═══════════════════════════════════════════════════════════
  async function startLiveEncode(wallet, eventTitle, artistName) {
    var res = await fetch('/api/start-live-encode', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet: wallet, eventTitle: eventTitle, artistName: artistName })
    });
    if (!res.ok) { throw new Error(await safeApiError(res)); }
    return res.json();
  }

  // ═══════════════════════════════════════════════════════════
  //  WALLET CONNECTED HANDLER
  //  Fires on: explicit connect AND session restore (wallets.js now calls notifyConnected both ways)
  // ═══════════════════════════════════════════════════════════
  document.addEventListener('walletConnected', async function (e) {
    var address = (e.detail && e.detail.address) || window.walletAddress;
    if (!address) { return; }

    // Update abbreviated address displays in navbar
    document.querySelectorAll('.wallet-address-display').forEach(function (el) {
      el.textContent = address.slice(0, 6) + '\u2026' + address.slice(-4);
    });

    try {
      var results = await Promise.all([
        fetchOrCreateProfile(address),
        fetchAccess(address)
      ]);
      _profile = results[0];
      _access  = results[1];
      applyCapabilityGates();
      applyUserName(_profile && _profile.name);

      // Notify live_studio.html (and any other panels) that wallet + access are ready
      window.dispatchEvent(new CustomEvent('msp:walletConnected', { detail: { address: address } }));
      fetch('/api/check-platform-nft', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ wallet: address })
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (_access && data.account_type !== _access.account_type) {
            fetchAccess(address).then(applyCapabilityGates);
          }
        }).catch(function () {});

      // Fix aria-hidden warning
      var walletModal = $('walletModal');
      if (walletModal) {
        walletModal.addEventListener('hide.bs.modal', function () {
          if (document.activeElement instanceof HTMLElement) { document.activeElement.blur(); }
        }, { once: true });
      }
    } catch (err) {
      console.error('Profile/access setup failed:', err.message);
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  PAGE ROUTERS
  // ═══════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async function () {

    // walletConnected fires on session restore now, but restore is async.
    // As a safety net: if wallet address is already set by the time DOMContentLoaded
    // runs, load from cache immediately (no server call).
    if (window.walletAddress) {
      var cached0 = loadProfileCache(window.walletAddress);
      if (cached0 && cached0.user_id) {
        _profile = cached0;
        applyUserName(cached0.name);
      }
    }

    // ─── LISTEN PAGE ────────────────────────────────────────
    if (location.pathname.endsWith('listen.html')) {

      function showSubscribeError(btn, msg) {
        var existing = btn.parentNode.querySelector('.subscribe-error');
        if (existing) existing.remove();
        var el = document.createElement('p');
        el.className = 'subscribe-error text-danger small mt-2 mb-0';
        el.textContent = msg;
        btn.insertAdjacentElement('afterend', el);
      }
      function clearSubscribeError(btn) {
        var existing = btn.parentNode.querySelector('.subscribe-error');
        if (existing) existing.remove();
      }

      document.querySelectorAll('[data-subscribe-plan]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          if (!window.walletAddress) {
            if (typeof window.openWalletModal === 'function') { window.openWalletModal(); }
            showSubscribeError(btn, 'Connect your wallet first, then try again.');
            return;
          }
          var plan = btn.dataset.subscribePlan;
          clearSubscribeError(btn);
          btn.disabled    = true;
          btn.textContent = 'Processing\u2026';
          try {
            var data = await subscribePlan(plan);
            btn.textContent = '\u2714 Subscribed!';
            btn.className   = btn.className.replace('btn-primary','btn-success').replace('btn-warning','btn-success').replace('btn-secondary','btn-success');
            var statusEl = $('subscription-status');
            if (statusEl) { statusEl.textContent = 'Active \u2014 expires ' + new Date(data.expiry).toLocaleDateString(); }
          } catch (err) {
            btn.disabled    = false;
            btn.textContent = 'Subscribe';
            showSubscribeError(btn, err.message);
          }
        });
      });

      // ── Favorites section ─────────────────────────────────────────────
      async function renderFavoritesSection() {
        var favSection = $('favorites-section');
        var favList    = $('favorites-list');
        if (!favSection || !favList) return;
        if (!CAN.favorite() || !window.walletAddress) {
          favSection.style.display = 'none';
          return;
        }
        favSection.style.display = '';
        var cids = Array.from(getFavorites());
        if (!cids.length) {
          favList.innerHTML = '<p class="text-muted small py-2">No favorites yet. Heart a track to save it here.</p>';
          return;
        }
        favList.innerHTML = cids.map(function (cid) {
          var short = cid.slice(0, 8);
          var isFav = true;
          return '<div class="fav-list-row d-flex align-items-center gap-2 py-1">' +
            '<button class="fav-btn fav-active" data-fav-cid="' + cid + '" aria-label="Remove from Favorites">♥</button>' +
            '<button class="btn btn-sm btn-link p-0 play-fav" data-cid="' + cid + '">▶ ' + short + '…</button>' +
            '<span class="ms-auto fav-convert-check"><input type="checkbox" class="fav-select" data-cid="' + cid + '" title="Select for playlist"></span>' +
          '</div>';
        }).join('');

        // Wire play buttons
        favList.querySelectorAll('.play-fav').forEach(function (btn) {
          btn.addEventListener('click', function () {
            playContent(btn.dataset.cid, null, null, { live: false })
              .catch(function (e) { console.warn(e.message); });
          });
        });

        // Wire fav (remove) buttons — reuse makeFavButton logic via _syncHeartButtons
        _syncHeartButtons();

        // Convert-to-playlist button
        var convertBtn = $('fav-convert-btn');
        if (convertBtn) {
          convertBtn.onclick = async function () {
            var selected = Array.from(favList.querySelectorAll('.fav-select:checked')).map(function (c) { return c.dataset.cid; });
            if (!selected.length) { alert('Check at least one track to add to a playlist.'); return; }
            var name = prompt('Name your playlist:');
            if (!name || !name.trim()) return;
            try {
              var res = await fetch('/api/favorites/convert-to-playlist', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: window.walletAddress, name: name.trim(), cids: selected }),
              });
              var data = await res.json();
              if (!res.ok) throw new Error(data.error);
              alert('✔ Playlist “' + name + '” created!');
            } catch (e) { alert('Failed: ' + e.message); }
          };
        }
      }
      renderFavoritesSection();

      (async function () {
        try {
          await loadNFTs('library-list');

          var trendingEl = $('trending-playlists');
          var newEl      = $('new-playlists');
          if (trendingEl || newEl) {
            var playlists = await fetch('/api/playlists').then(function (r) { return r.ok ? r.json() : []; });
            var markup = playlists.map(function (p) {
              return '<div class="col-md-4 mb-3"><div class="nft-card">' +
                '<img src="' + (p.cover_image || '').replace('ipfs://', GATEWAY()) + '" alt="' + p.name + '" style="width:100%;max-width:200px;aspect-ratio:1/1;object-fit:cover;">' +
                '<div class="p-2"><h5>' + p.name + '</h5>' +
                '<p class="small text-muted">Curator: ' + (p.curator || 'User') + '</p>' +
                '<button class="btn btn-primary btn-sm play-playlist" data-playlistid="' + p.id + '">\u25B6 Play</button>' +
                '</div></div></div>';
            }).join('');
            if (trendingEl) { trendingEl.innerHTML = markup; }
            if (newEl)      { newEl.innerHTML      = markup; }
            document.querySelectorAll('.play-playlist').forEach(function (btn) {
              btn.addEventListener('click', function () {
                playContent('mockcid', null, null, { live: false, playlistId: btn.dataset.playlistid }).catch(function (e) { alert(e.message); });
              });
            });
          }

          var liveConcertsEl = $('live-concerts');
          if (liveConcertsEl) {
            var concerts = await fetch('/api/live-concerts').then(function (r) { return r.ok ? r.json() : []; });
            if (!concerts.length) {
              liveConcertsEl.innerHTML = '<p class="text-muted small">No live concerts right now. Check back soon.</p>';
            } else {
              liveConcertsEl.innerHTML = concerts.map(function (c) {
                return '<div class="col-md-4 mb-3"><div class="nft-card">' +
                  '<div class="p-2" style="background:#1a0a06;border-radius:6px;">' +
                  '<h5>\uD83D\uDD34 Live: ' + (c.title || c.artist) + '</h5>' +
                  '<p class="small text-muted mb-1">' + c.artist + ' &middot; ' + (c.viewerCount || 0) + ' watching</p>' +
                  '<div class="d-flex gap-1">' +
                  '<button class="btn btn-danger btn-sm join-concert"' +
                    ' data-sessionid="' + c.sessionId + '"' +
                    ' data-hlsurl="' + (c.hlsUrl || '') + '"' +
                    ' data-artist="' + (c.artistWallet || '') + '"' +
                    ' data-title="' + (c.title || 'Live Stream') + '">' +
                    'Join Live</button>' +
                  '</div></div></div></div>';
              }).join('');
            }
            document.querySelectorAll('.join-concert').forEach(function (btn) {
              btn.addEventListener('click', async function () {
                try {
                  var hlsUrl = btn.dataset.hlsurl;
                  if (!hlsUrl) { alert('No stream URL available.'); return; }

                  // Live streams: play HLS directly — no IPFS metadata fetch needed
                  if (typeof window.playHls !== 'function') {
                    alert('Player not ready. Please refresh the page.');
                    return;
                  }
                  window.playHls(hlsUrl, null);

                  if (btn.dataset.artist) {
                    renderTipButton(btn.parentElement, { toWallet: btn.dataset.artist, tipType: 'artist', label: 'Tip Artist' });
                  }
                } catch (e) { alert(e.message); }
              });
            });
          }
        } catch (e) { console.debug('Listen page load failed:', e.message); }
      })();
    }

    // ─── CREATORS PAGE ──────────────────────────────────────
    if (location.pathname.endsWith('creators.html')) {

      // ── Content type tab switcher ─────────────────────────────────────
      var typeReqs = {
        music:        'Audio ≥ 128 kbps · 44.1/48 kHz · MP3, WAV, OGG, FLAC, AAC, M4A · max 500 MB',
        podcast:      'Audio ≥ 128 kbps · MP3, WAV, OGG, AAC, M4A · max 500 MB',
        video:        'MP4, MOV, MKV, WebM · min 500 kbps video · audio required · max 500 MB',
        art_still:    'Any supported media · no encoding — uploaded directly to IPFS · max 500 MB',
        art_animated: 'MP4, WebM · video required · max 500 MB',
      };
      var typeAccept = {
        music:        'audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a',
        podcast:      'audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/mp4,audio/x-m4a',
        video:        'video/mp4,video/quicktime,video/x-matroska,video/webm',
        art_still:    'audio/mpeg,audio/wav,video/mp4,video/webm,image/png,image/jpeg',
        art_animated: 'video/mp4,video/webm',
      };
      var typeHint = {
        music:        'MP3 · WAV · OGG · FLAC · AAC · M4A',
        podcast:      'MP3 · WAV · OGG · AAC · M4A',
        video:        'MP4 · MOV · MKV · WebM',
        art_still:    'MP3 · WAV · MP4 · WebM · PNG · JPG',
        art_animated: 'MP4 · WebM',
      };
      var typeDropIcon = {
        music: '♪', podcast: '🎙', video: '▶', art_still: '◈', art_animated: '◉',
      };

      var currentType  = 'music';
      var audioFileInput   = $('audio-file');
      var contentTypeField = $('content-type-field');
      var reqsEl           = $('upload-reqs');
      var dropHintEl       = $('drop-hint');
      var dropIconEl       = $('drop-icon');

      document.querySelectorAll('.utype-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          currentType = btn.dataset.type;
          document.querySelectorAll('.utype-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');

          if (contentTypeField) contentTypeField.value = currentType;
          if (reqsEl)           reqsEl.textContent     = typeReqs[currentType];
          if (dropHintEl)       dropHintEl.textContent = typeHint[currentType];
          if (dropIconEl)       dropIconEl.textContent = typeDropIcon[currentType] || '↑';
          if (audioFileInput)   audioFileInput.accept  = typeAccept[currentType];

          // Show/hide type-specific field groups
          ['music', 'podcast'].forEach(function (t) {
            var el = $('fields-' + t);
            if (el) el.style.display = (currentType === t) ? '' : 'none';
          });
          var rightsEl = $('fields-rights');
          if (rightsEl) rightsEl.style.display =
            (currentType === 'music' || currentType === 'podcast') ? '' : 'none';

          // Update submit button text
          var btnText = $('upload-btn-text');
          if (btnText) {
            var labels = {
              music: '↑ Upload & Mint', podcast: '↑ Upload Podcast',
              video: '↑ Upload Video', art_still: '↑ Upload Art',
              art_animated: '↑ Upload Animated Art',
            };
            btnText.textContent = (CAN.mintNFT() && currentType !== 'podcast')
              ? (labels[currentType] || '↑ Upload & Mint')
              : '↑ Upload';
          }
        });
      });

      // ── Tags live preview ──────────────────────────────────────────────
      var tagsInput   = $('tags');
      var tagsPreview = $('tags-preview');
      if (tagsInput && tagsPreview) {
        tagsInput.addEventListener('input', function () {
          var chips = tagsInput.value.split(',')
            .map(function (t) { return t.trim(); })
            .filter(Boolean);
          tagsPreview.innerHTML = chips.map(function (t) {
            return '<span class="tag-chip">' + t.replace(/[<>&"]/g, '') + '</span>';
          }).join('');
        });
      }

      // ── Cover image preview ────────────────────────────────────────────
      var coverInput    = $('cover-image');
      var coverPreview  = $('cover-preview');
      var coverImg      = $('cover-preview-img');
      var coverPH       = $('cover-placeholder');
      var coverClearBtn = $('cover-clear');
      var coverDropEl   = $('cover-drop');
      var coverBrowse   = $('cover-browse-btn');

      function showCoverPreview(file) {
        if (!file || !coverImg) return;
        var reader = new FileReader();
        reader.onload = function (e) {
          coverImg.src = e.target.result;
          if (coverPreview) coverPreview.style.display = 'block';
          if (coverPH)      coverPH.style.display      = 'none';
        };
        reader.readAsDataURL(file);
      }

      if (coverInput) {
        coverInput.addEventListener('change', function () {
          if (coverInput.files && coverInput.files[0]) showCoverPreview(coverInput.files[0]);
        });
      }
      if (coverBrowse) coverBrowse.addEventListener('click', function () { if (coverInput) coverInput.click(); });
      if (coverDropEl) coverDropEl.addEventListener('click', function (e) {
        if (e.target === coverClearBtn) return;
        if (coverInput) coverInput.click();
      });
      if (coverClearBtn) coverClearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (coverInput) coverInput.value = '';
        if (coverPreview) coverPreview.style.display = 'none';
        if (coverPH)      coverPH.style.display      = '';
        if (coverImg)     coverImg.src                = '';
      });

      // ── Audio drop zone ───────────────────────────────────────────────
      var dragDropArea = $('drag-drop-area');
      var dropInner    = $('drop-zone-inner');
      var browseBtn    = $('browse-btn');
      var releaseDateInput = $('release-date');
      var dateCreatedInput = $('date-created');

      function showFileName(name) {
        if (!dragDropArea) return;
        dragDropArea.classList.add('has-file');
        if (dropIconEl) dropIconEl.textContent = '✔';
        var primary = dragDropArea.querySelector('.drop-primary');
        if (primary) primary.textContent = name;
        var secondary = dragDropArea.querySelector('.drop-secondary');
        if (secondary) secondary.innerHTML =
          '<button type="button" id="browse-btn-change" class="drop-browse">Change file</button>';
        var changeBtn = $('browse-btn-change');
        if (changeBtn) changeBtn.addEventListener('click', function () { if (audioFileInput) audioFileInput.click(); });
      }

      function handleFileSelection() {
        if (!audioFileInput || !audioFileInput.files || !audioFileInput.files.length) return;
        var file     = audioFileInput.files[0];
        var fileDate = new Date(file.lastModified);
        if (dateCreatedInput) dateCreatedInput.value = fileDate.toISOString().split('T')[0];
        if (releaseDateInput && !releaseDateInput.value) releaseDateInput.value = new Date().toISOString().split('T')[0];
        showFileName(file.name);
      }

      if (browseBtn && audioFileInput) {
        browseBtn.addEventListener('click', function (e) { e.preventDefault(); audioFileInput.click(); });
      }
      if (audioFileInput) {
        audioFileInput.addEventListener('change', handleFileSelection);
      }
      if (dragDropArea && audioFileInput) {
        dragDropArea.addEventListener('dragover', function (e) { e.preventDefault(); dragDropArea.classList.add('drag-over'); });
        dragDropArea.addEventListener('dragleave', function () { dragDropArea.classList.remove('drag-over'); });
        dragDropArea.addEventListener('drop', function (e) {
          e.preventDefault();
          dragDropArea.classList.remove('drag-over');
          var files = e.dataTransfer.files;
          if (!files || !files.length) return;
          try { var dt = new DataTransfer(); dt.items.add(files[0]); audioFileInput.files = dt.files; } catch (_) {}
          handleFileSelection();
        });
      }

      // ── Mint NFT toggle ────────────────────────────────────────────────
      var mintNftCheckbox = $('mint-nft');
      var mintChainWrap   = $('mint-chain-wrap');
      if (mintNftCheckbox && mintChainWrap) {
        mintChainWrap.style.display = mintNftCheckbox.checked ? '' : 'none';
        mintNftCheckbox.addEventListener('change', function () {
          mintChainWrap.style.display = mintNftCheckbox.checked ? '' : 'none';
        });
      }

      // ── Live encode form (unchanged) ───────────────────────────────────
      var liveForm = $('liveEncodeForm');
      if (liveForm) {
        liveForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (!CAN.hostConcert()) { return alert('An active Creator subscription is required to host live concerts.'); }
          var eventTitle = $('eventTitle') ? $('eventTitle').value.trim() : '';
          var artistName = $('artistName') ? $('artistName').value.trim() : '';
          var statusEl   = $('liveStatus');
          if (!eventTitle || !artistName) {
            if (statusEl) { statusEl.textContent = 'Please fill in both fields.'; statusEl.className = 'text-danger'; }
            return;
          }
          if (statusEl) { statusEl.textContent = 'Starting live…'; statusEl.className = ''; }
          try {
            var addr2 = requireSigner().address;
            var data2 = await startLiveEncode(addr2, eventTitle, artistName);
            if (statusEl) {
              statusEl.innerHTML = '✔ Live started! <a href="' + data2.hlsUrl + '" target="_blank">Watch Stream</a><br><small>ID: ' + data2.productionID + '</small>';
              statusEl.className = 'text-success';
            }
          } catch (err) {
            if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.className = 'text-danger'; }
          }
        });
      }

      // ── DJ set form (unchanged) ────────────────────────────────────────
      var djSetForm = $('dj-set-form');
      if (djSetForm) {
        djSetForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (!CAN.hostDjSet()) { return alert('A Tier 2 or higher subscription is required to host DJ sets.'); }
          var setName    = $('dj-set-name')    ? $('dj-set-name').value.trim()    : '';
          var tipsToggle = $('dj-tips-enabled');
          var djPctInput = $('dj-tip-percent');
          var statusEl2  = $('dj-set-status');
          if (!setName) { return alert('Please enter a set name.'); }
          try {
            var result = await startDjSet({
              setName:      setName,
              tipsEnabled:  tipsToggle ? tipsToggle.checked : undefined,
              djPercent:    djPctInput ? parseFloat(djPctInput.value) : 100,
              artistSplits: []
            });
            if (statusEl2) { statusEl2.textContent = '✔ DJ Set started! ID: ' + result.set_id; statusEl2.className = 'text-success mt-2'; }
          } catch (err) {
            if (statusEl2) { statusEl2.textContent = 'Error: ' + err.message; statusEl2.className = 'text-danger mt-2'; }
          }
        });
      }

      // ── Upload form submit ─────────────────────────────────────────────
      var uploadForm   = $('upload-form');
      var uploadBtn    = $('upload-btn');
      var uploadStatus = $('upload-status');
      var progressEl   = $('upload-progress');

      function setLoading(on) {
        if (uploadBtn) uploadBtn.disabled = on;
        var btnText = $('upload-btn-text');
        if (btnText) btnText.textContent = on ? 'Processing…' : (
          CAN.mintNFT() ? '↑ Upload & Mint' : '↑ Upload'
        );
        if (progressEl) progressEl.style.display = on ? 'block' : 'none';
        if (uploadStatus && !on) uploadStatus.style.display = 'none';
      }

      function setUploadStatus(msg, type) {
        if (!uploadStatus) return;
        uploadStatus.textContent   = msg;
        uploadStatus.className     = type || '';
        uploadStatus.style.display = msg ? 'block' : 'none';
      }

      if (uploadForm) {
        uploadForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          var address;
          try { address = requireSigner().address; }
          catch (err) { setUploadStatus(err.message, 'error'); return; }

          if (!CAN.upload()) {
            setUploadStatus('A Creator account is required to upload. Subscribe on the listen page.', 'error');
            return;
          }
          if (!audioFileInput || !audioFileInput.files || !audioFileInput.files.length) {
            setUploadStatus('Please select a media file.', 'error'); return;
          }
          var coverEl = $('cover-image');
          if (!coverEl || !coverEl.files || !coverEl.files.length) {
            setUploadStatus('Please select a cover image.', 'error'); return;
          }
          var tagsVal = ($('tags') || {}).value || '';
          if (tagsVal.split(',').map(function(t){return t.trim();}).filter(Boolean).length < 3) {
            setUploadStatus('Please add at least 3 tags.', 'error'); return;
          }

          setLoading(true);
          setUploadStatus('Uploading…');

          try {
            var profile2 = getProfile();
            if (!profile2 || !profile2.user_id) throw new Error('Profile missing. Reconnect your wallet.');

            var formData = new FormData(uploadForm);
            formData.set('userId', profile2.user_id);
            formData.set('wallet', address);
            formData.set('contentType', currentType);

            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload');
            xhr.upload.onprogress = function (evt) {
              if (!progressEl || !evt.lengthComputable) return;
              progressEl.value = Math.round((evt.loaded / evt.total) * 95); // leave 5% for IPFS
            };
            xhr.onload = async function () {
              try {
                var ct = xhr.getResponseHeader('content-type') || '';
                if (xhr.status !== 200) {
                  var errMsg = 'Server error ' + xhr.status;
                  if (ct.includes('application/json')) {
                    try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch (_) {}
                  }
                  throw new Error(errMsg);
                }
                var data3 = JSON.parse(xhr.responseText);
                if (progressEl) progressEl.value = 100;

                // Certificate registration (non-blocking if chain not ready)
                if (data3.caSignature) {
                  await registerCertificate(data3.metadataCid, currentType, data3.caSignature).catch(function (e) {
                    console.warn('Certificate registration skipped:', e.message);
                  });
                }

                // NFT mint
                var shouldMint = data3.mint_pending && CAN.mintNFT() && currentType !== 'podcast';
                if (shouldMint) {
                  setUploadStatus('Minting NFT on-chain…');
                  var songTitle  = ($('song-title')  || {}).value || 'Untitled';
                  var artistNm   = ($('artist-name') || {}).value || 'Unknown';
                  var rdInput    = $('release-date');
                  var year       = rdInput && rdInput.value ? new Date(rdInput.value).getFullYear() : new Date().getFullYear();
                  await mintNftEth(profile2, { songTitle: songTitle, artistName: artistNm, year: year, metadataUrl: data3.metadataUrl });
                  setUploadStatus('✔ Uploaded, certified, and NFT minted!', 'success');
                } else {
                  setUploadStatus('✔ Upload complete! Content saved to your catalog.', 'success');
                }

                // Auto-play if audio/video
                if ((currentType === 'music' || currentType === 'podcast') && typeof window.playHls === 'function' && data3.hlsUrl) {
                  window.playHls(data3.hlsUrl.replace('ipfs://', GATEWAY()), data3.metadataUrl);
                }

                // Reset form
                uploadForm.reset();
                if (dragDropArea) dragDropArea.classList.remove('has-file');
                if (coverPreview) { coverPreview.style.display = 'none'; }
                if (coverPH)      { coverPH.style.display = ''; }
                if (tagsPreview)  tagsPreview.innerHTML = '';

              } catch (err) {
                setUploadStatus('Failed: ' + err.message, 'error');
              }
              setLoading(false);
            };
            xhr.onerror = function () {
              setUploadStatus('Network error — check your connection and try again.', 'error');
              setLoading(false);
            };
            xhr.send(formData);
          } catch (err) {
            setUploadStatus(err.message, 'error');
            setLoading(false);
          }
        });
      }
    } // end creators.html

    // ─── MARKETPLACE PAGE ───────────────────────────────────
    if (location.pathname.endsWith('marketplace.html')) {
      await loadNFTs('marketplace-list');
    }

    // ─── PROFILE PAGE ───────────────────────────────────────
    if (location.pathname.endsWith('profile.html')) {

      if (window.walletAddress) {
        var addrEl = $('profile-address');
        if (addrEl) { addrEl.textContent = window.walletAddress.slice(0,6) + '\u2026' + window.walletAddress.slice(-4); }
      }

      var accountTypeEl = $('account-type-display');
      if (accountTypeEl) {
        var labels = {
          'none':               'No active subscription',
          'listener_1':         'Listener \u2014 Tier 1',
          'listener_2':         'Listener \u2014 Tier 2',
          'listener_3':         'Listener \u2014 Tier 3',
          'creator_active':     'Creator (Active)',
          'creator_inactive':   'Creator (Inactive \u2014 renew subscription)',
          'nft_creator_active': 'Platform NFT Creator (Active)',
          'nft_creator_passive':'Platform NFT Creator (Passive \u2014 subscribe for full tools)'
        };
        accountTypeEl.textContent = labels[getAccess().level || 'none'] || (getAccess().level || 'none');
      }

      await loadNFTs('user-nfts');

      // ── Profile favorites panel ─────────────────────────────────────────
      var profFavList  = $('profile-favorites-list');
      var profFavCount = $('profile-favorites-count');
      if (profFavList && window.walletAddress && CAN.favorite()) {
        await loadFavorites(window.walletAddress);
        var favCids = Array.from(getFavorites());
        if (profFavCount) profFavCount.textContent = favCids.length;
        if (!favCids.length) {
          profFavList.innerHTML = '<p class="text-muted small">No favorites yet.</p>';
        } else {
          profFavList.innerHTML = favCids.map(function (cid) {
            return '<div class="d-flex align-items-center gap-2 py-1 border-bottom border-dark">' +
              '<button class="fav-btn fav-active" data-fav-cid="' + cid + '">♥</button>' +
              '<span class="font-monospace small text-muted">' + cid.slice(0, 12) + '…</span>' +
            '</div>';
          }).join('');
          _syncHeartButtons();
        }
      }

      var splitsForm = $('splits-form');
      if (splitsForm) {
        splitsForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (!CAN.setSplits()) { return alert('Creator account required to set royalty splits.'); }
          var cid          = $('splits-cid')           ? $('splits-cid').value.trim()           : '';
          var artist       = parseFloat($('split-artist')        ? $('split-artist').value        : '0');
          var nftHolders   = parseFloat($('split-nft-holders')   ? $('split-nft-holders').value   : '0');
          var activityPool = parseFloat($('split-activity-pool') ? $('split-activity-pool').value : '0');
          var passWallet   = $('split-passive-wallet')  ? $('split-passive-wallet').value.trim()  : '';
          var passPct      = parseFloat($('split-passive-pct')   ? $('split-passive-pct').value   : '0');
          if (!cid) { return alert('Please enter a content CID.'); }
          var passive = (passWallet && passPct > 0) ? [{ wallet: passWallet, percent: passPct }] : [];
          var total   = artist + nftHolders + activityPool + passive.reduce(function (s, p) { return s + p.percent; }, 0);
          if (Math.abs(total - 100) > 0.01) { return alert('Splits must total 100%. Currently: ' + total.toFixed(2) + '%'); }
          try {
            await submitRoyaltySplits(cid, { artist: artist, nft_holders: nftHolders, activity_pool: activityPool, passive: passive });
            alert('\u2714 Royalty splits saved!');
          } catch (err) { alert('Failed: ' + err.message); }
        });
      }

      var claimNftBtn = $('claim-platform-nft-btn');
      if (claimNftBtn) {
        claimNftBtn.addEventListener('click', async function () {
          if (!window.walletAddress) { return alert('Connect wallet first.'); }
          claimNftBtn.disabled    = true;
          claimNftBtn.textContent = 'Verifying\u2026';
          try {
            var res2  = await fetch('/api/claim-platform-nft', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ wallet: window.walletAddress })
            });
            var data4 = await res2.json();
            if (!res2.ok) { throw new Error(data4.error); }
            _access = await fetchAccess(window.walletAddress);
            applyCapabilityGates();
            claimNftBtn.textContent = '\u2714 Platform NFT Activated!';
            claimNftBtn.className   = claimNftBtn.className.replace('btn-warning','btn-success');
            alert(data4.message);
          } catch (err) {
            claimNftBtn.disabled    = false;
            claimNftBtn.textContent = 'Claim Platform NFT';
            alert('Claim failed: ' + err.message);
          }
        });
      }

      var supporterToggle = $('supporter-subaccount-toggle');
      if (supporterToggle) {
        supporterToggle.checked = getAccess().supporter_enabled || false;
        supporterToggle.addEventListener('change', async function () {
          if (!CAN.supporterSub()) { supporterToggle.checked = false; return alert('Only creator accounts can enable a supporter sub-account.'); }
          var enabled  = supporterToggle.checked;
          var endpoint = enabled ? '/api/add-supporter-subaccount' : '/api/toggle-supporter-subaccount';
          var body     = enabled ? { wallet: window.walletAddress } : { wallet: window.walletAddress, enabled: false };
          try {
            await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            var st = $('supporter-subaccount-status');
            if (st) { st.textContent = enabled ? 'Supporter sub-account enabled.' : 'Supporter sub-account disabled.'; }
          } catch (err) { supporterToggle.checked = !enabled; alert('Toggle failed: ' + err.message); }
        });
      }

      var djTipToggle = $('dj-tips-default-toggle');
      if (djTipToggle) {
        djTipToggle.checked = getAccess().dj_tips_default !== false;
        djTipToggle.addEventListener('change', async function () {
          await fetch('/api/update-profile', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ wallet: window.walletAddress, djTipsDefault: djTipToggle.checked })
          });
        });
      }

      var playlistForm = $('playlist-form');
      if (playlistForm) {
        playlistForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          if (!CAN.createPlaylist()) { return alert('Tier 2 or higher subscription required to create playlists.'); }
          var tracks = ($('playlist-tracks') ? $('playlist-tracks').value : '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
          if (!tracks.length) { return alert('Add at least one CID per line.'); }
          var playlist = { id: crypto.randomUUID(), curator: window.walletAddress, tracks: tracks, sharePercent: 8 };
          try {
            var res3 = await fetch('/api/create-playlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(playlist) });
            if (!res3.ok) { throw new Error(await res3.text()); }
            alert('\u2714 Playlist created!');
          } catch (err) { alert('Failed: ' + err.message); }
        });
      }
    } // end profile.html

  }); // end DOMContentLoaded

})();
