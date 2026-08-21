/**
 * The platform registry — the loop's memory, and the reason it compounds.
 *
 * A "platform" is a hosted ATS / careers-site vendor: one registrable domain
 * serving many employers, each on its own subdomain or path. Learning ONE
 * platform is worth more than learning one employer by exactly the number of
 * tenants it has, because a single family parser then reads all of them.
 *
 * Lifecycle of an entry:
 *
 *   candidate  — seen once, as the careers outlink of a single employer.
 *                Not actionable: could just be that employer's second domain.
 *   confirmed  — seen for >= PLATFORM_CONFIRM_THRESHOLD unrelated employers.
 *                Tenant enumeration is now allowed to run against it.
 *   supported  — a family extractor exists, so new tenants cost ~0 to onboard.
 *   rejected   — measured and dismissed (aggregator, CMS, false cluster).
 *
 * Nothing here is hand-seeded with a vendor list. Entries arrive from
 * measurement — outlink clustering and apply-URL clustering — so the registry
 * reflects the market the loop actually observes, including vendors nobody
 * would have thought to type in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORMS_PATH, PLATFORM_CONFIRM_THRESHOLD, NON_PLATFORM_HOSTS } from './config.mjs';
import { registrableDomain, normalizeHost, sameOrg } from './registrable.mjs';

/** @typedef {'candidate'|'confirmed'|'supported'|'rejected'} PlatformStatus */

/**
 * @typedef {Object} Platform
 * @property {string} domain            registrable domain of the vendor
 * @property {PlatformStatus} status
 * @property {string} [family]          extractor family key once supported
 * @property {string[]} seenOn          registrable domains of employers pointing here
 * @property {string[]} markers         HTML fingerprints observed on tenant pages
 * @property {string[]} hostSamples     example tenant hosts
 * @property {'subdomain'|'shared'|'mixed'|'unknown'} tenantShape
 * @property {Record<string, number>} hostHits  full host -> employers seen on it
 * @property {Record<string, number>} pathHits     first DETAIL url segment -> times seen
 * @property {string[]} listingPaths                 listing paths learned from our own adapters
 * @property {number} tenantCount
 * @property {string} discoveredAt
 * @property {string} [note]
 */

const EMPTY = { version: 1, updatedAt: null, platforms: {} };

/**
 * @param {string} [file]
 * @returns {{ version: number, updatedAt: string|null, platforms: Record<string, Platform> }}
 */
export function loadRegistry(file = PLATFORMS_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.platforms) return structuredClone(EMPTY);
    return raw;
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {string} [file]
 */
