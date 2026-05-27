#!/usr/bin/env node
/**
 * CHUV (Centre Hospitalier Universitaire Vaudois) job parser.
 *
 * The CHUV career portal runs on Hireserve ATS at recrutement.chuv.ch.
 * The home page (https://www.chuv.ch/fr/chuv-home/professionnels/emplois)
 * redirects/links to the Hireserve portal which exposes a public JSON
 * feed without authentication — no browser automation needed.
 *
 * API endpoint:
 *   GET /utf8/ic_job_feeds.feed_engine
 *     ?p_web_site_id=5352
 *     &p_published_to=WWW
 *     &p_language=DEFAULT
 *     &p_direct=Y
 *     &p_format=MOBILE
 *
 * Returns: { jobs: [{ id, title, refno, weblink, status, publication, org,
 *                     locations[], classifications{ class_14042 (Département),
 *                     class_14054 (Type de contrat), class_14093 (Catégorie),
 *                     class_14094 (Lieu), class_14052 (Taux d'activité) }, ... }] }
 *
 * Detail page: weblink (e.g. /vacancy/{slug}-{id}.html) — HTML, source-lang FR.
 *
 * Sources:
 *   - https://www.chuv.ch/fr/chuv-home/professionnels/emplois
 *   - https://recrutement.chuv.ch/home.html
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CHUV_KEY = 'chuv';
export const CHUV_COMPANY_NAME = 'CHUV';
export const CHUV_COMPANY_DOMAIN = 'chuv.ch';

const PORTAL_BASE = 'https://recrutement.chuv.ch';
const FEED_URL =
  `${PORTAL_BASE}/utf8/ic_job_feeds.feed_engine` +
  `?p_web_site_id=5352&p_published_to=WWW&p_language=DEFAULT&p_direct=Y&p_format=MOBILE`;
const CAREER_URL = 'https://www.chuv.ch/fr/chuv-home/professionnels/emplois';

const USER_AGENT = 'FrontaliereTicino-JobCrawler/2.0 (+https://frontaliereticino.ch)';
const REQUEST_DELAY_MS = 250;

/* ── Postal code map for CHUV locations (mostly VD) ────────── */

