/**
 * Project a paid PublisherJob (Firestore) into by-crawler job records.
 *
 * The assemble pipeline (scripts/assemble-jobs-dataset.mjs) is source-agnostic:
 * a publisher ad becomes ONE record PER LOCATION in
 * `data/jobs/by-crawler/publisher-submitted.json`, then it is emitted as a static
 * SEO page exactly like a crawled job. Per the locked decision, the ad goes live
 * at the next deploy ("disponibile tra 1-2 ore" = deploy/SSG latency); there is
 * no instant runtime overlay in Phase 1.
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

// First PARSEABLE date among the candidates → epoch ms (0 if none parse).
// Local twin of build-plugins/shared/firstParsableDate.ts (this module stays
// import-free per its contract). Stops a malformed postedDate from shadowing a
// valid firstSeenAt in the featured-slot recency sort below.
function firstParsableMs(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const ts = new Date(v).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

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

export function distinctLocations(locations) {
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
/** Minimum description words for an indexable page (thin-content gate, AGENTS). */
export const MIN_DESCRIPTION_WORDS = 50;

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function publisherJobToRecords(pubJob, opts = {}) {
  if (!pubJob || !LIVE_STATUSES.has(pubJob.status)) return [];
  // Server-side thin-content gate (defense beyond the client check): never emit a
  // sub-50-word page, regardless of how the doc reached a live status.
  if (wordCount(pubJob.description) < MIN_DESCRIPTION_WORDS) return [];
  // Free tier is a plain crawler-style job: never featured (defense-in-depth on
  // top of the Firestore-rules guard).
  const isFree = pubJob.tier === 'free';
  const isAzienda = pubJob.tier === 'azienda';
  const nowIso = opts.nowIso || null;
  const validDays = Number.isFinite(opts.validDays) ? opts.validDays : 30;

  // Mirror the (already ≥50-word, validated) description into the source-locale
  // key of descriptionByLocale. Publisher ads store only the flat `description`
  // string — they never populate `descriptionByLocale`. Downstream the
  // boilerplate guard (assemble-jobs-dataset detectBoilerplateDescriptions)
  // reads `job.descriptionByLocale?.it`, so an absent map looks like an EMPTY
  // description → every publisher ad is flagged `empty_description` → the
  // publisher-jobs-sync FATALs at the 50% threshold and a PAID ad never reaches
  // the live slice. Filling the source locale (IT for the IT-primary site) with
  // the same text the page already renders fixes the false positive without
  // changing any content or lowering the thin-content gate above.
  const sourceLang = pubJob.sourceLang || 'it';
  const descriptionByLocale = { ...(pubJob.descriptionByLocale || {}) };
  const flatDescription = String(pubJob.description || '').trim();
  if (flatDescription && !String(descriptionByLocale[sourceLang] || '').trim()) {
    descriptionByLocale[sourceLang] = pubJob.description;
  }
  if (flatDescription && !String(descriptionByLocale.it || '').trim()) {
    descriptionByLocale.it = pubJob.description;
  }

  // Same gap for titleByLocale (+ slugByLocale, built per-location below):
  // publisher ads store only a flat `title`/`slug`, so once the ad is in the
  // dataset `tests/job-locale-completeness` ("no job has a completely empty
  // titleByLocale/slugByLocale object") fails. Populate every locale (source
  // title; the /lavoro slug is locale-agnostic), merged with any real
  // translations. en/de/fr defaulting to the IT title trips assemble's
  // cross-locale-duplicate guard → needsRetranslation, so the "all-4-locales"
  // gates skip the ad until translate-pending fills real translations.
  const LOCALE_KEYS = ['it', 'en', 'de', 'fr'];
  const flatTitle = String(pubJob.title || '').trim();
  const titleByLocale = { ...(pubJob.titleByLocale || {}) };
  if (flatTitle) {
    for (const lk of LOCALE_KEYS) {
      if (!String(titleByLocale[lk] || '').trim()) titleByLocale[lk] = pubJob.title;
    }
  }

  const company = pubJob.company || {};
  const companyName = String(company.name || '').trim();
  const companyKey = company.companyKey || slugifyPublisher(companyName);
  // Publisher-provided logo URL (form field company.logoUrl). https-only (the
  // site is https — http would be mixed content); anything else (data:,
  // javascript:, relative junk) is dropped and the renderers fall back to the
  // deterministic coloured-initials badge.
  const rawLogo = String(company.logoUrl || '').trim();
  const companyLogo = /^https:\/\/\S+$/i.test(rawLogo) ? rawLogo : null;
  // Markdown-formatted description (sponsored-only authoring surface). The flat
  // `description` stays plain text — JSON-LD, meta descriptions, search
  // haystacks and the newsletter keep consuming it unchanged.
  const descriptionMd = !isFree && String(pubJob.descriptionMd || '').trim()
    ? String(pubJob.descriptionMd).trim()
    : null;
  const apply = pubJob.apply || {};
  const postedIso = toIso(pubJob.paidAt, nowIso) || toIso(pubJob.createdAt, nowIso);
  const firstSeenIso = toIso(pubJob.createdAt, postedIso);
  // `crawledAt` = "last verified live" — the emitter (jobsSeoPagesPlugin
  // toValidThrough) derives JobPosting validThrough from crawledAt (+60d), NOT
  // from the record's validThrough. A still-paid ad is re-projected every sync
  // run, so anchoring crawledAt to TODAY (day granularity, not the full
  // timestamp) keeps validThrough ~60d in the future for the whole subscription
  // while changing the slice at most once/day (no 30-min deploy churn). When the
  // subscription lapses the ad drops from the slice entirely.
  const crawledAtIso = String(nowIso || postedIso || '').slice(0, 10) || null;
  let validThroughIso =
    crawledAtIso ? new Date(new Date(crawledAtIso).getTime() + validDays * 86400000).toISOString()
      : (postedIso ? new Date(new Date(postedIso).getTime() + validDays * 86400000).toISOString() : null);
  // Floor to reference-now + validDays (#3505, same class as jobsSeoPagesPlugin
  // toValidThrough): a projection run without nowIso anchors crawledAt to the
  // (possibly old) postedDate → a still-live paid ad would emit an already-past
  // validThrough and be dropped from Google Jobs as expired. Day granularity
  // (like crawledAtIso) keeps the "changes at most once/day" no-churn property.
  const refDayIso = String(nowIso || new Date().toISOString()).slice(0, 10);
  const floorIso = new Date(new Date(refDayIso).getTime() + validDays * 86400000).toISOString();
  if (!validThroughIso || new Date(validThroughIso).getTime() < new Date(floorIso).getTime()) {
    validThroughIso = floorIso;
  }

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
    // The /lavoro/<slug> path is locale-agnostic → the same slug in every
    // locale (merged with any real per-locale slug already present).
    const slugByLocale = { ...(pubJob.slugByLocale || {}) };
    for (const lk of LOCALE_KEYS) {
      if (!String(slugByLocale[lk] || '').trim()) slugByLocale[lk] = baseSlug;
    }

    return {
      title: pubJob.title,
      slug: baseSlug,
      url,
      applyUrl,
      company: companyName,
      companyKey,
      companyDomain: company.domain || null,
      ...(companyLogo ? { companyLogo } : {}),
      ...(descriptionMd ? { descriptionMd } : {}),
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
      titleByLocale: Object.keys(titleByLocale).length ? titleByLocale : undefined,
      slugByLocale: Object.keys(slugByLocale).length ? slugByLocale : undefined,
      descriptionByLocale: Object.keys(descriptionByLocale).length ? descriptionByLocale : undefined,
      id,
      salaryMin: pubJob.salaryMin ?? null,
      salaryMax: pubJob.salaryMax ?? null,
      currency: pubJob.currency || 'CHF',
      firstSeenAt: firstSeenIso,
      // Refreshed (day-granularity) while the ad stays live → validThrough never goes stale.
      crawledAt: crawledAtIso,
      // Piano Azienda: ogni annuncio è sempre in evidenza (promessa "illimitato +
      // sempre featured"); sponsored: solo se il publisher l'ha marcato featured.
      featured: isAzienda || (!isFree && pubJob.featured === true),
      tier: isFree ? 'free' : (isAzienda ? 'azienda' : 'sponsored'),
      // Apply mode drives the candidate-side UI: 'external_url' → link out (free
      // tier is always this); 'forward_email' / 'in_house' → in-house apply form
      // that writes an `applications` doc (a CF forwards it). The publisher's
      // forward email is NEVER projected (PII) — the CF reads it server-side.
      applyMode: isFree ? 'external_url' : (apply.mode || 'external_url'),
      // Provenance — distinguishes self-published ads from crawled jobs downstream.
      publisherUid: pubJob.publisherUid || null,
      publisherJobId: pubJob.id || null,
      // Canary (broadcast-restricted) flag — a real on-site ad whose sponsor
      // blast / newsletter / job-alert distribution is gated to the owner only
      // (scripts/lib/canaryAd.mjs). Only emitted when true so non-canary records
      // stay byte-identical. Sponsored-only (free ads have no broadcast perks).
      ...(!isFree && pubJob.canary === true ? { canary: true } : {}),
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
    // Piano Azienda è "illimitato + sempre in evidenza": esente dal cap. Non viene
    // mai demosso E non consuma slot, così non soffoca i featured sponsored a pagamento.
    if (!r.featured || r.tier === 'azienda') continue;
    const key = r.canton || 'TI';
    if (!byCanton.has(key)) byCanton.set(key, []);
    byCanton.get(key).push(r);
  }
  for (const group of byCanton.values()) {
    if (group.length <= cap) continue;
    group.sort((a, b) => {
      const ta = firstParsableMs(a.postedDate, a.firstSeenAt);
      const tb = firstParsableMs(b.postedDate, b.firstSeenAt);
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
