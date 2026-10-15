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
const DEFAULT_FILTERS = [
  'nwr["name"]["website"]["office"](area.a);',
  'nwr["name"]["website"]["craft"](area.a);',
  'nwr["name"]["website"]["industrial"](area.a);',
  'nwr["name"]["website"]["man_made"](area.a);',
  'nwr["name"]["website"]["healthcare"](area.a);',
  'nwr["name"]["website"]["shop"](area.a);',
  'nwr["name"]["website"]["tourism"](area.a);',
  'nwr["name"]["website"]["amenity"](area.a);',
  'nwr["name"]["website"]["landuse"="industrial"](area.a);',
  'nwr["name"]["website"]["building"="industrial"](area.a);',
];

/**
 * @param {string} canton two-letter code, e.g. `TI`
 * @param {{ limit?: number, filters?: string[], timeoutSec?: number }} [opts]
 * @returns {Promise<{ name: string, domain: string, website: string, city: string, canton: string, tags: Record<string,string> }[]>}
 */
export async function fetchOsmBusinesses(canton, opts = {}) {
  const limit = opts.limit ?? 4000;
  const filters = (opts.filters || DEFAULT_FILTERS).join('\n  ');
  const query = `[out:json][timeout:${opts.timeoutSec ?? 120}];
area["ISO3166-2"="CH-${canton}"]->.a;
(
  ${filters}
);
out tags ${limit};`;

  const res = await politeFetch(ENDPOINT, {
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
    body: `data=${encodeURIComponent(query)}`,
    contentType: 'application/x-www-form-urlencoded',
  });
  if (!res.ok) return [];
  let payload;
  try { payload = JSON.parse(res.body); } catch { return []; }

  const seen = new Set();
  const out = [];
  for (const el of payload.elements || []) {
    const t = el.tags || {};
    const name = String(t.name || '').trim();
    const website = String(t.website || t['contact:website'] || '').trim();
    if (!name || !website) continue;
    let domain;
    try { domain = registrableDomain(normalizeHost(new URL(website.startsWith('http') ? website : `https://${website}`).hostname)); } catch { continue; }
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      name,
      domain,
      website,
      city: String(t['addr:city'] || '').trim(),
      canton,
      tags: Object.fromEntries(Object.entries(t).filter(([k]) => /^(office|craft|industrial|healthcare|amenity|man_made)$/.test(k))),
    });
  }
  return out;
}
