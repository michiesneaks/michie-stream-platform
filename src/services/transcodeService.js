'use strict';

const path    = require('path');
const fs      = require('fs-extra');
const ffmpeg  = require('fluent-ffmpeg');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');
const sharp   = require('sharp');
const logger  = require('../config/logger');

// ── FFmpeg path setup ─────────────────────────────────────────────────────────
try {
  const installer = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || installer.path);
} catch {
  if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

// ── Quality validation ────────────────────────────────────────────────────────

async function validateQuality(filePath, contentType, devMode = false) {
  const data = await new Promise((resolve, reject) =>
    ffprobe(filePath, { path: ffprobeStatic.path }, (err, info) =>
      err ? reject(err) : resolve(info))
  );

  const audioStream = data?.streams?.find((s) => s.codec_type === 'audio');
  const videoStream = data?.streams?.find((s) => s.codec_type === 'video');

  if (contentType === 'music' || contentType === 'podcast') {
    if (!audioStream) throw new Error('No audio stream found in uploaded file');
    if (!devMode) {
      const bitrate = parseInt(audioStream.bit_rate || '0', 10);
      if (bitrate && bitrate < 128000) {
        throw new Error(`Audio bitrate too low (${bitrate}bps — minimum 128 kbps)`);
      }
    }
  }

  if (contentType === 'video') {
    if (!videoStream) throw new Error('No video stream — upload an MP4, MOV, MKV, or WebM file');
    if (!audioStream) throw new Error('Video must include an audio track');
    if (!devMode) {
      const vBitrate = parseInt(videoStream.bit_rate || data?.format?.bit_rate || '0', 10);
      if (vBitrate && vBitrate < 500000) {
        throw new Error(`Video bitrate too low (${vBitrate}bps — minimum 500 kbps)`);
      }
    }
  }

  if (contentType === 'art_animated') {
    if (!videoStream) throw new Error('Animated art must be a video file (MP4, WebM)');
  }

  return { audioStream, videoStream, format: data?.format };
}

async function validateImage(filePath, devMode = false) {
  const meta  = await sharp(filePath).metadata();
  const stats = await fs.stat(filePath);

  if (stats.size > 10 * 1024 * 1024) throw new Error('Cover image must be under 10MB');

  if (!devMode) {
    if (meta.width < 1000 || meta.height < 1000) {
      throw new Error('Cover image must be at least 1000×1000px');
    }
    const aspectRatio = meta.width / meta.height;
    if (Math.abs(aspectRatio - 1) > 0.05) {
      throw new Error('Cover image must be square (1:1 aspect ratio)');
    }
  }
}

// ── Audio HLS transcoding — DEV (single-pass, lo+hi only for speed) ──────────

async function transcodeAudioDev(inputPath, outputDir, contentId) {
  const previewPath = path.join(outputDir, 'preview.mp3');

  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions(['-t', '30', '-b:a', '128k', '-ar', '44100'])
      .audioCodec('libmp3lame')
      .output(previewPath)
  ).catch(() => {}); // preview failure is non-fatal

  await runFfmpeg(
    ffmpeg(inputPath)
      .output(path.join(outputDir, 'lo.m3u8'))
        .audioCodec('aac').audioBitrate('128k').audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '10').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, 'lo_%03d.ts'))
      .output(path.join(outputDir, 'hi.m3u8'))
        .audioCodec('aac').audioBitrate('320k').audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '10').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, 'hi_%03d.ts'))
      .on('start', (cmd) => logger.info({ contentId }, 'FFmpeg DEV audio: ' + cmd))
  );

  const master =
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nlo.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"\nhi.m3u8\n';
  await fs.writeFile(path.join(outputDir, 'master.m3u8'), master);

  return { previewPath: await fs.pathExists(previewPath) ? previewPath : null };
}

// ── Audio HLS transcoding — PRODUCTION (lo + mid + hi) ───────────────────────

