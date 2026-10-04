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
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, isCantonOnlyLabel, isSwissLocationText } from './target-swiss-locations.mjs';
import { resolveSwissLocalityCanton, resolveSwissPostalCodePlace } from './swiss-locality-directory.mjs';
import {
  isAuthoritativeEmptySnapshot,
  markAuthoritativeEmptySnapshot,
} from './authoritative-empty-snapshot.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDetail,
  fetchWorkdaySidebarText,
  workdayPostingDateFields,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
  workdayPrimaryLocationState,
  fetchWorkdayBoardSummary,
  workdayFacetLeafValues,
} from './ats-clients/workday-client.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

// Switzerland country UUID — standard across nearly all Workday tenants.
export const WORKDAY_SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

// Officially assigned ISO 3166-1 alpha-2 codes (249). A structured country is
// evidence only when its code is on this list: a malformed, reserved or
// tenant-private code (`UK`, `EU`, `ZZ`, `XX`, ...) is "unrecognised", not
// "foreign", and must not feed the authoritative-empty proof. Deliberately a
// literal rather than `Intl.DisplayNames`, whose answer depends on the ICU
// build and which names `UK`, `EU` and `QO` as regions.
const ISO_3166_1_ALPHA2 = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT '
  + 'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG '
  + 'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' '));

/**
 * True only when `fetchWorkdayJobs` reported a board it saw whole: page 0 stated
 * a positive finite `total`, exactly that many postings were yielded and
 * collected, and pagination ended on its own terms — never on a swallowed page
 * error or the page cap. A missing or degenerate `total` (some tenants send 0)
 * is unprovable and fails closed.
 *
 * @param {import('./ats-clients/workday-client.mjs').WorkdayFetchStats|object} stats
 * @param {number} collected listings the caller actually holds
 */
export function isCompleteWorkdayBoard(stats, collected) {
  const total = stats?.firstPageTotal;
  if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) return false;
  if (!['total-reached', 'short-page', 'empty-page'].includes(stats?.endReason)) return false;
  return stats.yielded === total && collected === total;
}

const SWISS_COUNTRY_LABEL_RE = /\b(?:switzerland|schweiz|suisse|svizzera)\b/i;

function workdayBoardListsSwitzerland(summary, { facetParameter, swissIds = WORKDAY_SWISS_LOCATION_IDS } = {}) {
  const values = workdayFacetLeafValues(summary?.facets, facetParameter);
  return Boolean(values?.some((value) => swissIds.includes(value.id) || SWISS_COUNTRY_LABEL_RE.test(value.descriptor)));
}

/**
 * Whether an UNFILTERED board summary (`fetchWorkdayBoardSummary`) proves that
 * the career site is live and currently posts nowhere in Switzerland.
 *
 * "Board vuota" vs "board inesistente": a renamed or retired site answers 404
 * (`S21 not found: Job_Posting_Site_ID`) and never reaches this check, but a
 * site emptied by a migration to another ATS answers 200 with `total: 0` — the
 * same zero the Swiss-faceted query gives. Only a board that states postings
 * (`total > 0`) AND lists its country/location facet with Switzerland absent
 * from every value is the employer's own statement that the Swiss zero is real.
 * A missing facet, an empty one, or a Swiss value of any count is not a proof.
 *
 * @param {import('./ats-clients/workday-client.mjs').WorkdayBoardSummary|null|undefined} summary
 * @param {{ facetParameter: string, swissIds?: string[] }} options
 * @returns {boolean}
 */
export function provesWorkdaySwissAbsentFromBoard(summary, { facetParameter, swissIds = WORKDAY_SWISS_LOCATION_IDS } = {}) {
  const total = summary?.total;
  if (!Number.isSafeInteger(total) || total <= 0) return false;
  const values = workdayFacetLeafValues(summary.facets, facetParameter);
  if (!values || values.length === 0) return false;
  return values.every((value) => (
    !swissIds.includes(value.id)
    && !SWISS_COUNTRY_LABEL_RE.test(value.descriptor)
    && !isSwissLocationText(value.descriptor)
  ));
}

/**
 * Country-facet names seen on the fleet's Workday tenants, the closed list the
 * factory may fall back to when a tenant rejects the default key with HTTP 400
 * and its board summary shows no facet holding the Swiss id. Only facets whose
 * values are COUNTRIES belong here: the proof reads the same facet's values.
 *
 * `locationMainGroup` is deliberately absent. It is a group of nested facets
 * (`locations`, `primaryLocation`, `locationCountry`), not a filter key:
 * measured 2026-10-04, `appliedFacets: { locationMainGroup: [<CH id>] }`
 * answers HTTP 400 on Temenos, Lombard Odier, Medbase, Georg Fischer and
 * Medtronic, and the nested `locations` answers 502 to a country id.
 */
export const WORKDAY_COUNTRY_FACET_PARAMETERS = Object.freeze([
  'locationCountry', // the default, accepted 2026-10-04 by Georg Fischer, Medtronic, Siemens Healthineers, Sulzer, Trafigura
  'Country', // Imerys, KONE
  'Location', // Vontobel
  'Location_Country', // Ferring (no Swiss value: the zero is proven on it)
  'alocationCountry', // Galderma
]);

