/**
 * Getting the AdSense Offerwall to the "Candidati" clicks the gate could not
 * serve as they arrived (services/offerwallClickGate.ts).
 *
 * Measured 27-28/09 (102 rewarded requests, 59 released, 47 shown) and in
 * live probes on a job page:
 * - `suppressed`: a new visitor accepts the consent message on the job page,
 *   then clicks. Funding Choices delivered the Offerwall call before that
 *   decision and does not call again on the same page view, so nothing is
 *   held. After a reload the gate is `held` 0.65 s after the load. The same
 *   goes for `released` (a second attempt, a page back from the back-forward
 *   cache) and a stale `off_board`.
 * - Refused ad consent: with AdSense started for Limited Ads
 *   (`isAdSenseAllowed()` in services/adsConsent.ts) the held Offerwall
 *   renders in 0.7 s; while AdSense loaded only on a grant it never rendered
 *   (nothing in 12 s). A refusal is therefore a decision like a grant.
 * - No decision yet: nothing is held and no ad can be served. The visitor is
 *   asked to answer the consent message, reopened; any answer lets the call
 *   held since the load render the Offerwall (2.2 s after a grant), or takes
 *   the reload when nothing was held.
 * - `absent`: Funding Choices has not reached the gate yet when the click
 *   comes, or never will (blocked).
 *
 * So the click waits briefly for a gate that is still loading, asks for the
 * consent choice where there is none, and reloads the page once, resuming the
 * same click, where only a fresh page load can hold the Offerwall.
 */

import { ADS_CONSENT_DENIED, ADS_CONSENT_GRANTED, getAdsConsent } from './adsConsent';
import { offerwallGateStatus, type OfferwallGateStatus } from './offerwallClickGate';

export type OfferwallConsentState = 'granted' | 'denied' | 'none';

/** The ad consent the Offerwall depends on, as the CMP bridge stored it. */
export function offerwallConsentState(): OfferwallConsentState {
  const value = getAdsConsent();
  if (value === ADS_CONSENT_GRANTED) return 'granted';
  if (value === ADS_CONSENT_DENIED) return 'denied';
  return 'none';
}

/**
 * `offerwall`: release the held Offerwall.
 * `consent`: no consent decision, so no ad can be served: ask for the choice.
 * `reload`: only a fresh page load can hold the Offerwall: reload once and
 * resume the click.
 * `gpt`: nothing to release and nothing a reload would change: the GPT path.
 */
export type OfferwallClickPlan = 'offerwall' | 'consent' | 'reload' | 'gpt';

export function planOfferwallClick(
  status: OfferwallGateStatus,
  consent: OfferwallConsentState,
  { canReload }: { canReload: boolean },
): OfferwallClickPlan {
  // Funding Choices never reached the gate (blocked, or not loaded in time):
  // it cannot show the consent message either.
  if (status === 'absent') return 'gpt';
  // Granted or refused: Google serves the Offerwall's ad either way, with
  // Limited Ads after a refusal.
  if (consent === 'none') return 'consent';
  if (status === 'held') return 'offerwall';
  return canReload ? 'reload' : 'gpt';
}

/**
 * How long a click waits for a gate that Funding Choices has not reached yet.
 * With a stored decision Funding Choices loads with the page and calls the
 * gate 0.5-1.3 s after the load (live, desktop).
 */
export const OFFERWALL_GATE_WAIT_MS = 3000;
/** The same wait for the click resumed right after the reload. */
export const OFFERWALL_RESUME_GATE_WAIT_MS = 6000;
const GATE_POLL_MS = 100;

/** Whether the page is loading Funding Choices (its script is in the document). */
export function isFundingChoicesOnPage(doc: Document = document): boolean {
  return doc.querySelector('script[src*="fundingchoicesmessages.google.com"]') !== null;
}

/** Resolve with the gate status as soon as it is no longer `absent`, or at the timeout. */
export function waitForOfferwallGate(
  timeoutMs: number,
  { signal, win = window }: { signal?: AbortSignal; win?: Window } = {},
): Promise<OfferwallGateStatus> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer = 0;
    const check = (): boolean => {
      const status = offerwallGateStatus(win);
      if (status === 'absent' && !signal?.aborted && Date.now() - startedAt < timeoutMs) return false;
      win.clearInterval(timer);
      resolve(status);
      return true;
    };
    if (check()) return;
    timer = win.setInterval(check, GATE_POLL_MS);
  });
}

const RESUME_STORAGE_KEY = 'frontaliere_offerwall_resume_v1';
/** A resume marker older than this is ignored: the reload did not follow the click. */
export const OFFERWALL_RESUME_MAX_AGE_MS = 60_000;

/**
 * Remember, for the reload that follows, which job's click to resume. Returns
 * false when session storage is unavailable: the caller must not reload then,
 * or the click would be lost.
 */
export function markOfferwallResume(jobId: string, win: Window = window): boolean {
  try {
    win.sessionStorage.setItem(
      RESUME_STORAGE_KEY,
      JSON.stringify({ jobId, path: win.location.pathname, at: Date.now() }),
    );
    return win.sessionStorage.getItem(RESUME_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Read and clear the resume marker: true only for a fresh marker left by this
 * job on this page. Clearing it on every read makes the resume one-shot.
 */
export function takeOfferwallResume(jobId: string, win: Window = window): boolean {
  let raw: string | null = null;
  try {
    raw = win.sessionStorage.getItem(RESUME_STORAGE_KEY);
    win.sessionStorage.removeItem(RESUME_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const marker = JSON.parse(raw) as { jobId?: unknown; path?: unknown; at?: unknown };
    const age = typeof marker.at === 'number' ? Date.now() - marker.at : Number.NaN;
    return marker.jobId === jobId
      && marker.path === win.location.pathname
      && age >= 0
      && age <= OFFERWALL_RESUME_MAX_AGE_MS;
  } catch {
    return false;
  }
}
