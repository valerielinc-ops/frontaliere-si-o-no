#!/usr/bin/env node
/**
 * Huber+Suhner AG job parser — bespoke Umantis ATS tenant (custom domain).
 *
 * Live-verified July 2026: hubersuhner.com/en/company/jobs-and-careers links
 * out via "Check our vacancies" to `recruiting.hubersuhner.com` — a Umantis
 * (Haufe/Ivanti Umantis "Talent Management Suite") instance published behind
 * a corporate CNAME (no numeric `recruitingapp-{tenantId}.umantis.com`
 * subdomain visible), same family as the hospital tenants in
 * `scripts/lib/umantis-listing-common.mjs` / `umantis-detail-helpers.mjs`.
 *
 * This tenant does NOT reuse the shared Umantis helpers because of two
 * genuine layout differences confirmed by fetching the live listing +
 * several detail pages:
 *
 *   1. Listing UI is the "older" `tableaslist_contentrow1|2` layout (same
 *      family as KSBL/Adullam), BUT the per-job `/Vacancies/{id}/Description/{N}`
 *      path segment is a genuine per-posting language-variant id (observed
 *      values: 1, 2, 5, 30 — NOT a fixed 4-value ger/fre/eng/ita enum). The
 *      shared factory (`createUmantisListingParser`) computes a single
 *      `langCode` from the configured listing language and applies it to
 *      EVERY job — verified locally that this breaks here: e.g. job 7355's
 *      real content lives at `Description/1`; forcing `Description/3`
 *      (the "eng" formula) instead lands on the SPA/chrome shell with zero
 *      body text ("Kontakt: Keine Details erfasst"). So this parser reads
 *      the langCode straight off each row's own `href` instead of computing
 *      it, and reuses that same value for the `Application/CheckLogin`
 *      apply link (confirmed live: the "Jetzt bewerben" button on a
 *      `Description/1` page links to `Application/CheckLogin/1`, matching).
 *   2. Detail-page body markup is a custom skin: `<h4>Heading</h4><p>Body</p>`
 *      pairs inside `<div class="section__main__row__column">` (e.g. "Ihr
 *      Aufgabengebiet" / "Ihr Profil" / "Wieso HUBER+SUHNER?", or the English
 *      variant "Your tasks" / "Your profile" / "Why HUBER+SUHNER?"). This
 *      does not match any of the layouts `extractUmantisDetailContent()`
 *      recognises (customdatablock <li>, h2#expander-N, h3+padding), which
 *      returns '' on this tenant — confirmed locally against a saved
 *      detail-page fixture. Workload % / contract type (Befristet/
 *      Unbefristet / Unlimited) live in a `<p class="section__header__subtitle">`
 *      row right after the `<h1>` — also not covered by the shared helper.
 *
 * Both differences are additive extraction logic, not bugs in the shared
 * module, so this parser stays fully self-contained rather than editing
 * `umantis-listing-common.mjs` / `umantis-detail-helpers.mjs` for a single
 * tenant (see AGENTS.md: prefer a self-contained parser over touching
 * shared crawler infrastructure unless genuinely needed).
 *
 * Huber+Suhner posts globally on this single tenant (Switzerland, Germany,
 * Poland, India, China, Costa Rica, Tunisia, UK, ...). Scope narrowed to
 * Swiss postings only (Herisau AR head office + Pfäffikon ZH site) via the
 * listing-page location column.
 *
 * HQ / site addresses (no street address on the job pages themselves —
 * self-contained fallback map, deliberately NOT touching the CRITICAL-risk
 * `COMPANY_HQ` map in crawler-location-config.mjs, ~160 callers):
 *   - Herisau (AR):   Degersheimerstrasse 14, 9100 Herisau  (company imprint page)
 *   - Pfäffikon (ZH): Tumbelenstrasse 20, 8330 Pfäffikon ZH (business directory listings)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHuberSuhnerJobs() — Fetch and parse all Swiss jobs
 *   - isHuberSuhnerJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()         — Validate URLs belong to this company / ATS host
 *   - HUBER_SUHNER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HUBER_SUHNER_KEY = 'huber-suhner';
export const HUBER_SUHNER_COMPANY_NAME = 'Huber+Suhner AG';
export const HUBER_SUHNER_COMPANY_DOMAIN = 'hubersuhner.com';

const ATS_HOST = 'recruiting.hubersuhner.com';
const BASE_URL = `https://${ATS_HOST}`;
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=eng`;
const PUBLIC_CAREER_URL = 'https://www.hubersuhner.com/en/company/jobs-and-careers';

const SECTOR = 'Industria / Manifattura';

// Self-contained location fallback map — see file header for sourcing.
// Deliberately NOT wired into crawler-location-config.mjs COMPANY_HQ.
const LOCATIONS = {
  herisau: { city: 'Herisau', canton: 'AR', postalCode: '9100', streetAddress: 'Degersheimerstrasse 14' },
  pfaeffikon: { city: 'Pfäffikon', canton: 'ZH', postalCode: '8330', streetAddress: 'Tumbelenstrasse 20' },
};

const DETAIL_FETCH_DELAY_MS = 250;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', ccedil: 'ç', ndash: '–', mdash: '—',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isHuberSuhnerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HUBER_SUHNER_KEY ||
    key.startsWith('huber-suhner') ||
    company.includes('huber+suhner') ||
    company.includes('huber suhner') ||
    url.includes('hubersuhner.com') ||
    url.includes(ATS_HOST)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'hubersuhner.com' ||
      host.endsWith('.hubersuhner.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(operator|montage|laser|kabelproduktion|maschinenführer|maschinenfuhrer|produktion|manufactur)/.test(t)) return 'Produzione';
  if (/\b(automatiker|instandhaltung|maintenance|techni|hlk|process engineer)/.test(t)) return 'Tecnica';
  if (/\b(ingegner|engineer|entwickl|development)/.test(t)) return 'Ingegneria';
  if (/\b(quality|qualit|inspector)/.test(t)) return 'Qualità';
  if (/\b(controller|controlling|finanz|finance|buchhalt|account)/.test(t)) return 'Finanza';
  if (/\b(supply chain|logist|einkauf|magazz|lager)/.test(t)) return 'Logistica';
  if (/\b(sales|vertrieb|vendita|verkauf)/.test(t)) return 'Commerciale';
  if (/\b(it\b|software|informatik|ai solutions)/.test(t)) return 'IT';
  if (/\b(hr\b|human|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(marketing|kommunik)/.test(t)) return 'Marketing';
  if (/\b(praktik|intern|werkstudent|lehrling|lernend|apprenti)/.test(t)) return 'Formazione';
  return SECTOR === 'Industria / Manifattura' ? 'Produzione' : 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|werkstudent|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|leiter|leitend|corporate)/.test(t)) return 'senior';
  return 'mid';
}

/** Parse a workload span like "100%", "100 %", "40-60 %", "60 bis 100 %". */
function parseWorkload(text = '') {
  const nums = String(text || '').match(/\d{1,3}/g);
  if (!nums || nums.length === 0) return null;
  const values = nums.map((n) => parseInt(n, 10)).filter((n) => n > 0 && n <= 100);
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max };
}

