# MSP Dev Testing Guide
**Wallet:** `0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399`

---

## Why things aren't working

There are two separate bypass systems — server-side and client-side — and both need to be satisfied before anything works end-to-end.

| Layer | What it checks | Your bypass |
|---|---|---|
| **`server.cjs`** | `getCapabilityLevel(profile)` before every gated route | `isDevWallet()` — already in the updated file |
| **`main.js`** | `CAN.hostConcert()`, `CAN.upload()`, etc. — checked *before* any API call | Needs `_access.level` to be `creator_active` OR a console override |
| **`profiles.json`** | Profile must exist for most routes even with the server bypass | Must be created via `/api/create-profile` |

The most likely reason nothing works: **your wallet has no entry in `profiles.json`**. `fetchOrCreateProfile` in `main.js` hits `/api/profile/:wallet`, gets a 404, then prompts you for a display name — but that prompt may be blocked by your browser, or the profile was created as `listener` not `creator`, so `CAN.hostConcert()` still returns false.

---

## Step 0 — Prerequisites

Make sure these are true before anything else.

```
server.cjs   →  the updated version (with DEV_WALLET + isDevWallet)
profiles.json → exists at project root (empty {} is fine, server creates it)
Node + npm   → installed
Redis        → running OR just skip (server continues without it)
IPFS         → running OR skip (upload will fail gracefully, other routes unaffected)
```

Start the server (no .env needed for dev):

```bash
node src/server.cjs
# or
npm start
```

You should see these lines in the log — if you see the throw from the old file instead, you're running the wrong version:

```
MSP server starting
ETH_RPC or MSP_PRIVATE_KEY not set — running in DEV MODE (on-chain calls disabled)
DEV_WALLET active — all permission checks bypassed for this address
HTTP server on http://localhost:3001
```

---

## Step 1 — Create the profile (run once)

This is the step that's almost certainly missing. Run this in your terminal:

```bash
curl -s -X POST http://localhost:3001/api/create-profile \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "name": "MSP Dev",
    "account_type": "creator"
  }' | jq .
```

**Expected response:**
```json
{
  "user_id": "...",
  "name": "MSP Dev",
  "wallet_address": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
  "account_type": "creator",
  "royalty_fee_rate": 0.05,
  ...
}
```

If you get `409 Profile already exists` — good, skip to Step 2. If you get any other error, check the server log.

---

## Step 2 — Subscribe the wallet to a creator plan (run once)

The server's `isDevWallet()` bypass means the server won't care about this for most routes, but `main.js` checks `CAN.hostConcert()` client-side **before** hitting the server. `CAN.hostConcert()` reads `_access.level`, which comes from `/api/access/:wallet`. That endpoint reads `getCapabilityLevel(profile)`, which requires an active subscription to return `creator_active`.

```bash
curl -s -X POST http://localhost:3001/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "plan": "creator_monthly"
  }' | jq .
```

**Expected response:**
```json
{
  "success": true,
  "plan": "creator_monthly",
  "tier": null,
  "expiry": 1748...,
  "price_usd": 29.99,
  "price_eth": "0.01199600"
}
```

Verify the level is now correct:

```bash
curl -s http://localhost:3001/api/access/0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399 | jq .
```

**Expected:**
```json
{
  "level": "creator_active",
  "active": true,
  "account_type": "creator",
  ...
}
```

If you see `"level": "none"` — the subscription didn't save. Check `profiles.json` and rerun Step 1 first.

---

## Step 3 — Clear stale browser cache (do this once)

`main.js` caches your profile and access level in localStorage under `msp_profile_0x...`. If you did Steps 1–2 after the browser already loaded the page, the old `level: 'none'` is cached and `CAN.*` will still fail.

Open DevTools → Console, paste this, then hard-refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`):

```javascript
// Clear all MSP keys from localStorage
Object.keys(localStorage)
  .filter(k => k.startsWith('msp_') || k === 'profile')
  .forEach(k => localStorage.removeItem(k));
