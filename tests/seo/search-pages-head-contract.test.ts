/**
 * Unit guard for the four `gate:dist-quality` families that the
 * `/{section}/{ricerca|search|suche|recherche}-*` surface was failing on run
 * 31891126686 (issues #5875 / #5845).
 *
 * The gate itself (`tests/seo/related-search-clusters-emitted.test.ts`) only
 * runs post-deploy, against a real `dist/`, behind `RUN_DIST_GATES=1`. This
 * file is the pre-merge half: it exercises the SAME producers and the SAME
 * matchers on synthetic input, so a regression is caught by `npm test` instead
 * of by a post-deploy gate two hours later.
 *
 * What each block pins, and the measurement behind it:
 *
 *  1. QUOTE-AGNOSTIC HEAD LINKS (146 canonical + 199 hreflang offenders, all
 *     false positives). Every cluster page carries canonical + hreflang, but
 *     `buildSeoPageHtml` ends in `minifyHtml`, which unquotes `rel=canonical`
 *     and `rel=alternate`. A quoted-only grep counted 0 on 199 of 199 sampled
 *     pages. The matchers must accept what the minifier emits — and must still
 *     count 0 when the tag is genuinely absent, which is the half a "relaxed"
 *     regex silently loses.
 *
 *  2. BELOW-FLOOR BRIDGE HEAD (53 hreflang + 53 breadcrumb offenders, real).
 *     The bridge is a 200-OK page at the cluster's own URL; it shipped with a
 *     canonical and nothing else.
 *
 *  3. ESCAPED TITLE BUDGET (464 offenders, real). 464 of the 477 over-cap
 *     titles were ≤66 chars DECODED: the cap counted the pre-escape string,
 *     the gate and `audit-title-length.mjs` count the emitted HTML.
 *
 *  4. EDITORIAL LANDING TITLES (13 offenders, real, DIFFERENT producer). Same
 *     directory, same gate, uncapped template literal.
 */

import { describe, expect, it } from 'vitest';
import {
  countCanonicalLinks,
  countHreflangLinks,
} from '../../build-plugins/shared/headLinkPatterns';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';
import {
  buildLocaleAlternateBlock,
  buildLocaleAlternateEntries,
} from '../../build-plugins/shared/localeAlternateBlock';
import { escapeForBudget, TITLE_MAX_CHARS } from '../../build-plugins/shared/titleSuffix';
import {
  capForTitle,
  renderClusterBelowFloorBridge,
} from '../../build-plugins/relatedSearchClustersPlugin';
import { buildJobLocationSectorLandingModel } from '../../build-plugins/jobEditorialLanding';

const HREFLANG_ALL = [
  { locale: 'it' as const, url: 'https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-x/' },
  { locale: 'en' as const, url: 'https://frontaliereticino.ch/en/find-jobs-switzerland/search-x/' },
  { locale: 'de' as const, url: 'https://frontaliereticino.ch/de/jobs-in-schweiz/suche-x/' },
  { locale: 'fr' as const, url: 'https://frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-x/' },
];

function ldJsonTypes(html: string): string[] {
  const out: string[] = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as { '@type'?: string };
      if (parsed && typeof parsed['@type'] === 'string') out.push(parsed['@type']);
    } catch {
      /* not our business here */
    }
  }
  return out;
}

