import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  keywordPageMatcher,
  countProfessionPageJobs,
  professionPageIdForJob,
} from '../scripts/lib/keyword-page-match.mjs';
import { PROFESSION_TAXONOMY } from '../scripts/lib/profession-taxonomy.mjs';

/**
 * Observer for #7915: a profession keyword page must list its ads with the
 * SAME predicate the weekly digest counts promotion with.
 *
 * The digest counted with the multilingual alias matcher of the taxonomy, the
 * page listed by a single Italian substring (`filterKeywords: [feedFilter]`).
 * `isPromotable` rejects a row when the two diverge, so the generator itself
 * manufactured the gap: on the 2026-09-28 snapshot 5 rows with enough demand
 * or supply were blocked (estetista: 18 ads, 0 literal matches — the ads say
 * «Kosmetikerin»; agente-sicurezza: 36 ads, 493 literal matches for
 * «sicurezza»). This file goes red if a second membership predicate comes
 * back, or if a profession page falls back to the literal filter.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8');

describe('keywordPageMatcher — profession pages (professionMatch: true)', () => {
  const page = { professionMatch: true, professionId: 'estetista', filterKeywords: ['estetist'] };

  it('matches on the locale\'s own title, never blended across locales (#4715)', () => {
    const job = {
      title: 'Kosmetikerin 80-100%',
      titleByLocale: { de: 'Kosmetikerin 80-100%', it: 'Infermiere 80-100%' },
      description: 'estetista estetista estetista',
    };
    const matches = keywordPageMatcher(page);
    expect(matches(job, 'de')).toBe(true);
    // The Italian title names another trade: the job must not leak into the
    // Italian page, even though the German one lists it and the description
    // contains the literal feedFilter.
    expect(matches(job, 'it')).toBe(false);
    // Memoised per (job, locale): asking again in the other order is stable.
    expect(matches(job, 'de')).toBe(true);
  });

  it('falls back to the source title when the locale has no translation', () => {
    const job = { title: 'Kosmetikerin EFZ', titleByLocale: { de: 'Kosmetikerin EFZ' } };
    expect(keywordPageMatcher(page)(job, 'fr')).toBe(true);
  });

  it('does not match a job whose only link is the literal substring', () => {
    const job = {
      title: 'Responsabile sicurezza sul lavoro',
      titleByLocale: { it: 'Responsabile sicurezza sul lavoro' },
    };
    const security = { professionMatch: true, professionId: 'agente-sicurezza', filterKeywords: ['sicurezza'] };
    expect(keywordPageMatcher(security)(job, 'it')).toBe(false);
    // ...which the literal rule of a page without the opt-in would list.
    expect(keywordPageMatcher({ filterKeywords: ['sicurezza'] })(job, 'it')).toBe(true);
  });

  it('rejects the documented neighbouring security and beauty titles', () => {
    const security = keywordPageMatcher({ professionMatch: true, professionId: 'agente-sicurezza' });
    for (const title of [
      'Guardia notturna permanente Dipl. Infermieristica',
      'ICT Security Officer',
      'Servicemitarbeiter*in Café & Bar Flughafen Zürich',
      'Guarda il restauro di SAV',
    ]) {
      expect(security({ title }, 'it'), title).toBe(false);
    }

    const beauty = keywordPageMatcher({ professionMatch: true, professionId: 'estetista' });
    expect(beauty({ title: 'Verkaufsberater:in Kosmetik 80%' }, 'it')).toBe(false);
  });
});

describe('keywordPageMatcher — literal pages keep the pre-#7915 rule', () => {
  const medico = { filterKeywords: ['medico'] };

  it('matches a keyword found only in the description', () => {
    const job = { title: 'Assistente', titleByLocale: { it: 'Assistente' }, description: 'Studio del medico di base', company: 'X SA', location: 'Lugano' };
    expect(keywordPageMatcher(medico)(job, 'it')).toBe(true);
  });

  it('matches a keyword found only in the company', () => {
    const job = { title: 'Segretaria', titleByLocale: { it: 'Segretaria' }, description: 'Lavoro d\'ufficio', company: 'Centro Medico Ticino', location: 'Bellinzona' };
    expect(keywordPageMatcher(medico)(job, 'it')).toBe(true);
  });

  it('uses the locale\'s own description, not another locale\'s', () => {
    const job = {
      title: 'Assistant',
      titleByLocale: { it: 'Assistente', de: 'Assistent' },
      description: 'medico',
      descriptionByLocale: { it: 'nessuna parola chiave', de: 'Arztpraxis' },
      company: '', location: '',
    };
    expect(keywordPageMatcher(medico)(job, 'it')).toBe(false);
  });

  it('requires ALL keywords', () => {
    const job = { title: 'Medico', titleByLocale: { it: 'Medico' }, description: '', company: '', location: 'Lugano' };
    expect(keywordPageMatcher({ filterKeywords: ['medico', 'lugano'] })(job, 'it')).toBe(true);
    expect(keywordPageMatcher({ filterKeywords: ['medico', 'locarno'] })(job, 'it')).toBe(false);
  });

  it('never matches with no keywords and no opt-in', () => {
    const job = { title: 'Medico', titleByLocale: { it: 'Medico' } };
    expect(keywordPageMatcher({ filterKeywords: [] })(job, 'it')).toBe(false);
    expect(keywordPageMatcher({})(job, 'it')).toBe(false);
    // professionId alone is NOT an opt-in: the carried profession-gap
    // pages have it and must keep listing by their literal filter.
    expect(keywordPageMatcher({ professionId: 'medico', filterKeywords: [] })(job, 'it')).toBe(false);
  });
});

describe('countProfessionPageJobs — one definition of "ads the page lists"', () => {
  // 40 synthetic ads cycling through the taxonomy, half with a translated
  // Italian title from another entry, so the per-locale rule matters.
  const ids = PROFESSION_TAXONOMY.map((e) => e.id);
  const jobs = Array.from({ length: 40 }, (_, i) => {
    const own = PROFESSION_TAXONOMY[i % PROFESSION_TAXONOMY.length];
    const other = PROFESSION_TAXONOMY[(i * 7 + 3) % PROFESSION_TAXONOMY.length];
    const ownAlias = own.aliases[own.aliases.length - 1];
    return i % 2 === 0
      ? { title: `${ownAlias} 100%`, titleByLocale: { it: `${own.aliases[0]} 100%`, de: `${ownAlias} 100%` } }
      : { title: `${ownAlias} 100%`, titleByLocale: { it: `${other.aliases[0]} 100%`, de: `${ownAlias} 100%` } };
  });

  it('equals the number of ads the page matcher lists, for every taxonomy id', () => {
    let total = 0;
    for (const id of ids) {
      const matches = keywordPageMatcher({ professionMatch: true, professionId: id });
      const listed = jobs.filter((job) => matches(job, 'it')).length;
      const counted = countProfessionPageJobs(jobs, id, 'it');
      expect(counted, id).toBe(listed);
      total += counted;
    }
    // Every synthetic Italian title is an alias of some entry: the per-id
    // counts partition the fixture.
    expect(total).toBe(jobs.length);
  });

  it('defaults to Italian and fails closed on bad input', () => {
    expect(countProfessionPageJobs(jobs, ids[0])).toBe(countProfessionPageJobs(jobs, ids[0], 'it'));
    expect(countProfessionPageJobs(jobs, '')).toBe(0);
    expect(countProfessionPageJobs(null as unknown as any[], ids[0])).toBe(0);
  });

  it('exposes the same single-winner id used by the aggregate digest pass', () => {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const id = professionPageIdForJob(job, 'it');
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    for (const id of ids) {
      expect(counts.get(id) || 0).toBe(countProfessionPageJobs(jobs, id, 'it'));
    }
  });
});

describe('source contract: digest, feed and plugin share the matcher', () => {
  const PLUGIN = read('build-plugins/jobsSeoPagesPlugin.ts');
  const DIGEST = read('scripts/profession-keyword-opportunities.mjs');
  const FEED = read('scripts/generate-keyword-pages-config.mjs');

  it('the plugin lists keyword pages through keywordPageMatcher, with no inline literal rule', () => {
    // Invariants only (not exact lines): the shared module is imported and
    // called, and the old inline literal predicate is gone.
    expect(PLUGIN).toMatch(/\bkeywordPageMatcher\b[^;]*from\s+['"][^'"]*keyword-page-match\.mjs['"]/);
    expect(PLUGIN).toContain('keywordPageMatcher(');
    expect(PLUGIN).not.toContain('kwFilterWords.every');
  });

  it('the digest gates promotion on the page\'s own count, not a second predicate', () => {
    expect(DIGEST).toMatch(/\bprofessionPageIdForJob\b[^;]*from\s+['"][^'"]*keyword-page-match\.mjs['"]/);
    // `feedFilterJobCount` is the JSON field the feed and isPromotable read:
    // it must come from the one-pass per-id map, not a corpus traversal inside
    // the taxonomy ranking loop.
    expect(DIGEST).toMatch(/\bprofessionPageJobCounts\.get\(entry\.id\)/);
    expect(DIGEST).not.toContain('countProfessionPageJobs(jobs, entry.id');
  });

  it('the feed opts NEW profession-gap pages in, never the carried ones', () => {
    const carryStart = FEED.search(/for\s*\(\s*const\s+\w+\s+of\s+prevConfigPages\b/);
    const feedStart = FEED.search(/for\s*\(\s*const\s+\w+\s+of\s+opp\.opportunities\b/);
    expect(carryStart).toBeGreaterThan(-1);
    expect(feedStart).toBeGreaterThan(carryStart);
    const carryLoop = FEED.slice(carryStart, feedStart);
    const feedLoop = FEED.slice(feedStart, FEED.indexOf('fed++;', feedStart));
    expect(carryLoop).not.toContain('professionMatch');
    expect(feedLoop).toContain("source: 'profession-gap'");
    expect(feedLoop).toMatch(/professionMatch:\s*true\b/);
  });
});
