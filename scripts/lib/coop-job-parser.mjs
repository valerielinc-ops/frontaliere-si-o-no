/**
 * Coop — Detail page parser for post-processing.
 *
 * After the base crawler runs, this module re-validates each Coop job
 * against the JSON-LD data on the detail page to fix title mismatches
 * and ensure description quality.
 */

import { JSDOM } from 'jsdom';
import { fetch as undiciFetch } from 'undici';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { inferAnyCanton, isCantonOnlyLabel, normalizeSwissTargetLocationText } from './target-swiss-locations.mjs';
import { SWISS_CANTONS } from './crawler-location-config.mjs';
import { MIN_SOURCE_BODY_WORDS, meetsSourceBodyFloor, sourceBodyWordCount } from './source-body-floor.mjs';
import { preferLocationEncodedCanton } from './job-location-display.mjs';
import {
  createSpecUrlPolicy,
  fetchFollowingValidatedRedirects,
} from './prospector/public-fetch-policy.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';
import { transferSlugHistory } from './expired-jobs-archive.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Title overlap guard
// ─────────────────────────────────────────────────────────────

function normWords(s = '') {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function titleOverlap(expected = '', actual = '') {
  const expWords = normWords(expected);
  const actWords = new Set(normWords(actual));
  if (expWords.length === 0) return 1;
  return expWords.filter((w) => actWords.has(w)).length / expWords.length;
}

// ─────────────────────────────────────────────────────────────
// JSON-LD extraction from Coop detail pages
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a Coop detail page and read both its JSON-LD JobPosting and the
 * per-vacancy content the page renders outside it
 * (`extractCoopFamilyPageDetails`). Returns `null` when the page or its
 * JSON-LD is unavailable, exactly like `fetchCoopJsonLd`.
 */
export async function fetchCoopDetailPage(url, timeoutMs = 12000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  let rejectTimeout;
  const timeoutError = new Error(`Coop detail request timed out after ${timeoutMs}ms.`);
  timeoutError.name = 'TimeoutError';
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(timeoutError);
  }, timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            Accept: 'text/html',
            'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
          },
        });
        if (!res.ok) return null;
        const html = await res.text();
        const jsonLd = extractJsonLd(html);
        return jsonLd ? { jsonLd, page: extractCoopFamilyPageDetails(html) } : null;
      })(),
      timeoutPromise,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a Coop detail page and extract the JSON-LD JobPosting data.
 */
export async function fetchCoopJsonLd(url, timeoutMs = 12000) {
  return (await fetchCoopDetailPage(url, timeoutMs))?.jsonLd || null;
}

/**
 * Extract JSON-LD JobPosting from HTML.
 */
export function extractJsonLd(html = '') {
  // Permissive regex: tolerate single quotes, reordered attributes and a
  // missing/relocated `type=` — mirrors the robust extractor introduced for
  // Straumann (straumann-job-parser.mjs). Coop is ~95% of job volume, so a
  // silent regex miss on markup drift would drop recoverable listings.
  const matches = [...String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of matches) {
    try {
      const data = JSON.parse(m[1]);
      // Handle bare object, top-level array and @graph containers; match
      // `@type` as array/string via includes() instead of strict equality.
      const candidates = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
      for (const node of candidates) {
        if (String(node?.['@type'] || '').includes('JobPosting')) return node;
      }
    } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// HTML → Markdown converter for JSON-LD description
// ─────────────────────────────────────────────────────────────

export function coopDescHtmlToMarkdown(html = '') {
  if (!html || !html.trim()) return '';

  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  if (!root) return '';

  const lines = [];

  function processNode(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toLowerCase();

      if (/^h[1-3]$/.test(tag)) {
        const text = normalizeSpace(child.textContent);
        if (text) lines.push('', `## ${text}`);
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        const items = child.querySelectorAll(':scope > li');
        for (const li of items) {
          const text = normalizeSpace(li.textContent);
          if (text) lines.push(`- ${text}`);
        }
        continue;
      }

      if (tag === 'li') continue;
      if (tag === 'br') continue;

      if (tag === 'div') {
        const text = normalizeSpace(child.textContent);
        if (!text) continue;
        // Check if this div is a section header (short, followed by ul)
        const next = child.nextElementSibling;
        const isHeader = text.length < 60 && (next?.tagName?.toLowerCase() === 'ul' || next?.tagName?.toLowerCase() === 'br');
        if (isHeader && !text.includes('.')) {
          lines.push('', `## ${text}`);
        } else {
          // Recurse into div with children, or output text for leaf divs
          const hasChildElements = Array.from(child.childNodes).some((n) => n.nodeType === 1);
          if (hasChildElements) {
            processNode(child);
          } else {
            lines.push(text);
          }
        }
        continue;
      }

      if (tag === 'p') {
        const hasChildElements = Array.from(child.childNodes).some((n) => n.nodeType === 1);
        if (hasChildElements) {
          processNode(child);
        } else {
          const text = normalizeSpace(child.textContent);
          if (text) lines.push(text);
        }
        continue;
      }

      // Default: recurse
      processNode(child);
    }
  }

  processNode(root);

  // Deduplicate consecutive identical lines
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' && result.length > 0 && result[result.length - 1].trim() === '') continue;
    if (result.length > 0 && result[result.length - 1].trim() === trimmed && trimmed !== '') continue;
    result.push(trimmed);
  }

  return result.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// Detail-page content that the JSON-LD description does not carry
// ─────────────────────────────────────────────────────────────
//
// The Prospective JobBooster detail pages of the Coop-family tenants (Coop,
// Fust, Jumbo, Interdiscount, fenaco/Volg/LANDI) render per-vacancy content
// OUTSIDE `JobPosting.description`, and that description is all the parser
// used to publish:
//   - fenaco's generic template puts only the intro and the recruiter into the
//     JSON-LD; tasks and profile live in `<article id="tasks|skills">` and the
//     benefits in `.benefit` cards (166/555 volg-fenaco records had no task or
//     requirement at all — 509 published chars against a 4160-char page);
//   - every template labels the vacancy's own facts — workplace address,
//     Pensum, start date, contract term — in `.job-data`, `#info-section`,
//     `.box` or the `.banner-stats` row. Without them seventeen Coop
//     "Verkäufer:in Food" vacancies in seventeen different Zürich stores
//     published one identical body.
// Only labelled facts, list-bearing role sections and benefit cards are read;
// contact, application process, sharing, similar-jobs and print/modal blocks
// are chrome and stay out.

const PAGE_CHROME_TOKEN_RE = /contact|kontakt|process|share|other-jobs|similar|video|modal|sidebar|print-only|footer|stepstone|savelater|save-later/i;
// Application-process steps are rendered as a list in an anonymous <section>
// on the fenaco template: the heading is the only thing that names them.
const PAGE_CHROME_HEADING_RE = /bewerbungsprozess|bewerbungsablauf|bewerbungsinformation|processus de (?:candidature|recrutement)|processo di (?:candidatura|selezione)|application process|recruiting process/i;

function pageNodeText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  // <br> separates address lines ("Coop<br>Albisriederstrasse 334<br>8047
  // Zürich") and sentences alike: join with a comma unless the line already
  // ends a sentence.
  const BREAK = '\u2029';
  for (const br of clone.querySelectorAll('br')) br.replaceWith(BREAK);
  return String(clone.textContent || '')
    .split(BREAK)
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .reduce((text, line) => (!text ? line : `${text}${/[.!?:;,]$/.test(text) ? ' ' : ', '}${line}`), '')
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

function isInPageChrome(node) {
  for (let el = node; el && el.tagName && el.tagName !== 'BODY'; el = el.parentElement) {
    const tokens = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    if (PAGE_CHROME_TOKEN_RE.test(tokens)) return true;
  }
  return false;
}

// Some fenaco postings type the list by hand: "&bull;item<br/>&bull;item".
function bulletLinesOf(container, heading) {
  const clone = container.cloneNode(true);
  const ownHeading = [...clone.querySelectorAll('h2')].find((h) => normalizeSpace(h.textContent) === normalizeSpace(heading.textContent));
  ownHeading?.remove();
  for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of clone.querySelectorAll('p, div')) block.append('\n');
  const rawLines = String(clone.textContent || '').split('\n').map((line) => normalizeSpace(line)).filter(Boolean);
  // Only a hand-typed LIST qualifies: contact cards, "Über uns" prose and fact
  // tables also break lines with <br>/<div>, but never start them with bullets.
  const bulleted = rawLines.filter((line) => /^[•·▪◦]/.test(line)).length;
  if (bulleted < 2 || bulleted * 2 < rawLines.length) return [];
  return rawLines.map((line) => line.replace(/^[•·▪◦]\s*/, '')).filter((line) => line.length > 1);
}

