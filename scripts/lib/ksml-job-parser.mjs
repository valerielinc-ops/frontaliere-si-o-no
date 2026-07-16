#!/usr/bin/env node
/**
 * KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern) parser.
 *
 * Public portal: https://www.ksml.apps.be.ch/ksml/
 *
 * KSML is the Canton of Bern's official cantonal job market for teachers
 * ("Kantonaler Stellenmarkt für Lehrerinnen und Lehrer"), run by the Bern
 * Directorate of Education and Culture (Bildungs- und Kulturdirektion, BKD).
 * Bern school authorities (Volksschule, Kindergarten, Sek/Real, special
 * education) publish open teaching positions here — the primary publication
 * channel for permanent and fixed-term teaching roles in the canton.
 *
 * The portal is an Angular SPA (`<app-root>`) that hydrates from an
 * unauthenticated JSON REST endpoint (discovered by grepping the compiled
 * bundle for "ws/stellen"):
 *
 *   GET https://www.ksml.apps.be.ch/ksml/ws/stellen/
 *     → JSON array of ALL published postings (no pagination, ~150 rows)
 *
 * Detail page (Angular query-param route, confirmed live via search-indexed
 * URL "…/ksml/?q=stellen/ad/35547"):
 *
 *   https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/{stelleId}
 *
 * Each row's `stelleBase.inseratesprache` is a fixed system code — '1' for
 * German postings, '2' for French (Berner Jura / Seeland bilingual schools).
 * The metadata labels (`arbeitspensum`, `funktion`, `schulstufe`,
 * `anstellungsverhaeltnis`) are ALWAYS German system-codelist labels
 * regardless of the ad's own language — only `firmenportrait` / `aufgaben` /
 * `anforderungen` / `wirBieten` (the free-text body fields) follow
 * `inseratesprache`.
 *
 * `stelleBase.adresseOrg.strasse` is null on ~all rows (schools don't fill
 * it in), but `stelleBase.kontakt` (a free-text contact block) frequently
 * embeds the real street address on its own line. We extract it there when
 * possible. `kontakt` also carries named contact persons / phone / email —
 * PII that must never end up in the public job description — so it is used
 * ONLY for street-address extraction, never rendered into `description`.
 * When no street line is recoverable, fall back to the (real) city name as
 * `streetAddress` — the same "known city, unknown street" convention used by
 * `saint-gobain-weber-isover-job-parser.mjs` / `somedia-job-parser.mjs` for
 * other multi-site employers, rather than inventing a fictional street.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKsmlJobs()   — Fetch and parse all jobs
 *   - isKsmlJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace, normalizeDescriptionBullets } from './crawler-template.mjs';
import { appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KSML_KEY = 'ksml';
export const KSML_COMPANY_NAME = 'KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern)';
export const KSML_COMPANY_DOMAIN = 'ksml.apps.be.ch';

const API_URL = 'https://www.ksml.apps.be.ch/ksml/ws/stellen/';
const CAREER_URL = 'https://www.ksml.apps.be.ch/ksml/';
const DEFAULT_CANTON = 'BE';
const DEFAULT_ADDRESS_REGION = 'BE';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function detailUrlFor(stelleId) {
  return `https://www.ksml.apps.be.ch/ksml/?q=stellen/ad/${stelleId}`;
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isKsmlJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KSML_KEY ||
    key.startsWith('ksml') ||
    company.includes('ksml') ||
    company.includes('kantonaler stellenmarkt') ||
    url.includes('ksml.apps.be.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ksml.apps.be.ch' ||
      host === 'www.ksml.apps.be.ch' ||
      host.endsWith('.ksml.apps.be.ch')
    );
  } catch {
    return false;
  }
}

/* ── Source language ──────────────────────────────────────── */

// KSML's own system code: '1' = German, '2' = French (Berner Jura / bilingual
// Seeland schools). Verified live: every '2'-coded row's free-text fields
// (firmenportrait/aufgaben/anforderungen/wirBieten) are actually in French,
// and every French row belongs to the "Berner Jura" region.
function sourceLangFromCode(code) {
  return String(code || '').trim() === '2' ? 'fr' : 'de';
}

/* ── Category / experience / employment detection ─────────── */

function detectCategory(funktionLabel = '') {
  const t = normalize(funktionLabel);
  if (/schulleitung|f[uü]hrungsfunktion/.test(t)) return 'Istruzione / Direzione scolastica';
  if (/klassenhilfe/.test(t)) return 'Istruzione / Assistenza in classe';
  if (/spez\.?\s*unterricht/.test(t)) return 'Istruzione / Sostegno pedagogico';
  if (/besondere volksschule/.test(t)) return 'Istruzione / Scuola speciale';
  return 'Istruzione / Docenza';
}

function detectExperienceLevel(funktionLabel = '') {
  const t = normalize(funktionLabel);
  if (/schulleitung|f[uü]hrungsfunktion/.test(t)) return 'senior';
  if (/klassenhilfe/.test(t)) return 'junior';
  return 'mid';
}

function detectEmploymentType(arbeitspensumLabel = '') {
  const t = normalize(arbeitspensumLabel);
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  if (/teilzeit/.test(t)) return 'PART_TIME';
  return 'OTHER';
}

/* ── Street-address extraction from the `kontakt` free-text block ──
 * `kontakt` is PII-bearing (named contact person, phone, email) — used only
 * to recover a real street line, never rendered into the public description.
 */
const STREET_LINE_RE = /^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ.\-' ]{2,40}\s\d{1,4}[a-zA-Z]?)$/;
const STREET_FALSE_POSITIVE_RE = /schulleit|zyklus|klasse\b|abteilung|team\b/i;

