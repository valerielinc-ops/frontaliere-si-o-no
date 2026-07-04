import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POSTHOG_INIT_CONTENT } from '../../build-plugins/constants.ts';

/**
 * Issue #3406/#3407: POSTHOG_INIT_CONTENT (the plain-JS PostHog init snippet
 * externalised to every static SEO page — the dominant traffic surface) had
 * NO `before_send` benign-noise filter at all, unlike the SPA path
 * (services/posthog.ts). This left confirmed-benign exceptions ("Script
 * error.", third-party-only stacks) visible in the PostHog error monitor for
 * static pages while the SPA correctly dropped them — a sibling-drift bug
 * (AGENTS.md §Non-Negotiables #6) since PR #2733 (2026-06-22) added the
 * filter only to services/posthog-error-filter.ts.
 *
 * This test extracts the `before_send` function embedded in
 * POSTHOG_INIT_CONTENT (via `posthog.init(KEY, {...})` capture, since the
 * snippet stubs out a real `posthog` global) and exercises it directly,
 * mirroring tests/services/posthog-error-filter.test.ts's cases so the two
 * filters stay behaviourally aligned.
 */

interface CapturedInit {
  api_host?: string;
  before_send?: (event: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * POSTHOG_INIT_CONTENT is a bot-gated IIFE that installs the standard
 * PostHog stub loader (`window.posthog=e; e._i=[]; e.init=function(...){...
 * e._i.push([i,s,a])}`) and then calls the bare `posthog.init(KEY, opts)`.
 * Since jsdom's `window` IS the test's `globalThis` (same object, exactly
 * as in a real browser), running the snippet via `new Function(...)()` with
 * no params lets `window.posthog=e` and the later bare `posthog` reference
 * resolve to the SAME global — no fake window/document stub needed, unlike
 * an isolated `vm` sandbox. This mirrors tests/build-plugins/earlyBootSelfHeal.test.ts's
 * `new Function(SELF_HEAL_SCRIPT_CONTENT)()` pattern.
 */
function extractBeforeSend(): (event: unknown) => unknown {
  // Look like a real desktop Chrome so BOT_GATE_FN doesn't skip the init
  // (mirrors tests/bot-gate-parity.test.ts's "real browser" navigator setup).
  Object.defineProperty(window.navigator, 'webdriver', { configurable: true, get: () => false });
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => ['en-US', 'en'] });
  Object.defineProperty(window.navigator, 'plugins', { configurable: true, get: () => ({ length: 3 }) });
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    get: () => ({ query: () => Promise.resolve({ state: 'prompt' }) }),
  });
  if (!('chrome' in window)) Object.defineProperty(window, 'chrome', { configurable: true, value: {} });
  delete (window as unknown as { posthog?: unknown }).posthog;

  // The snippet's stub-loader inserts its <script> tag via
  // `getElementsByTagName('script')[0].parentNode.insertBefore(...)` —
  // needs at least one existing <script> in the document (as every real
  // page has, including this one), unlike a bare jsdom document.
  if (document.getElementsByTagName('script').length === 0) {
    document.head.appendChild(document.createElement('script'));
  }

  new Function(POSTHOG_INIT_CONTENT)();

  const captured = (window as unknown as { posthog?: { _i?: Array<[string, CapturedInit, string | undefined]> } }).posthog;
  const queued = captured?._i?.[0];
  const opts = queued?.[1];
  if (!opts?.before_send) {
    throw new Error('before_send not found in POSTHOG_INIT_CONTENT init call');
  }
  return opts.before_send as (event: unknown) => unknown;
}

describe('POSTHOG_INIT_CONTENT before_send (issue #3406/#3407)', () => {
  let beforeSend: (event: unknown) => unknown;

  beforeEach(() => {
    beforeSend = extractBeforeSend();
  });

  it('is valid, self-contained JS', () => {
    expect(() => new Function(POSTHOG_INIT_CONTENT)).not.toThrow();
  });

  it('passes through non-exception events unchanged', () => {
    const event = { event: '$pageview', properties: {} };
    expect(beforeSend(event)).toBe(event);
  });

  it('drops a benign "Script error." exception (#3406)', () => {
    const event = { event: '$exception', properties: { $exception_values: [{ type: 'Error', value: 'Script error.' }] } };
    expect(beforeSend(event)).toBeNull();
  });

  it('keeps a real first-party TypeError', () => {
    const event = { event: '$exception', properties: { $exception_values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'foo')" }] } };
    expect(beforeSend(event)).toBe(event);
  });

  it('keeps chunk-load $exceptions ("Importing a module script failed") so dashboards stay accurate', () => {
    const event = { event: '$exception', properties: { $exception_values: [{ type: 'TypeError', value: 'Importing a module script failed' }] } };
    expect(beforeSend(event)).toBe(event);
  });

  it('drops an exception whose entire resolved stack is Google Identity Services (#3407)', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'Error', value: 'oa' }],
        $exception_list: [
          {
            type: 'Error',
            value: 'oa',
            stacktrace: {
              frames: [
                { filename: 'https://accounts.google.com/gsi/client', lineno: 193, colno: 71 },
                { filename: 'https://accounts.google.com/gsi/client', lineno: 188, colno: 1 },
              ],
            },
          },
        ],
      },
    };
    expect(beforeSend(event)).toBeNull();
  });

  it('keeps an exception with a mixed first-party + third-party stack', () => {
    const event = {
      event: '$exception',
      properties: {
        $exception_values: [{ type: 'TypeError', value: 'oa' }],
        $exception_list: [
          {
            type: 'TypeError',
            value: 'oa',
            stacktrace: {
              frames: [
                { filename: 'https://accounts.google.com/gsi/client', lineno: 193, colno: 71 },
                { filename: 'https://frontaliereticino.ch/assets/index-entry.js', lineno: 12, colno: 4 },
              ],
            },
          },
        ],
      },
    };
    expect(beforeSend(event)).toBe(event);
  });

  it('fails open (returns the event) if the payload shape is unexpected', () => {
    const event = { event: '$exception', properties: { $exception_values: 'not-an-array' } };
    expect(beforeSend(event)).toBe(event);
  });

  it('fails open on a null/undefined event', () => {
    expect(beforeSend(null)).toBeNull();
    expect(beforeSend(undefined)).toBeNull();
  });
});
