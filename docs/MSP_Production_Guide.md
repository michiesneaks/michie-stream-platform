# MSP Production Readiness Guide
## Removing DEV_MODE Before Going Live

This document covers every change required to take MSP from local development
to a live production deployment. Work through each section in order.

---

## 1. Environment Variables (.env file)

These are the master switches. DEV_MODE is determined entirely by whether
ETH_RPC and MSP_PRIVATE_KEY are present. Set all of these before touching
any code.

```
# Ethereum
ETH_RPC=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
MSP_PRIVATE_KEY=0xYOUR_PLATFORM_WALLET_PRIVATE_KEY

# Smart contract addresses (deployed addresses from your Hardhat/Foundry deploy)
CONTENT_CA_ADDRESS=0x...
STREAMING_REGISTRY_ADDRESS=0x...
ROYALTY_PAYOUT_ADDRESS=0x...
ESCROW_CONTRACT_ADDRESS=0x...
PLATFORM_NFT_ADDRESS=0x...

# IPFS
IPFS_ENDPOINT=http://127.0.0.1:5001   # or your hosted IPFS node URL

# Security
PLAY_TOKEN_SECRET=<long random string — generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_SECRET=<another long random string>

# TLS (if serving HTTPS directly from Node — skip if using nginx/Cloudflare)
TLS_KEY_PATH=/etc/ssl/msp/privkey.pem
TLS_CERT_PATH=/etc/ssl/msp/fullchain.pem

# Optional
PORT=3001
DEV_WALLET=   # leave blank or remove entirely in production
```

Once ETH_RPC and MSP_PRIVATE_KEY are set, DEV_MODE becomes false automatically.
All the guards below activate on their own — but read each section to confirm.

---

## 2. src/middleware/devBypass.js

**Current state (dev):**
```js
const DEV_MODE = !process.env.ETH_RPC || !process.env.MSP_PRIVATE_KEY;

const DEV_WALLET = DEV_MODE
  ? (process.env.DEV_WALLET || '0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399')
  : null;
```

**What changes in production:**
- DEV_MODE becomes false because ETH_RPC and MSP_PRIVATE_KEY are now set.
- DEV_WALLET becomes null automatically.
- No code change needed — just set the env vars.

**Verify:** After starting the server you should NOT see this log line:
```
WARN: Running in DEV MODE — on-chain calls disabled
```

---

## 3. src/services/ipfsService.js

**Current state (commented out for dev):**
```js
// const { create: createIpfs } = require('ipfs-http-client');
// let ipfs = null;
// try {
//   ipfs = createIpfs({ url: process.env.IPFS_ENDPOINT || 'http://127.0.0.1:5001' });
//   logger.info('IPFS client initialized');
// } catch (err) {
//   logger.warn({ err }, 'IPFS client not configured');
// }

let ipfs = null; // Re-enable above block when IPFS_ENDPOINT is configured
```

**Restore to production state:**
```js
const { create: createIpfs } = require('ipfs-http-client');

let ipfs = null;
try {
  ipfs = createIpfs({ url: process.env.IPFS_ENDPOINT || 'http://127.0.0.1:5001' });
  logger.info('IPFS client initialized');
} catch (err) {
  logger.warn({ err }, 'IPFS client not configured');
}
```

Make sure your IPFS node is running and reachable at IPFS_ENDPOINT before
starting the server, or uploads will fail silently.

---

## 4. src/routes/upload.js

**Current state (dev bypass):**
```js
if (DEV_MODE) {
```

**Restore to production state:**
```js
if (DEV_MODE && !ipfsService.ipfs) {
```

This restores the original guard — if somehow DEV_MODE is true but an IPFS
client was still created, it will use IPFS. In normal production this branch
never runs because DEV_MODE is false and the code goes straight to
handleProdUpload().

---

## 5. src/routes/playTokens.js

**Current state (dev bypass):**
```js
const PLAY_TOKEN_SECRET = process.env.PLAY_TOKEN_SECRET || 'dev-play-secret';
```

**What changes in production:**
No code change needed. Set PLAY_TOKEN_SECRET in your .env to a long random
string. The fallback 'dev-play-secret' will never be used because the env
var is now present.

**Why this matters:** In dev, anyone who knows 'dev-play-secret' could forge
play tokens. In production, only the server knows the real secret.

---

## 6. src/services/ethService.js

