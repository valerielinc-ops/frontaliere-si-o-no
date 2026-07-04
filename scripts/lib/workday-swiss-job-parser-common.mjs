#!/usr/bin/env node
/**
 * Shared Workday (Swiss-scoped) job-parser factory.
 *
 * Many large multinationals run their careers on Workday and expose a public
 * CXS JSON API at `https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/
 * {site}/jobs`. This factory builds the 4 functions the standard crawler
 * template needs (`fetchAllJobs`, `isCompanyJob`, `isTrustedDomain`) for any
 * such tenant, scoped to Switzerland.
 *
 * Switzerland scoping is two-layered (defence in depth — some tenants silently
 * ignore an unknown facet and return the global board):
 *   1. API facet `locationFilters` = the canonical Workday Swiss country UUID
 *      `187134fccb084a0ea9b4b95f23890dbe` (standard across nearly all tenants).
 *   2. A per-listing guard that drops any explicitly-foreign location
 *      (`isLocationExplicitlyForeign`) so a facet-ignoring tenant can't leak
 *      non-CH roles mislabelled as `addressCountry: 'CH'`.
 *
 * Single source of truth for the Workday fetch/assembly loop — adding a new
 * Workday employer is then a ~30-line thin wrapper (see e.g.
 * scripts/lib/vontobel-job-parser.mjs).
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

// Switzerland country UUID — standard across nearly all Workday tenants.
export const WORKDAY_SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Workday location strings look like "Zurich, Switzerland", "Geneva - HQ",
 * or rollups "2 Locations". Split on " - " / ",", strip the country suffix,
 * and prefer the first segment the BFS matcher recognises as Swiss.
 */
function cleanWorkdayLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  const noSuffix = trimmed.replace(/,?\s*(switzerland|schweiz|suisse|svizzera)\s*$/i, '').trim();
  const parts = noSuffix.split(/\s*[-,]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  for (const p of parts) {
    if (inferSwissTargetCanton(p)) return p;
  }
  return parts[0];
}

/**
 * Fallback location signal for multi-site rollup postings ("2 Locations",
 * "3 Locations") that `cleanWorkdayLocation` can't resolve. Workday's
 * `externalPath` follows a stable `/job/{PrimaryLocation}/{titleSlug}_{reqId}`
 * shape across tenants — the second path segment is always the requisition's
 * primary work location, even when `locationsText` degrades to a rollup
 * count. Used only as a last-resort strict-mode fallback (never overrides a
 * resolvable `locationsText`), so it can only recover jobs that would
 * otherwise be dropped — never changes behaviour for tenants where
 * `locationsText` already resolves.
 */
function locationFromExternalPath(externalPath = '') {
  const parts = String(externalPath || '').split('/').filter(Boolean);
  if (parts.length < 2 || parts[0].toLowerCase() !== 'job') return '';
  try {
    return decodeURIComponent(parts[1]).trim();
  } catch {
    return parts[1].trim();
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(regulatory|qualit|qa|qc|validation|compliance|gxp|gmp)/.test(t)) return 'Qualità / Compliance';
  if (/\b(manufactur|production|fertigung|produktion|operator|polymech|automatik|mechanik|techniker|technician|maint|wartung)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research|scientist)/.test(t)) return 'Ingegneria';
  if (/\b(sales|kundenberat|account|vertrieb|representative|business\s*develop|territory|aussendienst)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|consumer)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|purchas|einkauf|sourcing)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz|treasur|reporting)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|lawyer|attorney|compliance)/.test(t)) return 'Legale';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops|digital|analytics)/.test(t)) return 'IT';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|intern|stage|stagiair|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|chief|manager|leiter|leitend|verantwort)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string} config.tenantHost   e.g. 'vontobel.wd3.myworkdayjobs.com'
 * @param {string} config.sitePath     e.g. 'Vontobel_External_Career'
 * @param {string} config.careerUrl    public careers page (for logs / fallback)
 * @param {string} config.defaultCanton
 * @param {string} config.defaultCity
 * @param {string} [config.defaultPostalCode]
 * @param {string} [config.sector='Altro']
 * @param {string} [config.defaultSourceLang='en']
 * @param {string[]} [config.locationFilters] Override the Swiss country facet.
 */
