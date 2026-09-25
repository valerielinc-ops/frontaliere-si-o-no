/**
 * Channel-agnostic helpers shared by the social job schedulers.
 *
 * These utilities are deliberately free of any Facebook / Reddit / channel
 * specifics: they sanitize job text, pick the most-recent never-posted jobs,
 * build the canonical IT job-board URL, and read/write a JSON "posted" ledger
 * parameterized by file path so any social channel can keep its own dedup
 * state. They are imported by both `schedule-fb-jobs-daily.mjs` and
 * `schedule-reddit-jobs-daily.mjs` so the same logic is never duplicated
 * across schedulers (project rule: a regex/constant/helper duplicated
 * literally in ≥2 files MUST live in ONE shared module).
 *
 * Channel-specific formatting (FB captions/hashtags, Reddit titles/markdown,
 * place-id lookup, API run loops) stays in the per-channel scripts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCantonResolvers, AGGREGATE_KEY } from '../../build-plugins/shared/cantonResolvers.mjs';
import { peelDanglingClauseTail } from '../../build-plugins/shared/clauseTail.mjs';
import { listSliceFileNames } from './crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cantonSlugFile = JSON.parse(readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

// ── Constants ───────────────────────────────────────────────

export const SITE_URL = 'https://frontaliereticino.ch';

// Meta Graph API base — ONE literal for the four call sites that talk to it
// (the two Facebook schedulers, the Instagram publish layer, the readiness
// prober). It was copy-pasted in each of them, which meant a version bump had
// to be remembered four times and a missed one would fail only for that single
// channel, at its own cron hour. Check
// developers.facebook.com/docs/graph-api/changelog before bumping.
export const GRAPH_API_VERSION = 'v21.0';
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Canton naming ───────────────────────────────────────────
// Canton ISO 2-letter code → Italian display name. Used both as prose (FB
// event/article captions, the events-digest blog article's per-canton
// sections) and, via a hashtag sanitizer downstream, as the tag fallback for
// job/event posts with no dedicated sector/category. Single source (was
// previously duplicated as a spaceless hashtag-only map inside
// schedule-fb-jobs-daily.mjs) — merged here per project rule (a regex/
// constant duplicated literally in ≥2 files MUST live in ONE shared module).
//
// Also includes the two half-canton URL group keys (BASILEA, APPENZELLO —
// see data/canton-url-slugs.json `cantonGroups` / resolveCantonUrlKey in
// scripts/lib/events-utils.mjs) with the generic group name, matching
// build-plugins/jobsSeoPagesPlugin.ts's getCantonDisplayLabel IT entries for
// the same two keys. Callers that group events/jobs by URL section (instead
// of raw ISO code) look these up directly.
export const CANTON_NAME_BY_CODE = {
  AG: 'Argovia', AI: 'Appenzello Interno', AR: 'Appenzello Esterno',
  BE: 'Berna', BL: 'Basilea Campagna', BS: 'Basilea Città',
  FR: 'Friburgo', GE: 'Ginevra', GL: 'Glarona', GR: 'Grigioni',
  JU: 'Giura', LU: 'Lucerna', NE: 'Neuchâtel', NW: 'Nidvaldo',
  OW: 'Obvaldo', SG: 'San Gallo', SH: 'Sciaffusa', SO: 'Soletta',
  SZ: 'Svitto', TG: 'Turgovia', TI: 'Ticino', UR: 'Uri',
  VD: 'Vaud', VS: 'Vallese', ZG: 'Zugo', ZH: 'Zurigo',
  BASILEA: 'Basilea', APPENZELLO: 'Appenzello',
};

// ── Shared display constants ────────────────────────────────
// Single source for constants that would otherwise be copy-pasted across the
// per-channel posters (project rule §6: a constant duplicated literally in ≥2
// files MUST live in ONE shared module so drift is impossible by-construction).

/** job.employmentType → Italian user-facing label. */
export const EMPLOYMENT_TYPE_LABEL = {
  FULL_TIME: 'Tempo pieno',
  PART_TIME: 'Part-time',
  CONTRACTOR: 'Contratto',
  TEMPORARY: 'Temporaneo',
};

/** Italian month names, 0-indexed (January = index 0). */
export const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

// ── Sanitization helpers ────────────────────────────────────

