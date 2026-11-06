/**
 * hreflang / self-map coherence for the four FOREIGN border-municipality
 * families shipped by issue #4545 (France, Germany, Austria, Liechtenstein).
 *
 * Guards the #5114 regression class: an hreflang alternate declared for a page
 * that is never emitted. Post-deploy validation walks the alternates and fails
 * the run when a target is missing, which blocks the Google notification — so a
 * dangling alternate is not a cosmetic SEO nit, it stops the deploy pipeline.
 *
 * The check is deliberately built the way the failure happens: the "emitted"
 * set is derived from the same dataset + path helper the emit loop uses, then
 * every alternate parsed out of the RENDERED HTML must be a member of it. A
 * locale silently dropped from an emit loop, or a path helper that diverges
 * from the alternate builder, both surface here.
 *
 * Below-floor communes are covered too: they are noindex,follow bridges but
 * they are emitted at the SAME URL as an above-floor page would be, precisely
 * so the alternates pointing at them resolve. If one ever became a silent skip,
 * its siblings' alternates would dangle — asserted explicitly below.
 */
import { describe, it, expect } from 'vitest';

import { renderAboveFloorPage as renderFrenchAbove, renderBridgePage as renderFrenchBridge } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderGermanAbove, renderBridgePage as renderGermanBridge } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderAustrianAbove, renderBridgePage as renderAustrianBridge } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { renderAboveFloorPage as renderLiechtensteinAbove, renderBridgePage as renderLiechtensteinBridge } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';

import {
  FRENCH_ABOVE_FLOOR, FRENCH_BELOW_FLOOR, FRENCH_LOCALES,
  frenchMunicipalityPathFor, isFrenchBorderMunicipalityPath,
} from '@/build-plugins/frenchBorderMunicipalityData';
import {
  GERMAN_ABOVE_FLOOR, GERMAN_BELOW_FLOOR, GERMAN_LOCALES,
  germanMunicipalityPathFor, isGermanBorderMunicipalityPath,
} from '@/build-plugins/germanBorderMunicipalityData';
import {
  AUSTRIAN_ABOVE_FLOOR, AUSTRIAN_BELOW_FLOOR, AUSTRIAN_LOCALES,
  austrianMunicipalityPathFor, isAustrianBorderMunicipalityPath,
} from '@/build-plugins/austrianBorderMunicipalityData';
import {
  LIECHTENSTEIN_ABOVE_FLOOR, LIECHTENSTEIN_BELOW_FLOOR, LIECHTENSTEIN_LOCALES,
  liechtensteinMunicipalityPathFor, isLiechtensteinBorderMunicipalityPath,
} from '@/build-plugins/liechtensteinBorderMunicipalityData';

const DIST = '/tmp/__border_municipality_hreflang_dist_does_not_exist__';
const DATE = '2026-08-05';

const EXPECTED_LOCALES = ['it', 'en', 'de', 'fr'] as const;

interface Family {
  name: string;
  locales: readonly string[];
  above: readonly { slug: string }[];
  below: readonly { slug: string }[];
  pathFor: (locale: never, slug: string) => string;
  isFamilyPath: (path: string) => boolean;
  renderAbove: (m: never, locale: never) => string;
  renderBridge: (m: never, locale: never) => string;
}