const CHUV_POSTAL_CODES = {
  lausanne: '1011',                  // CHUV main site
  prilly: '1008',                    // site de Cery
  'prilly-malley': '1008',
  epalinges: '1066',
  bussigny: '1030',
  'chavannes-pres-renens': '1022',
  'le-mont-sur-lausanne': '1052',
  morges: '1110',
  nyon: '1260',
  prangins: '1197',
  gland: '1196',
  rennaz: '1847',
  villeneuve: '1844',
  orbe: '1350',
  pompaples: '1318',
  'yverdon-les-bains': '1400',
  'montagny-pres-yverdon': '1442',
  payerne: '1530',
  palezieux: '1607',
  lonay: '1027',
  gimel: '1188',
  // Non-VD locations (CHUV affiliate / partner roles occasionally listed)
  geneve: '1204',
  bellinzone: '6500',
  sion: '1950',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function citySlug(city = '') {
  return normalize(city)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function postalCodeFor(city = '') {
  return CHUV_POSTAL_CODES[citySlug(city)] || '1011'; // default to CHUV HQ
}

/**
 * Pull the first classification value matching one of the given class IDs.
 * CHUV's feed groups taxonomy under classifications.class_<id>.values[].class_val.
 */
function pickClassValue(classifications = {}, classKey = '') {
  const cls = classifications?.[classKey];
  const values = cls?.values || [];
  if (!values.length) return '';
  return normalizeSpace(values[0]?.class_val || '');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isChuvJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CHUV_KEY ||
    company === 'chuv' ||
    company.includes('centre hospitalier universitaire vaudois') ||
    url.includes('recrutement.chuv.ch') ||
    url.includes('chuv.ch/fr/chuv-home/professionnels/emplois')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'chuv.ch' || host.endsWith('.chuv.ch');
  } catch {
    return false;
  }
}

/* ── Category / Contract / Level Detection ─────────────────── */

/**
 * Map CHUV "Catégorie professionnelle" (class_14093) to our category buckets.
 * Falls back to title-based detection when the classification is empty.
 */
function detectCategory(title = '', professionalCategory = '') {
  const cat = normalize(professionalCategory);
  if (cat.includes('soin')) return 'Sanità';
  if (cat.includes('medecin') || cat.includes('médecin')) return 'Sanità';
  if (cat.includes('medico-techn') || cat.includes('médico-techn')) return 'Sanità';
  if (cat.includes('psychosocial')) return 'Sanità';
  if (cat.includes('recherche')) return 'Ricerca';
  if (cat.includes('administration')) return 'Amministrazione';
  if (cat.includes('technique') || cat.includes('logistique')) return 'Tecnica';
  if (cat.includes('stagiaire') || cat.includes('apprenti')) return 'Stage/Apprendistato';
  if (cat.includes('benevol') || cat.includes('bénévol')) return 'Volontariato';

  // Fallback: title-based heuristic (FR/IT/DE/EN)
  const t = normalize(title);
  if (/\b(infirm|soign|aide.?soign|sage.?femme|asa|assc)/.test(t)) return 'Sanità';
  if (/\b(medecin|médecin|chef.?de.?clinique|cdc|assistant-?e?\s+medecin)/.test(t)) return 'Sanità';
  if (/\b(technicien|techniker|technic)/.test(t)) return 'Tecnica';
  if (/\b(admin|secretair|secrétair|comptab|gestionn)/.test(t)) return 'Amministrazione';
  if (/\b(chercheur|recherche|doctora|post.?doc|phd)/.test(t)) return 'Ricerca';
  if (/\b(stagiair|apprenti|étudiant|etudiant)/.test(t)) return 'Stage/Apprendistato';
  if (/\b(it|informatique|développeur|developpeur|developer|software)/.test(t)) return 'IT';
  return 'Sanità'; // CHUV is a hospital — sane default
}

/**
 * Map CHUV "Type de contrat" (class_14054) → our contract enum.
 * Possible values: CDI, CDD, CDM, Bénévole.
 */
function detectContract(contractType = '') {
  const c = normalize(contractType);
  if (c.includes('cdi')) return 'permanent';
  if (c.includes('cdd')) return 'fixed-term';
  if (c.includes('cdm')) return 'fixed-term'; // CDM = mission contract
  if (c.includes('benevol') || c.includes('bénévol')) return 'volunteer';
  return 'permanent';
}

/**
 * Map CHUV "Taux d'activité" (class_14052) → schema.org employmentType.
 * Common values: "Temps plein", "Temps partiel", "80% - 100%".
 */
function detectEmploymentType(activityRate = '', title = '') {
  const r = normalize(activityRate);
  const t = normalize(title);
  if (r.includes('plein') || /100\s*%/.test(r)) return 'FULL_TIME';
  if (r.includes('partiel')) return 'PART_TIME';
  if (/\b(stagiair|apprenti|stage|intern)/.test(t)) return 'INTERN';
  // Range like "80% - 100%": treat as full when upper bound >= 90, else part
  const m = r.match(/(\d{1,3})\s*%\s*[-–]\s*(\d{1,3})\s*%/);
  if (m) {
    const upper = parseInt(m[2], 10);
    return upper >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'FULL_TIME';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiair|apprenti|stage|intern|étudiant|etudiant|lehrling)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|chef|responsable|directeur|directrice|cadre|head|lead)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Language': 'fr-CH,fr;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`CHUV feed HTTP ${res.status} from ${FEED_URL}`);
  }
  const data = await res.json();
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

/**
 * Fetch the detail HTML for a single vacancy and return a plain-text description.
 * Falls back to the title-only stub if the request fails — the AI translation
 * pipeline will still produce a viable record.
 */
