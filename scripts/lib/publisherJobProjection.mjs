/**
 * Project a paid PublisherJob (Firestore) into by-crawler job records.
 *
 * The assemble pipeline (scripts/assemble-jobs-dataset.mjs) is source-agnostic:
 * a publisher ad becomes ONE record PER LOCATION in
 * `data/jobs/by-crawler/publisher-submitted.json`, then it is emitted as a static
 * SEO page exactly like a crawled job. The same records (filtered to paid) also
 * feed the runtime overlay so the ad is visible in the SPA before the next build.
 *
 * Pure + self-contained (no heavy imports) so it is trivially unit-testable and
 * usable from a plain Node build script. Canonical slug stabilization is left to
 * the assemble pipeline (deriveLocalizedSlug); here we emit a deterministic
 * starting slug + a stable id so dedup/merge identity is preserved across runs.
 */

export const PUBLISHER_SOURCE_KEY = 'publisher-submitted';
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const SLUG_MAX = 120;

// A publisher ad is "live" (projected into the slice) when sponsored+paid or free+published.
const LIVE_STATUSES = new Set(['paid', 'published']);

/** Lowercase ASCII slug; collapses non-alphanumerics to single hyphens. */
export function slugifyPublisher(input = '') {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Truncate a slug at a word (hyphen) boundary, never mid-token. */
export function truncatePublisherSlug(slug = '', maxLen = SLUG_MAX) {
  if (slug.length <= maxLen) return slug;
  const cut = slug.slice(0, maxLen);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, '');
}

function distinctLocations(locations) {
  if (!Array.isArray(locations)) return [];
  const seen = new Map(); // key → original label
  for (const loc of locations) {
    const label = loc && typeof loc === 'object' && loc.label != null ? loc.label : loc;
    const text = String(label ?? '').trim();
    const key = text.toLowerCase();
    if (text && !seen.has(key)) seen.set(key, { text, raw: loc });
  }
  return [...seen.values()];
}

/** epoch-millis | Firestore Timestamp | ISO string → ISO date (YYYY-MM-DD...). */
function toIso(value, fallbackIso) {
  if (value == null) return fallbackIso;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toMillis === 'function') {
    return new Date(value.toMillis()).toISOString();
  }
  if (typeof value === 'object' && typeof value._seconds === 'number') {
    return new Date(value._seconds * 1000).toISOString();
  }
  return fallbackIso;
}

/**
 * @param {object} pubJob  PublisherJob document (with id).
 * @param {object} [opts]
 * @param {string} [opts.nowIso]  Reference timestamp (inject for deterministic tests).
 * @param {number} [opts.validDays=30]  validThrough window (matches 30-day billing).
 * @returns {object[]}  by-crawler job records, one per distinct location. Empty if not paid.
 */
