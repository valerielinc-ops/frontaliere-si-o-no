/**
 * Tests for webcam rendering on border-wait pages (F8).
 *
 * Verifies:
 *  - Webcams render when `data/borderCrossings.ts` has a `webcams` entry for
 *    the crossing, and DO NOT render otherwise (no empty <figure>).
 *  - Attribution link carries `rel="nofollow noopener"` + `target="_blank"`.
 *  - Every <img> has explicit width/height (prevents CLS) + loading="lazy".
 *  - The inline refresh <script> is only injected when the page has at least
 *    one webcam.
 *  - `onerror` fallback hides the <figure> when a URL fails.
 */

import { describe, expect, it } from 'vitest';
import { borderCrossings } from '../data/borderCrossings';
import {
  generateBorderWaitPages,
  type BorderWaitCurrent,
} from '../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath } from '../build-plugins/borderWaitData';

const CURRENT: BorderWaitCurrent = {
  updatedAt: '2026-04-21T06:00:00.000Z',
  perCrossing: {
    'chiasso-brogeda': {
      waitTimeMinutes: 12,
      source: 'tomtom',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'yellow',
    },
    gaggiolo: {
      waitTimeMinutes: 20,
      source: 'tomtom',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'red',
    },
  },
};

const pages = generateBorderWaitPages({ current: CURRENT, today: new Date('2026-04-21T06:00:00.000Z') });

describe('webcam rendering — conditional display', () => {
  it('Brogeda page contains the 3 ASTRA/PolCa webcam figures', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    // Count <figure> blocks inside the main body
    const figureCount = (html.match(/<figure/g) ?? []).length;
    expect(figureCount).toBeGreaterThanOrEqual(3);
  });

  it('Stabio (gaggiolo) page contains at least one webcam figure', () => {
    const html = pages[buildOggiPath('it', 'gaggiolo')];
    expect(html).toContain('<figure');
    expect(html).toContain('02.0N.gif');
  });

  it('Crociale dei Mulini (no webcam configured) omits the webcam section entirely', () => {
    const html = pages[buildOggiPath('it', 'crociale-dei-mulini')];
    expect(html).not.toContain('<figure');
    expect(html).not.toContain('data-webcam-refresh');
  });

  it('Maslianico-Roggiana (closed pedestrian, no webcam) omits the webcam section', () => {
    const html = pages[buildOggiPath('it', 'maslianico-roggiana')];
    expect(html).not.toContain('<figure');
  });
});

describe('webcam rendering — attribution + accessibility', () => {
  it('webcam figcaption carries rel="nofollow noopener" + target="_blank"', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('rel="nofollow noopener"');
    expect(html).toContain('target="_blank"');
  });

  it('every webcam <img> has explicit width + height + loading="lazy"', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toMatch(/<img[^>]+loading="lazy"/);
    expect(html).toMatch(/<img[^>]+width="640"/);
    expect(html).toMatch(/<img[^>]+height="360"/);
  });

  it('webcam <img> has alt text mentioning the label + update time', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    // alt should contain "Chiasso Brogeda" in some form
    const altMatches = Array.from(html.matchAll(/<img[^>]+alt="([^"]+)"/g));
    expect(altMatches.length).toBeGreaterThan(0);
    const joined = altMatches.map((m) => m[1]).join(' ');
    expect(joined.toLowerCase()).toMatch(/brogeda|chiasso/);
  });

  it('webcam <img> has onerror handler that hides the parent <figure>', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain("closest('figure')");
    expect(html).toContain("style.display='none'");
  });
});

describe('webcam rendering — refresh script injection', () => {
  it('pages WITH webcams include the inline refresh <script>', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('data-webcam-refresh');
    expect(html).toContain('setInterval');
  });

  it('pages WITHOUT webcams do NOT include the refresh <script>', () => {
    const html = pages[buildOggiPath('it', 'crociale-dei-mulini')];
    expect(html).not.toContain('data-webcam-refresh');
  });

  it('refresh script uses cache-busting query param with Date.now()', () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('Date.now()');
  });
});

describe('webcam registry — data sanity', () => {
  it('every crossing with webcams uses an https:// imageUrl', () => {
    for (const c of borderCrossings) {
      for (const w of c.webcams ?? []) {
        expect(w.imageUrl.startsWith('https://')).toBe(true);
      }
    }
  });

  it('every webcam has sourceName + sourceUrl for attribution', () => {
    for (const c of borderCrossings) {
      for (const w of c.webcams ?? []) {
        expect(w.sourceName.length).toBeGreaterThan(0);
        expect(w.sourceUrl.startsWith('https://')).toBe(true);
      }
    }
  });

  it('at least 3 crossings have at least one webcam configured (F8 target)', () => {
    const withCams = borderCrossings.filter((c) => (c.webcams ?? []).length > 0);
    expect(withCams.length).toBeGreaterThanOrEqual(3);
  });
});
