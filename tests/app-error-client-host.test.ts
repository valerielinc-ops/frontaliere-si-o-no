// @vitest-environment jsdom
/**
 * Client half of the app-error host rule: `Analytics.trackAppError` must not
 * send `app_error` / `exception` to GA4 from the dev server or the Firebase
 * service domains, and must keep sending them from production.
 *
 * Failure title: «Feeder app-error: issue riconfermata senza eventi negli
 * ultimi 7 giorni».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logEvent = vi.hoisted(() => vi.fn());

vi.mock('firebase/analytics', () => ({
  getAnalytics: vi.fn(() => ({})),
  logEvent,
  setUserId: vi.fn(),
  setUserProperties: vi.fn(),
  isSupported: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/services/firebase', () => ({
  app: {},
  analytics: null,
  db: {},
  getApp: vi.fn(async () => ({})),
  getAnalytics: vi.fn(async () => ({})),
  getConfigValue: vi.fn(async () => ''),
  createTrace: vi.fn(async () => null),
  measureTrace: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

// tests/setup-common.tsx replaces the analytics service with a stub for every
// file: this one tests the real emitter.
vi.unmock('@/services/analytics');

declare const jsdom: { reconfigure(options: { url: string }): void };

const sentEvents = () => logEvent.mock.calls.map((call) => call[1] as string);

/** Fires one error and one control event from `host`; resolves once GA4 got the control. */
async function emitFrom(host: string) {
  jsdom.reconfigure({ url: `https://${host}/it/` });
  vi.resetModules();
  const { Analytics } = await import('../services/analytics');
  Analytics.trackAppError('unhandled_error', { message: 'boom' });
  Analytics.trackJobAlertDeleted();
  await vi.waitFor(() => expect(sentEvents()).toContain('job_alert_deleted'));
  return sentEvents();
}

describe('client: GA4 error events by host', () => {
  beforeEach(() => logEvent.mockClear());

  it.each(['127.0.0.1', 'localhost', 'frontaliere-ticino.firebaseapp.com'])(
    '%s sends no app_error and no exception, other events still flow',
    async (host) => {
      const events = await emitFrom(host);
      expect(events).not.toContain('app_error');
      expect(events).not.toContain('exception');
    },
  );

  it('the production host sends both', async () => {
    const events = await emitFrom('frontaliereticino.ch');
    expect(events).toEqual(expect.arrayContaining(['exception', 'app_error']));
  });
});
