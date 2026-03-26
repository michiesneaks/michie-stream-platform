/**
 * MSP Live Broadcast Module
 * public/Scripts/live_broadcast.js
 *
 * Handles both the BROADCASTER (creator going live) and
 * the VIEWER (watching + engaging with a live stream).
 *
 * Globals expected:
 *   window.walletAddress, window.ethersSigner (from wallets.js)
 *   window.Hls (from vendor/hls/hls.min.js)
 */

(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════════════════
  var CHUNK_INTERVAL_MS  = 2000;   // Send a chunk every 2 seconds
  var WS_RECONNECT_DELAY = 3000;   // WebSocket reconnect delay
  var MAX_RECONNECTS     = 5;

  var REACTIONS = ['🔥', '❤️', '👏', '🎵', '💎', '🚀'];

  // ═══════════════════════════════════════════════════════════
  //  BROADCASTER
  // ═══════════════════════════════════════════════════════════

  function LiveBroadcaster(opts) {
    /**
     * opts: {
     *   previewEl:    <video> element for camera preview
     *   statusEl:     element to write status messages
     *   statsEl:      element to display viewer count / duration / tips
     *   quality:      '720p' | '480p' | '360p' | '1080p'
     *   onSessionStart(sessionData),  ← called with { sessionId, hlsUrl }
     *   onStreamEnd(summary),
     *   onError(err),
     * }
     */
    this._opts       = opts || {};
    this._stream     = null;       // MediaStream from getUserMedia
    this._recorder   = null;       // MediaRecorder
    this._sessionId  = null;
    this._ws         = null;
    this._ping       = null;
    this._alive      = false;
    this._uploadQueue = [];
    this._uploading  = false;
    this._startTime  = null;
    this._timer      = null;
    this._reconnects = 0;
  }

  LiveBroadcaster.prototype.getCamera = async function (constraints) {
    var c = constraints || {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
    };
    this._stream = await navigator.mediaDevices.getUserMedia(c);
    if (this._opts.previewEl) {
      this._opts.previewEl.srcObject = this._stream;
      this._opts.previewEl.muted     = true;
      this._opts.previewEl.play().catch(function () {});
    }
    return this._stream;
  };

  LiveBroadcaster.prototype.getScreenShare = async function () {
    this._stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: true },
    });
    if (this._opts.previewEl) {
      this._opts.previewEl.srcObject = this._stream;
      this._opts.previewEl.muted     = true;
      this._opts.previewEl.play().catch(function () {});
    }
    return this._stream;
  };

  // ── RTMP stream key (for OBS / mobile apps) ───────────────────────────────
  /**
   * Fetch or display the creator's RTMP stream key.
   * Returns { stream_key, rtmp_url, rtmp_server, instructions }
   */
  LiveBroadcaster.prototype.getStreamKey = async function () {
    var wallet = global.walletAddress;
    if (!wallet) throw new Error('Connect your wallet first.');
    var res = await fetch('/api/stream-key/' + wallet);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Failed to get stream key');
    }
    return res.json();
  };

  LiveBroadcaster.prototype.regenerateStreamKey = async function () {
    var wallet = global.walletAddress;
    if (!wallet) throw new Error('Connect your wallet first.');
    if (!confirm('Generate a new stream key? Your old key will stop working immediately.')) return null;
    var res = await fetch('/api/stream-key/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: wallet }),
    });
    if (!res.ok) throw new Error('Failed to regenerate key');
    return res.json();
  };

  /**
   * Render the RTMP stream key panel into a container element.
   * Shows key, server URL, copy buttons, and OBS/mobile instructions.
   */
  LiveBroadcaster.prototype.renderStreamKeyPanel = async function (containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p style="color:var(--text-3);font-family:var(--font-m);font-size:11px;">Loading stream key…</p>';

    var data;
    try {
      data = await this.getStreamKey();
    } catch (e) {
      container.innerHTML = '<p style="color:var(--ember);font-size:12px;">' + _esc(e.message) + '</p>';
      return;
    }

    container.innerHTML =
      '<div class="rtmp-panel">' +
        '<div class="rtmp-eyebrow">External Streaming (OBS / Mobile Apps)</div>' +
        '<div class="rtmp-row">' +
          '<label class="rtmp-label">RTMP Server</label>' +
          '<div class="rtmp-value-row">' +
            '<code class="rtmp-code" id="rtmp-server-val">' + _esc(data.rtmp_server) + '</code>' +
            '<button class="rtmp-copy-btn" data-copy="rtmp-server-val">Copy</button>' +
          '</div>' +
        '</div>' +
        '<div class="rtmp-row">' +
          '<label class="rtmp-label">Stream Key <span class="rtmp-private">— keep private</span></label>' +
          '<div class="rtmp-value-row">' +
            '<code class="rtmp-code rtmp-key-masked" id="rtmp-key-val">' + _esc(data.stream_key) + '</code>' +
            '<button class="rtmp-reveal-btn" id="rtmp-reveal">Show</button>' +
            '<button class="rtmp-copy-btn" data-copy="rtmp-key-val">Copy</button>' +
          '</div>' +
        '</div>' +
        '<details class="rtmp-instructions">' +
          '<summary>Setup instructions</summary>' +
          '<div class="rtmp-inst-body">' +
            '<strong>OBS Studio</strong><br>' +
            'Settings → Stream → Service: Custom RTMP<br>' +
            'Server: <code>' + _esc(data.rtmp_server) + '</code><br>' +
            'Stream Key: <em>your key above</em><br><br>' +
            '<strong>Larix Broadcaster / Streamlabs Mobile</strong><br>' +
            'Connections → Add → URL: <code>' + _esc(data.rtmp_url) + '</code>' +
          '</div>' +
        '</details>' +
        '<button class="rtmp-regen-btn" id="rtmp-regen">↺ Regenerate Key</button>' +
      '</div>';

    // Copy buttons
    container.querySelectorAll('.rtmp-copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var src = document.getElementById(btn.dataset.copy);
        if (!src) return;
        navigator.clipboard.writeText(src.textContent).then(function () {
          btn.textContent = '✔ Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
        });
      });
    });

    // Reveal/hide key
    var revealBtn = document.getElementById('rtmp-reveal');
    var keyEl     = document.getElementById('rtmp-key-val');
    if (revealBtn && keyEl) {
      revealBtn.addEventListener('click', function () {
        keyEl.classList.toggle('rtmp-key-masked');
        revealBtn.textContent = keyEl.classList.contains('rtmp-key-masked') ? 'Show' : 'Hide';
      });
    }

    // Regenerate
    var regenBtn = document.getElementById('rtmp-regen');
    if (regenBtn) {
      var self2 = this;
      regenBtn.addEventListener('click', async function () {
        regenBtn.disabled = true;
        try {
          await self2.regenerateStreamKey();
          self2.renderStreamKeyPanel(containerId);
        } catch (e) {
          alert(e.message);
          regenBtn.disabled = false;
        }
      });
    }
  };

  LiveBroadcaster.prototype.startSession = async function (title, artistName) {
    if (!this._stream) throw new Error('Call getCamera() first');
    var wallet = global.walletAddress;
    if (!wallet) throw new Error('Wallet not connected');

    this._setStatus('Starting session…');

    var res = await fetch('/api/live-start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        wallet, title, artistName,
        quality: this._opts.quality || '720p',
      }),
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Failed to start session');
    }
    var data = await res.json();
    this._sessionId = data.sessionId;
    this._alive     = true;
    this._startTime = Date.now();

    if (typeof this._opts.onSessionStart === 'function') {
      this._opts.onSessionStart(data);
    }

    this._startRecorder();
    this._startWebSocket();
    this._startTimer();
    this._setStatus('🔴 LIVE');

    return data;
  };

  LiveBroadcaster.prototype._startRecorder = function () {
    var self = this;

    // Pick best supported codec
    var mimeTypes = [
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm',
    ];
    var mimeType = mimeTypes.find(function (t) { return MediaRecorder.isTypeSupported(t); });
    if (!mimeType) throw new Error('No supported video codec found in this browser');

    this._recorder = new MediaRecorder(this._stream, {
      mimeType:       mimeType,
      videoBitsPerSecond: 2500000,
      audioBitsPerSecond: 128000,
    });

    this._recorder.ondataavailable = function (e) {
      if (!e.data || e.data.size < 100) return;
      self._uploadQueue.push(e.data);
      self._drainQueue();
    };

    this._recorder.onerror = function (e) {
      self._setStatus('⚠ Recorder error: ' + e.error);
      if (typeof self._opts.onError === 'function') self._opts.onError(e.error);
    };

    this._recorder.onstop = function () {
      // Drain any remaining chunks
      self._drainQueue();
    };

    this._recorder.start(CHUNK_INTERVAL_MS);
  };

  LiveBroadcaster.prototype._drainQueue = async function () {
    if (this._uploading || !this._uploadQueue.length) return;
    this._uploading = true;
    while (this._uploadQueue.length && this._alive) {
      var blob    = this._uploadQueue.shift();
      var attempt = 0;
      var sent    = false;
      while (attempt < 3 && !sent) {
        try {
          var res = await fetch('/api/live-ingest/' + this._sessionId, {
            method:  'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body:    blob,
          });
          if (res.ok) { sent = true; }
          else {
            var data = await res.json().catch(function () { return {}; });
            if (data.status === 'ended_unexpectedly') { this._alive = false; break; }
            if (data.status === 'duration_cap_reached') {
              // Server enforced the stream duration limit — end gracefully
              this._alive = false;
              this._setStatus('⏱ Stream limit reached — ending stream…');
              if (data.error) alert(data.error);
              // Trigger the normal end-stream flow
              setTimeout(function () {
                if (typeof self.endStream === 'function') self.endStream();
              }, 1000);
              break;
            }
            attempt++;
          }
        } catch (e) {
          attempt++;
          await _sleep(500 * attempt);
        }
      }
      if (!sent) this._setStatus('⚠ Upload issue — retrying…');
    }
    this._uploading = false;
  };

  LiveBroadcaster.prototype._startWebSocket = function () {
    var self    = this;
    var proto   = location.protocol === 'https:' ? 'wss' : 'ws';
    var url     = proto + '://' + location.host + '/ws';

    function connect() {
      self._ws = new WebSocket(url);

      self._ws.onopen = function () {
        self._reconnects = 0;
        // Broadcaster joins as "host" — no chat history needed
        self._ws.send(JSON.stringify({
          type:      'join_session',
          sessionId: self._sessionId,
          wallet:    global.walletAddress,
          name:      'HOST',
        }));
        // Keepalive ping every 15s
        self._ping = setInterval(function () {
          if (self._ws.readyState === WebSocket.OPEN) {
            self._ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 15000);
      };

      self._ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'tip_alert' && self._opts.statsEl) {
          _appendToStats(self._opts.statsEl, '💸 Tip: ' + msg.amountEth + ' ETH from ' + msg.name);
        }
        if (msg.type === 'viewer_count' && self._opts.statsEl) {
          var vEl = self._opts.statsEl.querySelector('.viewer-count');
          if (vEl) vEl.textContent = msg.viewerCount + ' watching';
        }
      };

      self._ws.onclose = function () {
        clearInterval(self._ping);
        if (self._alive && self._reconnects < MAX_RECONNECTS) {
          self._reconnects++;
          setTimeout(connect, WS_RECONNECT_DELAY);
        }
      };

      self._ws.onerror = function () { self._ws.close(); };
    }
    connect();
  };

  LiveBroadcaster.prototype._startTimer = function () {
    var self    = this;
    var elapsed = self._opts.statsEl && self._opts.statsEl.querySelector('.duration');
    if (!elapsed) return;
    this._timer = setInterval(function () {
      if (!self._startTime) return;
      var s = Math.floor((Date.now() - self._startTime) / 1000);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      elapsed.textContent = (h ? _pad(h) + ':' : '') + _pad(m) + ':' + _pad(sec);
    }, 1000);
  };

  LiveBroadcaster.prototype.toggleMute = function () {
    if (!this._stream) return false;
    var audio = this._stream.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return !audio.enabled; // returns true if NOW muted
  };

  LiveBroadcaster.prototype.toggleCamera = function () {
    if (!this._stream) return false;
    var video = this._stream.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    return !video.enabled; // returns true if NOW off
  };

  LiveBroadcaster.prototype.endStream = async function () {
    this._alive = false;

    // Stop recorder — flushes final chunk
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
    // Drain remaining chunks
    await _sleep(500);
    await this._drainQueue();

    // Notify server
    var summary = null;
    if (this._sessionId && global.walletAddress) {
      var res = await fetch('/api/live-end/' + this._sessionId, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ wallet: global.walletAddress }),
      }).catch(function () { return null; });
      if (res && res.ok) summary = await res.json();
    }

    // Cleanup
    clearInterval(this._timer);
    clearInterval(this._ping);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.close();
    if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); });
    if (this._opts.previewEl) this._opts.previewEl.srcObject = null;

    this._setStatus('Stream ended');
    if (typeof this._opts.onStreamEnd === 'function') {
      this._opts.onStreamEnd(summary || {
        sessionId:   this._sessionId,
        duration:    Math.floor((Date.now() - this._startTime) / 1000),
        chunkCount:  0,
        tipsTotal:   0,
        peakViewers: 0,
      });
    }
    return summary;
  };

  LiveBroadcaster.prototype._setStatus = function (msg) {
    if (this._opts.statusEl) this._opts.statusEl.textContent = msg;
    console.log('[LiveBroadcaster]', msg);
  };

  // ═══════════════════════════════════════════════════════════
  //  VIEWER
  // ═══════════════════════════════════════════════════════════

  function LiveViewer(opts) {
    /**
     * opts: {
     *   videoEl:      <video> for HLS playback
     *   chatEl:       <div> to append chat messages
     *   reactionsEl:  <div> for floating emoji reactions
     *   statsEl:      <div> for viewer count / duration / tips
     *   sessionId:    (optional) auto-join this session
     *   onEnded(),    ← called when stream ends
     * }
     */
    this._opts      = opts || {};
    this._ws        = null;
    this._hls       = null;
    this._sessionId = opts.sessionId || null;
    this._reconnects = 0;
    this._alive     = false;
  }

  LiveViewer.prototype.join = function (sessionId) {
    this._sessionId = sessionId || this._sessionId;
    if (!this._sessionId) throw new Error('sessionId required');
    this._alive = true;
    this._connectWs();
  };

  LiveViewer.prototype._connectWs = function () {
    var self  = this;
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var url   = proto + '://' + location.host + '/ws';

    function connect() {
      self._ws = new WebSocket(url);

      self._ws.onopen = function () {
        self._reconnects = 0;
        self._ws.send(JSON.stringify({
          type:      'join_session',
          sessionId: self._sessionId,
          wallet:    global.walletAddress || null,
          name:      (global.mspProfile && global.mspProfile.name) || 'Listener',
        }));
      };

      self._ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        self._handleMessage(msg);
      };

      self._ws.onclose = function () {
        if (self._alive && self._reconnects < MAX_RECONNECTS) {
          self._reconnects++;
          setTimeout(connect, WS_RECONNECT_DELAY * self._reconnects);
        }
      };

      self._ws.onerror = function () { self._ws.close(); };
    }
    connect();
  };

  LiveViewer.prototype._handleMessage = function (msg) {
    switch (msg.type) {

      case 'session_state':
        this._startHls(msg.hlsUrl);
        this._renderChatHistory(msg.chatHistory);
        this._updateStats({ viewerCount: msg.viewerCount, duration: msg.duration, tipsTotal: msg.tipsTotal });
        break;

      case 'chat':
        this._appendChat(msg);
        break;

      case 'reaction':
        this._floatReaction(msg.emoji);
        break;

      case 'viewer_count':
        this._updateStats({ viewerCount: msg.viewerCount });
        break;

      case 'stats':
        this._updateStats(msg);
        break;

      case 'tip_alert':
        this._appendChat({ name: '💸 ' + msg.name, text: 'sent ' + msg.amountEth.toFixed(4) + ' ETH!', tip: true });
        this._updateStats({ tipsTotal: msg.tipsTotal });
        this._floatReaction('💎');
        break;

      case 'stream_ended':
        this._alive = false;
        this._appendChat({ name: 'MSP', text: '🎬 Stream ended.', system: true });
        if (this._hls) { this._hls.stopLoad(); }
        if (typeof this._opts.onEnded === 'function') this._opts.onEnded(msg);
        break;
    }
  };

  LiveViewer.prototype._startHls = function (hlsUrl) {
    var videoEl = this._opts.videoEl;
    if (!videoEl) return;

    if (global.Hls && global.Hls.isSupported()) {
      if (this._hls) { this._hls.destroy(); }
      this._hls = new global.Hls({ lowLatencyMode: true, liveSyncDurationCount: 2 });
      this._hls.loadSource(hlsUrl);
      this._hls.attachMedia(videoEl);
      this._hls.on(global.Hls.Events.MANIFEST_PARSED, function () { videoEl.play().catch(function () {}); });
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = hlsUrl;
      videoEl.play().catch(function () {});
    }
  };

  LiveViewer.prototype._renderChatHistory = function (history) {
    if (!this._opts.chatEl || !history) return;
    var self = this;
    history.forEach(function (m) { self._appendChat(m); });
  };

  LiveViewer.prototype._appendChat = function (msg) {
    var el = this._opts.chatEl;
    if (!el) return;
    var row   = document.createElement('div');
    row.className = 'chat-row' + (msg.tip ? ' chat-tip' : '') + (msg.system ? ' chat-system' : '');
    var name  = document.createElement('span');
    name.className   = 'chat-name';
    name.textContent = msg.name + ' ';
    var text  = document.createElement('span');
    text.className   = 'chat-text';
    text.textContent = msg.text;
    row.appendChild(name);
    row.appendChild(text);
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
    // Keep max 100 messages
    while (el.children.length > 100) el.removeChild(el.firstChild);
  };

  LiveViewer.prototype._floatReaction = function (emoji) {
    var el = this._opts.reactionsEl;
    if (!el) return;
    var span      = document.createElement('span');
    span.className    = 'floating-reaction';
    span.textContent  = emoji;
    // Random horizontal position
    span.style.left   = (10 + Math.random() * 80) + '%';
    el.appendChild(span);
    setTimeout(function () { if (span.parentNode) span.parentNode.removeChild(span); }, 2500);
  };

  LiveViewer.prototype._updateStats = function (data) {
    var el = this._opts.statsEl;
    if (!el) return;
    if (data.viewerCount != null) {
      var vc = el.querySelector('.viewer-count');
      if (vc) vc.textContent = data.viewerCount + ' watching';
    }
    if (data.duration != null) {
      var d  = el.querySelector('.duration');
      if (d) {
        var s = data.duration;
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        d.textContent = (h ? _pad(h) + ':' : '') + _pad(m) + ':' + _pad(sec);
      }
    }
    if (data.tipsTotal != null) {
      var tt = el.querySelector('.tips-total');
      if (tt) tt.textContent = parseFloat(data.tipsTotal).toFixed(4) + ' ETH tipped';
    }
  };

  LiveViewer.prototype.sendChat = function (text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'chat', text: text }));
  };

  LiveViewer.prototype.sendReaction = function (emoji) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'reaction', emoji: emoji }));
    this._floatReaction(emoji); // Optimistic local display
  };

  LiveViewer.prototype.sendTipAlert = function (amountEth) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'tip_alert', amountEth: amountEth }));
  };

  LiveViewer.prototype.leave = function () {
    this._alive = false;
    if (this._ws) {
      this._ws.send(JSON.stringify({ type: 'leave_session' }));
      this._ws.close();
    }
    if (this._hls) this._hls.destroy();
  };

  // ═══════════════════════════════════════════════════════════
  //  POST-STREAM MODAL
  // ═══════════════════════════════════════════════════════════

  function PostStreamModal(summary, opts) {
    /**
     * summary: { sessionId, duration, tipsTotal, peakViewers, chunkCount }
     * opts:    { onArchive, onDiscard, onRetry }
     */
    this._summary = summary;
    this._opts    = opts || {};
    this._el      = null;
  }

  PostStreamModal.prototype.open = function () {
    var self  = this;
    var s     = this._summary;
    var dur   = _formatDuration(s.duration || 0);

    // Keep a local reference to the recorded chunks for download
    // These are passed in summary.chunks if available
    var recordedChunks = s.chunks || null;

    var overlay = document.createElement('div');
    overlay.id        = 'post-stream-overlay';
    overlay.className = 'psm-overlay';
    overlay.innerHTML =
      '<div class="psm-modal">' +
        '<div class="psm-header">' +
          '<div class="psm-eyebrow">Stream Ended</div>' +
          '<h2 class="psm-title">What would you like to do?</h2>' +
        '</div>' +
        '<div class="psm-stats">' +
          '<div class="psm-stat"><span class="psm-stat-val">' + dur + '</span><span class="psm-stat-lbl">Duration</span></div>' +
          '<div class="psm-stat"><span class="psm-stat-val">' + (s.peakViewers || 0) + '</span><span class="psm-stat-lbl">Peak Viewers</span></div>' +
          '<div class="psm-stat"><span class="psm-stat-val">' + parseFloat(s.tipsTotal || 0).toFixed(4) + '</span><span class="psm-stat-lbl">ETH Tipped</span></div>' +
        '</div>' +
        '<div class="psm-fields">' +
          '<label class="psm-label">Title</label>' +
          '<input class="psm-input" id="psm-title" type="text" placeholder="Recording title…" value="' + _esc(s.title || '') + '">' +
          '<label class="psm-label">Description</label>' +
          '<textarea class="psm-input" id="psm-desc" rows="2" placeholder="What happened in this stream…"></textarea>' +
          '<label class="psm-label">Tags (comma-separated)</label>' +
          '<input class="psm-input" id="psm-tags" type="text" placeholder="live, dj, techno…">' +
        '</div>' +
        '<div class="psm-status" id="psm-status"></div>' +
        '<div class="psm-actions">' +
          '<button class="psm-btn psm-btn-primary" id="psm-mint">◈ Mint NFT + Save to Catalog</button>' +
          '<button class="psm-btn psm-btn-secondary" id="psm-save">Save to Catalog Only</button>' +
          '<button class="psm-btn psm-btn-download" id="psm-download" style="background:transparent;border:1px solid var(--gold);color:var(--gold);width:100%;border-radius:6px;padding:12px 20px;font-family:var(--font-u,sans-serif);font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;">⬇ Download Recording to Device</button>' +
          '<button class="psm-btn psm-btn-warn" id="psm-retry">↺ Retry Stream</button>' +
          '<button class="psm-btn psm-btn-ghost" id="psm-discard">✕ Discard Recording</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    this._el = overlay;

    function getFields() {
      return {
        title:       (document.getElementById('psm-title')  || {}).value || s.title || '',
        description: (document.getElementById('psm-desc')   || {}).value || '',
        tags:        (document.getElementById('psm-tags')   || {}).value || '',
      };
    }

    function setStatus(msg, color) {
      var el = document.getElementById('psm-status');
      if (el) { el.textContent = msg; el.style.color = color || '#eeeae4'; }
    }

    function disableAll() {
      ['psm-mint','psm-save','psm-download','psm-retry','psm-discard'].forEach(function (id) {
        var b = document.getElementById(id); if (b) b.disabled = true;
      });
    }

    // Resolve wallet — use global or fall back to summary
    function resolveWallet() {
      return (global.walletAddress) || s.wallet || '';
    }

    // ── Mint NFT + Save ──────────────────────────────────────────────────────
    document.getElementById('psm-mint').onclick = async function () {
      disableAll();
      setStatus('Archiving to IPFS…');
      var f = getFields();
      try {
        var res = await fetch('/api/live-archive', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            sessionId:   s.sessionId,
            wallet:      resolveWallet(),
            title:       f.title,
            description: f.description,
            tags:        f.tags,
            mintNft:     true,
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Archive failed');
        setStatus('✔ Archived! Minting NFT…', '#00d4bb');
        if (typeof self._opts.onArchive === 'function') self._opts.onArchive(data, true);
        setTimeout(function () { self.close(); }, 2000);
      } catch (e) { setStatus('Error: ' + e.message, '#e85d3a'); disableAll(); }
    };

    // ── Save Only ────────────────────────────────────────────────────────────
    document.getElementById('psm-save').onclick = async function () {
      disableAll();
      setStatus('Saving to catalog…');
      var f = getFields();
      try {
        var res = await fetch('/api/live-archive', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            sessionId:   s.sessionId,
            wallet:      resolveWallet(),
            title:       f.title,
            description: f.description,
            tags:        f.tags,
            mintNft:     false,
          }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Archive failed');
        setStatus('✔ Saved to catalog!', '#00d4bb');
        if (typeof self._opts.onArchive === 'function') self._opts.onArchive(data, false);
        setTimeout(function () { self.close(); }, 1500);
      } catch (e) { setStatus('Error: ' + e.message, '#e85d3a'); disableAll(); }
    };

    // ── Download to Device ───────────────────────────────────────────────────
    document.getElementById('psm-download').onclick = async function () {
      setStatus('Preparing download…');
      try {
        // Request the recorded chunks from the server
        var res = await fetch('/api/live-download/' + s.sessionId, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ wallet: resolveWallet() }),
        });

        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error(err.error || 'Download not available');
        }

        // Server streams the WebM blob back
        var blob = await res.blob();
        var filename = _esc(getFields().title || s.title || 'stream') + '_' +
          new Date().toISOString().slice(0, 10) + '.webm';

        // Trigger browser download
        var url = URL.createObjectURL(blob);
        var a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);

        setStatus('✔ Download started — check your Downloads folder.', '#00d4bb');
      } catch (e) { setStatus('Error: ' + e.message, '#e85d3a'); }
    };

    // ── Retry ────────────────────────────────────────────────────────────────
    document.getElementById('psm-retry').onclick = function () {
      self.close();
      if (typeof self._opts.onRetry === 'function') self._opts.onRetry(s);
    };

    // ── Discard ──────────────────────────────────────────────────────────────
    document.getElementById('psm-discard').onclick = async function () {
      if (!confirm('Permanently delete this recording? This cannot be undone.')) return;
      disableAll();
      setStatus('Discarding…');
      await fetch('/api/live-discard', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionId: s.sessionId, wallet: resolveWallet() }),
      }).catch(function () {});
      if (typeof self._opts.onDiscard === 'function') self._opts.onDiscard();
      self.close();
    };
  };

  PostStreamModal.prototype.close = function () {
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
  };

  // ═══════════════════════════════════════════════════════════
  //  LIVE SESSIONS BROWSER
  //  Renders the grid of active live sessions on listen.html
  // ═══════════════════════════════════════════════════════════

  async function renderLiveSessions(containerId, onJoin) {
    var el = document.getElementById(containerId);
    if (!el) return;

    var sessions = [];
    try {
      var res = await fetch('/api/live-sessions');
      if (res.ok) sessions = await res.json();
    } catch (e) { console.debug('live-sessions fetch failed:', e.message); }

    if (!sessions.length) {
      el.innerHTML = '<p class="live-empty">No live streams right now. Check back soon.</p>';
      return;
    }

    el.innerHTML = sessions.map(function (s) {
      var dur = _formatDuration(s.duration || 0);
      return (
        '<div class="live-card" data-session="' + _esc(s.sessionId) + '">' +
          '<div class="live-thumb">' +
            '<img src="' + _esc(s.thumbnailUrl) + '" onerror="this.style.display=\'none\'">' +
            '<div class="live-badge">● LIVE</div>' +
            '<div class="live-viewers">' + (s.viewerCount || 0) + ' watching</div>' +
          '</div>' +
          '<div class="live-info">' +
            '<div class="live-title">' + _esc(s.title) + '</div>' +
            '<div class="live-artist">' + _esc(s.artistName) + '</div>' +
            '<div class="live-dur">' + dur + '</div>' +
          '</div>' +
          '<button class="live-join-btn">Join Live</button>' +
        '</div>'
      );
    }).join('');

    el.querySelectorAll('.live-join-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sessionId = btn.closest('.live-card').dataset.session;
        if (typeof onJoin === 'function') onJoin(sessionId);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  UTILS
  // ═══════════════════════════════════════════════════════════
  function _pad(n)            { return String(n).padStart(2, '0'); }
  function _sleep(ms)         { return new Promise(function (r) { setTimeout(r, ms); }); }
  function _esc(s)            { return String(s || '').replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function _appendToStats(el, msg) {
    var p = document.createElement('p');
    p.className = 'stat-alert';
    p.textContent = msg;
    el.appendChild(p);
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 5000);
  }
  function _formatDuration(s) {
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? _pad(h) + ':' : '') + _pad(m) + ':' + _pad(sec);
  }

  // ═══════════════════════════════════════════════════════════
  //  EXPORTS
  // ═══════════════════════════════════════════════════════════
  global.MSPLive = {
    Broadcaster:      LiveBroadcaster,
    Viewer:           LiveViewer,
    PostStreamModal:  PostStreamModal,
    renderSessions:   renderLiveSessions,
    REACTIONS:        REACTIONS,
  };

})(window);
