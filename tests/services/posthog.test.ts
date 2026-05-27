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

import { vi, describe, it, expect, beforeEach, beforeAll } from 'vitest';

// Per-test-file mock of posthog-js so we can observe init/capture.
// ISOLATION NOTE: Use vi.importActual() instead of vi.unmock() to avoid
// permanently removing mocks from the shared module registry (isolate: false).
// vi.unmock() at module level persists across all test files in a worker.
const posthogMock = {
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
};

vi.mock('posthog-js', () => ({
  default: posthogMock,
}));

let posthogModule: typeof import('@/services/posthog');
let consentModule: typeof import('@/services/consentService');

beforeAll(async () => {
  posthogModule = await vi.importActual<typeof import('@/services/posthog')>('@/services/posthog');
  consentModule = await vi.importActual<typeof import('@/services/consentService')>('@/services/consentService');
});


beforeEach(() => {
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
    for (let i = 0; i < 20 && posthogMock.init.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

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
  });

  it('capturePageView() emits a $pageview event with $current_url + title', async () => {
    // First init so the internal singleton is populated.
    posthogModule.initPostHog();
    for (let i = 0; i < 20 && posthogMock.init.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    posthogModule.capturePageView('/test-path', 'Test Title');
    for (let i = 0; i < 20 && posthogMock.capture.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

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
    for (let i = 0; i < 20 && posthogMock.init.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    posthogModule.captureEvent('job_alert_created', { surface: 'inline_cta' });
    for (let i = 0; i < 20 && posthogMock.capture.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const match = posthogMock.capture.mock.calls.find(
      ([name]) => name === 'job_alert_created',
    );
    expect(match).toBeDefined();
    expect(match?.[1]).toMatchObject({ surface: 'inline_cta' });
  });
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
