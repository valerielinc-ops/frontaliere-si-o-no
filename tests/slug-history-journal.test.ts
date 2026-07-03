import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSlugMutation,
  getEvents,
  summarize,
  formatSummary,
  clear,
  mergePreviousSlugsCapped,
} from '../scripts/lib/slug-history-journal.mjs';
import {
  addPreviousSlugForLocale,
  cleanPreviousSlugsPerLocale,
  captureLostSlugs,
} from '../scripts/lib/dedicated-crawler-common.mjs';
import { trackSlugHistoryDrift } from '../scripts/assemble-jobs-dataset.mjs';

describe('slug-history-journal', () => {
  beforeEach(() => clear());

  it('records a single capture event', () => {
    recordSlugMutation({
      jobId: 'job-1', locale: 'it', slug: 'a-b-c',
      action: 'capture', source: 'test/source',
    });
    expect(getEvents()).toHaveLength(1);
    expect(summarize()).toMatchObject({ total: 1, captured: 1, dropped: 0, jobsAffected: 1 });
  });

  it('drops malformed events silently', () => {
    recordSlugMutation({});
    recordSlugMutation({ jobId: 'x' });
    recordSlugMutation({ jobId: 'x', slug: 's', action: 'invalid-action', source: 'src' });
    expect(getEvents()).toHaveLength(0);
  });

  it('mergePreviousSlugsCapped journals cap-trim overflow instead of silently dropping (company-crawler sibling fix)', () => {
    const oldSlugs = Array.from({ length: 15 }, (_, i) => `old-slug-${i}`);
    const newSlugs = Array.from({ length: 10 }, (_, i) => `new-slug-${i}`);
    const result = mergePreviousSlugsCapped(oldSlugs, newSlugs, { jobId: 'company-job-1', source: 'update-guess-jobs.mjs' });
    expect(result).toHaveLength(20);
    expect(getEvents()).toHaveLength(1);
    expect(getEvents()[0]).toMatchObject({ jobId: 'company-job-1', action: 'cap-trim', source: 'update-guess-jobs.mjs' });
  });

  it('mergePreviousSlugsCapped journals nothing when the union stays under cap', () => {
    const result = mergePreviousSlugsCapped(['a', 'b'], ['b', 'c'], { jobId: 'company-job-2', source: 'update-guess-jobs.mjs' });
    expect(result).toEqual(['a', 'b', 'c']);
    expect(getEvents()).toHaveLength(0);
  });

  it('formats summary for commit message', () => {
    recordSlugMutation({ jobId: 'j1', locale: 'en', slug: 'old-en', action: 'capture', source: 'srcA' });
    recordSlugMutation({ jobId: 'j2', locale: 'de', slug: 'old-de', action: 'capture', source: 'srcA' });
    recordSlugMutation({ jobId: 'j1', locale: 'it', slug: 'dead', action: 'drop', source: 'srcB' });
    const out = formatSummary();
    expect(out).toContain('previousSlugs delta');
    expect(out).toContain('capture: 2');
    expect(out).toContain('drop: 1');
    expect(out).toContain('srcA:2');
    expect(out).toContain('net: +1 across 2 jobs');
  });

  it('addPreviousSlugForLocale writes to byLocale and journals capture', () => {
    const job: any = { id: 'job-x' };
    addPreviousSlugForLocale(job, 'en', 'lathe-operator-...');
    expect(job.previousSlugsByLocale.en).toEqual(['lathe-operator-...']);
    expect(job.previousSlugs).toEqual(['lathe-operator-...']);
    const ev = getEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      jobId: 'job-x', locale: 'en', action: 'capture',
      source: expect.stringContaining('addPreviousSlugForLocale'),
    });
  });

  it('captureLostSlugs journals locale-specific rename (Medacta Tornitore regression)', () => {
    const job: any = {
      id: 'medacta-96190',
      slug: 'tornitore-medacta-international-sa-castel-san-pietro',
      slugByLocale: {
        it: 'tornitore-medacta-international-sa-castel-san-pietro',
        en: 'turner-medacta-international-sa-castel-san-pietro-rancate',
        de: 'turner-medacta-international-sa-castel-san-pietro-rancate',
      },
    };
    const prevByLocale = {
      it: 'tornitore-medacta-international-sa-castel-san-pietro',
      en: 'lathe-operator-medacta-international-sa-castel-san-pietro-rancate',
      de: 'dreher-medacta-international-sa-castel-san-pietro-rancate',
    };
    captureLostSlugs(job, prevByLocale, prevByLocale.it);
    // Both EN and DE renames must land in previousSlugsByLocale (THIS is the
    // regression that PR-1 fixes — pre-fix, these were lost entirely).
    expect(job.previousSlugsByLocale?.en).toContain('lathe-operator-medacta-international-sa-castel-san-pietro-rancate');
    expect(job.previousSlugsByLocale?.de).toContain('dreher-medacta-international-sa-castel-san-pietro-rancate');
    expect(job.previousSlugs).toEqual(expect.arrayContaining([
      'lathe-operator-medacta-international-sa-castel-san-pietro-rancate',
      'dreher-medacta-international-sa-castel-san-pietro-rancate',
    ]));
    const captures = getEvents().filter((e: any) => e.action === 'capture');
    expect(captures.length).toBeGreaterThanOrEqual(2);
    expect(captures.every((e: any) => e.source.includes('locale-rename') || e.source.includes('captureLostSlugs'))).toBe(true);
  });

  it('safety-net trackSlugHistoryDrift restores previousSlugs the writer would drop', () => {
    // Simulate the Medacta regression: prior slice has previousSlugs.it,
    // but the freshly-crawled "active" job array has stripped them.
    const prior = [{
      id: 'medacta-104173',
      url: 'https://medacta.com/job/104173',
      slug: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
      slugByLocale: {
        it: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
        en: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
      },
      previousSlugsByLocale: {
        it: ['associate-designer-medacta-castel-san-pietro'],
      },
      previousSlugs: ['associate-designer-medacta-castel-san-pietro'],
    }];
    const active: any[] = [{
      id: 'medacta-104173',
      url: 'https://medacta.com/job/104173',
      slug: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
      slugByLocale: {
        it: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
        en: 'associate-designer-medacta-international-sa-castel-san-pietro-xyz',
      },
      // previousSlugs intentionally missing — this is the regression
    }];
    const result = trackSlugHistoryDrift(prior, active);
    expect(result.mergedSlugs).toBeGreaterThanOrEqual(1);
    expect(active[0].previousSlugsByLocale?.it).toContain('associate-designer-medacta-castel-san-pietro');
    expect(active[0].previousSlugs).toContain('associate-designer-medacta-castel-san-pietro');
  });

  it('cleanPreviousSlugsPerLocale only drops matches against the same locale active slug', () => {
    const job: any = {
      id: 'medacta-96190',
      slug: 'tornitore-medacta-international-sa-castel-san-pietro',
      slugByLocale: {
        it: 'tornitore-medacta-international-sa-castel-san-pietro',
        en: 'turner-medacta-international-sa-castel-san-pietro-rancate',
        de: 'turner-medacta-international-sa-castel-san-pietro-rancate',
      },
      previousSlugsByLocale: {
        it: ['tornitore-medacta-international-sa-castel-san-pietro-rancate'], // ≠ active IT — keep
        en: ['turner-medacta-international-sa-castel-san-pietro-rancate', 'lathe-operator-...-rancate'], // first matches active EN → drop; second keep
        de: ['turner-medacta-international-sa-castel-san-pietro-rancate'], // matches active DE → drop
      },
    };
    cleanPreviousSlugsPerLocale(job);
    expect(job.previousSlugsByLocale.it).toEqual(['tornitore-medacta-international-sa-castel-san-pietro-rancate']);
    expect(job.previousSlugsByLocale.en).toEqual(['lathe-operator-...-rancate']);
    expect(job.previousSlugsByLocale.de).toBeUndefined();
    const drops = getEvents().filter((e: any) => e.action === 'drop');
    expect(drops).toHaveLength(2);
  });
});
