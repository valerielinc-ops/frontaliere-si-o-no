#!/usr/bin/env node
/**
 * Kanton Aargau (cantonal administration) job parser — official stellenmarkt.
 *
 * Source (2026-09): the canton's public job market
 * https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt
 * renders a widget whose data API is `https://www.ag.ch/io/jobs-proxy/jobs`:
 * a JSON list in Prospective format (`id`, `title`, `attributes`, `szas`,
 * `links.directlink`, `startDate`/`endDate`), 64 open vacancies on
 * 2026-09-29. Each `directlink` is a server-rendered page on jobs.ag.ch whose
 * JSON-LD JobPosting carries the ad (tasks, profile, working environment,
 * workplace address) and whose `#benefits` block lists the canton's benefits.
 *
 * Until 2026-09 this parser walked the Umantis tenant 12705 (`/Jobs/All`)
 * and synthesised a blurb for every row, on the belief (2026-07) that the
 * Prospective leads were dead and no body was reachable. That listing is the
 * canton's application back office, not its job market: 423 rows against 64
 * published, ~110 of them posted 2020-2022, and the same title under several
 * ids (e.g. «Vollzugsangestellter Bezirksgefängnis 100%» ×3), which is where
 * the duplicate-description findings of issue 5253 came from. Every row also
 * got the canton HQ (Aarau) as location.
 *
 * Exports 4 functions crawler template:
 * - fetchAllKantonAargauJobs() — Fetch + parse all jobs from the job market
 * - isKantonAargauJob()        — Match jobs belonging to Kanton Aargau
 * - isTrustedDomain()          — Validate URLs belong to ag.ch
 * - KANTON_AARGAU_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import {
  slugify,
  stripHtml,
  normalizeSpace,
  normalizeDescriptionSpace,
  normalizeDescriptionBullets,
} from './crawler-template.mjs';
import { decodeHtmlEntities as decodeNamedEntities, decodeNumericEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KANTON_AARGAU_KEY = 'kanton-aargau';
export const KANTON_AARGAU_COMPANY_NAME = 'Kanton Aargau';
export const KANTON_AARGAU_COMPANY_DOMAIN = 'ag.ch';

const JOBS_API_URL = 'https://www.ag.ch/io/jobs-proxy/jobs';
const PUBLIC_CAREER_URL = 'https://www.ag.ch/de/ueber-uns/jobs-karriere/offene-stellen/stellenmarkt';
const HQ_CANTON = 'AG';
/** Pause between detail requests. */
const DETAIL_DELAY_MS = 300;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function decodeText(value = '') {
  return decodeNamedEntities(decodeNumericEntities(String(value || '')));
}

/** HTML fragment → plain text with `• ` list items. */
function htmlToText(html = '') {
  return normalizeDescriptionSpace(stripHtml(decodeText(String(html || '').replace(/\s*[\r\n]+\s*/g, ' '))))
    .replace(/\n{2,}(?=• )/g, '\n');
}

/* ── Company Matchers ─────────────────────────────────────── */

