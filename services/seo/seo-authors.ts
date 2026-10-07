/**
 * Author profile SEO — Google News E-E-A-T compliance (FASE 1, A1).
 *
 * Builds title/description/canonical/og/jsonLd payloads for the
 * `/autori/{slug}/` profile pages.
 *
 * Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 — FASE 1, A1.
 *
 * Editorial signatures are Organizations. Real authors are Persons with the
 * public identity fields from the registry, including their `sameAs` links.
 */

import { AUTHORS, getAuthorBySlug, isRealAuthor, type Author } from '../../data/authors';
import { EDITORIAL_PROFILE_DISCLOSURE, localizeAuthor } from '../../data/authorLocales';
import { EDITORIAL_TEAM_ID, ORGANIZATION_ID } from './organizationLd';

const BASE_URL = 'https://frontaliereticino.ch';

export type AuthorLocale = 'it' | 'en' | 'de' | 'fr';

export interface AuthorSeo {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  jsonLd: Record<string, unknown>;
}

const LOCALE_LABELS: Record<AuthorLocale, { authorPrefix: string; suffix: string }> = {
  it: {
    authorPrefix: 'Autore',
    suffix: 'Frontaliere Ticino',
  },
  en: {
    authorPrefix: 'Author',
    suffix: 'Frontaliere Ticino',
  },
  de: {
    authorPrefix: 'Autor',
    suffix: 'Frontaliere Ticino',
  },
  fr: {
    authorPrefix: 'Auteur',
    suffix: 'Frontaliere Ticino',
  },
};

const AUTHOR_SLUG_BY_LOCALE: Record<AuthorLocale, string> = {
  it: 'autori',
  en: 'authors',
  de: 'autoren',
  fr: 'auteurs',
};

function buildCanonical(slug: string, locale: AuthorLocale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  const segment = AUTHOR_SLUG_BY_LOCALE[locale];
  return `${BASE_URL}${prefix}/${segment}/${slug}/`;
}

function buildDescription(author: Author): string {
  // Take the first 1-2 sentences of the bio, capped at ~160 chars to keep
  // SERP snippets clean. Falls back to role+expertise if bio is unusually short.
  // Lookbehind-free first-sentence split (Safari <16.4 compat): capture the
  // sentence-ending punctuation, drop the following whitespace, split on a NUL
  // sentinel absent from author bios — equivalent to the old /(?<=[.!?])\s+/ split.
  const firstSentence = author.bio.replace(/([.!?])\s+/g, '$1\u0000').split('\u0000')[0] ?? author.bio;
  const trimmed = firstSentence.length > 160
    ? `${firstSentence.slice(0, 157).trimEnd()}…`
    : firstSentence;
  return trimmed || `${author.role} — ${author.expertise.slice(0, 3).join(', ')}.`;
}

function buildEditorialProfileJsonLd(author: Extract<Author, { kind: 'editorial-profile' }>, canonical: string, locale: AuthorLocale): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${canonical}#profile`,
    name: author.name,
    image: `${BASE_URL}${author.photoPath}`,
    description: author.bio,
    disambiguatingDescription: EDITORIAL_PROFILE_DISCLOSURE[locale],
    url: canonical,
    ...(author.linkedin ? { sameAs: [author.linkedin] } : {}),
    knowsAbout: author.expertise,
    parentOrganization: {
      '@type': 'Organization',
      '@id': EDITORIAL_TEAM_ID,
      name: 'Redazione Frontaliere Ticino',
      url: `${BASE_URL}/chi-siamo/`,
    },
    knowsLanguage: ['it', 'en'],
  };
}

function buildRealAuthorJsonLd(author: Extract<Author, { kind: 'real-author' }>, canonical: string): Record<string, unknown> {
  const sameAs = [
    author.social.linkedin,
    author.social.twitter,
    author.social.mastodon,
    author.social.wikidataId ? `https://www.wikidata.org/wiki/${author.social.wikidataId}` : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': `${canonical}#person`,
    name: author.name,
    image: `${BASE_URL}${author.photoPath}`,
    jobTitle: author.role,
    description: author.bio,
    url: canonical,
    sameAs,
    knowsAbout: author.expertise,
    worksFor: {
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: 'Frontaliere Ticino',
    },
    knowsLanguage: ['it', 'en'],
  };
}

/**
 * Builds the SEO payload for an author profile page.
 *
 * Accepts either a slug (resolved against the static registry — used by SSG
 * and tests) or an already-resolved `Author` object. Callers holding a
 * CSR-merged author (admin `author_profiles/{slug}` patch applied on top of
 * the static registry — see `AutorePage.tsx`) MUST pass the merged object,
 * not the slug, so the emitted JSON-LD matches the visible
 * description/illustration instead of silently reverting to stale values.
 *
 * @throws Error when a slug does not match a registered author. Authors are
 *   a closed registry; an unknown slug is a programming error, not user input.
 */
export function buildAuthorSeo(authorOrSlug: string | Author, locale: AuthorLocale = 'it'): AuthorSeo {
  const original = typeof authorOrSlug === 'string' ? getAuthorBySlug(authorOrSlug) : authorOrSlug;
  const author = original ? localizeAuthor(original, locale) : undefined;
  if (!author) {
    throw new Error(`buildAuthorSeo: unknown author slug "${authorOrSlug}"`);
  }
  const labels = LOCALE_LABELS[locale];
  const canonical = buildCanonical(author.slug, locale);
  const title = `${author.name} — ${author.role} | ${labels.suffix}`;
  const description = buildDescription(author);
  const ogImage = `${BASE_URL}${author.photoPath}`;
  const jsonLd = isRealAuthor(author)
    ? buildRealAuthorJsonLd(author, canonical)
    : buildEditorialProfileJsonLd(author, canonical, locale);
  return { title, description, canonical, ogImage, jsonLd };
}

/** Returns every (slug, locale) pair so build-time generators can iterate. */
export function getAllAuthorSeoPaths(): Array<{ slug: string; locale: AuthorLocale; path: string }> {
  const out: Array<{ slug: string; locale: AuthorLocale; path: string }> = [];
  const locales: AuthorLocale[] = ['it', 'en', 'de', 'fr'];
  for (const author of AUTHORS) {
    for (const locale of locales) {
      const canonical = buildCanonical(author.slug, locale);
      out.push({ slug: author.slug, locale, path: canonical.replace(BASE_URL, '') });
    }
  }
  return out;
}
