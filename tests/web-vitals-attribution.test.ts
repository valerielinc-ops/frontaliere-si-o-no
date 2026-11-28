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
  INTERACTION_BUFFER_SIZE,
  INTERACTION_MATCH_TOLERANCE_MS,
  buildCwvAttributionEvent,
  getRecordedInteractions,
  recordInteraction,
  resetRecordedInteractions,
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
// Production footer classes (App.tsx). web-vitals 5.1 lib/getSelector.js joins
// the tag with the raw, SORTED classList and escapes nothing, so `md:pb-8`
// makes FOOTER_SELECTOR invalid CSS: querySelector cannot resolve it. This is the
// headline case of the CLS regression; classification must come from the
// node reference web-vitals also provides, not from this string.
const FOOTER_CLASSES = 'border-t border-edge bg-surface-alt py-8 pb-20 md:pb-8 mt-auto relative z-10';
const FOOTER_SELECTOR = `footer.${FOOTER_CLASSES.split(' ').sort().join('.')}`;

function autoAd(collapsed = false): string {
  return `<div class="${AUTO_AD_CLASS}"${collapsed ? ` ${AUTO_AD_COLLAPSED_ATTR}="1"` : ''}></div>`;
}

/** Job-board-like page: three Auto Ads containers in main (one collapsed). */
function mountPage(): void {
  document.body.innerHTML = `
    <div class="ft-rail-grid-x">
      <aside class="rail-left"><span class="rail-item">x</span></aside>
      <main id="main-content">
        <div id="job-auth-gate"><button class="gate-cta">Accedi</button></div>
        <section class="job-list"><article class="job-card">job</article></section>
        ${autoAd()}${autoAd(true)}${autoAd()}
        <ins class="adsbygoogle manual-slot"></ins>
      </main>
      <aside class="rail-right"><span class="rail-item-r">y</span></aside>
    </div>
    <footer class="${FOOTER_CLASSES}">
      <div class="mx-auto max-w-7xl px-4 py-10"><div class="grid grid-cols-2 gap-8">links</div></div>
    </footer>
    <div class="outside-root">loose</div>`;
}

function footerNode(): Element {
  return document.querySelector('footer')!;
}

