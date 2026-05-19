#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using the Prospective.ch ATS.
 *
 * Prospective.ch (Aequivital AG, Zurich) is a Swiss-built HRIS used by many
 * hospitals, public administrations and large companies. Each tenant gets a
 * numeric `medium` ID and exposes a public JSON listing endpoint:
 *
 *   https://ohws.prospective.ch/public/v1/medium/{MEDIUM_ID}/jobs
 *     ?lang={de|fr|it|en}&offset=0&limit=100
 *
 * Response shape: { medium_id, total, jobs: [{ id, hk_id, viewkey, title,
 *   attributes, szas, links, start_date, last_modification_timestamp }] }
 *
 * Tenants identified so far in this codebase:
 *   - 1000745 — Kantonsspital Graubünden (KSGR)
 *   - 1002129 — Lindenhofgruppe Bern
 *   - (multiple, see ksgr/lindenhof parsers + USZ + Spital STS + Uster + UniSpital Basel)
 *
 * The pre-existing `lindenhofgruppe-job-parser.mjs` and `ksgr-job-parser.mjs`
 * predate this shared module; new Prospective-based crawlers should use this
 * factory.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const PAGE_SIZE = 100;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchPage(apiUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${apiUrl}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function pickLocation(job, defaultCity) {
  const szas = job?.szas || {};
  const cityRaw = String(szas['sza_location.city'] || '').trim();
  if (cityRaw) {
    const m = cityRaw.match(/\b(\d{4})\s+([^\n,]+)/);
    if (m) return normalizeSpace(m[2]);
    return normalizeSpace(cityRaw);
  }
  // Sometimes the site label is in attributes[10]
  const attr10 = Array.isArray(job?.attributes?.['10']) ? job.attributes['10'][0] : '';
  if (attr10) return normalizeSpace(attr10);
  return defaultCity;
}

function pickPostalCode(job, defaultPostal) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\b/);
  return m ? m[1] : defaultPostal;
}

function pickEmploymentType(job) {
  const min = Number(job?.szas?.['sza_pensum.min'] || 0);
  const max = Number(job?.szas?.['sza_pensum.max'] || 0);
  if (max > 0 && max < 90) return 'PART_TIME';
  if (min >= 90 || max >= 90) return 'FULL_TIME';
  return 'OTHER';
}

function buildDescription(job) {
  const szas = job?.szas || {};
  const parts = [];
  const intro = normalizeSpace(szas.sza_introduction || '');
  if (intro) parts.push(intro);
  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push(`Aufgaben:\n${tasks}`);
  const reqs = stripHtml(szas.sza_requirements || '');
  if (reqs) parts.push(`Anforderungen:\n${reqs}`);
  const benefits = stripHtml(szas.sza_benefits || '');
  if (benefits) parts.push(`Wir bieten:\n${benefits}`);
  const profile = stripHtml(szas.sza_company_profil || '');
  if (profile) parts.push(profile);
  return parts.join('\n\n');
}

function detectCategory(title = '', dept = '') {
  const t = normalize(`${title} ${dept}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychi|geriatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Create a Prospective.ch parser for one employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string|number} config.mediumId    Prospective tenant ID
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} config.defaultPostalCode
 * @param {string} [config.apiLang='de']     Listing language
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string[]} [config.extraTrustedHosts]  Additional hosts to mark as trusted
 */
export function createProspectiveChParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    mediumId,
    apiLang = 'de',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    publicCareerUrl,
    defaultSourceLang = 'de',
    extraTrustedHosts = [],
  } = config;

  if (!companyKey || !companyName || !mediumId || !defaultCanton) {
    throw new Error('createProspectiveChParser: missing required config');
  }

  const API_BASE = `https://ohws.prospective.ch/public/v1/medium/${mediumId}/jobs`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const trustedHosts = new Set([
    corporateHost,
    ...extraTrustedHosts.map((h) => String(h).toLowerCase()),
  ].filter(Boolean));

  function isCompanyJob(job) {
    if (!job) return false;
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    // Match on display name verbatim or on the corporate-host basename
    // appearing inside the company string (same fuzzy rule the sibling
    // factories use, so `{ company: 'X' }` shapes are recognised).
    if (company && companyName && company === normalize(companyName)) return true;
    if (corporateHost && company && company.includes(corporateHost.split('.')[0])) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (url.includes(`/medium/${mediumId}/`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (trustedHosts.has(host)) return true;
      if (corporateHost && host.endsWith(`.${corporateHost}`)) return true;
      if (host === 'ohws.prospective.ch' && rawUrl.includes(`/medium/${mediumId}/`)) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   API: ${API_BASE} (Prospective medium ${mediumId})`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const all = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const url = `${API_BASE}?lang=${apiLang}&offset=${offset}&limit=${PAGE_SIZE}`;
      console.log(`  📄 offset=${offset}…`);
      const data = await fetchPage(url);
      const items = Array.isArray(data?.jobs) ? data.jobs : [];
      if (Number.isFinite(Number(data?.total))) total = Number(data.total);
      if (items.length === 0) break;
      all.push(...items);
      offset += items.length;
      if (items.length < PAGE_SIZE) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`  ✓ ${all.length} Prospective jobs (API total=${total})\n`);
    if (!all.length) return [];

    const jobs = [];
    for (const listing of all) {
      const szas = listing?.szas || {};
      const title = normalizeSpace(szas.sza_title || listing.title || '');
      if (!title || title.length < 3) continue;

      const directLink = normalizeSpace(listing?.links?.directlink || '');
      const applyLink = normalizeSpace(szas.sza_apply_link || '');
      const publicUrl = directLink || applyLink || publicCareerUrl || API_BASE;

      const location = pickLocation(listing, defaultCity);
      const canton = inferSwissTargetCanton(location) || defaultCanton;
      const descriptionText = buildDescription(listing);
      const sourceLang = detectLang(descriptionText || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const postedDate = (() => {
        const raw = listing?.start_date || listing?.last_modification_timestamp || '';
        const d = new Date(String(raw || ''));
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        return new Date().toISOString().slice(0, 10);
      })();

      const department = normalizeSpace(
        (Array.isArray(listing?.attributes?.['20']) ? listing.attributes['20'][0] : '')
          || szas.sza_company_branch || '',
      );

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — ${companyName}`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${companyName}` },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: publicUrl,
        source: `${companyName} Dedicated Parser (Prospective medium ${mediumId})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: pickPostalCode(listing, defaultPostalCode),
        category: detectCategory(title, department),
        contract: 'full-time',
        employmentType: pickEmploymentType(listing),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: applyLink || publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
