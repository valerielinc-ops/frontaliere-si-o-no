#!/usr/bin/env node
/**
 * Shared helpers for the Umantis ATS used by many Swiss hospitals.
 *
 * Multi-tenant SaaS — each hospital gets its own subdomain:
 *   https://recruitingapp-{TENANT_ID}.umantis.com/Jobs/All?lang={ger|fre|eng|ita}
 *
 * Two HTML UI generations exist across tenants:
 *
 *   1. **Newer UI (2023+)** — `<tr class="table-as-list__contentrow{1|2}">` rows
 *      with `<span class="column-value" id="column_value_{ELEMENT_ID}">` for
 *      structured metadata. Standardised element IDs across all newer tenants:
 *        - 1184128 → company name
 *        - 1184117 → Art (Vollzeit/Teilzeit)
 *        - 1184118 → Befristung (Unbefristet/Befristet)
 *        - 1184120 → department / Berufsgruppe
 *      Title link: `<a href="/Vacancies/{ID}/Description/1">{TITLE}</a>` inside
 *      `<h3 class="table-as-list__subtitle tableaslist_element_1152488">`.
 *      Used by: Bethesda, Sonnenhalde, Spital Davos.
 *
 *   2. **Older UI** — `tableaslist_contentrow{1|2}` (no double underscore)
 *      with pipe-separated text inside `tableaslist_text|subtitle
 *      tableaslist_element_{ID}` spans. Metadata is embedded as text:
 *        `<span ...>&nbsp;|&nbsp;Art: Vollzeit</span>`
 *      Title link is the bare `<a href="/Vacancies/{ID}/Description/1">{TITLE}</a>`.
 *      Used by: KSBL, Adullam.
 *
 * This module provides a single `createUmantisListingParser()` factory that
 * tries BOTH extraction strategies and uses whichever yields data, walks every
 * page of the listing (`collectUmantisListingPages`: the table shows 10 rows
 * per page), and reads the description from each vacancy's detail page.
 *
 * Some tenants embed the Umantis frontend behind a corporate CMS wrapper
 * (e.g. KSBL → karriere.ksbl.ch on TYPO3). The listing endpoint on the
 * raw umantis.com subdomain always works regardless.
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang, isCivilServiceListing } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml as fetchHtmlResilient, normalizeDescriptionBullets } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { isCrossHostRedirect, stripUmantisNonContent } from './umantis-detail-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';
import { dropTranslationsOfFabricatedSource } from './source-locale-description.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  agrave: 'à', acirc: 'â', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô',
  ucirc: 'û', ccedil: 'ç', Ccedil: 'Ç', oelig: 'œ', aelig: 'æ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', middot: '·', hellip: '…', copy: '©', reg: '®',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchHtml(url) {
  // Delegate the listing fetch to the shared resilient helper: retry/backoff +
  // connection-level Jina clean-IP fallback + 200-challenge rescue. Previously
  // this had retry only (no proxy), so a datacenter-egress block on the Umantis
  // tenant threw straight through. Name/signature kept so call sites (and the
  // detail fetch below, which keeps its bespoke redirect:'manual' dead-detail
  // handling) are unchanged.
  return fetchHtmlResilient(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
  });
}

/* ── Newer UI extractor ──────────────────────────────────── */