export function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')                  // HTML tags
    // Markdown headings — match at line start (multiline) AND inline
    // (after whitespace) so leftovers from HTML→text flattening like
    // "Avviare... ## Tasks - Si installa..." are also cleaned.
    .replace(/(^|\s)#{1,6}\s+/gm, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // markdown bold
    .replace(/\*([^*]+)\*/g, '$1')             // markdown italic
    .replace(/(^|\s)[-*+]\s+/gm, '$1')         // markdown list bullets
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Section labels that often leak into the body when a job description
// uses HTML headings/lists. Stripped only when they appear at the very start
// of the body, optionally followed by `:` or `-`.
const LEADING_SECTION_LABELS = [
  'descrizione',
  'description',
  'descrição',
  'beschreibung',
  'beschrijving',
  'mansioni',
  'compiti',
  'profilo',
  'profile',
  'profil',
  'requisiti',
  'requirements',
  'about us',
  'chi siamo',
  'who we are',
  'job description',
  'about the job',
  'company description',
  "l'offerta",
  'l offerta',
  'la posizione',
  'le tue mansioni',
  'i tuoi compiti',
  'le tue responsabilità',
];

export function stripLeadingSectionLabel(s) {
  if (!s) return '';
  const sorted = [...LEADING_SECTION_LABELS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^(?:${escaped.join('|')})\\s*[:\\-–—]?\\s+`, 'i');
  return s.replace(re, '').trim();
}

export function stripDiacritics(s) {
  if (!s) return '';
  // Strip U+0300–U+036F (Combining Diacritical Marks) after NFD decomposition.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function truncateBody(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  // Try to truncate at last sentence break before maxLen.
  const window = text.slice(0, maxLen);
  const lastSentence = Math.max(
    window.lastIndexOf('.'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
  );
  if (lastSentence >= Math.floor(maxLen * 0.5)) {
    return window.slice(0, lastSentence + 1).trim();
  }
  // Fall back to last space.
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLen * 0.5)) {
    // Shared peel — a word-boundary cut still stops mid-clause.
    return peelDanglingClauseTail(window.slice(0, lastSpace)) + '…';
  }
  // Reserve one char for the ellipsis so the result never exceeds maxLen.
  // Matters for hard-limited fields (e.g. Reddit's 300-char title cap):
  // appending '…' to a full maxLen window would yield maxLen+1 and be
  // rejected at submit time.
  return window.slice(0, maxLen - 1).trim() + '…';
}

// ── Salary formatting (shared) ──────────────────────────────
// Extracted here so every social channel formats job pay identically. The
// Swiss apostrophe thousands separator + currency/range logic previously lived
// only inside the per-channel Reddit/FB templates; the Telegram digest reuses
// these instead of copy-pasting the same regex a third time (project rule: a
// helper/regex duplicated literally in ≥2 files MUST live in ONE shared module).

/** Round to an integer with the Swiss apostrophe thousands separator: 90000 → "90'000". */
export function formatSwissThousands(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/**
 * Build a human salary label from a job's structured pay, e.g.
 * "CHF 90'000–110'000" or "CHF 90'000". Returns '' when no pay is present.
 * Reads `baseSalary.value.{min,max}Value` first, then flat `salaryMin/Max`.
 */
export function formatJobSalaryLabel(job) {
  const min = job?.baseSalary?.value?.minValue ?? job?.salaryMin;
  const max = job?.baseSalary?.value?.maxValue ?? job?.salaryMax;
  const currency = job?.baseSalary?.currency || 'CHF';
  if (!min && !max) return '';
  if (min && max && min !== max) {
    return `${currency} ${formatSwissThousands(min)}–${formatSwissThousands(max)}`;
  }
  const v = min || max;
  return `${currency} ${formatSwissThousands(v)}`;
}

// ── Job selection ───────────────────────────────────────────

export function recencyTs(job) {
  const candidates = [job?.firstSeenAt, job?.crawledAt, job?.postedDate];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Filter never-posted jobs from `jobs`, sort by recency descending, take
 * top `limit`. Mirrors the selection rule of submit-google-indexing-jobs.
 *
 * @param {Array<object>} jobs
 * @param {Set<string>} postedSet — set of jobIds already posted
 * @param {number} limit
 */
export function selectUnpostedJobs(jobs, postedSet, limit) {
  if (!Array.isArray(jobs)) return [];
  const list = jobs.filter((j) => {
    if (!j || !j.id) return false;
    if (postedSet.has(j.id)) return false;
    // Skip jobs flagged by the translate-pending workflow ONLY when the
    // job's own source locale isn't Italian yet — needsRetranslation means
    // translations FROM the source locale are stale, not that the source
    // locale's own title is bad. A DE/FR-sourced job with no IT translation
    // yet would emit e.g. "Verkäufer*in" as the post headline — wrong
    // language for an Italian audience — but an IT-sourced job flagged only
    // because ITS EN/DE/FR translations are pending has a perfectly good
    // Italian canonical title and must not be dropped (#4715).
    if (j.needsRetranslation === true && (j.sourceLang || 'it') !== 'it') return false;
    return true;
  });
  list.sort((a, b) => recencyTs(b) - recencyTs(a));
  return list.slice(0, Math.max(0, limit | 0));
}

// ── GA4-ranked job dataset (LinkedIn member / Instagram / TikTok posters) ──
// Shared by every "top clicked job of the day" poster — project rule: a
// helper duplicated literally in ≥2 files MUST live in ONE shared module.
// Originally lived only in post-to-linkedin-member.mjs; extracted here when
// the Instagram/TikTok carousel posters needed the identical logic.

/**
 * Italian job-board section slugs: the 24 canton sections, the legacy Ticino
 * one, and the AGGREGATE section.
 *
 * `_AGGREGATE_` resolves to `cerca-lavoro-svizzera` and is easy to forget
 * because it is not in the `cantons` table — omitting it silently dropped
 * every job living under the Swiss-wide board from the ranking.
 *
 * @returns {Set<string>}
 */
export function loadJobSections() {
  try {
    const out = new Set();
    const codes = [...Object.keys(cantonSlugFile.cantons || {}), 'TI', AGGREGATE_KEY];
    for (const code of codes) {
      const section = resolveCantonSection('it', code);
      if (section) out.add(section);
    }
    return out;
  } catch (err) {
    console.warn(`⚠️  could not build the job-section set: ${err.message}`);
    return new Set();
  }
}

/**
 * slug → job record, across every locale slug variant.
 *
 * WHY this is mandatory and not a nicety: under a canton section the URL
 * shape of a job detail page and of a generated SEO landing page are
 * identical (e.g. `/cerca-lavoro-ticino/infermieri/` is a "37 offerte"
 * profession page, not an offer). Membership in the real dataset is the only
 * non-rotting way to tell them apart, so when the dataset is unavailable this
 * returns an empty Map and the caller must skip the job slot rather than
 * guessing.
 *
 * @returns {Map<string, object>}
 */
export function loadJobIndex() {
  /** @type {Map<string, object>} */
  const index = new Map();
  const add = (slug, job) => {
    const s = String(slug || '').trim();
    if (s) index.set(s, job);
  };
  const ingest = (jobs) => {
    for (const job of jobs || []) {
      add(job?.slug, job);
      for (const v of Object.values(job?.slugByLocale || {})) add(v, job);
    }
  };
  try {
    const assembled = path.join(ROOT, 'data', 'jobs.json');
    if (existsSync(assembled)) {
      const parsed = JSON.parse(readFileSync(assembled, 'utf-8'));
      ingest(Array.isArray(parsed) ? parsed : parsed.jobs);
      return index;
    }
    const dir = path.join(ROOT, 'data', 'jobs', 'by-crawler');
    if (existsSync(dir)) {
      for (const file of listSliceFileNames(dir)) {
        try {
          ingest(JSON.parse(readFileSync(path.join(dir, file), 'utf-8')).jobs);
        } catch {
          /* one unreadable crawler file must not void the whole index */
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  could not build the job index: ${err.message}`);
  }
  return index;
}

