#!/usr/bin/env node
/**
 * Groupement Hospitalier de l'Ouest Lémanique (GHOL) — Beehire ATS.
 *
 * Public career site:   https://www.ghol.ch/jcms/fr/le-ghol/espace-ghol/carrieres-p_5013.html
 *                       (302 → https://app.beehire.com/career/ghol)
 * Beehire public API:   https://app.beehire.com/users/getPublicCampaigns/ghol
 *
 * The Jalios JCMS landing redirects to Beehire, which is an AngularJS SPA.
 * Rather than render the SPA we hit the public REST endpoint that the SPA
 * itself uses (`/users/getPublicCampaigns/{slug}`) — it returns the complete
 * campaign list with titles, descriptions (HTML), locations and contract
 * details, no auth required.
 *
 * Campaign shape (relevant fields):
 *   {
 *     _id,                         // 24-hex Mongo id
 *     title:       { "1": "..." }, // language id → string (1 = FR)
 *     description: { "1": "..." }, // language id → HTML body
 *     language:    1,
 *     inviteKey:   "g2ZqgW6aZ",    // short URL token
 *     inviteLink:  "https://app.beehire.com/invite/g2ZqgW6aZ",
 *     location:    { city, state, country, zip, name, latitude, longitude },
 *     details:     { contract: { duration, type, remote }, vacanciesNumber },
 *   }
 *
 * GHOL operates in canton VD (Nyon, Rolle, Saint-Cergue). Default canton VD.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  slugify,
  stripHtml,
  normalizeSpace,
  fetchJson,
} from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GHOL_KEY = 'ghol';
export const GHOL_COMPANY_NAME = "Groupement Hospitalier de l'Ouest Lémanique";
export const GHOL_COMPANY_DOMAIN = 'ghol.ch';

const BEEHIRE_SLUG = 'ghol';
const BEEHIRE_API = `https://app.beehire.com/users/getPublicCampaigns/${BEEHIRE_SLUG}`;
const PUBLIC_CAREER_URL =
  'https://www.ghol.ch/jcms/fr/le-ghol/espace-ghol/carrieres-p_5013.html';
const BEEHIRE_INVITE_BASE = 'https://app.beehire.com/invite/';

/* ── Helpers ───────────────────────────────────────────────── */

/**
 * Beehire stores localized strings keyed by language id. From the GHOL feed
 * key "1" is French; "2"/"3" are English/German when defined. We always
 * prefer the campaign's `language` id, then fall back to "1", then to the
 * first non-empty value.
 */
function pickLocalized(map, langId) {
  if (!map || typeof map !== 'object') return '';
  const keys = [String(langId || ''), '1', '2', '3'];
  for (const k of keys) {
    const v = map[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  for (const v of Object.values(map)) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

function languageIdToIso(id) {
  switch (String(id || '')) {
    case '1':
      return 'fr';
    case '2':
      return 'en';
    case '3':
      return 'de';
    case '4':
      return 'it';
    default:
      return 'fr';
  }
}

/**
 * Map Beehire contract enum values into our employmentType convention.
 */
function detectEmploymentType(details = {}) {
  const c = details.contract || {};
  const duration = String(c.duration || '').toLowerCase();
  const type = String(c.type || '').toLowerCase();
  if (duration.includes('parttime') || duration.includes('partial')) return 'PART_TIME';
  if (duration.includes('fulltime') || duration.includes('full')) {
    if (type.includes('temp') || type.includes('cdd') || type.includes('fixed')) return 'CONTRACTOR';
    if (type.includes('intern') || type.includes('stage')) return 'INTERN';
    return 'FULL_TIME';
  }
  if (type.includes('intern') || type.includes('stage')) return 'INTERN';
  if (type.includes('temp') || type.includes('cdd') || type.includes('fixed')) return 'CONTRACTOR';
  return 'OTHER';
}

function detectContract(details = {}) {
  const duration = String(details?.contract?.duration || '').toLowerCase();
  if (duration.includes('part')) return 'part-time';
  return 'full-time';
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(m[eé]decin|chef.?de.?clinique|chefarzt|oberarzt|assistant?.?m[eé]dical)\b/.test(t))
    return 'healthcare-medical';
  if (/\b(infirmi[eè]r|aide.?soign|assc|asse|aide.?infirmi[eè]re|nurse)\b/.test(t))
    return 'healthcare-nursing';
  if (/\b(physio|ergo|kinetik|kin[eé]si|logop|orthophon)\b/.test(t)) return 'healthcare-therapy';
  if (/\b(psycholog)\b/.test(t)) return 'healthcare-psychology';
  if (/\b(pharma|preparat[eo]ur.?pharma)\b/.test(t)) return 'pharma';
  if (/\b(secret[ae]ir|administrat|directeur|directrice|responsable)\b/.test(t))
    return 'administration';
  if (/\b(comptabl|financ|controll)\b/.test(t)) return 'finance';
  if (/\b(informatique|informatik|developp|ingenieur|technicien.?syst[eè]me)\b/.test(t))
    return 'technology';
  if (/\b(technicien|maintenance|electric|sanitair|chauffage|menuis)\b/.test(t)) return 'logistics';
  if (/\b(cuisinier|chef.?de.?rang|hotel|restaurat|servic|housekeep)\b/.test(t)) return 'hospitality';
  if (/\b(codific|codif|codeur|laboratoire|laborantin|techn.?biom)\b/.test(t))
    return 'healthcare-medtech';
  if (/\b(rh|ressources.?humain|recrut|hr)\b/.test(t)) return 'human-resources';
  if (/\b(stage|stagiair|apprenti)\b/.test(t)) return 'education';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(stage|stagiair|apprenti|trainee|intern|praktik)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(directeur|directrice|responsable|chef|chefarzt|senior|sr|head)\b/.test(t)) return 'senior';
  return 'mid';
}

/* ── Job identity / trust ──────────────────────────────────── */

export function isGholJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === GHOL_KEY ||
    company.includes('ghol') ||
    company.includes("groupement hospitalier de l'ouest l") ||
    company.includes("groupement hospitalier de l'ouest lemanique") ||
    url.includes('ghol.ch') ||
    url.includes('app.beehire.com/invite/') ||
    url.includes('app.beehire.com/career/ghol')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ghol.ch' ||
      host === 'www.ghol.ch' ||
      host === 'app.beehire.com' ||
      host.endsWith('.beehire.com')
    );
  } catch {
    return false;
  }
}