export function createWorkdaySwissParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    tenantHost,
    sitePath,
    careerUrl,
    defaultCanton,
    defaultCity,
    defaultPostalCode = '',
    sector = 'Altro',
    defaultSourceLang = 'en',
    locationFilters = WORKDAY_SWISS_LOCATION_IDS,
  } = config;

  if (!companyKey || !companyName || !tenantHost || !sitePath || !defaultCanton) {
    throw new Error('createWorkdaySwissParser: missing required config (companyKey, companyName, tenantHost, sitePath, defaultCanton)');
  }

  const API_BASE = buildWorkdayApiBase(tenantHost, sitePath);
  const PUBLIC_BASE = `https://${tenantHost}/en-US/${sitePath}`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || job?.company || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    return (
      key === companyKey ||
      key.startsWith(companyKey) ||
      (corporateHost && company.includes(corporateHost.split('.')[0])) ||
      (corporateHost && url.includes(corporateHost)) ||
      url.includes(tenantHost)
    );
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      return (
        (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) ||
        host === tenantHost ||
        host.endsWith('.myworkdayjobs.com')
      );
    } catch {
      return false;
    }
  }

  async function fetchJobListings({ useCountryFacet }) {
    const out = [];
    // Default path applies the canonical Swiss `locationCountry` facet. Some
    // tenants name their country facet differently (`Location`,
    // `alocationCountry`, …) and reject `locationCountry` with HTTP 400 — for
    // those we refetch the unfiltered board and rely on strict canton inference.
    const fetchOpts = useCountryFacet
      ? { locationFilters, maxPages: 100000 }
      : { appliedFacets: {}, maxPages: 100000 };
    try {
      for await (const posting of fetchWorkdayJobs(API_BASE, fetchOpts)) {
        const id = extractWorkdayJobIdentity(posting, {
          apiBase: API_BASE,
          publicBase: PUBLIC_BASE,
          company: companyName,
        });
        out.push({
          title: id.title,
          locationRaw: posting.locationsText || id.location || '',
          url: id.applyUrl,
          postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
          externalPath: id.externalPath,
          jobReqId: id.jobReqId,
          timeType: posting.timeType || '',
        });
      }
    } catch (err) {
      if (err instanceof WorkdayAuthError) {
        console.error(`❌ Workday anti-bot block (${companyName}): ${err.message}`);
        return [];
      }
      throw err;
    }
    return out;
  }

  async function fetchAllJobs() {
    console.log(`🏭 Fetching ${companyName} jobs`);
    console.log(`   Source: ${careerUrl || PUBLIC_BASE}`);
    console.log(`   Workday: ${API_BASE}\n`);

    let facetApplied = true;
    let listings = [];
    try {
      listings = await fetchJobListings({ useCountryFacet: true });
    } catch (err) {
      // Country facet not recognised by this tenant — refetch the full board and
      // apply a strict Swiss-canton gate per listing instead.
      console.warn(`⚠️ ${companyName}: locationCountry facet rejected (${err?.message || err}). Refetching unfiltered with strict CH gate.`);
      facetApplied = false;
      listings = await fetchJobListings({ useCountryFacet: false });
    }

    // Some tenants accept the locationCountry facet without erroring and
    // simply return the full, unfiltered global board anyway (confirmed on
    // Everest Re: identical `total` with/without the facet). A genuinely
    // CH-scoped board never contains an explicitly-foreign listing, so any
    // hit here proves the facet was silently ignored — downgrade to the
    // strict per-listing gate using the SAME (already unfiltered) listings,
    // no extra fetch needed.
    if (facetApplied && listings.some((l) => isLocationExplicitlyForeign(l.locationRaw))) {
      console.warn(`⚠️ ${companyName}: locationCountry facet silently ignored (foreign listings present in "filtered" board). Applying strict CH gate.`);
      facetApplied = false;
    }
    const strictSwiss = !facetApplied;
    if (!listings || listings.length === 0) {
      console.warn('⚠️ No Swiss job listings returned from Workday API.');
      return [];
    }
    console.log(`  📋 Listings found: ${listings.length}${strictSwiss ? ' (unfiltered — strict CH gate active)' : ' (Swiss facet)'}`);

    const jobs = [];
    for (const listing of listings) {
      const title = normalizeSpace(listing.title || '');
      if (!title || title.length < 3) continue;

      // In strict mode (unfiltered board) never substitute the HQ city before
      // the location gate: an empty `locationRaw` carries no per-site Swiss
      // signal, and defaulting it to `defaultCity` here would make `cleaned`
      // non-empty and slip the posting past the guard below, mislabelling it as
      // the HQ canton. Keep the raw empty so the guard drops it. The facet path
      // (board already CH-only) keeps the benign HQ fallback.
      const rawLocation = listing.locationRaw || (strictSwiss ? '' : defaultCity);
      if (isLocationExplicitlyForeign(rawLocation)) {
        console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
        continue;
      }
      let cleaned = cleanWorkdayLocation(rawLocation);
      // In strict mode an empty `cleaned` means the listing exposed no usable
      // single Swiss location from `locationsText` — a multi-site "N Locations"
      // rollup, an unparseable string, or an absent location. Before dropping,
      // try the `externalPath` primary-location segment (Workday's stable
      // `/job/{Location}/...` convention across tenants) — some tenants (e.g.
      // Eraneos, Medbase) publish some postings as a multi-site rollup in
      // `locationsText` even though `externalPath` always carries the actual
      // primary work city. Only accepted when it resolves to a confident Swiss
      // canton and isn't explicitly foreign, so this can only recover
      // legitimate CH jobs that would otherwise be dropped — never widens the
      // gate for tenants where `locationsText` already resolves.
      if (strictSwiss && !cleaned) {
        const pathLocation = locationFromExternalPath(listing.externalPath);
        if (
          pathLocation &&
          !isLocationExplicitlyForeign(pathLocation) &&
          inferSwissTargetCanton(pathLocation)
        ) {
          cleaned = pathLocation;
        }
      }
      // Defaulting an unresolved location to the HQ city (below) would let
      // `inferSwissTargetCanton` resolve the HQ canton and silently pass the
      // confidence gate, mislabelling a possibly mixed-/non-CH posting as the
      // HQ canton. None of the remaining cases carry per-site detail to
      // recover the CH location from, so drop the posting instead of
      // guessing HQ.
      if (strictSwiss && !cleaned) {
        console.log(`  ⏭️  Skipped unresolved multi-site/empty location: ${rawLocation} — ${title}`);
        continue;
      }
      const location = cleaned || defaultCity;
      const inferredCanton = inferSwissTargetCanton(location);
      // When the Swiss facet was applied the board is already CH-only, so a
      // tiny village the municipality DB doesn't know still falls back to the
      // HQ canton. When it wasn't (full board), require a confident Swiss match
      // so non-CH roles can't leak through mislabelled as `addressCountry: CH`.
      if (strictSwiss && !inferredCanton) {
        continue;
      }
      const canton = inferredCanton || defaultCanton;
      const publicUrl = listing.url || careerUrl || PUBLIC_BASE;

      // Workday listing endpoint never returns the body — fetch detail.
      let detailDescription = '';
      try {
        detailDescription = await fetchWorkdayJobDescriptionText(API_BASE, listing.externalPath, stripHtml);
      } catch {
        detailDescription = '';
      }
      await new Promise((r) => setTimeout(r, 350));

      const fallbackDescription = [
        `${title} — ${companyName}, ${location}.`,
        '',
        'Key details:',
        `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
        `• Employer: ${companyName}.`,
        `• Apply: ${companyName} Workday careers portal.`,
      ].join('\n');
      const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

      const sourceLang = detectLang(descriptionText || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ch`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const job = {
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText,
        descriptionByLocale: { [sourceLang]: descriptionText },
        needsRetranslation: true,
        location,
        canton,
        url: publicUrl,
        source: `${companyName} Dedicated Parser (Workday)`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(listing.timeType || '', title),
        experienceLevel: detectExperienceLevel(title),
        sector,
        currency: 'CHF',
        featured: false,
        postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };
      if (listing.jobReqId) job.jobReqId = listing.jobReqId;

      jobs.push(job);
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
