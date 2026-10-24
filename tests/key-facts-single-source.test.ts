// E-E-A-T P0 — key facts stated once, everywhere the same, with an official source.
//
// Before: founding year 2023 (Organization JSON-LD) vs 2024 (/chi-siamo/);
// "79.000", "78.000", "77.000", "76.000", "oltre 74.000" or "70.000"
// frontalieri; "28%", "29%", "30%" of the workforce; "+2-3% per year" growth
// against an official series in decline. services/seo/keyFacts.ts holds the
// values (USTAT Notiziario 2026-18, Q1 2026); this observer fails on any
// surface that states another current headcount, share or growth figure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOUNDING_YEAR,
  TICINO_CROSS_BORDER_SHARE_PERCENT,
  TICINO_CROSS_BORDER_WORKERS,
  TICINO_CROSS_BORDER_WORKERS_ROUNDED,
  TICINO_EMPLOYED_DOMESTIC,
  formatCrossBorderWorkers,
} from '../services/seo/keyFacts';
import { ORGANIZATION_FOUNDING_DATE } from '../services/seo/organizationLd';
import { CHI_SIAMO_COPY } from '../components/pages/chiSiamoCopy';
import itStats from '../services/locales/it-stats';
import enStats from '../services/locales/en-stats';
import deStats from '../services/locales/de-stats';
import frStats from '../services/locales/fr-stats';
import itCore from '../services/locales/it-core';
import enCore from '../services/locales/en-core';
import deCore from '../services/locales/de-core';
import frCore from '../services/locales/fr-core';
import itFisco from '../services/locales/it-fisco';
import enFisco from '../services/locales/en-fisco';
import deFisco from '../services/locales/de-fisco';
import frFisco from '../services/locales/fr-fisco';
import itComparatori from '../services/locales/it-comparatori';
import enComparatori from '../services/locales/en-comparatori';
import deComparatori from '../services/locales/de-comparatori';
import frComparatori from '../services/locales/fr-comparatori';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

// Files read as source text (code, static HTML, llms files — none is pipeline data).
const TEXT_SURFACES = [
  'index.html',
  'services/seo/seo-pages.ts',
  'services/seo/faq-translations.ts',
  'services/newsletterPreview.ts',
  'build-plugins/staticPagesPlugin.ts',
  'build-plugins/editorialContent.ts',
  'build-plugins/jobSectorLanding.ts',
  'build-plugins/jobsSeoPagesPlugin.ts',
  'scripts/send-newsletter.mjs',
  'public/llms.txt',
  'public/llms-full.txt',
  'public/en/llms.txt',
  'public/en/llms-full.txt',
  'public/de/llms.txt',
  'public/fr/llms.txt',
];
// UI locale chunks are imported (interface code, not live data).
const LOCALE_SURFACES: Record<string, unknown> = {
  itStats, enStats, deStats, frStats, itCore, enCore, deCore, frCore,
  itFisco, enFisco, deFisco, frFisco, itComparatori, enComparatori, deComparatori, frComparatori,
};
const surfaces = (): [string, string][] => [
  ...TEXT_SURFACES.map((rel) => [rel, read(rel)] as [string, string]),
  ...Object.entries(LOCALE_SURFACES).map(([name, mod]) => [name, JSON.stringify(mod)] as [string, string]),
];

// "<qualifier> NN.000 frontalieri" in the four languages, 60-99 thousand: a
// statement of the cantonal headcount. City-level figures (e.g. ~30.000 in
// Lugano) are a different fact and stay out of the pattern.
const HEADCOUNT_RE = /\b(?:circa|oltre|about|over|approximately|around|roughly|rund|etwa|über|environ|plus de)\s+([6-9]\d)[.,'’  ]000\s+(?:lavoratori\s+)?(?:frontalier|cross-border|Grenzg|travailleurs frontaliers)/giu;
const SHARE_RE = /(\d{2})\s?%\s+(?:della forza lavoro|of the (?:cantonal |Ticino |Canton Ticino )?workforce|der (?:kantonalen )?Arbeitskräfte|de la main-d)/giu;
const GROWTH_RE = /cresce del 2[-–]3|grows? by 2[-–]3|grown steadily|wächst jährlich um 2|waechst jaehrlich um 2|augmente de 2[-–]3|croit de 2[-–]3|Crescita annua/iu;

describe('key facts: one source', () => {
  it('derives the stated figures from the USTAT table', () => {
    expect(TICINO_CROSS_BORDER_WORKERS).toBe(78_561);
    expect(TICINO_EMPLOYED_DOMESTIC).toBe(244_531);
    expect(TICINO_CROSS_BORDER_WORKERS_ROUNDED).toBe(79_000);
    expect(TICINO_CROSS_BORDER_SHARE_PERCENT).toBe(32);
    expect(formatCrossBorderWorkers('it')).toBe('79.000');
    expect(formatCrossBorderWorkers('en')).toBe('79,000');
  });

  it('states one founding year: JSON-LD, homepage, seo-pages and /chi-siamo/ agree', () => {
    expect(ORGANIZATION_FOUNDING_DATE).toBe(FOUNDING_YEAR);
    const html = read('index.html');
    expect([...html.matchAll(/"foundingDate":\s*"(\d{4})"/g)].map((m) => m[1])).toEqual([FOUNDING_YEAR]);
    // seo-pages.ts is regex-parsed by staticPagesPlugin: it keeps the literal, held equal here.
    expect([...read('services/seo/seo-pages.ts').matchAll(/"foundingDate":\s*"(\d{4})"/g)].map((m) => m[1])).toEqual([FOUNDING_YEAR, FOUNDING_YEAR, FOUNDING_YEAR]);
    for (const copy of Object.values(CHI_SIAMO_COPY)) expect(copy.footer).toContain(FOUNDING_YEAR);
  });

  it('every current-headcount claim is the rounded USTAT figure', () => {
    const offenders: string[] = [];
    for (const [name, text] of surfaces()) {
      for (const m of text.matchAll(HEADCOUNT_RE)) {
        if (Number(m[1]) * 1000 !== TICINO_CROSS_BORDER_WORKERS_ROUNDED) offenders.push(`${name}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every workforce-share claim is the computed USTAT share', () => {
    const offenders: string[] = [];
    for (const [name, text] of surfaces()) {
      for (const m of text.matchAll(SHARE_RE)) {
        if (Number(m[1]) !== TICINO_CROSS_BORDER_SHARE_PERCENT) offenders.push(`${name}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no surface claims a steady 2-3% yearly growth (USTAT: downward trend)', () => {
    expect(surfaces().filter(([, text]) => GROWTH_RE.test(text)).map(([name]) => name)).toEqual([]);
  });

  it('llms files cite the USTAT source for the headcount', () => {
    for (const rel of TEXT_SURFACES.filter((p) => p.startsWith('public/'))) {
      expect(read(rel), rel).toContain('259587ns_2026-18.pdf');
    }
  });
});