/**
 * Pick the facet a Swiss-scoped query should use on a tenant that rejected the
 * configured key, from the UNFILTERED board summary (`fetchWorkdayBoardSummary`).
 *
 *   1. `swiss-value`: the one facet, at any nesting depth, whose own values
 *      carry a Swiss id (Galderma `alocationCountry`, Vontobel `Location`,
 *      Imerys / KONE `Country`). The query then returns the Swiss postings
 *      already filtered.
 *   2. `known-name`: otherwise, the one TOP-LEVEL facet named in
 *      `WORKDAY_COUNTRY_FACET_PARAMETERS` (Ferring `Location_Country`). Top
 *      level only, because that is where the proof reads its values.
 *
 * Zero or several candidates at a step → `null`: the caller keeps today's
 * behaviour (whole board + per-listing Swiss gate, unstamped zero). The
 * rejected key is never proposed again.
 *
 * @param {import('./ats-clients/workday-client.mjs').WorkdayBoardSummary|null|undefined} summary
 * @param {{ rejectedParameter?: string, swissIds?: string[] }} [options]
 * @returns {{ facetParameter: string, reason: 'swiss-value'|'known-name' }|null}
 */
export function discoverWorkdayCountryFacet(summary, { rejectedParameter = '', swissIds = WORKDAY_SWISS_LOCATION_IDS } = {}) {
  const facets = Array.isArray(summary?.facets) ? summary.facets : [];
  const withSwissValue = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || !Array.isArray(node.values)) continue;
      const parameter = typeof node.facetParameter === 'string' ? node.facetParameter : '';
      if (parameter && node.values.some((value) => (
        value && typeof value === 'object' && !Array.isArray(value.values) && swissIds.includes(String(value.id ?? ''))
      ))) {
        withSwissValue.add(parameter);
      }
      walk(node.values);
    }
  };
  walk(facets);
  withSwissValue.delete(rejectedParameter);
  if (withSwissValue.size === 1) return { facetParameter: [...withSwissValue][0], reason: 'swiss-value' };
  if (withSwissValue.size > 1) return null;

  const known = [...new Set(facets
    .map((facet) => facet?.facetParameter)
    .filter((parameter) => parameter !== rejectedParameter && WORKDAY_COUNTRY_FACET_PARAMETERS.includes(parameter)))];
  return known.length === 1 ? { facetParameter: known[0], reason: 'known-name' } : null;
}

/**
 * The req's structured primary country, when Workday states one and it is NOT
 * Switzerland; otherwise `''`.
 *
 * Reads `jobRequisitionLocation.country` (alpha-2 first) and the posting-level
 * `country`. Only an explicit foreign statement counts: an absent, Swiss or
 * unrecognised country returns `''`, so this can never manufacture a verdict
 * from missing data. Used exclusively as EVIDENCE for the authoritative-empty
 * proof below — it never decides whether a job is published.
 */
export function workdayStructuredForeignPrimaryCountry(info = {}) {
  const req = info?.jobRequisitionLocation;
  const alpha2 = String(req?.country?.alpha2Code || '').trim().toUpperCase();
  // A present but unrecognised code is not evidence, and it also vetoes the
  // descriptor fallback: the req's own structured country is unreadable.
  if (alpha2) return alpha2 !== 'CH' && ISO_3166_1_ALPHA2.has(alpha2) ? alpha2 : '';
  for (const candidate of [req?.country?.descriptor, info?.country?.descriptor]) {
    const text = normalizeSpace(candidate || '');
    if (text && isLocationExplicitlyForeign(text)) return text;
  }
  return '';
}

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
  for (let index = 0; index < parts.length; index += 1) {
    const p = parts[index];
    if (!inferSwissTargetCanton(p)) continue;
    // Un cantone non sostituisce la località che lo precede: `Seewis,
    // Graubunden` (il BFS scrive «Seewis im Prättigau») usciva `Graubunden`,
    // cioè un cantone pubblicato come località (georg-fischer, issue 5253).
    // La località resta, qualificata dal cantone che la rende riconoscibile.
    if (index > 0 && isCantonOnlyLabel(p)) return parts.slice(0, index + 1).join(', ');
    return p;
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
  return cleaned && swissCantonOf(cleaned, info).canton ? cleaned : '';
}

/**
 * Whether the req's OWN structured country is Switzerland: the requisition's
 * alpha-2 when Workday states one (it decides alone, so a foreign requisition
 * is never overruled), otherwise the posting-level country by its canonical
 * Workday id or name. Text alone never counts.
 */
export function workdayStructuredPrimaryCountryIsSwiss(info = {}) {
  const alpha2 = String(info?.jobRequisitionLocation?.country?.alpha2Code || '').trim().toUpperCase();
  if (alpha2) return alpha2 === 'CH';
  const country = info?.country;
  if (!country || typeof country !== 'object') return false;
  if (WORKDAY_SWISS_LOCATION_IDS.includes(String(country.id || ''))) return true;
  return /^(?:switzerland|schweiz|suisse|svizzera)$/i.test(normalizeSpace(country.descriptor || ''));
}

/**
 * The official directory's canton for a place, keyed by locality name:
 * `Bodio, Switzerland` → `Bodio`, and a trailing site qualifier goes too —
 * Novartis names its sites `Rotkreuz (Office-Based)`, `Muttenz (with Canteen)`.
 * An explicit canton qualifier (`(ZG)`) never reaches here: the gazetteer
 * reads it first. Offline: no request.
 */