async function transcodeAudioProd(inputPath, outputDir, contentId) {
  const previewPath = path.join(outputDir, 'preview.mp3');

  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions(['-t', '30', '-b:a', '128k', '-ar', '44100'])
      .audioCodec('libmp3lame')
      .output(previewPath)
  );

  await runFfmpeg(
    ffmpeg(inputPath)
      .output(path.join(outputDir, 'lo.m3u8'))
        .audioCodec('aac').audioBitrate('128k').audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '10').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, 'lo_%03d.ts'))
      .output(path.join(outputDir, 'mid.m3u8'))
        .audioCodec('aac').audioBitrate('256k').audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '10').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, 'mid_%03d.ts'))
      .output(path.join(outputDir, 'hi.m3u8'))
        .audioCodec('aac').audioBitrate('320k').audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '10').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, 'hi_%03d.ts'))
      .on('start', (cmd) => logger.info({ contentId }, 'FFmpeg audio: ' + cmd))
  );

  const master =
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nlo.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\nmid.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"\nhi.m3u8\n';
  await fs.writeFile(path.join(outputDir, 'master.m3u8'), master);

  return { previewPath };
}

// ── Video HLS transcoding — adaptive ladder ───────────────────────────────────

async function transcodeVideo(inputPath, outputDir, contentId, sourceHeight) {
  const previewPath = path.join(outputDir, 'preview.mp4');
  const ladder      = buildVideoLadder(sourceHeight || 720);
  const bwMap       = { '1080p': 4500000, '720p': 2800000, '480p': 1400000 };

  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions(['-ss', '0', '-t', '5', '-vf', 'scale=640:-1'])
      .output(previewPath)
      .on('error', () => logger.warn({ contentId }, 'Video preview generation failed — non-fatal'))
  ).catch(() => {});

  for (const rung of ladder) {
    await runFfmpeg(
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .outputOptions([
          '-preset', 'veryfast', '-crf', '22',
          '-maxrate', rung.vbr, '-bufsize', `${parseInt(rung.vbr) * 2}k`,
          '-vf', `scale=${rung.w}:${rung.h}:force_original_aspect_ratio=decrease,pad=${rung.w}:${rung.h}:(ow-iw)/2:(oh-ih)/2`,
          '-g', '48', '-keyint_min', '48',
        ])
        .audioCodec('aac').audioBitrate(rung.abr).audioFrequency(44100)
        .format('hls')
        .addOption('-hls_time', '6').addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', path.join(outputDir, `${rung.name}_%03d.ts`))
        .output(path.join(outputDir, `${rung.name}.m3u8`))
        .on('start', (cmd) => logger.info({ contentId, rung: rung.name }, 'FFmpeg video: ' + cmd))
    );
  }

  const master =
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
    ladder.map((r) =>
      `#EXT-X-STREAM-INF:BANDWIDTH=${bwMap[r.name]},RESOLUTION=${r.w}x${r.h},CODECS="avc1.42e01e,mp4a.40.2"\n${r.name}.m3u8`
    ).join('\n') + '\n';
  await fs.writeFile(path.join(outputDir, 'master.m3u8'), master);

  return { previewPath: await fs.pathExists(previewPath) ? previewPath : null };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildVideoLadder(sourceHeight) {
  const ladder = [];
  if (sourceHeight >= 1080) ladder.push({ h: 1080, w: 1920, vbr: '4000k', abr: '192k', name: '1080p' });
  if (sourceHeight >= 720)  ladder.push({ h: 720,  w: 1280, vbr: '2500k', abr: '128k', name: '720p' });
  ladder.push(               { h: 480,  w: 854,  vbr: '1200k', abr: '128k', name: '480p' });
  return ladder;
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on('end', resolve).on('error', reject).run();
  });
}

module.exports = {
  validateQuality,
  validateImage,
  transcodeAudioDev,
  transcodeAudioProd,
  transcodeVideo,
};
