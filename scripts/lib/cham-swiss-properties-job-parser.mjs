#!/usr/bin/env node
/**
 * Cham Swiss Properties AG job parser — Dualoo ATS (portal 6j9quii0).
 *
 * Public career site: https://champroperties.ch/en/company/karriere
 *   → embeds Dualoo portal https://jobs.dualoo.com/portal/6j9quii0
 *
 * @outsourced-ats-confirmed: this is the migration promised by the
 * @outsourced-ats-needs-migration tag this file previously carried. The
 * employer's own careers page embeds the Dualoo portal directly (confirmed
 * live 2026-08-25 via the iframe src on champroperties.ch/en/company/karriere)
 * — Dualoo is the employer's actual chosen outsourced ATS, not jobs.ch/jobup.ch,
 * which this parser used to source from instead (the wrong third party
 * entirely). Dualoo is a single-tenant-per-portal ATS (not a multi-employer
 * marketplace — see scripts/lib/known-aggregator-domains.mjs, which does NOT
 * list dualoo.com), the same pattern already used by 6 other crawlers in this
 * fleet (cereneo, forel-klinik, klinik-aadorf, klinik-arlesheim,
 * spital-affoltern, uroviva).
 *
 * Cham Swiss Properties AG (SIX: CHAM) is a listed Swiss real-estate
 * development / project-management company headquartered in Cham (ZG),
 * formed in 2025 through the merger of Ina Invest AG and Cham Group AG
 * (itself tracing back to the historic 1657 Cham paper-mill site). It
 * develops residential/mixed-use urban quarters (Papieri-Areal Cham,
 * Bredella Pratteln, plus projects in Zurich and Geneva) on a CHF ~1.7bn
 * portfolio. Confirmed GENUINE DIRECT EMPLOYER, not a staffing/placement
 * agency — own company careers page lists open positions as its own
 * headcount, with an in-house HR contact (Fachverantwortliche
 * Personaladministration), and the Dualoo portal posts directly under
 * "Cham Swiss Properties AG" as employer, no client/mandate framing.
 *
 * HQ fallback address (jobs.ch company profile + LinkedIn, unaffected by
 * the ATS migration): Fabrikstrasse 5, 6330 Cham, ZG.
 *
 * Modelled on `forel-klinik-job-parser.mjs` (same Dualoo HTML shape,
 * confirmed byte-for-byte matching `jobElement`/`data-eventData` markup and
 * `advertisement*Text` detail classes on 2026-08-25).
 *
 * Exports the 3 functions used by the crawler template:
 *   - fetchAllChamSwissPropertiesJobs()  — Fetch and parse all Swiss jobs
 *   - isChamSwissPropertiesJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                  — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, classAttrRx } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { detectEmploymentTypeFromOccupation } from './jobup-ch-feed-common.mjs';
import { fetchHtml, decodeEntities, normalizeSpace } from './hospital-custom-html-helpers.mjs';

/* Constants ─────────────────────────────────────────────── */

export const CHAM_SWISS_PROPERTIES_KEY = 'cham-swiss-properties';
export const CHAM_SWISS_PROPERTIES_COMPANY_NAME = 'Cham Swiss Properties';
export const CHAM_SWISS_PROPERTIES_COMPANY_DOMAIN = 'champroperties.ch';

const DUALOO_PORTAL = '6j9quii0';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;
const PUBLIC_CAREER_URL = 'https://champroperties.ch/en/company/karriere';
const DETAIL_DELAY_MS = 250;

/* HQ fallback: Fabrikstrasse 5, 6330 Cham (jobs.ch company profile + LinkedIn). */
const HQ = {
  city: 'Cham',
  canton: 'ZG',
  postalCode: '6330',
  streetAddress: 'Fabrikstrasse 5',
};

// Both live postings today sit at the Cham HQ; the docblock's other project
// sites (Pratteln, Zurich, Geneva) are development sites, not confirmed
// office/hiring locations, so they are deliberately absent here — an
// unconfirmed guess is worse than falling back to HQ.
const CITY_POSTAL_MAP = new Map([
  ['Cham', '6330'],
]);

const SECTOR = 'Immobiliare / Project Management';

/* Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isChamSwissPropertiesJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CHAM_SWISS_PROPERTIES_KEY ||
    key.startsWith('cham-swiss-properties') ||
    company.includes('cham swiss properties') ||
    url.includes('champroperties.ch') ||
    url.includes(`/${DUALOO_PORTAL}/`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'champroperties.ch'
      || host.endsWith('.champroperties.ch')
      || host === 'jobs.dualoo.com';
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(vertrag|contract|contrat|contratt)/.test(t)) return 'Contract Management';
  if (/\b(projekt|project|projet|progetto|bauherr|entwickl|develop)/.test(t)) return 'Project Management';
  if (/\b(it|software|digital|system)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(immobil|liegenschaft|real estate|property|portfolio)/.test(t)) return 'Immobiliare';
  if (/\b(admin|segret|contab|buchhalt|account|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(marketing|communication|kommunikation|comunicaz)/.test(t)) return 'Marketing';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Dualoo job titles carry the workload as a trailing "80-100%" (or single
 * "100%") token — there is no separate structured employmentType field on
 * this ATS, unlike jobs.ch's JSON-LD. Reuses the same occupation-percentage
 * classifier the jobs.ch-sourced version of this file already relied on.
 */
