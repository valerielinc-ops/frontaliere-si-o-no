/**
 * Unit tests for `fireCalcEntryIfNeeded` + `CALC_ROUTE_REGEX`.
 *
 * Context: Phase 4 of the May 18 traffic-and-subscriptions recovery plan.
 * The Phase 1 diagnosis (`data/recovery-2026-05-18/calc-funnel.md`) found the
 * calculator funnel was tracking-broken — `funnel_step:entry` fired only at
 * session-init, regardless of landing page, while users landing on SEO calc
 * variants emitted `input_start` / `calculate` but never `entry`.
 *
 * The helper emits `funnel_step:entry` with `funnel: 'calculator'` once per
 * session when the user is on any calc URL — canonical, SEO variant, or
 * sibling calc tool. Idempotent via sessionStorage.
 *
 * The global setup (tests/setup.tsx) replaces `@/services/analytics` with a
 * caching-Proxy mock. We use `vi.importActual` to load the REAL module and
 * observe emitted events by mocking the downstream `posthog` capture (which
 * `log()` calls synchronously).
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// Intercept the synchronous PostHog capture path that `Analytics.log()`
// invokes for every event. Firebase Analytics is async + queued, so PostHog
// is the most reliable surface to assert against.
const captureEventMock = vi.fn();
vi.mock('@/services/posthog', () => ({
  captureEvent: captureEventMock,
  capturePageView: vi.fn(),
  identifyUser: vi.fn(),
}));

let fireCalcEntryIfNeeded: (path: string) => void;
let CALC_ROUTE_REGEX: RegExp;

beforeAll(async () => {
  const mod = await vi.importActual<typeof import('@/services/analytics')>(
    '@/services/analytics',
  );
  fireCalcEntryIfNeeded = mod.fireCalcEntryIfNeeded;
  CALC_ROUTE_REGEX = mod.CALC_ROUTE_REGEX;
});

const entryCalls = () =>
  captureEventMock.mock.calls.filter(([eventName]) => eventName === 'funnel_step');

describe('CALC_ROUTE_REGEX', () => {
  it.each([
    '/calcola-stipendio/',
    '/calcola-stipendio',
    '/calcola-stipendio/nuovi-frontalieri-oltre-20-km/',
    '/calcola-stipendio/stipendio-netto-80000-chf',
    '/calcola-stipendio/confronta-retribuzione-ral/',
    '/verifica-congedo-parentale',
    '/verifica-congedo-parentale/',
    '/calcola-previdenza',
    '/simula-busta-paga',
    // Locale-prefixed variants
    '/en/calculate-salary/',
    '/de/gehalt-berechnen/neue-grenzgaenger-ueber-20-km/',
    '/fr/calculer-salaire/',
    '/en/estimate-parental-leave',
    '/de/rente-berechnen',
    '/fr/simuler-fiche-de-paie',
  ])('matches calc route: %s', (path) => {
    expect(CALC_ROUTE_REGEX.test(path)).toBe(true);
  });

  it.each([
    '/',
    '/cerca-lavoro-ticino',
    '/compara-servizi',
    '/tasse-e-pensione',
    '/articoli-frontaliere/some-post',
    '/en/jobs',
    '/calcola-stipendio-extra', // similar but not under the calc family
  ])('rejects non-calc route: %s', (path) => {
    expect(CALC_ROUTE_REGEX.test(path)).toBe(false);
  });
});

describe('fireCalcEntryIfNeeded', () => {
  beforeEach(() => {
    sessionStorage.clear();
    captureEventMock.mockClear();
  });

  it('fires `funnel_step:entry` (funnel=calculator) once per session', () => {
    fireCalcEntryIfNeeded('/calcola-stipendio/');
    const calls = entryCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('funnel_step');
    expect(calls[0][1]).toMatchObject({
      step: 'entry',
      funnel: 'calculator',
      landing_path: '/calcola-stipendio/',
    });

    // Repeat — must NOT fire again
    fireCalcEntryIfNeeded('/calcola-stipendio/');
    fireCalcEntryIfNeeded('/verifica-congedo-parentale/');
    expect(entryCalls()).toHaveLength(1);
  });

  it('skips non-calc routes', () => {
    fireCalcEntryIfNeeded('/');
    fireCalcEntryIfNeeded('/cerca-lavoro-ticino');
    fireCalcEntryIfNeeded('/articoli-frontaliere');
    expect(entryCalls()).toHaveLength(0);
    // Did not poison the dedupe flag — a subsequent calc-route call still fires
    fireCalcEntryIfNeeded('/calcola-stipendio/');
    expect(entryCalls()).toHaveLength(1);
  });

  it('fires on SEO variants and sibling calc tools', () => {
    const variants = [
      '/calcola-stipendio/nuovi-frontalieri-oltre-20-km/',
      '/calcola-stipendio/stipendio-netto-80000-chf',
      '/verifica-congedo-parentale',
      '/calcola-previdenza',
    ];
    for (const v of variants) {
      sessionStorage.clear();
      captureEventMock.mockClear();
      fireCalcEntryIfNeeded(v);
      const calls = entryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({
        step: 'entry',
        funnel: 'calculator',
        landing_path: v,
      });
    }
  });

  it('strips query + hash before regex test', () => {
    fireCalcEntryIfNeeded('/calcola-stipendio/?tipo=NEW&zona=OVER_20KM#top');
    const calls = entryCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      step: 'entry',
      funnel: 'calculator',
      landing_path: '/calcola-stipendio/',
    });
  });

  it('survives sessionStorage throwing (private mode)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => fireCalcEntryIfNeeded('/calcola-stipendio/')).not.toThrow();
    expect(entryCalls()).toHaveLength(1);
    setItemSpy.mockRestore();
  });

  it('handles missing/empty path safely', () => {
    fireCalcEntryIfNeeded('');
    fireCalcEntryIfNeeded(undefined as unknown as string);
    fireCalcEntryIfNeeded(null as unknown as string);
    expect(entryCalls()).toHaveLength(0);
  });
});
