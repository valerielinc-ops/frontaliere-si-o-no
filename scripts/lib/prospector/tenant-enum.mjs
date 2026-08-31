/**
 * Tenant enumeration — where the loop stops being linear.
 *
 * Discovering one employer buys one employer. Discovering the PLATFORM that
 * employer rents its careers page from, and then enumerating that platform's
 * tenants, buys every employer on it — and they are overwhelmingly the small
 * ones, because a 12-person haulier never builds a careers page but will happily
 * pay a vendor CHF 40/month for one.
 *
 * Three enumerators, complementary because each fails differently:
 *
 *   commoncrawl — the public web index. Broad and free, but a tiny tenant that
 *                 nobody links to may never have been crawled.
 *   certspotter — Certificate Transparency. Complete for per-tenant certs, and
 *                 USELESS against a wildcard cert: Some vendors serve every tenant
 *                 under a single `*.vendor.example` wildcard, so CT shows infrastructure hosts
 *                 and no customers at all (measured). Kept because plenty of
 *                 vendors do issue per-tenant certs, where it is exhaustive.
 *   slugprobe   — take the employer names we already hold and test them AS
 *                 tenant ids. Cheap, and the only one that reaches an employer
 *                 nobody has ever linked to or indexed.
 *
 * The wildcard-DNS trap, measured and guarded here: `does-not-exist-123.vendor.example`
 * RESOLVES. DNS existence proves nothing on these platforms, so a tenant only
 * counts once an HTTP fetch returns a page that scores as a vacancy page.
 */
import { politeFetch, mapPool } from './polite-fetch.mjs';
import { normalizeHost, registrableDomain, tenantLabel } from './registrable.mjs';
import { listingPathHints, tenantIsInPath } from './platform-registry.mjs';
import { scoreVacancyPage } from './extract.mjs';
import { extractLinks, isCareerLink } from './careers-trail.mjs';
import { CONCURRENCY } from './config.mjs';
import { decodeEntities } from './entities.mjs';
import { readAttr, readMetaContent } from '../html-attr.mjs';

/**
 * Query the Common Crawl URL index for every host under a platform domain.
 *
 * @param {string} platformDomain
 * @param {{ collections?: string[], limit?: number }} [opts]
 * @returns {Promise<string[]>} tenant hosts
 */
export async function enumerateViaCommonCrawl(platformDomain, opts = {}) {
  const limit = opts.limit ?? 800;
  let collections = opts.collections;
  if (!collections) {
    const idx = await politeFetch('https://index.commoncrawl.org/collinfo.json', { accept: 'application/json', ignoreRobots: true, retries: 3 });
    try {
      const all = JSON.parse(idx.body);
      collections = all.slice(0, 3).map((c) => c.id);
    } catch { collections = []; }
  }
  const hosts = new Set();
  for (const coll of collections) {
    const res = await politeFetch(
      `https://index.commoncrawl.org/${coll}-index?url=*.${encodeURIComponent(platformDomain)}&output=json&limit=${limit}`,
      { accept: 'application/json', timeoutMs: 120000, ignoreRobots: true, retries: 3 },
    );
    if (!res.ok) continue;
    for (const line of res.body.split('\n')) {
      if (!line.trim() || line.startsWith('<')) continue;
      try {
        const rec = JSON.parse(line);
        const h = normalizeHost(new URL(rec.url).hostname);
        if (h && registrableDomain(h) === platformDomain && h !== platformDomain) hosts.add(h);
      } catch { /* index rows are occasionally truncated */ }
    }
  }
  return [...hosts];
}

/**
 * Query Certificate Transparency for subdomains of a platform.
 *
 * @param {string} platformDomain
 * @returns {Promise<string[]>}
 */