function detectEmploymentTypeFromWorkload(workload) {
  if (!workload) return 'OTHER';
  return workload.max < 80 ? 'PART_TIME' : 'FULL_TIME';
}

/** Handles German (Befristet/Unbefristet) and English (Limited/Unlimited/Permanent). */
function detectContractDuration(text = '') {
  const t = normalize(text);
  if (/unbefristet|unlimited|permanent|indeterminato|indéterminée/.test(t)) return 'permanent';
  if (/\bbefristet\b|\btemporary\b|\blimited\b|\bfixed.?term\b/.test(t)) return 'temporary';
  return 'permanent';
}

/** DD.MM.YYYY -> YYYY-MM-DD */
function parseSwissDate(raw = '') {
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Resolve city/canton/postalCode/streetAddress from a raw listing location string. */
function resolveLocation(rawLocation = '') {
  const decoded = decodeEntities(rawLocation);
  const norm = normalize(decoded);
  const isPfaeffikon = /pf[aä]ffikon/.test(norm);
  const isHerisau = /herisau/.test(norm);

  // Combined listings (e.g. "Herisau (AR), Pfäffikon (ZH)") default to the
  // first-mentioned site (Herisau, the main HQ). Generic "Switzerland" /
  // "Schweiz" entries with no specific city also default to Herisau HQ.
  const bucket = isHerisau ? LOCATIONS.herisau
    : isPfaeffikon ? LOCATIONS.pfaeffikon
      : LOCATIONS.herisau;

  const canton = inferSwissTargetCanton(decoded) || bucket.canton;
  return {
    city: bucket.city,
    canton,
    postalCode: bucket.postalCode,
    streetAddress: bucket.streetAddress,
  };
}

/** Swiss-scope filter for the listing location column. */
function isSwissListingLocation(rawLocation = '') {
  const decoded = decodeEntities(rawLocation);
  return /herisau|pf[aä]ffikon|switzerland|schweiz|suisse|svizzera/i.test(decoded);
}

/* ── Listing parser (Umantis "older UI" — tableaslist_contentrow) ─────── */

function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const rowRx = /<tr\s+class="tableaslist_contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRx.exec(html))) {
    const row = m[1];
    const linkMatch = row.match(/href="\/Vacancies\/(\d+)\/Description\/(\d+)"[^>]*>([^<]+)<\/a>/);
    if (!linkMatch) continue;
    const [, id, langCode, rawTitle] = linkMatch;
    if (id === '9999' || seen.has(id)) continue;

    const title = normalizeSpace(decodeEntities(rawTitle));
    if (!title || title.length < 3) continue;
    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title)) continue;

    const locMatch = row.match(/tableaslist_element_1152495">&nbsp;\|&nbsp;\s*([^<]*)<\/span>/);
    const dateMatch = row.match(/Online since:\s*([\d.]+)/);

    seen.add(id);
    out.push({
      id,
      langCode,
      title,
      rawLocation: locMatch ? locMatch[1].trim() : '',
      onlineSince: dateMatch ? dateMatch[1] : '',
    });
  }
  return out;
}

