/**
 * Integration test (follow-up #4206, item #3): when registryPinnedLocaleSlug
 * refuses a per-locale pin because it is demonstrably garbled (#4071 guard),
 * hardenJobLocaleFields must actually HEAL the slot end-to-end — not just
 * decline to honor the bad pin and leave the same garbage value sitting in
 * job.slugByLocale untouched.
 *
 * Real corruption shape (KSA, umantis 122706): the registry pins garbage
 * ("logi-hyardfachfrau-…") into the `de` locale slot itself for a nursing
 * vacancy. None of the quality-repair loop's existing heuristics (Italian
 * mistranslation, boilerplate, company-name collision) are shaped to catch
 * generic garbage sitting in an arbitrary locale slot, so before this fix the
 * rejected pin would leave the garbage value in place forever: no healing,
 * no previousSlugs bridge, same 404 risk the #4071 guard exists to prevent.
 *
 * This test asserts both halves of the fix: (a) the slug is replaced with a
 * fresh title-derived slug, and (b) the discarded garbage is preserved as a
 * previousSlugsByLocale bridge so the old (never-actually-good) URL still
 * resolves. Uses SLUG_REGISTRY_PATH_OVERRIDE to inject a controlled registry,
 * same pattern as harden-registry-pin-quality-repair.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GARBLED_DE = 'logi-hyardfachfrau-hyardfachmann-kantonsspital-aarau-ksa-aarau-2767b3';
const KSA_ID = '990201';
const KSA_TENANT = '9188';

const tmpFiles: string[] = [];
afterEach(() => {
  delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
});

describe('hardenJobLocaleFields registry pin — garbled-pin forced repair (#4206 item 3)', () => {
  it('heals a demonstrably garbled registry-pinned slug and bridges the discarded garbage', async () => {
    const registry = {
      [`id|recruitingapp-${KSA_TENANT}.umantis.com|${KSA_ID}`]: {
        canonicalSlug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
        slugByLocale: {
          it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-5',
          en: 'registered-nurse-nursing-professional-kantonsspital-aarau-ksa-aarau',
          fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
          de: GARBLED_DE, // shares zero tokens with the DE title or the canonical
        },
      },
    };
    const regPath = path.join(os.tmpdir(), `slug-registry-fixture-garbled-${process.pid}.json`);
    fs.writeFileSync(regPath, JSON.stringify(registry), 'utf-8');
    tmpFiles.push(regPath);
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;

    // Import AFTER setting the override; the path is resolved at call time, but
    // this keeps intent explicit (same convention as the sibling quality-repair test).
    const { hardenJobLocaleFields } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const job = {
      id: `umantis-${KSA_ID}`,
      url: `https://recruitingapp-${KSA_TENANT}.umantis.com/Vacancies/${KSA_ID}/Description/1`,
      title: 'Dipl. Pflegefachfrau / Pflegefachmann',
      company: 'Kantonsspital Aarau (KSA)',
      location: 'Aarau',
      addressLocality: 'Aarau',
      slug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
      titleByLocale: {
        it: 'Dipl. Pflegefachfrau / Pflegefachmann',
        de: 'Dipl. Pflegefachfrau / Pflegefachmann',
        en: 'Registered Nurse / Nursing Professional',
        fr: 'Infirmier Diplômé / Infirmière Diplômée',
      },
      slugByLocale: {
        it: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-5',
        en: 'registered-nurse-nursing-professional-kantonsspital-aarau-ksa-aarau',
        fr: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch-2',
        de: GARBLED_DE, // corrupted slot under test
      },
    };

    const jobsPath = path.join(os.tmpdir(), `harden-garbled-repair-${process.pid}.json`);
    fs.writeFileSync(jobsPath, JSON.stringify([job], null, 2), 'utf-8');
    tmpFiles.push(jobsPath);

    const result = hardenJobLocaleFields({ dataJobsPath: jobsPath });
    expect(result.changed).toBe(true);

    const out = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'))[0];

    // (a) The garbage is gone — the DE slot now holds a fresh title-derived slug,
    // not the garbled registry pin (which the #4071 guard correctly refused).
    expect(out.slugByLocale.de).not.toBe(GARBLED_DE);
    expect(out.slugByLocale.de).toBeTruthy();

    // (b) The discarded garbage is preserved as a bridge so the never-actually-
    // good URL still resolves instead of 404ing.
    const dePrev = out.previousSlugsByLocale?.de || [];
    const allPrev = [...dePrev, ...(out.previousSlugs || [])];
    expect(allPrev).toContain(GARBLED_DE);
  });
});
