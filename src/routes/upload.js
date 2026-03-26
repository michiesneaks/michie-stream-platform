'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs-extra');
const crypto         = require('crypto');
const multer         = require('multer');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const { FEES, VALID_CONTENT_TYPES } = require('../config/constants');
const { DEV_MODE, isDevWallet } = require('../middleware/devBypass');
const profileService   = require('../services/profileService');
const catalogService   = require('../services/catalogService');
const transcodeService = require('../services/transcodeService');
const ipfsService      = require('../services/ipfsService');
const { ethers, ADDRESSES, signEIP712, mspWallet, provider } = require('../services/ethService');

let blake3;
try {
  blake3 = require('blake3');
} catch {
  if (process.env.FORCE_BLAKE3 === 'true') throw new Error('BLAKE3 required but failed to load');
}

// ── Multer configuration ──────────────────────────────────────────────────────
const ALLOWED_MEDIA_MIMES = new Set([
  'audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave',
  'audio/ogg','audio/flac','audio/x-flac','audio/aac','audio/mp4','audio/x-m4a',
  'video/mp4','video/quicktime','video/x-matroska','video/webm',
]);
const ALLOWED_MEDIA_EXTS  = /\.(mp3|wav|ogg|flac|aac|m4a|mp4|mov|mkv|webm)$/i;
const ALLOWED_IMAGE_MIMES = new Set(['image/png','image/jpeg','image/webp']);
const ALLOWED_IMAGE_EXTS  = /\.(png|jpg|jpeg|webp)$/i;

fs.ensureDirSync(path.join(__dirname, '..', '..', 'temp'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'temp')),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'audio-file') {
      return (ALLOWED_MEDIA_MIMES.has(file.mimetype) && ALLOWED_MEDIA_EXTS.test(file.originalname))
        ? cb(null, true)
        : cb(new Error(`Unsupported media type: ${file.mimetype}`));
    }
    if (file.fieldname === 'cover-image') {
      return (ALLOWED_IMAGE_MIMES.has(file.mimetype) && ALLOWED_IMAGE_EXTS.test(file.originalname))
        ? cb(null, true)
        : cb(new Error('Cover image must be PNG, JPG, or WebP'));
    }
    cb(null, true);
  },
});

// ── Route ─────────────────────────────────────────────────────────────────────
const router = express.Router();

router.post('/', upload.fields([{ name: 'audio-file', maxCount: 1 }, { name: 'cover-image', maxCount: 1 }]),
  async (req, res, next) => {
    const tempFiles = [];
    const cleanup   = () => Promise.all(tempFiles.map((p) => fs.remove(p).catch(() => {})));

    try {
      const audioFile  = req.files?.['audio-file']?.[0];
      const coverImage = req.files?.['cover-image']?.[0];
      if (audioFile)  tempFiles.push(audioFile.path);
      if (coverImage) tempFiles.push(coverImage.path);

      const fields = parseFields(req.body);
      validateRequiredFields(audioFile, coverImage, fields);

      if (!isDevWallet(fields.wallet)) {
        await assertCreatorProfile(fields.wallet);
      }

      assertSaneFilename(audioFile.originalname);

      const probeData = await transcodeService.validateQuality(audioFile.path, fields.contentType, DEV_MODE)
        .catch((err) => { throw new Error('Quality check: ' + err.message); });
      await transcodeService.validateImage(coverImage.path, DEV_MODE)
        .catch((err) => { throw new Error('Cover image: ' + err.message); });

      const profiles    = await profileService.loadProfiles();
      const profile     = profiles[fields.wallet] || { royalty_fee_rate: FEES.PLATFORM_ROYALTY_STANDARD };
      const contentId   = uuidv4();
      const hashes      = await computeHashes(audioFile.path, coverImage.path);
      const metadata    = buildMetadata(contentId, fields, profile, probeData, hashes);
      const tempDir     = path.join(__dirname, '..', '..', 'temp', contentId);
      tempFiles.push(tempDir);
      await fs.ensureDir(tempDir);

      if (DEV_MODE && !ipfsService.ipfs) {
        const result = await handleDevUpload(contentId, fields, audioFile, coverImage, metadata, tempDir, profiles);
        await cleanup();
        return res.json(result);
      }

      const result = await handleProdUpload(contentId, fields, audioFile, coverImage, metadata, tempDir, probeData, profiles, profile);
      await cleanup();
      return res.json(result);

    } catch (err) {
      await cleanup();
      logger.error({ err }, 'Upload failed');
      res.status(400).json({ error: String(err.message || err) });
    }
  }
);

