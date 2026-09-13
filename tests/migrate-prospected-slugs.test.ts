import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyProspectedSlugMigration,
  LOCALES,
  planProspectedSlugMigration,
  TARGET_CRAWLERS,
  validateProspectedSlugPlans,
} from '../scripts/migrate-prospected-slugs.mjs';
import { buildSlug } from '../scripts/lib/regenerate-slugs-helpers.mjs';

function fixture(url = 'https://example.test/jobs/1') {
  return {
    id: 'fixture-1',
    url,
    slug: 'ruolo-acme-lugano',
    slugByLocale: {
      it: 'ruolo-acme-lugano',
      en: 'role-acme-lugano',
      de: 'rolle-acme-lugano',
      fr: 'poste-acme-lugano',
    },
    titleByLocale: {
      it: 'Ruolo',
      en: 'Role',
      de: 'Rolle',
      fr: 'Poste',
    },
    company: 'Acme',
    location: 'Lugano',
    previousSlugs: ['older-acme-lugano'],
    previousSlugsByLocale: { it: ['older-acme-lugano'] },
  };
}

describe('migrate-prospected-slugs', () => {
  it('uses the canonical base, preserves every retired locale route, and is idempotent', () => {
    const job = fixture();
    const plan = planProspectedSlugMigration(job);
    const expectedDisambiguator = crypto.createHash('sha1').update(job.url).digest('hex').slice(0, 8);

    expect(plan.slugDisambiguator).toBe(expectedDisambiguator);
    applyProspectedSlugMigration(job, plan);

    for (const locale of LOCALES) {
      expect(job.slugByLocale[locale]).toBe(
        buildSlug(job.titleByLocale[locale], job.company, job.location, expectedDisambiguator),
      );
      expect(job.previousSlugsByLocale[locale]).toContain(plan.oldSlugByLocale[locale]);
    }
    expect(job.previousSlugs).toEqual(expect.arrayContaining([
      'older-acme-lugano',
      ...Object.values(plan.oldSlugByLocale),
    ]));

    const migrated = JSON.stringify(job);
    expect(applyProspectedSlugMigration(job)).toMatchObject({ changed: false });
    expect(JSON.stringify(job)).toBe(migrated);
  });

  it('fails closed when the detail URL is absent instead of inventing a shared route', () => {
    const job = fixture();
    delete job.url;
    expect(() => planProspectedSlugMigration(job)).toThrow(/detail URL/);
    expect(job.slug).toBe('ruolo-acme-lugano');
  });

  it('rejects a canonical collision before any slice can be written', () => {
    const first = fixture();
    const second = { ...fixture(), id: 'fixture-2' };
    const entries = [
      { crawlerKey: 'accor', job: first, plan: planProspectedSlugMigration(first) },
      { crawlerKey: 'ete', job: second, plan: planProspectedSlugMigration(second) },
    ];

    expect(() => validateProspectedSlugPlans(entries)).toThrow(/claimed by/);
  });

  it('can migrate every checked-in target job in memory without writing cron data', () => {
    const dataDir = path.join(process.cwd(), 'data', 'jobs', 'by-crawler');
    const entries = [];
    const seen = new Set<string>();
    for (const crawlerKey of TARGET_CRAWLERS) {
      const payload = JSON.parse(fs.readFileSync(path.join(dataDir, crawlerKey + '.json'), 'utf8'));
      for (const originalJob of payload.jobs) {
        const job = JSON.parse(JSON.stringify(originalJob));
        entries.push({
          crawlerKey,
          job,
          plan: planProspectedSlugMigration(job),
        });
      }
    }

    validateProspectedSlugPlans(entries);
    for (const entry of entries) {
      const oldSlugs = { ...entry.plan.oldSlugByLocale };
      applyProspectedSlugMigration(entry.job, entry.plan);
      expect(entry.job.slugDisambiguator).toBe(entry.plan.slugDisambiguator);
      for (const locale of LOCALES) {
        const slug = entry.job.slugByLocale[locale];
        expect(slug).toBe(entry.plan.nextSlugByLocale[locale]);
        expect(entry.job.previousSlugsByLocale[locale]).toContain(oldSlugs[locale]);
        const key = locale + ':' + slug;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
});