console.log('MSP localStorage cleared');
```

---

## Step 4 — Inject the wallet in the browser

`main.js` won't auto-connect your wallet — it waits for the real MetaMask `walletConnected` event from `wallets.js`. For dev testing, you can inject the state manually via the console after the page loads.

Open DevTools → Console on any MSP page, paste:

```javascript
// Inject dev wallet — run once per page load after DOMContentLoaded
window.walletAddress = '0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399';
window.ethersSigner  = null;   // tips/on-chain will fail gracefully
window.ethersProvider = null;

// Fire the walletConnected event — this triggers main.js to load profile + access
document.dispatchEvent(new CustomEvent('walletConnected', {
  detail: { address: window.walletAddress }
}));
```

After a moment you should see the wallet address displayed in the navbar (`0xDe1f…f399`) and the UI gates should unlock (Upload, Live Studio, DJ Set become visible).

**Confirm it worked:**
```javascript
// Should show { level: 'creator_active', active: true, ... }
console.log(window._access);

// Or force-read the access state:
fetch('/api/access/' + window.walletAddress)
  .then(r => r.json())
  .then(console.log);
```

---

## Testing each feature

### Access check

```bash
curl -s http://localhost:3001/api/access/0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399 | jq .
```

✅ `level: "creator_active"`, `active: true`

---

### Profile fetch

```bash
curl -s http://localhost:3001/api/profile/0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399 | jq .
```

✅ Returns full profile with `account_type: "creator"`

---

### Live Studio (`live_studio.html`)

This file has its own standalone `DEV_MODE = true` bypass in the broadcaster IIFE that sets `window.walletAddress` directly and calls `hideGate()` — you don't need the wallet inject for this page. The orange hazard banner at the bottom confirms the bypass is active.

1. Open `live_studio.html` in the browser
2. Confirm the orange dev banner appears at the bottom
3. Confirm the studio body is visible (not the lock gate)
4. Click **📷 Camera**, allow camera access → preview appears
5. Fill in Stream Title and Artist Name
6. Click **● Go Live**

The Go Live button will call `/api/start-live-encode` with your dev wallet. The server's `isDevWallet()` check lets it through.

**Expected server log:**
```
DEV_WALLET bypass — skipping creator access check for live encode
Live encode started { productionID: "MSP_Dev_...", inputSource: "rtmp://..." }
```

**Expected UI response:** Status changes to `● LIVE`, HLS URL appears above the preview.

---

### Live Encode via API directly

```bash
curl -s -X POST http://localhost:3001/api/start-live-encode \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "eventTitle": "Test Stream",
    "artistName": "MSP Dev"
  }' | jq .
```

✅ Returns `{ success: true, productionID: "...", hlsUrl: "/live/.../master.m3u8" }`

---

### creators.html — Upload form

1. Open `creators.html`
2. Run the wallet inject from Step 4 in the console
3. Hard-refresh, run inject again if gates don't appear
4. The **Upload & Mint** button and **DJ Set** and **Live Concert** sections should be visible

The upload itself requires IPFS to be running. To test the form validation without IPFS:

```bash
# Will fail at IPFS step but confirms access guard passes
curl -s -X POST http://localhost:3001/api/upload \
  -F "wallet=0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399" \
  -F "userId=test-user" \
  -F "contentType=music" \
  -F "songTitle=Test Track" \
  -F "artistName=MSP Dev" \
  -F "tags=electronic,ambient,test" \
  -F "audio-file=@/path/to/your.mp3" \
  -F "cover-image=@/path/to/cover.jpg"
```

✅ Without IPFS: `503 IPFS not configured` — this means the access guard passed.
✅ With IPFS running: returns full metadata CID and HLS URL.

---

### DJ Set

```bash
curl -s -X POST http://localhost:3001/api/start-dj-set \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "set_name": "Friday Night Test Mix",
    "tips_enabled": true,
    "dj_percent": 70
  }' | jq .
```

✅ Returns `{ success: true, set_id: "...", tips_enabled: true }`

End the set:

```bash
curl -s -X POST http://localhost:3001/api/end-dj-set \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "set_id": "<set_id from above>"
  }' | jq .