/** '2026-08-23' → '23/08/2026' (post copy is Italian). Shared by every
 * GA4-ranked poster (LinkedIn member, Instagram, TikTok). */
export function formatDayIt(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(day || '');
}

// ── Carousel caption (Instagram / TikTok) ───────────────────
// Both channels share the same constraint neither Facebook/LinkedIn/Telegram
// have: the caption itself is never a clickable link, so every carousel
// caption ends with the same "link in bio" note instead of a URL.

const CAROUSEL_HASHTAGS = {
  job: '#frontalieri #ticino #lavoro #svizzera #offertedilavoro',
  article: '#frontalieri #ticino #svizzera #italia #lavoro',
  border: '#frontalieri #ticino #dogane #traffico #confine',
};

/**
 * Build the numbered-list caption for a job/article/border carousel post.
 *
 * @param {{ kind: 'job'|'article'|'border', dayLabel: string, picks: Array<{title:string, statValue: string|number}> }} params
 */
export function buildCarouselCaption({ kind, dayLabel, picks }) {
  const isJob = kind === 'job';
  const isBorder = kind === 'border';
  const emoji = isBorder ? '🛂' : isJob ? '💼' : '📰';
  const lead = isBorder
    ? `Le 5 dogane più veloci questa settimana (${dayLabel})`
    : isJob
      ? `I 5 lavori più cliccati di ${dayLabel} su frontaliereticino.ch`
      : `I 5 articoli più letti di ${dayLabel} su frontaliereticino.ch`;
  const hashtags = CAROUSEL_HASHTAGS[kind] || CAROUSEL_HASHTAGS.article;
  const lines = picks.map((p, i) => `${i + 1}. ${p.title} — ${p.statValue}`);

  return [
    `${emoji} ${lead}`,
    '',
    ...lines,
    '',
    '👉 Il link di ogni voce è nella bio.',
    '',
    hashtags,
  ].join('\n');
}

