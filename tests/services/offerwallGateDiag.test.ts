// @vitest-environment jsdom
/**
 * Diagnostic of an `absent` Offerwall gate (services/offerwallGateDiag.ts):
 * which step of the Funding Choices chain a "Candidati" click found missing,
 * and what the gate reads a little later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADS_CONSENT_STORAGE_KEY } from '@/services/adsConsent';
import { FC_OFFERWALL_ENTITLEMENT_COOKIE } from '@/services/offerwallClickGate';
import {
  OFFERWALL_GATE_ABSENT_EVENT,
  OFFERWALL_GATE_LATE_CHECK_MS,
  OFFERWALL_GATE_LATE_EVENT,
  readOfferwallGateAbsentDiag,
  reportOfferwallGateAbsent,
} from '@/services/offerwallGateDiag';

type Gfc = {
  showRevocationMessage?: () => void;
  __ftOfferwallGateInstalled?: boolean;
  __ftOfferwallBootstrapComplete?: boolean;
};
const w = window as unknown as { googlefc?: Gfc };
const notBot = () => false;

/** The navigation entry of this page view (jsdom has none): where the document was loaded. */
const navigationEntry = Object.getOwnPropertyDescriptor(window.performance, 'getEntriesByType');
function loadedAt(url: string): void {
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    value: (type: string) => (type === 'navigation' ? [{ name: url }] : []),
  });
}

/** The page as far as each step: consent, the script, its API, the gate, the first call. */
function page(step: 'consent' | 'script' | 'api' | 'gate' | 'first_call'): void {
  const steps = ['consent', 'script', 'api', 'gate', 'first_call'];
  const reached = (name: string) => steps.indexOf(name) <= steps.indexOf(step);
  window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
  if (reached('script')) {
    const script = document.createElement('script');
    script.src = 'https://fundingchoicesmessages.google.com/i/pub-0?ers=1';
    script.type = 'text/plain';
    document.head.appendChild(script);
  }
  if (reached('api')) w.googlefc = { showRevocationMessage: () => undefined };
  if (reached('gate')) w.googlefc!.__ftOfferwallGateInstalled = true;
  if (reached('first_call')) w.googlefc!.__ftOfferwallBootstrapComplete = true;
}

describe('offerwallGateDiag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.head.querySelectorAll('script[src*="fundingchoicesmessages"]').forEach((el) => el.remove());
    delete w.googlefc;
    delete (window as unknown as { __ftFcConsentBridge?: number }).__ftFcConsentBridge;
    delete (window as unknown as { __tcfapi?: unknown }).__tcfapi;
    delete window.__ftOfferwallGate;
    if (navigationEntry) Object.defineProperty(window.performance, 'getEntriesByType', navigationEntry);
    else delete (window.performance as { getEntriesByType?: unknown }).getEntriesByType;
    document.cookie = `${FC_OFFERWALL_ENTITLEMENT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });

  it('names the first step of the chain that is missing', () => {
    expect(readOfferwallGateAbsentDiag(window, notBot).reason, 'no consent decision').toBe('ads_waiting_consent');

    page('consent');
    expect(readOfferwallGateAbsentDiag(window, () => true)).toMatchObject({ reason: 'ads_bot_gated', ad_path: 'bot_gated' });
    expect(readOfferwallGateAbsentDiag(window, notBot)).toMatchObject({ reason: 'fc_no_script', ad_path: 'loaded', fc_loaded: 0 });
    // The CMP bridge has run: Funding Choices is scheduled, its script not injected yet.
    (window as unknown as { __ftFcConsentBridge?: number }).__ftFcConsentBridge = 1;
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('fc_scheduled');

    page('script');
    expect(readOfferwallGateAbsentDiag(window, notBot)).toMatchObject({ reason: 'fc_not_loaded', fc_loaded: 0 });
    // Live 2026-10-07, Funding Choices script blocked: the page still has `googlefc` (our gate
    // and bridge) and a `__tcfapi` stub from Google's ad script. Neither is Funding Choices.
    w.googlefc = { __ftOfferwallGateInstalled: true };
    (window as unknown as { __tcfapi?: unknown }).__tcfapi = () => undefined;
    expect(readOfferwallGateAbsentDiag(window, notBot)).toMatchObject({ reason: 'fc_not_loaded', fc_loaded: 0 });
    delete w.googlefc;

    page('api');
    expect(readOfferwallGateAbsentDiag(window, notBot)).toMatchObject({ reason: 'gate_not_installed', fc_loaded: 1 });

    page('gate');
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('cmf_not_called');

    page('first_call');
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('cmf_first_only');

    window.__ftOfferwallGate = { state: 'held' };
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('held_no_release');
    window.__ftOfferwallGate = {};
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('gate_none');
  });

  it('marks an SPA entry and a Google entitlement, and times the decision from the page load', () => {
    page('first_call');
    vi.spyOn(window.performance, 'now').mockReturnValue(4321.6);
    expect(readOfferwallGateAbsentDiag(window, notBot)).toMatchObject({ reason: 'cmf_first_only', shown_ms: 4322 });

    document.cookie = `${FC_OFFERWALL_ENTITLEMENT_COOKIE}=granted; path=/`;
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('cmf_first_only+fcoec');

    loadedAt(`${window.location.origin}/cerca-lavoro-ticino/`);
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('cmf_first_only+spa+fcoec');

    // The page view started on this very path: a page load, not an SPA entry.
    loadedAt(window.location.href);
    expect(readOfferwallGateAbsentDiag(window, notBot).reason).toBe('cmf_first_only+fcoec');
  });

  it('sends the diagnostic at the decision, and the gate status a little later', () => {
    page('first_call');
    const send = vi.fn();
    reportOfferwallGateAbsent(send, window, notBot);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(OFFERWALL_GATE_ABSENT_EVENT, {
      reason: 'cmf_first_only',
      ad_path: 'loaded',
      fc_loaded: 1,
      adsbygoogle_loaded: 0,
      ad_blocked: 0,
      shown_ms: expect.any(Number),
    });

    // Funding Choices reaches the gate after the click: it only came too early.
    window.__ftOfferwallGate = { state: 'held', release: () => true };
    vi.advanceTimersByTime(OFFERWALL_GATE_LATE_CHECK_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(OFFERWALL_GATE_LATE_EVENT, {
      reason: 'held',
      gate_status: 'held',
      shown_ms: expect.any(Number),
    });
  });

  it('says how far Funding Choices got when the gate is still absent later', () => {
    page('script');
    const send = vi.fn();
    reportOfferwallGateAbsent(send, window, notBot);
    expect(send).toHaveBeenLastCalledWith(OFFERWALL_GATE_ABSENT_EVENT, expect.objectContaining({ reason: 'fc_not_loaded' }));

    page('first_call');
    vi.advanceTimersByTime(OFFERWALL_GATE_LATE_CHECK_MS);
    expect(send).toHaveBeenLastCalledWith(OFFERWALL_GATE_LATE_EVENT, expect.objectContaining({
      reason: 'cmf_first_only',
      gate_status: 'absent',
    }));
  });

  it('fails open: a page it cannot read sends nothing and schedules nothing', () => {
    const send = vi.fn();
    const setTimeoutSpy = vi.fn();
    expect(() => reportOfferwallGateAbsent(send, { setTimeout: setTimeoutSpy } as unknown as Window, notBot)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