function listItemsForHeading(heading) {
  for (let node = heading.parentElement; node && node.tagName !== 'BODY'; node = node.parentElement) {
    if (node.querySelectorAll('h2').length > 1) return [];
    const items = [...node.querySelectorAll('li')].map(pageNodeText).filter(Boolean);
    if (items.length > 0) return items;
    if (node === heading.parentElement) {
      const lines = bulletLinesOf(node, heading);
      if (lines.length > 0) return lines;
    }
  }
  return [];
}

function decodeCodePoint(raw, radix) {
  const codePoint = Number.parseInt(raw, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => decodeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => decodeCodePoint(code, 16))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** Decode a workplace value read from page markup or an analytics JS literal. */
export function normalizeCoopFamilyWorkplace(value = '') {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\([\\'"/])/g, '$1')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The workplace a Coop-family detail page declares for THIS vacancy.
 * Prospective's JSON-LD stamps the employer's head office (Fust: Oberbüren,
 * Interdiscount: Jegenstorf) as the job location on the Fust/Jumbo/
 * Interdiscount template; the page carries the real workplace in the
 * `job_arbeitsort` analytics field and in a localized workplace section.
 * Returns '' when the page declares none (the fenaco and Coop templates render
 * an address block, kept by `extractCoopFamilyPageDetails().facts`).
 * Moved here from `update-fust-jobs.mjs` so discovery and detail enrichment
 * read the workplace with one implementation.
 */
export function extractCoopFamilyWorkplace(html = '') {
  const source = String(html || '');
  const singleQuoted = source.match(/\bjob_arbeitsort\s*:\s*'((?:\\.|[^'\\])*)'/i);
  const doubleQuoted = source.match(/\bjob_arbeitsort\s*:\s*"((?:\\.|[^"\\])*)"/i);
  const analyticsValue = singleQuoted?.[1] || doubleQuoted?.[1] || '';
  const analyticsWorkplace = normalizeCoopFamilyWorkplace(analyticsValue);
  if (analyticsWorkplace && analyticsWorkplace.toLowerCase() !== 'fust') return analyticsWorkplace;

  // The French Interdiscount template has no `job_arbeitsort` and titles the
  // section "Lieu du travail": reading only "Lieu de travail" published its
  // Signy and Bassecourt apprenticeships at the Jegenstorf head office.
  const section = source.match(
    /<h4[^>]*>\s*(?:<b[^>]*>)?\s*(?:arbeitsort|lieu\s+d[eu]\s+travail|luogo\s+di\s+lavoro)\s*(?:<\/b>)?\s*<\/h4>\s*<p[^>]*>([\s\S]{0,500}?)<\/p>/i
  );
  const addressLines = String(section?.[1] || '')
    .split(/<br\s*\/?\s*>/i)
    .map((line) => normalizeCoopFamilyWorkplace(line))
    .filter((line) => line && line.toLowerCase() !== 'fust');
  const workplaceLine = addressLines.at(-1) || '';
  return normalizeCoopFamilyWorkplace(workplaceLine.replace(/^\d{4}\s+/, ''));
}

/**
 * Read the per-vacancy content a Coop-family detail page renders outside its
 * JSON-LD description (see the block comment above). Pure; never throws.
 *
 * @returns {{ workplace: string, facts: Array<{label: string, value: string}>,
 *   sections: Array<{heading: string, items: string[]}>,
 *   benefits: { heading: string, items: string[] } }}
 */
