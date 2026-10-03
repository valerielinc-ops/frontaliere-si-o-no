// @vitest-environment jsdom
/**
 * CWV attribution on registered GA4 dimensions (issues 8868 and 9815).
 *
 * `web_vitals` carries `largest_shift_target` / `inp_target`, but GA4 cannot
 * read them: they are not registered dimensions and the property is at 50 of
 * 50 event-scoped dimensions. `services/webVitalsAttribution.ts` re-emits a
 * bounded summary of a non-good CLS/INP as `ui_interaction`, whose parameters
 * are already registered. This file pins:
 *  - the classifier and the `details` format on a real DOM;
 *  - that only CLS/INP that are not `good` produce an event;
 *  - that every emitted key is a REGISTERED dimension (literal list below, not
 *    imported from the module under test): a new key is the «parameter sent
 *    but unreadable» class that let the field CLS regression go unattributed;
 *  - the wiring in `services/webVitals.ts`, consent gate included.
 * The node-environment import check lives in
 * tests/web-vitals-attribution-node.test.ts (environment is per file).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CWV_ATTRIBUTION_COMPONENTS,
  CWV_ATTRIBUTION_PAGE,
  CWV_ATTRIBUTION_PARAM_KEYS,
  CWV_ATTRIBUTION_SECTIONS,
  buildCwvAttributionEvent,
  type CwvAttributionParams,
} from '@/services/webVitalsAttribution';
import { AUTO_AD_COLLAPSED_ATTR, AUTO_AD_CONTAINER_SELECTOR } from '@/services/autoAdCollapse';

// Event-scoped custom dimensions registered on GA4 property 524485296 for
// `ui_interaction` (displayName «UI Interaction …» / «Action Type»). Verified
// read-only on 2026-10-03 with:
//   GET https://analyticsadmin.googleapis.com/v1beta/properties/524485296/customDimensions?pageSize=200
//   (service account, scope analytics.readonly)
// Do NOT add a key here without registering it first: the property is at the
// 50-dimension cap, so an unregistered key is silently unreadable.
const REGISTERED_UI_INTERACTION_DIMENSIONS = ['page', 'section', 'component', 'action', 'cta_id', 'details'];

const mocks = vi.hoisted(() => ({
  granted: { value: true },
  log: vi.fn(),
  handlers: {} as Record<string, (metric: unknown) => void>,
}));

vi.mock('@/services/consentService', () => ({
  isAnalyticsGranted: () => mocks.granted.value,
}));
vi.mock('@/services/analytics', () => ({
  Analytics: { log: mocks.log },
}));
vi.mock('@/services/posthog', () => ({
  captureEvent: vi.fn(),
}));
vi.mock('web-vitals/attribution', () => ({
  onCLS: (cb: (m: unknown) => void) => { mocks.handlers.CLS = cb; },
  onLCP: (cb: (m: unknown) => void) => { mocks.handlers.LCP = cb; },
  onFCP: (cb: (m: unknown) => void) => { mocks.handlers.FCP = cb; },
  onTTFB: (cb: (m: unknown) => void) => { mocks.handlers.TTFB = cb; },
  onINP: (cb: (m: unknown) => void) => { mocks.handlers.INP = cb; },
}));

const AUTO_AD_CLASS = AUTO_AD_CONTAINER_SELECTOR.replace(/^\./, '');
const FOOTER_SELECTOR = 'footer.bg-surface-alt.mt-auto>div.mx-auto.max-w-7xl.px-4.py-10>div.grid.grid-cols-2.gap-8';

function autoAd(collapsed = false): string {
  return `<div class="${AUTO_AD_CLASS}"${collapsed ? ` ${AUTO_AD_COLLAPSED_ATTR}="1"` : ''}></div>`;
}

/** Job-board-like page: three Auto Ads containers in main (one collapsed). */
function mountPage(): void {
  document.body.innerHTML = `
    <main id="main-content">
      <div id="job-auth-gate"><button class="gate-cta">Accedi</button></div>
      <div class="ft-rail-grid-x"><aside class="rail-left"><span class="rail-item">x</span></aside></div>
      <section class="job-list"><article class="job-card">job</article></section>
      ${autoAd()}${autoAd(true)}${autoAd()}
      <ins class="adsbygoogle manual-slot"></ins>
    </main>
    <footer class="bg-surface-alt mt-auto">
      <div class="mx-auto max-w-7xl px-4 py-10"><div class="grid grid-cols-2 gap-8">links</div></div>
    </footer>
    <div class="outside-root">loose</div>`;
}

function cls(rating: string, attribution?: Record<string, unknown>) {
  return { name: 'CLS', value: 0.22, rating, id: 'v5-cls', navigationType: 'navigate', attribution };
}

function inp(rating: string, attribution?: Record<string, unknown>) {
  return { name: 'INP', value: 320, rating, id: 'v5-inp', navigationType: 'navigate', attribution };
}

function assertRegisteredShape(event: CwvAttributionParams | null): asserts event is CwvAttributionParams {
  expect(event).not.toBeNull();
  for (const key of Object.keys(event as object)) {
    expect(REGISTERED_UI_INTERACTION_DIMENSIONS).toContain(key);
  }
  expect(CWV_ATTRIBUTION_SECTIONS as readonly string[]).toContain(event!.section);
  expect(CWV_ATTRIBUTION_COMPONENTS as readonly string[]).toContain(event!.component);
  for (const value of Object.values(event as object)) {
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
    expect((value as string).length).toBeLessThanOrEqual(100);
  }
}

