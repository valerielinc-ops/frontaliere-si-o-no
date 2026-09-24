/**
 * Click-only AdSense Offerwall on the Italian job board.
 *
 * FC_JOBBOARD_OFFERWALL_GATE_JS (build-plugins/constants.ts, twin inline in
 * index.html) holds the Offerwall phase of Funding Choices on
 * /cerca-lavoro-ticino pages, so the Offerwall never shows on entry. This
 * module releases it when the visitor clicks "Candidati" and follows it on
 * screen. Funding Choices exposes no Offerwall lifecycle callback, so both
 * steps are read from its DOM: every message mounts under a body-level
 * `fc-<kind>-root`, and the Offerwall is the root that becomes visible after
 * the release. It is configured without a dismiss button, so that root going
 * away means the visitor completed the rewarded choice.
 */

export interface OfferwallGateState {
  state?: 'idle' | 'held' | 'released';
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
const POLL_MS = 200;

const FC_ROOT_CLASS = /^fc-[a-z0-9-]+-root$/;

export type OfferwallReleaseResult =
  | { outcome: 'completed'; shownMs: number; completedMs: number; root: string }
  | { outcome: 'not_shown'; reason: 'not_held' | 'release_refused' | 'appear_timeout' }
  | { outcome: 'timed_out'; shownMs: number; root: string };

export interface ReleaseHeldOfferwallOptions {
  onShown?: (info: { shownMs: number; root: string }) => void;
  appearTimeoutMs?: number;
  completionTimeoutMs?: number;
  win?: Window;
}

export function isOfferwallHeld(win: Window = window): boolean {
  const gate = win.__ftOfferwallGate;
  return gate?.state === 'held' && typeof gate.release === 'function';
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
 * Release the held Offerwall and resolve once it has been completed, or as
 * soon as it is clear that it will not show. Roots already visible before the
 * release (the consent message, the revocation link) are never mistaken for
 * the Offerwall.
 */
export function releaseHeldOfferwall(options: ReleaseHeldOfferwallOptions = {}): Promise<OfferwallReleaseResult> {
  const win = options.win ?? window;
  const doc = win.document;
  const appearTimeoutMs = options.appearTimeoutMs ?? OFFERWALL_APPEAR_TIMEOUT_MS;
  const completionTimeoutMs = options.completionTimeoutMs ?? OFFERWALL_COMPLETION_TIMEOUT_MS;
  const gate = win.__ftOfferwallGate;
  if (!isOfferwallHeld(win) || !gate?.release) {
    return Promise.resolve({ outcome: 'not_shown', reason: 'not_held' });
  }

  const before = new Set(visibleRoots(doc));
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
      if (!isShown(shown.el)) {
        finish({ outcome: 'completed', shownMs: shown.shownMs, completedMs: elapsed, root: shown.root });
        return;
      }
      if (elapsed - shown.shownMs >= completionTimeoutMs) {
        finish({ outcome: 'timed_out', shownMs: shown.shownMs, root: shown.root });
      }
    }, POLL_MS);
  });
}
