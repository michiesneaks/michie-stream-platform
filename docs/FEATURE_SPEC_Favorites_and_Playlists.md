# MSP Feature Specification — Favorites

**Status:** Pending implementation
**Added:** March 2026
**Affects:** listen.html, profile.html, main.js, server.cjs, user profile schema, AI recommendation system

---

## What It Is

Every user (listener and creator) can mark any song with a "Favorite" action. Favorited tracks populate a private **Favorites list** accessible from the user's profile and the listen page.

---

## Rules

### Privacy
- Favorites lists are **strictly private** — visible only to the owning user.
- Favorites lists **cannot be shared, exported, or made public** in any form.
- No social feature (followers, activity feed, etc.) may surface a user's favorites.

### AI Recommendation Engine
- The Favorites list **is the primary signal** fed to MSP's on-platform AI recommendation engine.
- AI uses Favorites to surface similar content and similar content creators to the user.
- Favorites data is never exposed externally; it is consumed internally by the recommendation service only.

### Royalties — Critical Rule
- **The act of favoriting a track (adding it to the Favorites list) does NOT generate any royalty event** on its own. Simply saving a track to Favorites earns the creator nothing.
- **However, any complete and successful playthrough of content — regardless of where it was initiated from — IS a royalty-eligible stream.** This includes plays started from a Favorites list.
- A full play of a favorited track triggers a normal royalty payout cycle: `StreamingRegistry.logPlay()` is called, the play proof is submitted, and `RoyaltyPayout.executePayoutEther()` runs as normal.
- The **only** thing that does not earn royalties is the act of favoriting itself (the save action). The stream that follows is always fully payable to the Content Creator/Artist.
- Converting Favorites into a Playlist is encouraged for curation and social sharing purposes, but it is NOT a prerequisite for royalty earnings on plays.

**Plain English:** Favorite a song = no royalty. Play that favorited song to completion = royalty paid. Same as any other play from any other source.

### Quick Access
- The Favorites list gives users fast, direct access to loved content without searching, browsing, or scrolling artist pages.
- It should be surfaced prominently on the listen page and profile page (above Playlists in the UI hierarchy).

---

## Implementation Notes (for when coding begins)

### Profile Schema Addition
Add to the user profile document:
```json
{
  "favorites": []
}
```
`favorites` is an array of content CIDs (strings). It is address-scoped and stored server-side (DynamoDB). It is never returned in any public-facing API response.

### Server Routes Required
| Route | Method | Description |
|---|---|---|
| `/api/favorites/:wallet` | GET | Returns the user's favorites list (auth-gated — owner only) |
| `/api/favorites/add` | POST | `{ wallet, cid }` — adds a CID to favorites |
| `/api/favorites/remove` | POST | `{ wallet, cid }` — removes a CID from favorites |
| `/api/favorites/convert-to-playlist` | POST | `{ wallet, name, cids[] }` — creates a new Playlist from selected favorites |

### Frontend (main.js)
- Add a heart/star button (❤️) to every track card rendered by `loadNFTs()` and the library/listen page.
- Button toggles filled/unfilled state based on whether the CID is in the user's favorites.
- On click: call `/api/favorites/add` or `/api/favorites/remove`.
- Favorites list section should render similarly to the Playlists section but with a "Convert to Playlist" action button.
- The "Convert to Playlist" flow should allow the user to select which favorites to include and provide a playlist name — then call `/api/favorites/convert-to-playlist`.

### Capability Gating
- All account types that can stream can Favorite (Tier 1, Tier 2, Tier 3, Creator active, NFT Creator active).
- Non-subscribers cannot Favorite (they cannot stream, so there is nothing to favorite).
- Add `CAN.favorite()` to the capability matrix in main.js:
  ```javascript
  favorite: function () { return CAN.stream(); }
  ```
- Add `data-requires="favorite"` to the favorites UI section in listen.html and profile.html.

### Royalty Handling (server.cjs)
- **All completed plays are royalty eligible regardless of source.** No special `royalty_eligible` flag or play token override is needed based on source.
- The `source` field (`'favorites' | 'playlist' | 'browse' | 'live'`) should still be included in play token requests for **analytics and recommendation purposes only** — not to gate royalty payouts.
- `/api/submit-play-proof` always calls `StreamingRegistry.logPlay()` on a successfully verified play token, whether the play originated from a Favorites list, a Playlist, the browse page, or a live set.
- The only non-royalty-generating action in the Favorites system is the save/favorite action itself (`/api/favorites/add`).

### AI Recommendation Engine (future service)
- When the recommendation service is built, it reads from the user's favorites CIDs.
- It resolves each CID's metadata (genre, BPM, artist, tags) from IPFS/DynamoDB.
- It returns a ranked list of similar CIDs and creator wallet addresses.
- This service should be a separate `/api/recommendations/:wallet` endpoint backed by a lightweight similarity model (cosine similarity on tag/genre vectors is sufficient for MVP).

---

## UI Placement Summary

| Page | Element |
|---|---|
| listen.html | Favorites section below subscription status bar, above Playlists. Heart button on each track card. |
| profile.html | Favorites panel with count, "Convert to Playlist" button, and list of favorited tracks. |
| marketplace.html | Heart button on each NFT card (favorites the underlying content CID). |

---

## What Favorites Are NOT
- Not a playlist (not shareable, not curatable by others — but plays from Favorites DO earn royalties just like any other play source).
- Not a passive endorsement that earns a creator money on its own (the save action itself earns nothing — only the play does).
- Not a bookmark/save-for-later (it is a persistent preference signal used by AI).
- Not a social feature (never visible to other users or creators).
- Not an engagement metric exposed to creators (creators cannot see who favorited their tracks).
