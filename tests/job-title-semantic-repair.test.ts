import { describe, expect, it } from 'vitest';
import { repairJobTitleSemanticsInPlace, repairJobDescriptionBrandsInPlace, repairJobTranslationSemanticsInPlace } from '../scripts/lib/job-title-semantic-repair.mjs';
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

describe('source-backed description brand repair', () => {
  function brandFixture() {
    return { ...fixture(), title: 'Crew Member', description: "Chez McDonald’s, bienvenue !",
      descriptionByLocale: { fr: "Chez McDonald’s, bienvenue !", en: "At McDonsons, welcome. Start at McDonkey's!", de: 'Bei McDonsons.' } };
  }
  it('changes only known brand spans and is idempotent', () => {
    const job = brandFixture();
    expect(repairJobDescriptionBrandsInPlace(job)).toBe(2);
    expect(job.descriptionByLocale.en).toBe('At McDonald’s, welcome. Start at McDonald’s!');
    expect(job.descriptionByLocale.de).toBe('Bei McDonald’s.');
    expect(job.descriptionByLocale.fr).toBe(job.description);
    expect(repairJobDescriptionBrandsInPlace(job)).toBe(0);
  });
  it('preserves original legitimate tokens, absent source anchors and unrelated employers', () => {
    for (const job of [
      { ...brandFixture(), descriptionByLocale: { fr: "McDonald’s and McDonsons", en: 'McDonsons' } },
      { ...brandFixture(), description: 'Restaurant', descriptionByLocale: { fr: 'Restaurant', en: 'McDonsons' } },
      { ...brandFixture(), company: 'Other restaurant', url: 'https://example.org/job' },
    ]) {
      const before = structuredClone(job);
      expect(repairJobDescriptionBrandsInPlace(job)).toBe(0);
      expect(job).toEqual(before);
    }
  });
  it('preserves URLs, markup attributes, schema and identities exactly', () => {
    const job = { ...brandFixture(), schema: { name: "McDonkey's" } };
    const protectedText = `<a title="x > McDonsons" href="/McDonsons/">Apply</a> <a title='x > McDonsons' href='/McDonsons/'>Apply</a> [Apply](/a(foo)/McDonsons/) https://example.org/McDonsons/`;
    job.descriptionByLocale.en = `At McDonsons. [McDonsons](/apply/) ${protectedText}`;
    const before = structuredClone(job);
    repairJobTranslationSemanticsInPlace(job);
    expect(job.descriptionByLocale.en).toBe(`At McDonald’s. [McDonald’s](/apply/) ${protectedText}`);
    expect(job.schema).toEqual(before.schema);
    expect(job.slugByLocale).toEqual(before.slugByLocale);
    expect(job.previousSlugs).toEqual(before.previousSlugs);
  });
  it('repairs disabled-AI and expired assembly paths without mutating source input', async () => {
    const original = brandFixture();
    const enriched = await enrichJobLocalesDCC(original, { aiLocalizationEnabled: false }, {});
    expect(enriched.descriptionByLocale.en).toBe('At McDonald’s, welcome. Start at McDonald’s!');
    expect(original.descriptionByLocale.en).toContain('McDonsons');
    const dir = mkdtempSync(join(tmpdir(), 'brand-repair-'));
    try {
      const file = join(dir, 'expired.json');
      const jobs = [{ ...brandFixture(), expiredAt: new Date(Date.now() - 86400000).toISOString() }];
      normalizeAndPersistExpiredSlice(file, jobs);
      expect(JSON.parse(readFileSync(file, 'utf8'))[0].descriptionByLocale.en).toBe(enriched.descriptionByLocale.en);
      expect(normalizeAndPersistExpiredSlice(file, jobs)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
