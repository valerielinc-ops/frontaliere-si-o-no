/**
 * Discovery source — OpenStreetMap, via Overpass.
 *
 * The SECO feed only sees employers who are hiring RIGHT NOW in a notifiable
 * occupation. Most of the long tail is invisible to it: a 9-person joinery
 * hires twice a decade and never through the RAV. To reach those we need a
 * census of businesses rather than a census of vacancies, and OSM is the only
 * open one that carries the field that matters — `website`.
 *
 * That field is why this source is worth more than a company register: it hands
 * us name AND domain together, so the whole fragile name-to-domain guessing
 * step is skipped for every employer it covers.
 *
 * Overpass is a shared volunteer service. Queries here are per-canton, tagged,
 * and capped, and the loop is expected to run them on a slow cadence — this is
 * a census that changes over months, not a feed that needs polling.
 */
import { politeFetch } from './../polite-fetch.mjs';
import { normalizeHost, registrableDomain } from './../registrable.mjs';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Tag families that denote an employing business.
 *
 * Started narrow (office/craft/industrial/healthcare) on the theory that shops
 * and restaurants are branch locations of employers better reached through
 * their head office. Measured on Ticino, that theory cost 84% of the census:
 * 237 businesses with a domain, against 1'516 once hospitality and retail were
 * let in. Hotels and clinics hire constantly and hire locally, which is exactly
 * the segment the national boards miss, so breadth wins over tidiness here.
 */
const FILTER_PARTITIONS = [
  [
    'nwr["name"]["website"]["office"](area.a);',
    'nwr["name"]["website"]["craft"](area.a);',
    'nwr["name"]["website"]["industrial"](area.a);',
    'nwr["name"]["website"]["landuse"="industrial"](area.a);',
    'nwr["name"]["website"]["building"="industrial"](area.a);',
  ],
  ['nwr["name"]["website"]["healthcare"](area.a);'],
  ['nwr["name"]["website"]["shop"](area.a);'],
  ['nwr["name"]["website"]["tourism"](area.a);'],
  ['nwr["name"]["website"]["amenity"](area.a);'],
];
const DEFAULT_FILTERS = FILTER_PARTITIONS.flat();

function queryFor(canton, filters, limit, timeoutSec, nameFilter = null) {
  const scopedFilters = nameFilter
    ? filters.map((filter) => filter.replace('(area.a)', `${nameFilter}(area.a)`))
    : filters;
  return `[out:json][timeout:${timeoutSec}];\narea["ISO3166-2"="CH-${canton}"]->.a;\n(\n  ${scopedFilters.join('\n  ')}\n);\nout tags ${limit};`;
}

async function fetchElements(canton, filters, opts, limit, nameFilter = null) {
  let res;
  try {
    res = await politeFetch(ENDPOINT, {
      method: 'POST',
      accept: 'application/json',
      ignoreRobots: true,
      timeoutMs: 180000,
      // Overpass answers 406 to a User-Agent containing the token "Bot" —
      // isolated by bisecting the headers against a working curl (UA is the only
      // one that flips it; Accept and Accept-Language do not). Their usage policy
      // asks callers to identify themselves, so we still do: project name and
      // contact URL, minus the token their filter rejects.
      headers: { 'User-Agent': 'frontaliereticino.ch/2.0 (+https://frontaliereticino.ch/)' },
      body: `data=${encodeURIComponent(queryFor(canton, filters, limit, opts.timeoutSec ?? 120, nameFilter))}`,
      contentType: 'application/x-www-form-urlencoded',
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      lookupImpl: opts.lookupImpl,
    });
  } catch {
    return { elements: null, outcome: 'unavailable', errorCode: 'network_error' };
  }
  if (!res.ok) return { elements: null, outcome: 'unavailable', errorCode: `http_${res.status}` };
  let payload;
  try { payload = JSON.parse(res.body); } catch {
    return { elements: null, outcome: 'malformed', errorCode: 'malformed_json' };
  }
  if (!payload || !Array.isArray(payload.elements)) {
    return { elements: null, outcome: 'malformed', errorCode: 'unexpected_payload' };
  }
  return {
    elements: payload.elements,
    outcome: payload.elements.length >= limit ? 'partial' : 'complete',
    errorCode: payload.elements.length >= limit ? 'result_limit_reached' : null,
  };
}

