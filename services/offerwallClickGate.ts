/**
 * Click-only AdSense Offerwall on the job board.
 *
 * FC_JOBBOARD_OFFERWALL_GATE_JS (build-plugins/constants.ts, twin inline in
 * index.html) holds the Offerwall phase of Funding Choices on every
 * job-board section (JOB_BOARD_SECTION_PATHNAME_RX: all cantons, the
 * Switzerland aggregator, every locale) and suppresses the Offerwall alone on
 * every other page, so it never shows on entry. This
 * module releases it when the visitor clicks "Candidati" and follows it on
 * screen. Funding Choices exposes no Offerwall lifecycle callback, so both
 * steps are read from what it leaves in the page: every message mounts under
 * a body-level `fc-<kind>-root`, and the Offerwall is the root that becomes
 * visible after the release. Live probe on the job board (25-09): after the
 * rewarded ad's own "Chiudi", Funding Choices thanks the visitor and removes
 * the root about 3 s later, and its first-party `FCOEC` cookie, absent before
 * the close, is present afterwards. The root going away is when the offer may
 * take the screen back; a new `FCOEC` is what says the reward was granted.
 * When exactly Funding Choices writes it was not isolated, hence the wait
 * after the close.
 *
 * A release cannot be taken back: once the held call proceeds, Google may
 * still render the Offerwall later. So the observer never gives up on an
 * Offerwall that is on screen, and a caller must not start a second rewarded
 * flow after `appear_timeout` while it stays on this page.
 */

export interface OfferwallGateState {
  state?: 'idle' | 'held' | 'released' | 'suppressed' | 'off_board';
  release?: () => boolean;
}

declare global {
  interface Window {
    __ftOfferwallGate?: OfferwallGateState;
  }
}

/** Time the Offerwall has to render after the release (2.0-2.8 s live). */
export const OFFERWALL_APPEAR_TIMEOUT_MS = 5000;
/** Time on screen after which a stall is reported; the observer keeps going. */
export const OFFERWALL_STALL_REPORT_MS = 10 * 60 * 1000;
/** Cookie Funding Choices sets once the Offerwall's reward is granted. */
export const FC_OFFERWALL_ENTITLEMENT_COOKIE = 'FCOEC';
/** How long after the root closes the entitlement cookie may still arrive. */
export const OFFERWALL_ENTITLEMENT_GRACE_MS = 10_000;
const POLL_MS = 200;

const FC_ROOT_CLASS = /^fc-[a-z0-9-]+-root$/;

export type OfferwallReleaseResult =
  | { outcome: 'completed'; shownMs: number; closedMs: number; completedMs: number; root: string }
  | { outcome: 'closed_without_reward'; shownMs: number; closedMs: number; root: string }
  | { outcome: 'not_shown'; reason: 'not_held' | 'release_refused' | 'appear_timeout' };

export interface ReleaseHeldOfferwallOptions {
  onShown?: (info: { shownMs: number; root: string }) => void;
  /** The root closed; the entitlement check is running. */
  onClosed?: (info: { shownMs: number; closedMs: number; root: string }) => void;
  /** Still on screen after `stallReportMs`; reported once, observation continues. */
  onStalled?: (info: { shownMs: number; root: string }) => void;
  appearTimeoutMs?: number;
  stallReportMs?: number;
  entitlementGraceMs?: number;
  win?: Window;
}

/**
 * `suppressed`: the gate let the consent message through and dropped the
 * Offerwall for this page view (no stored consent decision yet).
 * `off_board`: Funding Choices reached the gate on a page outside the
 * job-board sections, where the Offerwall is always dropped; the visitor
 * then navigated to a job in the SPA without a new page load.
 * `absent`: Funding Choices never reached the gate on this page view.
 */
export type OfferwallGateStatus = 'held' | 'released' | 'suppressed' | 'off_board' | 'absent';

export function offerwallGateStatus(win: Window = window): OfferwallGateStatus {
  const gate = win.__ftOfferwallGate;
  if (gate?.state === 'held' && typeof gate.release === 'function') return 'held';
  if (gate?.state === 'released' || gate?.state === 'suppressed' || gate?.state === 'off_board') return gate.state;
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
 * is clear that it did not show in time. Roots already visible before the
 * release (the consent message, the revocation link) are never mistaken for
 * the Offerwall. A close counts as `completed` only when the entitlement
 * cookie was set or renewed after the release; there is no outcome for an
 * Offerwall that simply stays open.
 */
export function releaseHeldOfferwall(options: ReleaseHeldOfferwallOptions = {}): Promise<OfferwallReleaseResult> {
  const win = options.win ?? window;
  const doc = win.document;
  const appearTimeoutMs = options.appearTimeoutMs ?? OFFERWALL_APPEAR_TIMEOUT_MS;
  const stallReportMs = options.stallReportMs ?? OFFERWALL_STALL_REPORT_MS;
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
    let stallReported = false;
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
      if (closedMs === null) {
        if (isShown(shown.el)) {
          if (!stallReported && elapsed - shown.shownMs >= stallReportMs) {
            stallReported = true;
            options.onStalled?.({ shownMs: shown.shownMs, root: shown.root });
          }
          return;
        }
        closedMs = elapsed;
        options.onClosed?.({ shownMs: shown.shownMs, closedMs, root: shown.root });
      }
      const entitlement = readCookie(doc, FC_OFFERWALL_ENTITLEMENT_COOKIE);
      if (entitlement !== null && entitlement !== entitlementBefore) {
        finish({ outcome: 'completed', shownMs: shown.shownMs, closedMs, completedMs: elapsed, root: shown.root });
      } else if (elapsed - closedMs >= entitlementGraceMs) {
        finish({ outcome: 'closed_without_reward', shownMs: shown.shownMs, closedMs, root: shown.root });
      }
    }, POLL_MS);
  });
}
