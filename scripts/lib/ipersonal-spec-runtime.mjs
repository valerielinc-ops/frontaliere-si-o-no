import { JSDOM } from 'jsdom';
import { stripHtml } from './crawler-template.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import { extractDetailFields, isSufficientVacancyDescription } from './prospector/extract.mjs';
import { resolveDetailOrListingSwissGeography } from './prospector/location-evidence.mjs';
import { runSpecInProduction, templateToRegex } from './prospector/spec-crawler.mjs';

/** @param {string | URL} value */
function canonicalUrl(value = '') {
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function removeFromBoundary(root, boundary) {
  const range = boundary.ownerDocument.createRange();
  range.setStartBefore(boundary);
  range.setEndAfter(root.lastChild);
  range.deleteContents();
}

function markParagraphLists(detail) {
  const IPERSONAL_SECTION_LIST_RX = /(?:aufgaben|anforderungen|dein profil|ihr profil|bringst du mit|bringen sie mit|erwartet (?:dich|sie)|unser angebot|das bieten wir|diese punkte)/i;
  for (const container of [detail, ...detail.querySelectorAll('*')]) {
    let listSection = false;
    for (const item of container.children) {
      const text = String(item.textContent || '').replace(/\s+/g, ' ').trim();
      const isHeading = /^H[2-4]$/.test(item.tagName)
        || (item.tagName === 'P' && text.length <= 80 && IPERSONAL_SECTION_LIST_RX.test(text));
      if (isHeading) {
        listSection = IPERSONAL_SECTION_LIST_RX.test(text);
      } else if (item.tagName === 'HR') {
        listSection = false;
      } else if (listSection && item.tagName === 'P') {
        if (text.length >= 20 && !/^[›•*-]\s*/.test(text)) item.prepend('• ');
      }
    }
  }
}

function normalizeKnownIpersonalLocalities(html = '') {
  // Züberwangen (postcode 9523) is a village in the BFS municipality Zuzwil
  // (SG), not a standalone BFS municipality. Keep the authored place name in
  // title/description, but give the strict geography gate its canonical
  // municipality so this real Swiss vacancy is not discarded.
  return String(html).replace(
    /("addressLocality"\s*:\s*")Z(?:ü|\\u00fc)berwangen("[\s\S]{0,180}?"postalCode"\s*:\s*"9523")/gi,
    '$1Zuzwil SG$2',
  ).replace(
    /("addressLocality"\s*:\s*"Heiden"[\s\S]{0,180}?"addressRegion"\s*:\s*")Appenzell Ausserrhoden(")/gi,
    '$1AR$2',
  );
}

/**
 * Extract the authored Simple Job Board body shared by iPersonal and
 * MediPersonal. The application form, site chrome and repeated contact/SEO
 * tail live outside (or after) this boundary and must not become description.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractIpersonalDescription(html = '') {
  if (!html) return '';
  const document = new JSDOM(String(html).replace(/<style\b[\s\S]*?<\/style>/gi, '')).window.document;
  const source = document.querySelector('.job-profile-section #Jobdetails')
    || document.querySelector('.job-profile-section');
  if (!source) return '';

  const detail = new JSDOM(`<body>${source.innerHTML}</body>`).window.document.body;
  detail.querySelectorAll(
    'script, style, noscript, form, nav, footer, aside, #sjb-application-form, .sjb-application-form',
  ).forEach((node) => node.remove());

  const applicationBoundary = [...detail.querySelectorAll('h2, h3, h4, p')].find((heading) =>
    /^(?:bewerben sie sich jetzt|jetzt bewerben|kontakt und bewerbung|weitere bewerbungsm[oö]glichkeiten|neugierig geworden|interessiert\b)/i
      .test(String(heading.textContent || '').replace(/\s+/g, ' ').trim()));
  if (applicationBoundary) removeFromBoundary(detail, applicationBoundary);
  markParagraphLists(detail);

  // The shared stripper preserves real <li> elements. MediPersonal's older
  // posts instead use a typographic arrow inside paragraphs; normalize both
  // representations to the same source-backed bullet contract.
  // Older MediPersonal posts contain entities escaped twice (`&amp;ouml;`).
  // Two bounded passes decode those to text without touching arbitrary markup.
  const decoded = decodeEntities(decodeEntities(stripHtml(detail.innerHTML)))
    .replace(/\s*›\s*/g, '\n• ');
  const description = decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return isSufficientVacancyDescription(description) ? description : '';
}

/**
 * Run only the two sister iPersonal specs with an identity-encoded transport.
 * Their WordPress hosts currently serve Brotli which Undici leaves compressed
 * when the SSRF dispatcher is present. Capturing the already-fetched detail
 * page lets us preserve its list structure without a second network request.
 *
 * @param {any} spec
 * @param {Record<string, any>} [runtime]
 * @returns {Promise<Array<Record<string, any>> & {
 *   discoveredCount: number,
 *   expectedSeedCount: number,
 *   loadedSeedCount: number,
 *   qualityDroppedCount: number,
 *   detailFailureCount: number,
 *   sourceIdentityCollisionCount: number,
 *   unaccountedReturnedCount: number,
 * }>}
 */
