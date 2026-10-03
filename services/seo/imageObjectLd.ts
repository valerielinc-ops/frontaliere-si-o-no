/**
 * imageObjectLd — Centralized builder for schema.org ImageObject JSON-LD.
 *
 * Google Search Console reports an "Improve appearance" warning when an
 * ImageObject is missing any of: `acquireLicensePage`, `copyrightNotice`,
 * `license`, `creator`, `creditText`. These five are recommended (not required)
 * but their absence prevents the image from being eligible for licensable-image
 * rich results. We treat them as required across the whole site.
 *
 * The blocking gate lives at tests/seo/image-object-license-fields.test.ts —
 * it scans dist/ and fails CI if any ImageObject lacks one of the five.
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

export const SITE_LICENSE_PAGE = 'https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini';
export const SITE_ORGANIZATION_ID = 'https://frontaliereticino.ch/#organization';

const SITE_ORG = Object.freeze({
  // Keep repeated site image creators attached to the canonical graph node.
  // A bare Organization with the same name was emitted inside every article
  // ImageObject, so crawlers saw a second anonymous publisher entity beside
  // `https://frontaliereticino.ch/#organization`.
  '@type': 'Organization' as const,
  '@id': SITE_ORGANIZATION_ID,
  name: 'Frontaliere Ticino',
  url: 'https://frontaliereticino.ch/',
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

export function resolveHttpUrl(value: unknown, fallback: unknown, field: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string') {
    throw new Error(`imageObjectLd: ${field} must be an absolute http(s) URL`);
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    // Fall through to the field-specific error below.
  }
  throw new Error(`imageObjectLd: ${field} must be an absolute http(s) URL`);
}

export interface OrganizationCreator {
  '@type': 'Organization' | 'NewsMediaOrganization' | readonly ('Organization' | 'NewsMediaOrganization')[];
  '@id'?: string;
  name: string;
  url?: string;
}

export interface PersonCreator {
  '@type': 'Person';
  name: string;
  url?: string;
}

export type ImageCreator = OrganizationCreator | PersonCreator;

/** JSON-LD permits either a single type or an array of types. */
export function isOrganizationCreatorType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) => type === 'Organization' || type === 'NewsMediaOrganization');
}

export function isSiteOrganizationCreator(value: { '@type'?: unknown; name?: unknown; url?: unknown }): boolean {
  return isOrganizationCreatorType(value['@type'])
    && value.name === SITE_ORG.name
    && (value.url === undefined || value.url === SITE_ORG.url || value.url === SITE_ORG.url.replace(/\/$/, ''));
}

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
  /** Override default license URL; must be an absolute HTTP(S) URL. */
  license?: string;
  /** Override default acquire-license URL; must be an absolute HTTP(S) URL. */
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
  creditText: string;
  caption?: string;
  width?: number | string;
  height?: number | string;
  datePublished?: string;
  inLanguage?: string;
  [key: string]: unknown;
}

/**
 * Build a fully-licensable ImageObject. Always includes the 5 GSC-required
 * recommended fields (acquireLicensePage, copyrightNotice, license, creator,
 * creditText). Pass-through for `caption`, `width`, `height`, `datePublished`,
 * `inLanguage`, and any extra fields.
 *
 * `creditText` defaults to the resolved `creator.name` (so third-party webcams
 * automatically get their source name credited) or `"Frontaliere Ticino"`
 * when the site Organization is the creator.
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

  const resolvedCreator: ImageCreator = creator
    ? {
      ...creator,
      '@type': isOrganizationCreatorType(creator['@type']) ? 'Organization' : creator['@type'],
      ...(isSiteOrganizationCreator(creator) ? { '@id': (creator as OrganizationCreator)['@id'] ?? SITE_ORGANIZATION_ID } : {}),
    }
    : { ...SITE_ORG };

  const out: ImageObjectLd = {
    '@type': 'ImageObject',
    contentUrl: resolvedUrl,
    url: resolvedUrl,
    acquireLicensePage: resolveHttpUrl(acquireLicensePage, SITE_LICENSE_PAGE, 'acquireLicensePage'),
    copyrightNotice: copyrightNotice ?? defaultCopyrightNotice(),
    license: resolveHttpUrl(license, SITE_LICENSE_PAGE, 'license'),
    creator: resolvedCreator,
    creditText: creditText ?? resolvedCreator.name,
  };

  if (caption !== undefined) out.caption = caption;
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (datePublished !== undefined) out.datePublished = datePublished;
  if (inLanguage !== undefined) out.inLanguage = inLanguage;

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
