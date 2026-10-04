#!/usr/bin/env node
/**
 * Spital Thurgau (STGAG) job parser — embedded JSON in Typo3 page.
 *
 * Public career landing: https://www.stgag.ch/karriere/bildung-karriere/
 *   The /jobs/ index page (https://www.stgag.ch/jobs/) is rendered server-side
 *   by Typo3 + an Angular frontend (`comsolit.angular.frontend`). The full
 *   list of vacancies is embedded inline as a `<script data-name="jobs"
 *   type="application/json" class="embedded-json-data">` block; the Angular
 *   bundle reads it via `getEmbeddedJson` (no API call to fetch jobs).
 *
 * Embedded JSON shape:
 *   { count: 157, jobs: "<stringified array of {id,title,workplace,...}>" }
 * Each entry has:
 *   id, title, workplace, secondWorkplace, department, departmentId,
 *   contractType ("Befristet" | "Unbefristet"), employment ("Teilzeit" |
 *   "Vollzeit"), startDate, branchId, branchName, publishDate, applicationUrl,
 *   detailUrl, onlineSince, timestamp.
 *
 * Detail/Apply URLs point to the Umantis tenant `rekrutierung.stgag.ch`
 * (private subdomain CNAME for an Umantis recruiting app — same vendor as
 * KSA, but tenant ID is hidden behind the public hostname). The embedded JSON
 * has no body, so each job's description is read from its detail page
 * (`extractStgagDetailDescription`), with the listing metadata appended.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalThurgauJobs()  — Fetch and parse all jobs
 *   - isSpitalThurgauJob()         — Match jobs belonging to STGAG
 *   - isTrustedDomain()            — Validate URLs belong to STGAG
 *   - SPITAL_THURGAU_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { slugify, normalizeSpace, normalizeDescriptionSpace, normalizeDescriptionBullets, stripHtml } from './crawler-template.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_THURGAU_KEY = 'spital-thurgau';
export const SPITAL_THURGAU_COMPANY_NAME = 'Spital Thurgau (STGAG)';
export const SPITAL_THURGAU_COMPANY_DOMAIN = 'stgag.ch';

/**
 * The WHOLE text the parser used to publish INSTEAD of the Umantis detail
 * body (issue 5253), and nothing else: "<title> — Spital Thurgau (STGAG)."
 * over the "• <label>: <value>" lines of the listing metadata, or
 * "<title> — Spital Thurgau (STGAG), <city>" without them. Anchored at both
 * ends on purpose: the published ad (detail body + the same metadata lines)
 * must never be taken for it. Only ever recognised, to remove it from stored
 * jobs before the merge (`prepareExistingJobs` in update-spital-thurgau-jobs.mjs).
 */
export const SPITAL_THURGAU_FABRICATED_DESCRIPTION_RE = new RegExp(
  '^\\s*[^\\n]{1,200}? — Spital Thurgau \\(STGAG\\)'
  + '(?:\\.\\s*(?:\\n\\s*• (?:Standort|Abteilung|Bereich|Pensum|Anstellungsverhältnis|Eintrittsdatum): [^\\n]*)+|, [^\\n]{1,120})\\s*$',
);

