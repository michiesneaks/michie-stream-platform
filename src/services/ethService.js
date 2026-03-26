'use strict';

const { ethers }    = require('ethers');
const logger        = require('../config/logger');
const { DEV_MODE }  = require('../middleware/devBypass');
const { awsKmsSignEIP712 } = require('./module_aws_shim');

// ── Contract addresses ────────────────────────────────────────────────────────
const ADDRESSES = {
  contentCA:         process.env.CONTENT_CA_ADDRESS          || '0x0000000000000000000000000000000000000000',
  streamingRegistry: process.env.STREAMING_REGISTRY_ADDRESS  || '0x0000000000000000000000000000000000000000',
  royaltyPayout:     process.env.ROYALTY_PAYOUT_ADDRESS      || '0x0000000000000000000000000000000000000000',
  escrow:            process.env.ESCROW_CONTRACT_ADDRESS      || '0x0000000000000000000000000000000000000000',
  platformNft:       process.env.PLATFORM_NFT_ADDRESS         || '0x0000000000000000000000000000000000000000',
};

// Minimal ERC-721 ABI — only what we need for ownership checks
const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

// ── Provider + wallet initialization ─────────────────────────────────────────
let provider         = null;
let mspWallet        = null;
let streamingContract = null;

if (!DEV_MODE) {
  try {
    provider   = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC);
    mspWallet  = new ethers.Wallet(process.env.MSP_PRIVATE_KEY, provider);

    const streamingRegistryABI = global.STREAMING_REGISTRY_ABI || [];
    streamingContract = new ethers.Contract(ADDRESSES.streamingRegistry, streamingRegistryABI, mspWallet);
    logger.info('Ethereum provider, wallet, and contracts initialized');
  } catch (err) {
    logger.warn({ err }, 'Ethereum provider failed to init — running without on-chain calls');
  }
}

// ── Platform NFT ownership check ─────────────────────────────────────────────

async function hasPlatformNft(walletAddress) {
  if (!provider) return false;
  try {
    const contract = new ethers.Contract(ADDRESSES.platformNft, ERC721_ABI, provider);
    const balance  = await contract.balanceOf(walletAddress);
    return balance.gt(0);
  } catch (err) {
    logger.warn({ err }, 'Platform NFT check failed');
    return false;
  }
}

// ── EIP-712 signing ───────────────────────────────────────────────────────────

function derSigToRSV(derHex, digestHex) {
  const buf = Buffer.from(derHex.replace(/^0x/, ''), 'hex');
  if (buf[0] !== 0x30) throw new Error('Unexpected DER prefix');

  let offset = 2;
  if (buf[offset] !== 0x02) throw new Error('DER: missing r marker');
  offset++;
  const rLen = buf[offset++];
  const r    = buf.slice(offset, offset + rLen);
  offset    += rLen;
  if (buf[offset] !== 0x02) throw new Error('DER: missing s marker');
  offset++;
  const sLen = buf[offset++];
  const s    = buf.slice(offset, offset + sLen);

  const r32 = Buffer.alloc(32); r.copy(r32, 32 - r.length);
  const s32 = Buffer.alloc(32); s.copy(s32, 32 - s.length);
  const rHex = '0x' + r32.toString('hex');
  const sHex = '0x' + s32.toString('hex');

  const digest = ethers.utils.arrayify(digestHex);
  for (const v of [27, 28]) {
    try {
      const addr = ethers.utils.recoverAddress(digest, { r: rHex, s: sHex, v });
      if (addr && ethers.utils.isAddress(addr)) {
        return ethers.utils.joinSignature({ r: rHex, s: sHex, v });
      }
    } catch { /* try next v */ }
  }
  return ethers.utils.joinSignature({ r: rHex, s: sHex, v: 27 });
}

async function signEIP712(domain, types, value) {
  const maybeSig = await awsKmsSignEIP712(domain, types, value, mspWallet);
  const digest   = ethers.utils._TypedDataEncoder.hash(domain, types, value);
  return /^0x30/i.test(maybeSig) ? derSigToRSV(maybeSig, digest) : maybeSig;
}

module.exports = {
  ADDRESSES,
  provider,
  mspWallet,
  streamingContract,
  hasPlatformNft,
  signEIP712,
  ethers,
};
