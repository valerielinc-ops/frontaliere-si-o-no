import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCanonicalJobDetailPath } from '../../build-plugins/shared/jobDetailPath';

const locales = ['it', 'en', 'de', 'fr'] as const;
const relatedSections = {
  it: 'cerca-lavoro-turgovia',
  en: 'find-jobs-thurgau',
  de: 'jobs-im-thurgau',
  fr: 'trouver-emploi-thurgovie',
} as const;

const hostPageJob = {
  canton: 'BS',
  location: 'Basel',
  slugByLocale: {
    it: 'annuncio-ospite-basilea',
    en: 'host-job-basel',
    de: 'gaststelle-basel',
    fr: 'emploi-hote-bale',
  },
};

const relatedJob = {
  canton: 'TG',
  location: 'Frauenfeld',
  slugByLocale: {
    it: 'annuncio-correlato-turgovia',
    en: 'related-job-thurgau',
    de: 'verwandte-stelle-thurgau',
    fr: 'emploi-lie-thurgovie',
  },
};

describe('canonical job detail paths', () => {
  it('uses the linked job canton, not the host page canton, in every locale', () => {
    for (const locale of locales) {
      const hostPath = buildCanonicalJobDetailPath(
        locale,
        hostPageJob,
        hostPageJob.slugByLocale[locale],
      );
      const relatedPath = buildCanonicalJobDetailPath(
        locale,
        relatedJob,
        relatedJob.slugByLocale[locale],
      );

      expect(relatedPath).toMatch(/\/$/);
      expect(relatedPath).not.toBe(hostPath);
      expect(relatedPath).toBe(`/${locale === 'it' ? '' : `${locale}/`}${relatedSections[locale]}/${relatedJob.slugByLocale[locale]}/`);
      expect(relatedPath).toContain(relatedJob.slugByLocale[locale]);
      expect(relatedPath).not.toContain('basilea');
    }
  });

  it('keeps a pre-resolved canton on the same canonical path', () => {
    for (const locale of locales) {
      const resolvedOnce = buildCanonicalJobDetailPath(
        locale,
        relatedJob,
        relatedJob.slugByLocale[locale],
      );
      const emittedRelatedHref = buildCanonicalJobDetailPath(
        locale,
        relatedJob,
        relatedJob.slugByLocale[locale],
        relatedJob.canton,
      );

      expect(emittedRelatedHref).toBe(resolvedOnce);
    }
  });

  it('keeps the active emitter on the same canonical-path function', () => {
    const source = readFileSync(
      join(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'),
      'utf8',
    );

    expect(source).toContain('const perLocaleCanonicalPath = {');
    expect(source).toContain('const relPath = perLocaleCanonicalPath[locale];');
    expect(source).toContain('const canonicalPath = withSlash(relPath);');
    expect(source).toContain('const perJob_relatedCanonicalPaths = perJob_related.map');
    expect(source).toContain('const href = rPaths[locale];');
    expect(source).not.toContain(
      'buildCantonAwareSection(locale, jobCanton)}/${localizedSlug(r, locale)',
    );
  });
});