describe('head link matchers survive the build minifier', () => {
  const HEAD = [
    '<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-x/">',
    '<link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-x/">',
    '<link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-x/">',
  ].join('\n');
  const PAGE = `<!DOCTYPE html>\n<html lang="it">\n <head>\n ${HEAD}\n </head>\n <body><h1>x</h1></body>\n</html>`;

  it('the minifier really does unquote the rel token (premise of this whole file)', () => {
    const minified = minifyHtml(PAGE);
    expect(minified).toContain('rel=canonical');
    expect(minified).not.toContain('rel="canonical"');
    expect(minified).toContain('rel=alternate');
    // The old gate pattern — quoted-only — is why 199 of 199 sampled pages
    // reported `hreflang count = 0` while carrying the tags.
    expect(minified.match(/<link\s+rel=["']alternate["']/gi)).toBeNull();
  });

  it('counts canonical + hreflang in BOTH the authored and the minified shape', () => {
    for (const html of [PAGE, minifyHtml(PAGE)]) {
      expect(countCanonicalLinks(html)).toBe(1);
      expect(countHreflangLinks(html)).toBe(2);
    }
  });

  it('still counts ZERO when the tag is genuinely absent (non-vacuity)', () => {
    const noCanonical = minifyHtml(PAGE.replace(/<link rel="canonical"[^>]*>\n?/, ''));
    expect(countCanonicalLinks(noCanonical)).toBe(0);
    // …and the hreflang links must not be mistaken for a canonical.
    expect(countHreflangLinks(noCanonical)).toBe(2);

    const noHreflang = minifyHtml(PAGE.replace(/<link rel="alternate"[^>]*>\n?/g, ''));
    expect(countHreflangLinks(noHreflang)).toBe(0);
    expect(countCanonicalLinks(noHreflang)).toBe(1);
  });

  it('does not count a rel token that merely STARTS with the expected value', () => {
    expect(countCanonicalLinks('<link rel=canonicalish href=/a/>')).toBe(0);
    expect(countHreflangLinks('<link rel=alternates hreflang=it href=/a/>')).toBe(0);
  });

  it('does not count a link with an empty href', () => {
    expect(countCanonicalLinks('<link rel="canonical" href="">')).toBe(0);
    expect(countHreflangLinks('<link rel="alternate" hreflang="it" href="">')).toBe(0);
  });

  it('counts a duplicate canonical as 2, so the gate can still fail it', () => {
    expect(countCanonicalLinks(minifyHtml(PAGE + PAGE))).toBe(2);
  });
});

describe('locale alternate entries and block agree by construction', () => {
  const hrefFor = (l: string) => `https://frontaliereticino.ch/${l}/x/`;

  it('emits the 4 locales + x-default when the set is complete', () => {
    const entries = buildLocaleAlternateEntries({
      eligibleLocales: ['it', 'en', 'de', 'fr'],
      hrefFor,
    });
    expect(entries.map((e) => e.hreflang)).toEqual(['it', 'en', 'de', 'fr', 'x-default']);
    expect(entries.find((e) => e.hreflang === 'x-default')!.href).toBe(hrefFor('it'));
  });

  it('emits NOTHING on an incomplete set (all-or-nothing, #5114)', () => {
    expect(
      buildLocaleAlternateEntries({ eligibleLocales: ['it', 'en'], hrefFor }),
    ).toEqual([]);
    expect(buildLocaleAlternateBlock({ eligibleLocales: ['it', 'en'], hrefFor })).toBe('');
  });

  it('the rendered block is exactly the entries, so the two cannot drift', () => {
    const opts = { eligibleLocales: ['it', 'en', 'de', 'fr'], hrefFor };
    const fromEntries = buildLocaleAlternateEntries(opts)
      .map((e) => ` <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`)
      .join('\n');
    expect(buildLocaleAlternateBlock(opts)).toBe(fromEntries);
  });
});

describe('below-floor cluster bridge carries the full head contract', () => {
  const URL_PATH = '/cerca-lavoro-ticino/ricerca-4hana-basel/';
  const CANONICAL = `https://frontaliereticino.ch${URL_PATH}`;

  it('emits one canonical, the 4+1 hreflang set, and a BreadcrumbList', () => {
    const out = renderClusterBelowFloorBridge(
      'it',
      URL_PATH,
      CANONICAL,
      '4hana basel',
      HREFLANG_ALL,
    );
    expect(countCanonicalLinks(out.html)).toBe(1);
    expect(countHreflangLinks(out.html)).toBe(5);
    expect(ldJsonTypes(out.html)).toContain('BreadcrumbList');
  });

  it('the trail stops at the section and never names the bridge URL itself', () => {
    // A bridge disclaims its own URL (canonical → hub), so a crumb pointing
    // back at it would contradict the canonical. The wider "never advertises
    // its own URL" invariant lives in tests/related-search-clusters-shell.ts.
    const out = renderClusterBelowFloorBridge(
      'it',
      URL_PATH,
      CANONICAL,
      '4hana basel',
      HREFLANG_ALL,
    );
    const m = out.html.match(
      /<script\s+type="application\/ld\+json">(\{"@context[\s\S]*?)<\/script>/,
    );
    expect(m, 'no JSON-LD block on the bridge').not.toBeNull();
    const ld = JSON.parse(m![1]) as {
      '@type': string;
      itemListElement: Array<{ position: number; name: string; item: string }>;
    };
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement).toHaveLength(2);
    expect(ld.itemListElement.map((c) => c.position)).toEqual([1, 2]);
    expect(ld.itemListElement[1].item).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
    expect(JSON.stringify(ld)).not.toContain('ricerca-4hana-basel');
  });

  it('omits hreflang entirely — never a partial set — when a locale is missing', () => {
    const out = renderClusterBelowFloorBridge(
      'it',
      URL_PATH,
      CANONICAL,
      '4hana basel',
      HREFLANG_ALL.slice(0, 2),
    );
    expect(countHreflangLinks(out.html)).toBe(0);
    // The breadcrumb does NOT depend on the alternate set.
    expect(ldJsonTypes(out.html)).toContain('BreadcrumbList');
    expect(countCanonicalLinks(out.html)).toBe(1);
  });

  it('still canonicalises to the hub, not to itself (consolidation intact)', () => {
    const out = renderClusterBelowFloorBridge(
      'it',
      URL_PATH,
      CANONICAL,
      '4hana basel',
      HREFLANG_ALL,
    );
    expect(out.html).toContain('<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-svizzera/">');
    expect(out.html).toContain('noindex,follow');
    // `loc` stays the cluster URL: the sitemap decision is taken elsewhere.
    expect(out.loc).toBe(CANONICAL);
    expect(out.urlPath).toBe(URL_PATH);
  });
});

describe('cluster <title> budget is measured on the string that ships', () => {
  // Real offender from run 31891126686: 65 code points raw, 69 once escaped.
  const AMPERSAND = 'AI & Optimization Ingegnere (100% Remote) Lugano, Ticino a Lugano';

  it('the raw-length premise of the OLD cap: this headline "fits" unescaped', () => {
    expect([...AMPERSAND].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(escapeForBudget(AMPERSAND).length).toBeGreaterThan(TITLE_MAX_CHARS);
  });

  it('caps on the escaped length', () => {
    const capped = capForTitle(AMPERSAND, TITLE_MAX_CHARS);
    expect(escapeForBudget(capped).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // Word-aware: no mid-word amputation, no ellipsis (titleSuffix policy).
    expect(capped).not.toMatch(/…/);
    expect(AMPERSAND.startsWith(capped)).toBe(true);
    expect(capped.length).toBeGreaterThan(30);
  });

  it('leaves a headline that already fits completely untouched', () => {
    const short = 'Infermiere a Lugano';
    expect(capForTitle(short, TITLE_MAX_CHARS)).toBe(short);
  });

  it('holds for quotes and angle brackets too, not just &', () => {
    const quoted = 'Détaillant EFZ "Créer des expériences d\'achat" LIVIQUE a Lugano';
    const capped = capForTitle(quoted, TITLE_MAX_CHARS);
    expect(escapeForBudget(capped).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    const angled = `Tecnico <${'x'.repeat(30)}> & manutenzione a Bellinzona in Ticino`;
    expect(escapeForBudget(capForTitle(angled, TITLE_MAX_CHARS)).length)
      .toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('never returns an empty title (would ship a bare brand suffix)', () => {
    for (const h of ['&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&', 'a', 'per il', AMPERSAND]) {
      expect(capForTitle(h, TITLE_MAX_CHARS).length).toBeGreaterThan(0);
    }
  });
});

describe('editorial location×sector landing titles fit the cap', () => {
  const BASE = {
    jobs: [] as never[],
    localizedSlug: () => 'x',
    baseUrl: 'https://frontaliereticino.ch',
    sectionSlug: 'cerca-lavoro-ticino',
    localePrefix: '',
    now: '2026-08-15T00:00:00.000Z',
  };

  it('caps the 74-char Bellinzona offender without losing the location', () => {
    const model = buildJobLocationSectorLandingModel({
      ...BASE,
      locale: 'it',
      location: 'Bellinzona',
      sectorKey: 'hospitality',
    });
    expect(escapeForBudget(model.title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(model.title).toContain('Bellinzona');
    // <title> must stay distinct from <h1> (audit:h1-title-duplicates).
    expect(model.title).not.toBe(model.heading);
  });

  it('holds across the four locales and every sector', () => {
    const locales = ['it', 'en', 'de', 'fr'] as const;
    const sectors = ['health', 'finance', 'tech', 'engineering', 'admin', 'hospitality', 'sales'] as const;
    const offenders: string[] = [];
    for (const locale of locales) {
      for (const sectorKey of sectors) {
        for (const location of ['Bellinzona', 'Mendrisio', 'Lugano', 'Locarno', 'Chiasso']) {
          const model = buildJobLocationSectorLandingModel({ ...BASE, locale, location, sectorKey });
          const len = escapeForBudget(model.title).length;
          if (len > TITLE_MAX_CHARS) offenders.push(`${locale}/${sectorKey}/${location} — ${len}: ${model.title}`);
          if (model.title === model.heading) offenders.push(`${locale}/${sectorKey}/${location} — title === h1`);
        }
      }
    }
    expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
  });
});
