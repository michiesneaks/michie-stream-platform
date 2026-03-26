// public/Scripts/common.js
'use strict';

// ===========================
// Config
// ===========================
// Set this in a small inline <script> before common.js in your HTML if needed:
//   window.IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
// Default to a public gateway if not provided.
const IPFS_GATEWAY = (window.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/+$/, '') + '/';

// Helper to turn ipfs://CID/path into https://gateway/ipfs/CID/path
function ipfsToHttp(url) {
  if (typeof url !== 'string') return url;
  if (!url.startsWith('ipfs://')) return url;
  return url.replace(/^ipfs:\/\//, IPFS_GATEWAY);
}

// ===========================
// Audio Player elements (all optional)
// ===========================
const audio           = document.getElementById('audio-player');
const playBtn         = document.getElementById('play-btn');
const pauseBtn        = document.getElementById('pause-btn');
const stopBtn         = document.getElementById('stop-btn');
const progressBar     = document.getElementById('progress-bar');
const volumeBar       = document.getElementById('volume-bar');
const timeDisplay     = document.getElementById('time-display');
const durationDisplay = document.getElementById('duration-display');
const totalPlaysEl    = document.getElementById('total-plays');
const vinylIcon       = document.getElementById('vinyl-icon');

let totalPlays = 0;
let hls = null;

// ===========================
// HLS playback
// ===========================
function ensureHlsAvailable() {
  // Only true if hls.js was loaded globally via <script src=".../hls.min.js"></script>
  return (typeof window !== 'undefined' && window.Hls && typeof window.Hls.isSupported === 'function');
}

/**
 * Play an HLS (or direct) audio URL.
 * If metadataUrl is IPFS EIP-712 metadata with live/rollup info, we'll load the rollup playlist if present.
 */
async function playHls(url, metadataUrl) {
  if (!audio) return;

  // Resolve ipfs:// to https:// gateway
  const httpUrl = ipfsToHttp(url);
  const httpMeta = metadataUrl ? ipfsToHttp(metadataUrl) : null;

  // Clean up any previous instance
  if (hls) {
    try { hls.destroy(); } catch (_) {}
    hls = null;
  }

  // Try to derive a rollup HLS url from metadata if provided
  let candidate = httpUrl;
  if (httpMeta) {
    try {
      const res = await fetch(httpMeta);
      const metadata = await res.json();
      if (metadata?.availability_type === 'live' && metadata?.rollup?.presentations?.[0]?.playlist?.streams?.[0]?.url) {
        candidate = metadata.rollup.presentations[0].playlist.streams[0].url;
      }
    } catch (err) {
      console.warn('Failed to load metadata; falling back to provided URL', err);
    }
  }

  const isM3U8 = /\.m3u8($|\?)/i.test(candidate);

  // Safari has native HLS support
  const nativeHls = audio.canPlayType('application/vnd.apple.mpegurl');

  if (isM3U8 && ensureHlsAvailable() && window.Hls.isSupported() && !nativeHls) {
    hls = new window.Hls({ enableWorker: false });
    hls.loadSource(candidate);
    hls.attachMedia(audio);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      // Autoplay can fail on iOS/desktop depending on user gesture
      audio.play().catch(() => {
        // If it fails, leave controls visible so user can press play
        console.debug('Autoplay blocked by browser');
      });
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const level = hls.levels?.[data.level];
      if (level?.bitrate) console.log(`Switched to bitrate: ${Math.round(level.bitrate / 1000)} kbps`);
    });
  } else if (isM3U8 && nativeHls) {
    audio.src = candidate;
    audio.addEventListener('loadedmetadata', () => {
      audio.play().catch(() => {});
    }, { once: true });
  } else {
    // Not HLS, assume direct file (e.g., MP3)
    audio.src = candidate;
    audio.play().catch(() => {});
  }
}

// Expose player function globally if other pages need to call it
window.playHls = playHls;

