// ClaimReview JSON-LD utility (AE-8)
//
// Produces schema.org ClaimReview blocks that evaluate verifiable claims
// made on our pages (tax rates, salary medians, legal deadlines, LAMal
// premium changes, ...). Signals to Google News and AI assistants that
// the claim has been fact-checked by Frontaliere Ticino.
//
// Usage:
//   import { buildClaimReview } from './claim-review';
//
//   const cr = buildClaimReview({
//     pageUrl: 'https://frontaliereticino.ch/tasse-e-pensione/nuova-legge-frontalieri-2026',
//     claimReviewed: 'La franchigia IRPEF per i nuovi frontalieri è di 10.000 euro annui',
//     datePublished: '2026-04-23',
//     rating: 'true',
//     sourceUrl: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-06-13;83',
//     sourceName: 'Legge 13 giugno 2023 n. 83 — Ratifica Accordo Italia-Svizzera',
//     claimAuthor: 'Accordo fiscale Italia-Svizzera 23/12/2023',
//     claimDatePublished: '2023-12-23',
//   });
//
// The function never mutates input. It returns a fresh JSON-LD object
// that is safe to embed directly inside a page's structuredData array.

/**
 * Supported rating buckets. Values map to schema.org reviewRating shape
 * (ratingValue 1..5 on the Frontaliere Ticino scale, bestRating 5,
 * worstRating 1, alternateName in Italian for display).
 */
export type ClaimRating =
  | 'true'
  | 'mostly-true'
  | 'mixed'
  | 'mostly-false'
  | 'false';

interface RatingDescriptor {
  ratingValue: '1' | '2' | '3' | '4' | '5';
  alternateName: string;
}

const RATING_LOOKUP: Readonly<Record<ClaimRating, RatingDescriptor>> = Object.freeze({
  'true': { ratingValue: '5', alternateName: 'Vero' },
  'mostly-true': { ratingValue: '4', alternateName: 'Generalmente vero' },
  'mixed': { ratingValue: '3', alternateName: 'Dipende' },
  'mostly-false': { ratingValue: '2', alternateName: 'Parzialmente falso' },
  'false': { ratingValue: '1', alternateName: 'Falso' },
});

export interface ClaimReviewInput {
  /** Full URL of the page hosting the claim (used for ClaimReview.url). */
  pageUrl: string;
  /** The claim text being evaluated. Must be a single factual statement. */
  claimReviewed: string;
  /** Publication date of the review (ISO YYYY-MM-DD). */
  datePublished: string;
  /** Verdict bucket. Maps to reviewRating.ratingValue + alternateName. */
  rating: ClaimRating;
  /** Authoritative source URL (AFC / AdE / Accordo bilaterale / USTAT / ecc.). */
  sourceUrl: string;
  /** Human-readable source name (e.g. "AFC Ticino — Tabella imposta alla fonte"). */
  sourceName: string;
  /** Who originally made the claim (default: page URL itself). */
  claimAuthor?: string;
  /** When the claim was originally made (ISO, default: datePublished). */
  claimDatePublished?: string;
  /** Optional summary / rationale body (<= 2 sentences). */
  reviewBody?: string;
}

export interface ClaimReviewSchema {
  '@context': 'https://schema.org';
  '@type': 'ClaimReview';
  url: string;
  claimReviewed: string;
  author: {
    '@type': 'Organization';
    name: 'Frontaliere Ticino';
    url: string;
  };
  datePublished: string;
  reviewRating: {
    '@type': 'Rating';
    ratingValue: '1' | '2' | '3' | '4' | '5';
    bestRating: '5';
    worstRating: '1';
    alternateName: string;
  };
  itemReviewed: {
    '@type': 'Claim';
    author: { '@type': 'Organization'; name: string };
    datePublished: string;
    appearance: {
      '@type': 'CreativeWork';
      url: string;
      name: string;
    };
  };
  reviewBody?: string;
}

const BASE_URL = 'https://frontaliereticino.ch';

/**
 * Build a ClaimReview JSON-LD object from high-level inputs.
 * Pure: returns a new object on every call.
 */
export function buildClaimReview(input: Readonly<ClaimReviewInput>): ClaimReviewSchema {
  const rating = RATING_LOOKUP[input.rating];
  if (!rating) {
    throw new Error(`buildClaimReview: unsupported rating "${input.rating}"`);
  }

  const claimAuthor = input.claimAuthor ?? input.pageUrl;
  const claimDatePublished = input.claimDatePublished ?? input.datePublished;

  const schema: ClaimReviewSchema = {
    '@context': 'https://schema.org',
    '@type': 'ClaimReview',
    url: input.pageUrl,
    claimReviewed: input.claimReviewed,
    author: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    datePublished: input.datePublished,
    reviewRating: {
      '@type': 'Rating',
      ratingValue: rating.ratingValue,
      bestRating: '5',
      worstRating: '1',
      alternateName: rating.alternateName,
    },
    itemReviewed: {
      '@type': 'Claim',
      author: { '@type': 'Organization', name: claimAuthor },
      datePublished: claimDatePublished,
      appearance: {
        '@type': 'CreativeWork',
        url: input.sourceUrl,
        name: input.sourceName,
      },
    },
  };

  if (input.reviewBody) {
    schema.reviewBody = input.reviewBody;
  }

  return schema;
}

/**
 * Build multiple ClaimReview entries sharing the same pageUrl + datePublished.
 * Each entry can override any field individually.
 */
export function buildClaimReviews(
  common: Readonly<Pick<ClaimReviewInput, 'pageUrl' | 'datePublished'>>,
  entries: ReadonlyArray<Omit<ClaimReviewInput, 'pageUrl' | 'datePublished'> & Partial<Pick<ClaimReviewInput, 'pageUrl' | 'datePublished'>>>
): ClaimReviewSchema[] {
  return entries.map((entry) =>
    buildClaimReview({
      ...common,
      ...entry,
    } as ClaimReviewInput),
  );
}
