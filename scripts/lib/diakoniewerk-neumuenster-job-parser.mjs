#!/usr/bin/env node
/**
 * Stiftung Diakoniewerk Neumünster – Schweizerische Pflegerinnenschule
 * (Zollikerberg, ZH) job parser — Custom HTML.
 *
 * Diakoniewerk Neumünster operates the broader **Gesundheitswelt Zollikerberg**
 * cluster (Spital Zollikerberg, Residenz Neumünster Park, Alterszentrum
 * Hottingen, Institut Neumünster, Frauen-Permanence/Kinder-Permanence,
 * Geburtshaus Zollikerberg, …). All openings — across every site — are
 * published on the cluster's careers page, which posts each card with a
 * deep-link into the **PI-ASP / Personal-Office** ATS hosted at
 * `stiftdia.pi-asp.de`. PI-ASP itself is JS-only, so we parse the SSR'd
 * Next.js card list at the source.
 *
 * Public career site:
 *   https://www.diakoniewerk-neumuenster.ch/karriere  (redirects to gwz)
 *   https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen  ← parsed
 *
 * Each card is an `<a … href="https://stiftdia.pi-asp.de/bewerber-web…">`
 * whose flattened text content concatenates:
 *   "{ENTITY} {TITLE} {CATEGORY}"
 * (e.g. "Spital Zollikerberg Dipl. Pflegefachperson HF Pflegeberufe").
 *
 * We split that into entity / title / category using a list of known
 * Gesundheitswelt entities + a list of known job categories
 * ("Pflegeberufe", "Ärzte/Innen", "Verwaltung", "Hauswirtschaft", …).
 *
 * One link is the spontaneous-application CTA (`/bewerber-web/?companyEid=1`
 * — note `companyEid` vs the `company=1-FIRMA-ID` of real openings). It is
 * filtered out.
 *
 * PI-ASP detail pages are JS-only — we cannot extract per-job descriptions
 * via curl. We synthesise a short, structured fallback from
 * "{TITLE} chez {ENTITY} (Gesundheitswelt Zollikerberg), Zollikerberg (ZH).
 * Kategorie: {CATEGORY}." and let the shared AI-translate step enrich it.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const DIAKONIEWERK_KEY = 'diakoniewerk-neumuenster';
export const DIAKONIEWERK_COMPANY_NAME = 'Diakoniewerk Neumünster (Gesundheitswelt Zollikerberg)';
export const DIAKONIEWERK_COMPANY_DOMAIN = 'diakoniewerk-neumuenster.ch';

const LISTING_URL = 'https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen';

// Known Gesundheitswelt entities — extend if new sub-brands are added. Order
// matters: longer names first so "Residenz Neumünster Park" matches before
// the bare "Neumünster".
const KNOWN_ENTITIES = [
  'Residenz Neumünster Park',
  'Alterszentrum Hottingen',
  'Institut Neumünster',
  'Frauen-Permanence Zürich',
  'Frauen-Permanence',
  'Kinder-Permanence',
  'Geburtshaus Zollikerberg',
  'Spital Zollikerberg',
  'Gastronomie Neumünster Park',
  'Blumen Zollikerberg',
  'Gesundheitswelt Zollikerberg',
];

// Trailing category tokens emitted by the PI-ASP card text.
const KNOWN_CATEGORIES = [
  'Pflegeberufe',
  'Medizinische Berufe',
  'Ärzte/Innen',
  'Ärzte/innen',
  'Therapie',
  'Therapieberufe',
  'Hauswirtschaft',
  'Gastronomie',
  'Verwaltung',
  'Technik',
  'IT',
  'HR',
  'Personal',
  'Praktikum',
  'Ausbildung',
];

const ZURICH_CITY_BY_ENTITY = {
  // Most sites are in Zollikerberg (8125), but Hottingen + Permanence are in Zürich proper.
  'Alterszentrum Hottingen': { city: 'Zürich', postalCode: '8032' },
  'Frauen-Permanence Zürich': { city: 'Zürich', postalCode: '8001' },
  'Frauen-Permanence': { city: 'Zürich', postalCode: '8001' },
  'Kinder-Permanence': { city: 'Zürich', postalCode: '8001' },
};

const DEFAULT_LOC = { city: 'Zollikerberg', postalCode: '8125' };

function inferLocality(entity = '') {
  return ZURICH_CITY_BY_ENTITY[entity] || DEFAULT_LOC;
}

export function isDiakoniewerkJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === DIAKONIEWERK_KEY) return true;
  if (url.includes('stiftdia.pi-asp.de')) return true;
  if (url.includes('diakoniewerk-neumuenster.ch')) return true;
  if (url.includes('gesundheitswelt-zollikerberg.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'stiftdia.pi-asp.de' || host.endsWith('.pi-asp.de')) return true;
    if (host === 'diakoniewerk-neumuenster.ch' || host.endsWith('.diakoniewerk-neumuenster.ch')) return true;
    if (host === 'gesundheitswelt-zollikerberg.ch' || host.endsWith('.gesundheitswelt-zollikerberg.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Split the flat card text "ENTITY TITLE CATEGORY" into its three components.
 * Falls back gracefully when the entity/category tokens are missing.
 */
