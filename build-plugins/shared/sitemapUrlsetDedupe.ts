/**
 * Dedupe repeated `<url>` blocks WITHIN a single string-assembled `<urlset>`
 * XML document, keyed on `<loc>` (keep-first). (#3516)
 *
 * String-concatenation sitemap emitters (legacy `sitemap-jobs.xml` in
 * `jobsSeoPagesPlugin`, `sitemap-eventi.xml` in `eventsSeoPagesPlugin`) build
 * their document from independently-generated `<url>` block segments; two
 * segments (or two records inside one segment — e.g. the BS/BL half-canton
 * merge both resolving to `/eventi/basilea/`) can emit the same `<loc>`.
 * A repeated `<loc>` within one file is always noise — Google dedupes on
 * ingest, but it bloats the file and trips sitemap audits.
 *
 * NOTE: this is per-document by construction. The intentional cross-canton
 * dual-emit (same URL across *different* shard files) is not affected.
 *
 * Object-entry shard emissions are deduped separately inside
 * `scripts/lib/sitemap-shard.mjs` `emitSitemapXml` (same keep-first policy).
 */
export function dedupeUrlsetXmlByLoc(xml: string): string {
  const seen = new Set<string>();
  return xml.replace(/[ \t]*<url\b[\s\S]*?<\/url>\n?/g, (block) => {
    const m = block.match(/<loc>([\s\S]*?)<\/loc>/);
    const loc = m ? m[1].trim() : '';
    if (!loc) return block;
    if (seen.has(loc)) return '';
    seen.add(loc);
    return block;
  });
}

const SEEDED_PAGES_SITEMAP = 'sitemap-pages.xml';
/**
 * Excluded as an owner: Google News discovers `sitemap-news.xml` on its own, so
 * an article listed there and in its blog sitemap is the protocol working, not
 * a duplicate (see tests/sitemap-news-canonical.test.ts).
 */
const NOT_A_PAGE_OWNER = /^sitemap(?:_news|-news|-index)?\.xml$/;

/**
 * Let the seeded `sitemap-pages.xml` yield to the family that owns a URL.
 *
 * GEO audit 2026-10-31: 10 URLs (`/calcola-stipendio/stipendio-netto-*`, the job
 * and FAQ hubs) sat in both files. The family entry is the one built from the
 * pages it emits, so it stays. A real `<lastmod>` of the seed moves onto it
 * rather than being lost with the dropped copy.
 *
 * Pure: takes every dist sitemap, returns only the documents it changed.
 */
export function pruneSeededPagesAlreadyListed(
  files: readonly { readonly file: string; readonly xml: string }[],
): Map<string, string> {
  const seeded = files.find(({ file }) => file === SEEDED_PAGES_SITEMAP);
  if (!seeded) return new Map();

  const seededDayByLoc = new Map<string, string | undefined>();
  for (const match of seeded.xml.matchAll(/<url\b[\s\S]*?<\/url>/g)) {
    const loc = match[0].match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (loc) seededDayByLoc.set(loc, match[0].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1]);
  }

  const out = new Map<string, string>();
  const yielded = new Set<string>();
  for (const { file, xml } of files) {
    if (file === SEEDED_PAGES_SITEMAP || NOT_A_PAGE_OWNER.test(file)) continue;
    const next = xml.replace(/([ \t]*)<url\b[\s\S]*?<\/url>/g, (block, indent: string) => {
      const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
      if (!loc || !seededDayByLoc.has(loc)) return block;
      yielded.add(loc);
      const day = seededDayByLoc.get(loc);
      if (!day || block.includes('<lastmod>')) return block;
      return block.replace(/([ \t]*)<\/url>$/, `${indent}  <lastmod>${day}</lastmod>\n${indent}</url>`);
    });
    if (next !== xml) out.set(file, next);
  }
  if (yielded.size === 0) return out;

  out.set(
    SEEDED_PAGES_SITEMAP,
    seeded.xml.replace(/[ \t]*<url\b[\s\S]*?<\/url>\n?/g, (block) => {
      const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
      return loc && yielded.has(loc) ? '' : block;
    }),
  );
  return out;
}