const NON_PLACE_SEGMENT_RE = /^(?:ch|che|switzerland|schweiz|suisse|svizzera|emea|europe|remote|hybrid|on-?site)$/i;

function directoryLocalityCanton(text) {
  const bare = text.replace(/\s*\([^()]*\)\s*$/, '').trim() || text;
  // Tenant labels wrap the place: `CH - Rotkreuz`, `EMEA, CH, Rotkreuz, CSL
  // Behring`, `Bodio, Switzerland`. The label and each of its segments are
  // looked up; the answer stands only when exactly ONE place comes back.
  const hits = new Map();
  for (const segment of [bare, ...bare.split(/\s*[,|·;:]\s*|\s+-\s+/)]) {
    const name = segment.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!name || NON_PLACE_SEGMENT_RE.test(name)) continue;
    const canton = resolveSwissLocalityCanton(name);
    if (canton) hits.set(`${name.toLowerCase()}|${canton}`, { canton, locality: name });
  }
  return hits.size === 1 ? [...hits.values()][0] : { canton: '', locality: '' };
}

function swissCantonOf(location, info = {}) {
  const text = normalizeSpace(location);
  if (!text || isLocationExplicitlyForeign(text)) return { canton: '', locality: '' };
  const canton = inferSwissTargetCanton(text);
  if (canton) return { canton, locality: '' };
  if (!workdayStructuredPrimaryCountryIsSwiss(info)) return { canton: '', locality: '' };
  return directoryLocalityCanton(text);
}

/**
 * Canton of a req's primary Swiss locality, or `''`.
 *
 * The gazetteer behind `inferSwissTargetCanton` lists today's BFS communes, so
 * a workplace named after a LOCALITY rather than a commune resolves to nothing
 * and the req was dropped: measured live 2026-10-02, all 3 Swiss reqs of
 * Imerys (`Bodio`, merged into Giornico on 2025-04-06; `Bironico`, part of
 * Monteceneri since 2010) and 3 of KONE's 6 (`Brüttisellen`, in
 * Wangen-Brüttisellen). When the req's own structured country is Switzerland,
 * the official locality directory (swisstopo / Swiss Post) may name the canton
 * — only when it places the name in exactly one canton, never a guess.
 */
export function resolveWorkdaySwissCanton(location, info = {}, { log = true } = {}) {
  const { canton, locality } = swissCantonOf(location, info);
  if (log && canton && locality) console.log(`  📍 Canton from the Swiss locality directory: ${locality} → ${canton}`);
  return canton;
}

/**
 * The Swiss place a req's ADDRESS names, from its postal code, or null.
 *
 * Some tenants state the requisition workplace as an address, not a place:
 * Abbott's Zürich reqs read `Switzerland : Technoparkstrass 1 CH 8005` (live
 * 2026-10-02, 4 reqs dropped). Same guarantees as the locality rule: the req's
 * own structured country must be Switzerland, the text must carry exactly one
 * four-digit code (a second one could be a street number), and the official
 * directory must give that code one canton and one locality.
 *
 * @param {string} location
 * @param {object} [info] the req's `jobPostingInfo` (or `{ jobRequisitionLocation }`)
 * @returns {{ canton: string, locality: string } | null}
 */
export function resolveWorkdayPostalPlace(location, info = {}) {
  const text = normalizeSpace(location);
  if (!text || !workdayStructuredPrimaryCountryIsSwiss(info)) return null;
  const codes = [...new Set(text.match(/\b\d{4}\b/g) || [])];
  if (codes.length !== 1) return null;
  return resolveSwissPostalCodePlace(codes[0]);
}

/**
 * The Swiss place a req's location text names when the commune gazetteer could
 * not — `{ location, canton }`, or null. The recovery the Workday parsers share
 * (imerys, kone, the nine dedicated parsers, abbott's address reqs):
 *   1. the official locality directory, by name, one canton only
 *      (`Bodio`, `Rotkreuz (Office-Based)`, `CH - Brüttisellen`);
 *   2. the postal code of an address, one canton and one locality only
 *      (`Switzerland : Technoparkstrass 1 CH 8005` → Zürich).
 * Both only on the req's own structured Swiss country. It never answers for a
 * place the gazetteer resolves: a parser keeps its own verdict there.
 *
 * @param {string} location
 * @param {object} [info] the req's `jobPostingInfo`
 * @param {{ log?: boolean }} [options]
 * @returns {{ location: string, canton: string } | null}
 */
export function recoverWorkdaySwissPlace(location, info = {}, { log = true } = {}) {
  const text = normalizeSpace(location);
  if (!text || isLocationExplicitlyForeign(text) || inferSwissTargetCanton(text)) return null;
  if (!workdayStructuredPrimaryCountryIsSwiss(info)) return null;
  const directory = directoryLocalityCanton(text);
  if (directory.canton) {
    if (log) console.log(`  📍 Canton from the Swiss locality directory: ${directory.locality} → ${directory.canton}`);
    return { location: directory.locality, canton: directory.canton };
  }
  const postal = resolveWorkdayPostalPlace(text, info);
  if (postal) {
    if (log) console.log(`  📮 Place from the Swiss postal code: ${text} → ${postal.locality} (${postal.canton})`);
    return { location: postal.locality, canton: postal.canton };
  }
  return null;
}

