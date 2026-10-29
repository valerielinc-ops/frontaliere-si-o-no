// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
/**
 * Smoke tests for services/posthog.ts
 *
 * Context: A HogQL query showed PostHog events starting only from 2026-04-12.
 * Root cause: PostHog was added to the codebase on 2026-04-12 (commit 4f4b74049).
 * The gap is expected — it's the tracking baseline, not a bug.
 *
 * These tests protect against regressions:
 * - PostHog initializes on app boot (non-blocking, async)
 * - Uses the first-party reverse proxy (ad-blocker resilience)
 * - `$pageview` events are captured via capturePageView
 * - Consent is silent (no popup / banner) — analytics granted by default
 *
 * The global mock in tests/setup.tsx stubs @/services/posthog, so we unmock
 * and dynamically import the real module. posthog-js itself is mocked at the
 * module level to capture init/capture calls without touching the network.
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';

// Per-test-file mock of posthog-js so we can observe init/capture.
// ISOLATION NOTE: Use vi.importActual() instead of vi.unmock() to avoid
// permanently removing mocks from the shared module registry (isolate: false).
// vi.unmock() at module level persists across all test files in a worker.
// The module keeps a singleton, so only the first test that boots it sees
// `init` in `mock.calls` (beforeEach clears them). The implementation survives
// mockClear(), so the options of the one real init stay readable here.
let lastInitOptions: Record<string, any> | undefined;
const posthogMock = {
  init: vi.fn((_key: string, options: Record<string, any>) => { lastInitOptions = options; }),
  capture: vi.fn(),
  identify: vi.fn(),
};

vi.mock('posthog-js', () => ({
  default: posthogMock,
}));

let posthogModule: typeof import('@/services/posthog');
let consentModule: typeof import('@/services/consentService');

function setProductionHostname(): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname: 'frontaliereticino.ch' },
  });
}

// Poll for the async dynamic import + IIFE inside ensurePostHog() to settle.
// Uses a real per-tick delay (not setTimeout(0)): under full-suite parallel
// load a starved event loop can burn 20 zero-delay ticks before the
// `await import('posthog-js')` promise chain resolves, leaving init/capture
// uncalled and failing the assertion spuriously. ~1 s ceiling (200 × 5 ms)
// comfortably covers a slow import without changing what is asserted.
async function waitFor(predicate: () => boolean, tries = 200, delayMs = 5): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

beforeAll(async () => {
  posthogModule = await vi.importActual<typeof import('@/services/posthog')>('@/services/posthog');
  consentModule = await vi.importActual<typeof import('@/services/consentService')>('@/services/consentService');
});


beforeEach(() => {
  // jsdom defaults to localhost; the smoke tests exercise the production
  // startup path explicitly because local development must now be inert.
  setProductionHostname();
  posthogMock.init.mockClear();
  posthogMock.capture.mockClear();
  posthogMock.identify.mockClear();
  // Ensure clean localStorage between tests
  try { localStorage.clear(); } catch { /* jsdom quota ignored */ }
});

