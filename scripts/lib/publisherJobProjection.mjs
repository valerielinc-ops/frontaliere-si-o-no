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

  const company = pubJob.company || {};
  const companyName = String(company.name || '').trim();
  const companyKey = company.companyKey || slugifyPublisher(companyName);
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
  const validThroughIso =
    crawledAtIso ? new Date(new Date(crawledAtIso).getTime() + validDays * 86400000).toISOString()
      : (postedIso ? new Date(new Date(postedIso).getTime() + validDays * 86400000).toISOString() : null);

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

    // Mirror the flat title/slug into the source-locale (+ IT) keys of
    // titleByLocale/slugByLocale — same gap (and fix) as descriptionByLocale
    // above. Publisher ads store only flat `title`/`slug`; without these maps a
    // projected job lands in the dataset with NO titleByLocale/slugByLocale
    // object → the job-locale-completeness gate ("no completely empty …Locale
    // object") fails and turns `main` red (publisher-jobs-sync commits straight
    // to main, so an unvalidated record poisons the gate). en/de/fr are filled
    // later by translate-pending; we flag `needsRetranslation` until then so the
    // "all 4 locales" gate skips the row (it still carries a non-empty
    // source-locale map, so the "no empty object" gate passes).
    const titleByLocale = { ...(pubJob.titleByLocale || {}) };
    if (pubJob.title && !String(titleByLocale[sourceLang] || '').trim()) titleByLocale[sourceLang] = pubJob.title;
    if (pubJob.title && !String(titleByLocale.it || '').trim()) titleByLocale.it = pubJob.title;
    const slugByLocale = { ...(pubJob.slugByLocale || {}) };
    if (baseSlug && !String(slugByLocale[sourceLang] || '').trim()) slugByLocale[sourceLang] = baseSlug;
    if (baseSlug && !String(slugByLocale.it || '').trim()) slugByLocale.it = baseSlug;
    const needsRetranslation = ['it', 'en', 'de', 'fr'].some(
      (l) => !String(titleByLocale[l] || '').trim()
        || !String(slugByLocale[l] || '').trim()
        || !String(descriptionByLocale[l] || '').trim(),
    );

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
      titleByLocale: Object.keys(titleByLocale).length ? titleByLocale : undefined,
      slugByLocale: Object.keys(slugByLocale).length ? slugByLocale : undefined,
      descriptionByLocale: Object.keys(descriptionByLocale).length ? descriptionByLocale : undefined,
      needsRetranslation: needsRetranslation || undefined,
      id,
      salaryMin: pubJob.salaryMin ?? null,
      salaryMax: pubJob.salaryMax ?? null,
      currency: pubJob.currency || 'CHF',
      firstSeenAt: firstSeenIso,
      // Refreshed (day-granularity) while the ad stays live → validThrough never goes stale.
      crawledAt: crawledAtIso,
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
