#!/usr/bin/env node
/**
 * Victorinox AG job parser — Cegid/Talentsoft ATS.
 *
 * Victorinox is the family-owned Swiss maker of the original Swiss Army
 * Knife (plus watches, travel gear and household/professional knives),
 * HQ at Schmiedgasse 57, 6438 Ibach-Schwyz (canton Schwyz). ~1200 of its
 * ~2200 employees work in Switzerland, mostly at the Ibach/Seewen sites,
 * with additional Swiss sites in Zermatt (retail) and Delémont (JU,
 * Victorinox Cutlery watch/knife production).
 *
 * Public career site: https://www.victorinox.com/en/Careers/cms/careers/
 * Talentsoft portal:  https://victorinox-career.talent-soft.com/
 * All-jobs listing:   /job/list-of-all-jobs.aspx?all=1&mode=list&LCID=1031
 *   (LCID=1031 pins the German-language UI/labels — the majority of Swiss
 *   HQ postings are authored in German; per-job language is still detected
 *   independently from the job's own title/description via detectLang()).
 *
 * Same Cegid/Talentsoft ATS family as aarReha Schinznach
 * (scripts/lib/aarreha-schinznach-job-parser.mjs) and Molecular Partners
 * (scripts/lib/molecular-partners-job-parser.mjs): listing page renders
 * server-rendered `<li class="ts-offer-list-item">` blocks whose nested
 * `<ul class="ts-offer-list-item__description">` carries `Ref. : YYYY-NNN`
 * then the site/location string (either a full street address for the
 * Ibach HQ, e.g. "Schmiedgasse 57 6438 Ibach-Schwyz", or a bare city name
 * for secondary sites, e.g. "Zermatt" / "Seewen-Schwyz" / "Delémont").
 * Department is embedded in the listing link's `title` attribute suffix
 * (`"... (Ref. : 2026-245) - Product"`). No posted date in the listing, so
 * we default to today. Detail page content lives under
 * `id="contenu-ficheoffre"` and holds structured German/French prose
 * (Beschreibung der Aufgaben / Profil / Benefits / Einsatzort der Stelle).
 *
 * Multi-site canton handling: unlike single-site Talentsoft crawlers
 * (aarReha), Victorinox postings span 3 cantons (SZ Ibach/Seewen, VS
 * Zermatt, JU Delémont). resolveAddress() only ever attaches the Ibach HQ
 * street address to jobs it can positively identify as Ibach — a bare
 * "Zermatt"/"Delémont"/"Seewen-Schwyz" location never inherits the HQ
 * street, only a canton-appropriate postal code (from a small known-site
 * table, since these secondary sites are well documented but their exact
 * street is not published per-posting).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VICTORINOX_KEY = 'victorinox';
export const VICTORINOX_COMPANY_NAME = 'Victorinox';
export const VICTORINOX_COMPANY_DOMAIN = 'victorinox.com';

const PORTAL_BASE = 'https://victorinox-career.talent-soft.com';
const LISTING_URL = `${PORTAL_BASE}/job/list-of-all-jobs.aspx?all=1&mode=list&LCID=1031`;
const CAREER_URL = 'https://www.victorinox.com/en/Careers/cms/careers/';
const DETAIL_DELAY_MS = 300;
const MAX_PAGES = 20;

/* ── HQ fallback (Schmiedgasse 57, 6438 Ibach-Schwyz, SZ) ─────── */

const HQ = {
  city: 'Ibach-Schwyz',
  canton: 'SZ',
  postalCode: '6438',
  streetAddress: 'Schmiedgasse 57',
  region: 'Schwyz',
};

const SECTOR = 'Industria / Manifatturiero';

