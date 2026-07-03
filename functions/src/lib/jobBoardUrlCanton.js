/**
 * Derive a canton code from a job-board URL a subscriber landed on
 * (`consent_source_url`/`source_page` on `newsletter_subscribers/{email}`).
 * Ported from `services/router.ts` (`parseJobBoardSlug`, `JOB_BOARD_PREFIX`)
 * since Cloud Functions have no bundler and cannot import that TS module —
 * see `cantonUrlSlugs.json` for the shared-data duplication note.
 *
 * Deliberately conservative: only resolves single-canton job-board URLs.
 * The Switzerland-wide aggregator (`cerca-lavoro-svizzera` etc.) and the
 * half-canton URL groups (`APPENZELLO`, `BASILEA` — real member canton
 * AI/AR or BL/BS can't be told apart from the URL alone) return `null`
 * rather than a signal too broad or ambiguous to act on.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {{cantons: Record<string, {it: string, en: string, de: string, fr: string, dePrefix?: string}>}} */
const CANTON_URL_SLUGS = require('./cantonUrlSlugs.json');

const JOB_BOARD_PREFIX = {
  it: 'cerca-lavoro-',
  en: 'find-jobs-',
  de: 'jobs-in-',
  fr: 'trouver-emploi-',
};
const JOB_BOARD_PREFIX_LEGACY_DE = 'jobs-im-'; // legacy TI-only, e.g. jobs-im-tessin

const AMBIGUOUS_GROUP_CODES = new Set(['APPENZELLO', 'BASILEA']);

/**
 * @param {string} pathSegment  first non-locale path segment, e.g. `cerca-lavoro-ticino`
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {string|null}  2-letter canton code, or null if unresolved/ambiguous
 */
function parseJobBoardSegment(pathSegment, locale) {
  if (!pathSegment) return null;

  if (locale === 'de' && pathSegment === `${JOB_BOARD_PREFIX_LEGACY_DE}tessin`) {
    return 'TI';
  }

  if (locale === 'de') {
    for (const [code, record] of Object.entries(CANTON_URL_SLUGS.cantons)) {
      if (record.dePrefix && pathSegment === `${record.dePrefix}${record.de}`) {
        return AMBIGUOUS_GROUP_CODES.has(code) ? null : code;
      }
    }
  }

  const prefix = JOB_BOARD_PREFIX[locale];
  if (!pathSegment.startsWith(prefix)) return null;
  const tail = pathSegment.slice(prefix.length);
  if (!tail) return null;

  for (const [code, record] of Object.entries(CANTON_URL_SLUGS.cantons)) {
    if (record[locale] === tail) {
      return AMBIGUOUS_GROUP_CODES.has(code) ? null : code;
    }
  }

  return null;
}

/**
 * @param {string|null|undefined} url  absolute URL or path, e.g.
 *   `https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/` or
 *   `/fr/trouver-emploi-valais/some-job/`
 * @returns {string|null}  lowercase 2-letter canton code (e.g. `'ti'`), or null
 */
export function deriveCantonFromJobBoardUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let pathname;
  try {
    pathname = new URL(url, 'https://frontaliereticino.ch').pathname;
  } catch {
    return null;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return null;

  const locale = ['en', 'de', 'fr'].includes(segments[0]) ? segments[0] : 'it';
  const boardSegment = locale === 'it' ? segments[0] : segments[1];

  const cantonCode = parseJobBoardSegment(boardSegment, locale);
  return cantonCode ? cantonCode.toLowerCase() : null;
}
