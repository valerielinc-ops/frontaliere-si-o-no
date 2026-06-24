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

interface PbjsSlotDef {
  /** GPT div element id — Prebid matches the auction back to this GPT slot. */
  code: string;
  /** GAM ad unit path, keys the configured bids in prebidConfig. */
  adUnitPath: string;
  /** Requested sizes (mirrors the GPT slot); 'fluid' is dropped for the banner auction. */
  sizes: readonly GptSize[];
}

let scriptRequested = false;
let configured = false;

function pbjs(): Record<string, unknown> & { que: Array<() => void> } {
  const w = window as unknown as { pbjs?: Record<string, unknown> & { que?: Array<() => void> } };
  const p = (w.pbjs = w.pbjs || {});
  p.que = p.que || [];
  return p as Record<string, unknown> & { que: Array<() => void> };
}

function ensurePrebidScript(): void {
  if (scriptRequested || typeof document === 'undefined') return;
  scriptRequested = true;
  pbjs(); // ensure window.pbjs.que exists before the bundle evaluates
  if (document.querySelector(`script[src="${PREBID_SCRIPT_SRC}"]`)) return;
  const s = document.createElement('script');
  s.src = PREBID_SCRIPT_SRC;
  s.async = true;
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
          gdpr: { cmpApi: 'iab', timeout: 3000, defaultGdprScope: true },
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

  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Hard wall-clock guard: if prebid.js never loads or bidsBackHandler never
    // fires, resolve anyway so GPT still serves. A touch above the auction
    // timeout so a normal auction always wins the race.
    const guard = window.setTimeout(done, timeoutMs + 500);

    pbjs().que.push(() => {
      try {
        const p = pbjs() as unknown as {
          addAdUnits: (u: unknown) => void;
          requestBids: (o: unknown) => void;
          setTargetingForGPTAsync: (codes: string[]) => void;
        };
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