// Known secondary Swiss sites without a per-posting street address. Only
// the postal code is safe to infer here — the exact street is never
// attached unless the detail page states it explicitly (see
// resolveAddress()), so structured data never mixes an HQ street with a
// non-HQ postal code/canton.
const KNOWN_SECONDARY_SITE_POSTAL_CODES = [
  { test: /zermatt/i, postalCode: '3920' },
  { test: /del[eé]mont/i, postalCode: '2800' },
  { test: /seewen/i, postalCode: '6423' },
];

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Victorinox.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVictorinoxJob(job) {
  const key = normalizeSpace(job?.companyKey || job?.company || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeSpace(job?.company || '').toLowerCase();
  const url = normalizeSpace(job?.url || '').toLowerCase();

  return (
    key === VICTORINOX_KEY ||
    key.startsWith('victorinox') ||
    company.includes('victorinox') ||
    url.includes('victorinox.com') ||
    url.includes('victorinox-career.talent-soft.com')
  );
}

/**
 * Validate that a URL belongs to Victorinox's domain OR the Talentsoft
 * portal that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'victorinox.com' || host.endsWith('.victorinox.com')) return true;
    if (host === 'victorinox-career.talent-soft.com') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / Experience / Employment Detection ─────────────── */

function detectCategory(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|polier|schleif)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|assistant)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|pick|pack|betrieb)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|rundpolier)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|support specialist)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|bewerbung)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|brand|graphic|design)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(innovation|product)/.test(t)) return 'Innovazione / Prodotto';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalizeSpace(title).toLowerCase();
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|initiativbewerbung|unsolicited)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|fachgruppenleiter|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalizeSpace(text).toLowerCase();
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|100%)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address Resolution ───────────────────────────────────────── */

/**
 * Resolve city / postal code / street address from the raw listing
 * location string. Two shapes are observed:
 *   - Full HQ address: "Schmiedgasse 57 6438 Ibach-Schwyz"
 *     (street + 4-digit PLZ + city)
 *   - Bare site name: "Zermatt" / "Seewen-Schwyz" / "Delémont" / "Ibach-Schwyz"
 *
 * IMPORTANT: the Ibach HQ street address is only ever attached when the
 * location text can be positively identified as Ibach (parsed from a full
 * address, or matches /ibach/i). Other Swiss sites (Zermatt, Delémont,
 * Seewen-Schwyz) only get a postal code from the known-site table — never
 * the HQ street — so structured data never mixes an HQ street with a
 * different canton/postal code (see AGENTS.md Non-Negotiable #3).
 */
function resolveAddress(rawLocationText = '') {
  const text = normalizeSpace(rawLocationText);
  if (!text) {
    return { city: HQ.city, postalCode: HQ.postalCode, streetAddress: HQ.streetAddress, region: HQ.region };
  }

  const fullAddressMatch = text.match(/^(.*\S)\s+(\d{4})\s+(.+)$/);
  if (fullAddressMatch) {
    const [, street, postalCode, city] = fullAddressMatch;
    return {
      city: normalizeSpace(city),
      postalCode,
      streetAddress: normalizeSpace(street),
      region: '',
    };
  }

  const city = text;
  const knownSite = KNOWN_SECONDARY_SITE_POSTAL_CODES.find((entry) => entry.test.test(city));
  return {
    city,
    postalCode: knownSite ? knownSite.postalCode : (/ibach/i.test(city) ? HQ.postalCode : ''),
    streetAddress: /ibach/i.test(city) ? HQ.streetAddress : '',
    region: '',
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

function parseVictorinoxListing(html = '') {
  const out = [];
  const seen = new Set();
  const itemRe = /<li class="ts-offer-list-item[^"]*"[^>]*onclick="location\.href='([^']+)';"[^>]*>([\s\S]*?)<\/ul>\s*<\/li>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const rel = m[1];
    const block = m[2];
    const detailUrl = rel.startsWith('http') ? rel : `${PORTAL_BASE}${rel}`;

    const linkMatch = block.match(/<a\s+class="ts-offer-list-item__title-link[^"]*"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const titleAttr = linkMatch ? decodeEntities(linkMatch[1]) : '';
    const title = linkMatch
      ? normalizeSpace(decodeEntities(linkMatch[2].replace(/<[^>]+>/g, '')))
      : '';
    if (!title || title.length < 3) continue;

    const refMatch = block.match(/Ref\.\s*:\s*([0-9-]+)/);
    const ref = refMatch ? refMatch[1] : '';

    // Department is embedded in the title attribute suffix, e.g.
    // "Product Innovation Manager 80-100% m/w/d (Ref. : 2026-245) - Product".
    const deptMatch = titleAttr.match(/\)\s*-\s*(.+)$/);
    const department = deptMatch ? normalizeSpace(deptMatch[1]) : '';

    const descLis = [];
    const ulMatch = block.match(/<ul class="ts-offer-list-item__description[^"]*">([\s\S]*)$/);
    if (ulMatch) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let lm;
      while ((lm = liRe.exec(ulMatch[1]))) {
        descLis.push(normalizeSpace(decodeEntities(lm[1].replace(/<[^>]+>/g, ''))));
      }
    }
    // descLis[0] = "Ref. : YYYY-NNN", descLis[1] = location, descLis[2] = empty spacer.
    const location = descLis[1] || '';

    const key = ref || detailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ detailUrl, title, ref, department, location });
  }
  return out;
}

