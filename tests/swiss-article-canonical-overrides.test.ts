import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadSwissArticleCanonicalOverrides,
  resolveSwissArticleCanonicalUrl,
} from '@/build-plugins/shared/swissArticleCanonicalOverrides';

// Issue #3010 item 1 (follow-up to PR #3000 "de-collide duplicate svizzera
// localized slugs"): the shadowed member of each near-duplicate pair
// declares a canonical/og:url pointing at its authoritative pair member
// instead of itself. Neither page is removed/noindexed (repo anti-cut rule)
// — both stay live, only the canonical *hint* changes.
const PAIRS: ReadonlyArray<{
  shadowedId: string;
  authoritativeId: string;
  locales: ReadonlyArray<{ locale: 'it' | 'en' | 'de' | 'fr'; shadowedSlug: string; authoritativeSlug: string }>;
}> = [
  {
    shadowedId: 'tassazione-frontalieri-2026-nuovo-accordo',
    authoritativeId: 'frontaliere-tassazione-2026-regole-accordo',
    locales: [
      { locale: 'it', shadowedSlug: 'tassazione-frontalieri-2026-nuovo-accordo', authoritativeSlug: 'frontaliere-tassazione-2026-regole-accordo' },
      { locale: 'en', shadowedSlug: 'cross-border-workers-taxation-2026-new-agreement', authoritativeSlug: 'cross-border-taxation-2026-new-agreement' },
      { locale: 'de', shadowedSlug: 'grenzgaenger-besteuerung-2026-neues-steuerabkommen', authoritativeSlug: 'grenzgaenger-besteuerung-2026-neues-abkommen' },
      { locale: 'fr', shadowedSlug: 'travailleurs-frontaliers-fiscalite-2026-nouvel-accord', authoritativeSlug: 'frontaliers-fiscalite-2026-nouvel-accord' },
    ],
  },
  {
    shadowedId: 'tassazione-frontalieri-oltre-20km-confine',
    authoritativeId: 'tassazione-frontalieri-oltre-20km',
    locales: [
      { locale: 'it', shadowedSlug: 'tassazione-frontalieri-oltre-20km-confine', authoritativeSlug: 'tassazione-frontalieri-oltre-20km' },
      { locale: 'en', shadowedSlug: 'taxation-cross-border-workers-beyond-20km-border', authoritativeSlug: 'taxation-cross-border-workers-beyond-20km' },
      { locale: 'de', shadowedSlug: 'besteuerung-grenzgaenger-jenseits-20km', authoritativeSlug: 'besteuerung-grenzgaenger-ueber-20km' },
      { locale: 'fr', shadowedSlug: 'imposition-frontaliers-au-dela-20km-frontiere', authoritativeSlug: 'imposition-frontaliers-au-dela-20km' },
    ],
  },
  {
    shadowedId: 'educatore-infanzia-ticino-lavoro',
    authoritativeId: 'lavorare-educatore-infanzia-ticino',
    locales: [
      { locale: 'it', shadowedSlug: 'educatore-infanzia-ticino-lavoro', authoritativeSlug: 'lavorare-educatore-infanzia-ticino' },
      { locale: 'en', shadowedSlug: 'working-as-childcare-educator-ticino-job', authoritativeSlug: 'working-as-childcare-educator-ticino' },
      { locale: 'de', shadowedSlug: 'als-kindererzieher-im-tessin-arbeiten', authoritativeSlug: 'arbeiten-als-kindererzieher-tessin' },
      { locale: 'fr', shadowedSlug: 'travailler-comme-educateur-enfance-tessin-emploi', authoritativeSlug: 'travailler-comme-educateur-enfance-tessin' },
    ],
  },
];

const OVERRIDES_PATH = resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json');
const swissArticlesSource = readFileSync(resolve(__dirname, '..', 'data', 'swiss-articles-data.ts'), 'utf-8');

describe('data/swiss-article-canonical-overrides.json (issue #3010 item 1)', () => {
  const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, OVERRIDES_PATH);

  it('loads exactly 12 entries (3 pairs x 4 locales)', () => {
    expect(Object.keys(overrides)).toHaveLength(12);
  });

  it('every shadowed locale-slug points at an absolute URL for its authoritative pair member', () => {
    for (const pair of PAIRS) {
      for (const { shadowedSlug, authoritativeSlug } of pair.locales) {
        expect(overrides[shadowedSlug]).toBeDefined();
        expect(overrides[shadowedSlug]).toMatch(/^https:\/\/frontaliereticino\.ch\//);
        expect(overrides[shadowedSlug]).toContain(`/${authoritativeSlug}/`);
      }
    }
  });

  it('never has an authoritative slug as a key (authoritative variants stay self-canonical)', () => {
    for (const pair of PAIRS) {
      for (const { authoritativeSlug } of pair.locales) {
        expect(overrides[authoritativeSlug]).toBeUndefined();
      }
    }
  });

  it('every shadowed and authoritative article id still exists in data/swiss-articles-data.ts', () => {
    for (const pair of PAIRS) {
      expect(swissArticlesSource).toContain(`id: '${pair.shadowedId}'`);
      expect(swissArticlesSource).toContain(`id: '${pair.authoritativeId}'`);
    }
  });
});