/* ── Detail page extraction ───────────────────────────────────────────── */

/**
 * Extract the header metadata row: gender tag | location | workload % | contract
 * type, from `<h1 class="mbottom--small">Title</h1><p class="section__header__subtitle...">`.
 * HTML comments are stripped first — the CMS leaves stale commented-out
 * header markup from other postings further down some pages.
 */
function extractHeaderMeta(html = '') {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = clean.match(/<h1 class="mbottom--small">([^<]*)<\/h1>\s*<p class="section__header__subtitle[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (!m) return { title: '', spans: [] };
  const spans = [...m[2].matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
    .map((x) => normalizeSpace(decodeEntities(x[1])))
    .filter(Boolean);
  return { title: normalizeSpace(decodeEntities(m[1])), spans };
}

/**
 * Extract "Ihr Aufgabengebiet / Ihr Profil / Wieso HUBER+SUHNER?" (or the
 * English "Your tasks / Your profile / Why HUBER+SUHNER?") body sections:
 * `<h4>Heading</h4><p>Body</p>` pairs. Preserves bullet-list structure.
 */
function extractDetailSections(html = '') {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const rx = /<h4>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/g;
  const sections = [];
  let m;
  while ((m = rx.exec(clean))) {
    const heading = normalizeSpace(decodeEntities(stripHtml(m[1])));
    if (!heading) continue;
    let body = m[2]
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|ul|ol)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = normalizeSpace(decodeEntities(body)).replace(/\s*•\s*/g, '\n• ');
    if (body && body.length > 5) sections.push(`${heading}\n${body}`);
  }
  return sections;
}

async function fetchDetail(id, langCode) {
  const detailUrl = `${BASE_URL}/Vacancies/${id}/Description/${langCode}`;
  const applyUrl = `${BASE_URL}/Vacancies/${id}/Application/CheckLogin/${langCode}`;
  try {
    const html = await fetchHtml(detailUrl);
    const { spans } = extractHeaderMeta(html);
    const sections = extractDetailSections(html);
    return { detailUrl, applyUrl, spans, sections, html };
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed for vacancy ${id}: ${err?.message || err}`);
    return { detailUrl, applyUrl, spans: [], sections: [], html: '' };
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllHuberSuhnerJobs() {
  console.log(`🔍 Fetching ${HUBER_SUHNER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(LISTING_URL);
  const entries = parseListing(html);
  console.log(`  📋 Listings found (worldwide): ${entries.length}`);

  const swissEntries = entries.filter((e) => isSwissListingLocation(e.rawLocation));
  console.log(`  🇨🇭 Swiss listings (Herisau AR / Pfäffikon ZH): ${swissEntries.length}`);

  if (swissEntries.length === 0) {
    console.warn('⚠️ No Swiss job listings found.');
    return [];
  }

  const jobs = [];
  let detailHits = 0;
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const entry of swissEntries) {
    const { detailUrl, applyUrl, spans, sections } = await fetchDetail(entry.id, entry.langCode);
    await pause(DETAIL_FETCH_DELAY_MS);

    const { city, canton, postalCode, streetAddress } = resolveLocation(entry.rawLocation);
    const workload = parseWorkload(spans[2] || '');
    const contractText = spans[3] || '';

    let description;
    if (sections.length > 0) {
      description = sections.join('\n\n');
      detailHits += 1;
    } else {
      // Fallback: synthesise a structured description from listing + header
      // metadata so we never ship thin/boilerplate content when the detail
      // page extraction misses (network hiccup, unexpected markup change).
      const bullets = [`• Standort: ${entry.rawLocation || city} (${canton})`];
      if (workload) bullets.push(`• Pensum: ${workload.min === workload.max ? `${workload.min}%` : `${workload.min}-${workload.max}%`}`);
      if (contractText) bullets.push(`• Anstellung: ${contractText}`);
      bullets.push(`• Bewerbung über das Umantis-Karriereportal von ${HUBER_SUHNER_COMPANY_NAME}`);
      description = `${entry.title} bei ${HUBER_SUHNER_COMPANY_NAME} in ${entry.rawLocation || city}, Schweiz.\n\n${bullets.join('\n')}`;
    }

    const sourceLang = detectLang(description || entry.title, 'de');
    const jobSlug = slugify(`${entry.title} ${HUBER_SUHNER_KEY} ${city}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const postedDate = parseSwissDate(entry.onlineSince) || todayIso;

    const job = {
      // ── Required fields ──
      id: `${HUBER_SUHNER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HUBER_SUHNER_COMPANY_NAME,
      companyKey: HUBER_SUHNER_KEY,
      companyDomain: HUBER_SUHNER_COMPANY_DOMAIN,
      title: entry.title,
      titleByLocale: { [sourceLang]: entry.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields; the shared
      // AI-localization step clears this flag once it fills the other 3 locales.
      needsRetranslation: true,
      location: city,
      canton,
      url: detailUrl,
      source: `${HUBER_SUHNER_COMPANY_NAME} Dedicated Parser (Umantis @ ${ATS_HOST})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      streetAddress,
      category: detectCategory(entry.title),
      contract: detectEmploymentTypeFromWorkload(workload) === 'PART_TIME' ? 'part-time' : 'full-time',
      contractDuration: detectContractDuration(contractText),
      employmentType: detectEmploymentTypeFromWorkload(workload),
      experienceLevel: detectExperienceLevel(entry.title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (workload) {
      job.pensumMin = workload.min;
      job.pensumMax = workload.max;
      job.pensum = workload.min === workload.max ? `${workload.min}%` : `${workload.min}-${workload.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${HUBER_SUHNER_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${jobs.length} with rich detail content)`);
  return jobs;
}

// Exported for unit tests.
export { parseListing, resolveLocation, isSwissListingLocation, parseWorkload, detectContractDuration, extractHeaderMeta, extractDetailSections };
