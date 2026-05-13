/**
 * postch-job-parser.mjs
 *
 * Parses a Post.ch / job.post.ch detail page HTML and extracts
 * structured job data.
 *
 * Two detail page formats are supported:
 *
 *   Legacy /v2/ format (decommissioned, kept for fallback):
 *     https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 *     Contains <script type="application/ld+json"> with JobPosting schema.
 *
 *   Current SuccessFactors NES format:
 *     https://job.post.ch/{brand}/job/{slug}/{id}-{locale}
 *     JSON-LD is built client-side via JS — the static HTML exposes the
 *     job data inside #search-wrapper > .joblayouttoken elements (the
 *     order is documented in the inline rebuilder script):
 *       token 0 → title
 *       token 1 → workload minimum
 *       token 2 → workload maximum
 *       token 3 → jobLocationShort (pipe-separated, e.g. "Bellinzona|Ticino|TI|Svizzera|CHE")
 *       token 12 → posting start date
 *       token 13 → posting end date
 *       token 17 → jobReqId
 *       token 18 → description container (.rtltextaligneligible inside)
 *
 * `parsePostJobDetail` automatically falls back from JSON-LD to the token
 * structure so existing callers keep working.
 */

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

/**
 * Extract all JSON-LD blocks from HTML and return parsed objects.
 */
function extractJsonLd(html = '') {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch { /* skip malformed JSON-LD */ }
  }
  return blocks;
}

/**
 * Extract a meta tag content value from HTML.
 */
function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]+content\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = html.match(re);
  if (match) return decodeHtml(normalizeSpace(match[1]));
  // Try reversed attribute order
  const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:name|property)\\s*=\\s*["']${name}["']`, 'i');
  const match2 = html.match(re2);
  return match2 ? decodeHtml(normalizeSpace(match2[1])) : '';
}

/**
 * Extract <title> from HTML.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(normalizeSpace(match[1])) : '';
}

/**
 * Derive the location / city from the JobPosting schema.
 */
function deriveCity(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  // jobLocation can be a single Place or array of Places
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address) continue;
    if (typeof address === 'string') return normalizeSpace(address);
    const city = address.addressLocality || address.addressRegion || '';
    if (city) return normalizeSpace(city);
  }
  return '';
}

/**
 * Flatten a JobPosting schema's `jobLocation` field into a list of
 * `{ city, region, country }` records. Used by callers that need to pick
 * a specific place from a multi-location job (e.g. "the TI one").
 */
function flattenPlaces(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return [];
  const places = Array.isArray(loc) ? loc : [loc];
  return places.map((place) => {
    const address = place?.address;
    if (!address) return { city: '', region: '', country: '' };
    if (typeof address === 'string') {
      return { city: normalizeSpace(address), region: '', country: '' };
    }
    return {
      city: normalizeSpace(address.addressLocality || ''),
      region: normalizeSpace(address.addressRegion || ''),
      country: normalizeSpace(address.addressCountry || ''),
    };
  });
}

/**
 * Derive the region from the JobPosting schema.
 */
function deriveRegion(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    const region = address.addressRegion || '';
    if (region) return normalizeSpace(region);
  }
  return '';
}

/**
 * Derive the street address from the JobPosting schema.
 */
function deriveStreetAddress(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    if (address.streetAddress) return normalizeSpace(address.streetAddress);
  }
  return '';
}

/**
 * Extract description text. Prefer JSON-LD description, fall back to meta.
 */
function deriveDescription(jobPosting = {}, html = '') {
  const desc = jobPosting.description || '';
  if (desc) {
    // Strip HTML tags if present
    return normalizeSpace(desc.replace(/<[^>]+>/g, ' '));
  }
  return extractMeta(html, 'description') || extractMeta(html, 'og:description') || '';
}

/**
 * Parse workload / employment type from the JSON-LD.
 */
function deriveEmploymentType(jobPosting = {}) {
  const et = jobPosting.employmentType;
  if (!et) return '';
  if (Array.isArray(et)) return et[0] || '';
  return String(et);
}

/**
 * Strip a single layer of outer wrapper element to expose inner text, then
 * collapse whitespace. Keeps inline block separations as single spaces.
 */
