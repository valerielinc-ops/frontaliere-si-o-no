/**
 * Where the article corpus publishes its API.
 *
 * `nanakokyobashi-rgb/frontaliere-articles` builds `dist/api/` and serves it
 * from GitHub Pages; this site reads `manifest.json`, `articles.json`,
 * `swiss-articles.json`, `slugs.json` and the sitemaps from there. The URL was
 * written out in every reader — two of them today — and a corpus that moves
 * (a new Pages host, a CDN cutover) would have to be found in each. One
 * export, one place to change, `ARTICLES_API_BASE` to point a run somewhere
 * else without editing anything.
 */

export const ARTICLES_API_BASE =
  process.env.ARTICLES_API_BASE ?? 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