async function fetchJobDetail(weblink = '') {
  if (!weblink) return '';
  try {
    const res = await fetch(weblink, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-CH,fr;q=0.9',
      },
    });
    if (!res.ok) return '';
    const html = await res.text();
    // The Hireserve vacancy page wraps the description in #vacancy-content / .vacancy
    // Extract the main column conservatively — strip nav/header/footer noise.
    const bodyMatch = html.match(/<main[\s\S]*?<\/main>/i)
      || html.match(/<div[^>]*class="[^"]*vacancy[^"]*"[\s\S]*?<\/div>\s*<\/div>/i);
    const raw = bodyMatch ? bodyMatch[0] : html;
    return normalizeSpace(stripHtml(raw)).slice(0, 8000);
  } catch {
    return '';
  }
}

/**
 * Fetch all CHUV jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllChuvJobs() {
  console.log(`🔍 Fetching CHUV jobs`);
  console.log(`   Source: ${FEED_URL}\n`);

  const listings = await fetchFeed();
  if (!listings.length) {
    console.warn('⚠️ No CHUV job listings returned by the feed.');
    return [];
  }
  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const status = normalize(listing?.status || '');
    if (status && status !== 'open' && status !== 'live') continue;
    if (listing?.display_in_list && listing.display_in_list !== 'Y') continue;

    const title = normalizeSpace(listing?.title || '');
    if (!title || title.length < 3) continue;

    const classifications = listing?.classifications || {};
    const department = pickClassValue(classifications, 'class_14042');
    const contractType = pickClassValue(classifications, 'class_14054');
    const professionalCategory = pickClassValue(classifications, 'class_14093');
    const lieu = pickClassValue(classifications, 'class_14094');
    const activityRate = pickClassValue(classifications, 'class_14052');

    // Resolve location: prefer Hireserve location array → fallback to "Lieu" classification
    const apiLocation = (listing?.locations || []).find((l) => l?.city)?.city || '';
    const location = normalizeSpace(apiLocation || lieu || 'Lausanne');
    const canton = inferSwissTargetCanton(location) || 'VD';
    const postalCode = postalCodeFor(location);

    const publicUrl = listing?.weblink && /^https?:\/\//.test(listing.weblink)
      ? listing.weblink
      : `${PORTAL_BASE}/vacancy/${listing?.id || ''}`;

    // Defer detail fetch — keeps initial run cheap; allow opt-out via env.
    let descriptionText = '';
    if (process.env.CHUV_SKIP_DETAILS !== '1') {
      descriptionText = await fetchJobDetail(publicUrl);
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
    if (!descriptionText) {
      // Compose a meaningful stub from the feed metadata so AI translation has signal.
      const parts = [
        `${title} — CHUV`,
        department ? `Département: ${department}` : '',
        professionalCategory ? `Catégorie: ${professionalCategory}` : '',
        lieu ? `Lieu: ${lieu}` : '',
        activityRate ? `Taux d'activité: ${activityRate}` : '',
        contractType ? `Type de contrat: ${contractType}` : '',
      ].filter(Boolean);
      descriptionText = parts.join(' · ');
    }

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} chuv ${listing?.id || ''}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = (listing?.publication?.internet?.publish_date || listing?.timestamp || '')
      .toString()
      .slice(0, 10) || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `chuv-${listing?.id || urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CHUV_COMPANY_NAME,
      companyKey: CHUV_KEY,
      companyDomain: CHUV_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'CHUV Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, professionalCategory),
      contract: detectContract(contractType),
      employmentType: detectEmploymentType(activityRate, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'healthcare',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },

      // ── CHUV-specific metadata (preserved for downstream consumers) ──
      department: department || undefined,
      referenceCode: listing?.refno || undefined,
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total CHUV jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export for runner ergonomics
export { CAREER_URL, FEED_URL, slugify, stripHtml };
