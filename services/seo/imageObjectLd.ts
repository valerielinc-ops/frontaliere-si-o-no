/**
 * imageObjectLd — Centralized builder for schema.org ImageObject JSON-LD.
 *
 * Google Search Console reports an "Improve appearance" warning when an
 * ImageObject is missing any of: `acquireLicensePage`, `copyrightNotice`,
 * `license`, `creator`. These four are recommended (not required) but their
 * absence prevents the image from being eligible for licensable-image rich
 * results. We treat them as required across the whole site.
 *
 * The blocking gate lives at tests/seo/image-object-license-fields.test.ts —
 * it scans dist/ and fails CI if any ImageObject lacks one of the four.
 *
 * Usage:
 *   import { imageObjectLd } from '@/services/seo/imageObjectLd';
 *   const ld = imageObjectLd({ contentUrl: '...', caption: '...' });
 *
 * For webcam / third-party images, override `creator` and `license`:
 *   imageObjectLd({
 *     contentUrl: webcam.imageUrl,
 *     creator: { '@type': 'Organization', name: webcam.sourceName, url: webcam.sourceUrl },
 *     license: webcam.license,
 *     copyrightNotice: `© ${webcam.sourceName}`,
 *   });
 */

export const SITE_LICENSE_PAGE = 'https://frontaliereticino.ch/termini-di-servizio#licenza-immagini';

const SITE_ORG = Object.freeze({
  '@type': 'Organization' as const,
  name: 'Frontaliere Ticino',
  url: 'https://frontaliereticino.ch',
});

const COPYRIGHT_YEAR_START = 2024;

function currentCopyrightYear(): number {
  const now = new Date().getUTCFullYear();
  return now < COPYRIGHT_YEAR_START ? COPYRIGHT_YEAR_START : now;
}

function defaultCopyrightNotice(): string {
  const year = currentCopyrightYear();
  return year === COPYRIGHT_YEAR_START
    ? `© ${year} Frontaliere Ticino. Tutti i diritti riservati.`
    : `© ${COPYRIGHT_YEAR_START}–${year} Frontaliere Ticino. Tutti i diritti riservati.`;
}

export interface OrganizationCreator {
  '@type': 'Organization';
  name: string;
  url?: string;
}

export interface PersonCreator {
  '@type': 'Person';
  name: string;
  url?: string;
}

export type ImageCreator = OrganizationCreator | PersonCreator;

export interface ImageObjectInput {
  /**
   * Direct URL of the image bytes. Maps to schema.org `contentUrl`. If only
   * `url` is provided (legacy emitters) it is mirrored into `contentUrl`.
   */
  contentUrl?: string;
  url?: string;
  caption?: string;
  width?: number | string;
  height?: number | string;
  datePublished?: string;
  inLanguage?: string;
  /** Override default site Organization (e.g. for third-party webcams). */
  creator?: ImageCreator;
  /** Override default copyright notice. */
  copyrightNotice?: string;
  /** Override default license URL (e.g. point to source license page). */
  license?: string;
  /** Override default acquire-license URL. */
  acquireLicensePage?: string;
  /** Optional creditText (e.g. webcam source name). */
  creditText?: string;
  /** Any additional ImageObject fields to merge in (e.g. representativeOfPage). */
  [key: string]: unknown;
}

export interface ImageObjectLd {
  '@type': 'ImageObject';
  contentUrl: string;
  url: string;
  acquireLicensePage: string;
  copyrightNotice: string;
  license: string;
  creator: ImageCreator;
  caption?: string;
  width?: number | string;
  height?: number | string;
  datePublished?: string;
  inLanguage?: string;
  creditText?: string;
  [key: string]: unknown;
}

/**
 * Build a fully-licensable ImageObject. Always includes the 4 GSC-required
 * recommended fields. Pass-through for `caption`, `width`, `height`,
 * `datePublished`, `inLanguage`, `creditText`, and any extra fields.
 */
export function imageObjectLd(input: ImageObjectInput): ImageObjectLd {
  const {
    contentUrl,
    url,
    caption,
    width,
    height,
    datePublished,
    inLanguage,
    creator,
    copyrightNotice,
    license,
    acquireLicensePage,
    creditText,
    ...rest
  } = input;

  const resolvedUrl = contentUrl ?? url;
  if (!resolvedUrl) {
    throw new Error('imageObjectLd: contentUrl (or url) is required');
  }

  const out: ImageObjectLd = {
    '@type': 'ImageObject',
    contentUrl: resolvedUrl,
    url: resolvedUrl,
    acquireLicensePage: acquireLicensePage ?? SITE_LICENSE_PAGE,
    copyrightNotice: copyrightNotice ?? defaultCopyrightNotice(),
    license: license ?? SITE_LICENSE_PAGE,
    creator: creator ?? { ...SITE_ORG },
  };

  if (caption !== undefined) out.caption = caption;
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (datePublished !== undefined) out.datePublished = datePublished;
  if (inLanguage !== undefined) out.inLanguage = inLanguage;
  if (creditText !== undefined) out.creditText = creditText;

  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) out[k] = v;
  }

  return out;
}

/**
 * Same as imageObjectLd but emits a top-level JSON-LD document with @context.
 * Use when emitting a standalone <script type="application/ld+json"> block.
 */
export function imageObjectLdDocument(input: ImageObjectInput): ImageObjectLd & { '@context': 'https://schema.org' } {
  return {
    '@context': 'https://schema.org',
    ...imageObjectLd(input),
  };
}