```

---

### Play token

```bash
curl -s -X POST http://localhost:3001/api/request-play-token \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmTestCid123",
    "listener": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "live": false
  }' | jq .
```

✅ Returns `{ playToken: "eyJ..." }` — the `isDevWallet()` bypass skips the subscription check.

---

### Favorites

```bash
# Add a favorite
curl -s -X POST http://localhost:3001/api/favorites/add \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "cid": "QmTestTrackCid"
  }' | jq .

# Read favorites
curl -s http://localhost:3001/api/favorites/0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399 | jq .

# Remove a favorite
curl -s -X POST http://localhost:3001/api/favorites/remove \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "cid": "QmTestTrackCid"
  }' | jq .
```

✅ No subscription gate on add — any registered wallet can favorite.

---

### Create a playlist

```bash
curl -s -X POST http://localhost:3001/api/create-playlist \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "name": "Test Playlist",
    "cids": ["QmCid1", "QmCid2", "QmCid3"]
  }' | jq .
```

✅ Returns `{ success: true, playlist: { id: "...", name: "Test Playlist", ... } }`

---

### Royalty splits

```bash
curl -s -X POST http://localhost:3001/api/set-royalty-splits \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "cid": "QmTestTrackCid",
    "splits": {
      "artist": 85,
      "nft_holders": 5,
      "activity_pool": 10,
      "passive": []
    }
  }' | jq .
```

✅ Returns `{ success: true, splits: { ... } }`

---

### Tips

```bash
curl -s -X POST http://localhost:3001/api/tip \
  -H "Content-Type: application/json" \
  -d '{
    "from_wallet": "0xDe1f33Ce3E81bc54ebD0F4BC3Ce0a2F64d7Ef399",
    "to_wallet": "0xSomeArtistWallet",
    "tip_type": "artist",
    "amount_eth": "0.01"
  }' | jq .
```

✅ Returns distribution breakdown. Note: the actual ETH transfer requires `ethersSigner` (real wallet) — the server call only records the tip.

---

### Fees reference

```bash
curl -s http://localhost:3001/api/fees | jq .
```

---

### NFTs

```bash
curl -s http://localhost:3001/api/nfts | jq .
```

Returns `[]` until you've uploaded tracks and registered an NFT contract via `/api/update-profile`.

---

## Common errors and fixes

| Error | Cause | Fix |
|---|---|---|
| `404 Profile not found` | Wallet not in `profiles.json` | Run Step 1 |
| `CAN.hostConcert()` alert in browser | `_access.level` is not `creator_active` | Run Step 2, then Step 3 (clear cache) |
| Studio gate still showing | DEV_MODE not `true` in `live_studio.html` | Check the two lines at top of broadcaster IIFE |
| `level: "none"` from `/api/access` | Subscription missing or expired | Run Step 2 again |
| `409 Profile already exists` on create | Already created — safe to ignore | Skip to Step 2 |
| `503 IPFS not configured` on upload | IPFS node not running | Start IPFS or test other routes; upload is the only IPFS-dependent route |
| `Replay detected` on play proof | Redis replay key hit | Wait 24h or flush Redis: `redis-cli FLUSHDB` |
| `ETH_RPC or MSP_PRIVATE_KEY missing` crash | Running old `server.cjs` | Replace with updated file |
| Orange banner not showing | `live_studio.html` has `DEV_MODE = false` | Set both `DEV_MODE = true` and `DEV_WALLET` back |
| `walletConnected` event fires but gates stay locked | Stale localStorage cache | Run Step 3 (clear cache), hard-refresh |

---

## Turning DEV mode off (before production)

**`server.cjs`** — provide both env vars in `.env`:
```
ETH_RPC=https://mainnet.infura.io/v3/<KEY>
MSP_PRIVATE_KEY=0x<your_deployer_key>
```
`DEV_MODE` becomes `false` → `DEV_WALLET` becomes `null` → `isDevWallet()` always returns `false` → all bypasses off.

**`live_studio.html`** — two lines at the top of the broadcaster IIFE:
```javascript
var DEV_MODE   = false;   // ← flip
var DEV_WALLET = null;    // ← clear
```
