/**
 * What the site already crawls — the loop's definition of "we have this".
 *
 * Without this the prospector would spend its whole budget rediscovering the
 * 584 employers we already read. Coverage is answered from the repo itself
 * rather than from a hand-kept list, so it can never drift from reality:
 *
 *   1. runner filenames  `scripts/update-<key>-jobs.mjs`  -> the crawler keys
 *   2. `data/crawler-companies-auto.json`                 -> names + domains
 *   3. per-crawler slices, when materialised                -> names as crawled
 *
 * Matching is name-normalised (legal forms and country suffixes stripped) plus
 * domain-exact, because "Artisa Group SA" and "artisa-group" and
 * `artisagroup.com` are one employer and any of the three may be what a
 * discovery source hands us.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { registrableDomain, sameOrg } from './registrable.mjs';

/** Legal forms and geography that carry no identity. */
const NOISE_RX =
  /\b(s\.?a\.?r\.?l\.?|s\.?à\.?r\.?l\.?|sagl|s\.?a\.?g\.?l\.?|s\.?a\.?|a\.?g\.?|gmbh|s\.?r\.?l\.?|s\.?p\.?a\.?|ltd|limited|inc|llc|holding|group|gruppo|groupe|co|cie|société|societa|società|schweiz|suisse|svizzera|switzerland|swiss|ticino|succursale|filiale|di)\b/g;

/**
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompanyName(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NOISE_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {Object} CoverageIndex
 * @property {Set<string>} keys          crawler keys (`artisa-group`)
 * @property {Set<string>} names         normalised company names
 * @property {Set<string>} domains       registrable domains
 * @property {number} crawlerCount
 */

/**
 * @param {string} [root]
 * @returns {CoverageIndex}
 */
export function loadCoverage(root = ROOT) {
  const keys = new Set();
  const names = new Set();
  const domains = new Set();

  try {
    for (const f of fs.readdirSync(path.join(root, 'scripts'))) {
      const m = /^update-(.+)-jobs\.mjs$/.exec(f);
      if (m) keys.add(m[1]);
    }
  } catch { /* scripts/ always exists in-repo; tolerate a bare fixture root */ }

  const autoPath = path.join(root, 'data', 'crawler-companies-auto.json');
  try {
    const list = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
    for (const c of Array.isArray(list) ? list : []) {
      if (c.key) keys.add(String(c.key));
      if (c.name) names.add(normalizeCompanyName(c.name));
      if (c.website) domains.add(registrableDomain(c.website));
      if (c.companyDomain) domains.add(registrableDomain(c.companyDomain));
    }
  } catch { /* not materialised in a sparse checkout — keys still cover us */ }

  // Crawler keys are themselves a name signal (`artisa-group` -> `artisa`).
  for (const k of keys) names.add(normalizeCompanyName(k.replace(/-/g, ' ')));

  return { keys, names, domains, crawlerCount: keys.size };
}

/**
 * Do we already crawl this employer?
 *
 * @param {CoverageIndex} coverage
 * @param {{ name?: string, domain?: string, key?: string }} candidate
 * @returns {{ covered: boolean, via: string|null }}
 */
export function isCovered(coverage, candidate) {
  const key = candidate.key && String(candidate.key).toLowerCase();
  if (key && coverage.keys.has(key)) return { covered: true, via: 'key' };

  const domain = candidate.domain ? registrableDomain(candidate.domain) : '';
  if (domain) {
    if (coverage.domains.has(domain)) return { covered: true, via: 'domain' };
    for (const d of coverage.domains) if (d && sameOrg(d, domain)) return { covered: true, via: 'domain-brand' };
  }

  // Slugified raw name against the crawler keys, BEFORE noise-stripping.
  // `AXA Svizzera` normalises down to `axa` (3 chars), which is too short to
  // match safely by name — but `axa-svizzera` matches the runner key exactly.
  const slug = String(candidate.name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug && coverage.keys.has(slug)) return { covered: true, via: 'key-slug' };

  const name = normalizeCompanyName(candidate.name || '');
  if (name && name.length >= 3) {
    if (coverage.names.has(name)) return { covered: true, via: 'name' };
    // Containment, but only for names long enough that it means something —
    // "aet" inside "caseificio aet" would otherwise swallow unrelated employers.
    for (const n of coverage.names) {
      if (!n || n.length < 6) continue;
      if (n === name || (name.length >= 6 && (n.startsWith(`${name} `) || name.startsWith(`${n} `)))) {
        return { covered: true, via: 'name-prefix' };
      }
    }
  }
  return { covered: false, via: null };
}
