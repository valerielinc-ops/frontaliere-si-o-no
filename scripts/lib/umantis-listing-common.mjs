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
 * tries BOTH extraction strategies and uses whichever yields data. Description
 * text is the listing-page snippet (no detail-page fetching) — short but
 * reliable across all tenant UIs.
 *
 * Some tenants embed the Umantis frontend behind a corporate CMS wrapper
 * (e.g. KSBL → karriere.ksbl.ch on TYPO3). The listing endpoint on the
 * raw umantis.com subdomain always works regardless.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

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
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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

  return { id, title, art, befristung, department, snippet, companyValue, datum: '' };
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

/* ── Older UI extractor (pipe-separated metadata) ────────── */

function parseOlderUiListing(html) {
  const out = [];
  const seen = new Set();
  // Find all Description links + capture surrounding context for metadata
  const linkRx = /<a\s+[^>]*href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = linkRx.exec(html))) {
    const id = m[1];
    if (id === '9999') continue;
    if (seen.has(id)) continue;
    const title = normalizeSpace(decodeEntities(m[2]));
    if (!title || title.length < 3) continue;
    if (isInitiativeApplication(title)) continue;

    // Context window around the anchor (look behind for location, ahead for metadata)
    const anchorIdx = m.index;
    const before = html.slice(Math.max(0, anchorIdx - 2000), anchorIdx);
    const after = html.slice(anchorIdx, Math.min(html.length, anchorIdx + 3000));

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
    const datumMatch = (before + after).match(/Online seit:\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
    const datum = datumMatch ? datumMatch[1] : '';

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
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|apprenti|werkstudent)/.test(t)) return 'intern';
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

function parseSwissDate(raw = '') {
  // DD.MM.YYYY → YYYY-MM-DD
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [_, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/* ── Factory ─────────────────────────────────────────────── */

/**
 * Create an Umantis listing parser for one hospital.
 *
 * @param {Object} config
 * @param {string} config.companyKey         e.g. 'ksbl'
 * @param {string} config.companyName        e.g. 'Kantonsspital Baselland (KSBL)'
 * @param {string} config.companyDomain      e.g. 'ksbl.ch'
 * @param {string|number} config.tenantId    Umantis subdomain ID (e.g. 2748)
 * @param {string} [config.lang='ger']       Listing language (ger/fre/eng/ita)
 * @param {string} config.defaultCanton      ISO canton code (e.g. 'BL')
 * @param {string} config.defaultCity        Fallback city
 * @param {string} config.defaultPostalCode  Fallback postal code
 * @param {string} [config.publicCareerUrl]  Public career site URL (corporate site)
 * @param {string} [config.defaultSourceLang='de']
 */
export function createUmantisListingParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    tenantId,
    lang = 'ger',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    publicCareerUrl,
    defaultSourceLang = 'de',
  } = config;

  if (!companyKey || !companyName || !tenantId || !defaultCanton) {
    throw new Error('createUmantisListingParser: missing required config');
  }

  const BASE_URL = `https://recruitingapp-${tenantId}.umantis.com`;
  const LISTING_URL = `${BASE_URL}/Jobs/All?lang=${lang}`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const langCode = lang === 'ger' ? 1 : lang === 'fre' ? 2 : lang === 'eng' ? 3 : lang === 'ita' ? 4 : 1;

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && (company.includes(corporateHost.split('.')[0]) || url.includes(corporateHost))) return true;
    if (url.includes(`recruitingapp-${tenantId}.umantis.com`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host === `recruitingapp-${tenantId}.umantis.com`) return true;
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
    const { entries, ui } = parseUmantisListing(html);
    console.log(`  ✓ ${entries.length} jobs from listing (${ui} UI)`);

    if (!entries.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];

    for (const entry of entries) {
      const title = entry.title;
      const detailUrl = `${BASE_URL}/Vacancies/${entry.id}/Description/${langCode}`;
      const applyUrl = `${BASE_URL}/Vacancies/${entry.id}/Application/CheckLogin/${langCode}`;

      // Description: prefer snippet, fall back to title + department
      const descParts = [];
      if (entry.snippet) descParts.push(entry.snippet);
      if (entry.department) descParts.push(`Bereich: ${entry.department}`);
      if (entry.art) descParts.push(`Art: ${entry.art}`);
      if (entry.befristung) descParts.push(`Befristung: ${entry.befristung}`);
      const description = descParts.length > 0
        ? descParts.join('\n\n')
        : `${title} — ${companyName}`;

      const location = entry.location || defaultCity;
      const canton = inferSwissTargetCanton(location) || defaultCanton;

      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

      const postedDate = parseSwissDate(entry.datum) || todayIso;

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
        location,
        canton,
        url: detailUrl,
        source: `${companyName} Dedicated Parser (Umantis listing tenant ${tenantId})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectCategory(title, entry.department),
        contract: /befristet|temporär|temporair/i.test(entry.befristung) ? 'temporary' : 'full-time',
        employmentType: detectEmploymentType(entry.art, title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}

// Exported for tests
export { parseUmantisListing, parseNewerUiListing, parseOlderUiListing, decodeEntities, parseSwissDate };
