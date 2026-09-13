import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyProspectedSlugMigration,
  buildProspectedSlugOwnerMap,
  LOCALES,
  needsProspectedSlugMigration,
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

  it('migrates a stale master route even when the Italian locale slug already matches', () => {
    const job = fixture();
    const firstPlan = planProspectedSlugMigration(job);
    job.slugByLocale.it = firstPlan.nextSlugByLocale.it;
    job.slug = 'stale-master-route';
    job.slugDisambiguator = firstPlan.slugDisambiguator;

    const plan = planProspectedSlugMigration(job);
    expect(needsProspectedSlugMigration(job, plan)).toBe(true);

    applyProspectedSlugMigration(job, plan);
    expect(job.slug).toBe(plan.nextSlugByLocale.it);
    expect(job.previousSlugsByLocale.it).toContain('stale-master-route');
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

  it('rejects a planned route already active in another crawler slice', () => {
    const target = fixture('https://example.test/jobs/target');
    const plan = planProspectedSlugMigration(target);
    const external = {
      id: 'external-live-job',
      slug: plan.nextSlugByLocale.it,
      slugByLocale: {
        it: plan.nextSlugByLocale.it,
        en: 'external-en',
        de: 'external-de',
        fr: 'external-fr',
      },
    };
    const activeOwners = buildProspectedSlugOwnerMap([
      { job: external, owner: 'job:external-live-job' },
    ]);

    expect(() => validateProspectedSlugPlans([
      {
        crawlerKey: 'accor',
        job: target,
        plan,
        owner: 'job:target',
      },
    ], activeOwners)).toThrow(/it:.*claimed by/);
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

  it('wires the migration into a guarded manual bot-direct workflow', () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'migrate-prospected-slugs.yml'),
      'utf8',
    );

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).toContain('ref: main');
    expect(workflow).toMatch(/if \[ "\$\{GITHUB_REF:-\}" != "refs\/heads\/main" \]; then/);
    const refGuard = workflow.indexOf('Require main dispatch ref');
    expect(refGuard).toBeGreaterThanOrEqual(0);
    expect(refGuard).toBeLessThan(workflow.indexOf('name: Checkout'));
    expect(refGuard).toBeLessThan(workflow.indexOf('Prepare Firebase credentials'));
    expect(workflow).toContain('group: jobs-data-pipeline');
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('node scripts/migrate-prospected-slugs.mjs --apply');
    expect(workflow).toContain('Dry run prospected slug migration: 0 of');
    expect(workflow).toContain('run: npm test');
    expect(workflow).toContain('git diff --cached --name-only');
    expect(workflow).toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).toContain('--regenerate-cmd');
    for (const crawlerKey of TARGET_CRAWLERS) {
      expect(workflow).toContain(`data/jobs/by-crawler/${crawlerKey}.json`);
    }
  });
});