function collectBusinesses(elements, canton, seen) {
  const businesses = [];
  let malformedRows = 0;
  for (const el of elements) {
    if (!el || typeof el !== 'object' || Array.isArray(el)
      || !el.tags || typeof el.tags !== 'object' || Array.isArray(el.tags)) {
      malformedRows++;
      continue;
    }
    const t = el.tags;
    const name = String(t.name || '').trim();
    const website = String(t.website || t['contact:website'] || '').trim();
    if (!name || !website) { malformedRows++; continue; }
    let domain;
    try { domain = registrableDomain(normalizeHost(new URL(website.startsWith('http') ? website : `https://${website}`).hostname)); } catch {
      malformedRows++;
      continue;
    }
    if (!domain) { malformedRows++; continue; }
    if (seen.has(domain)) continue;
    seen.add(domain);
    businesses.push({
      name,
      domain,
      website,
      city: String(t['addr:city'] || '').trim(),
      canton,
      tags: Object.fromEntries(Object.entries(t).filter(([k]) => /^(office|craft|industrial|healthcare|shop|tourism|amenity|landuse|building)$/.test(k))),
    });
  }
  return { businesses, malformedRows };
}

/**
 * @param {string} canton two-letter code, e.g. `TI`
 * @param {{ limit?: number, filters?: string[], timeoutSec?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any }} [opts]
 * @returns {Promise<{ businesses: { name: string, domain: string, website: string, city: string, canton: string, tags: Record<string,string> }[], outcome: 'complete'|'partial'|'unavailable'|'malformed', errorCode: string|null }>}
 */
export async function fetchOsmBusinesses(canton, opts = {}) {
  const limit = opts.limit ?? 4000;
  const seen = new Set();
  const initialFilters = opts.filters || DEFAULT_FILTERS;
  const initial = await fetchElements(canton, initialFilters, opts, limit);
  if (!Array.isArray(initial.elements)) return { businesses: [], outcome: initial.outcome, errorCode: initial.errorCode };
  const initialResults = collectBusinesses(initial.elements, canton, seen);
  const businesses = [...initialResults.businesses];
  let malformedRows = initialResults.malformedRows;

  // A capped union query can return the same leading 4,000 elements on every
  // run. Recover its tail by querying separate tag families; if a family also
  // reaches the cap, split it by employer-name ranges. Results are deduplicated
  // by employer domain. This fallback runs only when the combined query caps.
  if (initial.errorCode === 'result_limit_reached' && opts.recoverCapped !== false) {
    const partitions = opts.filters ? [opts.filters] : FILTER_PARTITIONS;
    let partitionFailed = false;
    let partitionCapped = false;
    const readPartition = async (filters, nameFilter = null, range = null) => {
      const part = await fetchElements(canton, filters, opts, limit, nameFilter);
      if (!Array.isArray(part.elements)) {
        partitionFailed = true;
        return;
      }
      const collected = collectBusinesses(part.elements, canton, seen);
      businesses.push(...collected.businesses);
      malformedRows += collected.malformedRows;
      if (part.errorCode !== 'result_limit_reached') return;

      const children = range === 'A-M'
        ? [
          { pattern: '["name"~"^[A-F]",i]', range: 'A-F' },
          { pattern: '["name"~"^[G-M]",i]', range: 'G-M' },
        ]
        : range === 'N-Z'
          ? [
            { pattern: '["name"~"^[N-S]",i]', range: 'N-S' },
            { pattern: '["name"~"^[T-Z]",i]', range: 'T-Z' },
          ]
          : !range
            ? [
              { pattern: '["name"~"^[A-M]",i]', range: 'A-M' },
              { pattern: '["name"~"^[N-Z]",i]', range: 'N-Z' },
              { pattern: '["name"!~"^[A-Z]",i]', range: 'other' },
            ]
            : [];
      if (!children.length) {
        partitionCapped = true;
        return;
      }
      for (const child of children) await readPartition(filters, child.pattern, child.range);
    };
    for (const filters of partitions) {
      await readPartition(filters);
    }
    const incomplete = partitionFailed || partitionCapped || malformedRows > 0;
    return {
      businesses,
      outcome: incomplete ? (businesses.length ? 'partial' : partitionFailed ? 'unavailable' : 'malformed') : 'complete',
      errorCode: partitionFailed ? 'partition_unavailable' : partitionCapped ? 'partition_result_limit_reached' : malformedRows ? 'malformed_records' : null,
    };
  }

  const limitReached = initial.errorCode === 'result_limit_reached';
  const outcome = limitReached || (malformedRows > 0 && businesses.length > 0)
    ? 'partial'
    : malformedRows > 0 ? 'malformed' : 'complete';
  return {
    businesses,
    outcome,
    errorCode: limitReached ? 'result_limit_reached' : malformedRows ? 'malformed_records' : null,
  };
}
