/**
 * `ad_page_diag` — the per-page ad diagnosis has two runtimes that must agree:
 * services/adPageDiag.ts (SPA) and its ES5 twin AD_PAGE_DIAG_FN
 * (build-plugins/shared/adPageDiagInline.ts) carried by the static AdSense
 * loader. This file pins:
 *  - classifier parity: classifyAdPageTemplate ≡ AD_PAGE_TEMPLATE_INLINE_FN on a
 *    path matrix, plus the expected bucket of each path;
 *  - collector parity: both snapshots of the same DOM/window are identical;
 *  - once per page view (timer, hidden, pagehide, route change, loader → SPA
 *    hand-off) for both runtimes;
 *  - that the generated loader carries the emission before its early returns;
 *  - that every parameter is registered in GA4 by the setup script's list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ADSENSE_LOADER_CONTENT, BOT_GATE_FN } from '@/build-plugins/constants';
import { AD_PAGE_DIAG_FN } from '@/build-plugins/shared/adPageDiagInline';
import {
  AD_PAGE_DIAG_DELAY_MS,
  AD_PAGE_DIAG_EVENT,
  collectAdPageDiag,
  startAdPageDiag,
  type AdPageDiagHandle,
  type AdPageDiagParams,
} from '@/services/adPageDiag';
import {
  AD_PAGE_TEMPLATE_INLINE_FN,
  classifyAdPageTemplate,
  type AdPageTemplate,
} from '@/services/adPageTemplate';
import { ADS_CONSENT_CHANGE_EVENT, ADS_CONSENT_STORAGE_KEY } from '@/services/adsConsent';
import { AD_BANNER_STATE_ATTR } from '@/services/adsenseSlots';
import { useAdPageDiag } from '@/hooks/useAdPageDiag';
import { SEO_TRACKING_PUSH_EVENT } from '@/hooks/useSeoPageTracking';
import {
  AD_PAGE_DIAG_GA4_CUSTOM_DIMENSIONS,
  AD_PAGE_DIAG_GA4_CUSTOM_METRICS,
  AD_PAGE_DIAG_GA4_SHARED_DIMENSIONS,
} from '../scripts/lib/ga4-ad-page-diag-definitions.mjs';

type DiagWindow = Window & {
  __ftAdDiag?: AdPageDiagHandle;
  gtag?: (...args: unknown[]) => void;
  adsbygoogle?: unknown;
  googlefc?: unknown;
  __tcfapi?: unknown;
  __ftOfferwallGate?: unknown;
  __ftAdBlock?: unknown;
};
const w = window as DiagWindow;

// eslint-disable-next-line no-new-func
const inlineClassify = new Function(`return (${AD_PAGE_TEMPLATE_INLINE_FN});`)() as (p: string, d: Document) => AdPageTemplate;
// eslint-disable-next-line no-new-func
const inlineStart = new Function(`return (${AD_PAGE_DIAG_FN});`)() as (isBot: () => boolean) => void;

const JOB_POSTING_LD = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"x"}</script>';

const handles: AdPageDiagHandle[] = [];
let gtag: ReturnType<typeof vi.fn>;

function setPath(path: string): void {
  window.history.replaceState({}, '', path);
}

function runInline(isBot: () => boolean = () => false): AdPageDiagHandle {
  delete w.__ftAdDiag;
  inlineStart(isBot);
  handles.push(w.__ftAdDiag!);
  return w.__ftAdDiag!;
}

function runTs(isBot: () => boolean = () => false): AdPageDiagHandle {
  delete w.__ftAdDiag;
  startAdPageDiag(window.location.pathname, { isBot });
  handles.push(w.__ftAdDiag!);
  return w.__ftAdDiag!;
}

function diagCalls(): AdPageDiagParams[] {
  return gtag.mock.calls
    .filter((call) => call[0] === 'event' && call[1] === AD_PAGE_DIAG_EVENT)
    .map((call) => call[2] as AdPageDiagParams);
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  gtag = vi.fn();
  w.gtag = gtag;
  document.body.innerHTML = '';
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((el) => el.remove());
  window.localStorage.clear();
  setVisibility('visible');
  setPath('/');
  delete w.__ftAdDiag;
  delete w.adsbygoogle;
  delete w.googlefc;
  delete w.__tcfapi;
  delete w.__ftOfferwallGate;
  delete w.__ftAdBlock;
});

afterEach(() => {
  for (const h of handles.splice(0)) {
    try {
      h.flush(0);
    } catch {
      /* already closed */
    }
  }
  vi.useRealTimers();
});

