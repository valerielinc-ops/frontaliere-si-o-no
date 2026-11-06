# Header Bidding (Prebid.js)

Client-side header bidding layered on the **explicit GAM/GPT slots** only
(`GptAdSlot`: article rails + PoC). It runs a Prebid auction before
`googletag.display()` and passes the winning `hb_*` targeting to GPT, so SSP
demand competes with AdSense dynamic-allocation inside the same GAM auction.

> **AdSense Auto Ads are NOT header-bid.** Auto Ads (anchor/in-page/vignette,
> ~95% of revenue) are placed by AdSense itself, not as GPT slots, so Prebid
> cannot touch them. Header bidding is purely additive on the explicit slots.

## Status: built, default-OFF (inert)

The integration is merged but does **nothing** until all three of the following
exist. Until then `requestHeaderBids()` is a no-op and GPT serves AdSense-only,
exactly as before.

| Gate | Where | Default |
|------|-------|---------|
| `PREBID_ENABLED` master flag | `services/headerBidding.ts` | `false` |
| `VITE_PREBID_CONFIG` env (bidder IDs) | build env | unset → empty |
| `/assets/prebid.js` self-hosted bundle | `public/assets/` | absent |
| `KILL_HEADER_BIDDING` Remote Config | Firebase RC | `'false'` (runtime off-switch) |

## Go-live checklist

1. **Sign up SSPs** and obtain per-ad-unit placement IDs. Recommended for
   CH/IT/EU traffic at current volume: Criteo, Sovrn, Media.net, Yieldlab
   (DACH), Equativ/Smart (FR). Amazon APS via the Prebid adapter once approved.
2. **Build a custom Prebid bundle** at <https://docs.prebid.org/download.html>
   selecting the chosen bidder adapters **plus** `consentManagementTcf` (EU/CH
   GDPR — reads the TCF string from the existing Funding Choices CMP) and
   `gptPreAuction`. Drop the output at `public/assets/prebid.js`. Do **not** use
   the generic CDN bundle — it lacks our adapters and bloats the critical path.
3. **Create the GAM line items.** Header bidding only monetizes if GAM has the
   price-bucket line items + universal creative keyed on `hb_pb` / `hb_adid` /
   `hb_size` targeting. Use Prebid's GAM setup tooling
   (<https://docs.prebid.org/adops/before-you-start.html>). Without these, bids
   can never win the GAM auction. **This is the step that actually turns on
   revenue — code alone does nothing.**
4. **Set `VITE_PREBID_CONFIG`** (build secret) to the JSON map of ad unit path →
   bids, e.g.:
   ```json
   {
     "/23355151813/article-rail-left":  [{"bidder":"criteo","params":{"networkId":12345}}, {"bidder":"sovrn","params":{"tagid":"998877"}}],
     "/23355151813/article-rail-right": [{"bidder":"criteo","params":{"networkId":12345}}, {"bidder":"sovrn","params":{"tagid":"998877"}}],
     "/23355151813/gpt-poc-articoli":   [{"bidder":"medianet","params":{"cid":"8CU...","crid":"45678"}}]
   }
   ```
5. **Flip `PREBID_ENABLED = true`** and deploy.
6. **Monitor** RPM/viewability/`hb_*` line-item fill in GAM, and CWV (INP/CLS/LCP
   via CF Web Analytics) — the auction adds JS + latency. Roll back instantly via
   `KILL_HEADER_BIDDING = 'true'` in Remote Config (no deploy) if CWV regresses
   or revenue drops.

## CWV / safety notes

- Per-slot lazy load (IntersectionObserver, inherited from `GptAdSlot`), hard
  1000 ms auction timeout + 500 ms wall-clock guard → display is never blocked.
- Bot- and production-host-gated (shared with AdSense/GPT loaders).
- All failure paths fail-soft: a broken auction silently falls back to plain
  GPT display.