export function extractCoopFamilyPageDetails(html = '') {
  const empty = { workplace: '', facts: [], sections: [], benefits: { heading: '', items: [] } };
  const source = String(html || '');
  if (!source.trim()) return empty;
  let dom;
  try {
    dom = new JSDOM(source.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
  } catch {
    return empty;
  }
  try {
    return readCoopFamilyPage(dom.window.document, source);
  } finally {
    dom.window.close();
  }
}

function readCoopFamilyPage(doc, source) {
  const facts = [];
  const seenLabels = new Set();
  const pushFact = (rawLabel, rawValue) => {
    const label = normalizeSpace(rawLabel).replace(/:$/, '');
    const value = rawValue;
    const key = label.toLowerCase();
    if (!label || !value || label.length > 40 || value.length > 200 || seenLabels.has(key)) return;
    seenLabels.add(key);
    facts.push({ label, value });
  };
  for (const label of doc.querySelectorAll('.job-data label')) {
    if (!isInPageChrome(label)) pushFact(label.textContent, pageNodeText(label.nextElementSibling));
  }
  for (const row of doc.querySelectorAll('tr')) {
    const label = row.querySelector('td.label');
    const value = row.querySelector('td.text');
    if (label && value && !isInPageChrome(row)) pushFact(label.textContent, pageNodeText(value));
  }
  for (const box of doc.querySelectorAll('.box')) {
    const label = box.querySelector('h4');
    const value = box.querySelector('p');
    if (label && value && !isInPageChrome(box)) pushFact(label.textContent, pageNodeText(value));
  }
  let labelledBanner = false;
  for (const stat of doc.querySelectorAll('.banner-stats [aria-label]')) {
    if (isInPageChrome(stat)) continue;
    labelledBanner = true;
    pushFact(stat.getAttribute('aria-label') || '', pageNodeText(stat));
  }
  // The Fust/Jumbo/Interdiscount template labels nothing: its banner row is
  // workplace, department and (apprenticeships) "Lehrdauer von … bis …". The
  // last banner copy is the one that spells the period out.
  if (!labelledBanner) {
    const banners = [...doc.querySelectorAll('.banner-stats')].filter((banner) => !isInPageChrome(banner));
    const seenValues = new Set();
    for (const label of banners.at(-1)?.querySelectorAll('.banner-stats-label') || []) {
      const value = pageNodeText(label);
      if (!value || value.length > 200 || seenValues.has(value.toLowerCase())) continue;
      seenValues.add(value.toLowerCase());
      facts.push({ label: '', value });
    }
  }

  const sections = [];
  const seenHeadings = new Set();
  for (const heading of doc.querySelectorAll('h2')) {
    const title = pageNodeText(heading);
    const key = title.toLowerCase();
    if (!title || title.length > 120 || seenHeadings.has(key) || isInPageChrome(heading)) continue;
    if (PAGE_CHROME_HEADING_RE.test(title)) continue;
    if (heading.closest('#benefits-section, #vorteile, #benefits, #benefits-list')) continue;
    const items = [...new Set(listItemsForHeading(heading))];
    if (items.length === 0) continue;
    seenHeadings.add(key);
    sections.push({ heading: title, items });
  }

  const benefitItems = [];
  let benefitsHeading = '';
  for (const card of doc.querySelectorAll('.benefit')) {
    if (isInPageChrome(card)) continue;
    const title = pageNodeText(card.querySelector('.benefitTitle, .benefit-title'));
    const text = pageNodeText(card.querySelector('.benefitText, .benefit-text'));
    const item = title && text ? `${title}: ${text}` : (title || text || pageNodeText(card));
    if (item && !benefitItems.includes(item)) benefitItems.push(item);
    if (!benefitsHeading) {
      const container = card.closest('section') || card.parentElement?.parentElement;
      benefitsHeading = pageNodeText(container?.querySelector('h2'));
    }
  }

  return {
    workplace: extractCoopFamilyWorkplace(source),
    facts,
    sections,
    benefits: { heading: benefitsHeading, items: benefitItems },
  };
}

function containmentKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Publish the JSON-LD description together with what only the page carries:
 * the labelled facts first (the page shows them above the role), then the
 * JSON-LD body, then every list section and the benefit cards the body does
 * not already contain. A section whose items the JSON-LD already carries for
 * the most part is the same section in other words and is not repeated.
 */
export function composeCoopFamilyDescription(markdown = '', page = null) {
  const base = String(markdown || '').trim();
  if (!page) return base;
  const known = containmentKey(base);
  const isKnown = (item) => {
    const key = containmentKey(item);
    return Boolean(key) && known.includes(key);
  };
  const bodyLines = base ? base.split('\n') : [];
  const appended = [];
  const addList = (heading, items) => {
    const missing = items.filter((item) => !isKnown(item));
    if (missing.length === 0 || missing.length * 2 < items.length) return;
    const lines = missing.map((item) => `- ${item}`);
    // Same heading already in the JSON-LD body: extend that list in place
    // instead of publishing the heading twice.
    const headingKey = containmentKey(heading);
    const at = headingKey
      ? bodyLines.findIndex((line) => /^#{2,4}\s/.test(line) && containmentKey(line) === headingKey)
      : -1;
    if (at >= 0) {
      let end = at + 1;
      while (end < bodyLines.length && (bodyLines[end].startsWith('- ') || bodyLines[end].trim() === '')) {
        if (bodyLines[end].trim() === '' && !bodyLines[end + 1]?.startsWith('- ')) break;
        end += 1;
      }
      bodyLines.splice(end, 0, ...lines);
      return;
    }
    appended.push([heading ? `## ${heading}` : '', ...lines].filter(Boolean).join('\n'));
  };
  for (const section of page.sections || []) addList(section.heading, section.items || []);
  addList(page.benefits?.heading || '', page.benefits?.items || []);

  const blocks = [];
  const factLines = (page.facts || []).map(({ label, value }) => (label ? `- ${label}: ${value}` : `- ${value}`));
  if (factLines.length > 0) blocks.push(factLines.join('\n'));
  const body = bodyLines.join('\n').trim();
  if (body) blocks.push(body);
  blocks.push(...appended);
  return blocks.join('\n\n');
}

/**
 * Move the routes of a collapsed repost onto the record that replaces it.
 * Two reposts of one ad usually share their freshly built slug (same title,
 * same place): a slug the keeper already serves is not a route to bridge, and
 * handing it to `transferSlugHistory` would record the keeper's own URL as its
 * previous slug.
 */
function absorbRepublishedRoutes(keeper, removed) {
  const active = new Set([keeper?.slug, ...Object.values(keeper?.slugByLocale || {})].filter(Boolean));
  const foreign = (slug) => Boolean(slug) && !active.has(slug);
  const entriesOf = (map) => Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {});
  const routes = {
    slug: foreign(removed?.slug) ? removed.slug : '',
    slugByLocale: Object.fromEntries(entriesOf(removed?.slugByLocale).filter(([, slug]) => foreign(slug))),
    previousSlugs: (Array.isArray(removed?.previousSlugs) ? removed.previousSlugs : []).filter(foreign),
    previousSlugsByLocale: Object.fromEntries(entriesOf(removed?.previousSlugsByLocale)
      .map(([locale, slugs]) => [locale, (Array.isArray(slugs) ? slugs : []).filter(foreign)])
      .filter(([, slugs]) => slugs.length > 0)),
  };
  const hasRoutes = routes.slug || routes.previousSlugs.length > 0
    || Object.keys(routes.slugByLocale).length > 0 || Object.keys(routes.previousSlugsByLocale).length > 0;
  return hasRoutes ? transferSlugHistory(keeper, routes, 'coop-job-parser.collapseRepublishedCoopVacancies') : 0;
}

/**
 * Collapse the same vacancy published several times under different UUIDs:
 * same title, same store (postal code AND street — a city alone is not a
 * store: Zürich has dozens) and a byte-identical body, facts included (so a
 * different Pensum or start date keeps two postings apart). An authoritative
 * source reference is a second proof: when it matches, publication and expiry
 * dates may differ because those fields describe the repost, not the offer.
 * Measured on the 2026-09-29 Coop slice: "Transportdisponent:in" three times
 * at Industriestrasse 109, 9200 Gossau with one text. By default records
 * without a full store address are never collapsed: two UUIDs without a street
 * can be two vacancies of one role, and collapsing them would drop a live page
 * (Coop's two "Detailhandelsfachfrau:mann EFZ" apprenticeships at Heiden,
 * pages identical but for the ATS tracking id, stay two records).
 *
 * The source-backed Coop and Volg runners may opt into the stricter case-
 * (c) proof after their detail pages have been accepted: when the source
 * itself supplies no distinguishing address, identical published fields
 * (title, body, locality, employer and contract/category fields) are one
 * reader-visible advertisement. The caller must identify the records whose
 * detail pages supplied that proof; a listing fallback alone never opts in.
 *
 * The earliest-seen record is kept, so the published URL/slug that search
 * engines already know survives, and it absorbs every route of the records it
 * replaces (`transferSlugHistory`, the slug-history bridge also used by
 * `reconcile-crawler-company-ownership.mjs`): their indexed URLs redirect to
 * it instead of answering 404. The replaced records are returned so the caller
 * can report them.
 *
 * @param {{
 *   allowIdenticalSourcePostingsWithoutAddress?: boolean,
 *   sourceBackedUrls?: Iterable<string>,
 * }} [options]
 * @returns {{ kept: object[], collapsed: Array<{url: string, keptUrl: string}> }}
 */
export function collapseRepublishedCoopVacancies(jobs = [], {
  allowIdenticalSourcePostingsWithoutAddress = false,
  sourceBackedUrls = [],
} = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const sourceBackedUrlSet = new Set(sourceBackedUrls || []);
  const normalizedIdentityValue = (value) => {
    if (value && typeof value === 'object') return JSON.stringify(value);
    return normalizeSpace(value || '').toLowerCase();
  };
  const sourceBacked = (job) => job?._enrichedFromDetail === true || sourceBackedUrlSet.has(job?.url);
  const sourceIdenticalKey = (job) => {
    if (!sourceBacked(job)) return '';
    // Salary fields are parser estimates/legacy annotations on these slices,
    // not an attribute shown by the fetched Coop/fenaco detail page; they must
    // not turn one source advertisement into two SEO pages.
    const title = normalizeSpace(job?.title || '');
    const description = normalizeSpace(job?.description || '');
    const location = normalizeSpace(job?.location || job?.addressLocality || '');
    const employer = normalizeSpace(job?.company || job?.companyKey || '');
    if (!title || !description || !location || !employer) return '';
    const sourceReference = normalizeSpace(job?.sourceReference || '');
    return [
      sourceReference,
      title,
      description,
      location,
      job?.addressLocality,
      job?.addressRegion || job?.canton,
      job?.postalCode,
      job?.streetAddress,
      employer,
      job?.companyKey,
      job?.contract,
      job?.contractType,
      job?.employmentType,
      job?.workload,
      job?.category,
      job?.sector,
      job?.department,
      job?.requirements,
      ...(sourceReference ? [] : [job?.datePosted, job?.validThrough]),
      job?.addressCountry || job?.country,
    ].map(normalizedIdentityValue).join('\u0000');
  };
  const keyOf = (job) => {
    const postalCode = normalizeSpace(job?.postalCode || '');
    const streetAddress = normalizeSpace(job?.streetAddress || '');
    const description = normalizeSpace(job?.description || '');
    if (postalCode && streetAddress && description) {
      return `address\u0000${[job?.title, job?.location, postalCode, streetAddress, description]
      .map((value) => normalizeSpace(value || '').toLowerCase())
      .join('\u0000')}`;
    }
    if (allowIdenticalSourcePostingsWithoutAddress) {
      const sourceKey = sourceIdenticalKey(job);
      if (sourceKey) return `source\u0000${sourceKey}`;
    }
    return '';
  };
  const rank = (job) => [
    String(job?.firstSeenAt || '9999'),
    String(job?.postedDate || '9999'),
    String(job?.url || ''),
  ].join('|');
  const keeperByKey = new Map();
  for (const job of input) {
    const key = keyOf(job);
    if (!key) continue;
    const current = keeperByKey.get(key);
    if (!current || rank(job) < rank(current)) keeperByKey.set(key, job);
  }
  const kept = [];
  const collapsed = [];
  for (const job of input) {
    const key = keyOf(job);
    const keeper = key ? keeperByKey.get(key) : null;
    if (keeper && keeper !== job) {
      absorbRepublishedRoutes(keeper, job);
      collapsed.push({ url: job.url, keptUrl: keeper.url });
    } else {
      kept.push(job);
    }
  }
  return { kept, collapsed };
}

/**
 * `collapseRepublishedCoopVacancies` for the standard-pipeline runners (Jumbo,
 * Interdiscount): returns the kept records, logs each collapse and keeps the
 * enricher's non-enumerable `.detailDrop` summary on the returned array.
 */
export function withoutRepublishedCoopVacancies(jobs = [], label = 'Coop-family') {
  const { kept, collapsed } = collapseRepublishedCoopVacancies(jobs);
  for (const { url, keptUrl } of collapsed) console.log(`  ↪️ Republished ${label} vacancy ${url} collapsed into ${keptUrl}`);
  if (jobs?.detailDrop) {
    Object.defineProperty(kept, 'detailDrop', { value: jobs.detailDrop, enumerable: false, configurable: true });
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────
// JSON-LD canton normalization. The shared inference covers all 26 cantons;
// these overrides only cover localized labels absent from the canton data.
// ─────────────────────────────────────────────────────────────

const COOP_CANTON_LABEL_OVERRIDES = {
  'regione di basilea': 'BL',
  nidwaldo: 'NW',
  obwaldo: 'OW',
};

export function resolveCoopCantonCode(raw = '', locality = '', fallback = '') {
  const lower = String(raw || '').trim().toLowerCase();
  const override = COOP_CANTON_LABEL_OVERRIDES[lower];
  if (override) return override;
  return inferAnyCanton(raw) || inferAnyCanton(locality) || fallback || '';
}

/**
 * The adapter seed is the workplace evidence from the listing row. Some Coop
 * detail pages publish the employer's registered address as JSON-LD instead;
 * keep the seed as a location candidate so that detail enrichment cannot move
 * a branch vacancy to the generic head office. Leave `addressLocality` empty:
 * multi-site labels such as "Region Zürich (Sihlcity und Umgebung)" are valid
 * source evidence but are not one municipality and must not be guessed into a
 * different address.
 */
function adapterSeedAddressEvidence(job) {
  const scope = job?._targetScope;
  const location = normalizeSpace(scope?.location || '');
  const canton = normalizeSpace(scope?.canton || '');
  if (!location || !canton) return null;
  const sourceCanton = preferLocationEncodedCanton(location, canton);
  if (!sourceCanton) return null;
  const candidate = {
    location,
    addressLocality: '',
    addressRegion: sourceCanton,
    addressCountry: 'CH',
    postalCode: '',
    streetAddress: '',
  };
  const geography = resolveCoopJsonLdGeography(candidate);
  // The source adapter can intentionally publish a regional wrapper that the
  // municipality resolver cannot reduce to one city (for example
  // "Region Muri AG"). Keep that source-backed label and its explicit canton
  // rather than replacing it with the detail page's employer address.
  return {
    candidate,
    geography: geography || {
      location,
      canton: sourceCanton,
      addressCountry: 'CH',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Apply JSON-LD location/company data to a job object (pure fn)
// ─────────────────────────────────────────────────────────────

/**
 * Apply detail-page company data and location evidence to a job object. An
 * explicit adapter seed wins over a conflicting detail JSON-LD address because
 * the latter is often the employer's registered address, not the workplace.
 * Returns { job, changed } where `job` is a shallow copy with updated fields.
 */
export function applyCoopJsonLdToJob(job, jsonLd) {
  const updated = { ...job };
  let changed = false;

  const detailCandidate = jsonLdAddressCandidates(jsonLd)[0] || {};
  const ldLocality = detailCandidate.addressLocality || '';
  const ldRegion = detailCandidate.addressRegion || '';
  const detailGeography = resolveCoopJsonLdGeography(detailCandidate);
  const seedEvidence = adapterSeedAddressEvidence(job);
  const seedMatchesDetail = Boolean(seedEvidence && detailGeography)
    && normalizeSwissTargetLocationText(seedEvidence.geography.location)
      === normalizeSwissTargetLocationText(detailGeography.location)
    && normalizeSwissTargetLocationText(seedEvidence.geography.canton)
      === normalizeSwissTargetLocationText(detailGeography.canton);
  const seedOverridesDetail = Boolean(seedEvidence)
    && !seedMatchesDetail;
  const selectedGeography = seedOverridesDetail
    ? seedEvidence.geography
    : detailGeography;
  const selectedLocation = selectedGeography?.location || ldLocality;
  const selectedCanton = selectedGeography?.canton
    || (ldRegion || ldLocality ? resolveCoopCantonCode(ldRegion, ldLocality, updated.canton) : '');

  if (selectedLocation && selectedLocation !== updated.addressLocality) {
    updated.location = selectedLocation;
    updated.addressLocality = selectedLocation;
    changed = true;
  }
  // The detail address is the branch's own (Coop publishes one vacancy per
  // store: "Albisriederstrasse 334, 8047 Zürich"): keep its street and postal
  // code, which the record used to drop, leaving seventeen Zürich stores with
  // one address. When the adapter seed overrides the detail, a street from the
  // detail would be pinned to another place, so any stale one is removed.
  const detailAddressSelected = !seedOverridesDetail && Boolean(detailGeography)
    && selectedLocation === detailGeography.location;
  for (const field of ['postalCode', 'streetAddress']) {
    const next = detailAddressSelected ? normalizeSpace(detailCandidate[field] || '') : '';
    const current = normalizeSpace(updated[field] || '');
    if (next && next !== current) {
      updated[field] = next;
      changed = true;
    } else if (!detailAddressSelected && seedOverridesDetail && current) {
      delete updated[field];
      changed = true;
    }
  }
  if (selectedCanton) {
    if (selectedCanton !== updated.canton) {
      updated.canton = selectedCanton;
      updated.addressRegion = selectedCanton;
      changed = true;
    }
    if (selectedCanton !== updated.addressRegion) {
      updated.addressRegion = selectedCanton;
      changed = true;
    }
  }

  // Company update — use store-specific name if more specific than "Coop" alone
  const ldCompany = (jsonLd?.hiringOrganization?.name || '').trim();
  if (ldCompany && ldCompany.length > 4 && ldCompany !== updated.company) {
    updated.company = ldCompany;
    changed = true;
  }

  return { job: updated, changed };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

/**
 * Whether a converted source body may be published. The length floor is the
 * shared word floor (`source-body-floor.mjs`, Non-Negotiable #4): the former
 * 200-character minimum and the 400-character rule for unstructured text let
 * bodies of 20-49 words through or stopped longer ones, depending on word
 * length. The coverage ratio stays: it compares the converted text with the
 * source HTML to catch a conversion that lost most of the markup's content.
 */
export function validateCoopDescription(markdown = '', sourceHtmlLength = 0) {
  const warnings = [];
  const textLength = markdown.replace(/[#\-*>\n]/g, ' ').replace(/\s+/g, ' ').trim().length;
  const wordCount = sourceBodyWordCount(markdown);

  if (!meetsSourceBodyFloor(markdown)) {
    warnings.push(`Description too short: ${wordCount} words (minimum ${MIN_SOURCE_BODY_WORDS})`);
  }

  if (sourceHtmlLength > 0) {
    const ratio = textLength / sourceHtmlLength;
    if (ratio < 0.15) {
      warnings.push(`Coverage ratio too low: ${(ratio * 100).toFixed(1)}% (minimum 15%)`);
    }
  }

  return { ok: warnings.length === 0, warnings, textLength, wordCount };
}

function jsonLdAddressCandidates(jsonLd = {}) {
  const locations = Array.isArray(jsonLd?.jobLocation) ? jsonLd.jobLocation : [jsonLd?.jobLocation];
  return locations.filter(Boolean).map((location) => {
    const address = location?.address || {};
    const addressLocality = String(address.addressLocality || '').trim();
    const rawRegion = String(address.addressRegion || '').trim();
    // Prospective sometimes duplicates the municipality into addressRegion.
    // Treat that as absent subdivision evidence, then resolve the canton from
    // the still-authoritative locality instead of inventing an HQ fallback.
    const addressRegion = normalizeSpace(rawRegion).toLowerCase() === normalizeSpace(addressLocality).toLowerCase()
      ? ''
      : rawRegion;
    const country = typeof address.addressCountry === 'object'
      ? address.addressCountry?.name || address.addressCountry?.['@id'] || ''
      : address.addressCountry || '';
    return {
      location: addressLocality,
      addressLocality,
      addressRegion,
      addressCountry: String(country || '').trim(),
      postalCode: String(address.postalCode || '').trim(),
      streetAddress: String(address.streetAddress || '').trim(),
    };
  });
}

function resolveCoopJsonLdGeography(candidate) {
  const direct = resolveSourceBackedSwissGeography(candidate);
  if (direct) return direct;
  // This ATS uses addressRegion for non-canton districts (for example
  // "Zürcher Unterland/Limmattal"). With an explicit Swiss country, retry
  // solely from the structured locality; unknown/foreign localities still
  // fail the shared resolver instead of falling back to an employer HQ.
  if (/^(?:ch|che|schweiz|switzerland|suisse|svizzera|svizra)$/i.test(candidate.addressCountry)) {
    return resolveSourceBackedSwissGeography({ ...candidate, addressRegion: '' });
  }
  return null;
}

/**
 * Geography carried by the listing row itself (Prospective `sza_workplace.*`),
 * as an address candidate shaped like the JSON-LD ones. Returns `null` when the
 * listing has no locality or when it does not resolve to a Swiss municipality —
 * i.e. when it really is the generic fallback the detail payload must replace.
 *
 * Reads `addressLocality` ONLY, never `location`: the family's `location` is
 * built as `city || region || 'Schweiz'`, so it degrades to a region label that
 * can itself be a municipality name (Bern, Zürich, Zug…) and would resolve here
 * as if it were branch-level evidence. The crawlers emit `addressLocality`
 * exclusively for a real workplace city, which makes "the listing knows the
 * branch" a property of the field rather than a guess made from its value.
 */
function listingAddressEvidence(job) {
  const addressLocality = normalizeSpace(job?.addressLocality || '');
  if (!addressLocality) return null;
  const candidate = {
    location: addressLocality,
    addressLocality,
    addressRegion: normalizeSpace(job?.canton || job?.addressRegion || ''),
    addressCountry: normalizeSpace(job?.addressCountry || job?.country || ''),
    postalCode: normalizeSpace(job?.postalCode || ''),
    streetAddress: normalizeSpace(job?.streetAddress || ''),
  };
  const geography = resolveCoopJsonLdGeography(candidate);
  return geography ? { candidate, geography } : null;
}

function isSwissCantonCode(value = '') {
  return Object.hasOwn(SWISS_CANTONS, String(value || '').trim().toUpperCase());
}

/**
 * The workplace the detail PAGE declares for this vacancy (`job_arbeitsort`,
 * see `extractCoopFamilyWorkplace`) as address evidence. It outranks the
 * JSON-LD `jobLocation`, which on the Fust/Jumbo/Interdiscount template is the
 * employer's registered office: 52/83 Fust vacancies — apprenticeships in
 * Zuchwil, Schänis, … — were published at the Oberbüren head office, 27/250
 * Interdiscount ones at Jegenstorf/Jegensdorf.
 *
 * A municipality resolves through the shared resolver (the listing canton
 * disambiguates homonyms, and is dropped when it is stale and would reject an
 * unambiguous name). A branch label that is not a BFS municipality
 * ("Heerbrugg", "Zürich Löwen", "Rapperswil SG") is kept only when it is
 * coherent with the listing's own canton: the listing row names the same label
 * as its workplace, or the label itself encodes that canton. Anything else is
 * not evidence and leaves the decision to the listing/detail rules below.
 */
function pageWorkplaceEvidence(job, page) {
  const workplace = normalizeSpace(page?.workplace || '');
  if (!workplace || isCantonOnlyLabel(workplace)) return null;
  const listingCanton = normalizeSpace(job?.canton || job?.addressRegion || '').toUpperCase();
  const listingLocality = normalizeSpace(job?.addressLocality || '');
  const sameAsListing = Boolean(listingLocality)
    && normalizeSwissTargetLocationText(listingLocality) === normalizeSwissTargetLocationText(workplace);
  const candidate = {
    location: workplace,
    addressLocality: workplace,
    addressRegion: listingCanton,
    addressCountry: 'CH',
    postalCode: sameAsListing ? normalizeSpace(job?.postalCode || '') : '',
    streetAddress: sameAsListing ? normalizeSpace(job?.streetAddress || '') : '',
  };
  const geography = (listingCanton ? resolveSourceBackedSwissGeography(candidate) : null)
    || resolveSourceBackedSwissGeography({ ...candidate, addressRegion: '' });
  if (geography) return { candidate, geography };
  if (!isSwissCantonCode(listingCanton)) return null;
  const encodedCanton = inferAnyCanton(workplace);
  if (!sameAsListing && encodedCanton !== listingCanton) return null;
  if (encodedCanton && encodedCanton !== listingCanton) return null;
  return {
    candidate,
    geography: { location: workplace, canton: listingCanton, addressCountry: 'CH' },
  };
}

/**
 * A defect of ONE vacancy's detail payload, as opposed to a failure of the
 * fetch or of the enricher's own configuration. `enrichCoopSourceBackedJobs`
 * drops the tagged record instead of aborting the batch — under the same
 * ratio/floor guard as a withdrawn page, so a source-wide drift (ATS switch,
 * JSON-LD removed, description markup changed) still fails the batch closed.
 * Callers that apply the enricher directly still see the message verbatim.
 */
function detailRejection(message) {
  const error = new Error(message);
  error.coopDetailRejection = true;
  return error;
}

/**
 * Replace listing fallbacks with the source-backed detail payload. Missing,
 * malformed or geographically unresolved detail data is a hard failure: the
 * caller must never publish a partially enriched Coop-family slice.
 *
 * Location is the one field where the detail page is NOT authoritative. The
 * Coop-family ATS emits the EMPLOYER's registered address in the detail
 * `jobLocation` — for a branch vacancy the JSON-LD says "Bernstrasse 90, 3303
 * Jegenstorf" (Interdiscount's head office) while the listing row carries the
 * actual store in `sza_workplace.city`/`.zip`/`.street`. Overwriting the branch
 * with the head office collapses a whole multi-store slice onto one address:
 * 255/265 Interdiscount records ended up at the head office, and since the
 * duplicate-listing fingerprint is `title || location || description`, 238 of
 * them (90%) then read as the same vacancy re-posted — a CRITICAL in
 * `audit-parser-quality.mjs` and thin/duplicate content on distinct indexable
 * URLs (Non-Negotiable #4). So when the listing resolves to a Swiss
 * municipality of its own and the detail disagrees, the listing wins, and the
 * postalCode/streetAddress travel WITH it: a head-office street pinned to a
 * branch city is a wrong address, not a safe default (Non-Negotiable #3).
 */
export function applyCoopSourceDetailToJob(job, jsonLd, page = null) {
  if (!jsonLd || !String(jsonLd?.['@type'] || '').includes('JobPosting')) {
    throw detailRejection(`Coop-family detail has no JobPosting JSON-LD: ${job?.url || 'missing-url'}`);
  }
  const overlap = titleOverlap(job?.title, jsonLd?.title || '');
  if (!jsonLd?.title || overlap < 0.6) {
    throw detailRejection(`Coop-family detail title mismatch (${overlap.toFixed(2)}): ${job?.url || 'missing-url'}`);
  }

  const sourceHtml = String(jsonLd?.description || '');
  // `page` (from `extractCoopFamilyPageDetails`) adds what the page renders
  // outside the JSON-LD description; without it the JSON-LD alone is used.
  const description = composeCoopFamilyDescription(coopDescHtmlToMarkdown(sourceHtml), page);
  const validation = validateCoopDescription(description, sourceHtml.length);
  if (!validation.ok) {
    throw detailRejection(
      `Coop-family detail description rejected (${validation.wordCount} words, ${validation.textLength} chars): ${validation.warnings.join('; ')}`,
    );
  }

  const detailEvidence = jsonLdAddressCandidates(jsonLd)
    .map((candidate) => ({ candidate, geography: resolveCoopJsonLdGeography(candidate) }))
    .find(({ geography }) => geography);
  const workplaceEvidence = pageWorkplaceEvidence(job, page) || listingAddressEvidence(job);
  // The JSON-LD address is the employer's office, not the vacancy's place, and
  // it can be unresolvable on its own: the Jumbo/Coop apprenticeship template
  // stamps "Gossau", which names two municipalities (SG and ZH). The workplace
  // the page and the listing declare is the vacancy's own evidence; without
  // it the record is still rejected (two Jumbo "Detailhandelsfachfrau:mann /
  // -assistent:in" at Weinfelden Thurmarkt and St. Gallen Gallusmarkt were
  // dropped as "location rejected" on 2026-09-29).
  if (!detailEvidence && !workplaceEvidence) {
    throw detailRejection(`Coop-family detail location rejected: ${job?.url || 'missing-url'}`);
  }

  const workplaceKey = normalizeSwissTargetLocationText(workplaceEvidence?.geography?.location || '');
  const detailKey = normalizeSwissTargetLocationText(detailEvidence?.geography?.location || '');
  // A branch label that starts with the detail municipality ("Schaffhausen,
  // Herblingermarkt" vs JSON-LD "Schaffhausen") names the same place: keep the
  // detail's municipality and its street address.
  const labelNamesDetail = Boolean(workplaceKey && detailKey)
    && workplaceKey.startsWith(detailKey)
    && !/^[\p{L}\p{N}]/u.test(workplaceKey.slice(detailKey.length));
  const workplaceOverridesDetail = Boolean(workplaceEvidence)
    && (!detailEvidence || (workplaceKey !== detailKey && !labelNamesDetail));
  const evidence = workplaceOverridesDetail ? workplaceEvidence : detailEvidence;

  const sourceLang = String(job?.sourceLang || 'de').trim() || 'de';
  const updated = {
    ...job,
    description,
    descriptionByLocale: {
      ...(job?.descriptionByLocale || {}),
      [sourceLang]: description,
    },
    location: evidence.geography.location,
    addressLocality: evidence.geography.location,
    canton: evidence.geography.canton,
    addressRegion: evidence.geography.canton,
    postalCode: evidence.candidate.postalCode,
    streetAddress: evidence.candidate.streetAddress,
    ...(evidence.candidate.addressCountry ? { addressCountry: evidence.candidate.addressCountry } : {}),
    needsRetranslation: true,
    _enrichedFromDetail: true,
  };
  return updated;
}

// Statuses where the detail page — the authority for this vacancy — says the
// vacancy no longer exists: withdrawn or expired, not a failed fetch. Those are
// dropped from the enriched batch (the reconcile/archive path downstream then
// retires them) instead of aborting the crawl: a single expired posting used to
// throw `HTTP 410` and kill the whole run with the other ~97 vacancies already
// parsed, which is what made `Run fust` a chronic failure (#6659). Every other
// non-ok status still fails the batch closed. Callers may opt into keeping the
// already validated listing record for transient detail outages; persistent
// source/quality failures remain fail-closed.
const GONE_STATUS = new Set([404, 410]);
// Past this share of the batch "the vacancies expired / this one posting is
// thin" stops being a credible reading — that is source drift (host migration,
// ATS switch, JSON-LD reshaped), and publishing a gutted slice would be exactly
// the partial batch this enricher exists to prevent. Fail closed instead.
// Counts gone AND rejected pages together: they are the same statement about
// the batch, "the detail payload is no longer usable", and splitting the budget
// would let a half-gone/half-rejected batch through both halves of the guard.
const DETAIL_DROP_ABORT_RATIO = 0.5;
// …but a ratio alone is meaningless on a tiny batch: with a single job in
// `input`, one withdrawn vacancy is 100% and would throw «source drift», i.e.
// exactly the dead crawl this enricher exists to prevent. Interdiscount and
// Volg do publish slices this small (`fetchAllInterdiscountJobs()` hands its
// whole batch straight over), so the ratio only governs batches where it is
// statistically meaningful.
//
// "Statistically meaningful" is a property of the BATCH, so the floor is on
// `input.length` — not on the number of dropped pages (#7545). Guarding the
// drop count let the tiny-batch case back in through the other side: with two
// vacancies both withdrawn, `dropped === 2` cleared a floor of 1 and 100%
// cleared the ratio, so the crawl still died with «source drift» on the most
// banal shape there is — a two-item slice that expired. Below this batch size
// every dropped page is read as expiry, whatever their share; at or above it
// crossing the ratio takes at least three dropped pages, which is no longer a
// couple of vacancies ending on the same day.
const DETAIL_DROP_ABORT_MIN_BATCH = 4;
const isRetryableHttpStatus = (status) => Number.isFinite(status) && RETRYABLE_STATUS.has(status);

function singleLineErrorMessage(error) {
  return normalizeSpace(error?.message || error || 'unknown error');
}

/**
 * Fetch and strictly apply all detail payloads with bounded concurrency.
 *
 * `onGone` receives the detail URLs whose page reported the vacancy gone
 * (404/410) and were therefore dropped from the returned batch. Callers that
 * hold a listing-derived source-of-truth need it: dropping the job here is only
 * half the retirement, the URL must also leave their authoritative set, or a
 * downstream completeness check still counts it as a failed parse.
 *
 * `onRejected` is the same channel for the detail pages that ARE served but
 * whose payload one vacancy at a time fails the source-backed invariant (no
 * JobPosting JSON-LD, title mismatch, description below the quality floor,
 * unresolvable location). Those used to throw and kill the whole crawl: a
 * single 37-word fenaco posting among 677 made `Run volg` fail on every run
 * from 2026-09-02 (#7179), the same shape as the expired posting that made
 * `Run fust` chronic (#6659). The record is unpublishable either way — thin
 * content on an indexable URL is Non-Negotiable #4 — so it leaves the batch,
 * and only a batch-wide share of rejections is read as drift and fails closed.
 * `preserveListingOnTransientFailure` keeps the listing-derived record when a
 * detail request exhausts retries on an explicitly retryable HTTP status. A
 * network/DNS/TLS error remains fail-closed: the listing alone cannot prove
 * that the source is still reachable, while its rich fallback is safe for an
 * otherwise complete crawl that received one 503.
 * `dropBudgetDenominator` controls the population used by the source-drift
 * ratio guard; when omitted, it remains `input.length` for all callers.
 * `onDropSummary` receives `{ candidates, gone, rejected, dropped }` once the
 * batch settles, including a zero-drop observation. The same object is kept as
 * a non-enumerable `.detailDrop` on the returned array for standard-pipeline
 * callers; absent summary fields therefore still mean "not measured".
 */
export async function enrichCoopSourceBackedJobs(jobs, {
  fetchImpl = undiciFetch,
  allowedHosts = ['jobs.coopjobs.ch', 'jobs.fust.ch', 'jobs.fenaco.com'],
  concurrency = 6,
  timeoutMs = 20000,
  onGone = null,
  onRejected = null,
  onDropSummary = null,
  preserveListingOnTransientFailure = false,
  dropBudgetDenominator = undefined,
} = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const abortDenominator = Number.isFinite(dropBudgetDenominator)
    ? dropBudgetDenominator
    : input.length;
  const output = new Array(input.length);
  const gone = [];
  const rejected = [];
  const unavailable = [];
  const validateUrl = createSpecUrlPolicy({
    seedUrls: allowedHosts.map((hostname) => `https://${hostname}`),
  });
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, input.length)) }, async (_, worker) => {
    for (let index = worker; index < input.length; index += Math.min(Math.max(1, concurrency), Math.max(1, input.length))) {
      const job = input[index];
      const url = new URL(String(job?.url || ''));
      if (!allowedHosts.includes(url.hostname)) {
        throw new Error(`Untrusted Coop-family detail host: ${url.hostname}`);
      }
      let response;
      try {
        response = await fetchWithRetry(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetchFollowingValidatedRedirects(url.toString(), {
              fetchImpl,
              validateUrl,
              requestOptions: {
                signal: controller.signal,
                dispatcher: validateUrl.dispatcher,
                headers: {
                  Accept: 'text/html',
                  'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
                },
              },
            });
            if (!res?.ok && isRetryableHttpStatus(res?.status)) {
              const err = new Error(`HTTP ${res.status}`);
              err.status = res.status;
              throw err;
            }
            return res;
          } finally {
            clearTimeout(timer);
          }
        }, { label: `coop-detail:${url.hostname}` });
      } catch (error) {
        if (preserveListingOnTransientFailure
          && error?.retryExhausted === true
          && isRetryableHttpStatus(error.status)) {
          output[index] = job;
          unavailable.push({ url: url.toString(), reason: singleLineErrorMessage(error) });
          continue;
        }
        throw error;
      }
      if (!response?.ok) {
        if (GONE_STATUS.has(response?.status)) {
          gone.push({ url: url.toString(), status: response.status });
          continue;
        }
        // The normal transport throws retryable statuses so fetchWithRetry
        // can retry them; keep this defensive Response path on the same
        // explicit HTTP-status allowlist for custom/injected transports.
        if (preserveListingOnTransientFailure && isRetryableHttpStatus(response?.status)) {
          output[index] = job;
          unavailable.push({ url: url.toString(), reason: `HTTP ${response.status}` });
          continue;
        }
        throw new Error(`HTTP ${response?.status || 'unknown'}`);
      }
      const html = await response.text();
      const jsonLd = extractJsonLd(html);
      try {
        output[index] = applyCoopSourceDetailToJob(job, jsonLd, extractCoopFamilyPageDetails(html));
      } catch (error) {
        if (!error?.coopDetailRejection) throw error;
        rejected.push({ url: url.toString(), reason: error.message });
      }
    }
  });
  let firstUnexpectedError;
  let hasUnexpectedError = false;
  const settledWorkers = workers.map((workerPromise) => workerPromise.catch((error) => {
    if (!hasUnexpectedError) {
      firstUnexpectedError = error;
      hasUnexpectedError = true;
    }
    throw error;
  }));
  await Promise.allSettled(settledWorkers);
  const detailDrop = Object.freeze({
    candidates: input.length,
    gone: gone.length,
    rejected: rejected.length,
    dropped: gone.length + rejected.length,
  });
  const sourceDriftDetected = input.length >= DETAIL_DROP_ABORT_MIN_BATCH
    && detailDrop.dropped > abortDenominator * DETAIL_DROP_ABORT_RATIO;
  const publishDropSummary = (jobs) => {
    Object.defineProperty(jobs, 'detailDrop', {
      value: detailDrop,
      enumerable: false,
      configurable: true,
    });
    return jobs;
  };
  const reportDropOutcomes = () => {
    if (typeof onDropSummary === 'function') onDropSummary(detailDrop);
    if (gone.length > 0) {
      const goneLabels = gone.map(({ url, status }) => `${url} (HTTP ${status})`);
      console.warn(`⚠️  Dropped ${gone.length}/${input.length} withdrawn Coop-family vacancies: ${goneLabels.join(', ')}`);
      if (!sourceDriftDetected && typeof onGone === 'function') onGone(gone.map(({ url }) => url));
    }
    if (rejected.length > 0) {
      const rejectedLabels = rejected.map(({ url, reason }) => `${url} (${reason})`);
      console.warn(`⚠️  Dropped ${rejected.length}/${input.length} unusable Coop-family detail payloads: ${rejectedLabels.join(', ')}`);
      if (!sourceDriftDetected && typeof onRejected === 'function') onRejected(rejected.map(({ url }) => url));
    }
    if (unavailable.length > 0) {
      console.warn(`⚠️  Kept ${unavailable.length}/${input.length} listing-backed Coop-family vacancies after retryable detail failures:`);
      for (const { url, reason } of unavailable) console.warn(`  - ${url} (${reason})`);
    }
  };
  reportDropOutcomes();
  if (hasUnexpectedError) throw firstUnexpectedError;
  if (gone.length === 0 && rejected.length === 0 && unavailable.length === 0) {
    return publishDropSummary(output);
  }
  if (sourceDriftDetected) {
    throw new Error(
      `Coop-family detail batch: ${gone.length}/${input.length} pages gone (HTTP 404/410), `
      + `${rejected.length}/${input.length} rejected — source drift, not vacancy expiry`,
    );
  }
  return publishDropSummary(output.filter((job) => job !== undefined));
}