export function splitCardText(rawText = '') {
  let text = normalizeSpace(decodeEntities(rawText));
  if (!text) return { entity: '', title: '', category: '' };

  let entity = '';
  for (const e of KNOWN_ENTITIES) {
    if (text.startsWith(`${e} `) || text === e) {
      entity = e;
      text = text.slice(e.length).trim();
      break;
    }
  }

  let category = '';
  for (const c of KNOWN_CATEGORIES) {
    if (text.endsWith(` ${c}`) || text === c) {
      category = c;
      text = text.slice(0, text.length - c.length).trim();
      break;
    }
  }

  return { entity, title: text, category };
}

export function parseListing(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href="(https:\/\/stiftdia\.pi-asp\.de\/bewerber-web[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].replace(/&amp;/g, '&');
    // Spontaneous-application CTA uses `companyEid=1` instead of `company=1-FIRMA-ID`.
    if (/companyEid=/i.test(url)) continue;
    // Need a stable position id; if the URL has no `id=` token we can't dedupe.
    const idMatch = url.match(/[#&]?id=([0-9a-f-]{8,})/i);
    if (!idMatch) continue;
    const positionId = idMatch[1];
    if (seen.has(positionId)) continue;
    const flat = m[2].replace(/<[^>]+>/g, ' ');
    const { entity, title, category } = splitCardText(flat);
    if (!title) continue;
    seen.add(positionId);
    out.push({ url, positionId, entity, title, category });
  }
  return out;
}

export async function fetchAllDiakoniewerkJobs() {
  console.log(`🏥 Fetching ${DIAKONIEWERK_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let html;
  try {
    html = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(html);
  console.log(`  ✓ listing: ${rows.length} jobs`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const r of rows) {
    const entity = r.entity || 'Gesundheitswelt Zollikerberg';
    const loc = inferLocality(entity);
    const categoryNote = r.category ? ` Kategorie: ${r.category}.` : '';
    const description = `${r.title} bei ${entity} (${DIAKONIEWERK_COMPANY_NAME}), ${loc.city} (${loc.postalCode}, ZH).${categoryNote} Bewerbung über das PI-ASP-Karriereportal von Stiftung Diakoniewerk Neumünster.`;

    const sourceLang = detectLang(`${r.title} ${description}`, 'de');
    const jobSlug = slugify(`${r.title} ${DIAKONIEWERK_KEY} ${loc.city}`);
    // Use the stable PI-ASP position id (UUID) — never the URL hash, since the
    // URL also contains a `jobportalid` query that may drift.
    const urlHash = createHash('sha1').update(r.positionId).digest('hex').slice(0, 12);

    jobs.push({
      id: `${DIAKONIEWERK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: `${DIAKONIEWERK_COMPANY_NAME} — ${entity}`,
      companyKey: DIAKONIEWERK_KEY,
      companyDomain: DIAKONIEWERK_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: loc.city,
      canton: 'ZH',
      url: r.url,
      source: `${DIAKONIEWERK_COMPANY_NAME} Dedicated Parser (Custom HTML — PI-ASP)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode,
      category: detectHealthcareCategory(`${r.title} ${r.category}`),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${r.category}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${DIAKONIEWERK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