describe('page-template classifier parity (TS ≡ inline)', () => {
  const cases: ReadonlyArray<readonly [string, boolean, AdPageTemplate]> = [
    ['/', false, 'home'],
    ['/en/', false, 'home'],
    ['/de', false, 'home'],
    ['/cerca-lavoro-ticino/', false, 'jobboard_hub'],
    ['/cerca-lavoro-ticino', false, 'jobboard_hub'],
    ['/cerca-lavoro-argovia/', false, 'jobboard_hub'],
    ['/en/find-jobs-geneva/', false, 'jobboard_hub'],
    ['/fr/trouver-emploi-vaud/', false, 'jobboard_hub'],
    ['/cerca-lavoro-ticino/lugano/', false, 'jobboard_ticino'],
    ['/cerca-lavoro-ticino/azienda-migros/', false, 'jobboard_ticino'],
    ['/cerca-lavoro-ticino/impiegato-contabile-lugano-4f2a/', true, 'job_detail'],
    ['/cerca-lavoro-ticino/impiegato-contabile-lugano-4f2a/', false, 'jobboard_ticino'],
    ['/cerca-lavoro-vaud/infermieri/', false, 'jobboard_canton_it'],
    ['/cerca-lavoro-svizzera/ricerca-infermiere/', false, 'jobboard_canton_it'],
    ['/cerca-lavoro-vaud/infermiere-losanna-9c1/', true, 'job_detail'],
    ['/en/find-jobs-ticino/nurse-lugano/', false, 'jobboard_locale'],
    ['/en/find-jobs-ticino/nurse-lugano/', true, 'job_detail'],
    ['/de/jobs-im-tessin/lugano/', false, 'jobboard_locale'],
    ['/de/jobs-in-der-waadt/pflege/', false, 'jobboard_locale'],
    ['/lavoro-ticino-infermiere/', false, 'role_landing'],
    ['/en/jobs-ticino-nurse/', false, 'role_landing'],
    ['/de/arbeit-tessin-krankenpfleger/', false, 'role_landing'],
    ['/lavoro-lugano-cuoco/', false, 'role_landing'],
    ['/aziende/migros/', false, 'company'],
    ['/en/aziende/migros/', false, 'company'],
    ['/aziende-svizzera-italiana/', false, 'company'],
    ['/articoli-frontaliere/permesso-g-2026/', false, 'article'],
    ['/en/cross-border-articles/g-permit/', false, 'article'],
    ['/prezzi-diesel/oggi/', false, 'fuel'],
    ['/de/dieselpreis-schweiz/heute/', false, 'fuel'],
    ['/prezzi-benzina-confine/', false, 'fuel'],
    ['/calcola-stipendio/', false, 'tool'],
    ['/compara-servizi/confronta-banche/', false, 'tool'],
    ['/en/calculate-salary/', false, 'tool'],
    ['/simula-busta-paga/', false, 'tool'],
    ['/statistiche/', false, 'other'],
    ['/blog/cerca-lavoro-ticino/', false, 'other'],
    ['/en/jobs-industry/', false, 'other'],
  ];

  it.each(cases)('%s (JobPosting=%s) → %s', (path, hasJobPosting, expected) => {
    document.head.innerHTML = hasJobPosting ? JOB_POSTING_LD : '';
    expect(classifyAdPageTemplate(path, hasJobPosting)).toBe(expected);
    expect(inlineClassify(path, document)).toBe(expected);
  });
});

