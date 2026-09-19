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
  fetchWorkdayJobDetail,
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

function locationDescriptor(value) {
  if (typeof value === 'string') return value;
  return value?.descriptor || value?.location || value?.name || '';
}

/**
 * Resolve the Swiss city a req may be PUBLISHED under, from its OWN primary
 * workplace (`jobPostingInfo.location`), or `''`.
 *
 * This used to walk `[info.location, ...info.additionalLocations]` and return
 * the first Swiss hit. Workday reqs are cross-posted to several countries, so
 * that union is true while the workplace is abroad: a req worked in Frankfurt
 * that also lists Zug resolved to Zug and went out stamped `Zug / ZG / CH`.
 * Only the primary licenses the stamp; fail closed otherwise.
 *
 * Measured 2026-09-19 across the 10 published slices of the factory's
 * consumers (eraneos 58, everest-re 1, galderma 6, georg-fischer 19, medbase
 * 163, siemens-healthineers 3, temenos 0, trafigura 6, vontobel 32, ferring no
 * slice): 0 misattributed records, so the union defect is LATENT. The single
 * behaviour change is siemens-healthineers, whose 3 records have opaque
 * requisition-site path segments (`LPN-BO`, `TOI-L-112`, `CEY-BO`) published
 * as its `defaultCity`/`defaultCanton` (`Zurich`/`ZH`) — i.e. the HQ default
 * firing unverifiably — and are now dropped.
 *
 * Exported so a call site cannot drift back to the union without breaking the
 * test that names this rule.
 */
export function resolveWorkdayPrimarySwissLocation(info = {}) {
  const raw = locationDescriptor(info?.location);
  if (!raw || isLocationExplicitlyForeign(raw)) return '';
  const cleaned = cleanWorkdayLocation(raw);
  return cleaned && inferSwissTargetCanton(cleaned) ? cleaned : '';
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
  if (/\b(praktik|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|graduate)/.test(t)) return 'intern';
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
    let missingDetailUrlCount = 0;
    for (const listing of listings) {
      const title = normalizeSpace(listing.title || '');
      if (!title || title.length < 3) continue;

      // Count URL loss only after the same listing-level foreign-location gate
      // used below. Ambiguous locations stay conservative; detail-only
      // geography cannot be checked once the detail URL is missing.
      // Never substitute the HQ city for an absent `locationRaw`, on EITHER
      // path: an empty listing location carries no per-site Swiss signal, and
      // defaulting it here would make `cleaned` non-empty and slip the posting
      // past the guards below, stamping it with the HQ canton. Keep it empty
      // so the guards drop it.
      const listingRawLocation = listing.locationRaw || '';
      const detailUrl = String(listing.url || '').trim();
      if (!detailUrl) {
        if (!isLocationExplicitlyForeign(listingRawLocation)) missingDetailUrlCount += 1;
        console.log(`  ⏭️  Skipped listing without detail URL: ${title}`);
        continue;
      }

      // Fetch detail once: besides the body it carries the real primary and
      // additional locations when the listing is an `N Locations` roll-up.
      let detail = null;
      try {
        detail = await fetchWorkdayJobDetail(API_BASE, listing.externalPath);
      } catch {
        detail = null;
      }
      const detailInfo = detail?.jobPostingInfo || {};
      const detailLocations = [
        detailInfo.location,
        ...(Array.isArray(detailInfo.additionalLocations) ? detailInfo.additionalLocations : []),
      ].map(locationDescriptor).filter(Boolean);
      const detailLocation = resolveWorkdayPrimarySwissLocation(detailInfo);
      const detailIsForeignOnly = detailLocations.length > 0
        && !detailLocation
        && detailLocations.some((value) => isLocationExplicitlyForeign(value));
      if (detailIsForeignOnly) {
        console.log(`  ⏭️  Skipped foreign detail location: ${detailLocations.join(' | ')} — ${title}`);
        continue;
      }
      const rawLocation = detailLocation || listingRawLocation;
      if (isLocationExplicitlyForeign(rawLocation)) {
        console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
        continue;
      }
      let cleaned = cleanWorkdayLocation(rawLocation);
      if (!cleaned && detailLocation) cleaned = detailLocation;
      // On BOTH paths an empty `cleaned` means the listing exposed no usable
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
      if (!cleaned) {
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
      if (!cleaned) {
        console.log(`  ⏭️  Skipped unresolved multi-site/empty location: ${rawLocation} — ${title}`);
        continue;
      }
      const location = cleaned;
      const inferredCanton = inferSwissTargetCanton(location);
      // Require a confident Swiss match on BOTH paths, not just the unfiltered
      // board: the facet only proves the tenant filtered the board, never that
      // this req's own workplace is in Switzerland, so the HQ-canton fallback
      // here stamped `addressCountry: CH` on a location nothing had verified.
      // Measured 2026-09-19: 0 misattributed records in the 10 consumer
      // slices, so this is LATENT except siemens-healthineers, whose 3 records
      // (`LPN-BO`, `TOI-L-112`, `CEY-BO`) were published as `Zurich`/`ZH` by
      // this very default and are now dropped.
      if (!inferredCanton) {
        continue;
      }
      const canton = inferredCanton;
      const publicUrl = detailUrl;
      const employmentType = detectEmploymentType(listing.timeType || '', title);

      const detailDescription = detailInfo.jobDescription
        ? stripHtml(String(detailInfo.jobDescription))
          .replace(/[ \t]+/g, ' ')
          .replace(/[ \t]*\n[ \t]*/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 4000)
        : '';
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
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
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
    jobs.missingDetailUrlCount = missingDetailUrlCount;
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