// Correction (2026-07-03, post-deploy validate-dist regression): the
// shadowed IT slug's <url> block must be DROPPED from
// public/sitemap-blog-ch.xml (and, when present, public/sitemap-news.xml) —
// the same convention data/job-canonical-overrides.json already uses for
// jobs. Listing a sitemap <loc> whose own page canonicalizes elsewhere is a
// hard CI gate failure with no exception
// (scripts/audit-sitemap-canonicals.mjs / scripts/validate-sitemap-pages.mjs,
// "Sitemap <loc> URLs MUST self-canonicalize"). The authoritative slug MUST
// stay present (it is the self-canonical winner). RSS is untouched on
// purpose — see build-plugins/shared/swissArticleCanonicalOverrides.ts.
describe('shadowed pair slugs are dropped from the sitemap, not just canonical-hinted', () => {
  const sitemapBlogCh = readFileSync(resolve(__dirname, '..', 'public', 'sitemap-blog-ch.xml'), 'utf-8');
  const sitemapNews = readFileSync(resolve(__dirname, '..', 'public', 'sitemap-news.xml'), 'utf-8');

  for (const pair of PAIRS) {
    const itPair = pair.locales.find((l) => l.locale === 'it')!;

    it(`${pair.shadowedId} (/${itPair.shadowedSlug}/) is ABSENT from sitemap-blog-ch.xml`, () => {
      expect(sitemapBlogCh).not.toContain(`/articoli-svizzera/${itPair.shadowedSlug}/</loc>`);
    });

    it(`${pair.authoritativeId} (/${itPair.authoritativeSlug}/) is PRESENT in sitemap-blog-ch.xml (self-canonical winner)`, () => {
      expect(sitemapBlogCh).toContain(`/articoli-svizzera/${itPair.authoritativeSlug}/</loc>`);
    });

    it(`${pair.shadowedId} (/${itPair.shadowedSlug}/) is ABSENT from sitemap-news.xml`, () => {
      expect(sitemapNews).not.toContain(`/articoli-svizzera/${itPair.shadowedSlug}/</loc>`);
    });
  }
});

describe('loadSwissArticleCanonicalOverrides (safe defaults)', () => {
  it('returns {} when the file is missing (never throws, never blocks the build)', () => {
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync }, resolve(__dirname, 'does-not-exist.json'));
    expect(overrides).toEqual({});
  });

  it('drops non-absolute-http values and non-string keys/values', () => {
    const fakeReadFileSync = (() => JSON.stringify({
      overrides: {
        'good-slug': 'https://frontaliereticino.ch/articoli-svizzera/winner/',
        'relative-slug': '/articoli-svizzera/winner/',
        'number-value': 12345,
      },
    })) as unknown as typeof readFileSync;
    const overrides = loadSwissArticleCanonicalOverrides({ readFileSync: fakeReadFileSync }, 'irrelevant-path.json');
    expect(overrides).toEqual({ 'good-slug': 'https://frontaliereticino.ch/articoli-svizzera/winner/' });
  });
});

describe('resolveSwissArticleCanonicalUrl', () => {
  const overrides = { 'shadowed-slug': 'https://frontaliereticino.ch/articoli-svizzera/winner/' };

  it('returns the override URL for a shadowed slug', () => {
    expect(resolveSwissArticleCanonicalUrl('shadowed-slug', overrides, 'https://frontaliereticino.ch/articoli-svizzera/shadowed-slug/'))
      .toBe('https://frontaliereticino.ch/articoli-svizzera/winner/');
  });

  it('falls back to defaultUrl (self-canonical) for any slug with no override entry', () => {
    expect(resolveSwissArticleCanonicalUrl('winner-slug', overrides, 'https://frontaliereticino.ch/articoli-svizzera/winner-slug/'))
      .toBe('https://frontaliereticino.ch/articoli-svizzera/winner-slug/');
  });
});