describe('collector parity (TS ≡ inline)', () => {
  function jobDetailFixture(): void {
    setPath('/cerca-lavoro-ticino/impiegato-contabile-lugano-4f2a/');
    document.head.innerHTML = JOB_POSTING_LD;
    document.body.innerHTML = [
      '<ins class="adsbygoogle" data-ad-slot="1" data-ad-status="filled"></ins>',
      '<ins class="adsbygoogle" data-ad-slot="2" data-ad-status="unfilled" data-ft-static-ad-collapsed=""></ins>',
      '<ins class="adsbygoogle" data-ad-slot="3"></ins>',
      `<div ${AD_BANNER_STATE_ATTR}="collapsed"><ins class="adsbygoogle" data-ad-slot="4" data-ad-status="unfilled"></ins></div>`,
      '<div class="google-auto-placed"><ins class="adsbygoogle" data-ad-status="filled"></ins></div>',
      '<div class="google-auto-placed"><ins class="adsbygoogle" data-ad-slot="9" data-ad-status="filled"></ins></div>',
      '<ins class="adsbygoogle adsbygoogle-noablate" data-anchor-status="displayed" data-ad-status="filled"></ins>',
      '<ins class="adsbygoogle adsbygoogle-noablate" data-vignette-loaded="true" data-ad-status="filled"></ins>',
      '<div class="fc-consent-root"></div>',
    ].join('');
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
    w.adsbygoogle = { loaded: true, push: () => undefined };
    w.googlefc = { getAdBlockerStatus: () => 1 };
    w.__ftOfferwallGate = { state: 'held', release: () => true };
    w.__ftAdBlock = { blocked: false };
  }

  it('reports the full job-detail snapshot identically', () => {
    jobDetailFixture();
    const expected: AdPageDiagParams = {
      page_template: 'job_detail',
      consent_state: 'granted',
      ad_path: 'loaded',
      adsbygoogle_loaded: 1,
      fc_loaded: 1,
      gate_status: 'held',
      slots_total: 4,
      slots_filled: 1,
      slots_unfilled: 2,
      slots_collapsed: 2,
      anchor_status: 'displayed',
      vignette_ready: 1,
      auto_placed: 2,
      first_fill_ms: -1,
      cmp_shown: 1,
      ad_blocked: 0,
      diag_hidden: 0,
    };
    expect(runTs().collect(0)).toEqual(expected);
    expect(runInline().collect(0)).toEqual(expected);
  });

  const states: ReadonlyArray<readonly [string, () => void, boolean, Partial<AdPageDiagParams>]> = [
    ['no consent decision', () => {}, false, { ad_path: 'waiting_consent', consent_state: 'none', gate_status: 'absent' }],
    ['denied still serves (Limited Ads)', () => window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'denied'), false, { ad_path: 'loaded', consent_state: 'denied' }],
    ['no-ads entitlement wins over the bot gate', () => window.localStorage.setItem('reader_noads_active', 'true'), true, { ad_path: 'noads_entitlement' }],
    ['bot gate', () => window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted'), true, { ad_path: 'bot_gated', consent_state: 'granted' }],
    ['plain queue array = script not loaded', () => { w.adsbygoogle = []; }, false, { adsbygoogle_loaded: 0 }],
    ['library push = script loaded', () => { const q: unknown[] = []; (q as unknown as { push: unknown }).push = () => 0; w.adsbygoogle = q; }, false, { adsbygoogle_loaded: 1 }],
    ['TCF API alone = Funding Choices loaded', () => { w.__tcfapi = () => undefined; }, false, { fc_loaded: 1 }],
    ['bridge-only googlefc = not loaded', () => { w.googlefc = { callbackQueue: [] }; }, false, { fc_loaded: 0 }],
    ['held without release reads absent', () => { w.__ftOfferwallGate = { state: 'held' }; }, false, { gate_status: 'absent' }],
    ['idle reads absent', () => { w.__ftOfferwallGate = { state: 'idle' }; }, false, { gate_status: 'absent' }],
    ['off_board', () => { w.__ftOfferwallGate = { state: 'off_board' }; }, false, { gate_status: 'off_board' }],
    ['ad blocker', () => { w.__ftAdBlock = { blocked: true }; }, false, { ad_blocked: 1 }],
    ['anchor status is sanitised', () => { document.body.innerHTML = '<ins data-anchor-status="Ready To Display!"></ins>'; }, false, { anchor_status: 'readytodisplay' }],
  ];

  it.each(states)('%s', (_name, arrange, bot, expected) => {
    setPath('/cerca-lavoro-ticino/');
    arrange();
    const ts = runTs(() => bot).collect(1);
    const inline = runInline(() => bot).collect(1);
    expect(inline).toEqual(ts);
    expect(ts).toMatchObject({ ...expected, page_template: 'jobboard_hub', diag_hidden: 1 });
  });

  it('records the first fill and the consent message identically', async () => {
    setPath('/cerca-lavoro-ticino/');
    document.body.innerHTML = '<ins class="adsbygoogle" data-ad-slot="1"></ins>';
    // Both runtimes read `window.performance`; spy on that object, not the
    // global the fake timers may have swapped.
    const now = vi.spyOn(window.performance, 'now').mockReturnValue(4321);
    const ts = runTs();
    const tsSnapshot = () => ts.collect(0);
    const inline = runInline();
    const slot = document.querySelector('ins')!;
    slot.setAttribute('data-ad-status', 'filled');
    const root = document.createElement('div');
    root.className = 'fc-consent-root';
    document.body.appendChild(root);
    await Promise.resolve();
    await Promise.resolve();
    root.remove();
    now.mockRestore();
    expect(tsSnapshot()).toMatchObject({ first_fill_ms: 4321, cmp_shown: 1, slots_filled: 1 });
    expect(inline.collect(0)).toEqual(tsSnapshot());
  });

  it('marks cmp_shown when the consent decision changes during the page view', () => {
    setPath('/');
    const ts = runTs();
    const inline = runInline();
    expect(ts.collect(0).cmp_shown).toBe(0);
    expect(inline.collect(0).cmp_shown).toBe(0);
    window.dispatchEvent(new CustomEvent(ADS_CONSENT_CHANGE_EVENT, { detail: 'granted' }));
    expect(ts.collect(0).cmp_shown).toBe(1);
    expect(inline.collect(0).cmp_shown).toBe(1);
  });

  it('the pure TS collector matches what the handle reports', () => {
    jobDetailFixture();
    const handle = runTs();
    expect(collectAdPageDiag(w, { path: handle.path, firstFill: -1, cmp: 0 }, 0, () => false)).toEqual(handle.collect(0));
  });
});

