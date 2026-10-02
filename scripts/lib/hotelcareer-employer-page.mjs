/**
 * Hotelcareer employer page (`https://www.hotelcareer.ch/jobs/<employer>-<id>`):
 * the source-proven zero of the crawlers that read their employer from it
 * (vereinaklosters, blatters-hotel).
 *
 * The employer page lists every open vacancy as a link below its own path
 * (`/jobs/<employer>-<id>/<vacancy>-<id>`). When the employer has none,
 * Hotelcareer serves the same page — canonical URL, contact block, footer —
 * with an explicit sentence in the jobs box instead of the result list:
 *
 *   <div id="companyProfileJobsSmall" …> … Jobs …
 *     <div class="companyProfileContent">
 *       Dieses Unternehmen sucht aktuell nicht nach Verstärkung. …
 *
 * (hotel-vereina-52746, verified live on 2026-10-01; Blatter's page serves a
 * `<ul class="resultlist">` with its one vacancy in the same box.) That page is
 * the employer's own statement: vereinaklosters.ch/jobs links it as "offene
 * Stellen". Without reading it the crawler can only report "the parser found
 * nothing", which the health monitor cannot tell from a dead selector.
 *
 * The proof is positive and fail-closed (authoritative-empty-snapshot.mjs
 * contract): the page must be the employer's canonical page, carry the
 * explicit sentence inside the jobs box, have no result list there and no
 * vacancy link below the employer path anywhere. A challenge page, another
 * employer, a page with any vacancy link or an unknown wording is NOT a zero.
 */
import { readAttr, readMetaContent, scanStartTags } from './html-attr.mjs';
import { looksLikeAntiBotChallenge } from './jina-proxy.mjs';

/** Empty-state wording of the jobs box, as served on hotelcareer.ch (German). */
export const HOTELCAREER_NO_VACANCY_SENTENCES = Object.freeze([
  'Dieses Unternehmen sucht aktuell nicht nach Verstärkung',
]);

const JOBS_BOX_ID = 'companyProfileJobsSmall';
// The box is a heading plus one content div; the window only has to cover it.
const JOBS_BOX_WINDOW = 2000;

/** @param {string} value */
function normalizeText(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** @param {string} pathname */
function normalizePath(pathname = '') {
  let path = String(pathname || '').trim();
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  return path.replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {string} rawUrl
 * @returns {URL|null} a hotelcareer.ch URL, or null
 */
function hotelcareerUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === 'hotelcareer.ch' || host.endsWith('.hotelcareer.ch') ? url : null;
  } catch {
    return null;
  }
}

/**
 * The page's own canonical URL (`<link rel="canonical">`, else `og:url`).
 *
 * @param {string} html
 * @returns {string}
 */
function canonicalUrl(html) {
  const link = scanStartTags(html, 'link')
    .find(({ raw }) => readAttr(raw, 'rel').toLowerCase().split(/\s+/).includes('canonical'));
  return (link ? readAttr(link.raw, 'href') : '') || readMetaContent(html, 'og:url');
}

/**
 * True when any anchor on the page points below the employer path, i.e. to one
 * of its vacancies (relative or absolute, any Hotelcareer host).
 *
 * @param {string} html
 * @param {string} employerPath normalised employer path
 * @param {string} baseUrl
 */
function hasVacancyLink(html, employerPath, baseUrl) {
  return scanStartTags(html, 'a').some(({ raw }) => {
    const href = readAttr(raw, 'href');
    if (!href) return false;
    let url;
    try { url = new URL(href.replace(/&amp;/g, '&'), baseUrl); } catch { return false; }
    if (!hotelcareerUrl(url.href)) return false;
    return normalizePath(url.pathname).startsWith(`${employerPath}/`);
  });
}

/**
 * Evidence that a Hotelcareer employer page states it has no open vacancy, or
 * null when the page does not prove it.
 *
 * @param {string} html page body (direct, clean-IP or browser rendered)
 * @param {string} employerPath e.g. `/jobs/hotel-vereina-52746`
 * @returns {string|null} human-readable evidence for markAuthoritativeEmptySnapshot
 */
export function hotelcareerEmptyEmployerPageEvidence(html = '', employerPath = '') {
  const source = String(html || '');
  const expectedPath = normalizePath(employerPath);
  if (!source || !expectedPath || looksLikeAntiBotChallenge(source)) return null;

  const canonical = hotelcareerUrl(canonicalUrl(source));
  if (!canonical || normalizePath(canonical.pathname) !== expectedPath) return null;

  const boxStart = source.indexOf(`id="${JOBS_BOX_ID}"`);
  if (boxStart < 0) return null;
  const box = source.slice(boxStart, boxStart + JOBS_BOX_WINDOW);
  // A result list in the box is a vacancy list, whatever else the box says.
  if (/class\s*=\s*["'][^"']*\bresultlist\b/i.test(box)) return null;
  const boxText = normalizeText(box.replace(/<[^>]+>/g, ' '));
  const sentence = HOTELCAREER_NO_VACANCY_SENTENCES
    .find((candidate) => boxText.includes(normalizeText(candidate)));
  if (!sentence) return null;

  if (hasVacancyLink(source, expectedPath, canonical.href)) return null;

  return `Hotelcareer employer page ${canonical.origin}${canonical.pathname}: `
    + `"${sentence}", no vacancy link below ${expectedPath}/`;
}
