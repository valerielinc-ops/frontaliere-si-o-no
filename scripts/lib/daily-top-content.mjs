/**
 * daily-top-content.mjs — pick yesterday's most-clicked ARTICLE and most-clicked
 * JOB out of a GA4 `pagePath` report.
 *
 * PURE MODULE: no filesystem and no network at module scope (same contract as
 * scripts/lib/job-traffic-priority.mjs), so it imports cleanly inside a sparse
 * worktree where `data/` and `public/` are not materialized, and so the ranking
 * rules are unit-testable without touching GA4.
 *
 * ── Why GA4 and not the snapshots already in the repo ──────────────────────
 * The repo already has two traffic artifacts, and NEITHER can answer "on day D":
 *   • data/job-popularity.json  — Firestore `job_views`, a cumulative all-time
 *     counter per slug (see services/newsletter-content.mjs:152, which is why the
 *     30-day decay exists at all).
 *   • public/article-trending.json — Firestore `article_views`, weighted 7d-full
 *     / 30d-half, again off a cumulative counter.
 * Both are committed once per day, so a per-day delta IS derivable by diffing
 * two consecutive commits — but that delta is bounded by the refresh cron
 * (05:00 UTC → 05:00 UTC, not a calendar day), it silently goes negative on
 * full-scan days when deleted docs vanish, and it counts sessionStorage-debounced
 * *sessions* rather than pageviews. GA4 answers the calendar-UTC-day question
 * directly for both content kinds in a single report, so that is what this uses.
 *
 * ── Italian only, on purpose ───────────────────────────────────────────────
 * Only unprefixed (Italian) paths are considered. `/en/…`, `/de/…`, `/fr/…` are
 * dropped rather than folded onto their Italian twin: the slugs differ per
 * locale, so folding would need a slug→slug map, and the post copy is Italian
 * anyway. A German page winning the day would otherwise produce an Italian
 * caption pointing at a German URL.
 */

/** Article hub path segments (mirrors ARTICLE_HUB_SLUG_IT in social-post-utils.mjs). */
export const ARTICLE_HUB_SEGMENTS = Object.freeze(['articoli-frontaliere', 'articoli-svizzera']);

/** Locale prefixes the site emits; Italian is unprefixed. */
export const LOCALE_PREFIXES = Object.freeze(['en', 'de', 'fr']);

/**
 * The GA4 property's reporting timezone. Measured via the Admin API on
 * 2026-08-24: property 524485296 reports in `Europe/Zurich`, NOT UTC.
 */
export const GA4_REPORT_TIMEZONE = 'Europe/Zurich';

/**
 * The calendar day before `now` **in the GA4 property's timezone**, `YYYY-MM-DD`.
 *
 * This deliberately does NOT return the UTC previous day. A `startDate`/`endDate`
 * passed to `runReport` is resolved by GA4 against the PROPERTY's configured
 * timezone, so asking for the UTC day and calling the result "yesterday" is
 * wrong twice over: the bucket GA4 fills is the Zurich day, and near midnight
 * the two dates are different strings entirely. At the 08:15 UTC cron the two
 * happen to coincide, which is exactly what would have kept the bug invisible
 * until someone moved the cron or passed `--date`.
 *
 * Reporting on the local day is also the right product answer: "l'articolo piu'
 * letto di ieri" means yesterday for a reader in Ticino, not yesterday in UTC.
 *
 * @param {Date|number} [now]
 * @param {string} [timeZone] IANA zone; defaults to the property's
 * @returns {string}
 */
export function previousReportDay(now = Date.now(), timeZone = GA4_REPORT_TIMEZONE) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  // Read the local calendar date in the property timezone, then subtract one
  // *calendar* day. Subtracting 86400000ms first is wrong on DST transition
  // days: the fall-back day is 25h, so the last local hour of that day minus
  // 24h lands on the same calendar date (issue 6391). UTC date arithmetic
  // has no DST, so Y-M-D → previous Y-M-D is always one calendar day.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const num = (type) => Number(parts.find((p) => p.type === type)?.value);
  const y = num('year');
  const m = num('month');
  const d = num('day');
  const prev = new Date(Date.UTC(y, m - 1, d) - 86400000);
  const py = prev.getUTCFullYear();
  const pm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const pd = String(prev.getUTCDate()).padStart(2, '0');
  return `${py}-${pm}-${pd}`;
}

