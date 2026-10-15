import { describe, expect, it } from 'vitest';
import { expiredJobSlugVariants } from '../build-plugins/shared/expiredSlugVariants';

/**
 * Guards the slug-divergence bridge that fixes "empty orphan" soft-landing
 * pages: a job whose slug churned (vendor rename, company/location suffix
 * change, expiry) gets re-archived into an expired slice, and the build plugin
 * must resolve the OLD indexed orphan URL to that recovered content via any of
 * the job's historical slug variants.
 *
 * Modelled on the real USI PhD case (André Corboz SNSF project): the indexed EN
 * orphan URL `/en/find-jobs-ticino/phd-position-as-part-of-snsf-project-andre-
 * corboz-...` is only the job's `slugByLocale.en`; its primary slug is a
 * different IT variant. Keying solely on the orphan slug rendered it empty.
 */
describe('expiredJobSlugVariants', () => {
  it('returns the canonical slug first', () => {
    const variants = expiredJobSlugVariants({ slug: 'primary-slug', slugByLocale: { en: 'en-slug' } });
    expect(variants[0]).toBe('primary-slug');
  });

  it('collects slug, slugByLocale, previousSlugs and previousSlugsByLocale', () => {
    const variants = expiredJobSlugVariants({
      slug: 'p',
      slugByLocale: { it: 'p', en: 'en-x', de: 'de-x', fr: 'fr-x' },
      previousSlugs: ['old-1'],
      previousSlugsByLocale: { en: ['old-en-1', 'old-en-2'], de: ['old-de-1'] },
    });
    expect(new Set(variants)).toEqual(
      new Set(['p', 'en-x', 'de-x', 'fr-x', 'old-1', 'old-en-1', 'old-en-2', 'old-de-1']),
    );
  });

  it('dedups repeated slugs (slug === slugByLocale.it is common)', () => {
    const variants = expiredJobSlugVariants({ slug: 'p', slugByLocale: { it: 'p', en: 'en-x' } });
    expect(variants).toEqual(['p', 'en-x']);
  });

  it('ignores non-string / empty / malformed fields without throwing', () => {
    expect(expiredJobSlugVariants({})).toEqual([]);
    expect(
      expiredJobSlugVariants({
        slug: '',
        slugByLocale: { en: '', de: null as unknown as string, fr: 123 as unknown as string },
        previousSlugs: [null, '', 'ok'] as unknown[],
        previousSlugsByLocale: { en: 'not-an-array' as unknown as string[] },
      }),
    ).toEqual(['ok']);
  });

  it('resolves the indexed orphan URL to the recovered job via slugByLocale.en (USI Corboz case)', () => {
    const recovered = {
      slug: 'posizione-di-dottorato-nell-ambito-del-progetto-del-fns-usi-mendrisio',
      slugByLocale: {
        it: 'posizione-di-dottorato-nell-ambito-del-progetto-del-fns-l-ermeneutica-della-forma-urbana-e',
        en: 'phd-position-as-part-of-snsf-project-andre-corboz-s-hermeneutics-of-urban-and-territorial-',
        de: 'promotion-im-rahmen-des-snf-projekts-andre-corboz-s-hermeneutics-of-urban-and-territorial-',
      },
      descriptionByLocale: { en: 'PhD position as part of SNSF project...' },
    };
    // Build the same kind of index the plugin builds.
    const expiredBySlug = new Map<string, typeof recovered>();
    for (const v of expiredJobSlugVariants(recovered)) {
      if (!expiredBySlug.has(v)) expiredBySlug.set(v, recovered);
    }
    const orphanEnSlug = 'phd-position-as-part-of-snsf-project-andre-corboz-s-hermeneutics-of-urban-and-territorial-';
    expect(expiredBySlug.get(orphanEnSlug)).toBe(recovered);
    expect(expiredBySlug.get(orphanEnSlug)?.descriptionByLocale.en).toContain('PhD position');
  });
});