const FAMILIES: Family[] = [
  {
    name: 'France',
    locales: FRENCH_LOCALES,
    above: FRENCH_ABOVE_FLOOR,
    below: FRENCH_BELOW_FLOOR,
    pathFor: frenchMunicipalityPathFor as Family['pathFor'],
    isFamilyPath: isFrenchBorderMunicipalityPath,
    renderAbove: ((m, locale) => renderFrenchAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderFrenchBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Germany',
    locales: GERMAN_LOCALES,
    above: GERMAN_ABOVE_FLOOR,
    below: GERMAN_BELOW_FLOOR,
    pathFor: germanMunicipalityPathFor as Family['pathFor'],
    isFamilyPath: isGermanBorderMunicipalityPath,
    renderAbove: ((m, locale) => renderGermanAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderGermanBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Austria',
    locales: AUSTRIAN_LOCALES,
    above: AUSTRIAN_ABOVE_FLOOR,
    below: AUSTRIAN_BELOW_FLOOR,
    pathFor: austrianMunicipalityPathFor as Family['pathFor'],
    isFamilyPath: isAustrianBorderMunicipalityPath,
    renderAbove: ((m, locale) => renderAustrianAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderAustrianBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
  {
    name: 'Liechtenstein',
    locales: LIECHTENSTEIN_LOCALES,
    above: LIECHTENSTEIN_ABOVE_FLOOR,
    below: LIECHTENSTEIN_BELOW_FLOOR,
    pathFor: liechtensteinMunicipalityPathFor as Family['pathFor'],
    isFamilyPath: isLiechtensteinBorderMunicipalityPath,
    renderAbove: ((m, locale) => renderLiechtensteinAbove({ municipality: m, locale, dateStamp: DATE, distDir: DIST }).html) as Family['renderAbove'],
    renderBridge: ((m, locale) => renderLiechtensteinBridge({ municipality: m, locale, distDir: DIST })) as Family['renderBridge'],
  },
];

/** Every path the family's emit loop writes, for every locale. */
function emittedPaths(family: Family): Set<string> {
  const out = new Set<string>();
  for (const m of [...family.above, ...family.below]) {
    for (const locale of family.locales) {
      out.add(family.pathFor(locale as never, m.slug));
    }
  }
  return out;
}

// The shipped HTML is minified with unquoted attribute values where legal
// (`rel=alternate hreflang=it href="..."`), so every attribute matcher here
// has to accept both quoted and bare forms. A quoted-only regex matches
// nothing and turns the assertions below into vacuous passes — which is why
// `parseAlternates` callers also assert a non-empty result.
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function stripOrigin(href: string): string {
  return href.replace(/^https?:\/\/[^/]+/, '');
}

function parseAlternates(html: string): { hreflang: string; path: string }[] {
  const out: { hreflang: string; path: string }[] = [];
  for (const tag of html.match(/<link[^>]*>/g) ?? []) {
    if (attr(tag, 'rel') !== 'alternate') continue;
    const hreflang = attr(tag, 'hreflang');
    const href = attr(tag, 'href');
    if (!hreflang || !href) continue;
    out.push({ hreflang, path: stripOrigin(href) });
  }
  return out;
}

function parseCanonical(html: string): string | undefined {
  for (const tag of html.match(/<link[^>]*>/g) ?? []) {
    if (attr(tag, 'rel') !== 'canonical') continue;
    const href = attr(tag, 'href');
    if (href) return stripOrigin(href);
  }
  return undefined;
}

describe.each(FAMILIES.map((f) => [f.name, f] as const))(
  '%s border-municipality pages — hreflang coherence',
  (_name, family) => {
    const emitted = emittedPaths(family);

    it('emits all four site locales (a missing locale is what makes siblings\' alternates dangle)', () => {
      expect([...family.locales].sort()).toEqual([...EXPECTED_LOCALES].sort());
    });

    it('declares no alternate that points at a page the family never emits (#5114 class)', () => {
      const dangling: string[] = [];
      for (const m of family.above) {
        for (const locale of family.locales) {
          const html = family.renderAbove(m as never, locale as never);
          const alts = parseAlternates(html);
          // A parser that matches nothing would make this test vacuous.
          expect(alts.length).toBeGreaterThan(0);
          for (const alt of alts) {
            if (!emitted.has(alt.path)) {
              dangling.push(`${family.name}/${m.slug}[${locale}] → ${alt.hreflang}=${alt.path}`);
            }
          }
        }
      }
      expect(dangling).toEqual([]);
    });

    it('declares the same alternate set on below-floor bridges, which are emitted at the SAME URL', () => {
      const dangling: string[] = [];
      for (const m of family.below) {
        for (const locale of family.locales) {
          // The bridge must exist at exactly the URL the alternates point to.
          expect(emitted.has(family.pathFor(locale as never, m.slug))).toBe(true);
          const html = family.renderBridge(m as never, locale as never);
          const alts = parseAlternates(html);
          expect(alts.length).toBeGreaterThan(0);
          for (const alt of alts) {
            if (!emitted.has(alt.path)) {
              dangling.push(`${family.name}/${m.slug}[${locale}] → ${alt.hreflang}=${alt.path}`);
            }
          }
        }
      }
      expect(dangling).toEqual([]);
    });

    it('declares one alternate per locale plus a resolvable x-default', () => {
      const sample = family.above[0];
      const alts = parseAlternates(family.renderAbove(sample as never, 'it' as never));
      const byLang = new Set(alts.map((a) => a.hreflang));
      for (const locale of EXPECTED_LOCALES) expect(byLang).toContain(locale);
      expect(byLang).toContain('x-default');
      const xDefault = alts.find((a) => a.hreflang === 'x-default');
      expect(xDefault).toBeDefined();
      expect(emitted.has(xDefault!.path)).toBe(true);
    });

    it('uses a self-referencing canonical on every locale', () => {
      const sample = family.above[0];
      for (const locale of family.locales) {
        const html = family.renderAbove(sample as never, locale as never);
        expect(parseCanonical(html)).toBe(family.pathFor(locale as never, sample.slug));
      }
    });

    it('self-maps every emitted path in searchConsoleCompat (an unmapped live path is 301d away)', () => {
      const unmapped = [...emitted].filter((p) => !family.isFamilyPath(p));
      expect(unmapped).toEqual([]);
    });

    it('keeps above-floor and below-floor slugs disjoint, so no URL is emitted twice', () => {
      const aboveSlugs = new Set(family.above.map((m) => m.slug));
      const collisions = family.below.map((m) => m.slug).filter((s) => aboveSlugs.has(s));
      expect(collisions).toEqual([]);
    });

    it('has no duplicate slug within a tier (a collision would silently drop a commune)', () => {
      for (const [tier, list] of [['above', family.above], ['below', family.below]] as const) {
        const slugs = list.map((m) => m.slug);
        expect(new Set(slugs).size, `${family.name} ${tier} tier has duplicate slugs`).toBe(slugs.length);
      }
    });
  },
);