describe.each([
  ['inline loader', (isBot?: () => boolean) => runInline(isBot)],
  ['SPA service', (isBot?: () => boolean) => runTs(isBot)],
] as const)('once per page view — %s', (_name, start) => {
  it('sends once on the timer, never again on hide or pagehide', () => {
    start();
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ diag_hidden: 0, transport_type: 'beacon', page_template: 'home' });
  });

  it('sends once on the first hide before the timer', () => {
    start();
    vi.advanceTimersByTime(3000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    window.dispatchEvent(new Event('pagehide'));
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ diag_hidden: 1 });
  });

  it('a visible visibilitychange does not send', () => {
    start();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(diagCalls()).toHaveLength(0);
  });

  it('sends once on pagehide', () => {
    start();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ diag_hidden: 1 });
  });

  it('never throws when gtag throws', () => {
    w.gtag = () => {
      throw new Error('blocked');
    };
    const handle = start();
    expect(() => handle.flush(0)).not.toThrow();
    expect(handle.done).toBe(true);
  });

  it('queues on dataLayer when gtag is not there yet', () => {
    delete w.gtag;
    const dl = ((window as unknown as { dataLayer?: unknown[] }).dataLayer = []);
    start().flush(0);
    expect(dl).toHaveLength(1);
    const args = Array.from(dl[0] as ArrayLike<unknown>);
    expect(args.slice(0, 2)).toEqual(['event', AD_PAGE_DIAG_EVENT]);
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  });
});

describe('SPA route changes and the loader hand-off', () => {
  it('a second start on the same path is a no-op', () => {
    setPath('/cerca-lavoro-ticino/');
    startAdPageDiag('/cerca-lavoro-ticino/');
    const first = w.__ftAdDiag!;
    handles.push(first);
    startAdPageDiag('/cerca-lavoro-ticino/');
    expect(w.__ftAdDiag).toBe(first);
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls()).toHaveLength(1);
  });

  it('a route change flushes the previous page view first, then starts the next', () => {
    setPath('/cerca-lavoro-ticino/');
    startAdPageDiag('/cerca-lavoro-ticino/');
    handles.push(w.__ftAdDiag!);
    setPath('/aziende/migros/');
    startAdPageDiag('/aziende/migros/');
    handles.push(w.__ftAdDiag!);
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ page_template: 'jobboard_hub', diag_hidden: 1 });
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls()).toHaveLength(2);
    expect(diagCalls()[1]).toMatchObject({ page_template: 'company', diag_hidden: 0 });
  });

  it('the SPA steps aside on the path the static loader owns, and takes over on navigation', () => {
    setPath('/cerca-lavoro-ticino/');
    const loaderHandle = runInline();
    startAdPageDiag('/cerca-lavoro-ticino/');
    expect(w.__ftAdDiag).toBe(loaderHandle);
    setPath('/prezzi-diesel/oggi/');
    startAdPageDiag('/prezzi-diesel/oggi/');
    handles.push(w.__ftAdDiag!);
    expect(loaderHandle.done).toBe(true);
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls().map((p) => [p.page_template, p.diag_hidden])).toEqual([
      ['jobboard_hub', 1],
      ['fuel', 0],
    ]);
  });

  it('the loader steps aside when the SPA already took the path', () => {
    setPath('/cerca-lavoro-ticino/');
    startAdPageDiag('/cerca-lavoro-ticino/');
    const spaHandle = w.__ftAdDiag!;
    handles.push(spaHandle);
    inlineStart(() => false);
    expect(w.__ftAdDiag).toBe(spaHandle);
  });

  it('useAdPageDiag starts on mount and on every pushState event', async () => {
    setPath('/cerca-lavoro-ticino/');
    const { unmount } = renderHook(() => useAdPageDiag(true));
    await vi.dynamicImportSettled();
    await act(async () => {
      await Promise.resolve();
    });
    const first = w.__ftAdDiag!;
    expect(first.path).toBe('/cerca-lavoro-ticino/');
    handles.push(first);
    act(() => {
      setPath('/lavoro-ticino-infermiere/');
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });
    handles.push(w.__ftAdDiag!);
    expect(w.__ftAdDiag!.path).toBe('/lavoro-ticino-infermiere/');
    expect(first.done).toBe(true);
    expect(diagCalls()[0]).toMatchObject({ page_template: 'jobboard_hub', diag_hidden: 1 });
    unmount();
  });
});

