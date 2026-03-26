'use strict';

const logger = require('../config/logger');

// DEV_MODE is true when ETH_RPC or MSP_PRIVATE_KEY are absent.
// Set both in .env to disable DEV_MODE before production.
const DEV_MODE = !process.env.ETH_RPC || !process.env.MSP_PRIVATE_KEY;

// DEV_WALLET bypasses all profile and subscription checks for that address.
// REMOVE BEFORE PRODUCTION — provide ETH_RPC + MSP_PRIVATE_KEY in .env instead.
const DEV_WALLET = DEV_MODE
  ? (process.env.DEV_WALLET || '0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399')
  : null;

if (DEV_MODE) {
  logger.warn('Running in DEV MODE — on-chain calls disabled');
  if (DEV_WALLET) logger.warn({ DEV_WALLET }, 'DEV_WALLET active — permission checks bypassed for this address');
}

/**
 * Returns true if the given wallet is the DEV_WALLET and DEV_MODE is active.
 * Call at the top of any route that needs an access guard to short-circuit it.
 */
function isDevWallet(wallet) {
  return !!(DEV_WALLET && wallet && wallet.toLowerCase() === DEV_WALLET.toLowerCase());
}

module.exports = { DEV_MODE, DEV_WALLET, isDevWallet };
