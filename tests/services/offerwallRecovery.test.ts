// @vitest-environment jsdom
/**
 * services/offerwallRecovery.ts: the plan for a "Candidati" click the
 * Offerwall gate cannot serve as it arrives, the short wait for a gate that
 * Funding Choices is still loading, and the one-shot marker that resumes the
 * click after the recovery reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OFFERWALL_GATE_SCHEDULED_WAIT_MS,
  OFFERWALL_GATE_WAIT_MS,
  OFFERWALL_RESUME_MAX_AGE_MS,
  markOfferwallResume,
  offerwallConsentState,
  offerwallGateWaitMs,
  planOfferwallClick,
  takeOfferwallResume,
  waitForOfferwallGate,
} from '@/services/offerwallRecovery';
import { reopenAdsConsentMessage } from '@/services/adsConsent';

type GateWindow = Window & { __ftOfferwallGate?: { state?: string; release?: () => boolean } };
const gateWindow = window as GateWindow;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete gateWindow.__ftOfferwallGate;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.querySelectorAll('script[data-test-fc]').forEach((el) => el.remove());
  delete (window as unknown as { googlefc?: unknown }).googlefc;
  delete (window as unknown as { __ftFcConsentBridge?: unknown }).__ftFcConsentBridge;
});

describe('offerwallConsentState', () => {
  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    [null, 'none'],
    ['garbage', 'none'],
  ] as const)('reads %s as %s', (stored, expected) => {
    if (stored !== null) window.localStorage.setItem('frontaliere_ads_consent', stored);
    expect(offerwallConsentState()).toBe(expected);
  });
});

describe('planOfferwallClick', () => {
  it('releases a held Offerwall after any consent decision', () => {
    expect(planOfferwallClick('held', 'granted', { canReload: true })).toBe('offerwall');
    // A refusal gets the Offerwall with Limited Ads (live probe, 28-09).
    expect(planOfferwallClick('held', 'denied', { canReload: true })).toBe('offerwall');
    expect(planOfferwallClick('held', 'none', { canReload: true })).toBe('consent');
  });

  it.each(['suppressed', 'released', 'off_board'] as const)(
    'reloads a %s gate once, after a consent decision, when a reload can resume the click',
    (status) => {
      expect(planOfferwallClick(status, 'granted', { canReload: true })).toBe('reload');
      expect(planOfferwallClick(status, 'denied', { canReload: true })).toBe('reload');
      expect(planOfferwallClick(status, 'granted', { canReload: false })).toBe('gpt');
      expect(planOfferwallClick(status, 'none', { canReload: true })).toBe('consent');
    },
  );

  it('never asks for consent or reloads when Funding Choices never reached the gate', () => {
    for (const consent of ['granted', 'denied', 'none'] as const) {
      expect(planOfferwallClick('absent', consent, { canReload: true })).toBe('gpt');
    }
  });
});

describe('waitForOfferwallGate', () => {
  it('resolves at once for a gate already reached', async () => {
    gateWindow.__ftOfferwallGate = { state: 'suppressed' };
    await expect(waitForOfferwallGate(3000)).resolves.toBe('suppressed');
  });

  it('resolves as soon as Funding Choices holds the Offerwall', async () => {
    vi.useFakeTimers();
    const pending = waitForOfferwallGate(3000);
    await vi.advanceTimersByTimeAsync(1200);
    gateWindow.__ftOfferwallGate = { state: 'held', release: () => true };
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('held');
  });

  it('gives up as absent at the timeout', async () => {
    vi.useFakeTimers();
    const pending = waitForOfferwallGate(3000);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(pending).resolves.toBe('absent');
  });

  it('stops waiting when aborted', async () => {
    vi.useFakeTimers();
    const watch = new AbortController();
    const pending = waitForOfferwallGate(3000, { signal: watch.signal });
    watch.abort();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('absent');
  });
});

describe('offerwallGateWaitMs', () => {
  it('does not wait when Funding Choices is not coming on this page', () => {
    expect(offerwallGateWaitMs(false)).toBe(0);
  });

  it('waits for a Funding Choices script already in the page', () => {
    const script = document.createElement('script');
    script.setAttribute('data-test-fc', '');
    script.src = 'https://fundingchoicesmessages.google.com/i/pub-8628054934855353?ers=1';
    document.head.appendChild(script);
    expect(offerwallGateWaitMs(false)).toBe(OFFERWALL_GATE_WAIT_MS);
  });

  it('waits longer while the loader has only scheduled Funding Choices (bridge, no script yet)', () => {
    (window as unknown as { __ftFcConsentBridge?: number }).__ftFcConsentBridge = 1;
    expect(offerwallGateWaitMs(false)).toBe(OFFERWALL_GATE_SCHEDULED_WAIT_MS);
  });

  it('waits longer for the click resumed after the reload', () => {
    expect(offerwallGateWaitMs(true)).toBe(OFFERWALL_GATE_SCHEDULED_WAIT_MS);
  });
});

describe('resume marker', () => {
  it('resumes the same job on the same page once', () => {
    expect(markOfferwallResume('job-1')).toBe(true);
    expect(takeOfferwallResume('job-1')).toEqual({});
    expect(takeOfferwallResume('job-1')).toBeNull();
  });

  it('carries the reload reason and the click state to the resumed click', () => {
    markOfferwallResume('job-1', { reason: 'no_consent_decision', gate_status: 'suppressed', consent_state: 'granted' });
    expect(takeOfferwallResume('job-1')).toEqual({
      reason: 'no_consent_decision',
      gate_status: 'suppressed',
      consent_state: 'granted',
    });
  });

  it('carries the free choice taken before the reload', () => {
    markOfferwallResume('job-1', { reason: 'already_released', gate_status: 'released', consent_state: 'granted', choice: 'free' });
    expect(takeOfferwallResume('job-1')).toMatchObject({ choice: 'free' });
  });

  it('ignores and clears a marker for another job', () => {
    markOfferwallResume('job-1');
    expect(takeOfferwallResume('job-2')).toBeNull();
    expect(takeOfferwallResume('job-1')).toBeNull();
  });

  it('ignores a marker left on another page', () => {
    window.sessionStorage.setItem(
      'frontaliere_offerwall_resume_v1',
      JSON.stringify({ jobId: 'job-1', path: '/cerca-lavoro-ticino/altro/', at: Date.now() }),
    );
    expect(takeOfferwallResume('job-1')).toBeNull();
  });

  it('ignores a stale or malformed marker', () => {
    window.sessionStorage.setItem(
      'frontaliere_offerwall_resume_v1',
      JSON.stringify({ jobId: 'job-1', path: window.location.pathname, at: Date.now() - OFFERWALL_RESUME_MAX_AGE_MS - 1 }),
    );
    expect(takeOfferwallResume('job-1')).toBeNull();
    window.sessionStorage.setItem('frontaliere_offerwall_resume_v1', '{not json');
    expect(takeOfferwallResume('job-1')).toBeNull();
  });

  it('reports a marker it could not store, so the caller does not reload', () => {
    const real = window.sessionStorage;
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, 'sessionStorage', { value: throwing, configurable: true });
    try {
      expect(markOfferwallResume('job-1')).toBe(false);
    } finally {
      Object.defineProperty(window, 'sessionStorage', { value: real, configurable: true });
    }
  });
});

describe('reopenAdsConsentMessage', () => {
  type Gfc = { callbackQueue?: Array<Record<string, () => void>>; showRevocationMessage?: () => void };
  const gfc = () => (window as unknown as { googlefc?: Gfc }).googlefc;

  it('calls Funding Choices directly once it is loaded', () => {
    const showRevocationMessage = vi.fn();
    (window as unknown as { googlefc?: Gfc }).googlefc = { callbackQueue: [], showRevocationMessage };
    reopenAdsConsentMessage();
    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
    // A queued CONSENT_DATA_READY callback never runs after that event fired.
    expect(gfc()?.callbackQueue).toEqual([]);
  });

  it('queues the call until Funding Choices is loaded', () => {
    reopenAdsConsentMessage();
    const queued = gfc()?.callbackQueue ?? [];
    expect(queued).toHaveLength(1);
    const showRevocationMessage = vi.fn();
    gfc()!.showRevocationMessage = showRevocationMessage;
    queued[0].CONSENT_DATA_READY();
    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
  });

  it('queues one call however often it is asked before Funding Choices loads', () => {
    reopenAdsConsentMessage();
    reopenAdsConsentMessage();
    const queued = gfc()?.callbackQueue ?? [];
    expect(queued).toHaveLength(1);
    const showRevocationMessage = vi.fn();
    gfc()!.showRevocationMessage = showRevocationMessage;
    queued[0].CONSENT_DATA_READY();
    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
  });

  it('never throws when Funding Choices throws', () => {
    (window as unknown as { googlefc?: Gfc }).googlefc = {
      showRevocationMessage: () => {
        throw new Error('fc');
      },
    };
    expect(() => reopenAdsConsentMessage()).not.toThrow();
  });
});
