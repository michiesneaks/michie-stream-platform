// public/Scripts/wallets.js
// Drop-in replacement — no wallet-boot.js needed.
// Handles: modal open, MetaMask/Coinbase/Phantom/Solflare/Zcash connect,
//          global state (window.walletAddress / ethersProvider / ethersSigner),
//          UI updates, disconnect, session restore, account-change listeners,
//          mobile deep links, ethers v5 + v6 compatibility.
'use strict';

(function () {

  // ─────────────────────────────────────────────
  // 1.  Constants & tiny helpers
  // ─────────────────────────────────────────────
  const SESSION_KEY = 'msp_wallet';   // localStorage key  { address, type }
  const isMobile    = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const origin      = location.origin;

  /** Lazy DOM lookups — called only after DOMContentLoaded */
  const el = {
    connectBtns  : () => document.querySelectorAll('[data-connect-wallet]'),
    disconnect   : () => document.getElementById('btn-disconnect'),
    addrDisplay  : () => document.getElementById('walletAddress'),
    help         : () => document.getElementById('wallet-help'),
    modalEl      : () => document.getElementById('walletModal'),
  };

  function setHelp(msg, isError = false) {
    const h = el.help();
    if (!h) return;
    h.textContent = msg || '';
    h.className   = isError
      ? 'small text-danger mt-3'
      : 'small text-secondary mt-3';
  }

  /**
   * Show a help message with an optional install link rendered inline.
   * Never force-opens a new tab — the user clicks if they want to install.
   */
  function setHelpNotInstalled(walletName, installUrl, deepLinkUrl) {
    const h = el.help();
    if (!h) return;
    h.className = 'small text-warning mt-3';
    h.innerHTML = '';
    const msg  = document.createTextNode(walletName + ' extension not detected. ');
    const link = document.createElement('a');
    link.href        = installUrl;
    link.target      = '_blank';
    link.rel         = 'noopener noreferrer';
    link.textContent = 'Install ' + walletName;
    link.className   = 'text-warning';
    const msg2 = document.createTextNode(', then refresh this page.');
    h.appendChild(msg);
    h.appendChild(link);
    h.appendChild(msg2);
    // Mobile deep-link: only redirect inside the wallet browser, never to the app store
    if (isMobile && deepLinkUrl) {
      location.href = deepLinkUrl;
    }
  }

  function openNew(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** openNew kept for any future utility use */
  // (tryDeepLink removed — mobile deep-links handled inside setHelpNotInstalled)

  // ─────────────────────────────────────────────
  // 2.  Ethers v5 / v6 compatibility
  // ─────────────────────────────────────────────
  function ethersVersion() {
    // v6 exposes BrowserProvider; v5 exposes providers.Web3Provider
    if (typeof window.ethers?.BrowserProvider === 'function') return 6;
    if (typeof window.ethers?.providers?.Web3Provider === 'function') return 5;
    return null;
  }

  async function buildProviderAndSigner(rawProvider) {
    const ver = ethersVersion();
    if (ver === 6) {
      const provider = new window.ethers.BrowserProvider(rawProvider);
      const signer   = await provider.getSigner();
      return { provider, signer };
    }
    if (ver === 5) {
      const provider = new window.ethers.providers.Web3Provider(rawProvider);
      await provider.send('eth_requestAccounts', []);
      const signer = provider.getSigner();
      return { provider, signer };
    }
    // ethers not loaded — store raw address only, no signer
    console.warn('[wallets] ethers not found — provider/signer unavailable');
    return { provider: null, signer: null };
  }

  // ─────────────────────────────────────────────
  // 3.  Global state writers
  // ─────────────────────────────────────────────
  function setGlobals(address, provider, signer) {
    window.walletAddress   = address  || null;
    window.ethersProvider  = provider || null;
    window.ethersSigner    = signer   || null;
  }

  function clearGlobals() {
    setGlobals(null, null, null);
  }

  // ─────────────────────────────────────────────
  // 4.  UI helpers
  // ─────────────────────────────────────────────
  function formatAddr(address) {
    if (!address || address.length < 10) return address || '';
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function setConnectedUI(address) {
    const display = formatAddr(address);

    // All "Connect Wallet" buttons on the page
    el.connectBtns().forEach(btn => {
      btn.textContent = 'Connected';
      btn.disabled    = true;
    });

    // Address display
    const addrEl = el.addrDisplay();
    if (addrEl) addrEl.textContent = display;

    // Disconnect button
    const dc = el.disconnect();
    if (dc) dc.classList.remove('d-none');

    // Persist for session restore
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...saved, address }));
  }

  function setDisconnectedUI() {
    el.connectBtns().forEach(btn => {
      btn.textContent = 'Connect Wallet';
      btn.disabled    = false;
    });

    const addrEl = el.addrDisplay();
    if (addrEl) addrEl.textContent = '';

    const dc = el.disconnect();
    if (dc) dc.classList.add('d-none');

    localStorage.removeItem(SESSION_KEY);
    setHelp('');
  }

  /** Close the Bootstrap modal if it's open */
  function closeModal() {
    const modalEl = el.modalEl();
    if (!modalEl || !window.bootstrap) return;
    try {
      bootstrap.Modal.getInstance(modalEl)?.hide();
    } catch (_) {}
  }

  /** Open the Bootstrap modal — exposed as window.openWalletModal for main.js */
  function openWalletModal() {
    const modalEl = el.modalEl();
    if (!modalEl || !window.bootstrap) {
      console.warn('[wallets] Bootstrap modal not available');
      return;
    }
    try {
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.show();
    } catch (e) {
      console.error('[wallets] Could not open wallet modal:', e);
    }
  }
  window.openWalletModal = openWalletModal;

  // ─────────────────────────────────────────────
  // 5.  EVM provider utilities
  // ─────────────────────────────────────────────
  function getInjectedProviders() {
    const eth = window.ethereum;
    if (!eth) return [];
    if (Array.isArray(eth.providers) && eth.providers.length) return eth.providers;
    return [eth];
  }

  function findProvider(predicate) {
    for (const p of getInjectedProviders()) {
      try { if (predicate(p)) return p; } catch (_) {}
    }
    return null;
  }

  const getMetaMaskProvider = () => findProvider(p => p.isMetaMask && !p.isCoinbaseWallet);
  const getCoinbaseProvider = () => findProvider(p => p.isCoinbaseWallet);
  const getAnyEvmProvider   = () => findProvider(() => true);

  /** Request accounts and build ethers objects for an EVM provider */
  async function connectEvmProvider(raw) {
    const accounts = await raw.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts[0]) throw new Error('No accounts returned from wallet.');
    const address = accounts[0];
    const { provider, signer } = await buildProviderAndSigner(raw);
    return { address, provider, signer, raw };
  }

  /** Wire accountsChanged / disconnect events so the UI stays in sync */
  function wireEvmEvents(raw) {
    const onAccountsChanged = async (accounts) => {
      if (accounts && accounts[0]) {
        const { provider, signer } = await buildProviderAndSigner(raw).catch(() => ({}));
        setGlobals(accounts[0], provider, signer);
        setConnectedUI(accounts[0]);
      } else {
        clearGlobals();
        setDisconnectedUI();
      }
    };
    const onDisconnect = () => { clearGlobals(); setDisconnectedUI(); };

    // Remove stale listeners before adding (prevents duplicates on re-connect)
    try { raw.removeListener('accountsChanged', onAccountsChanged); } catch (_) {}
    try { raw.removeListener('disconnect',       onDisconnect);      } catch (_) {}
    raw.on?.('accountsChanged', onAccountsChanged);
    raw.on?.('disconnect',      onDisconnect);
  }

  // ─────────────────────────────────────────────
  // 6.  Connect handlers
  // ─────────────────────────────────────────────
  async function connectMetaMask() {
    setHelp('Connecting to MetaMask…');
    try {
      const raw = getMetaMaskProvider();
      if (!raw) {
        setHelpNotInstalled(
          'MetaMask',
          'https://metamask.io/download/',
          `https://metamask.app.link/dapp/${location.host}`
        );
        return;
      }
      const { address, provider, signer } = await connectEvmProvider(raw);
      setGlobals(address, provider, signer);
      setConnectedUI(address);
      wireEvmEvents(raw);
      setHelp(`Connected: ${formatAddr(address)}`);
      closeModal();
      notifyConnected(address);
    } catch (e) {
      setHelp(`MetaMask: ${e.message || e}`, true);
    }
  }

  async function connectCoinbase() {
    setHelp('Connecting to Coinbase Wallet…');
    try {
      const raw = getCoinbaseProvider();
      if (!raw) {
        setHelpNotInstalled(
          'Coinbase Wallet',
          'https://www.coinbase.com/wallet/downloads',
          `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(origin)}`
        );
        return;
      }
      const { address, provider, signer } = await connectEvmProvider(raw);
      setGlobals(address, provider, signer);
      setConnectedUI(address);
      wireEvmEvents(raw);
      setHelp(`Connected: ${formatAddr(address)}`);
      closeModal();
      notifyConnected(address);
    } catch (e) {
      setHelp(`Coinbase Wallet: ${e.message || e}`, true);
    }
  }

  async function connectPhantom() {
    setHelp('Connecting to Phantom…');
    try {
      const provider = window.solana;
      if (!provider?.isPhantom) {
        setHelpNotInstalled(
          'Phantom',
          'https://phantom.app/download',
          `https://phantom.app/ul/browse/${encodeURIComponent(origin)}`
        );
        return;
      }
      const resp    = await provider.connect({ onlyIfTrusted: false });
      const address = resp.publicKey?.toBase58?.() || String(resp.publicKey);
      setGlobals(address, null, null);
      setConnectedUI(address);
      setHelp(`Connected: ${formatAddr(address)}`);
      closeModal();

      provider.off?.('disconnect');
      provider.off?.('accountChanged');
      provider.on?.('disconnect', () => { clearGlobals(); setDisconnectedUI(); });
      provider.on?.('accountChanged', (pk) => {
        if (pk) { const a = pk.toBase58?.() || String(pk); setGlobals(a, null, null); setConnectedUI(a); }
        else     { clearGlobals(); setDisconnectedUI(); }
      });

      notifyConnected(address);
    } catch (e) {
      setHelp(`Phantom: ${e.message || e}`, true);
    }
  }

  async function connectSolflare() {
    setHelp('Connecting to Solflare…');
    try {
      const provider = window.solflare || (window.solana?.isSolflare ? window.solana : null);
      if (!provider) {
        setHelpNotInstalled(
          'Solflare',
          'https://solflare.com/download',
          `https://solflare.com/ul/v1/browse/${encodeURIComponent(origin)}`
        );
        return;
      }
      await provider.connect();
      const address = provider.publicKey?.toBase58?.() || String(provider.publicKey);
      setGlobals(address, null, null);
      setConnectedUI(address);
      setHelp(`Connected: ${formatAddr(address)}`);
      closeModal();

      provider.off?.('disconnect');
      provider.off?.('accountChanged');
      provider.on?.('disconnect', () => { clearGlobals(); setDisconnectedUI(); });
      provider.on?.('accountChanged', (pk) => {
        if (pk) { const a = pk.toBase58?.() || String(pk); setGlobals(a, null, null); setConnectedUI(a); }
        else     { clearGlobals(); setDisconnectedUI(); }
      });

      notifyConnected(address);
    } catch (e) {
      setHelp(`Solflare: ${e.message || e}`, true);
    }
  }

  function connectZcash() {
    setHelpNotInstalled('Zcash Wallet', 'https://z.cash/wallets/', null);
  }

  // ─────────────────────────────────────────────
  // 7.  Disconnect
  // ─────────────────────────────────────────────
  async function disconnect() {
    // Solana wallets support real disconnect()
    try { if (window.solana?.isConnected)   await window.solana.disconnect();   } catch (_) {}
    try { if (window.solflare?.isConnected) await window.solflare.disconnect(); } catch (_) {}
    // EVM wallets: no programmatic disconnect — clear app state only
    clearGlobals();
    setDisconnectedUI();
    setHelp('Disconnected. To fully revoke access, use your wallet\'s "Connected Sites" settings.');
  }

  // ─────────────────────────────────────────────
  // 8.  Post-connect hook (lets main.js react)
  //     main.js looks for window.onWalletConnected
  // ─────────────────────────────────────────────
  function notifyConnected(address) {
    if (typeof window.onWalletConnected === 'function') {
      try { window.onWalletConnected(address); } catch (e) { console.error('[wallets] onWalletConnected threw:', e); }
    }
    // Also dispatch a DOM event for flexibility
    document.dispatchEvent(new CustomEvent('walletConnected', { detail: { address } }));
  }

  // ─────────────────────────────────────────────
  // 9.  Session restore
  // ─────────────────────────────────────────────
  async function tryRestoreSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!saved?.address) return;

      // EVM: check if provider still has the account authorised (no prompt)
      const raw = getMetaMaskProvider() || getCoinbaseProvider() || getAnyEvmProvider();
      if (raw) {
        const accounts = await raw.request({ method: 'eth_accounts' }); // no popup
        const match = accounts?.find(a => a.toLowerCase() === saved.address.toLowerCase());
        if (match) {
          const { provider, signer } = await buildProviderAndSigner(raw);
          setGlobals(match, provider, signer);
          setConnectedUI(match);
          wireEvmEvents(raw);
          notifyConnected(match);   // let main.js display the cached name
          return;
        }
      }

      // Solana: check Phantom
      if (window.solana?.isPhantom && window.solana.isConnected) {
        const address = window.solana.publicKey?.toBase58?.();
        if (address && address === saved.address) {
          setGlobals(address, null, null);
          setConnectedUI(address);
          notifyConnected(address); // let main.js display the cached name
          return;
        }
      }

      // Solflare
      if ((window.solflare || window.solana?.isSolflare) && (window.solflare || window.solana)?.isConnected) {
        const prov    = window.solflare || window.solana;
        const address = prov.publicKey?.toBase58?.();
        if (address && address === saved.address) {
          setGlobals(address, null, null);
          setConnectedUI(address);
          notifyConnected(address); // let main.js display the cached name
          return;
        }
      }

      // Could not verify — clear stale session silently
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      console.debug('[wallets] Session restore failed (ok):', e.message);
      localStorage.removeItem(SESSION_KEY);
    }
  }

  // ─────────────────────────────────────────────
  // 10.  DOM wiring (after DOMContentLoaded)
  // ─────────────────────────────────────────────
  function wireDom() {
    // "Connect Wallet" buttons → open modal
    el.connectBtns().forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openWalletModal();
      });
    });

    // Wallet choice buttons inside the modal (delegated, safe for any page)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      switch (btn.id) {
        case 'btn-metamask': connectMetaMask();  break;
        case 'btn-coinbase': connectCoinbase();  break;
        case 'btn-phantom':  connectPhantom();   break;
        case 'btn-solflare': connectSolflare();  break;
        case 'btn-zcash':    connectZcash();     break;
      }
    });

    // Disconnect button
    const dc = el.disconnect();
    if (dc) {
      dc.addEventListener('click', async (e) => {
        e.preventDefault();
        await disconnect();
      });
    }
  }

  // ─────────────────────────────────────────────
  // 11.  Boot
  // ─────────────────────────────────────────────
  function boot() {
    wireDom();
    tryRestoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // ─────────────────────────────────────────────
  // 12.  Public API
  // ─────────────────────────────────────────────
  window.mspWallets = {
    openWalletModal,
    connectMetaMask,
    connectCoinbase,
    connectPhantom,
    connectSolflare,
    connectZcash,
    disconnect,
  };

})();