export async function runIpersonalSpecInProduction(spec, runtime = {}) {
  const pages = new Map();
  const attemptedDetailUrls = new Set();
  const resolvedDetailsByAttempt = new Map();
  const parsedDetails = new Map();
  const expectedSeedUrls = new Set(
    (spec?.seedUrls || []).map((seed) => canonicalUrl(seed)).filter(Boolean),
  );
  const loadedSeedUrls = new Set();
  const detailTemplateRx = spec?.detailTemplate ? templateToRegex(spec.detailTemplate) : null;
  const upstreamFetch = runtime.fetchImpl || globalThis.fetch;
  const upstreamDetailExtractor = runtime.detailExtractor || extractDetailFields;
  const capturingFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('Accept-Encoding', 'identity');
    const method = String(init.method || 'GET').toUpperCase();
    const inputUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url;
    let attemptedDetailUrl = '';
    if (method !== 'HEAD' && detailTemplateRx) {
      try {
        const parsed = new URL(inputUrl);
        if (detailTemplateRx.test(parsed.pathname)) {
          attemptedDetailUrl = canonicalUrl(parsed);
          attemptedDetailUrls.add(attemptedDetailUrl);
        }
      } catch { /* the public fetch policy rejects invalid URLs */ }
    }
    const response = await upstreamFetch(input, { ...init, headers });
    if (method !== 'HEAD') {
      const originalHtml = await response.clone().text();
      const canonicalInputUrl = canonicalUrl(inputUrl);
      const resolvedDetailUrl = canonicalUrl(response.url || inputUrl);
      if (attemptedDetailUrl) {
        resolvedDetailsByAttempt.set(attemptedDetailUrl, resolvedDetailUrl);
      }
      if (expectedSeedUrls.has(canonicalInputUrl) && originalHtml.trim()) {
        loadedSeedUrls.add(canonicalInputUrl);
      }
      pages.set(canonicalUrl(inputUrl), originalHtml);
      if (response.url) pages.set(canonicalUrl(response.url), originalHtml);
      const normalizedHtml = normalizeKnownIpersonalLocalities(originalHtml);
      if (normalizedHtml !== originalHtml) {
        return new Response(normalizedHtml, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    }
    return response;
  };
  const capturingDetailExtractor = (html, pageUrl) => {
    const detail = upstreamDetailExtractor(html, pageUrl);
    parsedDetails.set(canonicalUrl(pageUrl), detail);
    return detail;
  };

  const rows = await runSpecInProduction(spec, {
    ...runtime,
    fetchImpl: capturingFetch,
    detailExtractor: capturingDetailExtractor,
  });
  const enriched = rows.map((row) => {
    const description = extractIpersonalDescription(pages.get(canonicalUrl(row.url)) || '');
    return description ? { ...row, description } : row;
  });
  Object.defineProperty(enriched, 'discoveredCount', {
    value: attemptedDetailUrls.size,
    enumerable: false,
  });
  Object.defineProperty(enriched, 'expectedSeedCount', {
    value: expectedSeedUrls.size,
    enumerable: false,
  });
  Object.defineProperty(enriched, 'loadedSeedCount', {
    value: loadedSeedUrls.size,
    enumerable: false,
  });
  // Count only source-proven quality rejections. Arithmetic based solely on
  // `attempted - returned` would also bless unrelated losses (dedup bugs,
  // redirect aliasing, or a later adapter filter).
  const returnedUrls = new Set(rows.map((row) => canonicalUrl(row?.url)).filter(Boolean));
  const responseIdentityCounts = new Map();
  for (const attemptedUrl of attemptedDetailUrls) {
    const resolvedDetailUrl = resolvedDetailsByAttempt.get(attemptedUrl) || attemptedUrl;
    responseIdentityCounts.set(
      resolvedDetailUrl,
      (responseIdentityCounts.get(resolvedDetailUrl) || 0) + 1,
    );
  }
  const qualityDroppedUrls = new Set();
  const detailFailureUrls = new Set();
  for (const attemptedUrl of attemptedDetailUrls) {
    const resolvedDetailUrl = resolvedDetailsByAttempt.get(attemptedUrl) || attemptedUrl;
    if (returnedUrls.has(attemptedUrl) || returnedUrls.has(resolvedDetailUrl)) continue;
    const detail = parsedDetails.get(resolvedDetailUrl) || parsedDetails.get(attemptedUrl);
    if (!detail) {
      detailFailureUrls.add(attemptedUrl);
      continue;
    }
    const geography = resolveDetailOrListingSwissGeography(detail, {}).geography;
    const sourceMarkup = pages.get(resolvedDetailUrl) || pages.get(attemptedUrl) || '';
    const descriptionProven = isSufficientVacancyDescription(detail.description)
      || isSufficientVacancyDescription(extractIpersonalDescription(sourceMarkup));
    if (!geography || !descriptionProven) qualityDroppedUrls.add(attemptedUrl);
  }
  Object.defineProperty(enriched, 'qualityDroppedCount', {
    value: qualityDroppedUrls.size,
    enumerable: false,
  });
  Object.defineProperty(enriched, 'detailFailureCount', {
    value: detailFailureUrls.size,
    enumerable: false,
  });
  Object.defineProperty(enriched, 'sourceIdentityCollisionCount', {
    value: [...responseIdentityCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    enumerable: false,
  });
  const attemptedIdentities = new Set([
    ...attemptedDetailUrls,
    ...resolvedDetailsByAttempt.values(),
  ]);
  Object.defineProperty(enriched, 'unaccountedReturnedCount', {
    value: [...returnedUrls].filter((url) => !attemptedIdentities.has(url)).length,
    enumerable: false,
  });
  return /** @type {Array<Record<string, any>> & { discoveredCount: number, expectedSeedCount: number, loadedSeedCount: number, qualityDroppedCount: number, detailFailureCount: number, sourceIdentityCollisionCount: number, unaccountedReturnedCount: number }} */ (
    /** @type {unknown} */ (enriched)
  );
}

/**
 * Prove that an iPersonal/MediPersonal batch is a complete source snapshot.
 * A valid batch must account for every detail URL attempted by the listing
 * crawl and every published row must retain a rich, list-structured body.
 * Throws before merge/write so zero or partial runs keep the previous slice.
 *
 * @param {Array<Record<string, any>> & {
 *   discoveredCount?: number,
 *   expectedSeedCount?: number,
 *   loadedSeedCount?: number,
 *   qualityDroppedCount?: number,
 *   detailFailureCount?: number,
 *   sourceIdentityCollisionCount?: number,
 *   unaccountedReturnedCount?: number,
 * }} jobs
 * @returns {true}
 */
export function assertCompleteIpersonalSnapshot(jobs) {
  const discoveredCount = Number(jobs?.discoveredCount);
  const expectedSeedCount = Number(jobs?.expectedSeedCount);
  const loadedSeedCount = Number(jobs?.loadedSeedCount);
  const qualityDroppedCount = jobs?.qualityDroppedCount ?? 0;
  const detailFailureCount = jobs?.detailFailureCount ?? 0;
  const sourceIdentityCollisionCount = jobs?.sourceIdentityCollisionCount ?? 0;
  const unaccountedReturnedCount = jobs?.unaccountedReturnedCount ?? 0;
  if (!Number.isInteger(expectedSeedCount) || expectedSeedCount <= 0) {
    throw new Error('iPersonal snapshot incomplete: no authoritative seed count');
  }
  if (loadedSeedCount !== expectedSeedCount) {
    throw new Error(
      `iPersonal snapshot incomplete: loaded ${loadedSeedCount}/${expectedSeedCount} listing seeds`,
    );
  }
  if (!Array.isArray(jobs) || !Number.isInteger(discoveredCount) || discoveredCount <= 0) {
    throw new Error('iPersonal snapshot incomplete: no authoritative detail count');
  }
  if (!Number.isInteger(qualityDroppedCount)
    || qualityDroppedCount < 0
    || qualityDroppedCount > discoveredCount) {
    throw new Error('iPersonal snapshot incomplete: invalid quality-drop accounting');
  }
  if (!Number.isInteger(detailFailureCount)
    || detailFailureCount < 0
    || detailFailureCount !== 0) {
    throw new Error('iPersonal snapshot incomplete: detail fetch/parse failure');
  }
  if (!Number.isInteger(sourceIdentityCollisionCount)
    || sourceIdentityCollisionCount < 0
    || !Number.isInteger(unaccountedReturnedCount)
    || unaccountedReturnedCount < 0
    || sourceIdentityCollisionCount !== 0
    || unaccountedReturnedCount !== 0) {
    throw new Error('iPersonal snapshot incomplete: detail identity accounting mismatch');
  }
  if (jobs.length + qualityDroppedCount !== discoveredCount) {
    throw new Error(`iPersonal snapshot incomplete: parsed ${jobs.length}/${discoveredCount} attempted details`);
  }

  const ids = new Set();
  const urls = new Set();
  for (const job of jobs) {
    const id = String(job?.id || '').trim();
    const url = canonicalUrl(job?.url || '');
    const sourceLang = String(job?.sourceLang || '');
    const description = job?.descriptionByLocale?.[sourceLang] || job?.description || '';
    if (!id || !url || ids.has(id) || urls.has(url)) {
      throw new Error('iPersonal snapshot incomplete: missing or duplicate job identity');
    }
    if (!isSufficientVacancyDescription(description) || !/^\s*[-•*]\s/m.test(description)) {
      throw new Error(`iPersonal snapshot incomplete: ${id} lacks a rich structured description`);
    }
    ids.add(id);
    urls.add(url);
  }
  return true;
}
