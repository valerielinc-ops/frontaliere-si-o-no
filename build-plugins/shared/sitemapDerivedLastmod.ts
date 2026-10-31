/**
 * `<lastmod>` that a page can prove, derived after every sitemap is on disk.
 *
 * GEO audit 2026-10-31: 78 of 159 sub-sitemaps carried no `<lastmod>`, and the
 * 8,518 entries of `sitemap-jobs.xml` without one are not job postings but the
 * hubs around them (municipality, employer, profession). A hub does have a true
 * date, spread across other files: the newest posting it lists. This pass reads
 * it from the final HTML, so one rule covers the many emitters of those pages
 * and nothing has to be threaded through them.
 *
 * Two sources, both facts already published on the page:
 *  - a job listing page takes the newest `<lastmod>` among the job details it
 *    links to (the date policy of those is in jobSitemapLastmod.ts);
 *  - a page that declares `dateModified` in its JSON-LD repeats that value.
 *
 * Google trusts `<lastmod>` only while it stays accurate, so a page with neither
 * source keeps no tag. The event dataset, for one, has no modification date at
 * all (`crawledAt` is a liveness heartbeat), and the build clock is never a
 * substitute: absent is honest, invented is not.
 */
import { sourceDateIso } from '../../services/dataFreshness';
import { BASE_URL } from '../constants';

interface SitemapDocument {
  readonly file: string;
  readonly xml: string;
}

/** Sitemaps of pages that list job postings. */
const JOB_LISTING_SITEMAP_RX =
  /^sitemap-(?:jobs(?:-[a-z-]+)?|search-clusters-\d+|orphan-landings|professions|profession-cantons|profession-cities|sector|auto-sector-hubs|seo-hubs|recency|employer-profiles|weekly-employers|career-landings|nursing)\.xml$/;

/** Sitemaps of pages that state their own `dateModified` (sampled live 2026-10-31). */
const DECLARED_DATE_SITEMAPS: ReadonlySet<string> = new Set([
  'sitemap-bfs-salary.xml',
  'sitemap-border-wait-map.xml',
  'sitemap-fuel-indexes.xml',
  'sitemap-health-premiums.xml',
  'sitemap-market-report.xml',
  'sitemap-plate-auctions.xml',
]);

/** Files whose dated entries are job details: the expired family is not a listing target. */
const JOB_DETAIL_SITEMAP_RX = /^sitemap-jobs(?:-[a-z-]+)?\.xml$/;
const EXPIRED_JOB_SITEMAP = 'sitemap-jobs-expired.xml';

const URL_BLOCK_RX = /[ \t]*<url>[\s\S]*?<\/url>/g;
const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/;
const LASTMOD_DAY_RX = /<lastmod>\s*(\d{4}-\d{2}-\d{2})/;
const HREF_RX = /href="([^"#?]+)/g;
const DATE_MODIFIED_RX = /"dateModified"\s*:\s*"([^"]+)"/g;

/** `<loc>` to day, for every dated job detail of the job sitemaps. */
export function collectJobDetailDays(files: readonly SitemapDocument[]): Map<string, string> {
  const days = new Map<string, string>();
  for (const { file, xml } of files) {
    if (!JOB_DETAIL_SITEMAP_RX.test(file) || file === EXPIRED_JOB_SITEMAP) continue;
    for (const match of xml.matchAll(URL_BLOCK_RX)) {
      const day = match[0].match(LASTMOD_DAY_RX)?.[1];
      const loc = match[0].match(LOC_RX)?.[1];
      if (day && loc) days.set(loc, day);
    }
  }
  return days;
}

/** Newest job detail linked by a listing page, if it links to any. */
export function newestLinkedJobDay(html: string, jobDays: ReadonlyMap<string, string>): string | undefined {
  let newest: string | undefined;
  for (const match of html.matchAll(HREF_RX)) {
    const href = match[1];
    const day = jobDays.get(href.startsWith('/') ? `${BASE_URL}${href}` : href);
    if (day && (newest === undefined || day > newest)) newest = day;
  }
  return newest;
}

/** Newest valid `dateModified` the page declares. Rejects future or malformed values. */
export function newestDeclaredDay(html: string, now: Date = new Date()): string | undefined {
  let newest: string | undefined;
  for (const match of html.matchAll(DATE_MODIFIED_RX)) {
    const day = sourceDateIso(match[1], now)?.slice(0, 10);
    if (day && (newest === undefined || day > newest)) newest = day;
  }
  return newest;
}

/**
 * Add a `<lastmod>` to the undated entries of the eligible families.
 *
 * `readHtml` answers null for a page this build did not emit (a locale shard
 * holds only its own HTML): the entry then stays undated, which is the correct
 * failure mode. Returns only the documents it changed.
 */
export function deriveSitemapLastmods(
  files: readonly SitemapDocument[],
  readHtml: (loc: string) => string | null,
  now: Date = new Date(),
): Map<string, string> {
  const jobDays = collectJobDetailDays(files);
  const out = new Map<string, string>();
  for (const { file, xml } of files) {
    const isListing = JOB_LISTING_SITEMAP_RX.test(file) && file !== EXPIRED_JOB_SITEMAP;
    const isDeclared = DECLARED_DATE_SITEMAPS.has(file);
    if (!isListing && !isDeclared) continue;
    const next = xml.replace(URL_BLOCK_RX, (block) => {
      if (block.includes('<lastmod>')) return block;
      const loc = block.match(LOC_RX)?.[1];
      const html = loc ? readHtml(loc) : null;
      if (html === null) return block;
      const day = isListing ? newestLinkedJobDay(html, jobDays) : newestDeclaredDay(html, now);
      if (!day) return block;
      return block.replace(/([ \t]*)<\/url>$/, (_, indent: string) => `${indent}  <lastmod>${day}</lastmod>\n${indent}</url>`);
    });
    if (next !== xml) out.set(file, next);
  }
  return out;
}

/** Newest `<lastmod>` of a urlset: the honest date of the sub-sitemap in the index. */
export function newestSitemapDay(xml: string): string | undefined {
  let newest: string | undefined;
  for (const match of xml.matchAll(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/g)) {
    if (newest === undefined || match[1] > newest) newest = match[1];
  }
  return newest;
}
