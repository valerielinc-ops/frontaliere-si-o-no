// scripts/lib/topic-sources/wordpressSearch.mjs
//
// Search-based ingestion via WordPress REST API.
// Catches articles whose editors didn't tag them as `frontalieri` but
// whose title/body contains the keyword. The standard crawl path follows
// RSS feeds + tag pages, missing articles published under generic
// categories like /attualita/.
//
// Each configured WP site exposes /wp-json/wp/v2/posts with a `search`
// query parameter. We query for "frontalier" (stem matches frontaliere /
// frontalieri / frontaliera) and merge the returned posts into the news
// scan pool.
//
// Returns the same shape as extractRssItems in create-article.mjs:
//   { url, headline, date }
// so the merge into scanNewsSources is drop-in.

const WP_SOURCES = [
  { domain: 'comozero.it', host: 'comozero.it' },
  { domain: 'www.malpensa24.it', host: 'malpensa24.it' },
];

const SEARCH_TERM = 'frontalier';
const PER_PAGE = 20;
const MAX_AGE_DAYS = 7;
const TIMEOUT_MS = 12000;

/**
 * Strip HTML tags + decode common entities from rendered title/excerpt.
 */
function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch frontaliere-related posts from one WordPress site.
 * Resilient: catches all errors, returns empty array on failure.
 */
async function fetchOneWpSite({ source, fetchImpl, maxAgeDays }) {
  const url = `https://${source.domain}/wp-json/wp/v2/posts?` +
    `search=${encodeURIComponent(SEARCH_TERM)}&` +
    `per_page=${PER_PAGE}&orderby=date&order=desc&` +
    `_fields=id,link,date,title,excerpt`;

  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'frontaliereticino-bot/1.0 (+https://frontaliereticino.ch)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`  🔌 wp-search ${source.host}: HTTP ${res.status}`);
      return [];
    }
    const posts = await res.json();
    if (!Array.isArray(posts)) {
      console.error(`  🔌 wp-search ${source.host}: response not an array`);
      return [];
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 3600 * 1000;
    const out = [];
    for (const p of posts) {
      const headline = stripHtml(p?.title?.rendered ?? '');
      const link = String(p?.link ?? '').trim();
      const dateStr = p?.date ?? null;
      if (!headline || headline.length < 10 || !link) continue;
      let date = null;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!Number.isNaN(d.getTime())) date = d;
      }
      if (!date) continue;
      if (now - date.getTime() > maxAgeMs) continue;
      out.push({ url: link, headline, date, source: `wp-search:${source.host}` });
    }
    console.error(`  🔌 wp-search ${source.host}: ${out.length} articoli rilevanti`);
    return out;
  } catch (err) {
    console.error(`  🔌 wp-search ${source.host} fallito: ${err.message}`);
    return [];
  }
}

/**
 * Run search-based ingestion across all configured WP sites.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl=fetch]
 * @param {number} [options.maxAgeDays=7]
 * @returns {Promise<Array<{url:string, headline:string, date:Date, source:string}>>}
 */
export async function fetchWordpressSearchHeadlines({
  fetchImpl = fetch,
  maxAgeDays = MAX_AGE_DAYS,
} = {}) {
  const results = await Promise.all(
    WP_SOURCES.map((source) => fetchOneWpSite({ source, fetchImpl, maxAgeDays })),
  );
  return results.flat();
}

// Exported for tests + future expansion.
export { WP_SOURCES, SEARCH_TERM, stripHtml };