function extractNewerUiRow(rowHtml) {
  // Title link: <a href="/Vacancies/{ID}/Description/\d+">{TITLE}</a>
  const linkMatch = rowHtml.match(/<a\s+[^>]*href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/);
  if (!linkMatch) return null;
  const id = linkMatch[1];
  if (id === '9999') return null;
  const title = normalizeSpace(decodeEntities(linkMatch[2]));
  if (!title || title.length < 3) return null;

  // Newer-UI structured metadata via column-value spans (standard IDs)
  const colMatch = (suffixId) => {
    const rx = new RegExp(`<span class="column-value" id="column_value_${suffixId}">([^<]*)</span>`);
    const m = rowHtml.match(rx);
    return m ? normalizeSpace(decodeEntities(m[1])) : '';
  };
  const companyValue = colMatch('1184128');
  const art = colMatch('1184117');
  const befristung = colMatch('1184118');
  const department = colMatch('1184120');

  // Snippet (short teaser): <p class="table-as-list__subtitle tableaslist_element_1184115">...</p>
  const snippetMatch = rowHtml.match(/tableaslist_element_1184115"[^>]*>([\s\S]*?)<\/p\s*>/);
  const snippet = snippetMatch
    ? normalizeSpace(decodeEntities(stripHtml(snippetMatch[1])))
    : '';

  return { id, title, art, befristung, department, snippet, companyValue, datum: readOnlineSince(rowHtml) };
}

/**
 * Skip placeholder "initiative application" entries that Umantis tenants use
 * as evergreen channels for spontaneous applications (not real vacancies).
 * KSBL labels them `<role> (a) Initiativ`, others use prefixes.
 */
function isInitiativeApplication(title = '') {
  return /(^|\b)(initiativbewerbung|spontanbewerbung|blindbewerbung|allgemeine bewerbung)\b/i.test(title)
    || /\binitiativ\b/i.test(title)
    || /\(a\)\s*$/i.test(title);
}

function parseNewerUiListing(html) {
  const out = [];
  const seen = new Set();
  const rowRx = /<tr\s+class="table-as-list__contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRx.exec(html))) {
    const entry = extractNewerUiRow(m[1]);
    if (!entry) continue;
    if (seen.has(entry.id)) continue;
    if (isInitiativeApplication(entry.title)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

// Only the explicitly labelled publication field is accepted.
function readOnlineSince(rowHtml = '') {
  const text = normalizeSpace(decodeEntities(stripHtml(rowHtml)));
  return text.match(/Online seit:\s*(\d{1,2}\.\d{1,2}\.\d{4})(?!\d)/)?.[1] || '';
}

/* ── Older UI extractor (pipe-separated metadata) ────────── */

function parseOlderUiListing(html) {
  const out = [];
  const seen = new Set();
  // Find all Description links + capture surrounding context for metadata
  const linkRx = /<a\s+[^>]*href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/g;
  const anchors = [...html.matchAll(linkRx)];
  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i];
    const id = m[1];
    if (id === '9999') continue;
    if (seen.has(id)) continue;
    const title = normalizeSpace(decodeEntities(m[2]));
    if (!title || title.length < 3) continue;
    if (isInitiativeApplication(title)) continue;

    // Context window around the anchor (look behind for location, ahead for
    // metadata), bounded by the neighbouring anchors so a row's metadata
    // never bleeds from/into an adjacent listing. A fixed-distance window
    // alone can reach past a short row into the PREVIOUS job's cells — for
    // multi-property employers (e.g. Bürgenstock's resort brands "Taverne
    // 1879", "Waldhotel") that leaked a sibling row's property name in as
    // this job's location, which then fuzzy-matched an unrelated canton
    // (issue #5011).
    const anchorIdx = m.index;
    const prevAnchorEnd = i > 0 ? anchors[i - 1].index + anchors[i - 1][0].length : 0;
    const nextAnchorStart = i < anchors.length - 1 ? anchors[i + 1].index : html.length;
    const before = html.slice(Math.max(0, anchorIdx - 2000, prevAnchorEnd), anchorIdx);
    const after = html.slice(anchorIdx, Math.min(html.length, anchorIdx + 3000, nextAnchorStart));

    const pick = (text, label) => {
      const rx = new RegExp(`${label}:\\s*([^<|]+?)\\s*(?=<|\\|)`);
      const mm = text.match(rx);
      return mm ? normalizeSpace(decodeEntities(mm[1])) : '';
    };

    const art = pick(after, 'Art');
    const befristung = pick(after, 'Befristung');
    const department = pick(after, 'Unternehmensbereich')
      || pick(after, 'Berufsgruppe')
      || pick(after, 'Funktionsbereich')
      || pick(after, 'Organisationseinheit');
    // Publication belongs to this row, never to a neighbouring anchor's
    // surrounding metadata. A standalone fragment is safe only for one job.
    const prefix = html.slice(0, anchorIdx);
    const rowOpen = [...prefix.matchAll(/<tr\b[^>]*>/gi)].at(-1);
    const previousRowClose = prefix.toLowerCase().lastIndexOf('</tr>');
    const rowEnd = html.toLowerCase().indexOf('</tr>', anchorIdx);
    const rowHtml = rowOpen && rowOpen.index > previousRowClose && rowEnd >= 0
      ? html.slice(rowOpen.index, rowEnd + 5)
      : (anchors.length === 1 ? html : '');
    const rowLinks = [...rowHtml.matchAll(/href="\/Vacancies\/(\d+)\/Description\/\d+"/g)];
    const sameJobOnly = rowLinks.every((link) => link[1] === id);
    const datum = sameJobOnly ? readOnlineSince(rowHtml) : '';

    // Location heuristic: tableaslist_text element directly before the anchor
    // often contains the city name. Try to extract it.
    let location = '';
    const beforeText = before.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const cityMatch = beforeText.match(/\b([A-ZÄÖÜ][a-zäöüé]+(?:\s+[A-ZÄÖÜ][a-zäöüé]+)?)\s*\|\s*Online seit/);
    if (cityMatch) location = normalizeSpace(decodeEntities(cityMatch[1]));

    // Snippet heuristic for older UI: look in `after` for a `tableaslist_subtitle`
    // span that immediately follows the title link and contains substantive text
    // (not a metadata pipe pair). Falls back to '' if none found.
    let snippet = '';
    const snippetCandidates = after.match(/<(?:span|p)\s+class="tableaslist_subtitle[^"]*"[^>]*>([\s\S]*?)<\/(?:span|p)>/g) || [];
    for (const sc of snippetCandidates) {
      const text = normalizeSpace(decodeEntities(stripHtml(sc)));
      // Skip pipe-style metadata fragments
      if (!text) continue;
      if (/^\|/.test(text) || /^(Art|Befristung|Stellennummer|Unternehmensbereich|Berufsgruppe|Funktionsbereich|Organisationseinheit|Online seit)\s*:/.test(text)) continue;
      if (text.length < 40) continue;
      snippet = text;
      break;
    }

    seen.add(id);
    out.push({ id, title, art, befristung, department, snippet, companyValue: '', datum, location });
  }
  return out;
}

/* ── Combined parser ─────────────────────────────────────── */

function parseUmantisListing(html) {
  const newer = parseNewerUiListing(html);
  if (newer.length > 0) return { entries: newer, ui: 'newer' };
  const older = parseOlderUiListing(html);
  return { entries: older, ui: 'older' };
}

/* ── Pagination ──────────────────────────────────────────── */

/**
 * Upper bound on the listing walk. Umantis renders 10 rows per page by
 * default (`TableMaxEntries`), so 60 pages cover 600 vacancies — the same cap
 * `kanton-aargau-job-parser.mjs` uses for the largest tenant we crawl.
 */
export const UMANTIS_MAX_LISTING_PAGES = 60;

/**
 * Next-page link of an Umantis `Jobs/All` table, as rendered by both UI
 * generations: `data-pagination-next-href="?tc{TABLE}=p{N}&amp;_search_token{TABLE}={TOKEN}"`.
 * Returns the query string to append to the listing URL, or '' when the page
 * has no pager.
 */
export function extractUmantisNextPageQuery(html = '') {
  const m = String(html || '').match(
    /data-pagination-next-href="\?(tc\d+)=p(\d+)&(?:amp;)?(_search_token\d+)=(\d+)/,
  );
  return m ? `${m[1]}=p${m[2]}&${m[3]}=${m[4]}` : '';
}

/**
 * Walk every page of an Umantis listing starting from the already-fetched
 * first page. The first page alone is only `TableMaxEntries` rows: on
 * Bethesda (tenant 2998) it held 10 of the 14 vacancies the hospital
 * publishes, and the other 4 were only reachable through `?tc1152481=p2`.
 *
 * The last page still links a `p{N+1}`, which Umantis 302-redirects back to
 * page 1, so the walk stops on the first page that adds no unseen vacancy id
 * (or on a fetch error, keeping what was collected — the slice writer's
 * anti-shrink guard owns the decision about a short catalogue).
 *
 * @param {string} firstHtml   HTML of the listing's first page
 * @param {string} listingUrl  the listing URL (already carrying `?lang=`)
 * @param {(url: string) => Promise<string>} fetchPage
 * @param {{ maxPages?: number, delayMs?: number }} [opts]
 * @returns {Promise<{ entries: object[], ui: string, pages: number }>}
 */
export async function collectUmantisListingPages(firstHtml, listingUrl, fetchPage, opts = {}) {
  const maxPages = opts.maxPages ?? UMANTIS_MAX_LISTING_PAGES;
  const delayMs = opts.delayMs ?? 250;
  const first = parseUmantisListing(firstHtml);
  const entries = [...first.entries];
  const seen = new Set(entries.map((entry) => entry.id));
  let pages = 1;
  let query = extractUmantisNextPageQuery(firstHtml);
  const separator = listingUrl.includes('?') ? '&' : '?';
  while (query && pages < maxPages) {
    let html;
    try {
      html = await fetchPage(`${listingUrl}${separator}${query}`);
    } catch (err) {
      console.warn(`  ⚠️  Umantis listing page ${pages + 1} fetch failed: ${err?.message || err}`);
      break;
    }
    const { entries: pageEntries } = parseUmantisListing(html);
    let added = 0;
    for (const entry of pageEntries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
      added++;
    }
    if (added === 0) break;
    pages++;
    query = extractUmantisNextPageQuery(html);
    if (query && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { entries, ui: first.ui, pages };
}

/* ── Classifiers ─────────────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(pflege|pflegefach|stationsleitung|pflegehelfer|pflegehilfe|fage|fachperson gesundheit|spitex|langzeitpflege|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|innere medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychiatr|geriatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|segret|buchhalt|sachbearbeiter|finanzbuchhalt|faktur|account|finanz|controll)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|werkstudent)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(art = '', title = '') {
  const t = normalize(art || title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  const pct = normalize(title).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalize(title).match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/**
 * The job's `contract` from the listing's «Befristung» column and the
 * employment type the parser already reads from «Art» (and the title).
 *
 * These values used to reach the site also as «• Befristung: …» / «• Art: …»
 * lines the crawler appended to the description, where the job board read
 * «Teilzeit» and «befristet» out of the text. With the lines gone the
 * structured field carries them, in the job board's own order
 * (`normalizeJobContract`: part-time before temporary). «Unbefristet» (a
 * permanent position) contains «befristet»: the previous test matched it and
 * marked every permanent position of these tenants as temporary.
 *
 * @param {string} befristung      e.g. «Befristet», «Unbefristet»
 * @param {string} employmentType  e.g. `detectEmploymentType(art, title)`
 * @returns {'part-time'|'temporary'|'full-time'}
 */
export function umantisListingContract(befristung = '', employmentType = '') {
  if (employmentType === 'PART_TIME') return 'part-time';
  if (/(?:^|[^\p{L}])(?:befristet|temporär|temporair)/u.test(normalize(befristung))) return 'temporary';
  return 'full-time';
}

function parseSwissDate(raw = '') {
  // DD.MM.YYYY → YYYY-MM-DD
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [_, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Extract rich description content from an Umantis detail page.
 *
 * Newer-UI tenants (Bethesda, Sonnenhalde) use `<li>` or `<p
 * class="customdatablock" id="customdatablock_NNNN">…</li>` pairs:
 *   - Header item: contains the section name as plain text (e.g. "Ihre Aufgaben")
 *   - Body item: contains the bullet list inside an inner <ul><li>...</li></ul>
 *
 * Older-UI tenants (Adullam) embed similar sections via `tableaslist_element_*`
 * spans; we extract any prose-looking text block we can find.
 *
 * Returns concatenated plain-text content (\n\n separated sections).
 */
function findMatchingUmantisElementClose(html, start, tagName) {
  const tagRx = new RegExp(`<\\s*(\\/?)\\s*${tagName}\\b`, 'gi');
  tagRx.lastIndex = start;
  let depth = 1;
  let match;
  while ((match = tagRx.exec(html))) {
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return match.index;
      continue;
    }
    const tagEnd = html.indexOf('>', match.index + match[0].length);
    if (tagEnd !== -1 && !/\/\s*$/.test(html.slice(match.index + match[0].length, tagEnd))) {
      depth += 1;
    }
  }
  return -1;
}

export function extractUmantisDetailContent(html) {
  if (!html || typeof html !== 'string') return '';
  const cleanedHtml = stripUmantisNonContent(html);
  // First try the newer-UI customdatablock pattern. GZF and other tenants
  // emit the same blocks as <p> elements, sometimes with a malformed closing
  // tag (e.g. `</p`). Use the element's own closing tag first, with the next
  // block/container as a defensive boundary for malformed pages.
  const blocks = [];
  // Sanatorium Kilchberg renders the same blocks as <div> elements; without
  // the div form its ads fell to the p/li fallback and lost the intro, the
  // section labels and the employer paragraph.
  const dataBlockOpenRx = /<(?:li|p|div)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bcustomdatablock\b[^"']*["'])(?=[^>]*\bid\s*=\s*["']customdatablock_\d+["'])[^>]*>/gi;
  const starts = [...cleanedHtml.matchAll(dataBlockOpenRx)];
  for (let i = 0; i < starts.length; i += 1) {
    const opening = starts[i][0];
    const start = (starts[i].index ?? 0) + opening.length;
    const nextStart = i + 1 < starts.length ? (starts[i + 1].index ?? cleanedHtml.length) : cleanedHtml.length;
    const chunk = cleanedHtml.slice(start, nextStart);
    const ownEnd = findMatchingUmantisElementClose(cleanedHtml, start, opening.match(/^<(li|p|div)\b/i)?.[1] || 'p');
    const boundaryEnd = chunk.search(/<\/(?:article|main|body|footer|nav)\b/i);
    const end = Math.min(
      nextStart,
      ownEnd >= 0 ? ownEnd : nextStart,
      boundaryEnd >= 0 ? start + boundaryEnd : nextStart,
    );
    let text = cleanedHtml.slice(start, end)
      .replace(/<ul[^>]*>/gi, '')
      .replace(/<\/ul\s*>/gi, '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    text = normalizeSpace(decodeEntities(text)).replace(/\s*•\s*/g, '\n• ');
    if (text && text.length > 5) blocks.push(text);
  }
  if (blocks.length > 0) return blocks.join('\n\n');

  // Fallback: tenants without customdatablock blocks (older UI and custom
  // HTML templates: Bürgenstock, Klinik Im Hasel, Sonnenhalde, NSN, Kilchberg,
  // SZB, UPD — 7 of the factory's tenants on 2026-09-29). Read the page's
  // paragraphs, list items and section headings in order.
  //
  // Two defects of the previous version, both measured on those tenants
  // (issue 5253): `<(p|li)[^>]*>` had no word boundary, so `<link …>` opened a
  // "li" that ran from the <head> to the first `</li>` and published the page
  // title, skip links and «Ihr Browser kann leider keine eingebetteten
  // Frames anzeigen» as the first paragraph; and `.slice(0, 8)` cut 14 of 21
  // sampled ads, dropping the last profile items and the whole benefits list.
  // The body is bounded by what it is (content, not chrome) rather than by an
  // arbitrary count: contact cards, job-alert and "more jobs" teasers, skip
  // links and consent text are dropped by `isUmantisChromeFragment`.
  const main = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<(script|style|noscript|iframe)\b[\s\S]*?<\/\1\s*>/gi, '');
  // h1 included: on custom templates it is the only place the page names the
  // role, and `isDetailContentValid` checks the body against the title.
  const proseRx = /<(p|li|h[1-4])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const parts = [];
  let pm;
  while ((pm = proseRx.exec(main))) {
    const tag = pm[1].toLowerCase();
    // `<br>` inside a paragraph separates list lines on these templates
    // («Das erwartet dich<br>Benutzersupport…<br>Installation…»); keep them as
    // lines so `normalizeDescriptionBullets` can restore the list.
    // A <ul> nested in the paragraph (Bürgenstock) keeps its items as bullets.
    const text = decodeEntities(pm[2]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(?:li|ul|ol|div)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .split('\n').map((line) => normalizeSpace(line)).filter((line) => line && line !== '•').join('\n');
    if (!text || isUmantisChromeFragment(text)) continue;
    if (tag === 'li') {
      if (text.length > 2) parts.push({ kind: 'item', text });
    } else if (tag === 'p') {
      if (text.length > 25) parts.push({ kind: 'para', text });
    } else if (text.length > 80) {
      // Prose set in a heading tag (SZB opens every ad with an <h2> paragraph).
      parts.push({ kind: 'para', text });
    } else if (text.length >= 3) {
      parts.push({ kind: 'heading', text });
    }
  }
  // Trailing headings (nothing after them) are page furniture.
  let lastContent = -1;
  parts.forEach((part, i) => { if (part.kind !== 'heading') lastContent = i; });
  const kept = parts.filter((part, i) => part.kind !== 'heading' || i < lastContent);
  let out = '';
  for (const part of kept) {
    if (part.kind === 'item') out += `${out ? '\n' : ''}• ${part.text}`;
    else out += `${out ? '\n\n' : ''}${part.text}`;
  }
  return out;
}

/**
 * Page furniture that the p/li fallback must not publish: contact cards
 * (an e-mail address or a phone number), job-alert and "more jobs" teasers,
 * skip links, the iframe notice, consent/legal text, and bare action labels.
 *
 * @param {string} text  one normalised paragraph, list item or heading
 * @returns {boolean}
 */
export function isUmantisChromeFragment(text = '') {
  const t = String(text);
  if (/^(cookie|datenschutz|privacy|impressum)/i.test(t)) return true;
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(t)) return true;
  if (/(?:\+41[\s.]?\d{2}|\b0\d{2})[\s/.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/.test(t)) return true;
  if (/job-?abo|weitere (offene )?stellen|zum hauptinhalt|aktionsleiste|eingebetteten frames|stelle (weiter)?empfehlen/i.test(t)) return true;
  return /^(kontakt|aktionen|teilen|share|drucken|zurück|jetzt bewerben|online bewerben)$/i.test(t);
}

/**
 * Validate that detail content actually belongs to the requested job and isn't
 * the listing/careers chrome leaking through. Two checks:
 *
 *   1. **Chrome markers**: phrases that only appear on listing/careers pages
 *      and never inside a single job's body — e.g. "stellenausschreibungen",
 *      "fachbereich wählen", "keine passende stelle", consent-banner phrases
 *      ("sie sehen gerade einen platzhalterinhalt"). One match is enough to
 *      reject the content.
 *
 *   2. **Title overlap (soft)**: a real detail page mentions the job title in
 *      its body. If the title has ≥2 substantive tokens (≥4 chars each) and
 *      *none* of them appear in the extracted text, the content almost
 *      certainly isn't this job's body. We skip this check when no testable
 *      tokens exist (German compound titles can be a single long word).
 *
 * Failing detail content gets discarded (the job falls back to the listing's
 * own teaser, or gets no description) instead of letting page chrome land in
 * the JSON.
 *
 * @param {string} content   plain text extracted from the detail HTML
 * @param {string} title     listing-page job title
 * @returns {boolean}        true when content looks like a real job body
 */
function isDetailContentValid(content, title) {
  if (!content || content.length < 80) return false;
  const lower = content.toLowerCase();
  // Strong signals that we caught the listing/careers chrome instead of the
  // per-job body. Each phrase was observed in real failing slices
  // (adullam/kispi-sg/paraplegie/spitex-zuerich/upd) — keep this list tight
  // so we don't reject legitimate detail pages.
  const CHROME_MARKERS = [
    'stellenausschreibungen',
    'fachbereich wählen',
    'fachbereich auswählen',
    'keine passende stelle',
    'sie sehen gerade einen platzhalterinhalt', // Borlabs consent banner
    'bitte bestätigen sie den vorgang',          // Umantis cookie wall
    'initiativbewerbung einreichen',             // Paraplegie listing CTA repeated per role
    'zu den offenen stellen',                    // Kispi-sg listing CTA repeated per row
    'wir sind immer auf der suche',              // Adullam careers homepage hero
  ];
  for (const marker of CHROME_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  const tokens = String(title || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok.length >= 4 && !/^(und|der|die|das|für|mit|von|bei|ein|eine)$/.test(tok));
  if (tokens.length >= 2) {
    const bodyTokens = lower.match(/[\p{L}\p{N}]{4,}/gu) || [];
    const overlap = tokens.some((tok) => bodyTokens.some((bodyToken) => {
      if (bodyToken === tok) return true;
      // German vacancy prose sometimes uses a compound with the same
      // lexical component as the title ("Fallmanagement"/"Falleröffnung",
      // "Sozialpädagogin"/"Sozialkompetenz"). Do not accept an arbitrary
      // prefix: both remaining compound heads must be known German role/body
      // words, which keeps generic "Mitarbeiter" references from validating
      // an unrelated detail page.
      return isNarrowGermanCompoundRelation(tok, bodyToken);
    }));
    if (!overlap) return false;
  }
  return true;
}

const GERMAN_COMPOUND_HEADS = [
  /^(?:management|eröffnung)$/u,
  /^pädagog(?:e|in|ik)$/u,
  /^(?:kompetenz|köchin|koch)$/u,
  /^(?:en|innen)?aufnahme$/u,
  /^etisch(?:e|en|er|es|em)?$/u,
  /^(?:e|en|er|es|em|s|n|in|innen)$/u,
];

function isNarrowGermanCompoundRelation(titleToken, bodyToken) {
  const titleValue = String(titleToken || '').normalize('NFKC');
  const bodyValue = String(bodyToken || '').normalize('NFKC');
  let commonLength = 0;
  while (
    commonLength < titleValue.length
    && commonLength < bodyValue.length
    && titleValue[commonLength] === bodyValue[commonLength]
  ) {
    commonLength += 1;
  }
  if (commonLength < 4) return false;

  const titleHead = titleValue.slice(commonLength);
  const bodyHead = bodyValue.slice(commonLength);
  if (titleHead.length < 4 || bodyHead.length < 4) return false;
  return GERMAN_COMPOUND_HEADS.some((pattern) => pattern.test(titleHead))
    && GERMAN_COMPOUND_HEADS.some((pattern) => pattern.test(bodyHead));
}

// Exported for unit tests.
export { isDetailContentValid };

/**
 * Does the detail PAGE name this vacancy in its `<title>` or first `<h1>`?
 *
 * `isDetailContentValid` asks the extracted body to mention the title, which
 * guards against a listing/careers page served instead of the ad. On tenants
 * whose ad is split into customdatablocks (Sanatorium Kilchberg) the title
 * lives only in the page heading, outside the blocks: the check then rejected
 * a real ad and the job fell back to the listing snippet. When the page
 * itself carries the title, the body only has to pass the chrome and length
 * checks.
 *
 * @param {string} html
 * @param {string} title
 * @returns {boolean}
 */
function pageNamesTitle(html = '', title = '') {
  const heading = [
    String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '',
    String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '',
  ].join(' ');
  const pageText = normalize(decodeEntities(heading.replace(/<[^>]+>/g, ' ')));
  const tokens = normalize(title).split(/[^\p{L}\p{N}]+/u).filter((tok) => tok.length >= 4);
  return tokens.length > 0 && tokens.some((tok) => pageText.includes(tok));
}

export function isDetailPageForTitle(html, content, title) {
  return isDetailContentValid(content, title)
    || (pageNamesTitle(html, title) && isDetailContentValid(content, ''));
}

/**
 * Fetch + extract a Umantis detail page, detecting the "dead detail URL"
 * failure mode (issue #1245): several tenants now 3xx-redirect
 * `/Vacancies/{id}/Description/*` AWAY from the umantis host (→ public career
 * site / migrated ATS like Prospective). Following that redirect lands on
 * careers chrome which the extractor cannot parse → the caller would otherwise
 * synthesise generic boilerplate that the dataset boilerplate-guard hard-fails
 * on, filing an issue every run.
 *
 * We use `redirect: 'manual'` so a cross-host 3xx is reported as
 * `{ deadDetail: true }` instead of silently followed. The caller QUARANTINES
 * dead-detail jobs (skips emit) rather than feeding the guard garbage.
 *
 * @param {string} detailUrl
 * @param {string} [title]
 * @returns {Promise<{ content: string, deadDetail: boolean }>}
 *   `content`    — validated detail body, or '' (SPA/chrome/error).
 *   `deadDetail` — true only on a cross-host redirect (source migrated away).
 */
async function fetchUmantisDetail(detailUrl, title = '') {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(detailUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (isCrossHostRedirect(detailUrl, location)) {
        return { content: '', deadDetail: true }; // migrated away → quarantine
      }
      // Same-host redirect (lang/canon): follow it once.
      try {
        const followUrl = new URL(location, detailUrl).toString();
        const res2 = await fetch(followUrl, {
          headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
          redirect: 'follow',
        });
        if (!res2.ok) return { content: '', deadDetail: false };
        const html2 = await res2.text();
        const content2 = extractUmantisDetailContent(html2);
        return { content: isDetailPageForTitle(html2, content2, title) ? content2 : '', deadDetail: false };
      } catch {
        return { content: '', deadDetail: false };
      }
    }

    if (!res.ok) return { content: '', deadDetail: false };
    const html = await res.text();
    const content = extractUmantisDetailContent(html);
    return { content: isDetailPageForTitle(html, content, title) ? content : '', deadDetail: false };
  } catch {
    clearTimeout(timer);
    return { content: '', deadDetail: false };
  }
}

/* ── Factory ─────────────────────────────────────────────── */

/**
 * Create an Umantis listing parser for one hospital.
 *
 * @param {Object} config
 * @param {string} config.companyKey         e.g. 'ksbl'
 * @param {string} config.companyName        e.g. 'Kantonsspital Baselland (KSBL)'
 * @param {string} config.companyDomain      e.g. 'ksbl.ch'
 * @param {string|number} [config.tenantId]  Umantis subdomain ID (e.g. 2748). Optional
 *                                           when `customBaseUrl` is provided (some tenants
 *                                           publish the Umantis app behind a corporate
 *                                           subdomain CNAME and the numeric tenant ID is
 *                                           hidden). Defaults to 'X' in that case.
 * @param {string} [config.customBaseUrl]    Override base URL (e.g. 'https://rekrutierung.stgag.ch').
 *                                           When provided, replaces `recruitingapp-{tenantId}.umantis.com`
 *                                           for listing/detail/apply URLs and is also accepted by
 *                                           `isTrustedDomain`. Strip trailing slash.
 * @param {string} [config.lang='ger']       Listing language (ger/fre/eng/ita)
 * @param {string} config.defaultCanton      ISO canton code (e.g. 'BL')
 * @param {string} config.defaultCity        Fallback city
 * @param {string} config.defaultPostalCode  Fallback postal code
 * @param {string} [config.publicCareerUrl]  Public career site URL (corporate site)
 * @param {string} [config.defaultSourceLang='de']
 * @param {'detail'|'application'} [config.canonicalUrlMode='detail'] Which
 *                                           Umantis URL should become job.url.
 *                                           Some tenants redirect Description/*
 *                                           pages to a generic career center
 *                                           while Application/* remains the
 *                                           stable live job endpoint.
 *
 * A job whose Description/* URL 3xx-redirects cross-host (issue #1245) is
 * quarantined. The former `allowBoilerplateOnDeadDetail` opt-in emitted it
 * with a description the crawler wrote from the listing metadata; its last
 * users (kispi-sg, paraplegie) left the factory, and a description the
 * source never published is not emitted any more (issue 5253).
 */
export function createUmantisListingParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    tenantId: rawTenantId,
    customBaseUrl: rawCustomBaseUrl,
    lang = 'ger',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    publicCareerUrl,
    defaultSourceLang = 'de',
    canonicalUrlMode = 'detail',
  } = config;

  const customBaseUrl = rawCustomBaseUrl
    ? String(rawCustomBaseUrl).replace(/\/+$/, '')
    : '';
  const tenantId = rawTenantId != null && rawTenantId !== ''
    ? rawTenantId
    : (customBaseUrl ? 'X' : undefined);

  if (!companyKey || !companyName || !defaultCanton) {
    throw new Error('createUmantisListingParser: missing required config (companyKey/companyName/defaultCanton)');
  }
  if (!tenantId && !customBaseUrl) {
    throw new Error('createUmantisListingParser: either tenantId or customBaseUrl is required');
  }

  const BASE_URL = customBaseUrl || `https://recruitingapp-${tenantId}.umantis.com`;
  const LISTING_URL = `${BASE_URL}/Jobs/All?lang=${lang}`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  let customBaseHost = '';
  if (customBaseUrl) {
    try { customBaseHost = new URL(customBaseUrl).hostname.toLowerCase(); } catch { customBaseHost = ''; }
  }
  const langCode = lang === 'ger' ? 1 : lang === 'fre' ? 2 : lang === 'eng' ? 3 : lang === 'ita' ? 4 : 1;

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (tenantId && tenantId !== 'X' && url.includes(`recruitingapp-${tenantId}.umantis.com`)) return true;
    if (customBaseHost && url.includes(customBaseHost)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (tenantId && tenantId !== 'X' && host === `recruitingapp-${tenantId}.umantis.com`) return true;
      if (customBaseHost && (host === customBaseHost || host.endsWith(`.${customBaseHost}`))) return true;
      if (host.endsWith('.umantis.com')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Source: ${LISTING_URL}`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const html = await fetchHtml(LISTING_URL);
    const { entries, ui, pages } = await collectUmantisListingPages(html, LISTING_URL, fetchHtml);
    console.log(`  ✓ ${entries.length} jobs from listing (${ui} UI, ${pages} page${pages === 1 ? '' : 's'})`);
    if (entries.length > 0) console.log(`  📄 Fetching detail pages for rich descriptions...`);

    if (!entries.length) return [];

    const jobs = [];
    let detailHits = 0;
    let quarantinedDeadDetail = 0;
    let withoutSourceText = 0;

    let skippedCivilService = 0;
    for (const entry of entries) {
      const title = entry.title;
      // Skip Swiss compulsory civil-service (Zivildienst) placements — they
      // require Swiss citizenship and a conscription waiver, so they are
      // never accessible to cross-border workers. Their thin descriptions
      // also tend to trip the boilerplate guard when the listing pool is
      // small (see issues #683/#685/#693).
      if (isCivilServiceListing(title, entry.snippet)) {
        skippedCivilService++;
        continue;
      }
      const detailUrl = `${BASE_URL}/Vacancies/${entry.id}/Description/${langCode}`;
      const applyUrl = `${BASE_URL}/Vacancies/${entry.id}/Application/CheckLogin/${langCode}`;
      const jobUrl = canonicalUrlMode === 'application' ? applyUrl : detailUrl;

      // Fetch detail page for rich description content. Pass the title so the
      // detail-validity check can reject content that doesn't belong to this
      // job (chrome leak from Cloudflare-walled tenants or careers homepage).
      const { content: detailContent, deadDetail } = await fetchUmantisDetail(detailUrl, title);
      await new Promise((r) => setTimeout(r, 200));

      // Dead detail URL (issue #1245): the tenant deprecated
      // /Vacancies/{id}/Description/* and now 3xx-redirects it cross-host.
      // QUARANTINE the job: the ATS has moved elsewhere and the listing may
      // go stale, and there is no posting text to publish.
      if (deadDetail) {
        quarantinedDeadDetail++;
        continue;
      }
      if (detailContent) detailHits++;

      const location = entry.location || defaultCity;
      const canton = inferSwissTargetCanton(location) || defaultCanton;

      // The description is the posting's own text (issue 5253): the detail
      // page's body or, when the detail could not be read, the listing's own
      // teaser, each only above the shared 50-word floor. The crawler used to
      // append the listing columns as «• Bereich: … / • Art: … /
      // • Befristung: …» lines (its formatting, not the posting's text) and,
      // with neither text, to write a description of its own («<Titel> bei
      // <Firma> in <Ort> (<PLZ>, <Kanton>), Schweiz.», «• Standort: …»,
      // «• Bewerbung über das Umantis-Karriereportal von …»). The columns now
      // live only in structured fields (department, contract, employmentType,
      // location). A posting without text gets no description: the merge
      // keeps the source text an earlier run stored, otherwise the job takes
      // the pipeline's thin-source path.
      const sourceText = [detailContent, entry.snippet].find((text) => meetsSourceBodyFloor(text)) || '';
      const description = sourceText ? normalizeDescriptionBullets(sourceText) : '';
      if (!description) withoutSourceText++;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

      const publication = sourcePostingDateFields(parseSwissDate(entry.datum));
      const employmentType = detectEmploymentType(entry.art, title);

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: jobUrl,
        source: customBaseUrl
          ? `${companyName} Dedicated Parser (Umantis listing @ ${customBaseHost || customBaseUrl})`
          : `${companyName} Dedicated Parser (Umantis listing tenant ${tenantId})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectCategory(title, entry.department),
        // The listing's «Bereich»/«Berufsgruppe» column (formerly a
        // «• Bereich: …» line of the description).
        department: entry.department || undefined,
        contract: umantisListingContract(entry.befristung, employmentType),
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        ...publication,
        applyUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    if (skippedCivilService > 0) {
      console.log(`  ⏭️  Skipped ${skippedCivilService} Zivildienst/civil-service listing(s) (not relevant for cross-border workers)`);
    }
    if (quarantinedDeadDetail > 0) {
      console.warn(`  ⚠️  Quarantined ${quarantinedDeadDetail}/${entries.length} job(s): detail URL deprecated (cross-host 3xx → source migrated away, issue #1245). Not emitting boilerplate for these.`);
    }
    // If EVERY discovered job has a dead detail URL, the tenant has migrated
    // its ATS away from Umantis entirely. Exit cleanly with a clear WARNING.
    if (jobs.length === 0 && quarantinedDeadDetail > 0) {
      console.warn(`  ⚠️  ${companyName}: ALL ${entries.length} listing(s) have a deprecated (cross-host-redirecting) Umantis detail URL — source appears to have migrated off Umantis. Emitting 0 jobs (no hard failure). Follow-up: per-tenant public-site/Prospective description extraction (issue #1245).`);
    }
    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${entries.length} with rich detail content${quarantinedDeadDetail > 0 ? `, ${quarantinedDeadDetail} quarantined dead-detail` : ''}${withoutSourceText > 0 ? `, ${withoutSourceText} without source text` : ''})`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}

/* ── Stored jobs: text the factory once wrote ────────────── */

/**
 * Sentinel of the description the factory used to write when a job had no
 * text: «<Titel> bei <Firma> in <Ort> (<PLZ>, <Kanton>), Schweiz.» followed by
 * «• Standort: …» and this line, which no posting contains.
 */
export const UMANTIS_FABRICATED_DESCRIPTION_RE = /Bewerbung über das Umantis-Karriereportal von /;

/**
 * The listing columns the factory appended to the posting's text, as its own
 * trailing block after a blank line: «• Bereich: …», «• Art: …»,
 * «• Befristung: …» lines, and nothing after them.
 */
export const UMANTIS_LISTING_LABEL_LINES_RE =
  /\n\n• (?:Bereich|Art|Befristung): [^\n]*(?:\n• (?:Bereich|Art|Befristung): [^\n]*)*\s*$/;

/**
 * Remove, from one STORED job, the listing-column lines the crawler appended
 * to the posting's text (`labelLinesRe` matches that trailing block). The
 * posting's own text stays in its slot (the merge keeps it when a later run
 * cannot read the detail); the translations were made from the text with the
 * lines, so they are dropped and the job is flagged for retranslation.
 *
 * @param {object} job
 * @param {RegExp} [labelLinesRe]
 * @returns {boolean} true when the job carried the lines.
 */
export function stripUmantisListingLabelLines(job, labelLinesRe = UMANTIS_LISTING_LABEL_LINES_RE) {
  if (!job || typeof job !== 'object') return false;
  let changed = dropTranslationsOfFabricatedSource(job, labelLinesRe);
  const byLocale = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? job.descriptionByLocale
    : {};
  for (const [locale, value] of Object.entries(byLocale)) {
    if (typeof value !== 'string' || !labelLinesRe.test(value)) continue;
    byLocale[locale] = value.replace(labelLinesRe, '').trim();
    changed = true;
  }
  if (typeof job.description === 'string' && labelLinesRe.test(job.description)) {
    job.description = job.description.replace(labelLinesRe, '').trim();
    changed = true;
  }
  if (changed) job.needsRetranslation = true;
  return changed;
}

/**
 * `prepareExistingJobs` of the Umantis runners: before the merge, remove from
 * the stored jobs the text the crawler wrote itself, which the
 * locale-preserving merge would otherwise keep — the whole synthesised
 * description (and every translation of it) via `dropFabricatedDescription`,
 * and the appended listing-column lines via `stripUmantisListingLabelLines`.
 * The patterns default to the factory's; a tenant with its own parser
 * (Kanton St. Gallen) passes its own. Returns the same array.
 *
 * @param {object[]} jobs
 * @param {string} label  company name for the log line
 * @param {{ fabricatedRe?: RegExp, labelLinesRe?: RegExp }} [patterns]
 * @returns {object[]}
 */
export function repairStoredUmantisJobs(jobs, label, {
  fabricatedRe = UMANTIS_FABRICATED_DESCRIPTION_RE,
  labelLinesRe = UMANTIS_LISTING_LABEL_LINES_RE,
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  let fabricated = 0;
  let labelled = 0;
  for (const job of list) {
    if (dropFabricatedDescription(job, fabricatedRe)) fabricated++;
    else if (stripUmantisListingLabelLines(job, labelLinesRe)) labelled++;
  }
  if (fabricated + labelled > 0) {
    console.log(`  🧹 ${label}: removed the crawler-written description from ${fabricated} and the listing-column lines from ${labelled} stored job(s); they will be retranslated`);
  }
  return list;
}

// Exported for tests
export { parseUmantisListing, parseNewerUiListing, parseOlderUiListing, decodeEntities, parseSwissDate };
