'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs-extra');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const logger   = require('../config/logger');
const { isDevWallet } = require('../middleware/devBypass');
const profileService  = require('../services/profileService');
const redisService    = require('../services/redisService');
const { IPFS_GATEWAY } = require('../services/ipfsService');
const { streamingContract, ethers } = require('../services/ethService');
const { v4: uuidv4 } = require('uuid');

let blake3;
try { blake3 = require('blake3'); } catch { /* optional */ }

const PLAY_TOKEN_SECRET = process.env.PLAY_TOKEN_SECRET || 'dev-play-secret';

const STREAMABLE_LEVELS = new Set([
  'listener_1', 'listener_2', 'listener_3', 'creator_active', 'nft_creator_active',
]);

const router = express.Router();

// POST /api/request-play-token
router.post('/request', async (req, res, next) => {
  try {
    const { cid, listener, live, playlistId } = req.body || {};
    if (!cid || !listener) return res.status(400).json({ error: 'Missing fields' });

    if (!isDevWallet(listener)) {
      const profiles = await profileService.loadProfiles();
      const level    = profileService.getCapabilityLevel(profiles[listener]);
      if (!STREAMABLE_LEVELS.has(level)) {
        return res.status(403).json({ error: 'Active subscription required to stream.', pay_per_play: true });
      }
    }

    const playId  = uuidv4();
    const payload = { playId, cid, listener, live: !!live, playlistId, iat: Math.floor(Date.now() / 1000) };
    const token   = jwt.sign(payload, PLAY_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    res.json({ playToken: token });
  } catch (err) { next(err); }
});

// POST /api/submit-play-proof
router.post('/proof', async (req, res, next) => {
  try {
    const { playToken } = req.body || {};
    const decoded       = jwt.verify(playToken, PLAY_TOKEN_SECRET);
    const replayKey     = `play:${decoded.playId}`;

    const redis = redisService.getClient();
    if (redis && await redis.exists(replayKey)) throw new Error('Replay detected');
    if (redis) await redis.set(replayKey, 'used', { EX: 86400 });

    await verifyMetadataIntegrity(decoded.cid);

    if (streamingContract) {
      const metadataHash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['bytes32', 'string', 'address', 'bool'],
          [decoded.playId, decoded.cid, decoded.listener, !!decoded.live]
        )
      );
      const tx = await streamingContract.logPlay(
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes(decoded.playId)),
        decoded.cid, decoded.listener, !!decoded.live, metadataHash
      );
      await tx.wait();
    } else {
      logger.warn({ playId: decoded.playId }, 'logPlay skipped — DEV_MODE');
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Proof verification failed');
    res.status(400).json({ error: 'Invalid proof' });
  }
});

async function verifyMetadataIntegrity(cid) {
  if (!cid) return;

  // DEV_MODE: local CIDs start with 'local:'
  if (cid.startsWith('local:')) {
    const contentId = cid.replace('local:', '');
    const metaPath  = path.join(process.cwd(), 'public', 'catalog', contentId, 'metadata.json');
    try {
      await fs.readFile(metaPath, 'utf8');
      logger.info({ contentId }, 'DEV play proof — local metadata verified');
    } catch {
      logger.warn({ contentId }, 'DEV play proof — local metadata not found');
    }
    return;
  }

  // Production: fetch from IPFS gateway and verify hashes
  const response = await fetch(`${IPFS_GATEWAY}${cid}`);
  if (!response.ok) throw new Error(`IPFS fetch failed: ${response.status}`);

  const fetchedMetadata = await response.json();
  const recomputedSha   = crypto.createHash('sha256').update(JSON.stringify(fetchedMetadata)).digest('hex');

  if (recomputedSha !== fetchedMetadata.integrityHashes?.sha256Metadata) {
    throw new Error('Metadata integrity failed (sha256 mismatch)');
  }
  if (blake3 && fetchedMetadata.integrityHashes?.blake3Metadata) {
    const recomputedB3 = blake3.hash(Buffer.from(JSON.stringify(fetchedMetadata))).toString('hex');
    if (recomputedB3 !== fetchedMetadata.integrityHashes.blake3Metadata) {
      throw new Error('Metadata integrity failed (blake3 mismatch)');
    }
  }
}

module.exports = router;
