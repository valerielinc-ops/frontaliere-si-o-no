/**
 * bing-webmaster.mjs — shared helpers for the Bing Webmaster API (JSON REST,
 * https://ssl.bing.com/webmaster/api.svc/json/*), key-based auth (BING_API_KEY).
 *
 * Extracted 2026-07-17 (issue #4305) so scripts/submit-indexnow.js and
 * scripts/check-bing-status.mjs share ONE implementation of the quota check
 * instead of two copies drifting apart (AGENTS.md sibling-pattern rule).
 *
 * Endpoints confirmed live against frontaliereticino.ch 2026-07-17:
 *   - GetUrlSubmissionQuota: real, returns {DailyQuota, MonthlyQuota}.
 *   - GetFeeds: real — this is Bing's actual "sitemap submission status" API
 *     (Bing calls submitted sitemaps "feeds" in this API surface). Returns
 *     an array of {Url, Type, Status, UrlCount, Submitted, LastCrawled, ...}.
 *     Dates are .NET JSON format "/Date(<ms-epoch>)/".
 *   - GetSitemaps: does NOT exist on this API surface (404) — do not use.
 */

const BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

/**
 * Parse a Bing/.NET JSON date string like "/Date(1784137504000)/" into an
 * ISO 8601 string, or null if absent/unparseable.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function parseBingDate(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  return new Date(Number(match[1])).toISOString();
}

/**
 * Fetch remaining URL Submission API quota for a site.
 * @param {string} apiKey
 * @param {string} siteUrl
 * @returns {Promise<{dailyQuota: number, monthlyQuota: number} | null>}
 */
export async function getBingUrlSubmissionQuota(apiKey, siteUrl) {
  try {
    const endpoint = `${BASE}/GetUrlSubmissionQuota?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const d = data?.d;
    if (!d) return null;
    return {
      dailyQuota: Number(d.DailyQuota ?? NaN),
      monthlyQuota: Number(d.MonthlyQuota ?? NaN),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch submitted sitemap ("feed") status for a site — this is Bing's real
 * sitemap-submission-status endpoint (GetSitemaps does not exist).
 * @param {string} apiKey
 * @param {string} siteUrl
 * @returns {Promise<Array<{url:string,type:string,status:string,urlCount:number,submitted:string|null,lastCrawled:string|null}> | null>}
 */
export async function getBingFeeds(apiKey, siteUrl) {
  try {
    const endpoint = `${BASE}/GetFeeds?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const rows = data?.d;
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({
      url: r.Url,
      type: r.Type,
      status: r.Status,
      urlCount: Number(r.UrlCount ?? 0),
      compressed: !!r.Compressed,
      submitted: parseBingDate(r.Submitted),
      lastCrawled: parseBingDate(r.LastCrawled),
    }));
  } catch {
    return null;
  }
}