// ── URL building ────────────────────────────────────────────

/**
 * Build the canonical IT-locale job-board URL for a job. Job-board section
 * is canton-aware (resolved from the job's canton/location) — a TI-only
 * literal here meant every non-TI canton job posted to Facebook/Reddit
 * linked back to the wrong (TI) job board. Slug source order:
 * slugByLocale.it → slug. Returns null when the job has no slug.
 */
export function buildJobUrl(job) {
  const slug = job?.slugByLocale?.it || job?.slug;
  if (!slug) return null;
  const section = resolveCantonSection('it', resolveJobCanton(job || {}));
  return `${SITE_URL}/${section}/${slug}/`;
}

/**
 * Append UTM campaign parameters to an absolute site URL.
 *
 * WHY this exists: a link posted to a social channel with no UTM lands in GA4
 * as Direct or as an untagged Referral, so the channel reads as ZERO sessions
 * even while it is actually sending clicks. Measured 2026-08-24: the Telegram
 * channel had posted a jobs digest every day yet GA4 (property 524485296)
 * reported 0 sessions from `t.me` over 30 days — the links carried no UTM.
 *
 * Convention (matches scripts/send-job-alerts.mjs, scripts/newsletter-template.mjs
 * and build-plugins/jobsSeoPagesPlugin.ts): `utm_medium` is the CHANNEL CLASS
 * (email / social / referral) and `utm_source` is the specific IDENTIFIER
 * (job_alert / newsletter / telegram).
 *
 * Never throws: a URL the `URL` parser rejects is returned unchanged, so a
 * malformed input can only cost the attribution, never the link itself.
 * Existing query params on the input are preserved; only the `utm_*` keys
 * passed here are set. Empty/absent fields are skipped rather than written as
 * empty strings (an empty `utm_content=` is noise in GA4 reports).
 *
 * @param {string} url — absolute URL.
 * @param {{ source: string, medium: string, campaign: string, content?: string }} params
 * @returns {string} the tagged URL, or `url` verbatim when it cannot be parsed.
 */
export function withUtm(url, { source, medium, campaign, content } = {}) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const pairs = [
      ['utm_source', source],
      ['utm_medium', medium],
      ['utm_campaign', campaign],
      ['utm_content', content],
    ];
    for (const [key, value] of pairs) {
      const v = String(value ?? '').trim();
      if (v) u.searchParams.set(key, v);
    }
    return u.toString();
  } catch {
    return url;
  }
}

// ── Posted-jobs ledger I/O ──────────────────────────────────

/**
 * Read a posted-jobs ledger from `filePath`. Returns
 * `{schemaVersion:1, posted:[]}` on missing file, malformed JSON, or shape
 * mismatch — never throws. Channel-agnostic: each scheduler passes its own
 * ledger path.
 *
 * @param {string} filePath
 */
export function loadLedger(filePath) {
  try {
    if (!existsSync(filePath)) return { schemaVersion: 1, posted: [] };
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posted)) {
      return { schemaVersion: 1, posted: [] };
    }
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      posted: parsed.posted,
    };
  } catch {
    return { schemaVersion: 1, posted: [] };
  }
}

/**
 * Append entries to the ledger at `filePath` and write it back. Trims to the
 * last `trimLimit` entries. No-op (and never throws) when `entries` is empty
 * or not an array. Channel-agnostic: each scheduler passes its own ledger
 * path and trim cap.
 *
 * @param {string} filePath
 * @param {Array<object>} entries
 * @param {number} [trimLimit=1000]
 */
export function appendLedger(filePath, entries, trimLimit = 1000) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const current = loadLedger(filePath);
  const merged = current.posted.concat(entries);
  const trimmed = merged.slice(Math.max(0, merged.length - trimLimit));
  const out = { schemaVersion: 1, posted: trimmed };
  writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

