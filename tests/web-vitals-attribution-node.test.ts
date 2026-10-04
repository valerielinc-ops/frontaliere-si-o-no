// @vitest-environment node
/**
 * `services/webVitalsAttribution.ts` exports the contract constants that the
 * GA4 reader under `scripts/` imports from a node process. Importing the module
 * must therefore not touch `document`/`window`: its `doc = document` default is
 * evaluated only when `buildCwvAttributionEvent` is called. The DOM behaviour
 * is pinned in tests/web-vitals-attribution.test.ts (jsdom).
 */
import { describe, expect, it } from 'vitest';

describe('webVitalsAttribution in a node environment', () => {
  it('imports without a DOM and exposes the contract constants', async () => {
    expect(typeof globalThis.document).toBe('undefined');
    const mod = await import('@/services/webVitalsAttribution');
    expect(mod.CWV_ATTRIBUTION_PAGE).toBe('web_vitals');
    expect([...mod.CWV_ATTRIBUTION_SECTIONS]).toEqual(['cls', 'inp']);
    expect([...mod.CWV_ATTRIBUTION_COMPONENTS]).toEqual(['footer', 'auto_ad', 'manual_ad', 'rail', 'job_gate', 'main', 'other']);
    expect([...mod.CWV_ATTRIBUTION_PARAM_KEYS]).toEqual(['page', 'section', 'component', 'action', 'cta_id', 'details']);
    expect(typeof mod.buildCwvAttributionEvent).toBe('function');
  });
});