/**
 * Strip query/hash and normalize slashes off a GA4 pagePath.
 * Returns '' for anything unusable.
 *
 * @param {string} raw
 * @returns {string} e.g. '/articoli-frontaliere/qualcosa'
 */
export function normalizeGa4Path(raw) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim();
  if (!p) return '';
  const cut = Math.min(
    ...[p.indexOf('?'), p.indexOf('#')].filter((i) => i >= 0).concat([p.length]),
  );
  p = p.slice(0, cut);
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw form — a bad escape must not drop the row */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  return p;
}

/**
 * Classify a normalized path as an article page, a job page, or neither.
 *
 * A job page is `/<job-board-section>/<slug>` — exactly two segments, the first
 * being one of the 24 Italian canton sections produced by
 * resolveCantonSection('it', code). A bare `/<job-board-section>` is the board
 * index, not a job, so the two-segment requirement is what excludes it.
 *
 * @param {string} path normalized (see normalizeGa4Path)
 * @param {{ jobSections: Set<string>|string[] }} opts
 * @returns {{ kind: 'article'|'job', slug: string, section: string }|null}
 */
export function classifyPath(path, { jobSections } = {}) {
  if (!path || path === '/') return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [head, slug] = segments;
  if (!slug) return null;
  if (LOCALE_PREFIXES.includes(head)) return null;
  if (ARTICLE_HUB_SEGMENTS.includes(head)) {
    return { kind: 'article', slug, section: head };
  }
  const sections = jobSections instanceof Set ? jobSections : new Set(jobSections || []);
  if (sections.has(head)) {
    return { kind: 'job', slug, section: head };
  }
  return null;
}

/**
 * Is this `pageTitle` actually just the page's path?
 *
 * The SPA fires its GA4 pageview before `document.title` has been rewritten for
 * the new route, so GA4 records TWO rows for one article on the same day: one
 * whose title is the real headline, and one whose "title" is the raw path.
 * Measured on 2026-08-23, property 524485296:
 *     23 views | /articoli-frontaliere/bollettino-frontaliere-2026-08-23/
 *     20 views | Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci…
 * Both rows are genuine pageviews of the same page, so they must be SUMMED —
 * but the path-shaped one must never win the title, which is what this detects.
 * Without it the caption ships a URL where the headline belongs, and it does so
 * only for the articles whose path-row happens to outrank their title-row, i.e.
 * intermittently.
 *
 * @param {string} t
 * @returns {boolean}
 */
export function looksLikePathTitle(t) {
  const s = String(t ?? '').trim();
  if (!s) return true;
  return s.startsWith('/') || (s.includes('/') && !s.includes(' '));
}

/**
 * Drop the site-name suffix GA4 records in `pageTitle`.
 * 'Titolo | Frontaliere Ticino' → 'Titolo'.
 *
 * ONLY the pipe separates the title from the site name. An en/em dash must NOT
 * be treated as a separator even though many sites use it that way, because
 * this site's own headlines contain one:
 *   'Bollettino del frontaliere – 23 agosto 2026: 568 nuovi annunci di lavoro'
 * splitting on the dash truncated that to 'Bollettino del frontaliere', which
 * is both wrong and plausible-looking — the worst kind of wrong, since every
 * daily bollettino would have posted under an identical bland headline.
 *
 * Only the LAST separator group is removed, and only when something survives:
 * a title that is nothing but the site name is returned unchanged rather than
 * emptied, so the caller can still fall back to the slug.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanPageTitle(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  // Spacing around the pipe is not guaranteed: GA4 stores whatever the tag
  // sent, and 'Titolo|Sito' / 'Titolo  |  Sito' both occur. `\s*` rather than
  // `\s+` so the no-space form is not silently left unsplit.
  const parts = t.split(/\s*[|｜]\s*/);
  if (parts.length < 2) return t;
  const head = parts.slice(0, -1).join(' | ').trim();
  return head || t;
}