function extractStreetFromKontakt(kontakt = '') {
  const lines = String(kontakt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (STREET_FALSE_POSITIVE_RE.test(line)) continue;
    const m = STREET_LINE_RE.exec(line);
    if (m) return normalizeSpace(m[1]);
  }
  return '';
}

/* ── Description builder (never includes `kontakt` — PII) ─────────── */

const SECTION_HEADERS = {
  de: { portrait: 'Porträt', aufgaben: 'Aufgaben', anforderungen: 'Anforderungen', wirBieten: 'Wir bieten' },
  fr: { portrait: 'Portrait', aufgaben: 'Tâches', anforderungen: 'Profil requis', wirBieten: 'Nous offrons' },
};

function buildDescription({ firmenportrait, aufgaben, anforderungen, wirBieten }, lang) {
  const headers = SECTION_HEADERS[lang] || SECTION_HEADERS.de;
  const parts = [];
  if (normalizeSpace(firmenportrait)) parts.push(`${headers.portrait}\n${firmenportrait.trim()}`);
  if (normalizeSpace(aufgaben)) parts.push(`${headers.aufgaben}\n${aufgaben.trim()}`);
  if (normalizeSpace(anforderungen)) parts.push(`${headers.anforderungen}\n${anforderungen.trim()}`);
  if (normalizeSpace(wirBieten)) parts.push(`${headers.wirBieten}\n${wirBieten.trim()}`);
  const raw = parts.join('\n\n');
  return normalizeDescriptionSpace(normalizeDescriptionBullets(raw));
}

/* ── Date helper ──────────────────────────────────────────── */

function parseKsmlTimestamp(raw = '') {
  // "2026-06-23 06:57:25.495" → "2026-06-23"
  const m = String(raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().split('T')[0];
}

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchStellenList() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${API_URL}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        const err = new Error(`Invalid JSON from ${API_URL}: ${parseErr?.message || parseErr}`);
        err.retryable = true;
        err.cause = parseErr;
        throw err;
      }
      if (!Array.isArray(data)) throw new Error('Unexpected KSML ws/stellen/ shape (not an array)');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }, { label: `ksml ${API_URL}` });
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all KSML jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKsmlJobs() {
  console.log(`🎓 Fetching ${KSML_COMPANY_NAME} jobs`);
  console.log(`   Source: ${API_URL}\n`);

  const rows = await fetchStellenList();
  if (!rows || rows.length === 0) {
    console.warn('⚠️ No job listings returned from KSML ws/stellen/ API.');
    return [];
  }
  console.log(`  ✓ Total rows: ${rows.length}`);

  const jobs = [];
  const seenIds = new Set();

  for (const row of rows) {
    if (String(row?.publikationsstatus || '').toUpperCase() !== 'PUBLISHED') continue;

    const stelleId = row?.stelleId;
    if (stelleId === undefined || stelleId === null) continue;
    if (seenIds.has(stelleId)) continue;
    seenIds.add(stelleId);

    const sb = row?.stelleBase || {};
    const md = row?.stelleMetaData || {};
    const mdl = row?.stelleMetaDataLehrer || {};

    const title = normalizeSpace(stripHtml(String(sb.stellentitel || '')));
    if (!title || title.length < 3) continue;

    const organisation = normalizeSpace(sb.organisation || '') || KSML_COMPANY_NAME;
    const plzOrt = sb.adresseOrg?.plzOrt || {};
    const postalCode = normalizeSpace(plzOrt.plz || '') || '3000';
    const city = normalizeSpace(plzOrt.ort || '') || 'Bern';

    const sourceLang = sourceLangFromCode(sb.inseratesprache);
    const detailUrl = detailUrlFor(stelleId);

    const streetAddress = normalizeSpace(sb.adresseOrg?.strasse || '')
      || extractStreetFromKontakt(sb.kontakt)
      || city;

    const arbeitspensumLabel = md.arbeitspensum?.label || '';
    const funktionLabel = mdl.funktion?.label || '';
    const employmentType = detectEmploymentType(arbeitspensumLabel);
    const contract = employmentType === 'PART_TIME' ? 'part-time' : 'full-time';

    const description = buildDescription(
      {
        firmenportrait: sb.firmenportrait,
        aufgaben: sb.aufgaben,
        anforderungen: sb.anforderungen,
        wirBieten: sb.wirBieten,
      },
      sourceLang,
    );
    const fallbackDesc = sourceLang === 'fr'
      ? `${title} — poste auprès de ${organisation}, ${city} (Kanton Bern). Publié sur le marché cantonal de l'emploi pour les enseignant(e)s (KSML).`
      : `${title} — Stelle bei ${organisation}, ${city} (Kanton Bern). Publiziert auf dem Kantonalen Stellenmarkt für Lehrerinnen und Lehrer (KSML).`;
    const finalDescription = description.split(/\s+/).filter(Boolean).length >= 30 ? description : fallbackDesc;

    const jobSlug = appendSlugDisambiguator(
      slugify(`${title} ${organisation} ${city}`),
      String(stelleId),
    );
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `${KSML_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      slugDisambiguator: String(stelleId),
      company: KSML_COMPANY_NAME,
      companyKey: KSML_KEY,
      companyDomain: KSML_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: finalDescription,
      descriptionByLocale: { [sourceLang]: finalDescription },
      location: city,
      canton: DEFAULT_CANTON,
      url: detailUrl,
      source: 'KSML Dedicated Parser (ws/stellen JSON API)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      streetAddress,
      postalCode,
      addressRegion: DEFAULT_ADDRESS_REGION,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(funktionLabel),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(funktionLabel),
      sector: 'Istruzione / Scuola pubblica',
      currency: 'CHF',
      featured: false,
      postedDate: parseKsmlTimestamp(sb.erfassungTs),
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${KSML_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