export async function enumerateViaCertSpotter(platformDomain) {
  const res = await politeFetch(
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(platformDomain)}&include_subdomains=true&expand=dns_names`,
    { accept: 'application/json', ignoreRobots: true, retries: 2 },
  );
  if (!res.ok) return [];
  let rows;
  try { rows = JSON.parse(res.body); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const hosts = new Set();
  for (const r of rows) {
    for (const n of r.dns_names || []) {
      const h = normalizeHost(n);
      if (h.includes('*')) continue;
      if (registrableDomain(h) === platformDomain && h !== platformDomain) hosts.add(h);
    }
  }
  return [...hosts];
}

/** Infrastructure subdomains every vendor has and no employer is. */
const INFRA_LABELS = /^(www|dev|test|staging|stage|preprod|next|main|portal|api|app|admin|cdn|static|assets|mail|webmail|smtp|imap|ftp|vpn|git|ci|build|docs|blog|help|support|status|monitor|grafana|sso|auth|login|demo|sandbox|tfs\d*|ns\d*|mx\d*|autodiscover|sites|home|devops)$/i;

/**
 * Turn an employer name into the tenant ids a vendor would have handed it.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function tenantSlugCandidates(name = '') {
  const words = String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(sa|ag|sagl|gmbh|srl|sarl|spa|ltd|inc|llc|di|e|the|group|gruppo|holding|swiss|suisse|svizzera|schweiz|ch)$/.test(w));
  if (!words.length) return [];
  const out = new Set([
    words.join(''),
    words.join('-'),
    words[0],
  ]);
  if (words.length > 2) out.add(words.slice(0, 2).join(''));
  return [...out].filter((s) => s.length >= 3 && s.length <= 40);
}

/**
 * Do this vendor's tenant ids look derived from employer names?
 *
 * @param {{ hostHits?: Record<string, number>, hostSamples?: string[], domain: string }} platform
 * @returns {boolean}
 */
export function tenantIdsAreNameLike(platform) {
  const hosts = [...new Set([...Object.keys(platform.hostHits || {}), ...(platform.hostSamples || [])])];
  const labels = hosts.map((h) => tenantLabel(h)).filter((l) => l && !INFRA_LABELS.test(l));
  if (!labels.length) return true; // nothing observed yet — let the prober try
  const nameLike = labels.filter((l) => /^[a-z][a-z-]{2,}$/.test(l) && !/^\d/.test(l));
  return nameLike.length / labels.length >= 0.5;
}

/**
 * Confirm a URL really is a live tenant listing with vacancies.
 *
 * Probes the root AND any listing paths the registry has learned for this
 * vendor, keeping the best-scoring answer. Root-only probing was measured at
 * 0 live tenants from 135 Umantis candidate hosts, because an Umantis tenant
 * root serves a login form and the vacancies live at /Vacancies.
 *
 * @param {string} host
 * @param {{ minScore?: number, paths?: string[] }} [opts]
 * @returns {Promise<{ host: string, live: boolean, score: number, vacancyCount: number, company: string, url: string, signals: string[] }>}
 */
export async function probeTenant(host, opts = {}) {
  const minScore = opts.minScore ?? 3;
  const blank = { host, live: false, score: 0, vacancyCount: 0, company: '', url: `https://${host}/`, signals: [] };
  const bases = host.includes('/') ? [`https://${host}`] : [`https://${host}/`];
  const urls = [...bases];
  for (const p of opts.paths || []) urls.push(`https://${host.replace(/\/$/, '')}${p}`);

  let res = null;
  let scored = null;
  let links = [];
  const consider = (r, l, sc) => {
    if (!scored || sc.score > scored.score) { res = r; scored = sc; links = l; }
  };
  for (const u of urls.slice(0, 4)) {
    const r = await politeFetch(u);
    if (!r.ok || r.body.length < 300) continue;
    const l = extractLinks(r.body, r.url);
    consider(r, l, scoreVacancyPage(r.body, r.url, l));
    if (scored.score >= minScore + 2) break; // decisive, stop paying
  }

  // One hop, exactly as on an employer site. The learned path hint comes from
  // vacancy DETAIL urls (`/Vacancies/1234/Description/1`), which is not where
  // the listing lives (`/Jobs/All`) — and no amount of per-vendor path guessing
  // generalises. What does generalise: whatever page we landed on links to the
  // listing, so follow the most vacancy-looking internal link and score that.
  if (res && scored && scored.score < minScore) {
    const self = normalizeHost(new URL(res.url).hostname);
    const hop = links
      .filter((l) => normalizeHost(l.host) === self && isCareerLink(l) && l.url !== res.url)
      .slice(0, 3);
    for (const l of hop) {
      const r = await politeFetch(l.url);
      if (!r.ok || r.body.length < 300) continue;
      const ll = extractLinks(r.body, r.url);
      consider(r, ll, scoreVacancyPage(r.body, r.url, ll));
      if (scored.score >= minScore) break;
    }
  }
  if (!res || !scored) return blank;
  // The <title> of a tenant page is nearly always the employer's own name —
  // "Cippà Trasporti S.A. | Lavora con noi" — so the platform hands us the
  // company identity for free, no name resolution needed.
  const company = employerNameFromPage(res.body, host, links);
  const surface = looksLikeAggregator(scored.vacancies, host);
  return {
    host,
    // An aggregator is live and full of vacancies and still not what the loop
    // is for, so it is excluded here rather than downstream — a tenant that
    // turns out to be a board must never be filed as an employer.
    live: scored.score >= minScore && !surface.aggregator,
    aggregator: surface.aggregator,
    distinctCompanies: surface.distinctCompanies,
    score: scored.score,
    vacancyCount: scored.vacancies.length,
    company,
    url: res.url,
    signals: scored.signals,
  };
}

