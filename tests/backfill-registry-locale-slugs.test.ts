/**
 * Guards the slug-registry per-locale backfill (fix for the recurring slug-drift
 * orphan, real-world case: Swiss Life Workday `_R11696`).
 *
 * Root cause: `registerJobSlug` is immutable per-ENTRY (first write wins) and
 * only captures the locales a job carried when FIRST seen. A job first
 * registered before its AI localization finished therefore pins ONLY its
 * source-locale slug; the locales translated later are never added to the
 * registry, so `registryPinnedLocaleSlug` returns null for them and they are
 * re-derived from the (non-deterministic) AI title on every crawl → per-locale
 * slug churn → the old per-locale URL is stranded with no redirect (it falls
 * through to the noindex "offer updated" soft-landing).
 *
 * `backfillRegistryLocaleSlugs` makes the registry immutable per-LOCALE: it ADDS
 * a locale the first time a REAL translation exists, never overwrites a pinned
 * locale, and skips source-copies (a non-source locale whose slug merely copies
 * the source slug — pinning it would lock a copy in permanently).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillRegistryLocaleSlugs } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('backfillRegistryLocaleSlugs (unit)', () => {
  it('adds missing REAL translations and leaves the pinned locale untouched', () => {
    const registered = { canonicalSlug: 'conseiller-ch', slugByLocale: { en: 'conseiller-ch' } };
    const job = {
      sourceLang: 'en',
      slugByLocale: {
        en: 'conseiller-ch',
        it: 'consulente-sion',
        de: 'immobilienberater-sion',
        fr: 'conseiller-ch', // byte-copy of the source (en) slug → no real FR translation yet
      },
    };
    const added = backfillRegistryLocaleSlugs(registered, job, 'en');
    expect(added).toBe(2); // it + de only
    expect(registered.slugByLocale).toEqual({
      en: 'conseiller-ch',
      it: 'consulente-sion',
      de: 'immobilienberater-sion',
      // fr intentionally absent — source-copy, stays free to settle later
    });
  });

  it('never overwrites a locale the registry already pinned (immutable per-locale)', () => {
    const registered = { canonicalSlug: 'x', slugByLocale: { en: 'en-pinned', it: 'it-pinned' } };
    const job = { sourceLang: 'en', slugByLocale: { en: 'en-pinned', it: 'it-DRIFTED', de: 'de-real' } };
    const added = backfillRegistryLocaleSlugs(registered, job, 'en');
    expect(added).toBe(1); // only de
    expect(registered.slugByLocale.it).toBe('it-pinned'); // NOT the drifted value
    expect(registered.slugByLocale.de).toBe('de-real');
  });

  it('corrects a source-COPY slot once a real translation exists (KSBL sub-class)', () => {
    // fr is occupied but merely copies the en (source) slug → never served as
    // canonical (registryPinnedLocaleSlug nulls it), so it must be overwritten
    // by the genuine FR translation, not masked by the "already occupied" guard.
    const registered = { canonicalSlug: 'advisor-ch', slugByLocale: { en: 'advisor-ch', fr: 'advisor-ch' } };
    const job = { sourceLang: 'en', slugByLocale: { en: 'advisor-ch', fr: 'conseiller-sion', it: 'consulente-sion' } };
    const added = backfillRegistryLocaleSlugs(registered, job, 'en');
    expect(added).toBe(2); // fr (corrected) + it (added)
    expect(registered.slugByLocale.fr).toBe('conseiller-sion'); // source-copy replaced by real translation
    expect(registered.slugByLocale.it).toBe('consulente-sion');
    expect(registered.slugByLocale.en).toBe('advisor-ch'); // source slot untouched
  });

  it('is a no-op when the job carries no per-locale slugs', () => {
    const registered = { canonicalSlug: 'x', slugByLocale: { en: 'en' } };
    expect(backfillRegistryLocaleSlugs(registered, { sourceLang: 'en' }, 'en')).toBe(0);
    expect(backfillRegistryLocaleSlugs(null as unknown as object, {}, 'en')).toBe(0);
  });
});

describe('mergeAndDeduplicate backfills the registry for early-registered jobs', () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    for (const f of tmpFiles.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* gone */ }
    }
  });

  it('persists the later-translated locales (it/de) but skips the FR source-copy', async () => {
    const URL = 'https://recruitingapp-2908.umantis.com/Vacancies/7777/Description/1';
    const FP = 'id|recruitingapp-2908.umantis.com|7777';
    const EN = 'real-estate-advisor-sion-swiss-life-ch';
    const REAL_IT = 'consulente-immobiliare-sion-swiss-life-sion';
    const REAL_DE = 'immobilienberater-sion-swiss-life-sion';

    // Registry seeded as it would have been at first registration, before AI
    // localization filled it/de/fr — only the source (en) locale is pinned.
    const registry = { [FP]: { canonicalSlug: EN, slugByLocale: { en: EN }, createdAt: '2026-04-11', canton: 'VS' } };
    const regPath = path.join(os.tmpdir(), `backfill-reg-${process.pid}.json`);
    fs.writeFileSync(regPath, JSON.stringify(registry), 'utf-8');
    tmpFiles.push(regPath);
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;

    const { mergeAndDeduplicate } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const freshCrawl = {
      id: 'swiss-life-7777',
      url: URL,
      title: 'Real estate advisor',
      company: 'Swiss Life',
      location: 'Sion',
      canton: 'VS',
      sourceLang: 'en',
      description: 'x'.repeat(200),
      crawledAt: '2026-06-28T22:38:49Z',
      source: 'Company Careers Crawler',
      titleByLocale: { it: 'Consulente immobiliare', en: 'Real estate advisor', de: 'Immobilienberater', fr: 'Conseiller en immobilier' },
      slug: REAL_IT,
      // it/de are genuine translations; fr is still a byte-copy of the en slug.
      slugByLocale: { it: REAL_IT, en: EN, de: REAL_DE, fr: EN },
    };

    mergeAndDeduplicate([], [freshCrawl], {});

    const saved = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    expect(saved[FP].slugByLocale.en).toBe(EN); // untouched
    expect(saved[FP].slugByLocale.it).toBe(REAL_IT); // backfilled
    expect(saved[FP].slugByLocale.de).toBe(REAL_DE); // backfilled
    expect(saved[FP].slugByLocale.fr).toBeUndefined(); // source-copy → NOT pinned
  });
});