async function fetchDetailDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    // Job-detail block sits inside id="contenu-ficheoffre". Take everything
    // up to the boilerplate footer panel.
    const startMatch = html.match(/id="contenu-ficheoffre"[^>]*>([\s\S]+)/);
    if (!startMatch) return '';
    const block = startMatch[1].slice(0, 14000);
    // Cut off boilerplate footer (Rechtliche Hinweise / Mentions légales / etc).
    const cutMatch = block.match(/[\s\S]+?(?=Rechtliche\s+Hinweise|Mentions\s+l[ée]gales|<\/main>|<footer)/);
    const trimmed = cutMatch ? cutMatch[0] : block;
    const text = htmlToText(trimmed);
    return normalizeSpace(text).slice(0, 6000);
  } catch (err) {
    console.warn(` ⚠️ Victorinox detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

/**
 * Fetch all Victorinox jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllVictorinoxJobs() {
  console.log(`🔍 Fetching ${VICTORINOX_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);

  const rows = [];
  const seenKeys = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}&page=${page}`;
    const html = await fetchHtml(url);
    const pageRows = parseVictorinoxListing(html);
    if (!pageRows.length) {
      // fetchHtml() throws on genuine failure and auto-rescues 200-challenge
      // pages, so an empty parse here is usually a real end-of-pagination —
      // but sustained parser/markup drift would look identical. Warn so a
      // sustained pattern is visible.
      console.warn(` ⚠️ page ${page}: parsed 0 rows — treating as end of pagination.`);
      break;
    }
    let added = 0;
    for (const r of pageRows) {
      const key = r.ref || r.detailUrl;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      rows.push(r);
      added += 1;
    }
    console.log(`   · page ${page}: ${pageRows.length} parsed (+${added} new)`);
    if (added === 0) break;
  }
  console.log(`   ✓ ${rows.length} Talentsoft offers (deduped across pages)`);
  if (!rows.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const detailText = await fetchDetailDescription(r.detailUrl);

    const { city, postalCode, streetAddress, region } = resolveAddress(r.location);
    const hasLocationText = !!normalizeSpace(r.location);
    const inferredCanton = inferSwissTargetCanton(city) || inferSwissTargetCanton(r.location);
    if (hasLocationText && !inferredCanton) {
      // Location text present but doesn't resolve to any Swiss canton — a
      // non-Swiss/foreign office. Never fabricate the Ibach HQ canton for a
      // job that isn't actually there (AGENTS.md Non-Negotiable #3); skip it.
      console.warn(` ⚠️ Victorinox: skipping unresolvable/non-Swiss location "${r.location}" (${r.title})`);
      continue;
    }
    // Blank location text → resolveAddress() already defaulted to the Ibach
    // HQ site above, so HQ.canton is the correct (not fabricated) fallback.
    const canton = inferredCanton || HQ.canton;

    const summaryPieces = [
      r.department ? `Bereich: ${r.department}` : '',
      city ? `Standort: ${city}` : '',
      r.ref ? `Referenz: ${r.ref}` : '',
    ].filter(Boolean);
    const description = detailText && detailText.split(/\s+/).length >= 30
      ? detailText
      : [
        ...summaryPieces,
        `${VICTORINOX_COMPANY_NAME} — Schweizer Familienunternehmen, Hersteller des Original Schweizer Offiziersmessers, Uhren und Reisegepäck (HQ Ibach-Schwyz, SZ).`,
      ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${VICTORINOX_KEY} ${city || 'ibach'}`);
    const urlHash = createHash('sha1').update(r.detailUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${r.title} ${description}`);

    jobs.push({
      // ── Required fields ──
      id: `${VICTORINOX_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VICTORINOX_COMPANY_NAME,
      companyKey: VICTORINOX_KEY,
      companyDomain: VICTORINOX_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: city || r.location || HQ.city,
      canton,
      url: r.detailUrl,
      source: `${VICTORINOX_COMPANY_NAME} Dedicated Parser (Talentsoft)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || HQ.city,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${r.title} ${r.department}`),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(r.title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.detailUrl,
      jobReqId: r.ref || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${VICTORINOX_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
