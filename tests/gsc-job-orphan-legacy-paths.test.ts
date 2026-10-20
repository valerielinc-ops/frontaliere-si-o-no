import { describe, expect, it } from 'vitest';
import { mergeGscJobOrphans, urlToOrphan } from '../scripts/lib/gsc-job-orphans.mjs';
import { sectionPathFromOrphan } from '../build-plugins/jobOrphanBridgePlugin';

const jobSections = {
  it: new Set(['cerca-lavoro-ticino']),
  en: new Set(['find-jobs-ticino']),
  de: new Set(['jobs-im-tessin']),
  fr: new Set(['trouver-emploi-tessin']),
};

describe('GSC job-orphan paths', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('recognizes the shared legacy /lavoro route (%s)', (locale) => {
    const prefix = locale === 'it' ? '' : `/${locale}`;
    const url = `https://frontaliereticino.ch${prefix}/lavoro/legacy-job-slug/`;
    expect(urlToOrphan(url, jobSections)).toEqual({ locale, slug: 'legacy-job-slug', url });
  });

  it('continues to recognize current localized job sections', () => {
    expect(urlToOrphan('https://frontaliereticino.ch/fr/trouver-emploi-tessin/job-slug/', jobSections))
      .toMatchObject({ locale: 'fr', slug: 'job-slug' });
    expect(urlToOrphan('https://frontaliereticino.ch/de/jobs-im-tessin/job-slug/', jobSections))
      .toMatchObject({ locale: 'de', slug: 'job-slug' });
  });

  it.each([
    'https://frontaliereticino.ch/fr/articles-frontalier/editorial-slug/',
    'https://frontaliereticino.ch/de/grenzgaenger-artikel/editorial-slug/',
    'https://frontaliereticino.ch/fr/lavoro/',
    'https://frontaliereticino.ch/lavoro/ricerca-fisioterapista/',
  ])('does not ingest non-job or job-hub paths (%s)', (url) => {
    expect(urlToOrphan(url, jobSections)).toBeNull();
  });

  it('keeps distinct section URLs even when locale and slug are equal', () => {
    const one = { locale: 'de', slug: 'same-slug', url: 'https://frontaliereticino.ch/de/jobs-in-bern/same-slug/', kind: 'expired' };
    const two = { ...one, url: 'https://frontaliereticino.ch/de/jobs-in-zurich/same-slug/' };
    expect(mergeGscJobOrphans([], [one, two])).toEqual([one, two]);
  });

  it('updates a route when re-imported but retains routes absent from a later sample', () => {
    const oldRoute = { locale: 'fr', slug: 'old', url: 'https://frontaliereticino.ch/fr/lavoro/old/', kind: 'expired' };
    const refreshedRoute = {
      ...oldRoute,
      url: 'https://frontaliereticino.ch/fr//lavoro/old/',
      kind: 'expired-tracked',
    };
    const unrelated = { locale: 'de', slug: 'other', url: 'https://frontaliereticino.ch/de/lavoro/other/', kind: 'expired' };
    expect(mergeGscJobOrphans([oldRoute, unrelated], [refreshedRoute])).toEqual([refreshedRoute, unrelated]);
  });

  it.each([
    ['fr', 'https://frontaliereticino.ch/fr/lavoro/fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl/', '/fr/trouver-emploi-tessin/'],
    ['de', 'https://frontaliereticino.ch/de/lavoro/fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl/', '/de/jobs-im-tessin/'],
  ] as const)('canonicalizes an expired %s legacy job to the live localized board', (locale, url, canonicalPath) => {
    const entry = {
      locale,
      slug: 'fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl',
      url,
      kind: 'expired' as const,
    };
    expect(sectionPathFromOrphan(entry)).toBe(canonicalPath);
  });
});