function htmlBlockToText(value = '') {
  return normalizeSpace(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Iterate `.joblayouttoken` blocks inside #search-wrapper in document order.
 * Returns an array; index N corresponds to the Nth token.
 *
 * Each entry is `{ inner: string, text: string }`. `inner` is the raw inner
 * HTML of the .rtltextaligneligible span (preserves paragraph markup for
 * the description token), `text` is the whitespace-normalised text content.
 */
function extractJobLayoutTokens(html = '') {
  const wrapperMatch = html.match(/<div\s+id=["']search-wrapper["'][^>]*>([\s\S]*)/i);
  if (!wrapperMatch) return [];
  // Cheap delimiter: split on each opening joblayouttoken div and take its body.
  // We don't need to track nesting depth — every token block ends right before
  // the next opening tag or before the wrapper's closing region.
  const wrapper = wrapperMatch[1];
  const tokenRe = /<div\s+class=["']joblayouttoken[^"']*["'][^>]*>([\s\S]*?)(?=<div\s+class=["']joblayouttoken|<div\s+id=["']page-bottom|<\/div>\s*<\/div>\s*<div\s+id=["']page-bottom|$)/gi;
  const spanRe = /<span[^>]*class=["'][^"']*rtltextaligneligible[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(wrapper)) !== null) {
    const block = m[1];
    const spanMatch = block.match(spanRe);
    const inner = spanMatch ? spanMatch[1] : '';
    tokens.push({ inner, text: htmlBlockToText(inner) });
  }
  return tokens;
}

// Localities that the SF rebuilder treats as non-physical placements (home
// office, remote, hybrid in DE/FR/IT/EN). They appear inline in the same
// pipe-separated token as physical locations and must be skipped.
const HOMEOFFICE_LOCALITIES = new Set([
  'homeoffice', 'home office', 'home-office',
  'remote', 'remotearbeit', 'travail à distance', 'lavoro a distanza', 'fernarbeit',
  'hybrid', 'hybride', 'ibrido', 'hub locations', 'siti hub',
]);

/**
 * Convert a Post.ch pipe-separated location token into a list of JSON-LD
 * Place objects. Multiple locations are concatenated in the same token,
 * separated only by pipes (e.g. "City1|Canton|CC|Country|CCC  | City2|…").
 * The format mirrors `parseJobLocations` in the page's own SF rebuilder JS.
 */
function parseLocationToken(text = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return [];
  const parts = cleaned.split('|').map(p => p.trim()).filter(Boolean);
  const places = [];
  let i = 0;
  while (i < parts.length) {
    const current = parts[i];
    if (HOMEOFFICE_LOCALITIES.has(current.toLowerCase())) {
      // home-office entries are followed by 2 segments (country, country code).
      i += i + 2 < parts.length ? 3 : 1;
      continue;
    }
    if (i + 4 < parts.length) {
      const [locality, canton, cantonCode, country, countryCode] = parts.slice(i, i + 5);
      if (/^[A-Z]{2,3}$/.test(cantonCode) && /^[A-Z]{2,3}$/.test(countryCode)) {
        places.push({
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: locality,
            addressRegion: cantonCode,
            addressCountry: countryCode,
          },
        });
        i += 5;
        continue;
      }
    }
    if (i + 2 < parts.length) {
      const [locality, country, countryCode] = parts.slice(i, i + 3);
      if (/^[A-Z]{2,3}$/.test(countryCode)) {
        places.push({
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: locality,
            addressCountry: countryCode,
          },
        });
        i += 3;
        continue;
      }
    }
    i += 1;
  }
  return places;
}

/**
 * Convert SuccessFactors NES date tokens ("28/04/26", "13.05.26", "5/13/26")
 * into ISO YYYY-MM-DD using the locale embedded in the URL. Returns '' on
 * failure — callers should fall back to a default date.
 */
function parseTokenDate(raw = '', url = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const isUS = /-en_US\b/i.test(url);
  // Try ISO first
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime()) && /\d{4}/.test(s)) {
    return direct.toISOString().slice(0, 10);
  }
  const match = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!match) return '';
  let [, a, b, y] = match;
  if (y.length === 2) y = `20${y}`;
  const day = isUS ? Number(b) : Number(a);
  const month = isUS ? Number(a) : Number(b);
  const year = Number(y);
  if (!day || !month || !year) return '';
  const iso = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(iso.getTime())) return '';
  return iso.toISOString().slice(0, 10);
}

/**
 * Build a JobPosting-shaped object from the token structure of a current
 * SuccessFactors NES detail page. Returns `null` if the page does not
 * contain the expected `.joblayouttoken` markup.
 *
 * Two layouts are emitted by the same template:
 *   - "Regular" (`PFCH`/professional):  description in token 18,
 *     workload in tokens 1-2, posting dates in tokens 12-13.
 *   - "Apprenticeship" (`PCH` brand):  description in token 11,
 *     duration in token 1, no posting-date tokens.
 *
 * We detect the layout by checking whether token 18 carries text — when it
 * does, it's the regular layout; otherwise we fall back to token 11.
 */