export function isKantonAargauJob(job) {
  if (!job) return false;
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === KANTON_AARGAU_KEY
    || company === normalize(KANTON_AARGAU_COMPANY_NAME)
    || url.includes('ag.ch')
    || url.includes('recruitingapp-12705.umantis.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'ag.ch' || host.endsWith('.ag.ch')) return true;
    if (host === 'ohws.prospective.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics (public admin) ─ */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(lehrperson|lehrer|lehrerin|schule|kindergarten|primarstufe|sekundarstufe|kantonsschule|berufsschule|dozent)/.test(t)) return 'Formazione';
  if (/\b(polizist|polizei|kapo|einsatz|fahndung)/.test(t)) return 'Sicurezza';
  if (/\b(pflege|pflegefach|fage|gesundheit|arzt|ärztin|medizin|sozialdienst|betreuung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(recht|jurist|rechtspraktikum|gericht|staatsanwalt|notariat)/.test(t)) return 'Legale';
  if (/\b(it|informatik|software|develop|system|digital)/.test(t)) return 'IT';
  if (/\b(admin|sekretariat|sachbearbeit|buchhalt|finanz|controll|revision|revisor)/.test(t)) return 'Amministrazione';
  if (/\b(hr|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(techni|haustechni|facility|wald|förster|umwelt|natur|landschaft)/.test(t)) return 'Tecnica';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|hochschulpraktikum)/.test(t)) return 'Formazione';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|lehrling|lernend|apprenti|hochschulpraktikum|rechtspraktikum)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leiterin|leitend|kommandant)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/* ── Listing ───────────────────────────────────────────────── */

/**
 * The job-market API payload → one entry per open vacancy.
 *
 * Attribute ids as the stellenmarkt widget labels them: 10 Fachbereich,
 * 15 Themenbereich, 20 Arbeitsort, 30 Abteilung, 40 Pensum, 50 Stellenart,
 * 70 Anstellung (befristet/unbefristet).
 *
 * @param {{ jobs?: object[] }} payload
 * @returns {Array<{ id: string, title: string, url: string, location: string, department: string,
 *   pensum: string, kind: string, field: string, term: string, startDate: string, endDate: string }>}
 */
export function parseAgJobsApi(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const first = (attrs, id) => normalizeSpace(decodeText((attrs?.[id] || [])[0] || ''));
  const out = [];
  const seen = new Set();
  for (const job of jobs) {
    const id = String(job?.id || '').trim();
    const url = String(job?.links?.directlink || '').trim();
    const title = normalizeSpace(decodeText(job?.title || ''));
    if (!id || !url || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      url,
      location: first(job.attributes, '20'),
      department: first(job.attributes, '30'),
      pensum: first(job.attributes, '40'),
      kind: first(job.attributes, '50'),
      field: first(job.attributes, '10'),
      term: first(job.attributes, '70'),
      startDate: String(job?.startDate || ''),
      endDate: String(job?.endDate || ''),
    });
  }
  return out;
}

/* ── Detail page ──────────────────────────────────────────── */

/**
 * The ad on a jobs.ag.ch vacancy page: the JSON-LD JobPosting description
 * (tasks, profile, working environment, as the page shows them), the page's
 * `#benefits` block, and the structured workplace address.
 *
 * @param {string} html
 * @returns {{ description: string, streetAddress: string, postalCode: string,
 *   addressLocality: string, datePosted: string, validThrough: string, employmentType: string }}
 */
