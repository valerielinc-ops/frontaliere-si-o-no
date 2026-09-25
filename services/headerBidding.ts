/**
 * headerBidding — Prebid.js wrapper for the explicit GAM/GPT slots.
 *
 * Runs a client-side header-bidding auction BEFORE GptAdSlot calls
 * `gt.display()`, then hands the winning bid's targeting (hb_pb / hb_adid /
 * hb_size) to GPT via `pbjs.setTargetingForGPTAsync`. SSP demand thus competes
 * with AdSense dynamic-allocation inside the same GAM auction. AdSense Auto Ads
 * are untouched — header bidding only augments the explicit pubads slots that
 * GptAdSlot already serves (article rails, PoC).
 *
 * SAFETY (default-inert, fail-soft):
 *  - `PREBID_ENABLED` master flag (default `false`): the whole stack does
 *    nothing until a self-hosted `/assets/prebid.js` bundle, SSP placement IDs
 *    (`VITE_PREBID_CONFIG`) and the GAM `hb_*` line items all exist. Flip to
 *    `true` only at go-live. See docs/HEADER-BIDDING.md.
 *  - Per-slot Remote Config kill-switch (`KILL_HEADER_BIDDING`) wired by the
 *    caller via useKillSwitches — turns the auction off within ~1 min, no deploy.
 *  - `requestHeaderBids()` ALWAYS resolves (no config / load error / bot /
 *    timeout) and never rejects: a broken auction must never block GPT display
 *    or stop an ad from serving. A hard wall-clock guard resolves even if
 *    prebid.js never loads or `bidsBackHandler` never fires.
 *  - Bot- and production-host-gated like the AdSense / GPT loaders, so bot
 *    traffic never inflates bid requests.
 */

import type { GptSize } from '@/components/shared/GptAdSlot';
import { isLikelyBot } from '@/services/adAnalytics';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { bidsForAdUnit, hasConfiguredBidders } from '@/services/prebidConfig';
import { isAdsConsentGranted } from '@/services/adsConsent';

/**
 * Master flag for the entire header-bidding stack. Flip to `true` ONLY once the
 * `/assets/prebid.js` bundle, `VITE_PREBID_CONFIG` and the GAM `hb_*` line items
 * are all live (docs/HEADER-BIDDING.md). `false` = no auction; GPT serves
 * AdSense-only exactly as before this module landed.
 */
export const PREBID_ENABLED = false;

// Self-hosted custom Prebid build (display adapters: criteo, sovrn, medianet,
// yieldlab, smartadserver + consentManagementTcf for EU/CH GDPR + gptPreAuction).
// Built from prebid.org/download and dropped in /public/assets — never the
// generic CDN bundle (it lacks our adapters and bloats the critical path).
const PREBID_SCRIPT_SRC = '/assets/prebid.js';
const DEFAULT_TIMEOUT_MS = 1000;
// TCF consent wait MUST fit inside the requestBids auction window: Prebid core
// delays the auction internally until either the CMP responds or this timeout
// elapses. It previously stood at 3000ms — well past the runAuction wall-clock
// guard (`timeoutMs + 500` = 1500ms, see below) — so on EU/CH traffic with a
// slow `__tcfapi`, the guard could call gt.display() before the auction (gated
// on consent) ever got to run requestBids, i.e. zero header-bid demand for the
// primary audience. Tied to DEFAULT_TIMEOUT_MS (never greater) so the guard's
// 1500ms wall-clock ceiling for CH/EU users never regresses. See issue #2860.
const CONSENT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

interface PbjsSlotDef {
  /** GPT div element id — Prebid matches the auction back to this GPT slot. */
  code: string;
  /** GAM ad unit path, keys the configured bids in prebidConfig. */
  adUnitPath: string;
  /** Requested sizes (mirrors the GPT slot); 'fluid' is dropped for the banner auction. */
  sizes: readonly GptSize[];
}

let scriptRequested = false;
let scriptFailed = false;
let configured = false;

// Auctions currently parked waiting on either `bidsBackHandler` or the
// wall-clock guard. If `/assets/prebid.js` 404s (or errors for any other
// reason) the bundle never evaluates, so `pbjs.que` never drains — without
// this, every parked auction would sit unresolved until its own wall-clock
// guard eventually fired. `handleScriptLoadError` resolves all of them the
// moment the browser reports the load failure, instead of waiting it out.
interface PendingAuction {
  done: () => void;
  guard: number;
}
const pendingAuctions = new Set<PendingAuction>();