describe('static AdSense loader carries the emission', () => {
  const NOADS_GATE = "if((function(){try{return window.localStorage.getItem('reader_noads_active')==='true';";

  it('embeds the diagnosis before the no-ads and bot-gate early returns', () => {
    const diagAt = ADSENSE_LOADER_CONTENT.indexOf(AD_PAGE_DIAG_FN);
    expect(diagAt).toBeGreaterThan(ADSENSE_LOADER_CONTENT.indexOf('staticAdArm();'));
    expect(diagAt).toBeLessThan(ADSENSE_LOADER_CONTENT.indexOf(NOADS_GATE));
    expect(diagAt).toBeLessThan(ADSENSE_LOADER_CONTENT.indexOf(`if((${BOT_GATE_FN})())return;`));
    expect(ADSENSE_LOADER_CONTENT).toContain(`'${AD_PAGE_DIAG_EVENT}'`);
    expect(ADSENSE_LOADER_CONTENT).toContain(`},${AD_PAGE_DIAG_DELAY_MS});`);
  });

  it('reports a no-ads page view from the real loader', () => {
    setPath('/cerca-lavoro-ticino/');
    window.localStorage.setItem('reader_noads_active', 'true');
    // eslint-disable-next-line no-new-func
    new Function(ADSENSE_LOADER_CONTENT)();
    handles.push(w.__ftAdDiag!);
    vi.advanceTimersByTime(AD_PAGE_DIAG_DELAY_MS);
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ ad_path: 'noads_entitlement', page_template: 'jobboard_hub', diag_hidden: 0 });
  });

  it('reports a bot-gated page view from the real loader', () => {
    setPath('/cerca-lavoro-ticino/');
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => 'curl/8.4.0' });
    try {
      // eslint-disable-next-line no-new-func
      new Function(ADSENSE_LOADER_CONTENT)();
      handles.push(w.__ftAdDiag!);
      window.dispatchEvent(new Event('pagehide'));
    } finally {
      if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
      else delete (window.navigator as unknown as { userAgent?: string }).userAgent;
    }
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]).toMatchObject({ ad_path: 'bot_gated', consent_state: 'granted', diag_hidden: 1 });
  });
});

describe('GA4 registration covers every parameter', () => {
  it('each parameter is a registered (or already shared) custom definition', () => {
    setPath('/');
    const params = Object.keys(runTs().collect(0)).sort();
    const registered = [
      ...AD_PAGE_DIAG_GA4_SHARED_DIMENSIONS,
      ...AD_PAGE_DIAG_GA4_CUSTOM_DIMENSIONS.map((d: { parameterName: string }) => d.parameterName),
      ...AD_PAGE_DIAG_GA4_CUSTOM_METRICS.map((m: { parameterName: string }) => m.parameterName),
    ].sort();
    expect(registered).toEqual(params);
  });

  it('first_fill_ms is registered in milliseconds', () => {
    const metric = AD_PAGE_DIAG_GA4_CUSTOM_METRICS.find((m: { parameterName: string }) => m.parameterName === 'first_fill_ms');
    expect(metric?.measurementUnit).toBe('MILLISECONDS');
  });
});

describe('SPA banner exposes its state to the diagnosis', () => {
  it('AdSenseBanner spreads AD_BANNER_STATE_ATTR with its lifecycle state on the wrapper', () => {
    const src = readFileSync(resolve(__dirname, '..', 'components/shared/AdSenseBanner.tsx'), 'utf8');
    expect(src).toContain('{...{ [AD_BANNER_STATE_ATTR]: state }}');
  });
});