/**
 * Whether a listing row's location text MAY be a Swiss place the recovery can
 * confirm — the directory places exactly one of its names, or it carries one
 * unique Swiss postal code. Offline, no request: for parsers that pre-filter
 * listing rows before reading the detail, so a locality-named row is not
 * dropped before its structured country is even read. Never a verdict on its
 * own: `recoverWorkdaySwissPlace` still needs the req's structured Swiss
 * country.
 *
 * @param {string} location
 * @returns {boolean}
 */
export function isWorkdaySwissPlaceCandidate(location) {
  const text = normalizeSpace(location);
  if (!text || isLocationExplicitlyForeign(text)) return false;
  if (directoryLocalityCanton(text).canton) return true;
  const codes = [...new Set(text.match(/\b\d{4}\b/g) || [])];
  return codes.length === 1 && Boolean(resolveSwissPostalCodePlace(codes[0]));
}

/**
 * `recoverWorkdaySwissPlace` over the req's OWN primary workplace: the
 * requisition location first, then the posting location. For a parser whose
 * own resolver dropped the req.
 *
 * @param {object} [info] the req's `jobPostingInfo`
 * @param {{ log?: boolean }} [options]
 * @returns {{ location: string, canton: string } | null}
 */
export function recoverWorkdayPrimarySwissPlace(info = {}, options = {}) {
  for (const field of [info?.jobRequisitionLocation, info?.location]) {
    const place = recoverWorkdaySwissPlace(locationDescriptor(field), info, options);
    if (place) return place;
  }
  return null;
}

/**
 * `resolveWorkdaySwissCanton` for the dedicated Workday parsers that place a
 * req from its listing row and only read the detail for the body (abbott,
 * alcon, ardian, bossard, ksb, novartis, rituals-cosmetics, roche, stryker).
 * The commune gazetteer answers first; only when it misses AND the directory
 * knows the name is the req's detail read, for its structured country — so a
 * board whose places are communes or foreign cities costs no extra request.
 *
 * @param {string} apiBase CXS base, see `buildWorkdayApiBase`
 * @param {string} externalPath the listing's `/job/...` path
 * @param {string} location the place the parser is about to publish
 * @param {{ fetchDetail?: typeof fetchWorkdayJobDetail }} [options]
 * @returns {Promise<string>} canton code, or `''`
 */
export async function fetchWorkdaySwissCanton(apiBase, externalPath, location, options = {}) {
  const text = normalizeSpace(location);
  if (!text || isLocationExplicitlyForeign(text)) return '';
  const canton = inferSwissTargetCanton(text);
  if (canton || !apiBase || !externalPath) return canton;
  // No request unless the directory knows the name: on a global board (roche
  // walks every country) a foreign city costs nothing.
  if (!directoryLocalityCanton(text).canton) return '';
  const { fetchDetail = fetchWorkdayJobDetail } = options;
  let detail = null;
  try {
    detail = await fetchDetail(apiBase, externalPath);
  } catch {
    detail = null;
  }
  return resolveWorkdaySwissCanton(text, detail?.jobPostingInfo || {});
}

/**
 * Swiss city of a req whose LISTING row carries no single location — an
 * `N Locations` roll-up or an empty `locationsText` — read from the req's own
 * primary workplace in the detail, or `''`.
 *
 * For the dedicated Workday parsers that predate this factory. Their legacy
 * scaffold filled that gap with the employer HQ (`|| 'Basel'`, `|| 'Selzach'`,
 * ...), so a req worked in Warsaw, Pune or Neustadt and cross-posted to a
 * Swiss site went out stamped with the HQ canton (issue 9842: roche, sulzer,
 * abbott). `''` means "no Swiss primary": the caller drops the row.
 *
 * @param {string} apiBase CXS base, see `buildWorkdayApiBase`
 * @param {string} externalPath the listing's `/job/...` path
 * @param {{ fetchDetail?: typeof fetchWorkdayJobDetail }} [options]
 * @returns {Promise<string>}
 */