export function publisherJobToRecords(pubJob, opts = {}) {
  if (!pubJob || !LIVE_STATUSES.has(pubJob.status)) return [];
  // Free tier is a plain crawler-style job: never featured (defense-in-depth on
  // top of the Firestore-rules guard).
  const isFree = pubJob.tier === 'free';
  const nowIso = opts.nowIso || null;
  const validDays = Number.isFinite(opts.validDays) ? opts.validDays : 30;

  const company = pubJob.company || {};
  const companyName = String(company.name || '').trim();
  const companyKey = company.companyKey || slugifyPublisher(companyName);
  const apply = pubJob.apply || {};
  const postedIso = toIso(pubJob.paidAt, nowIso) || toIso(pubJob.createdAt, nowIso);
  const firstSeenIso = toIso(pubJob.createdAt, postedIso);
  const validThroughIso =
    postedIso ? new Date(new Date(postedIso).getTime() + validDays * 86400000).toISOString() : null;

  const locations = distinctLocations(pubJob.locations);
  if (locations.length === 0) return [];

  return locations.map(({ text: locationLabel, raw }) => {
    const addr = (raw && typeof raw === 'object' && raw.address) || {};
    const canton = (raw && raw.canton) || addr.addressRegion || 'TI';
    const baseSlug = truncatePublisherSlug(
      slugifyPublisher(`${pubJob.title}-${locationLabel}-${companyName}`),
    );
    const id = `pub-${pubJob.id}-${slugifyPublisher(locationLabel)}`;
    const url = `${SITE_ORIGIN}/lavoro/${baseSlug}`;
    const applyUrl = apply.mode === 'external_url' && apply.url ? apply.url : url;

    return {
      title: pubJob.title,
      slug: baseSlug,
      url,
      applyUrl,
      company: companyName,
      companyKey,
      companyDomain: company.domain || null,
      location: locationLabel,
      addressLocality: addr.addressLocality || locationLabel,
      postalCode: addr.postalCode || null,
      streetAddress: addr.streetAddress || null,
      addressRegion: canton,
      addressCountry: addr.addressCountry || 'CH',
      canton,
      country: 'CH',
      category: pubJob.category || null,
      sector: pubJob.sector || null,
      source: PUBLISHER_SOURCE_KEY,
      sourceLang: pubJob.sourceLang || 'it',
      postedDate: postedIso,
      employmentType: pubJob.employmentType || null,
      contractType: pubJob.contractType || null,
      validThrough: validThroughIso,
      description: pubJob.description || '',
      titleByLocale: pubJob.titleByLocale || undefined,
      descriptionByLocale: pubJob.descriptionByLocale || undefined,
      id,
      salaryMin: pubJob.salaryMin ?? null,
      salaryMax: pubJob.salaryMax ?? null,
      currency: pubJob.currency || 'CHF',
      firstSeenAt: firstSeenIso,
      featured: !isFree && pubJob.featured === true,
      tier: isFree ? 'free' : 'sponsored',
      // Apply mode drives the candidate-side UI: 'external_url' → link out (free
      // tier is always this); 'forward_email' / 'in_house' → in-house apply form
      // that writes an `applications` doc (a CF forwards it). The publisher's
      // forward email is NEVER projected (PII) — the CF reads it server-side.
      applyMode: isFree ? 'external_url' : (apply.mode || 'external_url'),
      // Provenance — distinguishes self-published ads from crawled jobs downstream.
      publisherUid: pubJob.publisherUid || null,
      publisherJobId: pubJob.id || null,
    };
  });
}

/**
 * Featured inventory cap PER CANTON — keeps the sponsored "featured" placement
 * scarce (and therefore valuable). Beyond the cap, the most-recently-paid ads
 * keep the boost; the rest stay paid/listed but lose `featured` (no demotion of
 * the ad itself, only of the premium placement). Owner tunes this one constant.
 */
export const FEATURED_SLOTS_PER_CANTON = 6;

/**
 * Apply the per-canton featured cap to a flat record array (mutating featured).
 * Records are ranked by paidAt/firstSeenAt desc within each canton.
 * @param {object[]} records
 * @param {number} [cap]
 * @returns {object[]} the same records (featured possibly downgraded)
 */
export function applyFeaturedSlotCap(records, cap = FEATURED_SLOTS_PER_CANTON) {
  if (!Array.isArray(records)) return [];
  const byCanton = new Map();
  for (const r of records) {
    if (!r.featured) continue;
    const key = r.canton || 'TI';
    if (!byCanton.has(key)) byCanton.set(key, []);
    byCanton.get(key).push(r);
  }
  for (const group of byCanton.values()) {
    if (group.length <= cap) continue;
    group.sort((a, b) => {
      const ta = Date.parse(a.postedDate || a.firstSeenAt || '') || 0;
      const tb = Date.parse(b.postedDate || b.firstSeenAt || '') || 0;
      return tb - ta; // most recently paid first
    });
    group.slice(cap).forEach((r) => { r.featured = false; });
  }
  return records;
}

/**
 * Project many publisher jobs to a flat record array (skips non-live) and apply
 * the per-canton featured inventory cap.
 * @param {object[]} pubJobs
 * @param {object} [opts] { featuredCap }
 */
export function publisherJobsToSlice(pubJobs, opts = {}) {
  if (!Array.isArray(pubJobs)) return [];
  const records = pubJobs.flatMap((j) => publisherJobToRecords(j, opts));
  return applyFeaturedSlotCap(records, opts.featuredCap);
}