const LISTING_URL = 'https://www.stgag.ch/jobs/';
/** Pause between detail requests: one Umantis tenant, ~160 vacancies. */
const DETAIL_DELAY_MS = 200;
const PUBLIC_CAREER_URL = 'https://www.stgag.ch/karriere/bildung-karriere/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isSpitalThurgauJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_THURGAU_KEY ||
    key === 'stgag' ||
    key.startsWith('spital-thurgau') ||
    company.includes('spital thurgau') ||
    company.includes('stgag') ||
    url.includes('stgag.ch') ||
    url.includes('rekrutierung.stgag.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'stgag.ch' ||
      host.endsWith('.stgag.ch') ||
      host === 'rekrutierung.stgag.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', department = '', branchName = '') {
  const signal = `${normalize(title)} ${normalize(department)} ${normalize(branchName)}`;
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|psychiatr|psycholog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr|install)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '', contractType = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|doktorand|ausbildung)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(employment = '', title = '') {
  const t = normalize(employment || title);
  if (/teilzeit|part.?time/.test(t)) return 'PART_TIME';
  if (/vollzeit|full.?time/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Map STGAG `workplace` to a Swiss canton. STGAG runs sites in Münsterlingen
 * (TG), Frauenfeld (TG), Romanshorn (TG), Weinfelden (TG) and other Thurgau
 * locations — every workplace on this domain is in canton TG.
 */
function pickCanton() {
  return 'TG';
}

/**
 * Pick the best-effort city from the workplace string. STGAG returns values
 * like "Spital Münsterlingen" or "Psychiatriezentrum, Romanshorn". We try
 * the comma-separated tail first, then fall back to a known-city scan, then
 * to "Münsterlingen" (HQ).
 */
function pickCity(workplace = '') {
  const ws = String(workplace || '').trim();
  if (!ws) return 'Münsterlingen';
  const commaTail = ws.split(',').pop().trim();
  if (commaTail && /^[A-Za-zÄÖÜäöüß'\- ]{3,}$/.test(commaTail)) return commaTail;
  const cities = ['Münsterlingen', 'Frauenfeld', 'Romanshorn', 'Weinfelden', 'Kreuzlingen', 'Amriswil', 'Arbon'];
  const found = cities.find((c) => ws.includes(c));
  return found || 'Münsterlingen';
}

function pickPostalCode(city = '') {
  switch (String(city || '').toLowerCase()) {
    case 'münsterlingen': return '8596';
    case 'frauenfeld': return '8500';
    case 'romanshorn': return '8590';
    case 'weinfelden': return '8570';
    case 'kreuzlingen': return '8280';
    case 'amriswil': return '8580';
    case 'arbon': return '9320';
    default: return '8596';
  }
}

/**
 * Parse "DD.MM.YYYY" into ISO date "YYYY-MM-DD".
 * Returns an empty value when the source publication date is missing or malformed.
 */
function parseSwissDate(raw = '') {
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/* ── Embedded-JSON Parser ─────────────────────────────────── */

/**
 * Parse the embedded `<script data-name="jobs" type="application/json">`
 * block out of the Typo3 HTML and return the array of raw job records.
 */
export function parseStgagEmbeddedJson(html = '') {
  const m = html.match(
    /<script[^>]*data-name="jobs"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) {
    console.warn(
      '⚠️ spital-thurgau: embedded <script data-name="jobs"> block not found in the page — the Typo3/Angular markup may have changed (a genuinely-empty board would still embed `jobs: []`).',
    );
    return [];
  }
  let outer;
  try {
    outer = JSON.parse(m[1]);
  } catch {
    console.warn(
      '⚠️ spital-thurgau: embedded <script data-name="jobs"> block is not valid JSON — the source markup may have changed.',
    );
    return [];
  }
  // STGAG double-encodes: outer.jobs is a JSON string, not an array. Decode it
  // in place so the shared shape guard below validates the real list whether the
  // source double-encodes (string) or emits `jobs` as a direct array.
  if (typeof outer?.jobs === 'string') {
    try {
      outer.jobs = JSON.parse(outer.jobs);
    } catch {
      console.warn(
        '⚠️ spital-thurgau: double-encoded `jobs` string failed to JSON-parse — the source markup may have changed.',
      );
      return [];
    }
  }
  return assertJsonListShape(outer, { key: 'jobs', source: 'spital-thurgau' });
}

/* ── Detail-page body ─────────────────────────────────────── */

/**
 * Inner HTML of the first element matched by `openTagRx`, balanced on its own
 * tag name so nested elements of the same kind do not end it early.
 */
function elementInner(html, openTagRx) {
  const open = openTagRx.exec(html);
  if (!open) return '';
  const tag = open[0].match(/^<\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
  if (!tag) return '';
  const start = open.index + open[0].length;
  const tagRx = new RegExp(`<\\s*(\\/?)\\s*${tag}\\b[^>]*>`, 'gi');
  tagRx.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tagRx.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

function blockText(fragment = '') {
  // The tenant's templates carry CRLF line ends inside the markup.
  // `stripHtml` closes each `<li>` with its own newline: keep a list tight.
  return normalizeDescriptionSpace(stripHtml(fragment).replace(/\r\n?/g, '\n'))
    .replace(/\n{2,}(?=• )/g, '\n');
}

/** The employer paragraph without award images, QR code and job-board link. */
function employerParagraph(fragment = '') {
  return blockText(fragment
    .replace(/<div\b[^>]*class="[^"]*\bimageWrapper\b[\s\S]*$/i, '')
    .replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' '));
}

/**
 * The vacancy body of a `rekrutierung.stgag.ch` detail page.
 *
 * STGAG's Umantis tenant renders the whole ad server-side, in one of two
 * templates (both seen on the live board, 2026-09-29):
 *
 *   - current: `<article class="articleBody">` with `#jobIntroOne`,
 *     `#jobIntroTwo`, `.jobDescription` / `.profileDescription` lists and the
 *     employer paragraph in `#ueberUns`;
 *   - older: `<div id="Job">` intro, `<main><section class="l-row">` with the
 *     task/profile lists, and the employer paragraph in `#Uns`.
 *
 * The benefits grid (script-filled, or a string of benefit codes in the
 * older template), the contact card, the map and the share bar are not read. Returns '' when neither template is there, and the caller
 * keeps the listing metadata.
 *
 * @param {string} html
 * @returns {string} plain text, sections separated by a blank line, list items as `• `
 */
export function extractStgagDetailDescription(html = '') {
  const page = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const sections = [];
  const push = (text) => { if (text) sections.push(text); };

  const article = elementInner(page, /<article\b[^>]*class="[^"]*\barticleBody\b[^"]*"[^>]*>/i);
  if (article) {
    // The intro sentence often ends on «eine/n» and continues with the title
    // block, so the title and workload stay in reading order.
    push(blockText(elementInner(article, /<div\b[^>]*id="jobIntroOne"[^>]*>/i)));
    push(blockText(elementInner(article, /<div\b[^>]*class="[^"]*\bjobTitleContainer\b[^"]*"[^>]*>/i)));
    push(blockText(elementInner(article, /<div\b[^>]*id="jobIntroTwo"[^>]*>/i)));
    const lists = ['jobDescription', 'profileDescription']
      .map((cls) => blockText(elementInner(article, new RegExp(`<div\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i'))));
    if (!lists.some(Boolean)) return '';
    lists.forEach(push);
    push(employerParagraph(elementInner(article, /<section\b[^>]*id="ueberUns"[^>]*>/i)));
    return sections.join('\n\n').trim();
  }

  const lists = blockText(elementInner(page, /<section\b[^>]*class="l-row"[^>]*>/i));
  if (!lists) return '';
  push(blockText(elementInner(page, /<div\b[^>]*id="Job"[^>]*>/i)));
  push(lists);
  push(employerParagraph(elementInner(page, /<div\b[^>]*id="Uns"[^>]*>/i)));
  return sections.join('\n\n').trim();
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSpitalThurgauJobs() {
  console.log(`🏥 Fetching ${SPITAL_THURGAU_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.error(`❌ Failed to fetch /jobs/ page: ${err?.message}`);
    return [];
  }

  const records = parseStgagEmbeddedJson(html);
  if (records.length === 0) {
    console.warn('⚠️ No embedded job data found in the page.');
    return [];
  }
  console.log(`  📋 Embedded jobs: ${records.length}\n`);

  const jobs = [];
  const seen = new Set();
  let detailHits = 0;
  for (const rec of records) {
    if (rec?.type && rec.type !== 'job') continue;
    const id = String(rec?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = normalizeSpace(String(rec?.title || ''));
    if (!title || title.length < 3) continue;

    const workplace = normalizeSpace(String(rec?.workplace || rec?.secondWorkplace || ''));
    const department = normalizeSpace(String(rec?.department || ''));
    const branchName = normalizeSpace(String(rec?.branchName || ''));
    const employment = normalizeSpace(String(rec?.employment || ''));
    const contractType = normalizeSpace(String(rec?.contractType || ''));

    const city = pickCity(workplace);
    const canton = pickCanton();

    const detailUrl = String(rec?.detailUrl || '').trim()
      || `https://rekrutierung.stgag.ch/Vacancies/${id}/Description/1?lang=ger`;
    const applyUrl = String(rec?.applicationUrl || '').trim()
      || `https://rekrutierung.stgag.ch/Vacancies/${id}/Application/CheckLogin/1?lang=ger`;

    const descBits = [];
    if (workplace) descBits.push(`• Standort: ${workplace}`);
    if (department) descBits.push(`• Abteilung: ${department}`);
    if (branchName) descBits.push(`• Bereich: ${branchName}`);
    if (employment) descBits.push(`• Pensum: ${employment}`);
    if (contractType) descBits.push(`• Anstellungsverhältnis: ${contractType}`);
    if (rec?.startDate) descBits.push(`• Eintrittsdatum: ${rec.startDate}`);
    // The listing JSON carries metadata only; the ad itself (tasks, profile,
    // employer paragraph) lives on the Umantis detail page. Without it every
    // job published ~250 chars of Standort/Abteilung/Pensum (issue 5253).
    let detailBody = '';
    try {
      detailBody = extractStgagDetailDescription(await fetchPage(detailUrl));
    } catch (err) {
      console.warn(`  ⚠️ detail ${id}: ${err?.message || err} — no description this run`);
    }
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    if (detailBody) detailHits++;
    const metadata = descBits.join('\n');
    // Only the ad's own text (issue 5253): no "<title> — Spital Thurgau
    // (STGAG)." line over the listing metadata in place of a detail body that
    // was not read. A detail body under the common 50-word floor gives no
    // description (the shared pipeline's thin-source path).
    const descriptionText = meetsSourceBodyFloor(detailBody)
      ? normalizeDescriptionBullets([detailBody, metadata].filter(Boolean).join('\n\n'))
      : '';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} stgag ch`);
    const urlHash = createHash('sha1')
      .update(`stgag-vacancy-${id}`)
      .digest('hex')
      .slice(0, 12);

    const employmentType = detectEmploymentType(employment, title);
    const contract = /teilzeit/i.test(employment) ? 'part-time' : 'full-time';

    const job = {
      id: `spital-thurgau-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_THURGAU_COMPANY_NAME,
      companyKey: SPITAL_THURGAU_KEY,
      companyDomain: SPITAL_THURGAU_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: detailUrl,
      source: 'STGAG Dedicated Parser (embedded JSON @ stgag.ch/jobs/)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      postalCode: pickPostalCode(city),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department, branchName),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, contractType),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(parseSwissDate(rec?.publishDate || rec?.onlineSince || '')),
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (department) job.department = department;
    if (contractType) job.contractDuration = /^befristet$/i.test(contractType) ? 'fixed-term' : 'permanent';

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SPITAL_THURGAU_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${jobs.length} with the detail-page body)`);
  return jobs;
}