/* ── Build job from API data ───────────────────────────────── */

function buildJob(campaign) {
  if (!campaign || typeof campaign !== 'object') return null;
  const langId = campaign.language;
  const sourceLang = languageIdToIso(langId);

  const titleRaw = pickLocalized(campaign.title, langId);
  const title = normalizeSpace(titleRaw);
  if (!title || title.length < 3) return null;

  const descriptionHtml = pickLocalized(campaign.description, langId);
  const descriptionText = stripHtml(descriptionHtml || '') ||
    `${title} — ${GHOL_COMPANY_NAME}`;

  const location = campaign.location || {};
  const cityRaw = normalizeSpace(location.city || '');
  const city = cityRaw || 'Nyon';
  // Canton: Beehire stores state="VD"/"VS"/... directly for Swiss locations.
  const state = String(location.state || '').toUpperCase().slice(0, 2);
  const canton = /^[A-Z]{2}$/.test(state) ? state : 'VD';
  const country = String(location.country || '').toLowerCase();
  const isCH =
    country.includes('suisse') ||
    country.includes('switzerland') ||
    country === 'ch' ||
    /^vd|vs|ge|fr|ne|ju|be|so|ti|gr|zh|bs|bl|ag|sg|sh|sz|nw|ow|ur|zg|tg|gl|ar|ai|li$/i.test(state);
  if (!isCH) return null;

  const postalCode = normalizeSpace(location.zip || '') || '1260';
  const inviteKey = normalizeSpace(campaign.inviteKey || '');
  const publicUrl = inviteKey
    ? `${BEEHIRE_INVITE_BASE}${inviteKey}`
    : `https://app.beehire.com/career/${BEEHIRE_SLUG}`;

  const idForHash = String(campaign._id || campaign.inviteKey || title);
  const urlHash = createHash('sha1').update(idForHash).digest('hex').slice(0, 12);

  const jobSlug = slugify(`${title} ${GHOL_COMPANY_NAME} ${city}`);
  // Beehire campaigns don't expose a posted-date — use today.
  const postedDate = new Date().toISOString().slice(0, 10);

  // The sourceLang sanity-check: if Beehire's language id doesn't match the
  // text, recompute via detectLang. Cheap insurance against mis-tagged feeds.
  const detectedLang = detectLang(descriptionText || title, sourceLang);
  const effectiveLang =
    detectedLang === 'fr' || detectedLang === 'de' || detectedLang === 'it' || detectedLang === 'en'
      ? detectedLang
      : sourceLang;

  return {
    id: `${GHOL_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [effectiveLang]: jobSlug },
    company: GHOL_COMPANY_NAME,
    companyKey: GHOL_KEY,
    companyDomain: GHOL_COMPANY_DOMAIN,
    title,
    titleByLocale: { [effectiveLang]: title },
    description: descriptionText,
    descriptionByLocale: { [effectiveLang]: descriptionText },
    location: city,
    canton,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    country: 'CH',
    postalCode,
    category: detectCategory(title),
    sector: 'Salute / Ospedale',
    contract: detectContract(campaign.details),
    employmentType: detectEmploymentType(campaign.details),
    experienceLevel: detectExperienceLevel(title),
    currency: 'CHF',
    featured: false,
    postedDate,
    url: publicUrl,
    applyUrl: publicUrl,
    source: 'GHOL Dedicated Parser (Beehire public API)',
    sourceLang: effectiveLang,
    crawledAt: new Date().toISOString(),
    needsRetranslation: true,
  };
}

/* ── Main fetch function ───────────────────────────────────── */

/**
 * Fetch all GHOL jobs from the Beehire public campaigns endpoint.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllGholJobs() {
  console.log(`🏥 Fetching GHOL (Nyon) jobs from Beehire`);
  console.log(`   Public career page: ${PUBLIC_CAREER_URL}`);
  console.log(`   Beehire API: ${BEEHIRE_API}\n`);

  let payload;
  try {
    payload = await fetchJson(BEEHIRE_API, {
      timeoutMs: Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25_000,
      headers: { 'Accept-Language': 'fr-CH,fr;q=0.9' },
    });
  } catch (err) {
    console.warn(`⚠️ Beehire API unreachable: ${err?.message || err}`);
    return [];
  }
  const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  console.log(`   Beehire returned ${campaigns.length} campaign(s)\n`);

  const jobs = [];
  for (const campaign of campaigns) {
    try {
      const job = buildJob(campaign);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`   ⚠️ Skipping campaign ${campaign?._id}: ${err?.message || err}`);
    }
  }

  // Deduplicate by id (Mongo _id is unique).
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique GHOL jobs: ${deduped.length}`);
  return deduped;
}