export function extractAgJobPosting(html = '') {
  const empty = { description: '', streetAddress: '', postalCode: '', addressLocality: '', datePosted: '', validThrough: '', employmentType: '' };
  let posting = null;
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data?.['@graph'] || [data]);
    posting = nodes.find((node) => node?.['@type'] === 'JobPosting') || posting;
    if (posting) break;
  }
  if (!posting) return empty;
  const sections = [];
  const body = htmlToText(String(posting.description || '').replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, '<p>$1</p>'));
  if (body) sections.push(body);
  const benefitsStart = html.search(/<div\b[^>]*id="benefits"[^>]*>/i);
  if (benefitsStart >= 0) {
    const fragment = html.slice(benefitsStart);
    const perks = [...fragment.matchAll(/<div\s+class="benefitText"[^>]*>([\s\S]*?)<\/div>/gi)]
      .slice(0, 20)
      .map((m) => htmlToText(m[1].replace(/<b>([\s\S]*?)<\/b>/i, '<p>$1</p>')))
      .filter(Boolean);
    const unique = [...new Set(perks)];
    if (unique.length) sections.push(`Benefits\n${unique.join('\n')}`);
  }
  const address = (Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation)?.address || {};
  return {
    description: normalizeDescriptionBullets(sections.join('\n\n')),
    streetAddress: normalizeSpace(address.streetAddress || ''),
    postalCode: normalizeSpace(String(address.postalCode || '')),
    addressLocality: normalizeSpace(address.addressLocality || ''),
    datePosted: String(posting.datePosted || ''),
    validThrough: String(posting.validThrough || ''),
    employmentType: String(posting.employmentType || ''),
  };
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchText(url, accept) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: accept, 'User-Agent': USER_AGENT, 'Accept-Language': 'de-CH,de;q=0.9' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllKantonAargauJobs() {
  console.log(`🏛️  Fetching ${KANTON_AARGAU_COMPANY_NAME} jobs`);
  console.log(`   Source: ${JOBS_API_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  let payload;
  try {
    payload = JSON.parse(await fetchText(JOBS_API_URL, 'application/json'));
  } catch (err) {
    // A failed read is not an empty board: throw so the pipeline keeps the
    // prior slice instead of retiring every job.
    throw new Error(`Kanton Aargau job-market API unavailable: ${err?.message || err}`);
  }
  const entries = parseAgJobsApi(payload);
  const total = Number(payload?.total);
  console.log(`  ✓ ${entries.length} vacancies in the job market${Number.isFinite(total) ? ` (API total ${total})` : ''}\n`);
  if (Number.isFinite(total) && total > entries.length) {
    console.warn(`  ⚠️ API reports ${total} vacancies but returned ${entries.length}.`);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (const entry of entries) {
    let detail = null;
    try {
      detail = extractAgJobPosting(await fetchText(entry.url, 'text/html,application/xhtml+xml'));
    } catch (err) {
      console.warn(`  ⚠️ detail ${entry.id}: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));

    const location = detail?.addressLocality || entry.location || 'Aarau';
    const canton = inferSwissTargetCanton(location) || HQ_CANTON;
    const meta = [
      entry.pensum && `• Pensum: ${entry.pensum}`,
      entry.term && `• Anstellung: ${entry.term}`,
      entry.department && `• Abteilung: ${entry.department}`,
      `• Arbeitsort: ${location}`,
    ].filter(Boolean).join('\n');
    let description = detail?.description || '';
    if (description) detailHits += 1;
    description = description
      ? `${description}\n\n${meta}`
      : `${entry.title} — ${KANTON_AARGAU_COMPANY_NAME}.\n\n${meta}`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${entry.title} kanton-aargau ch`);
    const urlHash = createHash('sha1').update(`kanton-aargau-job-${entry.id}`).digest('hex').slice(0, 12);
    const postedDate = (detail?.datePosted || entry.startDate || '').slice(0, 10) || todayIso;
    const employmentType = /teilzeit|part/i.test(detail?.employmentType || '') ? 'PART_TIME'
      : (/full|voll/i.test(detail?.employmentType || '') ? 'FULL_TIME' : detectEmploymentType(`${entry.title} ${entry.pensum}`));

    const job = {
      id: `${KANTON_AARGAU_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KANTON_AARGAU_COMPANY_NAME,
      companyKey: KANTON_AARGAU_KEY,
      companyDomain: KANTON_AARGAU_COMPANY_DOMAIN,
      title: entry.title,
      titleByLocale: { [sourceLang]: entry.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: entry.url,
      source: `${KANTON_AARGAU_COMPANY_NAME} Dedicated Parser (ag.ch job market)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      ...(detail?.streetAddress ? { streetAddress: detail.streetAddress } : {}),
      ...(detail?.postalCode ? { postalCode: detail.postalCode } : {}),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(entry.title),
      contract: /befristet/i.test(entry.term) && !/unbefristet/i.test(entry.term) ? 'temporary' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(entry.title),
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(detail?.validThrough || entry.endDate ? { validThrough: (detail?.validThrough || entry.endDate) } : {}),
      applyUrl: entry.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };
    if (entry.department) job.department = entry.department;
    jobs.push(job);
  }

  console.log(`📋 Total ${KANTON_AARGAU_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${jobs.length} with the detail-page body)`);
  return jobs;
}