/**
 * Is this surface an aggregator rather than one employer's own vacancy page?
 *
 * The loop's value is employers who hire DIRECTLY: their vacancies exist
 * nowhere else, which is the entire reason to crawl them. An aggregator — a
 * sector job board, an apprenticeship portal, a hospitality exchange — carries
 * many employers' ads, is already indexed by everyone, and adds duplicate
 * inventory rather than new inventory.
 *
 * Told apart structurally, not by a denylist of names, because the denylist
 * would need a new entry for every board that exists: a direct employer's page
 * names ONE hiring organisation, an aggregator names many. Two independent
 * readings of that, so a page with no structured data is still classifiable:
 *   - distinct `hiringOrganization` values in the extracted vacancies;
 *   - distinct third-party hosts the vacancy links point at (a board sends you
 *     off to each employer's own site).
 *
 * @param {{ company?: string, url?: string }[]} vacancies
 * @param {string} selfHost
 * @returns {{ aggregator: boolean, distinctCompanies: number, distinctHosts: number }}
 */
export function looksLikeAggregator(vacancies = [], selfHost = '') {
  const companies = new Set(
    vacancies.map((v) => String(v.company || '').trim().toLowerCase()).filter(Boolean),
  );
  const hosts = new Set();
  for (const v of vacancies) {
    try {
      const h = registrableDomain(new URL(v.url).hostname);
      if (h && h !== registrableDomain(selfHost)) hosts.add(h);
    } catch { /* relative or malformed */ }
  }
  return {
    aggregator: companies.size >= 2 || hosts.size >= 3,
    distinctCompanies: companies.size,
    distinctHosts: hosts.size,
  };
}

/** Page-furniture words that are never an employer's name. */
const GENERIC_TITLE_RX = /^(jobs?|karriere|offene stellen|stellen|stellenangebote|login|initiativbewerbung|bewerbung|carriere|carriera|lavora con noi|emplois|careers?|vacancies|home|willkommen|portal|bewerberportal|e-?recruiting|bewerbermanagement|rekrutierungstool|jobportal|jobboard)$/i;

/** Prefixes/suffixes vendors bolt onto a tenant title around the real name. */
const TITLE_FURNITURE_RX =
  /\b(bewerberportal|bewerbermanagement|rekrutierungstool|bewerbungsplattform|e-?recruiting|jobportal|job ?board|stellenportal|offene stellen|stellenangebote|stellen|jobs?|karriere|carriere|carriera|vacancies|lavora con noi|arbeiten (?:bei|im|in)|willkommen bei)\b/gi;

/**
 * The employer's name, as read off a tenant page.
 *
 * A hosted ATS puts the tenant's own name in the <title>, which is why tenant
 * enumeration needs no name resolution at all — but it wraps it in vendor
 * furniture ("Bewerberportal MPI AGE Stellen") and sometimes replaces it
 * entirely with a generic label ("Jobs", "Offene Stellen"). So: strip the
 * furniture, and when nothing identifying survives, fall back through
 * og:site_name, the logo's alt text, and finally the tenant id — which is at
 * least stable and unique, where "Jobs" is neither.
 *
 * @param {string} html
 * @param {string} host
 * @param {{ url: string, text: string }[]} [links]
 * @returns {string}
 */
