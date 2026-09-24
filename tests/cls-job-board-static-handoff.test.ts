// @vitest-environment jsdom
/**
 * #8868 — CLS on /cerca-lavoro-ticino/ (field p75 0.13–0.14).
 *
 * Playwright layout-shift attribution against production (4x CPU, 1.6 Mbps,
 * 2026-09-24) found two shifts in the static → SPA handoff, both outside
 * JobBoard itself:
 *
 * 1. `body:has(.seo-footer-block) #root { min-height: 100vh }` (index.css)
 *    flips on only when the parser reaches `aside#jb-seo-block`, the LAST
 *    element of the ~150KB document. On a slow connection the static listing
 *    is already painted, so #root jumps from its 80px header reserve to 100vh
 *    and throws the static sub-nav + listing below the fold: 0.58 (desktop).
 * 2. index.tsx moved the body-level fallback into #root but left the
 *    body-direct `nav.seo-hub-subnav` behind, so the sub-nav jumped from under
 *    the header to below the listing: 0.106 (desktop).
 *
 * The fixtures mirror the production HTML skeleton of the hub page.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { adoptStaticFallbackIntoRoot } from '@/services/staticFallbackHandoff';

const ROOT = resolve(__dirname, '..');

/** Selector of every index.css rule that reserves `min-height: 100vh` on #root. */
function rootViewportReserveSelectors(): string[] {
  const css = readFileSync(resolve(ROOT, 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    if (/#root$/.test(selector) && /min-height\s*:\s*100vh/.test(m[2])) out.push(selector);
  }
  return out;
}

const JOB_BOARD_HUB_BODY = `
  <div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div></div>
  <nav class="seo-hub-subnav border-t border-edge bg-surface" data-hub="job-board"><a href="/x/">x</a></nav>
  <div class="ft-rail-grid xlw:grid">
    <aside id="rail-left-root" class="ft-rail-aside"></aside>
    <main class="seo-static-content"><h1>Offerte di lavoro in Ticino</h1></main>
    <aside id="rail-right-root" class="ft-rail-aside"></aside>
  </div>
  <div id="footer-root"></div>
  <aside class="job-archive-cta" id="jb-archive-cta"></aside>
  <aside id="jb-seo-block" class="seo-footer-block"></aside>`;

const HOMEPAGE_BODY = `
  <div id="root"><main id="main-content"><h1>Frontaliere Ticino</h1></main></div>
  <div id="footer-root"></div>
  <aside id="hp-seo-block" class="seo-footer-block"></aside>`;

const STATIC_OVERLAY_HUB_BODY = `
  <div id="root"><div class="ft-hdr-reserve"></div></div>
  <div class="ft-rail-grid"><main class="seo-static-content"><h1>Hub</h1></main></div>
  <div id="footer-root"></div>`;

describe('#root 100vh reservation (index.css) — #8868', () => {
  it('has exactly one reservation rule, scoped to pages with a footer SEO block', () => {
    const selectors = rootViewportReserveSelectors();
    expect(selectors).toHaveLength(1);
    expect(selectors[0]).toContain(':has(.seo-footer-block)');
  });

  it('stays OFF on the job-board hub while its static fallback sits outside #root', () => {
    document.body.innerHTML = JOB_BOARD_HUB_BODY;
    for (const selector of rootViewportReserveSelectors()) {
      expect(
        document.querySelector(selector),
        `\`${selector}\` reserves 100vh on #root of /cerca-lavoro-ticino/: the footer block is parsed last, ` +
          'so the reservation flips on after the static listing painted and pushes it below the fold (CLS 0.58).',
      ).toBeNull();
    }
  });

  it('stays OFF when the fallback is a body-direct main without the rail wrapper', () => {
    document.body.innerHTML = `
      <div id="root"><div class="ft-hdr-reserve"></div></div>
      <main class="cluster-seo-prose"><h1>Cluster</h1></main>
      <aside id="jb-seo-block" class="seo-footer-block"></aside>`;
    for (const selector of rootViewportReserveSelectors()) {
      expect(document.querySelector(selector)).toBeNull();
    }
  });

  it('stays ON for the homepage, whose prerendered content lives inside #root', () => {
    document.body.innerHTML = HOMEPAGE_BODY;
    for (const selector of rootViewportReserveSelectors()) {
      expect(document.querySelector(selector)).toBe(document.getElementById('root'));
    }
  });

  it('stays OFF on staticOverlay hubs without a footer SEO block (#2236)', () => {
    document.body.innerHTML = STATIC_OVERLAY_HUB_BODY;
    for (const selector of rootViewportReserveSelectors()) {
      expect(document.querySelector(selector)).toBeNull();
    }
  });
});

describe('adoptStaticFallbackIntoRoot — #8868', () => {
  beforeEach(() => {
    document.body.innerHTML = JOB_BOARD_HUB_BODY;
  });

  it('moves the body-level hub sub-nav with the fallback, in painted order', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    const subnav = document.querySelector<HTMLElement>('nav.seo-hub-subnav')!;

    const adopted = adoptStaticFallbackIntoRoot(root, fallback);

    expect(adopted.subnav).toBe(subnav);
    expect(Array.from(root.children).map((el) => el.classList[0])).toEqual([
      'ft-hdr-reserve',
      'seo-hub-subnav',
      'seo-static-content',
    ]);
    expect(document.querySelector('body > nav.seo-hub-subnav')).toBeNull();
  });

  it('hides the emptied rail wrapper and clears a stale display on the fallback', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    fallback.style.setProperty('display', 'none', 'important');
    const railWrap = document.querySelector<HTMLElement>('.ft-rail-grid')!;

    const adopted = adoptStaticFallbackIntoRoot(root, fallback);

    expect(adopted.railWrap).toBe(railWrap);
    expect(railWrap.style.display).toBe('none');
    expect(fallback.style.getPropertyValue('display')).toBe('');
  });

  it('leaves a sub-nav that is not between #root and the fallback where it is', () => {
    document.body.innerHTML = `
      <div id="root"><div class="ft-hdr-reserve"></div></div>
      <div class="ft-rail-grid"><main class="seo-static-content"></main></div>
      <nav class="seo-hub-subnav"></nav>`;
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;

    const adopted = adoptStaticFallbackIntoRoot(root, fallback);

    expect(adopted.subnav).toBeNull();
    expect(document.querySelector('body > nav.seo-hub-subnav')).not.toBeNull();
    expect(Array.from(root.children).map((el) => el.classList[0])).toEqual(['ft-hdr-reserve', 'seo-static-content']);
  });

  it('is the handoff index.tsx actually runs', () => {
    const entry = readFileSync(resolve(ROOT, 'index.tsx'), 'utf-8');
    expect(entry).toContain('adoptStaticFallbackIntoRoot(rootElement, fallback)');
    expect(entry).not.toMatch(/rootElement\.appendChild\(fallback\)/);
  });
});
