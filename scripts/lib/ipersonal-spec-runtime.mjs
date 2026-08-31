import { JSDOM } from 'jsdom';
import { stripHtml } from './crawler-template.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import { isSufficientVacancyDescription } from './prospector/extract.mjs';
import { runSpecInProduction } from './prospector/spec-crawler.mjs';

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
      if (/^H[2-4]$/.test(item.tagName)) {
        listSection = IPERSONAL_SECTION_LIST_RX.test(String(item.textContent || ''));
      } else if (item.tagName === 'HR') {
        listSection = false;
      } else if (listSection && item.tagName === 'P') {
        const text = String(item.textContent || '').trim();
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

  const applicationBoundary = [...detail.querySelectorAll('h2, h3, h4')].find((heading) =>
    /^(?:bewerben sie sich jetzt|jetzt bewerben|kontakt und bewerbung|weitere bewerbungsm[oö]glichkeiten|neugierig geworden)/i
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
 */
export async function runIpersonalSpecInProduction(spec, runtime = {}) {
  const pages = new Map();
  const upstreamFetch = runtime.fetchImpl || globalThis.fetch;
  const capturingFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('Accept-Encoding', 'identity');
    const response = await upstreamFetch(input, { ...init, headers });
    if (String(init.method || 'GET').toUpperCase() !== 'HEAD') {
      const originalHtml = await response.clone().text();
      const inputUrl = typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url;
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

  const rows = await runSpecInProduction(spec, {
    ...runtime,
    fetchImpl: capturingFetch,
  });
  return rows.map((row) => {
    const description = extractIpersonalDescription(pages.get(canonicalUrl(row.url)) || '');
    return description ? { ...row, description } : row;
  });
}