export function employerNameFromPage(html = '', host = '', links = []) {
  // Decode rather than strip: `Soci&egrave;t&eacute; X` must come back as
  // `Sociètè X`, not `Soci t  X` — the mangled form fails every
  // later name match against coverage and against the employer's own site.
  const clean = (raw) => decodeEntities(String(raw || ''))
    .split(/[|–—·»]|\s-\s/)[0]
    .replace(/\s+/g, ' ')
    .trim();

  const candidates = [];
  const title = clean(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1]);
  if (title) candidates.push(title);
  const ogSite = clean(readMetaContent(html, 'og:site_name'));
  if (ogSite) candidates.push(ogSite);
  // Quote-balanced (#6480): a company name with an apostrophe — `Casa d'Anziani`,
  // `L'Oréal` — was truncated at the apostrophe by the old `[^"']+` class.
  const logoImg = [...String(html || '').matchAll(/<img\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((tag) => /logo/i.test(readAttr(tag, 'class')) || /logo/i.test(readAttr(tag, 'id')));
  const logoAlt = clean(logoImg ? readAttr(logoImg, 'alt') : '');
  if (logoAlt) candidates.push(logoAlt);

  for (const raw of candidates) {
    const stripped = raw.replace(TITLE_FURNITURE_RX, ' ').replace(/\s+/g, ' ').trim();
    if (stripped.length >= 3 && !GENERIC_TITLE_RX.test(stripped)) return stripped.slice(0, 120);
  }
  for (const raw of candidates) {
    if (raw.length >= 3 && !GENERIC_TITLE_RX.test(raw)) return raw.slice(0, 120);
  }
  void links;
  return tenantLabel(host) || host;
}

/**
 * Full enumeration for one platform.
 *
 * @param {import('./platform-registry.mjs').Platform} platform
 * @param {{ nameSeeds?: string[], maxProbe?: number, useCommonCrawl?: boolean, useCertSpotter?: boolean }} [opts]
 * @returns {Promise<{ platform: string, discovered: string[], probed: any[], live: any[], byMethod: Record<string, number> }>}
 */
export async function enumerateTenants(platform, opts = {}) {
  const domain = platform.domain;
  const byMethod = {};
  const found = new Map();
  const paths = listingPathHints(platform);
  const pathTenant = tenantIsInPath(platform);

  const add = (host, method) => {
    const h = normalizeHost(host);
    if (!h || h === domain) return;
    const label = tenantLabel(h);
    if (!label || INFRA_LABELS.test(label)) return;
    if (!found.has(h)) found.set(h, method);
    byMethod[method] = (byMethod[method] || 0) + 1;
  };

  // Shared-host vendors put the tenant in the PATH, so there are no hosts to
  // enumerate — the candidate space is `<one host>/<employer slug>`. Skipping
  // this branch would write off every vendor of that shape, which is half the
  // Swiss SME tier (refline, solique).
  const addPathTenant = (base, slug) => {
    const key = `${base}/${slug}`;
    if (!found.has(key)) found.set(key, 'pathprobe');
    byMethod.pathprobe = (byMethod.pathprobe || 0) + 1;
  };

  if (opts.useCommonCrawl !== false) {
    for (const h of await enumerateViaCommonCrawl(domain)) add(h, 'commoncrawl');
  }
  if (opts.useCertSpotter !== false) {
    for (const h of await enumerateViaCertSpotter(domain)) add(h, 'certspotter');
  }
  // Slug probing only makes sense where the vendor derives tenant ids from the
  // employer's NAME. Umantis hands out `recruitingapp-122706`; probing 6'000
  // employer names against an opaque id space would be thousands of requests
  // for a guaranteed zero. Decided from the tenant labels already observed.
  if (opts.nameSeeds?.length) {
    if (pathTenant) {
      const base = Object.entries(platform.hostHits || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
        || platform.hostSamples?.[0] || domain;
      for (const seed of opts.nameSeeds) {
        for (const slug of tenantSlugCandidates(seed)) addPathTenant(base, slug);
      }
    } else if (tenantIdsAreNameLike(platform)) {
      for (const seed of opts.nameSeeds) {
        for (const slug of tenantSlugCandidates(seed)) add(`${slug}.${domain}`, 'slugprobe');
      }
    }
  }
  for (const sample of platform.hostSamples || []) add(sample, 'known');

  // Probe in order of EVIDENCE, not insertion order. A slug probe is a guess
  // and there can be tens of thousands of them (20'215 in one measured run);
  // a host seen in the web index or in a certificate log is a host that exists.
  // Left unordered, the probe budget is spent entirely on guesses and a vendor
  // whose tenants are all already known scores zero.
  const METHOD_RANK = { known: 0, commoncrawl: 1, certspotter: 2, pathprobe: 3, slugprobe: 4 };
  const hosts = [...found.keys()]
    .sort((a, b) => (METHOD_RANK[found.get(a)] ?? 9) - (METHOD_RANK[found.get(b)] ?? 9))
    .slice(0, opts.maxProbe ?? 300);
  const probed = (await mapPool(hosts, CONCURRENCY, (h) => probeTenant(h, { paths }))).filter(Boolean);
  for (const p of probed) p.method = found.get(p.host);
  return {
    platform: domain,
    discovered: hosts,
    probed,
    live: probed.filter((p) => p.live),
    byMethod,
  };
}