**Current state:**
```js
if (!DEV_MODE) {
  try {
    provider   = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC);
    mspWallet  = new ethers.Wallet(process.env.MSP_PRIVATE_KEY, provider);
    streamingContract = new ethers.Contract(...);
    logger.info('Ethereum provider, wallet, and contracts initialized');
  } catch (err) {
    logger.warn({ err }, 'Ethereum provider failed to init — running without on-chain calls');
  }
}
```

**What changes in production:**
No code change needed. When DEV_MODE is false (because ETH_RPC and
MSP_PRIVATE_KEY are set), this block runs automatically and initializes
the real provider, wallet, and streaming contract.

**Verify:** You should see this log line on startup:
```
INFO: Ethereum provider, wallet, and contracts initialized
```

---

## 7. src/services/module_aws_shim.js

**Current state (dev fallback):**
```js
let awsKmsSignEIP712;
try {
  ({ awsKmsSignEIP712 } = require('../../module_aws'));
} catch {
  awsKmsSignEIP712 = async (domain, types, value, wallet) => {
    if (wallet && wallet._signTypedData) {
      return wallet._signTypedData(domain, types, value);
    }
    return '0x';
  };
}
```

**What changes in production:**
If you are using AWS KMS for signing (recommended for production key
management), ensure module_aws.js is present and your AWS credentials are
configured. The try/catch will then load the real KMS signer.

If you are NOT using AWS KMS and instead signing directly with the wallet
private key, the fallback using wallet._signTypedData is actually correct
for production too — no change needed in that case.

---

## 8. Frontend — devBypass console injection

During development, the wallet was injected via the browser console:
```js
window.walletAddress = '0xde1f33ce3e81bc54ebd0f4bc3ce0a2f64d7ef399';
window.ethersSigner = { ... };
document.dispatchEvent(new CustomEvent('walletConnected', { ... }));
```

**In production:** Users connect real wallets via MetaMask/Coinbase/Phantom
through the wallet modal. This console injection is never needed and should
never be done on a production system. No code change — just stop doing it.

---

## 9. Smart contract addresses

Currently all contract addresses fall back to the zero address:
```js
contentCA: process.env.CONTENT_CA_ADDRESS || '0x0000000000000000000000000000000000000000',
```

**Before going live:**
1. Deploy your Solidity contracts (ContentCA.sol, StreamingRegistry.sol,
   RoyaltyPayout.sol, Escrow.sol, MusicNFT.sol) to mainnet or your chosen L2.
2. Add the deployed addresses to your .env file.
3. The zero address fallbacks will never be used once the env vars are set.

---

## 10. Redis

Redis is already optional — the server starts without it and analytics
degrade gracefully. For production you should run a persistent Redis instance.

```
REDIS_URL=redis://your-redis-host:6379
```

If Redis is not available, the analytics heartbeat endpoint returns 503
(by design via the requireRedis middleware) and play tokens still work
normally — you just lose telemetry data.

---

## 11. Pre-launch checklist

Go through this list in order on your production server:

```
[ ] ETH_RPC set and pointing to mainnet/L2 node
[ ] MSP_PRIVATE_KEY set — platform wallet funded with enough gas
[ ] All five contract addresses set in .env
[ ] IPFS_ENDPOINT set and IPFS node is running
[ ] ipfsService.js uncommented (Step 3 above)
[ ] upload.js guard restored (Step 4 above)
[ ] PLAY_TOKEN_SECRET set to a long random string
[ ] JWT_SECRET set to a long random string
[ ] Redis running and REDIS_URL set
[ ] TLS configured (cert + key paths, or put nginx/Cloudflare in front)
[ ] DEV_WALLET removed from .env entirely
[ ] Server started — confirm NO "DEV MODE" warning in logs
[ ] Server started — confirm "Ethereum provider...initialized" in logs
[ ] Server started — confirm "IPFS client initialized" in logs
[ ] Test upload of a real file end to end
[ ] Test wallet connect via MetaMask on a real browser
[ ] Test play token request and proof submission
[ ] Test subscription flow
```

---

## 12. What you do NOT need to change

These files work correctly in both dev and production with no modifications:

- src/server.cjs — route mounting is environment-agnostic
- src/routes/catalog.js — no dev bypasses
- src/routes/playlists.js — no dev bypasses
- src/routes/favorites.js — no dev bypasses
- src/routes/royalties.js — no dev bypasses
- src/routes/analytics.js — no dev bypasses
- src/services/playlistService.js — no dev bypasses
- src/services/catalogService.js — no dev bypasses
- All frontend JS files — wallet connection handles both dev and prod
- styles.css — no environment dependency
- All HTML pages — no environment dependency
