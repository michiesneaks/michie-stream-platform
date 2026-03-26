'use strict';

/**
 * Normalizes all wallet address fields to lowercase on every request.
 * Ensures MetaMask/Coinbase checksummed addresses always match stored profiles.
 */
function walletNormalizer(req, res, next) {
  if (req.body) {
    const fields = ['wallet', 'listener', 'from_wallet', 'to_wallet'];
    for (const field of fields) {
      if (req.body[field]) req.body[field] = req.body[field].toLowerCase();
    }
  }
  if (req.params && req.params.wallet) {
    req.params.wallet = req.params.wallet.toLowerCase();
  }
  next();
}

module.exports = walletNormalizer;
