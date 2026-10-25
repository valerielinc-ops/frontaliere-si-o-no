/**
 * Boundary for live job discovery: a URL-set sitemap's canonical `<loc>`
 * entries are the probe candidates; hreflang alternates are metadata for
 * their page, not additional jobs to request.
 *
 * Keep this selection outside the generic sitemap crawler so every live-gate
 * caller makes the same primary-vs-alternate choice without changing the
 * crawler's union used by IndexNow and snapshot consumers.
 */
import { parseSitemapXml } from './sitemap-crawl.mjs';

export function parsePrimarySitemapUrls(xml, options = {}) {
  return parseSitemapXml(xml, options).primaryUrls;
}
