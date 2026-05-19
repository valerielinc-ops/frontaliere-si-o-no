#!/usr/bin/env node
/**
 * Klinik Gut AG (Gruppe) — orthopaedic / accident private clinic group in
 * Graubünden + Ascona. HQ in St. Moritz (postal 7500).
 *
 * Public career site (Drupal 11 — RZ theme), German source:
 *   https://www.klinik-gut.ch/de/offene-stellen
 *
 * Layout:
 *   <h2>Klinik Gut Standort St. Moritz</h2>      ← location boundary
 *     <h2 class="accordion-header">              ← job (Bootstrap accordion)
 *       <button data-bs-target="#drz-accordion-id-NNNN">{title}</button>
 *     </h2>
 *     <div id="drz-accordion-id-NNNN" class="accordion-collapse collapse">
 *       <div class="accordion-body">…full posting body…</div>
 *     </div>
 *   <h2>Klinik Gut Standort Fläsch</h2>          ← next location
 *     …more accordion items…
 *
 * The Drupal `drz-accordion-id-NNNN` is a stable CMS node id reused across
 * crawls — perfect canonical job id.
 *
 * Group sites:
 *   - Klinik St. Moritz (Plazza Paracelsus 2a, 7500 St. Moritz, GR)
 *   - Klinik Fläsch (7306 Fläsch, GR)
 *   - Praxis Chur / Buchs / Zürich / Ascona — listing-only entries (no openings)
 *
 * For each posting, derive the city from the most recent "Standort" header.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KLINIK_GUT_KEY = 'klinik-gut';
export const KLINIK_GUT_COMPANY_NAME = 'Klinik Gut AG';
export const KLINIK_GUT_COMPANY_DOMAIN = 'klinik-gut.ch';

const PUBLIC_CAREER_URL = 'https://www.klinik-gut.ch/de/offene-stellen';

const STANDORT_PROFILE = {
  'st. moritz': { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'st moritz':  { city: 'St. Moritz', canton: 'GR', postal: '7500' },
  'flaesch':    { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'fläsch':     { city: 'Fläsch',     canton: 'GR', postal: '7306' },
  'chur':       { city: 'Chur',       canton: 'GR', postal: '7000' },
  'buchs':      { city: 'Buchs SG',   canton: 'SG', postal: '9470' },
  'zürich':     { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'zuerich':    { city: 'Zürich',     canton: 'ZH', postal: '8001' },
  'ascona':     { city: 'Ascona',     canton: 'TI', postal: '6612' },
};

const DEFAULT_LOCATION = { city: 'St. Moritz', canton: 'GR', postal: '7500' };

/* ── Company matchers ──────────────────────────────────────── */

export function isKlinikGutJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === KLINIK_GUT_KEY ||
    key.startsWith('klinik-gut') ||
    company.includes('klinik gut') ||
    url.includes('klinik-gut.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-gut.ch' || host.endsWith('.klinik-gut.ch');
  } catch {
    return false;
  }
}

/* ── Helpers ───────────────────────────────────────────────── */

function resolveStandort(headerText) {
  const lc = String(headerText || '').toLowerCase();
  for (const key of Object.keys(STANDORT_PROFILE)) {
    if (lc.includes(key)) return STANDORT_PROFILE[key];
  }
  return null;
}

/* ── Parser ────────────────────────────────────────────────── */

/**
 * Walk the page in document order, tracking the active Standort header. For
 * each accordion h2 (`<button data-bs-target="#drz-accordion-id-NNNN">`),
 * locate the matching `<div id="drz-accordion-id-NNNN">` body and emit a
 * listing record.
 */
