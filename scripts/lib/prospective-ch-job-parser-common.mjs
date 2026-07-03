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
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

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
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${apiUrl}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }, { label: `prospective-ch ${apiUrl}` });
}

function pickLocation(job, defaultCity) {
  const szas = job?.szas || {};
  const cityRaw = String(szas['sza_location.city'] || '').trim();
  if (cityRaw) {
    const m = cityRaw.match(/\b(\d{4})\s+([^\n,]+)/);
    if (m) return normalizeSpace(m[2]);
    return normalizeSpace(cityRaw);
  }
  // Some Prospective tenants store the city under `sza_workplace.city` (a
  // plain city name without postal prefix) — newer schema, e.g. asana Spital AG.
  const workplaceCity = String(szas['sza_workplace.city'] || '').trim();
  if (workplaceCity) return normalizeSpace(workplaceCity);
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" instead of the dotted `sza_location.city`
  // key above — parse the trailing "ZIP City" segment when present.
  const flatLocation = String(szas['sza_location'] || '').trim();
  if (flatLocation) {
    const flatMatch = flatLocation.match(/\b\d{4}\s+([^\n,]+)$/);
    if (flatMatch) return normalizeSpace(flatMatch[1]);
  }
  // Sometimes the site label is in attributes[10] (legacy fallback). Skip it
  // when it's clearly a department code (4-letter all-caps) rather than a city,
  // so callers fall through to defaultCity.
  const attr10 = Array.isArray(job?.attributes?.['10']) ? job.attributes['10'][0] : '';
  if (attr10) {
    const trimmed = normalizeSpace(attr10);
    if (!/^[A-Z]{2,5}$/.test(trimmed)) return trimmed;
  }
  return defaultCity;
}

// City-gated HQ fallback: only borrow the configured default ZIP/street when
// the resolved location TEXT actually matches the HQ city — canton-level
// matching is wrong, since it would re-stamp HQ street/ZIP onto any other
// city in the same canton. `pickLocation` already falls back to `defaultCity`
// itself when there's no real signal, so this also covers the legitimate
// zero-signal case (location === defaultCity).
function isHqCity(location, defaultCity) {
  if (!location || !defaultCity) return !location;
  const escaped = String(defaultCity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(location);
}

function pickPostalCode(job, defaultPostal, location, defaultCity) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\b/);
  if (m) return m[1];
  // Newer schema: explicit workplace ZIP field.
  const workplaceZip = String(job?.szas?.['sza_workplace.zip'] || '').trim();
  const m2 = workplaceZip.match(/\b(\d{4})\b/);
  if (m2) return m2[1];
  // Some tenants expose a standalone `sza_location.zip` field instead of
  // embedding the ZIP in the city string (e.g. medium 1005736 workplace
  // records: `sza_location.city: 'Solothurn'`, `sza_location.zip: '4500'`).
  const locationZip = String(job?.szas?.['sza_location.zip'] || '').trim();
  const m3 = locationZip.match(/\b(\d{4})\b/);
  if (m3) return m3[1];
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" instead of the dotted keys above.
  const flatLocation = String(job?.szas?.['sza_location'] || '').trim();
  const m4 = flatLocation.match(/\b(\d{4})\s+[^\n,]+$/);
  if (m4) return m4[1];
  return isHqCity(location, defaultCity) ? defaultPostal : '';
}

