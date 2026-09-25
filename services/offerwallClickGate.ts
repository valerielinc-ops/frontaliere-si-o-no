/**
 * Click-only AdSense Offerwall on the Italian job board.
 *
 * FC_JOBBOARD_OFFERWALL_GATE_JS (build-plugins/constants.ts, twin inline in
 * index.html) holds the Offerwall phase of Funding Choices on
 * /cerca-lavoro-ticino pages, so the Offerwall never shows on entry. This
 * module releases it when the visitor clicks "Candidati" and follows it on
 * screen. Funding Choices exposes no Offerwall lifecycle callback, so both
 * steps are read from what it leaves in the page: every message mounts under
 * a body-level `fc-<kind>-root`, and the Offerwall is the root that becomes
 * visible after the release. Live probe on the job board (25-09): after the
 * rewarded ad's own "Chiudi", Funding Choices thanks the visitor, sets its
 * first-party `FCOEC` cookie and removes the root about 3 s later. The root
 * going away is when the offer may take the screen back; the new `FCOEC` is
 * what says the reward was granted.
 */

export interface OfferwallGateState {
  state?: 'idle' | 'held' | 'released' | 'suppressed';
  release?: () => boolean;
}

declare global {
  interface Window {
    __ftOfferwallGate?: OfferwallGateState;
  }
}

/** Time the Offerwall has to render after the release before the GPT path takes over. */
export const OFFERWALL_APPEAR_TIMEOUT_MS = 4000;
/** Upper bound on choice + rewarded video; past it the offer stops waiting. */
export const OFFERWALL_COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;
/** Cookie Funding Choices sets once the Offerwall's reward is granted. */
export const FC_OFFERWALL_ENTITLEMENT_COOKIE = 'FCOEC';
/** How long after the root closes the entitlement cookie may still arrive. */
export const OFFERWALL_ENTITLEMENT_GRACE_MS = 2000;
const POLL_MS = 200;

const FC_ROOT_CLASS = /^fc-[a-z0-9-]+-root$/;

export type OfferwallReleaseResult =
  | { outcome: 'completed'; shownMs: number; completedMs: number; root: string }
  | { outcome: 'closed_without_reward'; shownMs: number; closedMs: number; root: string }
  | { outcome: 'not_shown'; reason: 'not_held' | 'release_refused' | 'appear_timeout' }
  | { outcome: 'timed_out'; shownMs: number; root: string };

export interface ReleaseHeldOfferwallOptions {
  onShown?: (info: { shownMs: number; root: string }) => void;
  appearTimeoutMs?: number;
  completionTimeoutMs?: number;
  entitlementGraceMs?: number;
  win?: Window;
}

/**
 * `suppressed`: the gate let the consent message through and dropped the
 * Offerwall for this page view (no stored consent decision yet).
 * `absent`: Funding Choices never reached the gate on this page view.
 */
export type OfferwallGateStatus = 'held' | 'released' | 'suppressed' | 'absent';

export function offerwallGateStatus(win: Window = window): OfferwallGateStatus {
  const gate = win.__ftOfferwallGate;
  if (gate?.state === 'held' && typeof gate.release === 'function') return 'held';
  if (gate?.state === 'released' || gate?.state === 'suppressed') return gate.state;
  return 'absent';
}

export function isOfferwallHeld(win: Window = window): boolean {
  return offerwallGateStatus(win) === 'held';
}

function readCookie(doc: Document, name: string): string | null {
  const match = doc.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function isShown(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style?.display !== 'none' && style?.visibility !== 'hidden';
}

function rootClassOf(el: Element): string | undefined {
  return Array.from(el.classList).find((name) => FC_ROOT_CLASS.test(name));
}

function visibleRoots(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('[class*="fc-"][class*="-root"]'))
    .filter((el) => rootClassOf(el) !== undefined && isShown(el));
}

/**
 * Release the held Offerwall and resolve once it has closed, or as soon as it
 * is clear that it will not show. Roots already visible before the release
 * (the consent message, the revocation link) are never mistaken for the
 * Offerwall. A close counts as `completed` only when the entitlement cookie
 * was set or renewed after the release.
 */
export function releaseHeldOfferwall(options: ReleaseHeldOfferwallOptions = {}): Promise<OfferwallReleaseResult> {
  const win = options.win ?? window;
  const doc = win.document;
  const appearTimeoutMs = options.appearTimeoutMs ?? OFFERWALL_APPEAR_TIMEOUT_MS;
  const completionTimeoutMs = options.completionTimeoutMs ?? OFFERWALL_COMPLETION_TIMEOUT_MS;
  const entitlementGraceMs = options.entitlementGraceMs ?? OFFERWALL_ENTITLEMENT_GRACE_MS;
  const gate = win.__ftOfferwallGate;
  if (!isOfferwallHeld(win) || !gate?.release) {
    return Promise.resolve({ outcome: 'not_shown', reason: 'not_held' });
  }

  const before = new Set(visibleRoots(doc));
  const entitlementBefore = readCookie(doc, FC_OFFERWALL_ENTITLEMENT_COOKIE);
  let released = false;
  try {
    released = gate.release() === true;
  } catch {
    released = false;
  }
  if (!released) return Promise.resolve({ outcome: 'not_shown', reason: 'release_refused' });

  const startedAt = Date.now();
  return new Promise((resolve) => {
    let shown: { el: HTMLElement; root: string; shownMs: number } | null = null;
    let closedMs: number | null = null;
    const finish = (result: OfferwallReleaseResult) => {
      win.clearInterval(timer);
      resolve(result);
    };
    const timer = win.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (!shown) {
        const el = visibleRoots(doc).find((candidate) => !before.has(candidate));
        if (el) {
          shown = { el, root: rootClassOf(el) ?? 'fc-root', shownMs: elapsed };
          options.onShown?.({ shownMs: elapsed, root: shown.root });
          return;
        }
        if (elapsed >= appearTimeoutMs) finish({ outcome: 'not_shown', reason: 'appear_timeout' });
        return;
      }
      if (closedMs === null && !isShown(shown.el)) closedMs = elapsed;
      if (closedMs !== null) {
        const entitlement = readCookie(doc, FC_OFFERWALL_ENTITLEMENT_COOKIE);
        if (entitlement !== null && entitlement !== entitlementBefore) {
          finish({ outcome: 'completed', shownMs: shown.shownMs, completedMs: closedMs, root: shown.root });
        } else if (elapsed - closedMs >= entitlementGraceMs) {
          finish({ outcome: 'closed_without_reward', shownMs: shown.shownMs, closedMs, root: shown.root });
        }
        return;
      }
      if (elapsed - shown.shownMs >= completionTimeoutMs) {
        finish({ outcome: 'timed_out', shownMs: shown.shownMs, root: shown.root });
      }
    }, POLL_MS);
  });
}
