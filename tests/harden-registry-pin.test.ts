/**
 * Integration test: hardenJobLocaleFields restores a registry-pinned locale slug
 * when a re-translated title drifted it.
 *
 * This is the end-to-end guard for the AI-translation slug-instability root-cause
 * fix. A job already registered in data/slug-registry.json must keep its locked
 * per-locale slug even after its title is re-translated into a different form,
 * with the drifted slug demoted to previousSlugs so the legacy URL keeps
 * resolving. Uses a real registry entry (picked dynamically so the test survives
 * registry churn) by injecting a small immutable registry fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hardenJobLocaleFields,
} from '../scripts/lib/dedicated-crawler-common.mjs';

const tmpFiles: string[] = [];
const previousRegistryOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  if (previousRegistryOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousRegistryOverride;
});

describe('hardenJobLocaleFields registry pin', () => {
  it('restores a drifted EN slug to the immutable registry value and demotes the drift', () => {
    const tenant = '9999';
    const id = '12345';
    const registry = {
      canonicalSlug: 'informatico-a',
      slugByLocale: {
        it: 'informatico-a',
        en: 'computer-scientist',
        de: 'informatiker-in',
        fr: 'informaticien-ne',
      },
    };
    const registryPath = path.join(os.tmpdir(), `harden-registry-fixture-${process.pid}-${id}.json`);
    tmpFiles.push(registryPath);
    fs.writeFileSync(registryPath, JSON.stringify({
      [`id|recruitingapp-${tenant}.umantis.com|${id}`]: registry,
    }), 'utf-8');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;
    const lockedEn = registry.slugByLocale.en as string;
    const driftEn = 'totally-different-ai-retranslation-slug-upd';

    const job = {
      id: `umantis-${id}`,
      // url drives fingerprintJob → `id|recruitingapp-<tenant>.umantis.com|<id>` → matches the registry key
      url: `https://recruitingapp-${tenant}.umantis.com/Vacancies/${id}/Description/1`,
      title: 'Informatico/a', // Italian source title → titleSourceLang detects 'it'
      company: 'EOC',
      location: 'Bellinzona',
      slug: registry.canonicalSlug,
      titleByLocale: {
        it: 'Informatico/a',
        en: 'Computer Scientist',
        de: 'Informatiker/in',
        fr: 'Informaticien/ne',
      },
      slugByLocale: {
        it: registry.slugByLocale.it,
        en: driftEn, // simulate AI-retranslation slug drift
        de: registry.slugByLocale.de,
        fr: registry.slugByLocale.fr,
      },
    };

    const tmp = path.join(os.tmpdir(), `harden-registry-pin-${process.pid}-${id}.json`);
    tmpFiles.push(tmp);
    fs.writeFileSync(tmp, JSON.stringify([job], null, 2), 'utf-8');

    const result = hardenJobLocaleFields({ dataJobsPath: tmp });
    expect(result.changed).toBe(true);

    const out = JSON.parse(fs.readFileSync(tmp, 'utf-8'))[0];

    // Registry slug wins over the drifted AI translation.
    expect(out.slugByLocale.en).toBe(lockedEn);

    // The drift is preserved as a bridge so the old URL keeps resolving.
    const enPrev = out.previousSlugsByLocale?.en || [];
    const allPrev = [...enPrev, ...(out.previousSlugs || [])];
    expect(allPrev).toContain(driftEn);
  });
});
