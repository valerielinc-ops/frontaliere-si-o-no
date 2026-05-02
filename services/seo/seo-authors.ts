/**
 * Author profile SEO — Google News E-E-A-T compliance (FASE 1, A1).
 *
 * Builds title/description/canonical/og/jsonLd payloads for the
 * `/autori/{slug}/` profile pages.
 *
 * Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 — FASE 1, A1.
 *
 * The Person JSON-LD shape mirrors the spec exactly: stable `@id`,
 * `worksFor` reference to `#organization`, `sameAs` for KG signals, and
 * `knowsAbout` populated from {@link Author.expertise}.
 */

import { AUTHORS, getAuthorBySlug, type Author } from '@/data/authors';

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
  const firstSentence = author.bio.split(/(?<=[.!?])\s+/)[0] ?? author.bio;
  const trimmed = firstSentence.length > 160
    ? `${firstSentence.slice(0, 157).trimEnd()}…`
    : firstSentence;
  return trimmed || `${author.role} — ${author.expertise.slice(0, 3).join(', ')}.`;
}

function buildPersonJsonLd(author: Author, canonical: string): Record<string, unknown> {
  const sameAs = [
    author.social.linkedin,
    author.social.twitter,
    author.social.mastodon,
    author.social.wikidataId
      ? `https://www.wikidata.org/wiki/${author.social.wikidataId}`
      : undefined,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

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
    worksFor: { '@id': `${BASE_URL}/#organization` },
    knowsLanguage: ['it', 'en'],
  };
}

/**
 * Builds the SEO payload for an author profile page.
 *
 * @throws Error when the slug does not match a registered author. Authors are
 *   a closed registry; an unknown slug is a programming error, not user input.
 */
export function buildAuthorSeo(slug: string, locale: AuthorLocale = 'it'): AuthorSeo {
  const author = getAuthorBySlug(slug);
  if (!author) {
    throw new Error(`buildAuthorSeo: unknown author slug "${slug}"`);
  }
  const labels = LOCALE_LABELS[locale];
  const canonical = buildCanonical(slug, locale);
  const title = `${author.name} — ${author.role} | ${labels.suffix}`;
  const description = buildDescription(author);
  const ogImage = `${BASE_URL}${author.photoPath}`;
  const jsonLd = buildPersonJsonLd(author, canonical);
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