/**
 * Fold GA4 rows into ranked candidates, one entry per slug.
 *
 * Rows for the same slug are summed — GA4 emits several rows for one path
 * whenever `pageTitle` differs (see looksLikePathTitle for the SPA case).
 * The title kept is the highest-view REAL title; a path-shaped title only ever
 * survives when the slug has no real title at all.
 *
 * `isJobSlug`, when supplied, is the authority on what a job page is. Under a
 * canton section live both job detail pages AND generated SEO landing pages
 * (`/cerca-lavoro-ticino/infermieri/` is a 37-offer profession page, not an
 * offer), and the two are indistinguishable by URL shape. Validating against
 * the real dataset excludes landing pages, category aliases and stale slugs by
 * construction, instead of by an enumeration that silently rots.
 *
 * @param {Array<{ path: string, title?: string, views: number }>} rows
 * @param {{ jobSections?: Set<string>|string[], isJobSlug?: (slug: string) => boolean }} opts
 * @returns {{ articles: Array<object>, jobs: Array<object> }} each sorted desc by views
 */
export function rankCandidates(rows, { jobSections, isJobSlug } = {}) {
  /** @type {Map<string, any>} */
  const bySlug = new Map();

  for (const row of rows || []) {
    const path = normalizeGa4Path(row?.path);
    const hit = classifyPath(path, { jobSections });
    if (!hit) continue;
    if (hit.kind === 'job' && typeof isJobSlug === 'function' && !isJobSlug(hit.slug)) {
      continue;
    }
    const views = Number(row?.views) || 0;
    if (views <= 0) continue;

    const key = `${hit.kind}:${hit.slug}`;
    const title = cleanPageTitle(row?.title);
    const isReal = !looksLikePathTitle(title);
    const existing = bySlug.get(key);
    if (existing) {
      existing.views += views;
      // A real title always beats a path-shaped one; between two real titles,
      // the one from the higher-view row wins.
      if (isReal && (!existing.hasRealTitle || views > existing.titleRowViews)) {
        existing.title = title;
        existing.hasRealTitle = true;
        existing.titleRowViews = views;
      }
    } else {
      bySlug.set(key, {
        kind: hit.kind,
        slug: hit.slug,
        section: hit.section,
        path,
        title: isReal ? title : '',
        hasRealTitle: isReal,
        titleRowViews: views,
        views,
      });
    }
  }

  const all = [...bySlug.values()].sort(
    (a, b) => b.views - a.views || a.slug.localeCompare(b.slug),
  );
  return {
    articles: all.filter((c) => c.kind === 'article'),
    jobs: all.filter((c) => c.kind === 'job'),
  };
}

/**
 * First candidate whose slug is not already in the ledger.
 *
 * This is the whole point of the dedup requirement: the day's #1 is often the
 * SAME item several days running, and reposting it would make the account look
 * broken. Falling through to #2, #3 … keeps the slot filled with real winners
 * instead of skipping the day.
 *
 * @param {Array<{slug: string}>} candidates ranked desc
 * @param {Set<string>} postedSet slugs already posted
 * @returns {{ pick: object|null, skipped: number, exhausted: boolean }}
 */
export function pickFirstUnposted(candidates, postedSet) {
  const list = candidates || [];
  const posted = postedSet instanceof Set ? postedSet : new Set(postedSet || []);
  let skipped = 0;
  for (const candidate of list) {
    if (posted.has(candidate.slug)) {
      skipped += 1;
      continue;
    }
    return { pick: candidate, skipped, exhausted: false };
  }
  return { pick: null, skipped, exhausted: list.length > 0 };
}

/**
 * First `limit` candidates whose slug is not already in the ledger — the
 * carousel-format sibling of pickFirstUnposted (single item vs Instagram/
 * TikTok's "top N of the day" carousel). Same fall-through rule: an
 * already-posted candidate is skipped, not dropped from the count, so the
 * carousel still fills to `limit` from further down the ranking instead of
 * shipping short.
 *
 * @param {Array<{slug: string}>} candidates ranked desc
 * @param {Set<string>} postedSet slugs already posted
 * @param {number} limit max picks to return
 * @returns {{ picks: object[], skipped: number }}
 */
export function pickTopNUnposted(candidates, postedSet, limit) {
  const list = candidates || [];
  const posted = postedSet instanceof Set ? postedSet : new Set(postedSet || []);
  const max = Math.max(0, limit | 0);
  const picks = [];
  let skipped = 0;
  for (const candidate of list) {
    if (picks.length >= max) break;
    if (posted.has(candidate.slug)) {
      skipped += 1;
      continue;
    }
    picks.push(candidate);
  }
  return { picks, skipped };
}
