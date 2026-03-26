'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MSP GStreamer Pipeline Manager  —  gst_pipeline.js
 *  src/gst_pipeline.js
 *
 *  Two operating modes — fundamentally different pipeline architectures:
 *
 *  PRODUCTION  ("The Monster" — like the flowchart)
 *  ────────────────────────────────────────────────
 *  Single gst-launch-1.0 process, true tee-based parallel fan-out.
 *  Mirrors a professional broadcast transcoder.
 *
 *  filesrc/rtmpsrc/fdsrc
 *    → demux (qtdemux / flvdemux / matroskademux)
 *    → video decode (avdec_h264 / vp8dec)
 *    → videoconvert → videorate(30fps)
 *    → vtee ──► queue → scale 1920×1080 → [HW/SW enc] → h264parse → mux1080 → hlssink2
 *            ──► queue → scale 1280×720  → [HW/SW enc] → h264parse → mux720  → hlssink2
 *            ──► queue → scale 854×480   → [HW/SW enc] → h264parse → mux480  → hlssink2
 *            ──► queue → scale 640×360   → [HW/SW enc] → h264parse → mux360  → hlssink2
 *            ──► queue → scale 320×180   → jpegenc     → multifilesink (thumb)
 *    → audio decode (avdec_aac / vorbisdec)
 *    → audioconvert → audioresample(44100,stereo)
 *    → level (loudness analysis, peak metering)
 *    → atee ──► avenc_aac(192k) → mux1080.
 *            ──► avenc_aac(128k) → mux720.
 *            ──► avenc_aac(128k) → mux480.
 *            ──► avenc_aac(96k)  → mux360.
 *
 *  Use for: catalog assets, royalty-eligible streams, VOD transcode
 *  Archive: YES → output lands in STREAMS_ROOT/{cid}/ → served by Nginx
 *
 *  SOCIAL  ("Bare Bones" — fast, minimal, ephemeral)
 *  ─────────────────────────────────────────────────
 *  Single source → decode → 480p encode → 1s HLS fragments
 *  No tee, no multi-bitrate, no analysis, no thumbnail.
 *
 *  Use for: fan interaction streams, casual DJ sets
 *  Archive: NO by default (creator can opt-in post-stream)
 *
 *  Hardware encoder priority (auto-detected at startup):
 *    1. NVIDIA NVENC  (nvh264enc)
 *    2. Intel/AMD VA-API  (vaapih264enc)
 *    3. Apple VideoToolbox  (vtenc_h264)
 *    4. Software x264enc  ← always available if gst-plugins-ugly installed
 *
 *  Every path has an FFmpeg fallback — GStreamer not required to run MSP.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs-extra');
const EventEmitter = require('events');
const crypto       = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
//  Config (all overridable via environment)
// ─────────────────────────────────────────────────────────────────────────────

const GST_LAUNCH   = process.env.GST_LAUNCH_PATH  || 'gst-launch-1.0';
const GST_INSPECT  = process.env.GST_INSPECT_PATH || 'gst-inspect-1.0';
const FFMPEG_PATH  = process.env.FFMPEG_PATH       || 'ffmpeg';

/** Where Nginx serves catalog HLS from (VOD assets) */
const STREAMS_ROOT = process.env.STREAMS_ROOT || '/var/www/msp/streams';
/** Where Nginx serves live HLS from */
const HLS_ROOT     = process.env.HLS_ROOT     || '/var/www/msp/live';

// ─────────────────────────────────────────────────────────────────────────────
//  Modes
// ─────────────────────────────────────────────────────────────────────────────

const MODES = {
  PRODUCTION: 'production',   // heavy, multi-bitrate, archived, royalty-eligible
  SOCIAL:     'social',       // bare-bones, single quality, ephemeral
};

// ─────────────────────────────────────────────────────────────────────────────
//  Ladders
// ─────────────────────────────────────────────────────────────────────────────

/** PRODUCTION — all four video rungs. Rungs above source height are skipped. */
const PROD_VIDEO_LADDER = [
  { name: '1080p', w: 1920, h: 1080, vbr: 4500, abr: 192, seg: 10 },
  { name: '720p',  w: 1280, h: 720,  vbr: 2800, abr: 128, seg: 10 },
  { name: '480p',  w: 854,  h: 480,  vbr: 1400, abr: 128, seg: 10 },
  { name: '360p',  w: 640,  h: 360,  vbr: 700,  abr: 96,  seg: 10 },
];

/** PRODUCTION audio-only ladder (music / podcast VOD) */
const PROD_AUDIO_LADDER = [
  { name: 'hi',  bps: 320000 },
  { name: 'mid', bps: 256000 },
  { name: 'lo',  bps: 128000 },
];

/** SOCIAL — single rung, lowest latency */
const SOCIAL_RUNG = { w: 854, h: 480, vbr: 1200, abr: 128 };

// ─────────────────────────────────────────────────────────────────────────────
//  Capability detection
// ─────────────────────────────────────────────────────────────────────────────