function buildJobPostingFromTokens(html = '', url = '') {
  const tokens = extractJobLayoutTokens(html);
  if (tokens.length < 4) return null;
  const title = tokens[0]?.text || '';
  if (!title) return null;
  const locationToken = tokens[3]?.text || '';
  const jobLocation = parseLocationToken(locationToken);
  if (jobLocation.length === 0) return null;

  const regularDescInner = tokens[18]?.inner || '';
  const regularDesc = htmlBlockToText(regularDescInner);
  const apprenticeshipDescInner = tokens[11]?.inner || '';
  const apprenticeshipDesc = htmlBlockToText(apprenticeshipDescInner);

  const isRegular = regularDesc.length > 40;
  const descriptionInner = isRegular ? regularDescInner : apprenticeshipDescInner;
  const description = isRegular ? regularDesc : apprenticeshipDesc;

  const datePosted = isRegular ? parseTokenDate(tokens[12]?.text || '', url) : '';
  const validThrough = isRegular ? parseTokenDate(tokens[13]?.text || '', url) : '';

  const pensumMin = tokens[1]?.text || '';
  const pensumMax = tokens[2]?.text || '';
  let employmentType = '';
  let workloadRange = '';
  if (isRegular) {
    const maxNum = Number(pensumMax);
    if (Number.isFinite(maxNum) && maxNum > 0 && maxNum < 100) employmentType = 'PART_TIME';
    else if (Number.isFinite(maxNum) && maxNum >= 100) employmentType = 'FULL_TIME';
    workloadRange = pensumMin && pensumMax && pensumMin !== pensumMax
      ? `${pensumMin}-${pensumMax}%`
      : (pensumMax ? `${pensumMax}%` : '');
  } else {
    employmentType = 'INTERN'; // apprenticeship layout
  }

  return {
    '@type': 'JobPosting',
    title,
    description,
    jobLocation,
    datePosted,
    validThrough,
    employmentType,
    _workloadRange: workloadRange,
  };
}

/**
 * Extract a stable Post.ch job ID from a detail URL.
 *
 * Handles both URL families:
 *   - Legacy:   .../v2/job-vacancies/{slug}/{uuid}            → "uuid:{uuid}"
 *   - Current:  .../{brand}/job/{slug}/{id}-{locale}          → "sfid:{id}"
 *
 * Returns '' for unrecognised URLs so callers can fall back to the URL
 * itself as a match key.
 */
export function extractPostJobIdFromUrl(url = '') {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  const uuidMatch = u.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (uuidMatch) return `uuid:${uuidMatch[0]}`;
  // SuccessFactors NES IDs are 4-7 digit numbers immediately before the
  // locale suffix (e.g. /73503-it_IT). The legacy stable-id extractor only
  // matches ≥6 digits, but post.ch IDs are routinely 5 digits, so we have
  // our own narrower regex anchored on the locale suffix.
  const sfMatch = u.match(/\/(\d{4,7})-([a-z]{2})_([a-z]{2})(?:[\/?#]|$)/);
  if (sfMatch) return `sfid:${sfMatch[1]}`;
  return '';
}

/**
 * Parse a Post.ch job detail page and return structured data.
 *
 * @param {string} html - Raw HTML of the detail page
 * @param {string} url  - URL of the detail page (for fallback data)
 * @returns {object} Structured job detail
 */
export function parsePostJobDetail(html = '', url = '') {
  const jsonLdBlocks = extractJsonLd(html);

  // Find the JobPosting schema block
  let jobPosting = jsonLdBlocks.find(
    b => b['@type'] === 'JobPosting' || b['@type']?.includes?.('JobPosting')
  );

  // Fall back to the token structure used by current SuccessFactors NES pages.
  if (!jobPosting) {
    jobPosting = buildJobPostingFromTokens(html, url);
  }
  jobPosting = jobPosting || {};

  const hiringOrg = jobPosting.hiringOrganization;
  const hiringOrgName = typeof hiringOrg === 'string'
    ? hiringOrg
    : (hiringOrg?.name || '');

  const title = normalizeSpace(jobPosting.title || '')
    || extractMeta(html, 'og:title')
    || extractTitle(html).replace(/\s*\|.*$/, '')
    || '';

  const city = deriveCity(jobPosting);
  const region = deriveRegion(jobPosting);
  const streetAddress = deriveStreetAddress(jobPosting);
  const places = flattenPlaces(jobPosting);
  const description = deriveDescription(jobPosting, html);
  const employmentType = deriveEmploymentType(jobPosting);
  const datePosted = normalizeDate(jobPosting.datePosted || '');
  const validThrough = normalizeDate(jobPosting.validThrough || '');
  const industry = normalizeSpace(jobPosting.industry || jobPosting.occupationalCategory || '');

  // Workload (pensum) — Post.ch sometimes includes it in the title or description;
  // current SuccessFactors NES pages expose it as discrete tokens that
  // `buildJobPostingFromTokens` surfaces via `_workloadRange`.
  let workload = jobPosting._workloadRange || '';
  if (!workload) {
    const workloadMatch = (title + ' ' + description).match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
    if (workloadMatch) {
      workload = `${workloadMatch[1]}-${workloadMatch[2]}%`;
    } else {
      const singleMatch = (title + ' ' + description).match(/(\d{1,3})\s*%/);
      if (singleMatch) workload = `${singleMatch[1]}%`;
    }
  }

  return {
    title,
    description,
    hiringOrg: normalizeSpace(hiringOrgName),
    city,
    region,
    location: city || region || '',
    streetAddress,
    industry,
    datePosted,
    validThrough,
    employmentType,
    workload,
    places, // every parsed jobLocation, used by callers to pick a target city
    url,
  };
}
