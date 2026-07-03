#!/usr/bin/env node
/**
 * CordenPharma job parser — Fetcher and job builder.
 *
 * CordenPharma is a pharmaceutical CDMO (Contract Development and
 * Manufacturing Organization). Its two Swiss sites both sit in canton
 * Basel-Landschaft (BL):
 *   - CordenPharma Switzerland LLC — Eichenweg 1 A, 4410 Liestal
 *   - CordenPharma Fribourg AG, Zweigniederlassung Ettingen — Brühlstrasse 50, 4107 Ettingen
 *     (legal entity "Corden Pharma Fribourg SA" is registered in canton FR,
 *     Villars-sur-Glâne, but the actual worksite — where employees report —
 *     is the Ettingen branch in BL; jobs are scoped to the worksite, not the
 *     registered office).
 *
 * Source: career.cordenpharma.com, a d.vinci-powered career portal.
 * The location-filtered listing pages (/en/p/{site}/jobs) embed the full
 * job list as a `DvinciData = {...}` JSON blob directly in a <script> tag —
 * no separate public API call is needed. Per-job detail pages embed the
 * description as server-rendered HTML inside `<div id="liquidDesign*Publication">`
 * blocks (Introduction / Tasks / Profile / We-offer).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCordenpharmaJobs()  — Fetch and parse all jobs
 *   - isCordenpharmaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CORDENPHARMA_KEY = 'cordenpharma';
export const CORDENPHARMA_COMPANY_NAME = 'CordenPharma';
export const CORDENPHARMA_COMPANY_DOMAIN = 'cordenpharma.com';

const HQ = getCompanyDefaults(CORDENPHARMA_KEY) || { city: 'Liestal', canton: 'BL', postalCode: '4410', addressRegion: 'BL' };

// The portal is a global multi-country career site — only the two Swiss,
// Basel-Landschaft worksites are in scope for this crawler.
const SITE_URLS = [
  'https://career.cordenpharma.com/en/p/liestal/jobs',
  'https://career.cordenpharma.com/en/p/ettingen/jobs',
];

// Ground-truth per-site address, keyed by the d.vinci `locations[].id`.
const SITE_ADDRESS = {
  LIESTAL: { city: 'Liestal', canton: 'BL', postalCode: '4410', streetAddress: 'Eichenweg 1 A' },
  ETTINGEN: { city: 'Ettingen', canton: 'BL', postalCode: '4107', streetAddress: 'Brühlstrasse 50' },
};

const SECTOR = 'Farmaceutico / CDMO';

const COMPANY_BOILERPLATE = {
  it: `CordenPharma è un'organizzazione leader nello sviluppo e nella produzione conto terzi (CDMO) di principi attivi farmaceutici (API), eccipienti, prodotti finiti (drug product) e packaging. Con circa 3'000 dipendenti nel mondo, CordenPharma supporta aziende farmaceutiche e biotech nella produzione di farmaci su sei piattaforme tecnologiche: peptidi, lipidi e carboidrati, iniettabili, molecole altamente potenti e oncologiche, piccole molecole e oligonucleotidi. I siti svizzeri di Liestal ed Ettingen, entrambi nel canton Basel-Landschaft, operano in ambiente GMP certificato.`,
  en: `CordenPharma is a leading full-service Contract Development and Manufacturing Organization (CDMO) specializing in active pharmaceutical ingredients (APIs), excipients, drug products, and packaging. With around 3,000 employees worldwide, CordenPharma helps pharmaceutical and biotech companies manufacture medicines across six technology platforms: peptides, lipids & carbohydrates, injectables, highly potent & oncology, small molecules, and oligonucleotides. The Swiss sites in Liestal and Ettingen, both in canton Basel-Landschaft, operate under certified GMP conditions.`,
  de: `CordenPharma ist eine führende Full-Service-Auftragsentwicklungs- und -herstellungsorganisation (CDMO), spezialisiert auf pharmazeutische Wirkstoffe (APIs), Hilfsstoffe, Arzneimittel (Drug Products) und Verpackung. Mit rund 3'000 Mitarbeitenden weltweit unterstützt CordenPharma Pharma- und Biotech-Unternehmen bei der Herstellung von Arzneimitteln über sechs Technologieplattformen: Peptide, Lipide & Kohlenhydrate, Injektabilia, hochpotente & onkologische Wirkstoffe, kleine Moleküle und Oligonukleotide. Die Schweizer Standorte Liestal und Ettingen, beide im Kanton Basel-Landschaft, arbeiten unter zertifizierten GMP-Bedingungen.`,
  fr: `CordenPharma est une organisation leader de développement et de fabrication sous contrat (CDMO) spécialisée dans les principes actifs pharmaceutiques (API), les excipients, les produits finis (drug products) et le conditionnement. Avec environ 3'000 employés dans le monde, CordenPharma aide les entreprises pharmaceutiques et biotech à fabriquer des médicaments sur six plateformes technologiques : peptides, lipides et glucides, injectables, molécules hautement actives et oncologie, petites molécules et oligonucléotides. Les sites suisses de Liestal et Ettingen, tous deux dans le canton de Bâle-Campagne, opèrent dans des conditions GMP certifiées.`,
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to CordenPharma.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCordenpharmaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CORDENPHARMA_KEY ||
    key.startsWith('cordenpharma') ||
    company.includes('cordenpharma') ||
    company.includes('corden pharma') ||
    url.includes('cordenpharma.com')
  );
}

/**
 * Validate that a URL belongs to CordenPharma's domain (main site or the
 * career.cordenpharma.com d.vinci-hosted subdomain).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === CORDENPHARMA_COMPANY_DOMAIN || host.endsWith(`.${CORDENPHARMA_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(qualit|qa\b|qc\b|quality|validat)/.test(t)) return 'Qualità';
  if (/\b(analytic|analista|laborator|scientist|chemist|chimic)/.test(t)) return 'Scienza';
  if (/\b(produzion|operator|betriebsmechaniker|manufactur|process)/.test(t)) return 'Produzione';
  if (/\b(ingegner|engineer|entwickl|synthesis|synthese|development)/.test(t)) return 'Ingegneria';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(it\b|software|informatica|digital|system)/.test(t)) return 'IT';
  if (/\b(hr\b|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(regolator|regulatory|pharmacovig)/.test(t)) return 'Qualità';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  return 'Produzione';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'INTERN';
  if (/\b(befristet|temporary|tempor|fixed.?term|cdd)/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

/* ── Address resolution (canton-gated — see AGENTS.md sibling-pattern fix) ──
 * Both Swiss sites are known ground truth (Liestal / Ettingen), keyed by the
 * d.vinci `locations[].id`. If a listing ever carries an unrecognised site id
 * (e.g. a non-Swiss location slipped through the location-filtered fetch),
 * postalCode/streetAddress MUST NOT be silently backfilled with the wrong
 * site's HQ address — only fall back to HQ when the inferred canton actually
 * matches HQ.canton.
 */
