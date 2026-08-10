/**
 * #4479 — Swiss minimum-wage landings.
 * Path builders/parsers, dataset invariants, and render smoke tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MINWAGE_LOCALES,
  MINWAGE_PAGES,
  MINWAGE_LANDING_ROUTES,
  CANTON_IDS,
  buildMinWageLandingPath,
  parseMinWageLandingPath,
  isMinWageLandingPath,
  type MinWageDataset,
} from '@/build-plugins/minimumWageLandingsData';
import { __renderMinWagePageForTest } from '@/build-plugins/minimumWageLandingsPlugin';
import { MIN_INDEXABLE_WORDS } from '@/build-plugins/constants';
import { TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import { expectIndexableWithLargePreview } from './helpers/robotsAssertions';

const DATASET = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'data', 'seo', 'swiss-minimum-wage.json'), 'utf8'),
) as MinWageDataset;

describe('minimum-wage landings — routing', () => {
  it('produces 28 canonical routes (7 page types × 4 locales), all trailing-slash', () => {
    expect(MINWAGE_LANDING_ROUTES).toHaveLength(28);
    for (const r of MINWAGE_LANDING_ROUTES) {
      expect(r.endsWith('/')).toBe(true);
      expect(r.startsWith('/')).toBe(true);
    }
    expect(new Set(MINWAGE_LANDING_ROUTES).size).toBe(28);
  });

  it('round-trips build → parse for every locale/page', () => {
    for (const locale of MINWAGE_LOCALES) {
      for (const page of MINWAGE_PAGES) {
        const path = buildMinWageLandingPath(locale, page);
        expect(parseMinWageLandingPath(path)).toEqual({ locale, page });
        expect(isMinWageLandingPath(path)).toBe(true);
      }
    }
  });

  it('IT canonical slugs are the expected keyword URLs', () => {
    expect(buildMinWageLandingPath('it', { kind: 'hub' })).toBe('/salario-minimo/');
    expect(buildMinWageLandingPath('it', { kind: 'canton', canton: 'ti' })).toBe('/salario-minimo/ticino/');
    expect(buildMinWageLandingPath('it', { kind: 'ccl' })).toBe('/salario-minimo/contratti-collettivi/');
    expect(buildMinWageLandingPath('en', { kind: 'hub' })).toBe('/en/minimum-wage/');
    expect(buildMinWageLandingPath('de', { kind: 'canton', canton: 'ge' })).toBe('/de/mindestlohn/genf/');
    expect(buildMinWageLandingPath('fr', { kind: 'hub' })).toBe('/fr/salaire-minimum/');
  });

  it('rejects unrelated paths', () => {
    expect(parseMinWageLandingPath('/cerca-lavoro-ticino/')).toBeNull();
    expect(isMinWageLandingPath('/salario-minimo/zurigo/')).toBe(false);
  });
});

describe('minimum-wage dataset — invariants', () => {
  it('covers the five statutory-minimum cantons with all 4 locale names', () => {
    const ids = DATASET.cantons.map((c) => c.id).sort();
    expect(ids).toEqual([...CANTON_IDS].sort());
    for (const c of DATASET.cantons) {
      for (const loc of MINWAGE_LOCALES) {
        expect(c.name[loc], `${c.id} missing ${loc} name`).toBeTruthy();
        expect(c.law[loc], `${c.id} missing ${loc} law`).toBeTruthy();
        expect(c.note[loc], `${c.id} missing ${loc} note`).toBeTruthy();
      }
      expect(c.hourlyMin).toBeGreaterThan(0);
      expect(c.hourlyMax).toBeGreaterThanOrEqual(c.hourlyMin);
      expect(c.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('Geneva is the highest and Ticino the lowest statutory minimum', () => {
    const sorted = [...DATASET.cantons].sort((a, b) => b.hourlyMin - a.hourlyMin);
    expect(sorted[0].id).toBe('ge');
    expect(sorted[sorted.length - 1].id).toBe('ti');
  });

  it('monthly estimate is hourly × 182 (42h/week)', () => {
    for (const c of DATASET.cantons) {
      expect(c.monthlyMin).toBe(Math.round(c.hourlyMin * DATASET.meta.monthlyFactor));
      expect(c.monthlyMax).toBe(Math.round(c.hourlyMax * DATASET.meta.monthlyFactor));
    }
    expect(DATASET.meta.monthlyFactor).toBe((42 * 52) / 12);
  });

  it('covers the four main CCL sectors with binding minimums', () => {
    const ids = DATASET.ccls.map((c) => c.id).sort();
    expect(ids).toEqual(['edilizia', 'interinali', 'pulizie', 'ristorazione']);
    for (const ccl of DATASET.ccls) {
      expect(ccl.rows.length).toBeGreaterThan(0);
      for (const loc of MINWAGE_LOCALES) {
        expect(ccl.sector[loc], `${ccl.id} missing ${loc} sector`).toBeTruthy();
        expect(ccl.scope[loc], `${ccl.id} missing ${loc} scope`).toBeTruthy();
        expect(ccl.note[loc], `${ccl.id} missing ${loc} note`).toBeTruthy();
      }
      for (const r of ccl.rows) {
        expect(['month', 'hour']).toContain(r.unit);
        for (const loc of MINWAGE_LOCALES) {
          expect(r.label[loc], `${ccl.id} row missing ${loc} label`).toBeTruthy();
        }
      }
    }
  });
});

describe('minimum-wage landings — render smoke', () => {
  it('every page renders above the thin-content floor with canonical + h1 + an indexable Discover-eligible robots directive', () => {
    for (const locale of MINWAGE_LOCALES) {
      for (const page of MINWAGE_PAGES) {
        const r = __renderMinWagePageForTest({ locale, page, dateStamp: '2026-07-19' });
        expect(r.wordCount, `${locale}/${page.kind} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toContain('<h1');
        expect(r.html).toContain(`https://frontaliereticino.ch${r.urlPath}`);
        expectIndexableWithLargePreview(r.html, `${locale}/${page.kind}`);
      }
    }
  });

  it('hub page carries the end-of-content multiplex; leaf pages do not', () => {
    // HTML is minified at build (attribute quotes stripped), so assert on the
    // AdSense <ins> marker + the multiplex format rather than a quoted string.
    const hub = __renderMinWagePageForTest({ locale: 'it', page: { kind: 'hub' }, dateStamp: '2026-07-19' });
    expect(hub.html).toContain('adsbygoogle');
    expect(hub.html).toContain('autorelaxed');
    const canton = __renderMinWagePageForTest({
      locale: 'it',
      page: { kind: 'canton', canton: 'ti' },
      dateStamp: '2026-07-19',
    });
    expect(canton.html).not.toContain('adsbygoogle');
    const ccl = __renderMinWagePageForTest({ locale: 'it', page: { kind: 'ccl' }, dateStamp: '2026-07-19' });
    expect(ccl.html).not.toContain('adsbygoogle');
  });

  it('Ticino page states the CHF value and cross-links the hub + CCL page', () => {
    const r = __renderMinWagePageForTest({
      locale: 'it',
      page: { kind: 'canton', canton: 'ti' },
      dateStamp: '2026-07-19',
    });
    expect(r.html).toContain('CHF 20.00–20.50/h');
    expect(r.html).toContain('/salario-minimo/');
    expect(r.html).toContain('/salario-minimo/contratti-collettivi/');
  });

  // Issue #5355 — audit:title-length regression. The `ccl` template's four
  // locale strings (IT/EN/FR) plus the EN `hub` string all overflowed the
  // audit's 66-char cap once the CCL year interpolation was in place
  // (67-84 chars measured live on 2026-08-10). Fixed at the source in
  // minimumWageLandingsPlugin.ts's title templates, not by truncation — this
  // is the render-level regression test so the class cannot come back
  // silently: it covers every locale x page combo, not just the four that
  // were over, so a future edit to ANY of these templates (or the `year`
  // interpolation growing to 5 digits) is caught too.
  it('every <title> fits the audit-title-length.mjs 66-char SERP cap', () => {
    // Mirror scripts/audit-title-length.mjs's normalizeText(): the audit
    // measures the DECODED text a browser/SERP shows, not the raw HTML
    // entities minified markup ships (e.g. `&amp;` -> `&`, 5 chars -> 1).
    const decodeEntities = (s: string) =>
      s
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
    const over: string[] = [];
    for (const locale of MINWAGE_LOCALES) {
      for (const page of MINWAGE_PAGES) {
        const r = __renderMinWagePageForTest({ locale, page, dateStamp: '2026-07-19' });
        const rawTitle = r.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
        expect(rawTitle, `${locale}/${page.kind} has no <title>`).not.toBe('');
        const title = decodeEntities(rawTitle);
        if (title.length > TITLE_MAX_CHARS) {
          over.push(`${locale}/${page.kind} (${title.length} chars): ${title}`);
        }
      }
    }
    expect(over).toEqual([]);
  });
});