describe('PostHog smoke tests', () => {
  it('initPostHog() calls posthog.init with the EU reverse proxy host', async () => {
    posthogModule.initPostHog();

    // ensurePostHog() performs a dynamic import + async IIFE; poll for resolution.
    await waitFor(() => posthogMock.init.mock.calls.length > 0);

    // Module-level singleton may short-circuit in later tests; assert at least once.
    expect(posthogMock.init).toHaveBeenCalled();
    const [key, opts] = posthogMock.init.mock.calls[0];

    // Key must be present (baseline — not a secret, already public in client bundle).
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);

    // First-party proxy — critical for ad-blocker resilience.
    // Hardcoding 't.frontaliereticino.ch' protects against regression to eu.i.posthog.com.
    expect(opts.api_host).toBe('https://t.frontaliereticino.ch');

    // Pageviews handled manually via analytics.ts (avoid double-capture in SPA).
    expect(opts.capture_pageview).toBe(false);

    // Autocapture disabled — explicit events only.
    expect(opts.autocapture).toBe(false);

    // Quota controls: replay is capped locally and analytics sampling is
    // installed as a third before_send hook after URL privacy and benign-error filtering.
    expect(opts.session_recording.sampleRate).toBe(0.05);
    expect(Array.isArray(opts.before_send)).toBe(true);
    expect(opts.before_send).toHaveLength(3);
  });

  it('lets the SPA $pageview through the whole before_send chain (no page view reached PostHog from 2026-09-16)', async () => {
    // Observer for the regression of PR 8752: the zero analytics sample rate
    // also dropped $pageview, so the SDK captured page views that before_send
    // then discarded. Run the event through every hook the init installs, in
    // order, exactly as posthog-js does; a null at any step = lost page view.
    posthogModule.initPostHog();
    await waitFor(() => lastInitOptions !== undefined);
    const hooks = lastInitOptions?.before_send as Array<(event: unknown) => unknown>;
    expect(Array.isArray(hooks)).toBe(true);
    const run = (event: unknown) => hooks.reduce<unknown>((acc, hook) => (acc ? hook(acc) : acc), event);

    const pageview = { event: '$pageview', properties: { $session_id: 'spa-session', $pathname: '/calcolatore/' } };
    expect(run(pageview)).toEqual(pageview);
    // Ordinary product events stay behind the quota hard stop.
    expect(run({ event: 'funnel_step', properties: { $session_id: 'spa-session' } })).toBeNull();
  });

  it('capturePageView() emits a $pageview event with $current_url + title', async () => {
    // First init so the internal singleton is populated.
    posthogModule.initPostHog();
    await waitFor(() => posthogMock.init.mock.calls.length > 0);

    posthogModule.capturePageView('/test-path', 'Test Title');
    await waitFor(() => posthogMock.capture.mock.calls.length > 0);

    const pageviewCalls = posthogMock.capture.mock.calls.filter(
      ([eventName]) => eventName === '$pageview',
    );
    expect(pageviewCalls.length).toBeGreaterThanOrEqual(1);

    const [, props] = pageviewCalls[0];
    expect(props.$current_url).toContain('/test-path');
    expect(props.title).toBe('Test Title');
  });

  it('captureEvent() forwards arbitrary events with properties', async () => {
    posthogModule.initPostHog();
    await waitFor(() => posthogMock.init.mock.calls.length > 0);

    posthogModule.captureEvent('job_alert_created', { surface: 'inline_cta' });
    await waitFor(() => posthogMock.capture.mock.calls.length > 0);

    const match = posthogMock.capture.mock.calls.find(
      ([name]) => name === 'job_alert_created',
    );
    expect(match).toBeDefined();
    expect(match?.[1]).toMatchObject({ surface: 'inline_cta' });
  });
});

describe('Local dev host gate', () => {
  const realLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it.each(['http://localhost:3000/', 'http://127.0.0.1:4173/', 'http://[::1]:3000/'])(
    'never initializes PostHog on %s',
    async (url) => {
      Object.defineProperty(window, 'location', { configurable: true, value: new URL(url) });
      vi.resetModules();
      const localModule = await vi.importActual<typeof import('@/services/posthog')>('@/services/posthog');

      localModule.initPostHog();
      localModule.captureEvent('job_alert_created');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(posthogMock.init).not.toHaveBeenCalled();
      expect(posthogMock.capture).not.toHaveBeenCalled();
    },
  );
});

describe('Silent consent guarantee', () => {
  it('setDefaultConsent() grants analytics without any banner / popup', () => {
    // No stored preference → defaults to granted.
    consentModule.setDefaultConsent();

    const state = consentModule.getConsent();
    expect(state).not.toBeNull();
    expect(state?.analytics).toBe(true);
    expect(state?.advertising).toBe(true);

    // Nothing in the DOM should reference a consent banner component
    // (CookieBanner was removed in the silent-consent migration).
    expect(document.querySelector('[data-testid="cookie-banner"]')).toBeNull();
    expect(document.querySelector('[data-testid="consent-popup"]')).toBeNull();
  });

  it('isAnalyticsGranted() returns true after silent default', () => {
    consentModule.setDefaultConsent();
    expect(consentModule.isAnalyticsGranted()).toBe(true);
  });
});

describe('PostHog email URL privacy', () => {
 it('filters SDK-added URLs before sending pageleave events', async () => {
  posthogModule.initPostHog();
  await waitFor(() => Boolean(lastInitOptions));
  const event = { event: '$pageleave', $set: { $referrer: 'https://frontaliereticino.ch/?authToken=secret&utm_source=email' }, $set_once: { $initial_current_url: 'https://frontaliereticino.ch/?ac=secret&utm_source=email' }, properties: {
   $current_url: 'https://frontaliereticino.ch/?ac=secret&ne=candidate%40example.test&utm_medium=email',
   $initial_current_url: 'https://frontaliereticino.ch/?authToken=secret&utm_medium=email',
  } };
  const result = lastInitOptions!.before_send.reduce((value: unknown, filter: (event: unknown) => unknown) => value && filter(value), event);
  expect(result).toBe(event);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('candidate');
  expect(event.properties.$current_url).toContain('utm_medium=email');
 });
});