export async function fetchWorkdayPrimarySwissLocation(apiBase, externalPath, options = {}) {
  const { fetchDetail = fetchWorkdayJobDetail } = options;
  if (!apiBase || !externalPath) return '';
  let detail = null;
  try {
    detail = await fetchDetail(apiBase, externalPath);
  } catch {
    detail = null;
  }
  return resolveWorkdayPrimarySwissLocation(detail?.jobPostingInfo || {});
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
 * @param {string} [config.countryFacetParameter='locationCountry'] Name of the
 *   tenant's country/location facet. Most tenants call it `locationCountry`;
 *   some (Imerys, KONE) call it `Country` and answer HTTP 400 to the default
 *   key. Leave it out: when the default is rejected with HTTP 400 the factory
 *   reads the board's facets and picks the country facet itself
 *   (`discoverWorkdayCountryFacet`). Declare it only when that discovery finds
 *   nothing or the wrong facet; a declared key is never second-guessed.
 * @param {boolean} [config.proveSwissAbsentFromLiveBoard=true] Stamp an empty
 *   result as a source-proven zero when the Swiss-faceted query itself states
 *   `total: 0` AND the unfiltered board is live (`total > 0`) with Switzerland
 *   absent from its country/location facet (`provesWorkdaySwissAbsentFromBoard`).
 *   On by default: the standard crawler template honours the stamp. Pass
 *   `false` only with a comment on that line, or the one above, saying why
 *   (tests/workday-swiss-job-parser-common.test.ts enforces the comment).
 * @param {boolean} [config.preferJobRequisitionLocation=false] Use the
 *   requisition's structured workplace when the tenant's public listing
 *   location is a search/region label.
 * @param {boolean} [config.proveForeignOnlyBoardEmpty=false] Stamp an empty
 *   result as a source-proven zero (`markAuthoritativeEmptySnapshot`) when the
 *   Swiss-faceted board was seen whole and EVERY listing on it is a req whose
 *   structured primary country is foreign — i.e. cross-postings that list a
 *   Swiss site only as an additional location, which the primary-only gate
 *   refuses by design (issue #9651). Pair with the runner's
 *   `allowAuthoritativeEmptySnapshot` + `authoritativeSnapshotScope:
 *   'empty-only'`.
 * @param {boolean} [config.includeCareerSiteSidebar=false] Append the career
 *   site's sidebar text (`GET {apiBase}/sidebar`: "Über uns", employer
 *   benefits, …) to every posting body. Workday folds those blocks into each
 *   posting's JSON-LD `description`, while the CXS job payload never carries
 *   them — so a tenant that keeps its company paragraph in the sidebar
 *   (Medbase) published ~45 % of what its source page states. Opt-in per
 *   tenant, after checking its sidebar is employer content and not a bare
 *   video/landing widget.
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
    countryFacetParameter = 'locationCountry',
    proveSwissAbsentFromLiveBoard = true,
    preferJobRequisitionLocation = false,
    proveForeignOnlyBoardEmpty = false,
    includeCareerSiteSidebar = false,
  } = config;

  if (!companyKey || !companyName || !tenantHost || !sitePath || !defaultCanton) {
    throw new Error('createWorkdaySwissParser: missing required config (companyKey, companyName, tenantHost, sitePath, defaultCanton)');
  }

  // A key the parser declared is the tenant's own answer: no discovery over it.
  const countryFacetDeclared = config.countryFacetParameter !== undefined;

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

  async function fetchJobListings({ useCountryFacet, stats = undefined, facetParameter = countryFacetParameter }) {
    const out = [];
    // Default path applies the canonical Swiss `locationCountry` facet. Some
    // tenants name their country facet differently (`Location`,
    // `alocationCountry`, …) and reject `locationCountry` with HTTP 400 — for
    // those fetchAllJobs() first looks for the tenant's own country facet, and
    // only without one refetches the unfiltered board under strict canton
    // inference.
    const fetchOpts = useCountryFacet
      ? { appliedFacets: { [facetParameter]: locationFilters }, maxPages: 100000, stats }
      : { appliedFacets: {}, maxPages: 100000, stats };
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
          ...workdayPostingDateFields(posting),
          externalPath: id.externalPath,
          jobReqId: id.jobReqId,
          timeType: posting.timeType || '',
        });
      }
    } catch (err) {
      if (err instanceof WorkdayAuthError) {
        // A blocked Swiss-faceted request must reach fetchAllJobs(), which
        // already has the safe unfiltered-board fallback for tenants that
        // reject the facet. Returning [] here turns a live board into the
        // runner's `no-jobs-parsed` abort (the Everest Re failure mode).
        if (useCountryFacet) throw err;
        console.error(`❌ Workday anti-bot block (${companyName}): ${err.message}`);
        // The unfiltered retry is the last transport attempt. Preserve the
        // cause on the empty array so the standard pipeline records an
        // anti-bot failure rather than treating it as a legitimate zero.
        Object.defineProperty(out, 'fetchOutcome', {
          value: 'anti_bot_block',
          enumerable: false,
        });
        return out;
      }
      throw err;
    }
    return out;
  }

  /**
   * Read the unfiltered board once and stamp an empty result only when that
   * board proves the tenant is live without Switzerland in the configured
   * facet. A missing or ambiguous proof stays a bare `[]`; a board that lists
   * Switzerland returns null so the caller can retry through the strict
   * per-listing CH gate.
   */
  async function proveSwissAbsentFromLiveBoard(facetParameter, boardCache, reason) {
    const empty = [];
    let summary = boardCache?.summary;
    if (!summary) {
      try {
        summary = await fetchWorkdayBoardSummary(API_BASE);
      } catch (err) {
        console.warn(`⚠️ ${companyName}: could not read the unfiltered Workday board to prove the Swiss zero (${err?.message || err}).`);
        return empty;
      }
      if (boardCache) boardCache.summary = summary;
    }
    if (!provesWorkdaySwissAbsentFromBoard(summary, { facetParameter, swissIds: locationFilters })) {
      console.warn(`⚠️ ${companyName}: the unfiltered Workday board does not prove the Swiss zero `
        + `(total=${summary?.total ?? 'n/a'}, ${facetParameter} facet ${workdayFacetLeafValues(summary?.facets, facetParameter) ? 'present' : 'missing'}).`);
      if (workdayBoardListsSwitzerland(summary, { facetParameter, swissIds: locationFilters })) {
        return null;
      }
      return empty;
    }
    const locations = workdayFacetLeafValues(summary.facets, facetParameter);
    const evidence = `${companyName} Workday site ${sitePath}: ${reason}; live board `
      + `${summary.total} posting(s) across ${locations.length} location value(s) (${locations.slice(0, 5).map((c) => c.descriptor).join(', ')}`
      + `${locations.length > 5 ? ', …' : ''}), Switzerland not among them`;
    console.log(`  🧾 Proven empty Swiss board — ${evidence}`);
    return markAuthoritativeEmptySnapshot(empty, evidence);
  }

  /**
   * Zero-listing run: stamp it only when the Swiss-faceted query itself said
   * `total: 0` on a page it completed, and the unfiltered board proves the
   * site is live without Switzerland in its country facet. Anything else — a
   * facet the tenant rejected, an anti-bot `[]`, a missing total, a board with
   * no postings at all, a failed proof read — stays a bare `[]`, which the
   * runner's validator refuses (previous slice kept, monitor keeps counting).
   * Returns null when the unfiltered board explicitly lists Switzerland: the
   * faceted zero is then inconsistent with the source and the caller must
   * refetch the unfiltered board through the strict per-listing CH gate.
   * `facetParameter` is the key the faceted query actually used (declared or
   * discovered): the board must be read on that same facet. `boardCache` holds
   * the unfiltered summary already read in this run (by facet discovery or an
   * earlier proof attempt), so the board is read at most once per run; a failed
   * read is not cached.
   */
  async function proveSwissAbsentEmpty(facetApplied, facetStats, facetParameter, boardCache) {
    const facetSaidZero = facetApplied
      && facetStats?.firstPageTotal === 0
      && facetStats?.endReason === 'empty-page'
      && facetStats?.yielded === 0;
    if (!facetSaidZero) return [];
    return proveSwissAbsentFromLiveBoard(facetParameter, boardCache, 'Swiss-faceted query total 0');
  }

  /**
   * After the Swiss-faceted query failed: when it was an HTTP 400 on the
   * default key (the tenant names its country facet differently), read the
   * unfiltered board's facets and pick the tenant's own country facet. Any
   * other failure (anti-bot, 5xx, network), a key the parser declared, or a
   * board that does not name one facet unambiguously → `null`, today's path.
   * The summary read here is kept in `boardCache` for the zero proof.
   */
  async function discoverCountryFacetAfterRejection(err, boardCache) {
    if (countryFacetDeclared) return null;
    if (err instanceof WorkdayAuthError || err?.statusCode !== 400) return null;
    let summary;
    try {
      summary = await fetchWorkdayBoardSummary(API_BASE);
    } catch (summaryErr) {
      console.warn(`⚠️ ${companyName}: could not read the Workday board facets to find the country facet (${summaryErr?.message || summaryErr}).`);
      return null;
    }
    if (boardCache) boardCache.summary = summary;
    const discovered = discoverWorkdayCountryFacet(summary, { rejectedParameter: countryFacetParameter, swissIds: locationFilters });
    if (!discovered) {
      const names = (summary?.facets || []).map((facet) => facet?.facetParameter).filter(Boolean);
      console.warn(`⚠️ ${companyName}: no single country facet on the Workday board (facets: ${names.join(', ') || 'none'}).`);
    }
    return discovered;
  }

  async function fetchAllJobs() {
    console.log(`🏭 Fetching ${companyName} jobs`);
    console.log(`   Source: ${careerUrl || PUBLIC_BASE}`);
    console.log(`   Workday: ${API_BASE}\n`);

    let facetApplied = true;
    let facetReturnedEmpty = false;
    let emptyProof;
    let listings = [];
    // How the faceted pagination ended — the completeness evidence for the
    // authoritative-empty proof. Only the faceted fetch fills it.
    const facetStats = {};
    // The facet key the Swiss-scoped query ends up using: the declared one, or
    // the one discovered on the board after the default was rejected.
    let facetParameter = countryFacetParameter;
    // The unfiltered board summary, read at most once per run and shared by
    // facet discovery and the zero proof.
    const boardCache = {};
    try {
      listings = await fetchJobListings({ useCountryFacet: true, stats: facetStats, facetParameter });
    } catch (err) {
      console.warn(`⚠️ ${companyName}: ${countryFacetParameter} facet rejected (${err?.message || err}).`);
      const discovered = await discoverCountryFacetAfterRejection(err, boardCache);
      let discoveredListings = null;
      if (discovered) {
        console.warn(`⚠️ ${companyName}: using the board's own country facet "${discovered.facetParameter}" `
          + `(found by ${discovered.reason === 'swiss-value' ? 'its Swiss value' : 'its known name'}).`);
        try {
          discoveredListings = await fetchJobListings({ useCountryFacet: true, stats: facetStats, facetParameter: discovered.facetParameter });
          facetParameter = discovered.facetParameter;
        } catch (retryErr) {
          console.warn(`⚠️ ${companyName}: discovered facet "${discovered.facetParameter}" rejected too (${retryErr?.message || retryErr}).`);
        }
      }
      if (discoveredListings) {
        listings = discoveredListings;
      } else {
        // No usable country facet on this tenant — refetch the full board and
        // apply a strict Swiss-canton gate per listing instead.
        console.warn(`⚠️ ${companyName}: refetching unfiltered with strict CH gate.`);
        facetApplied = false;
        listings = await fetchJobListings({ useCountryFacet: false });
      }
    }

    // Some tenants accept the locationCountry facet without erroring and
    // simply return the full, unfiltered global board anyway (confirmed on
    // Everest Re: identical `total` with/without the facet). A genuinely
    // CH-scoped board never contains an explicitly-foreign listing, so any
    // hit here proves the facet was silently ignored. First use the same
    // source-level Swiss-absence proof as the empty-facet path; if it cannot
    // prove absence, downgrade to the strict per-listing gate using the SAME
    // (already unfiltered) listings.
    if (facetApplied && listings.some((l) => isLocationExplicitlyForeign(l.locationRaw))) {
      if (proveSwissAbsentFromLiveBoard) {
        const proof = await proveSwissAbsentFromLiveBoard(
          facetParameter,
          boardCache,
          'Swiss-faceted query returned foreign listing(s)',
        );
        if (isAuthoritativeEmptySnapshot(proof)) return proof;
      }
      console.warn(`⚠️ ${companyName}: ${facetParameter} facet silently ignored (foreign listings present in "filtered" board). Applying strict CH gate.`);
      facetApplied = false;
    }

    // A tenant can accept the facet request and answer with an empty page even
    // while its unfiltered board still contains Swiss postings (a stale or
    // silently unsupported facet). Treat the empty filtered response like the
    // rejected-facet path: retry the live board and apply the strict per-listing
    // Swiss gate instead of turning a live source into `no-jobs-parsed`.
    if (facetApplied && listings.length === 0) {
      facetReturnedEmpty = true;
      if (proveSwissAbsentFromLiveBoard) {
        emptyProof = await proveSwissAbsentEmpty(true, facetStats, facetParameter, boardCache);
        if (isAuthoritativeEmptySnapshot(emptyProof)) return emptyProof;
      }
      console.warn(`⚠️ ${companyName}: Swiss facet returned no listings. Refetching unfiltered with strict CH gate.`);
      facetApplied = false;
      listings = await fetchJobListings({ useCountryFacet: false });
    }

    // An anti-bot block on a later page can leave either unfiltered retry with
    // a partial batch. Preserve that transport outcome before any listing-level
    // fallback or parsing can mistake the batch for a complete snapshot.
    if (listings?.fetchOutcome === 'anti_bot_block') return listings;

    const strictSwiss = !facetApplied;
    if (!listings || listings.length === 0) {
      console.warn('⚠️ No Swiss job listings returned from Workday API.');
      // The unfiltered retry is the last transport attempt. Do not replace its
      // annotated empty array while probing for an authoritative zero.
      if (listings?.fetchOutcome === 'anti_bot_block') return listings;
      if (proveSwissAbsentFromLiveBoard) {
        const proof = emptyProof === undefined
          ? await proveSwissAbsentEmpty(facetReturnedEmpty || facetApplied, facetStats, facetParameter, boardCache)
          : emptyProof;
        if (isAuthoritativeEmptySnapshot(proof)) return proof;
      }
      return listings || [];
    }
    console.log(`  📋 Listings found: ${listings.length}${strictSwiss ? ' (unfiltered — strict CH gate active)' : ' (Swiss facet)'}`);

    const sidebarText = includeCareerSiteSidebar
      ? await fetchWorkdaySidebarText(API_BASE, stripHtml)
      : '';

    const jobs = [];
    let missingDetailUrlCount = 0;
    // Listings whose detail was fetched AND states a foreign primary country.
    // Counted before any drop decision; the proof below needs it to equal the
    // whole board, so a skipped listing, a failed detail fetch or a req with
    // no structured country each break the proof by construction.
    const foreignPrimaryListings = [];
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
      const foreignPrimaryCountry = detail ? workdayStructuredForeignPrimaryCountry(detailInfo) : '';
      if (foreignPrimaryCountry) foreignPrimaryListings.push(`${listing.jobReqId || title}:${foreignPrimaryCountry}`);
      const requisitionState = workdayPrimaryLocationState({
        location: detailInfo.jobRequisitionLocation,
      });
      // Some tenants expose the requisition field only for a subset of
      // postings. Prefer it when present, but retain the structured detail
      // location when it is absent; an explicit unresolved requisition still
      // remains primary and is rejected by the fail-closed state below.
      const primaryLocationField = preferJobRequisitionLocation && requisitionState.present
        ? detailInfo.jobRequisitionLocation
        : detailInfo.location;
      const detailLocations = [
        primaryLocationField,
        ...(Array.isArray(detailInfo.additionalLocations) ? detailInfo.additionalLocations : []),
      ].map(locationDescriptor).filter(Boolean);
      // The req's own structured country travels with its primary location, so
      // a locality outside the BFS commune list can still be placed (see
      // `resolveWorkdaySwissCanton`).
      const primaryInfo = {
        location: primaryLocationField,
        jobRequisitionLocation: detailInfo.jobRequisitionLocation,
        country: detailInfo.country,
      };
      const detailLocation = resolveWorkdayPrimarySwissLocation(primaryInfo);
      const detailIsForeignOnly = detailLocations.length > 0
        && !detailLocation
        && detailLocations.some((value) => isLocationExplicitlyForeign(value));
      if (detailIsForeignOnly) {
        console.log(`  ⏭️  Skipped foreign detail location: ${detailLocations.join(' | ')} — ${title}`);
        continue;
      }
      // Carry the PRIMARY's state through every fallback below.
      // `resolveWorkdayPrimarySwissLocation` returns '' both when the detail has
      // no primary at all and when it has one that was not recognised, and
      // `detailLocation || listingRawLocation` collapsed the second case into
      // the first — so a Swiss listing row, or the `externalPath` segment
      // further down, could still emit the job with a Swiss locality even
      // though the req's own primary said something else. Fail-open, and the
      // same semantic error as a resolver that never fails, one layer up.
      //
      // A primary that is PRESENT but unresolved is evidence about the req, not
      // an absence to be filled in: the only legitimate substitute is a primary
      // that genuinely is not there.
      const primaryState = workdayPrimaryLocationState({ location: primaryLocationField });
      const mayFallBackToListing = !primaryState.present;
      const rawLocation = detailLocation || (mayFallBackToListing ? listingRawLocation : '');
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
      // Gated on the same primary state: this recovery exists for tenants whose
      // `locationsText` is a rollup, NOT to overrule a primary that is present
      // and unrecognised. Without the gate it is a second fail-open path to the
      // very same outcome the check above closes.
      if (!cleaned && mayFallBackToListing) {
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
      // The directory fallback applies only to the detail's own primary, whose
      // structured country it is gated on — never to a listing row or path
      // segment recovered above.
      const inferredCanton = location === detailLocation
        ? resolveWorkdaySwissCanton(location, primaryInfo)
        : inferSwissTargetCanton(location);
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
      // The CXS listing row carries no `timeType`; the detail does ("Part
      // time" on KONE's 50 % HR role, live 2026-10-02, published full-time).
      const employmentType = detectEmploymentType(listing.timeType || detailInfo.timeType || '', title);

      const detailDescription = detailInfo.jobDescription
        ? stripHtml(String(detailInfo.jobDescription))
          .replace(/[ \t]+/g, ' ')
          .replace(/[ \t]*\n[ \t]*/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        : '';
      await new Promise((r) => setTimeout(r, 350));

      // Only the posting's own text is published (issue 5253). A req whose
      // detail has no body used to go out as a synthetic "Key details" stub
      // (location, employer, "apply on the portal"); it is not published any
      // more (0 rows on the 13 tenants of this factory on 2026-09-29).
      if (!meetsSourceBodyFloor(detailDescription)) {
        console.log(`  ⏭️  No vacancy text in the Workday detail, not published: ${title}`);
        continue;
      }
      const bodyText = detailDescription;
      const descriptionText = sidebarText ? `${bodyText}\n\n${sidebarText}` : bodyText;

      // Language of the posting body, not of the site-level sidebar.
      const sourceLang = detectLang(bodyText || title, defaultSourceLang);
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
        ...mergeSourcePostingDates(listing, workdayPostingDateFields(detail)),
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };
      if (listing.jobReqId) job.jobReqId = listing.jobReqId;

      jobs.push(job);
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length}`);
    Object.defineProperty(jobs, 'missingDetailUrlCount', {
      value: missingDetailUrlCount,
      enumerable: false,
    });
    // A facet-empty response can be a stale/unsupported filter rather than a
    // proof on its own. Once the unfiltered retry has gone through the strict
    // Swiss gate, the same live-board summary proof is valid when that retry
    // produces no Swiss jobs. Preserve an unproven result as a bare batch.
    if (proveSwissAbsentFromLiveBoard && facetReturnedEmpty && jobs.length === 0) {
      const proven = emptyProof === undefined || (Array.isArray(emptyProof) && !isAuthoritativeEmptySnapshot(emptyProof))
        ? await proveSwissAbsentEmpty(true, facetStats, facetParameter, boardCache)
        : emptyProof;
      if (isAuthoritativeEmptySnapshot(proven)) return proven;
    }
    // Source-proven zero: the facet-scoped board was observed whole (the
    // iterator yielded exactly the `total` page 0 announced and no page failed
    // — a short page alone is not proof, a tenant can cut a page short while
    // `total` says more) and every req on it is worked abroad. That is a positive statement by the source, not "the parser
    // found nothing": an anti-bot `[]`, a zero-listing board, a facet the
    // tenant ignored, a detail that failed to load or a req without a
    // structured country all leave the batch unstamped, so the pipeline keeps
    // failing closed on them.
    if (
      proveForeignOnlyBoardEmpty
      && jobs.length === 0
      && facetApplied
      && isCompleteWorkdayBoard(facetStats, listings.length)
      && foreignPrimaryListings.length === listings.length
    ) {
      const evidence = `${companyName} Workday Swiss-faceted board: ${listings.length} listing(s), `
        + `every primary workplace abroad (${foreignPrimaryListings.join(', ')})`;
      console.log(`  🧾 Proven empty Swiss board — ${evidence}`);
      return markAuthoritativeEmptySnapshot(jobs, evidence);
    }
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