// ── Field parsing ─────────────────────────────────────────────────────────────
function parseFields(body = {}) {
  const rawType     = body.contentType || 'music';
  const contentType = VALID_CONTENT_TYPES.includes(rawType) ? rawType : 'music';
  return {
    contentType,
    isAudioOnly: contentType === 'music' || contentType === 'podcast',
    isVideoType: contentType === 'video' || contentType === 'art_animated',
    isArtStill:  contentType === 'art_still',
    songTitle:   body.songTitle,
    artistName:  body.artistName,
    description: body.description    || '',
    album:       body.album          || '',
    bpm:         body.bpm            || '',
    episodeNumber: body.episodeNumber || '',
    seriesName:  body.seriesName     || '',
    releaseDate: body.releaseDate,
    userId:      body.userId,
    wallet:      body.wallet,
    tags:        String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    mlc_iswc:    body.mlc_iswc            || '',
    mlc_ipi:     body.mlc_ipi_name_number || '',
    isrc:        body.isrc               || '',
    mintNft:     body.mintNft,
  };
}

function validateRequiredFields(audioFile, coverImage, fields) {
  if (!audioFile)        throw new Error('Media file is required');
  if (!coverImage)       throw new Error('Cover image is required');
  if (!fields.songTitle) throw new Error('Title is required');
  if (!fields.artistName) throw new Error('Artist name is required');
  if (!fields.userId || !fields.wallet) throw new Error('Missing userId or wallet');
}

function assertSaneFilename(filename) {
  if (/^(track\d+|song\d+|test\d*|untitled)\.(mp3|mp4|wav|webm)$/i.test(filename)) {
    throw new Error('Please rename your file before uploading.');
  }
}

async function assertCreatorProfile(wallet) {
  const profiles = await profileService.loadProfiles();
  const profile  = profiles[wallet];
  if (!profile) throw new Error('Profile not found. Create a profile first.');
  if (!['creator', 'platform_nft_creator'].includes(profile.account_type)) {
    throw new Error('A creator account is required to upload content.');
  }
}

// ── Hashing ───────────────────────────────────────────────────────────────────
async function computeHashes(audioPath, coverPath) {
  const audioData  = await fs.readFile(audioPath);
  const coverData  = await fs.readFile(coverPath);
  return {
    sha256Audio:  crypto.createHash('sha256').update(audioData).digest('hex'),
    sha256Cover:  crypto.createHash('sha256').update(coverData).digest('hex'),
    blake3Audio:  blake3 ? blake3.hash(audioData).toString('hex') : null,
    blake3Cover:  blake3 ? blake3.hash(coverData).toString('hex') : null,
  };
}

// ── Metadata builder ──────────────────────────────────────────────────────────
function buildMetadata(contentId, fields, profile, probeData, hashes) {
  const base = {
    id:           contentId,
    title:        fields.songTitle,
    description:  fields.description,
    creator: {
      name:           fields.artistName,
      user_id:        fields.userId,
      wallet_address: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(fields.wallet)),
    },
    content_type:      fields.contentType,
    availability_type: 'on_demand',
    release_date:      fields.releaseDate || new Date().toISOString().split('T')[0],
    tags:              fields.tags,
    files:             {},
    royalty_fee_rate:  profile.royalty_fee_rate,
    integrityHashes: {
      sha256Audio: hashes.sha256Audio,
      sha256Cover: hashes.sha256Cover,
      ...(hashes.blake3Audio ? { blake3Audio: hashes.blake3Audio } : {}),
      ...(hashes.blake3Cover ? { blake3Cover: hashes.blake3Cover } : {}),
    },
  };

  if (fields.isAudioOnly) {
    base.mlc_metadata = {
      work_title:      fields.songTitle,
      iswc:            fields.mlc_iswc,
      isrc:            fields.isrc,
      ipi_name_number: fields.mlc_ipi,
      writers: [{ name: fields.artistName, role: 'artist', ipi_name_number: fields.mlc_ipi, ownership_percent: 100 }],
      publishers: [],
    };
  }
  if (fields.contentType === 'music') {
    if (fields.album) base.album = fields.album;
    if (fields.bpm)   base.bpm   = parseInt(fields.bpm, 10) || null;
  }
  if (fields.contentType === 'podcast') {
    if (fields.episodeNumber) base.episode_number = parseInt(fields.episodeNumber, 10) || null;
    if (fields.seriesName)    base.series_name    = fields.seriesName;
  }
  if (fields.isVideoType) {
    base.video = {
      width:    probeData?.videoStream?.width    || null,
      height:   probeData?.videoStream?.height   || null,
      codec:    probeData?.videoStream?.codec_name || null,
      duration: parseFloat(probeData?.format?.duration || '0') || null,
    };
  }
  return base;
}

