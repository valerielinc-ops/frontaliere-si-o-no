/**
 * Discovery source — our own crawl output, read as a platform census.
 *
 * The cheapest source in the loop: no network at all. We already crawl ~890
 * employers, and every job record carries the URL the vacancy actually lives at
 * plus the employer's own domain. Where those two disagree, the URL's host is a
 * hosted ATS — the employer is publishing on somebody else's infrastructure.
 *
 * Measured over the site's jobs dataset: 34 platforms with two or more
 * unrelated employers on them, including the whole Swiss SME tier that the
 * national boards never expose as a category — umantis (21 employers),
 * refline (11), solique (10), dualoo (6), ostendis (4), jobalino (5) — and the
 * Italian-language vendors Ticino employers favour (intervieweb, ncoreplat).
 *
 * That histogram is worth far more than the employers it came from: each of
 * those vendors has a tenant list, and the tenants are overwhelmingly employers
 * we do NOT crawl. This source is what points stage 3 at them.
 *
 * Reads the per-crawler slices when they are materialised, else the monolithic
 * dataset. In a sparse checkout neither may exist, and the source then yields
 * nothing rather than failing the run — the network sources still carry it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, ROOT } from './../config.mjs';
import { registrableDomain, normalizeHost, sameOrg } from './../registrable.mjs';
import { isPlatformEligible } from './../platform-registry.mjs';
import { listSliceFileNames } from './../../crawler-slice-files.mjs';

/**
 * @param {string} root
 * @returns {any[]}
 */
function readJobs(dataRoot) {
  const sliceDir = path.join(dataRoot, 'jobs', 'by-crawler');
  /** @type {any[]} */
  const jobs = [];
  try {
    for (const f of listSliceFileNames(sliceDir)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(sliceDir, f), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw?.jobs || [];
        jobs.push(...list);
      } catch { /* one unreadable slice must not sink the census */ }
    }
  } catch { /* slices not materialised */ }
  if (jobs.length) return jobs;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot, 'jobs.json'), 'utf8'));
    return Array.isArray(raw) ? raw : raw?.jobs || [];
  } catch {
    return [];
  }
}

/**
 * Listing URLs of the crawlers we already run, grouped by platform.
 *
 * Distinct from the job-URL census above, and necessary because the two answer
 * different questions. A job URL says where a vacancy DETAIL page sits
 * (`/Vacancies/1234/Description/1`); the seed URL of an adapter says where the
 * LISTING sits (`/Jobs/4?CompanyID=...`). Probing a new tenant needs the second
 * — measured: probing Umantis tenants at the detail path returned 0 live
 * tenants out of 135, and the tenant root serves a login form that does not
 * even link to the listing.
 *
 * @param {{ dataRoot?: string }} [opts]
 * @returns {Record<string, string[]>} platform domain -> listing paths, commonest first
 */
export function listingPathsFromAdapters(opts = {}) {
  // Two roots, because the adapters are small and the job datasets are not: a
  // sparse worktree can materialise `jobs-crawler-adapters/` (1,7 MB) while
  // still pointing DATA_ROOT at a full checkout for `jobs.json` (341 MB).
  const roots = [opts.dataRoot, DATA_ROOT, path.join(ROOT, 'data')].filter(Boolean);
  /** @type {Record<string, Record<string, number>>} */
  const byPlatform = {};
  let files = [];
  let dir = '';
  for (const r of roots) {
    const candidate = path.join(r, 'jobs-crawler-adapters', 'adapters');
    try {
      const found = fs.readdirSync(candidate).filter((f) => f.endsWith('.json'));
      if (found.length) { files = found; dir = candidate; break; }
    } catch { /* try the next root */ }
  }
  if (!files.length) return {};
  for (const f of files) {
    let adapter;
    try { adapter = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const seed of adapter?.seedUrls || []) {
      let u;
      try { u = new URL(seed); } catch { continue; }
      const host = normalizeHost(u.hostname);
      const platform = registrableDomain(host);
      // Only the vendor's own scheme generalises; a seed on the employer's own
      // domain says nothing about anyone else.
      if (!platform || platform === registrableDomain(adapter?.companyHost || '')) continue;
      const seg = `/${u.pathname.split('/').filter(Boolean)[0] || ''}`;
      if (seg.length < 2) continue;
      byPlatform[platform] = byPlatform[platform] || {};
      byPlatform[platform][seg] = (byPlatform[platform][seg] || 0) + 1;
    }
  }
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [platform, hits] of Object.entries(byPlatform)) {
    out[platform] = Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([seg]) => seg);
  }
  return out;
}

/**
 * @param {{ dataRoot?: string, minEmployers?: number }} [opts]
 * @returns {{ platforms: { domain: string, employers: string[], employerHosts: [string, string, string][], sampleHosts: string[] }[], jobCount: number, weakHosts: number }}
 */
export function censusFromOwnCrawls(opts = {}) {
  const dataRoot = opts.dataRoot || DATA_ROOT;
  const minEmployers = opts.minEmployers ?? 2;
  const jobs = readJobs(dataRoot);

  /** @type {Map<string, { employers: Set<string>, hosts: Set<string> }>} */
  const byPlatform = new Map();
  for (const j of jobs) {
    const url = j?.url || j?.applyUrl;
    const company = String(j?.company || '').trim();
    if (!url || !company) continue;
    let host;
    try { host = normalizeHost(new URL(url).hostname); } catch { continue; }
    if (!host || !isPlatformEligible(host)) continue;
    const platform = registrableDomain(host);
    const employerDomain = registrableDomain(j?.companyDomain || '');
    // Published on their own infrastructure — not a vendor sighting.
    if (employerDomain && sameOrg(platform, employerDomain)) continue;
    if (!byPlatform.has(platform)) byPlatform.set(platform, { employers: new Map(), hosts: new Set() });
    const entry = byPlatform.get(platform);
    // One host per employer, not a flat host set: the registry decides whether
    // a vendor is a multi-tenant ATS or a shared board from whether DIFFERENT
    // employers sit on different subdomains, which a flat set cannot answer.
    let pathname = '/';
    try { pathname = new URL(url).pathname; } catch { /* keep default */ }
    if (!entry.employers.has(company.toLowerCase())) entry.employers.set(company.toLowerCase(), { host, path: pathname });
    if (entry.hosts.size < 20) entry.hosts.add(host);
  }

  const platforms = [];
  let weakHosts = 0;
  for (const [domain, entry] of byPlatform) {
    if (entry.employers.size < minEmployers) { weakHosts++; continue; }
    platforms.push({
      domain,
      employers: [...entry.employers.keys()],
      employerHosts: [...entry.employers].map(([name, v]) => [name, v.host, v.path]),
      sampleHosts: [...entry.hosts],
    });
  }
  platforms.sort((a, b) => b.employers.length - a.employers.length);
  return { platforms, jobCount: jobs.length, weakHosts };
}
