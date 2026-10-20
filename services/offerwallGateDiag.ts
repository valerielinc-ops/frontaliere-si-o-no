/**
 * Why the Offerwall gate is `absent` at a "Candidati" click: Funding Choices
 * never reached it on this page view, so no Offerwall can be released and
 * the click goes to the paid fallback (`rewarded_offerwall_not_shown`,
 * reason `not_held`). GA4 04-06/10: 11% of the clicks of visits that landed
 * on the job board (19 of 177), consent granted, every browser, cause not
 * known. The SPA entries from an off-board page were the other half and are
 * `off_board` since #11896.
 *
 * This reads the page once at that decision and once more a little later,
 * and sends both as GA4 events. The property has no free event dimension
 * (50 of 50), so the events carry only parameters GA4 already has; read them
 * filtered on the event name.
 *
 * `rewarded_offerwall_gate_absent`, at the decision:
 *   - `reason`: the first step of the chain that failed (`stage` below), then
 *     `+spa` when the page was reached by an SPA navigation and `+fcoec` when
 *     Google's entitlement cookie is there (Funding Choices shows no
 *     Offerwall to a visitor it already entitled);
 *   - `ad_path`, `fc_loaded`, `adsbygoogle_loaded`, `ad_blocked`: as in
 *     `ad_page_diag` (services/adPageDiag.ts), read at the click.
 *     `fc_loaded` is Funding Choices' own API: until 2026-10-07 it also
 *     counted `__tcfapi`, which Google's ad script stubs by itself, so with
 *     the Funding Choices script blocked the stage came out as
 *     `cmf_not_called` instead of `fc_not_loaded` (live);
 *   - `shown_ms`: milliseconds from the page load to the decision.
 * `rewarded_offerwall_gate_late`, OFFERWALL_GATE_LATE_CHECK_MS later:
 *   - `reason` and `gate_status`: the gate status then. `held` means the
 *     click only came too early; while still absent, `reason` is the stage;
 *   - `shown_ms`: milliseconds from the page load to this check.
 *
 * Stages, in the order a page view goes through them:
 *   - `ads_<ad_path>`: the ad path did not run (`bot_gated`,
 *     `noads_entitlement`, `waiting_consent`), so nothing loads Funding Choices;
 *   - `fc_no_script`: no Funding Choices script in the page, and nothing
 *     scheduled it;
 *   - `fc_scheduled`: the CMP bridge that injects it has run, the script is
 *     not in the page yet (the loaders inject it on idle without a decision);
 *   - `fc_not_loaded`: the script is there but its API is not (blocked, failed
 *     or still loading);
 *   - `gate_not_installed`: Funding Choices loaded on a page without the gate;
 *   - `cmf_not_called`: Funding Choices never called the controlled messaging
 *     function;
 *   - `cmf_first_only`: only the first, enum-less call came; the call that
 *     carries the Offerwall did not;
 *   - `held_no_release`, `gate_<state>`: a gate object in an unusable state.
 *
 * Fails open: a read that throws sends nothing and never touches the click.
 */

import { collectAdPageDiag, type AdPathReason } from './adPageDiag';
import { FC_OFFERWALL_ENTITLEMENT_COOKIE, offerwallGateStatus } from './offerwallClickGate';
import { FUNDING_CHOICES_SCRIPT } from './offerwallRecovery';

/** How long after the decision the gate is read again. */
export const OFFERWALL_GATE_LATE_CHECK_MS = 8000;

export const OFFERWALL_GATE_ABSENT_EVENT = 'rewarded_offerwall_gate_absent';
export const OFFERWALL_GATE_LATE_EVENT = 'rewarded_offerwall_gate_late';
export type OfferwallGateDiagEvent = typeof OFFERWALL_GATE_ABSENT_EVENT | typeof OFFERWALL_GATE_LATE_EVENT;