// ===========================
// Player controls (guarded)
// ===========================
if (audio) {
  // Buttons
  if (playBtn && pauseBtn && vinylIcon) {
    playBtn.addEventListener('click', () => {
      audio.play().catch(() => {});
      playBtn.style.display = 'none';
      pauseBtn.style.display = 'inline';
      vinylIcon.style.display = 'block';
      const glowDuration = Math.max(0.5, 4 - audio.volume * 3);
      vinylIcon.style.animation = `spin 2s linear infinite, glow ${glowDuration}s ease-in-out infinite`;
    });

    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        audio.pause();
        pauseBtn.style.display = 'none';
        playBtn.style.display = 'inline';
        vinylIcon.style.animation = 'none';
        vinylIcon.style.display = 'none';
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        audio.pause();
        audio.currentTime = 0;
        if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
        pauseBtn.style.display = 'none';
        playBtn.style.display = 'inline';
        vinylIcon.style.animation = 'none';
        vinylIcon.style.display = 'none';
      });
    }
  }

  // Playback state → UI
  audio.addEventListener('play', () => {
    document.body.classList.add('audio-playing');
    if (totalPlaysEl) totalPlaysEl.textContent = String(++totalPlays);
  });

  audio.addEventListener('pause', () => {
    document.body.classList.remove('audio-playing');
  });

  audio.addEventListener('ended', () => {
    document.body.classList.remove('audio-playing');
    if (vinylIcon) {
      vinylIcon.style.animation = 'none';
      vinylIcon.style.display = 'none';
    }
    if (pauseBtn && playBtn) {
      pauseBtn.style.display = 'none';
      playBtn.style.display = 'inline';
    }
    if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
  });

  // Timeline + duration
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100 || 0;
    if (progressBar) {
      progressBar.value = String(pct);
      progressBar.style.setProperty('--val', `${pct}%`);
    }
    if (timeDisplay) {
      const m = Math.floor(audio.currentTime / 60);
      const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0');
      timeDisplay.textContent = `${m}:${s}`;
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    if (durationDisplay && audio.duration && isFinite(audio.duration)) {
      const m = Math.floor(audio.duration / 60);
      const s = Math.floor(audio.duration % 60).toString().padStart(2, '0');
      durationDisplay.textContent = `Duration: ${m}:${s}`;
    }
    if (progressBar) progressBar.max = 100;
  });

  // Scrub
  if (progressBar) {
    progressBar.addEventListener('input', () => {
      if (!audio.duration || !isFinite(audio.duration)) return;
      const pct = Number(progressBar.value || 0);
      audio.currentTime = (pct / 100) * audio.duration;
      progressBar.style.setProperty('--val', `${pct}%`);
    });
    progressBar.style.setProperty('--val', '0%');
  }

  // Volume
  if (volumeBar) {
    volumeBar.addEventListener('input', () => {
      const v = Math.max(0, Math.min(1, parseFloat(volumeBar.value)));
      audio.volume = isFinite(v) ? v : 1;
      const pct = (audio.volume * 100);
      volumeBar.style.setProperty('--val', `${pct}%`);
      if (!audio.paused && vinylIcon) {
        const glowDuration = Math.max(0.5, 4 - audio.volume * 3);
        vinylIcon.style.animation = `spin 2s linear infinite, glow ${glowDuration}s ease-in-out infinite`;
      }
    });
    volumeBar.style.setProperty('--val', '100%');
  }
}

// ===========================
// Wallet entry point (delegates to your modal)
// ===========================
// Keep the button hook here, but let wallets.js own the real UX.
// wallets.js should define: window.openWalletModal = () => { /* show modal, handle providers */ }
const connectWalletBtn = document.getElementById('connectWallet');
if (connectWalletBtn) {
  connectWalletBtn.addEventListener('click', () => {
    if (typeof window.openWalletModal === 'function') {
      window.openWalletModal();
    } else {
      console.warn('openWalletModal() not found. Did you load wallets.js?');
      // Optional: basic MetaMask fallback if wallets.js missing
      if (window.ethereum && window.ethers) {
        (async () => {
          try {
            const provider = new window.ethers.BrowserProvider(window.ethereum);
            await provider.send('eth_requestAccounts', []);
            const signer = await provider.getSigner();
            const addr = await signer.getAddress();
            const el = document.getElementById('walletAddress');
            if (el) el.textContent = `Connected: ${addr.slice(0, 6)}...${addr.slice(-4)}`;
            connectWalletBtn.textContent = 'Connected';
            connectWalletBtn.disabled = true;

            // Profile page helper (only if defined)
            if (window.location.pathname.includes('profile.html') && typeof window.loadProfile === 'function') {
              window.loadProfile(addr);
            }
          } catch (e) {
            console.error('Wallet connection failed:', e);
            const el = document.getElementById('walletAddress');
            if (el) el.textContent = 'Failed to connect wallet';
          }
        })();
      } else {
        const el = document.getElementById('walletAddress');
        if (el) el.textContent = 'Wallet modal not loaded';
      }
    }
  });
}