function resolveEmploymentTypeFromTitle(title = '') {
  const m = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || title.match(/(\d{2,3})\s*%/);
  const min = m ? Number(m[1]) : 100;
  const max = m && m[2] ? Number(m[2]) : min;
  return detectEmploymentTypeFromOccupation(min, max) === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME';
}

/* ── Dualoo portal parsing (mirrors forel-klinik-job-parser.mjs) ──────── */

function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
  const blockRe = /<a[^>]*class="[^"]*\bjobElement\b[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const hrefMatch = block.match(/\shref="([^"]+)"/);
    const evMatch = block.match(/\sdata-eventData="([^"]+)"/);
    const spanMatch = block.match(/<span[^>]*class="jobName"[^>]*>([\s\S]*?)<\/span>/i);
    if (!hrefMatch) continue;
    const rel = hrefMatch[1];
    let meta = {};
    if (evMatch) {
      const evRaw = evMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try { meta = JSON.parse(evRaw); } catch { meta = {}; }
    }
    const spanTitle = spanMatch
      ? normalizeSpace(decodeEntities(spanMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const evTitle = normalizeSpace(decodeEntities(String(meta.jobName || '')));
    const title = spanTitle || evTitle;
    if (!title || title.length < 3) continue;
    const uuidMatch = rel.match(/([a-f0-9-]{36})\/detail/);
    const uuid = uuidMatch ? uuidMatch[1] : rel;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const url = rel.startsWith('http')
      ? rel
      : `${DETAIL_BASE}/${rel.replace(new RegExp(`^${DUALOO_PORTAL}/`), '')}`;
    out.push({
      uuid,
      url,
      title,
      location: normalizeSpace(decodeEntities(String(meta.location || ''))),
      startDate: normalizeSpace(decodeEntities(String(meta.startDate || ''))),
    });
  }
  return out;
}

async function fetchDualooDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    const sections = [];
    const grab = (cls, label) => {
      const rx = new RegExp(`${classAttrRx(cls)}[^>]*>([\\s\\S]*?)</div>`, 'i');
      const mm = html.match(rx);
      if (!mm) return;
      const text = mm[1]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text) sections.push(`${label}\n${text}`);
    };
    grab('advertisementResponsibilitiesText', 'Aufgaben:');
    grab('advertisementRequirementsText', 'Anforderungen:');
    grab('advertisementBenefitsText', 'Wir bieten:');
    return sections.join('\n\n');
  } catch {
    return '';
  }
}

function extractCity(rawLocation) {
  if (!rawLocation) return HQ.city;
  const parts = rawLocation.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || HQ.city;
  return last;
}

function postalFor(city) {
  return CITY_POSTAL_MAP.get(city) || (city === HQ.city ? HQ.postalCode : '');
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Cham Swiss Properties jobs. Returns an array of ParsedJob
 * objects (source-locale only — other locales are filled by the AI
 * localization step and translate-pending pipeline).
 */
export async function fetchAllChamSwissPropertiesJobs() {
  console.log(`🔍 Fetching ${CHAM_SWISS_PROPERTIES_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PORTAL_URL);
  const items = parseDualooPortal(html);
  console.log(`  ✓ ${items.length} Dualoo job cards parsed`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  const seenSlugs = new Set();
  let detailHits = 0;

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const detailContent = await fetchDualooDetail(it.url);
    if (detailContent) detailHits += 1;

    const city = extractCity(it.location);
    const canton = inferAnyCanton(city) || HQ.canton;
    const description = [
      detailContent,
      it.location ? `Standort: ${it.location}` : '',
      it.startDate ? `Eintritt: ${it.startDate}` : '',
      `${CHAM_SWISS_PROPERTIES_COMPANY_NAME} — Immobilienentwicklung mit Sitz in ${HQ.city} (Kanton ${HQ.canton}).`,
    ].filter(Boolean).join('\n\n');

    // The Dualoo portal is fetched at `?lang=DE` (its only locale for this
    // tenant, confirmed live 2026-08-25 — both postings are German-only) —
    // 'de' is a real default here, not a guess.
    const sourceLang = detectLang(description || it.title, 'de');
    const urlHash = createHash('sha1').update(it.uuid).digest('hex').slice(0, 12);
    const employmentType = resolveEmploymentTypeFromTitle(it.title);

    let jobSlug = slugify(`${it.title} cham-swiss-properties ${city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${it.title} cham-swiss-properties ${city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    jobs.push({
      // ── Required fields ──
      id: `${CHAM_SWISS_PROPERTIES_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CHAM_SWISS_PROPERTIES_COMPANY_NAME,
      companyKey: CHAM_SWISS_PROPERTIES_KEY,
      companyDomain: CHAM_SWISS_PROPERTIES_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city,
      canton,
      url: it.url,
      source: `${CHAM_SWISS_PROPERTIES_COMPANY_NAME} Dedicated Parser (Dualoo)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      streetAddress: city === HQ.city ? HQ.streetAddress : '',
      postalCode: postalFor(city),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(it.title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(it.title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      hiringOrganizationName: `${CHAM_SWISS_PROPERTIES_COMPANY_NAME} AG`,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(
    `\n📋 Total ${CHAM_SWISS_PROPERTIES_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${detailHits}/${items.length} with rich detail content)`,
  );
  return jobs;
}
