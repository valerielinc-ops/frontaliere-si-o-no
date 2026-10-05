/**
 * SERP copy of the `/cerca-lavoro-svizzera/ricerca-*` cluster family
 * (issue 11198, CTR below the template curve).
 *
 * Production HTML measured on 2026-10-05 showed two generator defects shared
 * by every indexable cluster page in all four locales:
 *
 *  1. `<title>` was the bare keyword + city ("Fielmann a Genève | Frontaliere
 *     Ticino", "Driver Truck | Frontaliere Ticino"): nothing in the SERP said
 *     the page lists JOBS, while every sibling job template (role, city,
 *     employer hubs, keyword landings) carries a job-intent framing.
 *  2. the meta description stopped at ~70-110 chars, so the shared
 *     `clampMetaDescription` padded it with the evergreen SITE blurb and cut
 *     that blurb mid-phrase: "… Fielmann Group. Scopri guide pratiche, dati
 *     aggiornati" / "… Explore practical guides, current data and useful".
 *     Long company lists were cut mid-word instead ("Universitäre Psych…").
 *
 * The assertions are invariants on the rendered page (and on the helper the
 * incremental manifest reuses), not pinned strings.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClusterDescription,
  buildClusterTitle,
  renderClusterPage,
} from '../build-plugins/relatedSearchClustersPlugin';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';
import { escapeForBudget, META_DESCRIPTION_MAX_CHARS, META_DESCRIPTION_MIN_CHARS, TITLE_MAX_CHARS } from '../build-plugins/shared/titleSuffix';

type Locale = 'it' | 'en' | 'de' | 'fr';
const LOCALES: Locale[] = ['it', 'en', 'de', 'fr'];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-serp-'));
  tmpDirs.push(dir);
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf8');
  writeFileSync(join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf8');
  return dir;
}

const SLUG_PREFIX: Record<Locale, string> = { it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche' };

function jobs(n: number, company: string, location: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${company}-${i}`,
    title: `Augenoptiker ${i}`,
    company,
    location,
    canton: 'GE',
    slug: `augenoptiker-${i}-${location.toLowerCase()}`,
  }));
}

function render(locale: Locale, opts: { slug: string; keyword: string; city: string | null; companies: string[]; n?: number }) {
  const n = opts.n ?? 30;
  const page = renderClusterPage({
    distDir: makeDist(),
    dateStamp: '2026-10-05',
    ctx: {
      candidate: {
        slug: `${SLUG_PREFIX[locale]}-${opts.slug}`,
        locale,
        jobCount: n,
        sampleTerms: [opts.city ? `${opts.keyword} ${opts.city}` : opts.keyword],
        editorialCollision: null,
      },
      keyword: opts.keyword,
      city: opts.city,
      matchingJobs: jobs(n, opts.companies[0], opts.city || 'Zürich'),
      topCompanies: opts.companies,
      cantonGroup: '_AGGREGATE_',
    } as any,
    enriched: undefined,
    hreflang: [],
    related: [],
  });
  return page.html;
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function titleOf(html: string): string {
  return decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
}
function h1Of(html: string): string {
  return decode((/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')).trim();
}
function metaDescriptionOf(html: string): string {
  const m = /<meta name=description content=(?:"([^"]*)"|([^\s>]+))/.exec(html);
  return decode(m?.[1] ?? m?.[2] ?? '');
}

const JOB_INTENT: Record<Locale, RegExp> = {
  it: /offerte di lavoro/i,
  en: /\bjobs\b/i,
  de: /\b(Jobs|Stellen)\b/,
  fr: /offres d[’']emploi/i,
};

// Evergreen site blurb `clampMetaDescription` pads short copy with — its
// presence in a cluster snippet is the defect, whichever word it stops on.
const SITE_PADDING: Record<Locale, RegExp> = {
  it: /Scopri guide pratiche/,
  en: /Explore practical guides/,
  de: /Entdecke praktische Ratgeber/,
  fr: /Découvrez des guides pratiques/,
};

describe('cluster <title> carries job intent (issue 11198)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: brand/city keyword gets a job framing, stays in budget and differs from the H1`, () => {
      const html = render(locale, { slug: 'fielmann-geneve', keyword: 'fielmann', city: 'Genève', companies: ['Fielmann Group'] });
      const title = titleOf(html);
      expect(title).toMatch(JOB_INTENT[locale]);
      expect(title).toMatch(/Fielmann/);
      expect(title).toMatch(/Genève/);
      expect(escapeForBudget(title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title.toLowerCase()).not.toBe(h1Of(html).toLowerCase());
    });

    it(`${locale}: city-less keyword is framed too`, () => {
      const html = render(locale, { slug: 'driver-truck', keyword: 'Driver Truck', city: null, companies: ['TRAVECO Transporte AG'] });
      expect(titleOf(html)).toMatch(JOB_INTENT[locale]);
      expect(escapeForBudget(titleOf(html)).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    });
  }

  it('does not stack a second job phrase on a keyword that already carries one', () => {
    const title = buildClusterTitle('offerte lavoro Operatore/Operatrice Socio', null, 'it');
    expect(title.match(/lavoro/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(title).toMatch(/Operatore\/Operatrice Socio/);
  });

  it('a keyword too long for the framing keeps the old within-budget headline title', () => {
    const kw = 'addetto al commercio al dettaglio efz creare esperienze di acquisto';
    const title = buildClusterTitle(kw, 'Lugano', 'it');
    expect(escapeForBudget(title).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title.length).toBeGreaterThan(0);
  });

  it('the rendered title IS the helper output (manifest and page share one generator)', () => {
    for (const locale of LOCALES) {
      const html = render(locale, { slug: 'propre-schaffhausen', keyword: 'propre', city: 'Schaffhausen', companies: ['STA Personal AG'] });
      expect(titleOf(html)).toBe(buildClusterTitle('propre', 'Schaffhausen', locale));
    }
  });
});

describe('cluster meta description is complete and job-specific (issue 11198)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: short tagline is completed with job copy, never with the truncated site blurb`, () => {
      const html = render(locale, { slug: 'fielmann-geneve', keyword: 'fielmann', city: 'Genève', companies: ['Fielmann Group'] });
      const desc = metaDescriptionOf(html);
      expect(desc).not.toMatch(SITE_PADDING[locale]);
      expect(desc.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_CHARS);
      expect(desc.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
      expect(desc).toMatch(/[.!]$/);
    });

    it(`${locale}: a long employer list is shortened by whole names, not cut mid-word`, () => {
      const companies = [
        'Psychiatrische Dienste Aargau (PDAG)',
        'Universitäre Psychiatrische Kliniken Basel (UPK)',
      ];
      const desc = buildClusterDescription({
        keyword: 'offerte lavoro Psicologo / Psicologo ASS (w/m/d)',
        city: null,
        jobCount: 25,
        topCompanies: companies,
      }, locale);
      expect(desc).not.toMatch(/…$/);
      expect(desc.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
      expect(desc).toMatch(/[.!]$/);
    });
  }

  it('the zero-job tagline keeps its forward-framed copy (no "0 offerte")', () => {
    const desc = buildClusterDescription({ keyword: 'fielmann', city: 'Spreitenbach', jobCount: 0, topCompanies: [] }, 'it');
    expect(desc).not.toMatch(/\b0 offerte/);
    expect(desc.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_CHARS);
  });
});