// ── DEV upload path ───────────────────────────────────────────────────────────
async function handleDevUpload(contentId, fields, audioFile, coverImage, metadata, tempDir, profiles) {
  const catalogDir = path.join(process.cwd(), 'public', 'catalog', contentId);
  const hlsDir     = path.join(catalogDir, 'hls');
  await fs.ensureDir(hlsDir);

  const coverExt  = path.extname(coverImage.originalname) || '.jpg';
  const coverDest = path.join(catalogDir, 'cover' + coverExt);
  await fs.copy(coverImage.path, coverDest);
  metadata.files.cover_image = `/catalog/${contentId}/cover${coverExt}`;

  if (fields.isAudioOnly) {
    const { previewPath } = await transcodeService.transcodeAudioDev(audioFile.path, hlsDir, contentId);
    if (previewPath) {
      await fs.copy(previewPath, path.join(catalogDir, 'preview.mp3'));
      metadata.files.preview_url = `/catalog/${contentId}/preview.mp3`;
    }
    metadata.ipfs_audio_url  = `/catalog/${contentId}/hls/master.m3u8`;
    metadata.files.hls_url   = metadata.ipfs_audio_url;
  } else {
    const mediaDest = path.join(catalogDir, 'media' + path.extname(audioFile.originalname));
    await fs.copy(audioFile.path, mediaDest);
    metadata.files.media_url    = `/catalog/${contentId}/media${path.extname(audioFile.originalname)}`;
    metadata.ipfs_audio_url     = metadata.files.media_url;
    metadata.files.hls_url      = metadata.files.media_url;
  }

  await writeMetadata(catalogDir, metadata);
  await updateProfilePlaylist(profiles, fields.wallet, `local:${contentId}`);

  await catalogService.addCatalogEntry(contentId, {
    contentId,
    title:       metadata.title,
    artistName:  metadata.creator.name,
    wallet:      fields.wallet,
    contentType: fields.contentType,
    metadataUrl: `/catalog/${contentId}/metadata.json`,
    hlsUrl:      metadata.ipfs_audio_url,
    coverUrl:    metadata.files.cover_image,
    previewUrl:  metadata.files.preview_url || null,
  });

  logger.info({ contentId, contentType: fields.contentType, wallet: fields.wallet }, 'DEV upload complete');
  return {
    success:          true,
    contentId,
    contentType:      fields.contentType,
    hlsUrl:           metadata.ipfs_audio_url,
    metadataUrl:      `/catalog/${contentId}/metadata.json`,
    metadataCid:      `local:${contentId}`,
    coverCid:         metadata.files.cover_image,
    caSignature:      null,
    royalty_fee_rate: metadata.royalty_fee_rate,
    mint_pending:     false,
    dev_mode:         true,
  };
}