export interface OfferwallGateAbsentDiag {
  reason: string;
  ad_path: AdPathReason;
  fc_loaded: 0 | 1;
  adsbygoogle_loaded: 0 | 1;
  ad_blocked: 0 | 1;
  shown_ms: number;
}

type AdDiagWindow = Parameters<typeof collectAdPageDiag>[0];
/** The flags the inline gate leaves on `googlefc` (index.html, FC_JOBBOARD_OFFERWALL_GATE_JS). */
interface GateFlags {
  __ftOfferwallGateInstalled?: boolean;
  __ftOfferwallBootstrapComplete?: boolean;
}

function sinceLoadMs(win: Window): number {
  return Math.max(0, Math.round(win.performance?.now?.() ?? 0));
}

/** The page view started on another path: the visitor got here in the SPA. */
function reachedBySpaNavigation(win: Window): boolean {
  try {
    const entry = win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!entry?.name) return false;
    return new URL(entry.name, win.location.href).pathname !== win.location.pathname;
  } catch {
    return false;
  }
}

function hasEntitlementCookie(win: Window): boolean {
  return new RegExp(`(?:^|;\\s*)${FC_OFFERWALL_ENTITLEMENT_COOKIE}=`).test(win.document.cookie);
}

/** Snapshot of why the gate is absent. Pure read. `isBot`: the bot gate of the ad path (tests). */
export function readOfferwallGateAbsentDiag(win: Window = window, isBot?: () => boolean): OfferwallGateAbsentDiag {
  const page = collectAdPageDiag(win as AdDiagWindow, { path: win.location.pathname, firstFill: -1, cmp: 0 }, 0, isBot);
  const flags = win as unknown as { googlefc?: GateFlags; __ftFcConsentBridge?: unknown };
  const fc = flags.googlefc;
  const gate = win.__ftOfferwallGate;
  const stage =
    page.ad_path !== 'loaded' ? `ads_${page.ad_path}`
      : win.document.querySelector(FUNDING_CHOICES_SCRIPT) === null ? (flags.__ftFcConsentBridge ? 'fc_scheduled' : 'fc_no_script')
        : !page.fc_loaded ? 'fc_not_loaded'
          : fc?.__ftOfferwallGateInstalled !== true ? 'gate_not_installed'
            : fc.__ftOfferwallBootstrapComplete !== true ? 'cmf_not_called'
              : !gate ? 'cmf_first_only'
                : gate.state === 'held' ? 'held_no_release'
                  : `gate_${String(gate.state ?? 'none')}`;
  return {
    reason: `${stage}${reachedBySpaNavigation(win) ? '+spa' : ''}${hasEntitlementCookie(win) ? '+fcoec' : ''}`,
    ad_path: page.ad_path,
    fc_loaded: page.fc_loaded,
    adsbygoogle_loaded: page.adsbygoogle_loaded,
    ad_blocked: page.ad_blocked,
    shown_ms: sinceLoadMs(win),
  };
}

/**
 * Send the diagnostic of an `absent` gate now, and the gate status
 * OFFERWALL_GATE_LATE_CHECK_MS later. `send` adds the offer's event context.
 */
export function reportOfferwallGateAbsent(
  send: (eventName: OfferwallGateDiagEvent, params: Record<string, unknown>) => void,
  win: Window = window,
  isBot?: () => boolean,
): void {
  try {
    send(OFFERWALL_GATE_ABSENT_EVENT, { ...readOfferwallGateAbsentDiag(win, isBot) });
  } catch {
    return;
  }
  win.setTimeout(() => {
    try {
      const status = offerwallGateStatus(win);
      send(OFFERWALL_GATE_LATE_EVENT, {
        reason: status === 'absent' ? readOfferwallGateAbsentDiag(win, isBot).reason : status,
        gate_status: status,
        shown_ms: sinceLoadMs(win),
      });
    } catch {
      // Diagnostic only.
    }
  }, OFFERWALL_GATE_LATE_CHECK_MS);
}
