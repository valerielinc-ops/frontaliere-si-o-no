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