// ── Article (blog) social helpers ───────────────────────────
// Shared by the manual `post-to-facebook.mjs` CLI and the scheduled
// `schedule-fb-articles-daily.mjs` cron so the FB article caption/URL logic
// lives in ONE place (project rule: a helper/constant duplicated literally in
// ≥2 files MUST be extracted). Job-specific caption/hashtag logic stays in the
// per-job scheduler; this block is the blog-article twin.

// Localized (IT) URL hub slug per article section. Mirrors the `indexSlug.it`
// of `services/articleSections.ts` and the inline hub map in
// `.github/workflows/generate-article.yml`. IT-only because the FB audience
// reads Italian and the canonical og:url is the IT page.
export const ARTICLE_HUB_SLUG_IT = {
  frontaliere: 'articoli-frontaliere',
  svizzera: 'articoli-svizzera',
};

// FB Place ID used to geo-anchor article posts for FB Search discovery.
// 106534719384213 = "Lugano, Switzerland" (verified live) — the canonical
// city for the cross-border / Ticino audience. Kept identical to the value
// the per-deploy poster used so the scheduled poster is behaviourally a
// drop-in replacement.
export const ARTICLE_PLACE_ID = '106534719384213';

// category → user-facing hashtag line / emoji. Default covers articles with no
// (or an unknown) category. Values byte-identical to the historical
// post-to-facebook.mjs maps so captions don't drift after the cutover.
export const ARTICLE_CATEGORY_HASHTAGS = {
  fiscale: '#frontalieri #ticino #tasse #fisco #svizzera #italia',
  pratico: '#frontalieri #ticino #lavoro #svizzera #guidapratica',
  novita: '#frontalieri #ticino #news #svizzera #italia #novità',
  pensione: '#frontalieri #ticino #pensione #AVS #previdenza',
};
export const DEFAULT_ARTICLE_HASHTAGS = '#frontalieri #ticino #lavoro #svizzera #italia';
export const ARTICLE_CATEGORY_EMOJI = {
  fiscale: '📊',
  pratico: '📋',
  novita: '🗞️',
  pensione: '🏦',
};

/**
 * Build the canonical IT-locale article URL. Always trailing-slash (site
 * convention — the no-slash form serves a JS redirect bridge with no OG meta,
 * which the FB crawler can't follow). Returns null when section/slug missing.
 *
 * @param {'frontaliere'|'svizzera'} section
 * @param {string} slugIt
 */
export function buildArticleUrl(section, slugIt) {
  const hub = ARTICLE_HUB_SLUG_IT[section];
  if (!hub || !slugIt) return null;
  return `${SITE_URL}/${hub}/${slugIt}/`;
}

/**
 * Build the FB caption for a blog article. Mirrors the original
 * post-to-facebook.mjs message format byte-for-byte:
 *
 *   {emoji} {ogTitle}
 *
 *   {ogDescription}
 *
 *   👉 Leggi l'articolo completo:
 *
 *   {hashtags}
 *
 * @param {{ ogTitle: string, ogDescription?: string, category?: string }} article
 */
export function buildArticleCaption({ ogTitle, ogDescription, category }) {
  const emoji = ARTICLE_CATEGORY_EMOJI[category] || '📰';
  const hashtags = ARTICLE_CATEGORY_HASHTAGS[category] || DEFAULT_ARTICLE_HASHTAGS;
  const description = ogDescription || '';
  return [
    `${emoji} ${ogTitle}`,
    '',
    description,
    '',
    `👉 Leggi l'articolo completo:`,
    '',
    hashtags,
  ].join('\n').trim();
}

// ── Landing-page pre-flight (immediate posters) ─────────────

const PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * HEAD-check that a just-built landing page is actually live before an
 * immediate (non-scheduled) poster links to it. Immediate posters link to
 * per-comune / per-article pages emitted at build time; if the deploy is
 * slow or retrying, the page can still 404 at click-time — posting anyway
 * would burn the click on a dead link with zero ad impression.
 *
 * HEAD-only (cheap, no body), bounded by a timeout via AbortController (same
 * pattern as `scripts/probe-5xx.mjs`) so one slow/hanging comune can't stall
 * the whole batch — callers should run these concurrently (Promise.allSettled).
 *
 * Fails safe: a clean 4xx OR a network error/timeout both count as "not
 * live" and the caller should skip the post. A missing/ambiguous status
 * (e.g. a minimal test mock, or a 5xx which may just be a transient CDN
 * blip) is treated as live so it never blocks posting on something that
 * isn't actually a dead link.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isLandingPageLive(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || PREFLIGHT_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: controller.signal });
    if (res && typeof res.status === 'number' && res.status >= 400 && res.status < 500) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