async function detectCapabilities() {
  const caps = {
    gstreamer: false, gstVersion: null,
    nvenc: false, vaapi: false, videotoolbox: false, x264: false,
    hlssink2: false, rtmpsrc: false, level: false, jpegenc: false,
    matroskademux: false,
    ffmpeg: false, ffmpegVersion: null,
  };

  try {
    const out = await _cmd(GST_LAUNCH, ['--version']);
    caps.gstreamer = true;
    caps.gstVersion = (out.match(/GStreamer\s+([\d.]+)/) || [])[1] || 'unknown';
  } catch (_) {}

  if (caps.gstreamer) {
    await Promise.all([
      ['nvh264enc',    'nvenc'],
      ['vaapih264enc', 'vaapi'],
      ['vtenc_h264',   'videotoolbox'],
      ['x264enc',      'x264'],
      ['hlssink2',     'hlssink2'],
      ['rtmpsrc',      'rtmpsrc'],
      ['level',        'level'],
      ['jpegenc',      'jpegenc'],
      ['matroskademux','matroskademux'],
    ].map(async ([el, key]) => {
      try { await _cmd(GST_INSPECT, [el]); caps[key] = true; } catch (_) {}
    }));
  }

  try {
    const out = await _cmd(FFMPEG_PATH, ['-version']);
    caps.ffmpeg = true;
    caps.ffmpegVersion = (out.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
  } catch (_) {}

  return caps;
}

/**
 * Returns an object with:
 *   el     — GStreamer element name
 *   hw     — hardware backend label
 *   enc(kbps) — function that returns the full encoder element string
 */
function pickVideoEncoder(caps) {
  if (caps.nvenc)        return {
    el: 'nvh264enc', hw: 'nvidia',
    enc: kbps => `nvh264enc bitrate=${kbps} rc-mode=cbr preset=low-latency ! h264parse`,
  };
  if (caps.vaapi)        return {
    el: 'vaapih264enc', hw: 'vaapi',
    enc: kbps => `vaapivpp ! vaapih264enc rate-control=cbr bitrate=${kbps} ! h264parse`,
  };
  if (caps.videotoolbox) return {
    el: 'vtenc_h264', hw: 'videotoolbox',
    enc: kbps => `vtenc_h264 bitrate=${kbps} realtime=true ! h264parse`,
  };
  return {
    el: 'x264enc', hw: 'software',
    enc: kbps => `x264enc bitrate=${kbps} speed-preset=fast tune=film key-int-max=60 ! h264parse`,
  };
}

function pickSocialEncoder(caps) {
  // Social always prefers low-latency over quality
  if (caps.nvenc)
    return kbps => `nvh264enc bitrate=${kbps} rc-mode=cbr preset=low-latency ! h264parse`;
  if (caps.vaapi)
    return kbps => `vaapivpp ! vaapih264enc rate-control=cbr bitrate=${kbps} ! h264parse`;
  return kbps => `x264enc bitrate=${kbps} speed-preset=ultrafast tune=zerolatency key-int-max=30 ! h264parse`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GstPipeline
// ─────────────────────────────────────────────────────────────────────────────

class GstPipeline extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.id          Content or session ID (used in logs)
   * @param {string}  opts.mode        MODES.PRODUCTION | MODES.SOCIAL
   * @param {string}  opts.hlsDir      Output directory for HLS segments
   * @param {object}  opts.caps        From detectCapabilities()
   * @param {object}  opts.logger      Pino or console logger
   */
  constructor(opts) {
    super();
    this.id       = opts.id || opts.sessionId || crypto.randomUUID();
    this.mode     = opts.mode   || MODES.PRODUCTION;
    this.hlsDir   = opts.hlsDir || path.join(STREAMS_ROOT, this.id);
    this.caps     = opts.caps   || {};
    this.logger   = opts.logger || { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
    this._procs   = [];
    this._stopped = false;
    this._healthT = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRIMARY API
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * VOD transcode  (file on disk → HLS)
   * Runs to completion, resolves when done.
   */
  async transcodeFile(opts) {
    const { inputPath, contentType = 'music', sourceHeight = 0 } = opts;
    await fs.ensureDir(this.hlsDir);

    const isAudio = contentType === 'music' || contentType === 'podcast';
    this.logger.info({ id: this.id, mode: this.mode, contentType }, 'transcodeFile start');

    // PRODUCTION mode —> full tee-based pipeline
    if (this.mode === MODES.PRODUCTION) {
      if (isAudio) {
        return this.caps.gstreamer
          ? this._gstAudioProduction(inputPath)
          : this._ffmpegAudioProduction(inputPath);
      } else {
        const ladder = PROD_VIDEO_LADDER.filter(r => r.h <= (sourceHeight || 720) + 120);
        if (!ladder.length) ladder.push(PROD_VIDEO_LADDER[1]);
        return this.caps.gstreamer
          ? this._gstVideoProduction(inputPath, ladder)
          : this._ffmpegVideoProduction(inputPath, ladder);
      }
    }

    // SOCIAL mode —> single quality, fast
    if (isAudio) {
      return this.caps.gstreamer
        ? this._gstAudioSocial(inputPath)
        : this._ffmpegAudioSocial(inputPath);
    } else {
      return this.caps.gstreamer
        ? this._gstVideoSocial(inputPath)
        : this._ffmpegVideoSocial(inputPath);
    }
  }

  /**
   * Live RTMP ingest  (OBS / Larix / hardware encoder → HLS)
   * Returns the spawned child process(es).
   */
  startRtmpLive(opts) {
    const { rtmpUrl, audioOnly = false, qualities = ['720p', '480p'] } = opts;
    if (!fs.existsSync(this.hlsDir)) fs.ensureDirSync(this.hlsDir);

    this.logger.info({ id: this.id, mode: this.mode, rtmpUrl, audioOnly }, 'startRtmpLive');

    if (this.mode === MODES.SOCIAL) {
      return this.caps.gstreamer && this.caps.rtmpsrc
        ? this._gstRtmpSocial({ rtmpUrl, audioOnly })
        : this._ffmpegRtmpSocial({ rtmpUrl, audioOnly });
    }

    const ladder = audioOnly ? [] : PROD_VIDEO_LADDER.filter(r => qualities.includes(r.name));
    if (!ladder.length && !audioOnly) ladder.push(PROD_VIDEO_LADDER[1]);

    return this.caps.gstreamer && this.caps.rtmpsrc
      ? this._gstRtmpProduction({ rtmpUrl, audioOnly, ladder })
      : this._ffmpegRtmpProduction({ rtmpUrl, audioOnly, ladder });
  }

  /**
   * Live browser pipe  (MediaRecorder WebM chunks → stdin → HLS)
   */
  startBrowserLive(opts) {
    const { passThrough, audioOnly = false, qualities = ['720p', '480p'] } = opts;
    if (!fs.existsSync(this.hlsDir)) fs.ensureDirSync(this.hlsDir);

    this.logger.info({ id: this.id, mode: this.mode, audioOnly }, 'startBrowserLive');

    if (this.mode === MODES.SOCIAL) {
      return this.caps.gstreamer
        ? this._gstBrowserSocial({ passThrough, audioOnly })
        : this._ffmpegBrowserSocial({ passThrough, audioOnly });
    }

    const ladder = audioOnly ? [] : PROD_VIDEO_LADDER.filter(r => qualities.includes(r.name));
    if (!ladder.length && !audioOnly) ladder.push(PROD_VIDEO_LADDER[1]);

    return this.caps.gstreamer
      ? this._gstBrowserProduction({ passThrough, audioOnly, ladder })
      : this._ffmpegBrowserProduction({ passThrough, audioOnly });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRODUCTION GST — audio VOD
  //
  //  filesrc → decodebin → audioconvert → audioresample → level → atee
  //    atee → avenc_aac(320k) → hlssink2(hi)
  //    atee → avenc_aac(256k) → hlssink2(mid)
  //    atee → avenc_aac(128k) → hlssink2(lo)
  // ══════════════════════════════════════════════════════════════════════════

  async _gstAudioProduction(inputPath) {
    const { hlsDir } = this;
    const levelPart = this.caps.level
      ? `! level name=lvl message=true interval=500000000 peak-ttl=300000000 `
      : '';

    const lines = [
      `filesrc location="${inputPath}"`,
      `! decodebin name=dec`,
      `dec.`,
      `! queue max-size-time=0 max-size-bytes=0`,
      `! audioconvert`,
      `! audioresample`,
      `! audio/x-raw,rate=44100,channels=2`,
      levelPart,
      `! tee name=atee`,
    ];

    for (const r of PROD_AUDIO_LADDER) {
      lines.push(
        `atee.`,
        `! queue max-size-time=0 max-size-bytes=0`,
        `! avenc_aac bitrate=${r.bps} compliance=-2`,
        `! aacparse`,
        `! hlssink2`,
        `    location="${hlsDir}/${r.name}_%05d.ts"`,
        `    playlist-location="${hlsDir}/${r.name}.m3u8"`,
        `    target-duration=10 max-files=0`,
      );
    }

    await this._gstRun(lines.join(' '));
    await this._writeAudioMaster();
    this.logger.info({ id: this.id }, 'Audio PRODUCTION complete');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRODUCTION GST — video VOD  (THE MONSTER)
  //
  //  filesrc → demux → video decode → videoconvert → videorate(30fps) → vtee
  //    vtee → scale(1080p) → enc → h264parse → mux1080 → hlssink2
  //    vtee → scale(720p)  → enc → h264parse → mux720  → hlssink2
  //    vtee → scale(480p)  → enc → h264parse → mux480  → hlssink2
  //    vtee → scale(360p)  → enc → h264parse → mux360  → hlssink2
  //    vtee → scale(320x180) → jpegenc → multifilesink (thumbnail every ~30s)
  //
  //    demux → audio decode → audioconvert → audioresample → level → atee
  //    atee → avenc_aac(192k) → mux1080.
  //    atee → avenc_aac(128k) → mux720.
  //    atee → avenc_aac(128k) → mux480.
  //    atee → avenc_aac(96k)  → mux360.
  // ══════════════════════════════════════════════════════════════════════════

  async _gstVideoProduction(inputPath, ladder) {
    const { hlsDir } = this;
    const enc        = pickVideoEncoder(this.caps);
    const levelPart  = this.caps.level
      ? `! level name=lvl message=true interval=500000000 `
      : '';
    const ext   = path.extname(inputPath).toLowerCase();
    const demux = ext === '.mp4' || ext === '.m4v'  ? 'qtdemux name=dmx'
                : ext === '.mkv' || ext === '.webm' ? 'matroskademux name=dmx'
                : ext === '.flv'                    ? 'flvdemux name=dmx'
                : 'qtdemux name=dmx';

    const lines = [];

    // ── Source + demux ──────────────────────────────────────────────────────
    lines.push(
      `filesrc location="${inputPath}"`,
      `! ${demux}`,
    );

    // ── Video decode → vtee ─────────────────────────────────────────────────
    lines.push(
      `dmx.`,
      `! queue max-size-bytes=0 max-size-time=0`,
      `! h264parse ! avdec_h264`,
      `! videoconvert`,
      `! videorate`,
      `! video/x-raw,framerate=30/1`,
      `! tee name=vtee`,
    );

    // ── One video branch per rung ────────────────────────────────────────────
    for (const r of ladder) {
      lines.push(
        `vtee.`,
        `! queue max-size-bytes=0 max-size-time=0 leaky=downstream`,
        `! videoscale method=bilinear add-borders=true`,
        `! video/x-raw,width=${r.w},height=${r.h}`,
        `! ${enc.enc(r.vbr)}`,
        `! mpegtsmux name=mux${r.name}`,
        `! hlssink2`,
        `    location="${hlsDir}/${r.name}_%05d.ts"`,
        `    playlist-location="${hlsDir}/${r.name}.m3u8"`,
        `    target-duration=${r.seg} max-files=0`,
      );
    }

    // ── Thumbnail branch (JPEG) ─────────────────────────────────────────────
    if (this.caps.jpegenc) {
      lines.push(
        `vtee.`,
        `! queue leaky=downstream`,
        `! videoscale ! video/x-raw,width=320,height=180`,
        `! jpegenc quality=82`,
        `! multifilesink location="${hlsDir}/thumb_%05d.jpg" max-files=3`,
      );
    }

    // ── Audio decode → atee ─────────────────────────────────────────────────
    lines.push(
      `dmx.`,
      `! queue max-size-bytes=0 max-size-time=0`,
      `! aacparse ! avdec_aac`,
      `! audioconvert ! audioresample`,
      `! audio/x-raw,rate=44100,channels=2`,
      levelPart,
      `! tee name=atee`,
    );

    // ── One audio branch per rung → feed into corresponding video mux ───────
    const abrMap = { '1080p': 196608, '720p': 131072, '480p': 131072, '360p': 98304 };
    for (const r of ladder) {
      lines.push(
        `atee.`,
        `! queue max-size-time=0`,
        `! avenc_aac bitrate=${abrMap[r.name] || 131072} compliance=-2`,
        `! aacparse`,
        `! mux${r.name}.`,
      );
    }

    const pipeline = lines.join(' ');
    this.logger.info(
      { id: this.id, encoder: enc.hw, rungs: ladder.map(r => r.name) },
      `GST VIDEO PRODUCTION: ${pipeline.slice(0, 160)}…`,
    );

    await this._gstRun(pipeline);
    await this._writeVideoMaster(ladder);
    await this._resolveThumb();
    this.logger.info({ id: this.id }, 'Video PRODUCTION complete');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SOCIAL GST — audio and video VOD
  // ══════════════════════════════════════════════════════════════════════════

  async _gstAudioSocial(inputPath) {
    const { hlsDir } = this;
    const pl = [
      `filesrc location="${inputPath}"`,
      `! decodebin`,
      `! audioconvert ! audioresample`,
      `! audio/x-raw,rate=44100,channels=2`,
      `! avenc_aac bitrate=131072 compliance=-2 ! aacparse`,
      `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
      `           playlist-location="${hlsDir}/stream.m3u8"`,
      `           target-duration=10 max-files=0`,
    ].join(' ');
    await this._gstRun(pl);
    await fs.writeFile(path.join(hlsDir, 'master.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=131000,CODECS="mp4a.40.2"\nstream.m3u8\n');
  }

  async _gstVideoSocial(inputPath) {
    const { hlsDir } = this;
    const encFn = pickSocialEncoder(this.caps);
    const ext   = path.extname(inputPath).toLowerCase();
    const demux = ext === '.mp4' ? 'qtdemux name=d' : 'matroskademux name=d';
    const pl = [
      `filesrc location="${inputPath}" ! ${demux}`,
      `d. ! queue ! h264parse ! avdec_h264 ! videoconvert`,
      `! videoscale ! video/x-raw,width=${SOCIAL_RUNG.w},height=${SOCIAL_RUNG.h}`,
      `! ${encFn(SOCIAL_RUNG.vbr)}`,
      `! mpegtsmux name=mux`,
      `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
      `           playlist-location="${hlsDir}/stream.m3u8"`,
      `           target-duration=10 max-files=0`,
      `d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample`,
      `! avenc_aac bitrate=131072 compliance=-2 ! aacparse ! mux.`,
    ].join(' ');
    await this._gstRun(pl);
    await fs.writeFile(path.join(hlsDir, 'master.m3u8'),
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=${SOCIAL_RUNG.w}x${SOCIAL_RUNG.h},CODECS="avc1.42e01e,mp4a.40.2"\nstream.m3u8\n`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRODUCTION GST LIVE  —  RTMP
  //  Same tee architecture as VOD but uses rtmpsrc and 2s HLS fragments
  // ══════════════════════════════════════════════════════════════════════════

  _gstRtmpProduction({ rtmpUrl, audioOnly, ladder }) {
    const { hlsDir } = this;

    if (audioOnly) {
      const pl = [
        `rtmpsrc location="${rtmpUrl} live=1"`,
        `! flvdemux name=d`,
        `d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample`,
        `! audio/x-raw,rate=44100,channels=2 ! tee name=atee`,
        ...PROD_AUDIO_LADDER.flatMap(r => [
          `atee. ! queue ! avenc_aac bitrate=${r.bps} compliance=-2 ! aacparse`,
          `! hlssink2 location="${hlsDir}/${r.name}_%05d.ts"`,
          `           playlist-location="${hlsDir}/${r.name}.m3u8"`,
          `           target-duration=2 max-files=16`,
        ]),
      ].join(' ');
      const proc = this._gstLive(pl, 'rtmp-prod-audio');
      this._startHealthWatch();
      return proc;
    }

    const enc   = pickVideoEncoder(this.caps);
    const lines = [
      `rtmpsrc location="${rtmpUrl} live=1"`,
      `! flvdemux name=d`,
      `d. ! queue max-size-time=2000000000 max-size-bytes=0`,
      `! h264parse ! avdec_h264 ! videoconvert ! videorate`,
      `! video/x-raw,framerate=30/1 ! tee name=vtee`,
      `d. ! queue max-size-time=2000000000`,
      `! aacparse ! avdec_aac ! audioconvert ! audioresample`,
      `! audio/x-raw,rate=44100,channels=2 ! tee name=atee`,
    ];

    for (const r of ladder) {
      lines.push(
        `vtee. ! queue max-size-time=0 leaky=downstream`,
        `! videoscale ! video/x-raw,width=${r.w},height=${r.h}`,
        `! ${enc.enc(r.vbr)} ! mpegtsmux name=mux${r.name}`,
        `! hlssink2 location="${hlsDir}/${r.name}_%05d.ts"`,
        `           playlist-location="${hlsDir}/${r.name}.m3u8"`,
        `           target-duration=2 max-files=16`,
        `atee. ! queue ! avenc_aac bitrate=${r.abr * 1000} compliance=-2 ! aacparse ! mux${r.name}.`,
      );
    }

    this._writeVideoMasterSync(hlsDir, ladder, 2);
    const proc = this._gstLive(lines.join(' '), 'rtmp-prod-video');
    this._startHealthWatch();
    return proc;
  }

  _gstRtmpSocial({ rtmpUrl, audioOnly }) {
    const { hlsDir } = this;
    if (audioOnly) {
      const pl = [
        `rtmpsrc location="${rtmpUrl} live=1" ! flvdemux name=d`,
        `d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample`,
        `! avenc_aac bitrate=131072 compliance=-2 ! aacparse`,
        `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
        `           playlist-location="${hlsDir}/stream.m3u8"`,
        `           target-duration=1 max-files=10`,
      ].join(' ');
      return this._gstLive(pl, 'rtmp-social-audio');
    }
    const encFn = pickSocialEncoder(this.caps);
    const pl = [
      `rtmpsrc location="${rtmpUrl} live=1" ! flvdemux name=d`,
      `d. ! queue max-size-time=2000000000 ! h264parse ! avdec_h264 ! videoconvert`,
      `! videoscale ! video/x-raw,width=${SOCIAL_RUNG.w},height=${SOCIAL_RUNG.h}`,
      `! ${encFn(SOCIAL_RUNG.vbr)} ! mpegtsmux name=mux`,
      `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
      `           playlist-location="${hlsDir}/stream.m3u8"`,
      `           target-duration=1 max-files=10`,
      `d. ! queue ! aacparse ! avdec_aac ! audioconvert ! audioresample`,
      `! avenc_aac bitrate=131072 compliance=-2 ! aacparse ! mux.`,
    ].join(' ');
    return this._gstLive(pl, 'rtmp-social-video');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BROWSER LIVE  (MediaRecorder WebM → fdsrc stdin → GStreamer)
  // ══════════════════════════════════════════════════════════════════════════

  _gstBrowserProduction({ passThrough, audioOnly, ladder }) {
    const { hlsDir } = this;
    const enc = pickVideoEncoder(this.caps);

    if (audioOnly || !ladder.length) {
      return this._gstBrowserSocial({ passThrough, audioOnly: true });
    }

    const lines = [
      `fdsrc fd=0`,
      `! matroskademux name=d`,
      `d.video_0 ! queue ! vp8dec ! videoconvert ! videorate`,
      `! video/x-raw,framerate=30/1 ! tee name=vtee`,
      `d.audio_0 ! queue ! vorbisdec ! audioconvert ! audioresample`,
      `! audio/x-raw,rate=44100,channels=2 ! tee name=atee`,
    ];

    for (const r of ladder) {
      lines.push(
        `vtee. ! queue leaky=downstream ! videoscale`,
        `! video/x-raw,width=${r.w},height=${r.h}`,
        `! ${enc.enc(r.vbr)} ! mpegtsmux name=mux${r.name}`,
        `! hlssink2 location="${hlsDir}/${r.name}_%05d.ts"`,
        `           playlist-location="${hlsDir}/${r.name}.m3u8"`,
        `           target-duration=2 max-files=16`,
        `atee. ! queue ! avenc_aac bitrate=${r.abr * 1000} compliance=-2 ! aacparse ! mux${r.name}.`,
      );
    }

    this._writeVideoMasterSync(hlsDir, ladder, 2);
    const proc = this._gstLive(lines.join(' '), 'browser-prod', passThrough);
    this._startHealthWatch();
    return proc;
  }

  _gstBrowserSocial({ passThrough, audioOnly }) {
    const { hlsDir } = this;
    if (audioOnly) {
      const pl = [
        `fdsrc fd=0 ! matroskademux`,
        `! vorbisdec ! audioconvert ! audioresample`,
        `! avenc_aac bitrate=131072 compliance=-2 ! aacparse`,
        `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
        `           playlist-location="${hlsDir}/stream.m3u8"`,
        `           target-duration=1 max-files=10`,
      ].join(' ');
      return this._gstLive(pl, 'browser-social-audio', passThrough);
    }
    const encFn = pickSocialEncoder(this.caps);
    const pl = [
      `fdsrc fd=0 ! matroskademux name=d`,
      `d.video_0 ! queue ! vp8dec ! videoconvert`,
      `! videoscale ! video/x-raw,width=${SOCIAL_RUNG.w},height=${SOCIAL_RUNG.h}`,
      `! ${encFn(SOCIAL_RUNG.vbr)} ! mpegtsmux name=mux`,
      `! hlssink2 location="${hlsDir}/stream_%05d.ts"`,
      `           playlist-location="${hlsDir}/stream.m3u8"`,
      `           target-duration=1 max-files=10`,
      `d.audio_0 ! queue ! vorbisdec ! audioconvert ! audioresample`,
      `! avenc_aac bitrate=131072 compliance=-2 ! aacparse ! mux.`,
    ].join(' ');
    return this._gstLive(pl, 'browser-social-video', passThrough);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FFMPEG FALLBACKS  (mirrors every GStreamer path)
  // ══════════════════════════════════════════════════════════════════════════

  async _ffmpegAudioProduction(inputPath) {
    const { hlsDir } = this;
    for (const r of PROD_AUDIO_LADDER) {
      await _runProc(FFMPEG_PATH, [
        '-i', inputPath, '-vn',
        '-c:a', 'aac', '-b:a', `${Math.round(r.bps/1000)}k`, '-ar', '44100', '-ac', '2',
        '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
        '-hls_segment_filename', `${hlsDir}/${r.name}_%05d.ts`,
        `${hlsDir}/${r.name}.m3u8`,
      ]);
    }
    await this._writeAudioMaster();
  }

  async _ffmpegAudioSocial(inputPath) {
    const { hlsDir } = this;
    await _runProc(FFMPEG_PATH, [
      '-i', inputPath, '-vn',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
      '-hls_segment_filename', `${hlsDir}/stream_%05d.ts`,
      `${hlsDir}/stream.m3u8`,
    ]);
    await fs.writeFile(`${hlsDir}/master.m3u8`,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=131000,CODECS="mp4a.40.2"\nstream.m3u8\n');
  }

  async _ffmpegVideoProduction(inputPath, ladder) {
    const { hlsDir } = this;
    for (const r of ladder) {
      await _runProc(FFMPEG_PATH, [
        '-i', inputPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-maxrate', `${r.vbr}k`, '-bufsize', `${r.vbr * 2}k`,
        '-vf', `scale=${r.w}:${r.h}:force_original_aspect_ratio=decrease,pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2`,
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', `${r.abr}k`, '-ar', '44100', '-ac', '2',
        '-f', 'hls', '-hls_time', `${r.seg}`, '-hls_list_size', '0',
        '-hls_segment_filename', `${hlsDir}/${r.name}_%05d.ts`,
        `${hlsDir}/${r.name}.m3u8`,
      ]);
    }
    await _runProc(FFMPEG_PATH, ['-i', inputPath, '-ss', '5', '-frames:v', '1',
      '-vf', 'scale=320:-1', `${hlsDir}/thumb.jpg`]).catch(() => {});
    await this._writeVideoMaster(ladder);
  }

  async _ffmpegVideoSocial(inputPath) {
    const { hlsDir } = this;
    await _runProc(FFMPEG_PATH, [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-vf', `scale=${SOCIAL_RUNG.w}:${SOCIAL_RUNG.h}:force_original_aspect_ratio=decrease`,
      '-c:a', 'aac', '-b:a', `${SOCIAL_RUNG.abr}k`, '-ar', '44100',
      '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
      '-hls_segment_filename', `${hlsDir}/stream_%05d.ts`,
      `${hlsDir}/stream.m3u8`,
    ]);
    await fs.writeFile(`${hlsDir}/master.m3u8`,
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=${SOCIAL_RUNG.w}x${SOCIAL_RUNG.h},CODECS="avc1.42e01e,mp4a.40.2"\nstream.m3u8\n`);
  }

  _ffmpegRtmpProduction({ rtmpUrl, audioOnly, ladder }) {
    const { hlsDir } = this;
    const r = ladder[0] || { w: 1280, h: 720, vbr: 2800, abr: 128 };
    const args = audioOnly ? [
      '-i', rtmpUrl, '-vn', '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '16',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', `${hlsDir}/hi_%05d.ts`, `${hlsDir}/hi.m3u8`,
    ] : [
      '-i', rtmpUrl,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', `-b:v`, `${r.vbr}k`,
      '-c:a', 'aac', `-b:a`, `${r.abr}k`, '-ar', '44100',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '16',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', `${hlsDir}/${r.name || '720p'}_%05d.ts`,
      `${hlsDir}/${r.name || '720p'}.m3u8`,
    ];
    this._writeVideoMasterSync(hlsDir, ladder.slice(0,1), 2);
    return this._ffmpegLive(args, 'rtmp-prod-ffmpeg');
  }

  _ffmpegRtmpSocial({ rtmpUrl, audioOnly }) {
    const { hlsDir } = this;
    const args = audioOnly ? [
      '-i', rtmpUrl, '-vn', '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '10', '-hls_flags', 'delete_segments',
      '-hls_segment_filename', `${hlsDir}/stream_%05d.ts`, `${hlsDir}/stream.m3u8`,
    ] : [
      '-i', rtmpUrl,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', `${SOCIAL_RUNG.vbr}k`,
      '-c:a', 'aac', '-b:a', `${SOCIAL_RUNG.abr}k`, '-ar', '44100',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '10', '-hls_flags', 'delete_segments',
      '-hls_segment_filename', `${hlsDir}/stream_%05d.ts`, `${hlsDir}/stream.m3u8`,
    ];
    return this._ffmpegLive(args, 'rtmp-social-ffmpeg');
  }

  _ffmpegBrowserProduction({ passThrough, audioOnly }) {
    return this._ffmpegBrowserLive({ passThrough, audioOnly, vbr: 2800, abr: 128, hlsSeg: 2, maxFiles: 16 });
  }

  _ffmpegBrowserSocial({ passThrough, audioOnly }) {
    return this._ffmpegBrowserLive({ passThrough, audioOnly, vbr: SOCIAL_RUNG.vbr, abr: SOCIAL_RUNG.abr, hlsSeg: 1, maxFiles: 10 });
  }

  _ffmpegBrowserLive({ passThrough, audioOnly, vbr, abr, hlsSeg, maxFiles }) {
    const { hlsDir } = this;
    const args = [
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', 'pipe:0',
      ...(audioOnly ? ['-vn'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', `${vbr}k`]),
      '-c:a', 'aac', '-b:a', `${abr}k`, '-ar', '44100',
      '-f', 'hls', '-hls_time', `${hlsSeg}`, '-hls_list_size', `${maxFiles}`,
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', `${hlsDir}/stream_%05d.ts`,
      `${hlsDir}/stream.m3u8`,
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    passThrough.pipe(proc.stdin);
    proc.stderr?.on('data', d => this.logger.debug({ id: this.id }, `FF: ${d}`));
    proc.on('error', err => this.emit('error', err));
    proc.on('close', (c, s) => this._onClose(c, 'ff-browser', s));
    this._procs.push(proc);
    return proc;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STOP + HEALTH
  // ══════════════════════════════════════════════════════════════════════════

  async stop() {
    this._stopped = true;
    clearInterval(this._healthT);
    await Promise.all(this._procs.map(p => new Promise(res => {
      if (!p || p.exitCode !== null) return res();
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} res(); }, 8000);
      p.on('close', () => { clearTimeout(t); res(); });
      try { p.kill('SIGINT'); } catch (_) {}
    })));
    this._procs = [];
    this.emit('stopped', { id: this.id });
    this.logger.info({ id: this.id }, 'Pipeline stopped');
  }

  _startHealthWatch() {
    this._healthT = setInterval(() => {
      const alive = this._procs.filter(p => p.exitCode === null).length;
      this.emit('health', { id: this.id, alive, total: this._procs.length });
      if (!this._stopped && alive === 0)
        this.emit('all_dead', { id: this.id });
    }, 15000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNALS
  // ══════════════════════════════════════════════════════════════════════════

  async _gstRun(pipelineStr) {
    return _runProc(GST_LAUNCH, ['-e', pipelineStr]);
  }

  _gstLive(pipelineStr, label, stdinStream) {
    const stdio = stdinStream ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const proc  = spawn(GST_LAUNCH, ['-e', pipelineStr], { stdio });
    if (stdinStream) stdinStream.pipe(proc.stdin);
    proc.stdout?.on('data', d => this.logger.debug({ id: this.id, label }, `GST: ${d}`));
    proc.stderr?.on('data', d => this.logger.debug({ id: this.id, label }, `GST: ${d}`));
    proc.on('error', err => { this.logger.error({ id: this.id, label, err }); this.emit('error', { label, err }); });
    proc.on('close', (c, s) => this._onClose(c, label, s));
    this._procs.push(proc);
    return proc;
  }

  _ffmpegLive(args, label) {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr?.on('data', d => this.logger.debug({ id: this.id, label }, `FF: ${d}`));
    proc.on('error', err => { this.logger.error({ id: this.id, label, err }); this.emit('error', { label, err }); });
    proc.on('close', (c, s) => this._onClose(c, label, s));
    this._procs.push(proc);
    return proc;
  }

  _onClose(code, label, signal) {
    this.logger.info({ id: this.id, label, code, signal }, 'process closed');
    if (!this._stopped) this.emit('pipeline_closed', { id: this.id, label, code, signal });
  }

  async _writeAudioMaster() {
    const bwMap = { hi: 320000, mid: 256000, lo: 128000 };
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const r of PROD_AUDIO_LADDER) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bwMap[r.name]},CODECS="mp4a.40.2"\n${r.name}.m3u8`);
    }
    await fs.writeFile(path.join(this.hlsDir, 'master.m3u8'), lines.join('\n') + '\n');
  }

  async _writeVideoMaster(ladder) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const r of ladder) {
      const bw = (r.vbr + r.abr) * 1000;
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${r.w}x${r.h},CODECS="avc1.42e01e,mp4a.40.2"\n${r.name}.m3u8`);
    }
    await fs.writeFile(path.join(this.hlsDir, 'master.m3u8'), lines.join('\n') + '\n');
  }

  _writeVideoMasterSync(hlsDir, ladder, seg) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const r of ladder) {
      const bw = ((r.vbr || 2800) + (r.abr || 128)) * 1000;
      const name = r.name || '720p';
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${r.w || 1280}x${r.h || 720},CODECS="avc1.42e01e,mp4a.40.2"\n${name}.m3u8`);
    }
    fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), lines.join('\n') + '\n');
  }

  async _resolveThumb() {
    try {
      const files = (await fs.readdir(this.hlsDir))
        .filter(f => /^thumb_\d+\.jpg$/.test(f)).sort().reverse();
      if (files.length)
        await fs.copy(path.join(this.hlsDir, files[0]), path.join(this.hlsDir, 'thumb.jpg'));
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _cmd(cmd, args) {
  return new Promise((res, rej) => {
    const chunks = [];
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => chunks.push(d));
    p.on('error', rej);
    p.on('close', c => c === 0 ? res(Buffer.concat(chunks).toString()) : rej(new Error(`${cmd} exit ${c}`)));
  });
}

function _runProc(cmd, args) {
  return new Promise((res, rej) => {
    const errs = [];
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stderr?.on('data', d => errs.push(d));
    p.on('error', rej);
    p.on('close', c => c === 0 ? res() : rej(new Error(`${cmd} exit ${c}: ${Buffer.concat(errs).toString().slice(0,300)}`)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  GstPipeline,
  detectCapabilities,
  pickVideoEncoder,
  pickSocialEncoder,
  MODES,
  STREAMS_ROOT,
  HLS_ROOT,
  PROD_VIDEO_LADDER,
  PROD_AUDIO_LADDER,
  SOCIAL_RUNG,
};