// Ad-unit codes (== the GPT div id, see PbjsSlotDef.code) that have already
// run at least one auction. `useBidCache: true` (configurePrebid below) plus
// Prebid's own adUnits/bidsReceived registries are keyed by this code and
// persist for the life of the page — they are NOT scoped to a route. This app
// is a hand-rolled-router SPA (services/router.ts) with no full page reload
// between routes, so if a GPT slot's div id (and therefore its Prebid ad-unit
// code) were ever reused for a *different* adUnitPath/creative after an SPA
// navigation, a stale cached bid (hb_adid / hb_size) from the previous route's
// auction could be replayed onto the new route's differently-sized/targeted
// slot. `runAuction` purges any prior ad-unit definition for a reused code
// before re-adding it (belt-and-braces even though today's callers mint a
// fresh, monotonically-increasing div id per component mount — see
// GptAdSlot's `slotSeq` — so no code is currently reused within one SPA
// session); `invalidateHeaderBiddingOnNavigation` (wired into the same
// pushState/popstate/hashchange navigation hook hooks/useUIState.ts already
// uses for pageview tracking) additionally purges every known code on each
// route change, so no stale registration can ever outlive the route it was
// requested for. See issue #2860 item 3.
const knownAdUnitCodes = new Set<string>();

function pbjs(): Record<string, unknown> & { que: Array<() => void> } {
  const w = window as unknown as { pbjs?: Record<string, unknown> & { que?: Array<() => void> } };
  const p = (w.pbjs = w.pbjs || {});
  p.que = p.que || [];
  return p as Record<string, unknown> & { que: Array<() => void> };
}

/**
 * Fires on the `<script>` tag's `error` event (404, network failure, blocked
 * request, etc.). The Prebid bundle never evaluated, so `pbjs.que` will never
 * be drained by it — give up immediately for every in-flight and future
 * auction rather than relying solely on the wall-clock guard.
 */
function handleScriptLoadError(): void {
  scriptFailed = true;
  for (const auction of pendingAuctions) {
    window.clearTimeout(auction.guard);
    auction.done();
  }
  pendingAuctions.clear();
}

function ensurePrebidScript(): void {
  // ── ADVERTISING CONSENT GATE (#5842) ────────────────────────────────
  // Prebid is an advertising script: it broadcasts bid requests to third-party
  // bidders and forwards the TCF consent string to them. Today it is reachable
  // only from inside a `googletag.cmd` callback, which cannot drain while
  // gpt.js is blocked — so it is *transitively* gated already. That is exactly
  // the kind of guarantee this workspace has been burned by: a contract with no
  // import form, holding only as long as an unrelated call site keeps its
  // shape. Gated explicitly, before the sticky `scriptRequested` latch.
  if (!isAdsConsentGranted()) return;
  if (scriptRequested || typeof document === 'undefined') return;
  scriptRequested = true;
  pbjs(); // ensure window.pbjs.que exists before the bundle evaluates
  if (document.querySelector(`script[src="${PREBID_SCRIPT_SRC}"]`)) return;
  const s = document.createElement('script');
  s.src = PREBID_SCRIPT_SRC;
  s.async = true;
  s.onerror = handleScriptLoadError;
  document.head.appendChild(s);
}

function configurePrebid(): void {
  if (configured) return;
  configured = true;
  const p = pbjs();
  p.que.push(() => {
    try {
      (p as unknown as { setConfig: (c: unknown) => void }).setConfig({
        priceGranularity: 'dense',
        bidderTimeout: DEFAULT_TIMEOUT_MS,
        useBidCache: true,
        // EU/CH traffic: pass the IAB TCF v2 consent string to bidders. Funding
        // Choices (Google's CMP, already loaded) provides it; Prebid reads it
        // from the standard __tcfapi CMP interface.
        consentManagement: {
          // <= CONSENT_TIMEOUT_MS keeps the consent wait inside the runAuction
          // wall-clock guard (timeoutMs + 500) — see CONSENT_TIMEOUT_MS above.
          gdpr: { cmpApi: 'iab', timeout: CONSENT_TIMEOUT_MS, defaultGdprScope: true },
        },
        // Forward the GAM slot name to bidders for reporting / targeting.
        gptPreAuction: { enabled: true },
      });
    } catch {
      /* fail-soft */
    }
  });
}

/** Whether a header-bidding auction should run for this ad unit right now. */
export function prebidActiveFor(adUnitPath: string): boolean {
  return (
    PREBID_ENABLED &&
    typeof window !== 'undefined' &&
    hasConfiguredBidders() &&
    bidsForAdUnit(adUnitPath).length > 0 &&
    isAdSenseProductionHost(window.location.hostname) &&
    !isLikelyBot()
  );
}

/**
 * Run a header-bidding auction for a single GPT slot and apply the winning
 * targeting to it. ALWAYS resolves (fail-soft); never rejects; never blocks GPT
 * display longer than ~`timeoutMs`. Caller must call `gt.display()` only after
 * the returned promise settles.
 */
export function requestHeaderBids(slot: PbjsSlotDef, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (!prebidActiveFor(slot.adUnitPath)) return Promise.resolve();
  ensurePrebidScript();
  configurePrebid();

  const bids = bidsForAdUnit(slot.adUnitPath).map((b) => ({ ...b }));
  const sizes = slot.sizes.filter((s): s is [number, number] => Array.isArray(s));
  if (!bids.length || !sizes.length) return Promise.resolve();

  return runAuction(slot, timeoutMs, bids, sizes);
}