/** CLS attribution as web-vitals reports it: selector string plus node reference. */
function footerShift(loadState = 'complete'): Record<string, unknown> {
  return { largestShiftTarget: FOOTER_SELECTOR, largestShiftSource: { node: footerNode() }, loadState };
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
    const event = buildCwvAttributionEvent(cls('poor', footerShift()));
    assertRegisteredShape(event);
    expect(event).toMatchObject({
      page: CWV_ATTRIBUTION_PAGE,
      section: 'cls',
      component: 'footer',
      action: 'complete',
      cta_id: `${CWV_ATTRIBUTION_PAGE}.cls.footer.complete`,
    });
    expect(event.details.endsWith('|ac3|cc1')).toBe(true);
    expect(event.details.startsWith('cwv:cls:footer:complete:footer.')).toBe(true);
  });

  it('the production footer selector is not valid CSS, so the node reference decides', () => {
    // Chrome throws a SyntaxError; jsdom may throw or match nothing. Either way
    // the string alone cannot find the footer.
    let resolved: Element | null = null;
    try { resolved = document.querySelector(FOOTER_SELECTOR); } catch { resolved = null; }
    expect(resolved).toBeNull();
    const bySelectorOnly = buildCwvAttributionEvent(cls('poor', { largestShiftTarget: FOOTER_SELECTOR, loadState: 'complete' }));
    assertRegisteredShape(bySelectorOnly);
    // Issue 20410: the raw string stays invalid CSS (asserted above), but the
    // fallback now retries once with CSS-escaped Tailwind tokens.
    expect(bySelectorOnly.component).toBe('footer');
    const byNode = buildCwvAttributionEvent(cls('poor', footerShift()));
    assertRegisteredShape(byNode);
    expect(byNode.component).toBe('footer');
  });

  it('classifies from the node even when the selector points elsewhere', () => {
    const textNode = document.querySelector('footer .grid')!.firstChild!;
    const event = buildCwvAttributionEvent(cls('poor', {
      largestShiftTarget: 'section.job-list>article.job-card',
      largestShiftSource: { node: textNode },
      loadState: 'complete',
    }));
    assertRegisteredShape(event);
    expect(event.component).toBe('footer');
  });

  it('keeps the best available INP target across all processed event entries', () => {
    const event = buildCwvAttributionEvent(inp('poor', {
      interactionTarget: '#job-auth-gate>button.gate-cta',
      interactionType: 'pointer',
      processedEventEntries: [
        { target: null },
        { target: document.querySelector('.outside-root') },
        { target: document.querySelector('#job-auth-gate button') },
      ],
    }));
    assertRegisteredShape(event);
    expect(event).toMatchObject({ section: 'inp', component: 'job_gate', action: 'pointer' });
  });

  it('emits an explicit unknown INP target when the browser exposes none', () => {
    const event = buildCwvAttributionEvent(inp('poor', {
      interactionType: 'pointer',
      processedEventEntries: [{ target: null }, {}],
    }));
    assertRegisteredShape(event);
    expect(event).toMatchObject({ section: 'inp', component: 'unknown', action: 'pointer' });
    expect(event.details).toBe('cwv:inp:unknown:pointer:unknown|ac3|cc1');
  });

  // Without a node reference the selector is the fallback.
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

  // Production hierarchy: grid wrapper > aside + main. Main targets must not be
  // swallowed by the wrapper (the bug: every main target classified `rail`).
  it('classifies main descendants as main and only the aside rails as rail, by node reference', () => {
    const componentOf = (sel: string) => {
      const event = buildCwvAttributionEvent(cls('poor', { largestShiftSource: { node: document.querySelector(sel) }, loadState: 'complete' }));
      assertRegisteredShape(event);
      return event.component;
    };
    expect(componentOf('#main-content')).toBe('main');
    expect(componentOf('.job-card')).toBe('main');
    expect(componentOf('.job-list')).toBe('main');
    expect(componentOf('.rail-left')).toBe('rail');
    expect(componentOf('.rail-item')).toBe('rail');
    expect(componentOf('.rail-right')).toBe('rail');
    expect(componentOf('.ft-rail-grid-x')).toBe('rail');
    expect(componentOf('.rail-left')).not.toBe(componentOf('#main-content'));
  });

  it('keeps the static SEO main classified as main, inside or outside the rail grid', () => {
    document.body.innerHTML = `
      <div class="ft-rail-grid"><main class="seo-static-content"><h1 class="static-h1">t</h1></main></div>
      <main class="cluster-seo-prose"><p class="prose-p">p</p></main>
      <main class="seo-static-content"><p class="bare-p">p</p></main>`;
    for (const sel of ['.static-h1', '.prose-p', '.bare-p']) {
      const event = buildCwvAttributionEvent(cls('poor', { largestShiftSource: { node: document.querySelector(sel) }, loadState: 'complete' }));
      assertRegisteredShape(event);
      expect(event.component).toBe('main');
    }
  });

  it('returns null for good CLS/INP and for every other metric', () => {
    expect(buildCwvAttributionEvent(cls('good', footerShift()))).toBeNull();
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
    const event = buildCwvAttributionEvent(cls('poor', footerShift('Complete <script>')));
    assertRegisteredShape(event);
    expect(event.action).toBe('unknown');
  });

  it('emits only registered GA4 dimensions', () => {
    expect([...CWV_ATTRIBUTION_PARAM_KEYS]).toEqual(REGISTERED_UI_INTERACTION_DIMENSIONS);
    const event = buildCwvAttributionEvent(cls('poor', footerShift()));
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
    await reportThrough(cls('poor', footerShift()));
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledWith('ui_interaction', expect.anything()));
    expect(mocks.log).toHaveBeenCalledWith('web_vitals', expect.objectContaining({ metric_name: 'CLS', largest_shift_target: FOOTER_SELECTOR }));
    const [, vitals] = mocks.log.mock.calls.find(([eventName]) => eventName === 'web_vitals')!;
    const [, params] = mocks.log.mock.calls.find(([eventName]) => eventName === 'ui_interaction')!;
    expect(params).toMatchObject({ page: CWV_ATTRIBUTION_PAGE, section: 'cls', component: 'footer', action: 'complete' });
    // Explicit page_path, equal to web_vitals', so the two events join on the same page.
    expect(params.page_path).toBe(vitals.page_path);
  });

  it('logs only web_vitals for a good CLS', async () => {
    await reportThrough(cls('good', footerShift()));
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledWith('web_vitals', expect.anything()));
    await settle();
    expect(mocks.log.mock.calls.map(([eventName]) => eventName)).toEqual(['web_vitals']);
  });

  it('logs neither event without analytics consent', async () => {
    mocks.granted.value = false;
    await reportThrough(cls('poor', footerShift()));
    await settle();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});

