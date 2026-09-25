#!/usr/bin/env node
/**
 * Möbel Pfister AG (pfister) job parser — Refline ATS tenant 424626 on
 * apply.refline.ch.
 *
 * pfister is Switzerland's largest furniture/home-furnishing retailer
 * (founded 1882, HQ in Suhr AG), part of the XXXLutz Group since 2020, with
 * 18 branches spread across nearly every canton. Its Refline tenant lists
 * openings for both `Möbel Pfister AG` and its curtain-fitting subsidiary
 * `Pfister Vorhang Service AG` — both are the same corporate group, not an
 * unrelated shared/multi-brand instance.
 *
 * Public career site:
 *   https://www.pfister.ch/de/karriere
 *   Refline widget: https://apply.refline.ch/424626/search.html?lang=de
 *
 * Listing format: table-row, Pfister sub-variant —
 *   <tr><td class="position"><a href=".../{posId}/pub/{rev}/index.html">Title</a></td>
 *       <td class="businessUnit">…</td>
 *       <td class="workplace">…</td>
 *       <td class="workload">…</td></tr>
 *   The table adds a `businessUnit` column between `position` and `workplace`
 *   — the same slot ZKB fills with `operationArea` — so `refline-common.mjs`'s
 *   `parseReflineTableListing` was extended (backward-compatibly) to tolerate
 *   both column names.
 *
 * Detail page: <h1 id="bTitle">Title</h1> + generic p/li/h3/h4 content blocks
 * (same shape parseReflineDetail already handles for other tenants).
 *
 * Location coverage is genuinely multi-canton (live-verified 2026-07-04,
 * 38 open roles): AG (Suhr, Spreitenbach), ZH (Affoltern am Albis,
 * Dübendorf), BE (Bern, Alchenflüh-Lyssach, Thörishaus), FR (Avry),
 * TI (Contone), LU (Emmen), VD (Etoy, Villeneuve), SG (Mels), BL (Pratteln).
 * Four workplace strings need an explicit override instead of the shared
 * `inferSwissTargetCanton()` municipality lookup:
 *  - "Alchenflueh-Lyssach", "Thoerishaus", "Villeneuve" are not resolvable
 *    at all (either missing from the curated BFS municipality list, or —
 *    for the compound "Alchenflueh-Lyssach" label — split apart by the
 *    generic hyphen-split heuristic before the matchable half is checked).
 *  - "Spreitenbach" resolves, but to the WRONG canton: it is administratively
 *    Aargau, yet `crawler-location-config.mjs`'s `SWISS_CANTONS.ZH.names`
 *    lists it as a Zürich-agglomeration town (pre-existing miscategorization,
 *    also worked around by `ikea-job-parser.mjs`'s hardcoded HQ canton —
 *    not fixed here since it lives in a widely-shared geo config file
 *    outside this crawler's scope).
 * Left unhandled, all four would silently fall through to the Suhr/AG
 * default (Alchenflueh-Lyssach/Thoerishaus/Villeneuve) or the wrong canton
 * (Spreitenbach) instead of surfacing a "safe default, not removed check"
 * result — this override map keeps them correct.
 */
import { createReflineParser } from './refline-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

// "Pfister" is a common Swiss surname/brand — the plain substring check
// createReflineParser() uses by default for every other tenant would also
// match unrelated companies like "Angst+Pfister AG", "Carrosserie Pfister
// AG" and "PFISTERER Holding AG" (all contain the bare token "pfister").
// Only treat the free-text `company` field as a genuine Möbel Pfister AG /
// Pfister Vorhang Service AG match (see file header) when it contains one of
// these unambiguous, qualified phrases.
function isPfisterCompanyName(normalizedCompany = '') {
  return normalizedCompany.includes('möbel pfister') || normalizedCompany.includes('pfister vorhang');
}

export const PFISTER_KEY = 'pfister';
export const PFISTER_COMPANY_NAME = 'Möbel Pfister AG';
export const PFISTER_COMPANY_DOMAIN = 'pfister.ch';

// Workplace strings (as they appear verbatim in the Refline `workplace`
// column) that the shared BFS-municipality canton lookup cannot resolve.
// Keys are lower-cased for matching; values are the canonical
// city/canton to report.
const PFISTER_LOCATION_OVERRIDES = {
  'alchenflueh-lyssach': { city: 'Alchenflüh-Lyssach', canton: 'BE' },
  'alchenflüh-lyssach': { city: 'Alchenflüh-Lyssach', canton: 'BE' },
  thoerishaus: { city: 'Thörishaus', canton: 'BE' },
  thörishaus: { city: 'Thörishaus', canton: 'BE' },
  villeneuve: { city: 'Villeneuve', canton: 'VD' },
  spreitenbach: { city: 'Spreitenbach', canton: 'AG' },
};

function pfisterLocationHints(workplace = '') {
  const raw = String(workplace || '').trim();
  const override = PFISTER_LOCATION_OVERRIDES[raw.toLowerCase()];
  if (override) return { city: override.city, canton: override.canton, postal: '' };

  if (!raw) return { city: 'Suhr', canton: 'AG', postal: '5034' };
  const cleaned = raw.replace(/^Kanton\s+/i, '').trim();
  const cityPart = cleaned.split(/[-–—,]/)[0].trim();
  const inferred = inferSwissTargetCanton(cityPart) || inferSwissTargetCanton(cleaned);
  if (inferred) return { city: cityPart || 'Suhr', canton: inferred, postal: '' };
  return { city: cityPart || 'Suhr', canton: 'AG', postal: '' };
}

const parser = createReflineParser({
  reflineTenant: '424626',
  companyKey: PFISTER_KEY,
  companyName: PFISTER_COMPANY_NAME,
  companyDomain: PFISTER_COMPANY_DOMAIN,
  defaultCanton: 'AG',
  defaultCity: 'Suhr',
  defaultPostalCode: '5034',
  publicCareerUrl: 'https://www.pfister.ch/de/karriere',
  defaultSourceLang: 'de',
  listingHost: 'apply.refline.ch',
  listingPath: 'search.html?lang=de',
  sector: 'Retail / Furniture',
  sourceLabel: 'Möbel Pfister AG Dedicated Parser (Refline 424626)',
  locationHintsFor: pfisterLocationHints,
  companyNameMatch: isPfisterCompanyName,
});

export const fetchAllPfisterJobs = parser.fetchAllJobs;
export const isPfisterJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