/**
 * Core auction plumbing, split out from `requestHeaderBids` so the
 * script-load-error guard can be exercised directly in tests without
 * flipping the (intentionally hardcoded) `PREBID_ENABLED` master flag.
 */
function runAuction(
  slot: PbjsSlotDef,
  timeoutMs: number,
  bids: ReturnType<typeof bidsForAdUnit>,
  sizes: [number, number][],
): Promise<void> {
  // The script tag already failed to load in a previous call (e.g. a prior
  // slot on the same page already observed the 404) — don't bother queueing
  // another callback that will never run; give up right away.
  if (scriptFailed) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const auction: PendingAuction = {
      done: () => {
        if (settled) return;
        settled = true;
        pendingAuctions.delete(auction);
        resolve();
      },
      // Hard wall-clock guard: if prebid.js never loads or bidsBackHandler
      // never fires, resolve anyway so GPT still serves. A touch above the
      // auction timeout so a normal auction always wins the race.
      // `handleScriptLoadError` (wired to the script tag's `error` event)
      // resolves `done` immediately on a load failure, well before this
      // backstop would otherwise elapse.
      guard: window.setTimeout(() => auction.done(), timeoutMs + 500),
    };
    pendingAuctions.add(auction);
    const done = auction.done;
    const guard = auction.guard;

    pbjs().que.push(() => {
      try {
        const p = pbjs() as unknown as {
          addAdUnits: (u: unknown) => void;
          removeAdUnit: (code: string) => void;
          requestBids: (o: unknown) => void;
          setTargetingForGPTAsync: (codes: string[]) => void;
        };
        // Purge any previous ad-unit definition (and its cached bids) for this
        // code before re-adding it. A fresh code (the common case — see
        // knownAdUnitCodes docstring) makes this a no-op; it only matters if a
        // code is ever reused, in which case it stops a stale bid from a prior
        // adUnitPath/creative leaking into this auction via useBidCache.
        if (knownAdUnitCodes.has(slot.code)) {
          try {
            p.removeAdUnit(slot.code);
          } catch {
            /* fail-soft */
          }
        }
        knownAdUnitCodes.add(slot.code);
        p.addAdUnits([{ code: slot.code, mediaTypes: { banner: { sizes } }, bids }]);
        p.requestBids({
          timeout: timeoutMs,
          adUnitCodes: [slot.code],
          bidsBackHandler: () => {
            try {
              p.setTargetingForGPTAsync([slot.code]);
            } catch {
              /* fail-soft */
            } finally {
              window.clearTimeout(guard);
              done();
            }
          },
        });
      } catch {
        window.clearTimeout(guard);
        done();
      }
    });
  });
}

/**
 * Call on every SPA route change (no full page reload happens between routes
 * — services/router.ts) to purge every ad-unit code any slot has ever run an
 * auction for. Defense-in-depth alongside the reuse-guard in `runAuction`:
 * even if a future caller ends up reusing a GPT div id / Prebid code across a
 * navigation, this guarantees no stale bid/adUnit definition from the
 * previous route survives into the new one. Fail-soft and a no-op when no
 * auction has ever run (nothing in `knownAdUnitCodes`) or the header-bidding
 * script never loaded. Wired into the same pushState/popstate/hashchange
 * navigation hook hooks/useUIState.ts already uses for pageview tracking.
 * See issue #2860 item 3.
 */
export function invalidateHeaderBiddingOnNavigation(): void {
  if (knownAdUnitCodes.size === 0 || scriptFailed || typeof window === 'undefined') return;
  const codes = Array.from(knownAdUnitCodes);
  knownAdUnitCodes.clear();
  pbjs().que.push(() => {
    try {
      const p = pbjs() as unknown as { removeAdUnit: (code: string) => void };
      for (const code of codes) {
        try {
          p.removeAdUnit(code);
        } catch {
          /* fail-soft */
        }
      }
    } catch {
      /* fail-soft */
    }
  });
}

/**
 * Exposed only for tests. `PREBID_ENABLED` is hardcoded `false` until
 * go-live (see module docstring) so the normal `requestHeaderBids` gate
 * can't be exercised in unit tests — these internals let tests drive the
 * script-load / script-load-error plumbing directly.
 */
export const __testing = {
  ensurePrebidScript,
  configurePrebid,
  runAuction,
  isScriptFailed: (): boolean => scriptFailed,
  knownAdUnitCodeCount: (): number => knownAdUnitCodes.size,
  CONSENT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  resetForTests(): void {
    scriptRequested = false;
    scriptFailed = false;
    configured = false;
    pendingAuctions.clear();
    knownAdUnitCodes.clear();
    if (typeof document !== 'undefined') {
      document.querySelectorAll(`script[src="${PREBID_SCRIPT_SRC}"]`).forEach((el) => el.remove());
    }
  },
};