describe('buildCwvAttributionEvent', () => {
  beforeEach(mountPage);
  afterEach(() => { document.body.innerHTML = ''; });

  it('attributes a poor CLS on the footer with the Auto Ads census', () => {
    const event = buildCwvAttributionEvent(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    assertRegisteredShape(event);
    expect(event).toMatchObject({
      page: CWV_ATTRIBUTION_PAGE,
      section: 'cls',
      component: 'footer',
      action: 'complete',
      cta_id: `${CWV_ATTRIBUTION_PAGE}.cls.footer.complete`,
    });
    expect(event.details.endsWith('|ac3|cc1')).toBe(true);
    expect(event.details.startsWith(FOOTER_SELECTOR.slice(0, 70))).toBe(true);
  });

  it.each([
    ['div.google-auto-placed', 'auto_ad'],
    ['ins.adsbygoogle.manual-slot', 'manual_ad'],
    ['aside.rail-left>span.rail-item', 'rail'],
    ['#job-auth-gate>button.gate-cta', 'job_gate'],
    ['section.job-list>article.job-card', 'main'],
    ['div.outside-root', 'other'],
  ])('classifies %s as %s', (selector, component) => {
    const event = buildCwvAttributionEvent(cls('needs-improvement', { largestShiftTarget: selector, loadState: 'dom-content-loaded' }));
    assertRegisteredShape(event);
    expect(event.component).toBe(component);
  });

  it('returns null for good CLS/INP and for every other metric', () => {
    expect(buildCwvAttributionEvent(cls('good', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }))).toBeNull();
    expect(buildCwvAttributionEvent(inp('good', { interactionTarget: FOOTER_SELECTOR, interactionType: 'pointer' }))).toBeNull();
    for (const name of ['LCP', 'FCP', 'TTFB']) {
      expect(buildCwvAttributionEvent({ name, rating: 'poor', attribution: { target: FOOTER_SELECTOR } })).toBeNull();
    }
  });

  it('falls back to `other` on an invalid or unmatched selector without throwing', () => {
    for (const largestShiftTarget of ['###', 'div.never-rendered>span', '', undefined]) {
      const build = () => buildCwvAttributionEvent(cls('poor', { largestShiftTarget, loadState: 'complete' }));
      expect(build).not.toThrow();
      const event = build();
      assertRegisteredShape(event);
      expect(event.component).toBe('other');
    }
    const bare = buildCwvAttributionEvent(cls('poor'));
    assertRegisteredShape(bare);
    expect(bare).toMatchObject({ component: 'other', action: 'unknown' });
  });

  it('attributes an INP that needs improvement by interaction type', () => {
    const event = buildCwvAttributionEvent(inp('needs-improvement', { interactionTarget: '#job-auth-gate>button.gate-cta', interactionType: 'pointer' }));
    assertRegisteredShape(event);
    expect(event).toMatchObject({ section: 'inp', component: 'job_gate', action: 'pointer' });
  });

  it('keeps the action bounded when attribution carries an unexpected value', () => {
    const event = buildCwvAttributionEvent(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'Complete <script>' }));
    assertRegisteredShape(event);
    expect(event.action).toBe('unknown');
  });

  it('emits only registered GA4 dimensions', () => {
    expect([...CWV_ATTRIBUTION_PARAM_KEYS]).toEqual(REGISTERED_UI_INTERACTION_DIMENSIONS);
    const event = buildCwvAttributionEvent(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    expect(Object.keys(event!).sort()).toEqual([...REGISTERED_UI_INTERACTION_DIMENSIONS].sort());
  });
});

describe('webVitals wiring', () => {
  async function reportThrough(metric: unknown): Promise<void> {
    vi.resetModules();
    for (const key of Object.keys(mocks.handlers)) delete mocks.handlers[key];
    // tests/setup-common.tsx mocks the module globally; its dependencies still
    // resolve to the mocks registered in this file.
    const { initWebVitals } = await vi.importActual<typeof import('@/services/webVitals')>('@/services/webVitals');
    initWebVitals();
    await vi.waitFor(() => expect(mocks.handlers.CLS).toBeTypeOf('function'));
    const name = (metric as { name: string }).name;
    mocks.handlers[name](metric);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    mountPage();
    mocks.log.mockReset();
    mocks.granted.value = true;
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('logs ui_interaction next to web_vitals for a poor CLS', async () => {
    await reportThrough(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledWith('ui_interaction', expect.anything()));
    expect(mocks.log).toHaveBeenCalledWith('web_vitals', expect.objectContaining({ metric_name: 'CLS', largest_shift_target: FOOTER_SELECTOR }));
    const [, params] = mocks.log.mock.calls.find(([eventName]) => eventName === 'ui_interaction')!;
    expect(params).toMatchObject({ page: CWV_ATTRIBUTION_PAGE, section: 'cls', component: 'footer', action: 'complete' });
  });

  it('logs only web_vitals for a good CLS', async () => {
    await reportThrough(cls('good', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledWith('web_vitals', expect.anything()));
    await settle();
    expect(mocks.log.mock.calls.map(([eventName]) => eventName)).toEqual(['web_vitals']);
  });

  it('logs neither event without analytics consent', async () => {
    mocks.granted.value = false;
    await reportThrough(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    await settle();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