export function saveRegistry(registry, file = PLATFORMS_PATH) {
  registry.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Is this host even eligible to be a platform?
 *
 * Rejects the social/CDN/aggregator denylist and bare registrable domains with
 * no subdomain AND no path — a link to `https://example.com/` carries no
 * tenant signal at all.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isPlatformEligible(host) {
  const h = normalizeHost(host);
  if (!h || !h.includes('.')) return false;
  const reg = registrableDomain(h);
  if (NON_PLATFORM_HOSTS.has(reg) || NON_PLATFORM_HOSTS.has(h)) return false;
  // Anything under a government or academic suffix is an institution, not a vendor.
  if (/\.(admin|gov)\.[a-z]{2}$/.test(reg) || reg.endsWith('.admin.ch')) return false;
  return true;
}

/**
 * Record that `employerDomain` publishes its vacancies on `tenantHost`.
 * Promotes candidate -> confirmed once enough UNRELATED employers agree.
 *
 * The "unrelated" test is what keeps a corporate group from confirming itself:
 * `acme.ch` and `acme-group.com` pointing at `jobs.acme.com` is one employer,
 * not two, and `sameOrg` collapses them.
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {{ tenantHost: string, employerDomain: string, markers?: string[], note?: string, path?: string }} obs
 * @returns {{ platform: Platform|null, promoted: boolean, created: boolean }}
 */
export function observePlatform(registry, { tenantHost, employerDomain, markers = [], note, path }) {
  const host = normalizeHost(tenantHost);
  if (!isPlatformEligible(host)) return { platform: null, promoted: false, created: false };
  const domain = registrableDomain(host);
  const employer = registrableDomain(employerDomain || '');
  // The employer's own domain is never a platform, however many subdomains it has.
  if (employer && sameOrg(domain, employer)) return { platform: null, promoted: false, created: false };

  let created = false;
  let p = registry.platforms[domain];
  if (!p) {
    created = true;
    p = registry.platforms[domain] = {
      domain,
      status: 'candidate',
      seenOn: [],
      markers: [],
      hostSamples: [],
      tenantShape: 'unknown',
      hostHits: {},
      pathHits: {},
      tenantCount: 0,
      discoveredAt: new Date().toISOString(),
    };
  }
  if (note) p.note = note;

  if (employer && !p.seenOn.some((d) => sameOrg(d, employer))) p.seenOn.push(employer);
  if (!p.hostSamples.includes(host)) p.hostSamples = [...p.hostSamples, host].slice(0, 25);
  for (const m of markers) if (m && !p.markers.includes(m)) p.markers.push(m);

  // Classify the vendor by WHERE the tenant id sits, because the two shapes
  // need completely different expansion strategies:
  //
  //   subdomain — each employer gets its own host
  //               (`recruitingapp-122706.umantis.com`, `vaudoise.softgarden.io`).
  //               Expandable by enumerating hosts: certificate logs, the web
  //               index, or probing employer names as tenant ids.
  //   shared    — every employer sits on ONE host and the tenant id lives in the
  //               path or query (`apply.refline.ch`, `jobs.dualoo.com`,
  //               `sozialinfo.ch`). Host enumeration is meaningless here; the
  //               way in is to crawl that single host's own index, which is
  //               cheaper still — one crawler picks up every employer on it.
  //
  // Decided by counting DISTINCT hosts against distinct employers, not by
  // whether a subdomain exists: `apply.refline.ch` has a subdomain and is
  // nonetheless a single shared host, which an is-there-a-dot test gets wrong.
  p.hostHits = p.hostHits || {};
  p.hostHits[host] = (p.hostHits[host] || 0) + 1;

  // Learn WHERE on the host the vacancies sit. Probing a tenant's bare root is
  // not enough: an Umantis tenant root serves a login form and the listing
  // lives at /Vacancies, so a root-only probe scored 0 live tenants out of 135
  // candidate hosts (measured). The first URL segment of vacancies we already
  // crawl gives that path for free.
  //
  // It also reveals the other tenant shape: on shared hosts the first segment
  // IS the tenant (`live.solique.ch/ottosag`, `apply.refline.ch/424626`), which
  // is what makes those vendors enumerable at all.
  if (path) {
    const seg = `/${String(path).split('/').filter(Boolean)[0] || ''}`;
    if (seg.length > 1) {
      p.pathHits = p.pathHits || {};
      p.pathHits[seg] = (p.pathHits[seg] || 0) + 1;
    }
  }
  const hostCount = Object.keys(p.hostHits).length;
  const employerCount = Math.max(p.seenOn.length, 1);
  if (employerCount >= 2) {
    if (hostCount === 1) p.tenantShape = 'shared';
    else if (hostCount >= employerCount * 0.6) p.tenantShape = 'subdomain';
    else p.tenantShape = 'mixed';
  }


  const promoted = p.status === 'candidate' && p.seenOn.length >= PLATFORM_CONFIRM_THRESHOLD;
  if (promoted) p.status = 'confirmed';
  return { platform: p, promoted, created };
}

/**
 * Listing paths worth probing on this platform's tenants, commonest first.
 *
 * A path seen for MANY employers is a fixed part of the vendor's URL scheme
 * (`/Vacancies`); one seen for a single employer is that employer's own tenant
 * id and must not be probed against everyone else.
 *
 * @param {Platform} platform
 * @returns {string[]}
 */
export function listingPathHints(platform) {
  // Listing paths learned from our own adapters outrank anything inferred from
  // detail URLs: they are the page a crawler actually starts from.
  const learned = platform?.listingPaths || [];
  const hits = Object.entries(platform?.pathHits || {});
  if (!hits.length) return learned.slice(0, 3);
  const shared = hits.filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const distinct = hits.length;
  // Nearly every path distinct => the segment is the tenant id, not a fixed
  // listing path. Nothing generalisable to probe.
  if (shared.length === 0 || distinct > shared.length * 3) return learned.slice(0, 3);
  return [...new Set([...learned, ...shared.map(([seg]) => seg)])].slice(0, 4);
}

/**
 * True when the first URL segment is the TENANT id rather than a fixed path —
 * the signature of a shared-host vendor, and what makes one enumerable by
 * probing employer-name slugs against a single host.
 *
 * @param {Platform} platform
 * @returns {boolean}
 */
export function tenantIsInPath(platform) {
  const hits = Object.entries(platform?.pathHits || {});
  if (hits.length < 2) return false;
  return platform.tenantShape === 'shared' && listingPathHints(platform).length === 0;
}

/**
 * The platform an arbitrary host belongs to, if the registry knows it.
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @param {string} host
 * @returns {Platform|null}
 */
export function matchPlatform(registry, host) {
  const domain = registrableDomain(host);
  const p = registry.platforms[domain];
  return p && p.status !== 'rejected' ? p : null;
}

/**
 * Platforms worth spending enumeration budget on, best first.
 *
 * Ranked by employers-seen then tenants-known: a vendor five employers already
 * use is likelier to have a deep tenant list than one seen twice.
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @returns {Platform[]}
 */
export function enumerablePlatforms(registry) {
  return Object.values(registry.platforms)
    .filter((p) => p.status === 'confirmed' || p.status === 'supported')
    // A shared host has no tenants to enumerate — it is crawled as one source.
    .filter((p) => p.tenantShape === 'subdomain' || p.tenantShape === 'mixed' || p.tenantShape === 'unknown')
    .sort((a, b) => (b.seenOn.length - a.seenOn.length) || (b.tenantCount - a.tenantCount));
}

/**
 * Shared-host vendors and niche boards: one crawler each, many employers apiece.
 * Ranked by employers seen, which is the number of employers that ONE crawler
 * would add — the best return per unit of work anywhere in the loop.
 *
 * @param {ReturnType<typeof loadRegistry>} registry
 * @returns {Platform[]}
 */
export function sharedHostPlatforms(registry) {
  return Object.values(registry.platforms)
    .filter((p) => (p.status === 'confirmed' || p.status === 'supported') && (p.tenantShape === 'shared' || p.tenantShape === 'mixed'))
    .sort((a, b) => b.seenOn.length - a.seenOn.length);
}
