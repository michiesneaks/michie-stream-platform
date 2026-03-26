// public/Scripts/common.js
'use strict';

// ===========================
// Config
// ===========================
const IPFS_GATEWAY = (window.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/+$/, '') + '/';

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
  return (typeof window !== 'undefined' && window.Hls && typeof window.Hls.isSupported === 'function');
}

async function playHls(url, metadataUrl) {
  if (!audio) return;

  const httpUrl  = ipfsToHttp(url);
  const httpMeta = metadataUrl ? ipfsToHttp(metadataUrl) : null;

  if (hls) {
    try { hls.destroy(); } catch (_) {}
    hls = null;
  }

  let candidate = httpUrl;
  if (httpMeta) {
    try {
      const res      = await fetch(httpMeta);
      const metadata = await res.json();
      if (metadata && metadata.availability_type === 'live' &&
          metadata.rollup && metadata.rollup.presentations &&
          metadata.rollup.presentations[0] &&
          metadata.rollup.presentations[0].playlist &&
          metadata.rollup.presentations[0].playlist.streams &&
          metadata.rollup.presentations[0].playlist.streams[0]) {
        candidate = metadata.rollup.presentations[0].playlist.streams[0].url;
      }
    } catch (err) {
      console.warn('Failed to load metadata; falling back to provided URL', err);
    }
  }

  const isM3U8   = /\.m3u8($|\?)/i.test(candidate);
  const nativeHls = audio.canPlayType('application/vnd.apple.mpegurl');

  if (isM3U8 && ensureHlsAvailable() && window.Hls.isSupported() && !nativeHls) {
    hls = new window.Hls({ enableWorker: false });
    hls.loadSource(candidate);
    hls.attachMedia(audio);
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      audio.play().catch(function () {});
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, function (_, data) {
      const level = hls.levels && hls.levels[data.level];
      if (level && level.bitrate) {
        console.log('Switched to bitrate: ' + Math.round(level.bitrate / 1000) + ' kbps');
      }
    });
  } else if (isM3U8 && nativeHls) {
    audio.src = candidate;
    audio.addEventListener('loadedmetadata', function () {
      audio.play().catch(function () {});
    }, { once: true });
  } else {
    audio.src = candidate;
    audio.play().catch(function () {});
  }
}

window.playHls = playHls;

// ===========================
// Player controls (guarded)
// ===========================
if (audio) {
  // Wire play button — vinylIcon is optional, do not gate on it
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      audio.play().catch(function () {});
      playBtn.style.display  = 'none';
      if (pauseBtn) pauseBtn.style.display = 'inline';
      if (vinylIcon) {
        vinylIcon.style.display = 'block';
        const glowDuration = Math.max(0.5, 4 - audio.volume * 3);
        vinylIcon.style.animation = 'spin 2s linear infinite, glow ' + glowDuration + 's ease-in-out infinite';
      }
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', function () {
      audio.pause();
      pauseBtn.style.display = 'none';
      if (playBtn) playBtn.style.display = 'inline';
      if (vinylIcon) {
        vinylIcon.style.animation = 'none';
        vinylIcon.style.display   = 'none';
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      audio.pause();
      audio.currentTime = 0;
      if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (playBtn)  playBtn.style.display  = 'inline';
      if (vinylIcon) {
        vinylIcon.style.animation = 'none';
        vinylIcon.style.display   = 'none';
      }
    });
  }

  audio.addEventListener('play', function () {
    document.body.classList.add('audio-playing');
    if (totalPlaysEl) totalPlaysEl.textContent = String(++totalPlays);
  });

  audio.addEventListener('pause', function () {
    document.body.classList.remove('audio-playing');
  });

  audio.addEventListener('ended', function () {
    document.body.classList.remove('audio-playing');
    if (vinylIcon) {
      vinylIcon.style.animation = 'none';
      vinylIcon.style.display   = 'none';
    }
    if (pauseBtn && playBtn) {
      pauseBtn.style.display = 'none';
      playBtn.style.display  = 'inline';
    }
    if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
  });

  audio.addEventListener('timeupdate', function () {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100 || 0;
    if (progressBar) {
      progressBar.value = String(pct);
      progressBar.style.setProperty('--val', pct + '%');
    }
    if (timeDisplay) {
      const m = Math.floor(audio.currentTime / 60);
      const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0');
      timeDisplay.textContent = m + ':' + s;
    }
  });

  audio.addEventListener('loadedmetadata', function () {
    if (durationDisplay && audio.duration && isFinite(audio.duration)) {
      const m = Math.floor(audio.duration / 60);
      const s = Math.floor(audio.duration % 60).toString().padStart(2, '0');
      durationDisplay.textContent = 'Duration: ' + m + ':' + s;
    }
    if (progressBar) progressBar.max = 100;
  });

  if (progressBar) {
    progressBar.addEventListener('input', function () {
      if (!audio.duration || !isFinite(audio.duration)) return;
      const pct = Number(progressBar.value || 0);
      audio.currentTime = (pct / 100) * audio.duration;
      progressBar.style.setProperty('--val', pct + '%');
    });
    progressBar.style.setProperty('--val', '0%');
  }

  if (volumeBar) {
    volumeBar.addEventListener('input', function () {
      const v = Math.max(0, Math.min(1, parseFloat(volumeBar.value)));
      audio.volume = isFinite(v) ? v : 1;
      const pct = audio.volume * 100;
      volumeBar.style.setProperty('--val', pct + '%');
      if (!audio.paused && vinylIcon) {
        const glowDuration = Math.max(0.5, 4 - audio.volume * 3);
        vinylIcon.style.animation = 'spin 2s linear infinite, glow ' + glowDuration + 's ease-in-out infinite';
      }
    });
    volumeBar.style.setProperty('--val', '100%');
  }
}

// ===========================
// Wallet button — delegates to wallets.js
// ===========================
const connectWalletBtn = document.getElementById('connectWallet');
if (connectWalletBtn) {
  connectWalletBtn.addEventListener('click', function () {
    if (typeof window.openWalletModal === 'function') {
      window.openWalletModal();
    } else {
      console.warn('openWalletModal() not found. Did you load wallets.js?');
    }
  });
}
