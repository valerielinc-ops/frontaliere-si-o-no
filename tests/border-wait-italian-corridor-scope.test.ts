/**
 * Regression coverage for the Ticino-vs-Italy conflation fixed by #4545.
 *
 * Background: until this issue, `borderWaitPagesPlugin.ts` decided whether to
 * emit Ticino-specific copy by asking `REGION_TO_COUNTRY[region] === 'IT'`,
 * and `isTicinoCrossing()` was defined the same way. That was accidentally
 * correct only while the three `ticino-*` regions were the ONLY Italy-facing
 * ones. The Grigioni/Vallese alpine corridor (Splügen, Great St Bernard,
 * Simplon, …) is Italy-facing and 200 km from Ticino, so under the old test
 * those pages would have claimed the A2 motorway runs from Lugano to the
 * Splügen pass, quoted the Ticino TIS withholding tables and the TILO S40/S50
 * commuter rail, and been ranked inside "best/worst Ticino border crossing"
 * editorial.
 *
 * These assertions fail if anyone reintroduces the country test as a proxy
 * for the corridor.
 */

import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_WAIT_LOCALES,
  BORDER_WAIT_REGIONS,
  CROSSING_TO_REGION,
  REGION_TO_COUNTRY,
  buildOggiPath,
  isTicinoCrossing,
  isTicinoRegion,
  type BorderCrossingSlug,
} from '../build-plugins/borderWaitData';
import {
  generateBorderWaitPages,
  type BorderWaitCurrent,
} from '../build-plugins/borderWaitPagesPlugin';
import { countHtmlBodyWords, MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import { borderCrossings } from '../data/borderCrossings';
import { slugifyCrossingName } from '../services/borderCrossingSlug';

/** The corridor this issue added: Italy-facing, emphatically not Ticino. */
const ITALIAN_ALPINE_CROSSINGS: readonly BorderCrossingSlug[] = [
  'passo-dello-spluga',
  'castasegna-villa-di-chiavenna',
  'campocologno-tirano',
  'tunnel-munt-la-schera',
  'forcola-di-livigno',
  'giogo-di-santa-maria',
  'sempione',
  'traforo-del-gran-san-bernardo',
] as const;

/**
 * Tokens that are verified facts for the Ticino–Italy corridor ONLY. Any of
 * them appearing on a non-Ticino page is a factual error, not a style nit.
 */
const TICINO_ONLY_TOKENS: readonly string[] = [
  'A2', // the Chiasso motorway; the alpine passes are on the A13/E43/SS36
  'Lugano',
  'Mendrisio',
  'Bellinzona',
  'Bellinzone',
  'Brogeda',
  'Stabio',
  'Bizzarone',
  'Crociale dei Mulini',
  'TILO',
  'TIS', // Ticino withholding-tax tables
  'Como',
  'Côme',
  'Varese',
  'Varèse',
  'E35',
] as const;

const EMPTY_CURRENT: BorderWaitCurrent = { updatedAt: null, perCrossing: {} };

/**
 * Visible page copy, with the parts that may legitimately mention Ticino
 * removed: `<a>` text (related-links blocks deliberately cross-link to the
 * Chiasso/Stabio pages — that is internal linking, not a factual claim about
 * this crossing) and `<script>`/`<style>` payloads.
 *
 * Everything that survives is prose the page ASSERTS about the crossing, so a
 * Ticino-only fact appearing here is a correctness bug.
 */
function visibleProse(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<a\b[\s\S]*?<\/a>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('#4545 — the Grigioni/Vallese corridor is wired into every registry', () => {
  it('mirrors the complete data/borderCrossings.ts dataset, with no gaps', () => {
    const datasetSlugs = borderCrossings.map((c) => slugifyCrossingName(c.name));
    const registry = new Set<string>(BORDER_WAIT_CROSSINGS as readonly string[]);
    const missing = datasetSlugs.filter((s) => !registry.has(s));
    expect(
      missing,
      `crossings present in data/borderCrossings.ts but absent from BORDER_WAIT_CROSSINGS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('gives every alpine crossing a region, a country and a display name', () => {
    for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
      expect(BORDER_WAIT_CROSSINGS).toContain(crossing);
      const region = CROSSING_TO_REGION[crossing];
      expect(region, `${crossing} has no region`).toBeTruthy();
      expect(REGION_TO_COUNTRY[region]).toBe('IT');
    }
  });
});

describe('#4545 — "Italy-facing" and "Ticino corridor" are distinct predicates', () => {
  it('classifies the alpine corridor as Italy-facing but NOT Ticino', () => {
    for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
      const region = CROSSING_TO_REGION[crossing];
      expect(REGION_TO_COUNTRY[region], `${crossing} should face Italy`).toBe('IT');
      expect(
        isTicinoCrossing(crossing),
        `${crossing} is Italy-facing but must NOT count as a Ticino crossing — ` +
          'it would leak into Ticino-scoped editorial (ranking article, Telegram digest)',
      ).toBe(false);
    }
  });

  it('keeps isTicinoCrossing true for exactly the 26 real Ticino crossings', () => {
    const ticino = BORDER_WAIT_CROSSINGS.filter((c) => isTicinoCrossing(c));
    expect(ticino).toHaveLength(26);
    for (const c of ticino) {
      expect(CROSSING_TO_REGION[c].startsWith('ticino-')).toBe(true);
    }
  });

  it('is not equivalent to the country test — that equivalence is the bug', () => {
    const byCountry = BORDER_WAIT_REGIONS.filter((r) => REGION_TO_COUNTRY[r] === 'IT');
    const byCorridor = BORDER_WAIT_REGIONS.filter((r) => isTicinoRegion(r));
    expect(byCorridor.length).toBeLessThan(byCountry.length);
  });
});

describe('#4545 — no Ticino-only fact leaks onto a non-Ticino page', () => {
  const pages = generateBorderWaitPages({ current: EMPTY_CURRENT, history: [], today: new Date() });

  it('emits a page for every alpine crossing in all 4 locales', () => {
    for (const locale of BORDER_WAIT_LOCALES) {
      for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
        const path = buildOggiPath(locale, crossing);
        expect(pages[path], `missing page ${path}`).toBeTruthy();
      }
    }
  });

  it('clears the indexable word floor on every alpine page (Non-Negotiable #4)', () => {
    for (const locale of BORDER_WAIT_LOCALES) {
      for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
        const path = buildOggiPath(locale, crossing);
        const words = countHtmlBodyWords(pages[path]);
        expect(words, `${path} has only ${words} body words`).toBeGreaterThanOrEqual(
          MIN_INDEXABLE_WORDS,
        );
      }
    }
  });

  it('never names a Ticino-only place, motorway, tax table or rail line', () => {
    const offenders: string[] = [];
    for (const locale of BORDER_WAIT_LOCALES) {
      for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
        const path = buildOggiPath(locale, crossing);
        const prose = visibleProse(pages[path] ?? '');
        for (const token of TICINO_ONLY_TOKENS) {
          if (new RegExp(`\\b${token}\\b`).test(prose)) {
            offenders.push(`${path} → "${token}"`);
          }
        }
      }
    }
    expect(
      offenders,
      `Ticino-only facts rendered on non-Ticino pages:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('still renders the Ticino facts on the Ticino pages', () => {
    const prose = visibleProse(pages[buildOggiPath('it', 'chiasso-brogeda')] ?? '');
    expect(prose).toMatch(/\bLugano\b/);
    expect(prose).toMatch(/\bA2\b/);
    expect(prose).toMatch(/Crociale dei Mulini/);
  });

  it('gives the Italian alpine corridor its own fiscal paragraph, not the generic one', () => {
    const html = pages[buildOggiPath('it', 'passo-dello-spluga')] ?? '';
    // Italy-wide facts that DO apply to every Italian frontaliere corridor.
    expect(html).toMatch(/25\s?%/);
    expect(html).toMatch(/frontalier/i);
    // …and it must not be byte-identical to a German-corridor page's prose.
    const german = pages[buildOggiPath('it', 'bad-sackingen-stein-ag')] ?? '';
    expect(html).not.toBe(german);
  });
});

/**
 * Internal-link scoping. `pickSiblingCrossings` in
 * `build-plugins/shared/relatedLinks.ts` used to select its sibling pool with
 * `REGION_TO_COUNTRY[region] === 'IT' ? TOP_5_CROSSINGS : …`. TOP_5_CROSSINGS
 * is five *Ticino* crossings, so once an Italy-facing non-Ticino corridor
 * existed that test would have pointed every alpine page at Chiasso, Gaggiolo
 * and Ponte Tresa — the cross-corridor link bug #4952 was filed to stop.
 *
 * Asserted through the rendered page rather than the private helper: what
 * matters is the links a crawler actually sees.
 */
describe('#4545 — alpine pages do not link into the Ticino cluster', () => {
  const pages = generateBorderWaitPages({ current: EMPTY_CURRENT, history: [], today: new Date() });
  const TICINO_TOP_5 = [
    'chiasso-brogeda',
    'chiasso-centro',
    'gaggiolo',
    'oria-gandria',
    'ponte-tresa',
  ] as const;

  it('offers alpine crossings as siblings, never the Ticino top-5', () => {
    const offenders: string[] = [];
    for (const crossing of ITALIAN_ALPINE_CROSSINGS) {
      const path = buildOggiPath('it', crossing);
      const html = pages[path] ?? '';
      for (const ticino of TICINO_TOP_5) {
        if (html.includes(`/traffico-dogane/${ticino}/oggi/`)) {
          offenders.push(`${path} → links to Ticino crossing ${ticino}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('still links Ticino pages to their historical Ticino siblings', () => {
    const html = pages[buildOggiPath('it', 'chiasso-centro')] ?? '';
    const linked = TICINO_TOP_5.filter(
      (t) => t !== 'chiasso-centro' && html.includes(`/traffico-dogane/${t}/oggi/`),
    );
    expect(linked.length).toBeGreaterThan(0);
  });
});