function pickStreetAddress(job, defaultStreet, location, defaultCity) {
  // `sza_workplace` is often a free-text "Label, Street Number, ZIP City"
  // triple (e.g. "Baloise Solothurn, Amthausplatz 4, 4500 Solothurn"). The
  // comma-segment containing a digit but not starting with a 4-digit ZIP
  // is the street address.
  const workplace = String(job?.szas?.sza_workplace || '').trim();
  if (workplace) {
    const parts = workplace.split(',').map((p) => p.trim()).filter(Boolean);
    const streetPart = parts.find((p) => /\d/.test(p) && !/^\d{4}\b/.test(p));
    if (streetPart) return streetPart;
  }
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" — same comma-segment heuristic applies.
  const flatLocation = String(job?.szas?.sza_location || '').trim();
  if (flatLocation) {
    const flatParts = flatLocation.split(',').map((p) => p.trim()).filter(Boolean);
    const flatStreetPart = flatParts.find((p) => /\d/.test(p) && !/^\d{4}\b/.test(p));
    if (flatStreetPart) return flatStreetPart;
  }
  return isHqCity(location, defaultCity) ? defaultStreet : '';
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
 * @param {string} [config.defaultStreetAddress] HQ street, used ONLY as a
 *   city-gated fallback (resolved location matches defaultCity) when a
 *   listing's own `sza_workplace` has no parseable street segment.
 * @param {string} [config.apiLang='de']     Listing language
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {string[]} [config.extraTrustedHosts]  Additional hosts to mark as trusted
 * @param {string[]} [config.acceptDirectlinkHosts]  Only ingest listings whose
 *   `links.directlink` hostname matches one of these. Use for shared Prospective
 *   tenants that mix multiple employers (e.g. medium 1008606 serves both PZM
 *   Münsingen and UPD Bern). Default: no filtering.
 * @param {boolean} [config.sharedMedium=false]  Set true when this `mediumId`
 *   is intentionally split across multiple companyKeys (discriminated via
 *   `filterListing` at fetch time, e.g. Baloise/Helvetia on medium 1005736).
 *   Disables the bare `/medium/{id}/` URL fallback in `isCompanyJob`, which
 *   would otherwise match jobs belonging to the *other* company sharing the
 *   tenant — that fallback is only safe when one company owns the medium.
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
    defaultStreetAddress = '',
    publicCareerUrl,
    defaultSourceLang = 'de',
    extraTrustedHosts = [],
    acceptDirectlinkHosts = [],
    sharedMedium = false,
    filterListing,
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
  const directlinkHostAllowlist = new Set(
    (acceptDirectlinkHosts || []).map((h) => String(h).toLowerCase().replace(/^www\./, '')),
  );

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
    if (!sharedMedium && url.includes(`/medium/${mediumId}/`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (trustedHosts.has(host)) return true;
      if (corporateHost && host.endsWith(`.${corporateHost}`)) return true;
      if (host === 'ohws.prospective.ch') {
        // Accept both tenant-scoped (/medium/{ID}/) and job-direct (/public/v1/jobs/{viewkey})
        // formats. The API returns the job-direct shape when a tenant has no
        // custom job-page URL configured (e.g. GZ Dielsdorf medium 1005824).
        if (rawUrl.includes(`/medium/${mediumId}/`)) return true;
        if (rawUrl.includes('/public/v1/jobs/')) return true;
      }
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
      // Graceful degradation: any fetch error (HTTP 404, ENOTFOUND, abort,
      // malformed JSON) terminates pagination instead of throwing. Returns
      // whatever was collected so far (empty list on first-iter failure).
      // Matches the contract every dedicated crawler test asserts via
      // "graceful degradation" suites — when the upstream JobAbo is offline,
      // the crawler must return [] (no throw), not crash the cron workflow.
      let data;
      try {
        data = await fetchPage(url);
      } catch (err) {
        console.warn(`  ⚠️  Prospective fetch failed at offset=${offset}: ${err && err.message || err}. Returning ${all.length} jobs collected so far.`);
        break;
      }
      const items = assertJsonListShape(data, { key: 'jobs', source: companyName, lang: apiLang });
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
    let directlinkSkipped = 0;
    let attributeSkipped = 0;
    for (const listing of all) {
      const szas = listing?.szas || {};
      const title = normalizeSpace(szas.sza_title || listing.title || '');
      if (!title || title.length < 3) continue;

      // Caller-supplied predicate for shared tenants where the discriminator
      // is an attribute bucket (e.g. medium 1003280 tags KSNW vs LUKS via
      // attributes['40']). Returning false drops the listing.
      if (typeof filterListing === 'function') {
        let keep = true;
        try { keep = !!filterListing(listing); } catch { keep = false; }
        if (!keep) { attributeSkipped += 1; continue; }
      }

      // Multi-employer Prospective tenant filter: when configured, drop
      // listings whose directlink hostname doesn't match the allowlist.
      // This is for shared tenants like 1008606 (PZM Münsingen + UPD Bern).
      if (directlinkHostAllowlist.size > 0) {
        const dl = normalizeSpace(listing?.links?.directlink || '');
        if (dl) {
          try {
            const dlHost = new URL(dl).hostname.toLowerCase().replace(/^www\./, '');
            if (!directlinkHostAllowlist.has(dlHost)) {
              directlinkSkipped += 1;
              continue;
            }
          } catch {
            // Malformed URL — treat as not matching, skip.
            directlinkSkipped += 1;
            continue;
          }
        }
      }

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
        postalCode: pickPostalCode(listing, defaultPostalCode, location, defaultCity),
        streetAddress: pickStreetAddress(listing, defaultStreetAddress, location, defaultCity),
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

    if (directlinkSkipped > 0) {
      console.log(`  ⏭️  Filtered out ${directlinkSkipped} listings (directlink host not in allowlist)`);
    }
    if (attributeSkipped > 0) {
      console.log(`  ⏭️  Filtered out ${attributeSkipped} listings (filterListing predicate)`);
    }
    console.log(`📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