export function parseKlinikGutListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();

  // Build an ordered list of candidate events (standort headers + accordion buttons).
  const events = [];

  // Standort h2 = plain `<h2>…Standort…</h2>` (NOT `class="accordion-header"`).
  const standortRe = /<h2>\s*((?:<[^>]+>)?[^<]+)/g;
  let sm;
  while ((sm = standortRe.exec(html)) !== null) {
    const text = normalizeSpace(decodeEntities(sm[1].replace(/<[^>]+>/g, '')));
    if (!/standort/i.test(text)) continue;
    events.push({ pos: sm.index, kind: 'standort', text });
  }

  // Accordion buttons.
  const buttonRe =
    /<h2[^>]*class="accordion-header"[^>]*>\s*<button[^>]*data-bs-target="#drz-accordion-id-(\d+)"[^>]*>([\s\S]*?)<\/button>\s*<\/h2>/g;
  let bm;
  while ((bm = buttonRe.exec(html)) !== null) {
    const id = bm[1];
    const title = normalizeSpace(
      decodeEntities(String(bm[2]).replace(/<[^>]+>/g, '')),
    );
    if (!title || title.length < 5) continue;
    events.push({ pos: bm.index, kind: 'job', id, title, headEnd: buttonRe.lastIndex });
  }

  // Sort by document position so we can resolve the most recent standort.
  events.sort((a, b) => a.pos - b.pos);

  let activeStandort = null;
  for (const ev of events) {
    if (ev.kind === 'standort') {
      activeStandort = resolveStandort(ev.text);
      continue;
    }
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);

    // Locate the body div for this accordion id (search forward only).
    const bodyRe = new RegExp(
      `<div[^>]*id="drz-accordion-id-${ev.id}"[^>]*>([\\s\\S]*?)</div>\\s*</div>\\s*</section>`,
      'i',
    );
    const body = html.slice(ev.headEnd).match(bodyRe);
    const bodyText = body ? htmlToText(body[1]) : '';

    out.push({
      id: ev.id,
      title: ev.title,
      body: bodyText,
      location: activeStandort || DEFAULT_LOCATION,
    });
  }

  return out;
}

/* ── Description fallback ──────────────────────────────────── */

function buildFallbackDescription(title, cityName) {
  return [
    `${title} bei der Klinik Gut AG am Standort ${cityName}.`,
    '',
    'Die Klinik Gut ist eine etablierte private Klinik-Gruppe für Orthopädie, Unfallchirurgie und Sportmedizin mit Hauptstandorten in St. Moritz und Fläsch (Graubünden) sowie Praxisstandorten in Chur, Buchs SG, Zürich und Ascona. Sie betreut nationale und internationale Patientinnen und Patienten und legt Wert auf ein engagiertes Team und individuelle Versorgung.',
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllKlinikGutJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${KLINIK_GUT_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Drupal 11 — DE source)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Klinik Gut career page: ${err?.message || err}`);
  }

  const listings = parseKlinikGutListing(html);
  console.log(`  📋 Found ${listings.length} accordion vacancies\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No vacancies parsed from Klinik Gut page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const listing of listings) {
    const title = listing.title;
    const loc = listing.location;

    let description = listing.body && listing.body.split(/\s+/).length >= 40
      ? listing.body
      : buildFallbackDescription(title, loc.city);
    if (description.split(/\s+/).length < 80) {
      description = `${description}\n\n${buildFallbackDescription(title, loc.city)}`;
    }

    const haystack = `${title} ${description}`;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KLINIK_GUT_KEY} ${loc.city}`);
    const url = `${PUBLIC_CAREER_URL}#drz-accordion-id-${listing.id}`;
    const urlHash = createHash('sha1')
      .update(`${url}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(haystack);

    jobs.push({
      id: `${KLINIK_GUT_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_GUT_COMPANY_NAME,
      companyKey: KLINIK_GUT_KEY,
      companyDomain: KLINIK_GUT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: loc.city,
      canton: inferSwissTargetCanton(loc.city) || loc.canton,
      url,
      source: 'Klinik Gut Dedicated Parser (Drupal accordion)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: loc.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postal,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${title.substring(0, 65)} → ${loc.city} (${listing.id})`);
  }

  console.log(`\n📋 Total ${KLINIK_GUT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