// ── Production upload path ────────────────────────────────────────────────────
async function handleProdUpload(contentId, fields, audioFile, coverImage, metadata, tempDir, probeData, profiles, profile) {
  const ipfs   = ipfsService.ipfs;
  const hlsDir = path.join(tempDir, 'hls');
  await fs.ensureDir(hlsDir);

  if (fields.isArtStill) {
    const result = await ipfs.add({ path: 'media' + path.extname(audioFile.originalname), content: fs.createReadStream(audioFile.path) });
    metadata.files.media_url = `ipfs://${result.cid.toString()}`;

  } else if (fields.isAudioOnly) {
    const { previewPath } = await transcodeService.transcodeAudioProd(audioFile.path, hlsDir, contentId);
    const previewAdd      = await ipfs.add({ path: 'preview.mp3', content: fs.createReadStream(previewPath) });
    metadata.files.preview_url = `ipfs://${previewAdd.cid.toString()}`;
    const { folderCid } = await ipfsService.addDirectoryToIpfs(ipfs, hlsDir);
    metadata.ipfs_audio_url = `ipfs://${folderCid}/master.m3u8`;
    metadata.files.hls_url  = metadata.ipfs_audio_url;

  } else {
    const { previewPath } = await transcodeService.transcodeVideo(audioFile.path, hlsDir, contentId, probeData?.videoStream?.height);
    if (previewPath) {
      const previewAdd = await ipfs.add({ path: 'preview.mp4', content: fs.createReadStream(previewPath) });
      metadata.files.preview_url = `ipfs://${previewAdd.cid.toString()}`;
    }
    const { folderCid } = await ipfsService.addDirectoryToIpfs(ipfs, hlsDir);
    metadata.ipfs_audio_url = `ipfs://${folderCid}/master.m3u8`;
    metadata.files.hls_url  = metadata.ipfs_audio_url;
  }

  const coverAdd = await ipfs.add({ path: 'cover' + path.extname(coverImage.originalname), content: fs.createReadStream(coverImage.path) });
  metadata.files.cover_image = `ipfs://${coverAdd.cid.toString()}`;

  const metaStr     = JSON.stringify(metadata);
  const sha256Meta  = crypto.createHash('sha256').update(metaStr).digest('hex');
  const blake3Meta  = blake3 ? blake3.hash(Buffer.from(metaStr)).toString('hex') : null;
  metadata.integrityHashes.sha256Metadata = sha256Meta;
  if (blake3Meta) metadata.integrityHashes.blake3Metadata = blake3Meta;

  const { cid: metadataCid } = await ipfs.add(JSON.stringify(metadata));
  const metadataCidStr = metadataCid.toString();

  let caSignature = null;
  if (provider && mspWallet) {
    try {
      const network   = await provider.getNetwork();
      const domain    = { name: 'ContentCA', version: '1', chainId: Number(network.chainId), verifyingContract: ADDRESSES.contentCA };
      const types     = { Certificate: [{ name: 'cid', type: 'string' }, { name: 'contentType', type: 'string' }] };
      caSignature     = await signEIP712(domain, types, { cid: metadataCidStr, contentType: fields.contentType });
    } catch (err) {
      logger.warn({ contentId, err }, 'EIP-712 signing skipped');
    }
  }

  await updateProfilePlaylist(profiles, fields.wallet, metadataCidStr);

  logger.info({ contentId, contentType: fields.contentType, wallet: fields.wallet, metadataCidStr }, 'Upload complete');
  return {
    success:          true,
    contentId,
    contentType:      fields.contentType,
    hlsUrl:           metadata.ipfs_audio_url || metadata.files?.media_url,
    metadataUrl:      `ipfs://${metadataCidStr}`,
    metadataCid:      metadataCidStr,
    coverCid:         metadata.files.cover_image,
    caSignature,
    royalty_fee_rate: profile.royalty_fee_rate,
    mint_pending:     fields.mintNft === 'true',
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────
async function writeMetadata(dir, metadata) {
  const str  = JSON.stringify(metadata, null, 2);
  const hash = crypto.createHash('sha256').update(str).digest('hex');
  metadata.integrityHashes.sha256Metadata = hash;
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
}

async function updateProfilePlaylist(profiles, wallet, cid) {
  const fresh = await profileService.loadProfiles();
  if (!fresh[wallet]) return;
  if (!fresh[wallet].playlist_cids) fresh[wallet].playlist_cids = [];
  fresh[wallet].playlist_cids.push(cid);
  await profileService.saveProfiles(fresh);
}

module.exports = router;
