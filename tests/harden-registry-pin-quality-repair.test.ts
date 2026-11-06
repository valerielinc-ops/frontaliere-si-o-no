/**
 * Regression test for the second slug-derivation loop in hardenJobLocaleFields.
 *
 * The registry pin must be authoritative in BOTH locale loops. The second loop
 * (quality-repair: boilerplate / italian / federal-placeholder) bypasses the
 * isSlugStable anti-churn guard, so without an explicit pin guard it would
 * "repair" a registered job's slug — demoting the immutable, indexed registry
 * slug to previousSlugs and churning the canonical away from the indexed URL.
 *
 * Strategy: two jobs share a boilerplate EN slug (matches SLUG_BOILERPLATE_RE →
 * needsBoilerplateSlugRepair → isQualityRepair → bypasses isSlugStable). One is
 * registered (must stay pinned), one is not (must be repaired). This proves the
 * second loop both fires (control job repaired) and is guarded (registered job
 * frozen). Uses SLUG_REGISTRY_PATH_OVERRIDE to inject a controlled registry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BOILERPLATE_EN = 'permette-di-combinare-efficacemente-informatico-eoc-bellinzona';

const REGISTERED_ID = '990001';
const UNREGISTERED_ID = '990002';

const tmpFiles: string[] = [];
afterEach(() => {
  delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
});

function makeJob(id: string) {
  return {
    id: `umantis-${id}`,
    url: `https://recruitingapp-2908.umantis.com/Vacancies/${id}/Description/1`,
    title: 'Informatiker/in', // German source title → titleSourceLang = de
    company: 'EOC',
    location: 'Bellinzona',
    addressLocality: 'Bellinzona',
    slug: 'informatico-a-eoc-bellinzona',
    titleByLocale: {
      it: 'Informatico/a',
      en: 'Computer Scientist',
      de: 'Informatiker/in',
      fr: 'Informaticien/ne',
    },
    slugByLocale: {
      it: 'informatico-a-eoc-bellinzona',
      en: BOILERPLATE_EN, // both jobs start with the same boilerplate EN slug
      de: 'informatiker-in-eoc-bellinzona',
      fr: 'informaticien-ne-eoc-bellinzona',
    },
  };
}

describe('hardenJobLocaleFields registry pin — quality-repair loop', () => {
  it('keeps the registered boilerplate slug pinned while repairing the unregistered one', async () => {
    // Controlled registry: only the REGISTERED job is locked, to the boilerplate
    // EN slug (distinct from IT and DE so the source-copy guard does not skip it).
    const registry = {
      [`id|recruitingapp-2908.umantis.com|${REGISTERED_ID}`]: {
        canonicalSlug: 'informatico-a-eoc-bellinzona',
        slugByLocale: {
          it: 'informatico-a-eoc-bellinzona',
          en: BOILERPLATE_EN,
          de: 'informatiker-in-eoc-bellinzona',
          fr: 'informaticien-ne-eoc-bellinzona',
        },
      },
    };
    const regPath = path.join(os.tmpdir(), `slug-registry-fixture-${process.pid}.json`);
    fs.writeFileSync(regPath, JSON.stringify(registry), 'utf-8');
    tmpFiles.push(regPath);
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;

    // Import AFTER setting the override; the path is resolved at call time so the
    // load picks up the fixture regardless of import order, but this keeps intent
    // explicit.
    const { hardenJobLocaleFields } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const jobsPath = path.join(os.tmpdir(), `harden-quality-repair-${process.pid}.json`);
    fs.writeFileSync(jobsPath, JSON.stringify([makeJob(REGISTERED_ID), makeJob(UNREGISTERED_ID)], null, 2), 'utf-8');
    tmpFiles.push(jobsPath);

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const out = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    const registered = out.find((j: { id: string }) => j.id === `umantis-${REGISTERED_ID}`);
    const unregistered = out.find((j: { id: string }) => j.id === `umantis-${UNREGISTERED_ID}`);

    // Registered job: registry pin is authoritative — boilerplate slug survives
    // the quality-repair loop instead of churning the indexed URL, and is NOT
    // demoted to previousSlugs (no canonical move at all).
    expect(registered.slugByLocale.en).toBe(BOILERPLATE_EN);
    expect(registered.previousSlugsByLocale?.en || []).not.toContain(BOILERPLATE_EN);

    // Control: the unregistered job IS repaired by the quality-repair loop — the
    // boilerplate slug is replaced and demoted to previousSlugs. This proves the
    // loop actually fires, so the pin assertion above is meaningful (not a no-op).
    expect(unregistered.slugByLocale.en).not.toBe(BOILERPLATE_EN);
    expect(unregistered.previousSlugsByLocale?.en || []).toContain(BOILERPLATE_EN);
  });
});