describe('INP target captured at interaction time (issue 20410)', () => {
  beforeEach(() => { mountPage(); resetRecordedInteractions(); });
  afterEach(() => { document.body.innerHTML = ''; resetRecordedInteractions(); });

  const card = () => document.querySelector('.job-card')!;
  const emptyTargetInp = (interactionTime: number, extra: Record<string, unknown> = {}) => inp('poor', {
    interactionTarget: '',
    interactionTime,
    interactionType: 'pointer',
    processedEventEntries: [{ target: null, startTime: interactionTime }],
    ...extra,
  });

  it('keeps unknown only when nothing was recorded', () => {
    const event = buildCwvAttributionEvent(emptyTargetInp(1000));
    expect(event).toMatchObject({ component: 'unknown' });
    expect(event!.details).toContain(':unknown|');
  });

  it('classifies a null entry.target from the buffer entry closest to interactionTime', () => {
    recordInteraction({ target: footerNode(), timeStamp: 400 }, '/cerca-lavoro-ticino/');
    recordInteraction({ target: card(), timeStamp: 1000 }, '/cerca-lavoro-ticino/');
    const node = card();
    node.remove(); // the list re-rendered: the node is gone at report time
    const event = buildCwvAttributionEvent(emptyTargetInp(1010));
    expect(event).toMatchObject({ section: 'inp', component: 'main', action: 'pointer' });
    expect(event!.details).toContain('article.job-card');
    expect(event!.cta_id).toBe('web_vitals.inp.main.pointer');
  });

  it('does not borrow an interaction outside the tolerance', () => {
    recordInteraction({ target: card(), timeStamp: 1000 });
    const far = emptyTargetInp(1000 + INTERACTION_MATCH_TOLERANCE_MS + 1);
    expect(buildCwvAttributionEvent(far)).toMatchObject({ component: 'unknown' });
    expect(buildCwvAttributionEvent(emptyTargetInp(1000 + INTERACTION_MATCH_TOLERANCE_MS))).toMatchObject({ component: 'main' });
  });

  it('falls back to the first processed entry start when interactionTime is missing', () => {
    recordInteraction({ target: footerNode(), timeStamp: 2000 });
    const event = buildCwvAttributionEvent(inp('poor', {
      interactionTarget: '',
      processedEventEntries: [{ target: null, startTime: 2003 }],
    }));
    expect(event).toMatchObject({ component: 'footer' });
  });

  it('uses interactionTargetElement.deref() as second fallback', () => {
    const event = buildCwvAttributionEvent(emptyTargetInp(5000, { interactionTargetElement: { deref: () => footerNode() } }));
    expect(event).toMatchObject({ component: 'footer' });
    expect(event!.details).toContain('footer');
  });

  it('keeps web-vitals own selector when present', () => {
    recordInteraction({ target: footerNode(), timeStamp: 1000 });
    const event = buildCwvAttributionEvent(inp('poor', { interactionTarget: 'div#x', interactionTime: 1000, processedEventEntries: [{ target: card() }] }));
    expect(event!.details).toContain('div#x');
    expect(event!.component).toBe('main');
  });

  it('retries a Tailwind selector with CSS escapes', () => {
    document.body.insertAdjacentHTML('beforeend', '<footer><button class="md:pb-8">x</button></footer>');
    const event = buildCwvAttributionEvent(inp('poor', { interactionTarget: 'button.md:pb-8', processedEventEntries: [] }));
    expect(event).toMatchObject({ component: 'footer' });
  });

  it('listener work is bounded: ring buffer, no throw on junk, no document queries', () => {
    const target = card();
    const spy = vi.spyOn(document, 'querySelector');
    const spyAll = vi.spyOn(document, 'querySelectorAll');
    for (let i = 0; i < INTERACTION_BUFFER_SIZE * 50; i += 1) recordInteraction({ target, timeStamp: i });
    recordInteraction({ target: null, timeStamp: 1 });
    recordInteraction({ target });
    recordInteraction({} as never);
    expect(getRecordedInteractions()).toHaveLength(INTERACTION_BUFFER_SIZE);
    expect(getRecordedInteractions().at(-1)!.timeStamp).toBe(INTERACTION_BUFFER_SIZE * 50 - 1);
    expect(spy).not.toHaveBeenCalled();
    expect(spyAll).not.toHaveBeenCalled();
    spy.mockRestore();
    spyAll.mockRestore();
  });

  it('initWebVitals installs passive capture listeners for pointerdown, keydown and click', async () => {
    vi.resetModules();
    const add = vi.spyOn(document, 'addEventListener');
    const { initWebVitals } = await vi.importActual<typeof import('@/services/webVitals')>('@/services/webVitals');
    initWebVitals();
    const registered = add.mock.calls.filter(([, , opts]) => (opts as AddEventListenerOptions | undefined)?.capture === true);
    expect(registered.map(([type]) => type).sort()).toEqual(['click', 'keydown', 'pointerdown']);
    for (const [, , opts] of registered) expect((opts as AddEventListenerOptions).passive).toBe(true);
    add.mockRestore();
  });
});