function resolveAddress(rawLoc = {}) {
  const locId = String(rawLoc.id || '').toUpperCase();
  const known = SITE_ADDRESS[locId] || null;
  const city = (known?.city || rawLoc.city || rawLoc.name || '').trim();
  const canton = known?.canton || '';
  const postalCode = (known?.postalCode || rawLoc.postalCode || '').trim();
  const streetAddress = (known?.streetAddress || rawLoc.streetAddress || '').trim();

  return { city, canton, postalCode, streetAddress };
}

/* ── Detail page description extraction ───────────────────── */

const DETAIL_SECTION_IDS = [
  'liquidDesignIntroductionPublication',
  'liquidDesignTasksPublication',
  'liquidDesignProfilePublication',
  'liquidDesignWeOfferPublication',
];

/**
 * Extract the job description from a d.vinci detail page. Each content block
 * is a `<div id="liquidDesign{Section}Publication">` rendered server-side and
 * sequentially — slice from each section's opening tag to the next section
 * (or end of the known sections) and strip HTML.
 */
function extractDetailDescription(html = '') {
  const parts = [];
  for (const id of DETAIL_SECTION_IDS) {
    const marker = `id="${id}"`;
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) continue;
    const divStart = html.lastIndexOf('<div', markerIdx);
    if (divStart === -1) continue;
    const nextMarkerIdx = html.indexOf('id="liquidDesign', markerIdx + marker.length);
    const sliceEnd = nextMarkerIdx !== -1 ? html.lastIndexOf('<div', nextMarkerIdx) : html.length;
    const chunk = html.slice(divStart, sliceEnd > divStart ? sliceEnd : html.length);
    const text = normalizeSpace(stripHtml(chunk));
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

async function fetchDetailPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const html = await fetchHtml(url, { timeoutMs });
  return extractDetailDescription(html);
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch the site-filtered d.vinci listing page and extract the embedded
 * `DvinciData.jobPublications` JSON blob — the whole listing is server-side
 * rendered into the page's inline <script>, no separate API call needed.
 */
async function fetchSiteListings(siteUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const html = await fetchHtml(siteUrl, { timeoutMs });
  const match = html.match(/DvinciData\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const publications = Array.isArray(data?.jobPublications) ? data.jobPublications : [];
  return publications
    .map((pub) => {
      const opening = pub?.jobOpening || {};
      const rawLocation = Array.isArray(opening.locations) ? opening.locations[0] : null;
      const address = rawLocation?.address || {};
      return {
        title: pub.position || opening.name || '',
        url: pub.jobPublicationURL || '',
        location: opening.location || rawLocation?.name || '',
        language: pub.language || '',
        employmentLabel: (opening.workingTimes || []).map((w) => w.name).join(', '),
        createdDate: opening.createdDate || '',
        startDate: pub.startDate || '',
        rawLocation: {
          id: rawLocation?.id || '',
          name: rawLocation?.name || '',
          city: address.city || '',
          postalCode: address.zipCode || '',
          streetAddress: address.address2 || address.address1 || '',
        },
      };
    })
    .filter((j) => j.title && j.url);
}

async function fetchJobListings() {
  const all = [];
  const seenUrls = new Set();
  for (const siteUrl of SITE_URLS) {
    console.log(`   Fetching ${siteUrl}`);
    try {
      const listings = await fetchSiteListings(siteUrl);
      for (const listing of listings) {
        if (seenUrls.has(listing.url)) continue;
        seenUrls.add(listing.url);
        all.push(listing);
      }
    } catch (err) {
      console.warn(`⚠️ CordenPharma listing fetch failed for ${siteUrl}: ${err?.message || err}`);
    }
  }
  return all;
}

/**
 * Fetch all CordenPharma jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCordenpharmaJobs() {
  console.log(`🔍 Fetching CordenPharma jobs`);
  console.log(`   Source: ${SITE_URLS.join(', ')}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const { city, canton: siteCanton, postalCode, streetAddress } = resolveAddress(listing.rawLocation);
    const location = normalizeSpace(listing.location || city || HQ.city);
    const canton =
      siteCanton ||
      inferSwissTargetCanton(location) ||
      inferAnyCanton(location) ||
      HQ.canton;

    const publicUrl = listing.url;

    let descriptionText = '';
    try {
      descriptionText = await fetchDetailPage(publicUrl);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${title}: ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting

    // Non-Negotiable #4: never index thin content (<50 words). Enrich with
    // the company boilerplate paragraph when the scraped detail is too thin
    // or the detail fetch failed outright — this always pushes the job over
    // the guard threshold regardless of upstream fetch success.
    const sourceLang = ['it', 'en', 'de', 'fr'].includes(listing.language)
      ? listing.language
      : detectLang(descriptionText || title, 'de');
    const wordCount = descriptionText.split(/\s+/).filter(Boolean).length;
    let description = descriptionText;
    if (wordCount < 50) {
      const boilerplate = COMPANY_BOILERPLATE[sourceLang] || COMPANY_BOILERPLATE.en;
      description = [
        descriptionText || `${title} — ${CORDENPHARMA_COMPANY_NAME}, ${location}.`,
        boilerplate,
      ].join('\n\n');
    }

    const jobSlug = slugify(`${title} cordenpharma ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.createdDate && String(listing.createdDate).slice(0, 10))
      || (listing.startDate && String(listing.startDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${CORDENPHARMA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CORDENPHARMA_COMPANY_NAME,
      companyKey: CORDENPHARMA_KEY,
      companyDomain: CORDENPHARMA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'CordenPharma Dedicated Parser (d.vinci)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton || HQ.addressRegion,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CORDENPHARMA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
