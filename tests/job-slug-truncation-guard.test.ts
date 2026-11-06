/**
 * A locale slug must never lose the employer's trade.
 *
 * Live case (2026-10-23): "Macchinista M1, M2,M3" (PEMSA, Lugano) got the
 * EN/DE/FR title "M1, M2" from machine translation, so the variants were served
 * at `/de/jobs-im-tessin/m1-m2-pemsa-lugano/` — the trade gone from the URL.
 * The registry then pinned that slug as a "real translation". These tests fix
 * the shared rule (scripts/lib/job-title-identity.mjs) and prove the writers
 * converge instead of undoing each other's repair.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hardenJobLocaleFields, registryPinnedLocaleSlug } from '../scripts/lib/dedicated-crawler-common.mjs';
import { slugDropsTitleWords } from '../scripts/regenerate-slugs-by-locale.mjs';
import { buildSlug } from '../scripts/lib/regenerate-slugs-helpers.mjs';
import { losslessSlugTitle, slugDropsSourceWords } from '../scripts/lib/job-title-identity.mjs';

const SOURCE_TITLE = 'Macchinista M1, M2,M3';
const SOURCE_SLUG = 'macchinista-m1-m2-m3-pemsa-lugano';
const TRUNCATED_SLUG = 'm1-m2-pemsa-lugano';

describe('lossless slug title', () => {
  it('derives the slug from the employer title when the translation dropped the trade', () => {
    expect(losslessSlugTitle('M1, M2', SOURCE_TITLE)).toBe(SOURCE_TITLE);
    expect(buildSlug(losslessSlugTitle('M1, M2', SOURCE_TITLE), 'PEMSA', 'Lugano')).toBe(SOURCE_SLUG);
  });
  it('keeps a real translation, good or bad, as the slug title', () => {
    expect(losslessSlugTitle('Machinist M1, M2, M3', SOURCE_TITLE)).toBe('Machinist M1, M2, M3');
    expect(losslessSlugTitle('Software Engineer', 'Software Engineer (m/w/d)')).toBe('Software Engineer');
  });
  it('recognises a truncated slug once company and location are removed', () => {
    expect(slugDropsTitleWords(TRUNCATED_SLUG, SOURCE_TITLE, 'PEMSA', 'Lugano')).toBe(true);
    expect(slugDropsTitleWords(SOURCE_SLUG, SOURCE_TITLE, 'PEMSA', 'Lugano')).toBe(false);
    expect(slugDropsTitleWords('machinist-m1-m2-m3-pemsa-lugano', SOURCE_TITLE, 'PEMSA', 'Lugano')).toBe(false);
    expect(slugDropsSourceWords('m1-m2', SOURCE_TITLE)).toBe(true);
  });
});

describe('registryPinnedLocaleSlug truncation guard', () => {
  const registered = {
    canonicalSlug: SOURCE_SLUG,
    slugByLocale: { it: SOURCE_SLUG, de: TRUNCATED_SLUG, en: 'machinist-m1-m2-m3-pemsa-lugano' },
  };
  const ctx = { sourceTitle: SOURCE_TITLE, company: 'PEMSA', location: 'Lugano', disambiguator: '' };

  it('refuses to pin a slug that only drops words of the employer title', () => {
    expect(registryPinnedLocaleSlug(registered, 'de', 'it', ctx)).toBeNull();
  });
  it('still pins a real translation', () => {
    expect(registryPinnedLocaleSlug(registered, 'en', 'it', ctx)).toBe('machinist-m1-m2-m3-pemsa-lugano');
  });
  it('keeps the prior behaviour when no source title is supplied', () => {
    expect(registryPinnedLocaleSlug(registered, 'de', 'it')).toBe(TRUNCATED_SLUG);
  });
});

const tmpFiles: string[] = [];
const previousRegistryOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  if (previousRegistryOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousRegistryOverride;
});

describe('hardenJobLocaleFields does not undo a truncation repair', () => {
  it('keeps the repaired DE slug although the registry still holds the truncated one', () => {
    const tenant = '9998';
    const id = '777';
    const registryPath = path.join(os.tmpdir(), `slug-truncation-registry-${process.pid}.json`);
    tmpFiles.push(registryPath);
    fs.writeFileSync(registryPath, JSON.stringify({
      [`id|recruitingapp-${tenant}.umantis.com|${id}`]: {
        canonicalSlug: SOURCE_SLUG,
        slugByLocale: { it: SOURCE_SLUG, en: TRUNCATED_SLUG, de: TRUNCATED_SLUG, fr: TRUNCATED_SLUG },
      },
    }), 'utf-8');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;

    // State after regenerate-slugs-by-locale repaired the truncated slots.
    const job = {
      id: `umantis-${id}`,
      url: `https://recruitingapp-${tenant}.umantis.com/Vacancies/${id}/Description/1`,
      title: SOURCE_TITLE,
      sourceLang: 'it',
      company: 'PEMSA',
      location: 'Lugano',
      slug: SOURCE_SLUG,
      titleByLocale: { it: SOURCE_TITLE, en: 'M1, M2', de: 'M1, M2', fr: 'M1, M2' },
      slugByLocale: { it: SOURCE_SLUG, en: SOURCE_SLUG, de: SOURCE_SLUG, fr: SOURCE_SLUG },
    };
    const tmp = path.join(os.tmpdir(), `slug-truncation-harden-${process.pid}.json`);
    tmpFiles.push(tmp);
    fs.writeFileSync(tmp, JSON.stringify([job], null, 2), 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: tmp });
    const [after] = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    for (const locale of ['en', 'de', 'fr']) {
      expect(after.slugByLocale[locale]).not.toBe(TRUNCATED_SLUG);
      expect(after.slugByLocale[locale]).toContain('macchinista');
    }
  });
});
