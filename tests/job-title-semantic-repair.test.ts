import { describe, expect, it } from 'vitest';
import { repairJobTitleSemanticsInPlace } from '../scripts/lib/job-title-semantic-repair.mjs';
import { enrichJobLocalesDCC } from '../scripts/lib/dedicated-crawler-common.mjs';
import { normalizeParsedJobsForSlice, normalizeAndPersistExpiredSlice } from '../scripts/assemble-jobs-dataset.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function fixture() {
  return { title: 'Crew', company: "McDonald's Switzerland", sourceLang: 'fr',
    url: 'https://jobs.mcdonalds.ch/fr-ch/crew/job/P8-318369-1',
    titleByLocale: { fr: 'Crew', it: 'Nazioni Unite', en: 'United Nations', de: 'Besatzung' },
    slug: 'nazioni-unite', slugByLocale: { en: 'united-nations', fr: 'crew' }, previousSlugs: ['crew-old'],
    description: '', location: 'Lugano', canton: 'TI' };
}
describe('source-backed restaurant Crew semantic repair', () => {
  it('repairs corruptions without moving canonical URLs or aliases and is idempotent', () => {
    const job = fixture();
    const identity = JSON.stringify([job.slug, job.slugByLocale, job.previousSlugs]);
    expect(repairJobTitleSemanticsInPlace(job)).toBe(3);
    expect(Object.values(job.titleByLocale)).toEqual(['Crew', 'Crew', 'Crew', 'Crew']);
    expect(repairJobTitleSemanticsInPlace(job)).toBe(0);
    expect(JSON.stringify([job.slug, job.slugByLocale, job.previousSlugs])).toBe(identity);
    job.titleByLocale.de = 'Vereinte Nationen';
    expect(repairJobTitleSemanticsInPlace(job)).toBe(1);
  });
  it('preserves genuine UN roles, aviation Crew and valid translations', () => {
    for (const job of [
      { ...fixture(), title: 'United Nations', titleByLocale: { fr: 'Nations Unies', en: 'United Nations' } },
      { ...fixture(), company: 'SWISS', url: 'https://careers.swiss.com/jobs/1' },
      { ...fixture(), titleByLocale: { fr: 'Crew', it: 'Collaboratore di ristorazione', en: 'Crew member' } },
    ]) {
      const before = structuredClone(job);
      expect(repairJobTitleSemanticsInPlace(job)).toBe(0);
      expect(job).toEqual(before);
    }
  });
  it('uses exact employer host evidence when company display name is abbreviated', () => {
    const job = { ...fixture(), company: 'McD' };
    expect(repairJobTitleSemanticsInPlace(job)).toBe(3);
    const unrelated = { ...fixture(), company: 'SWISS', url: 'https://jobs.mcdonalds.ch.example.org/job/1' };
    expect(repairJobTitleSemanticsInPlace(unrelated)).toBe(0);
  });
  it('repairs existing records with AI disabled without mutating the input', async () => {
    const original = fixture();
    const result = await enrichJobLocalesDCC(original, { aiLocalizationEnabled: false }, {});
    expect(result.titleByLocale.en).toBe('Crew');
    expect(original.titleByLocale.en).toBe('United Nations');
  });
  it('repairs the active assembly funnel', () => {
    const job = fixture();
    normalizeParsedJobsForSlice([job]);
    expect(job.titleByLocale.de).toBe('Crew');
  });
  it('persists historical repairs before aggregate caps and is repeatable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-title-repair-'));
    try {
      const file = join(dir, 'expired.json');
      const jobs = [{ ...fixture(), expiredAt: new Date(Date.now() - 86400000).toISOString() }];
      expect(normalizeAndPersistExpiredSlice(file, jobs)).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))[0].titleByLocale.it).toBe('Crew');
      expect(normalizeAndPersistExpiredSlice(file, jobs)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
