#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
/**
 * Daily Facebook scheduler for Ticino job listings.
 *
 * Picks the most recent N never-posted jobs from `data/jobs.json` (or
 * `public/data/jobs.json` as fallback), schedules one Facebook Page post
 * per job over the next 24 h via Graph API `scheduled_publish_time`, and
 * tracks posted jobs in `data/fb-posted-jobs.json` to dedup across runs.
 *
 * Slot allocation is deterministic — minutes inside the hour are fixed:
 *   volume=24  → :05                          (1/hour)
 *   volume=72  → :05 :25 :45                  (1/20min)
 *   volume=144 → :05 :15 :25 :35 :45 :55      (1/10min)
 *
 * The script does a pre-flight `GET /{pageId}/scheduled_posts` to skip
 * minutes that are already occupied by other schedulers (e.g. the article
 * cron at :07 :37) or by manual posts.
 *
 * Usage:
 *   FB_PAGE_ID=… FB_PAGE_ACCESS_TOKEN=… node scripts/schedule-fb-jobs-daily.mjs
 *
 * Env:
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN — Graph API credentials (required for
 *     non-dry-run mode).
 *   FB_JOB_VOLUME=1|24|72|144  — daily post count, default 24 (one per hour).
 *   DRY_RUN=1                — log payloads, no API call.
 *
 * Soft-fail: every error path logs and `process.exit(0)`. The workflow's
 * commit step is gated on the data file mutating, so a no-op run leaves
 * git untouched.
 */

import { readFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './lib/read-large-json.mjs';
import { facebookUrl, FACEBOOK_CAMPAIGN_JOB } from './lib/facebook-links.mjs';
import { SOCIAL_REDIRECT_ORIGIN, socialRedirectKey } from './lib/social-redirect-links.mjs';
import { isGeneratedSocialCopyMode, loadSocialCopyPack, releaseUnpublishedSocialCopyAssignmentBestEffort, selectSocialCopyForPublish, socialCopyLedgerFields, socialCopyTrackingContent } from './lib/social-copy-pack.mjs';
import { getItalianJobTitle } from '../build-plugins/shared/italianJobTitle.mjs';
import { JOB_OG_IMAGE_VERSION } from '../build-plugins/shared/jobOgImageVersion.mjs';
import {
  markSocialPublishReservationPublished,
  refreshSocialPublishReservation,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from './lib/social-publish-reservations.mjs';
import { isAmbiguousSocialPublishResponse } from './lib/social-publish-outcome.mjs';
import { reconcileFacebookScheduledPosts } from './lib/facebook-scheduled-publish-reconciliation.mjs';

import {
  stripHtml,
  stripLeadingSectionLabel,
  stripDiacritics,
  truncateBody,
  selectUnpostedJobs,
  buildJobUrl,
  loadLedger,
  appendLedger,
  CANTON_NAME_BY_CODE,
  EMPLOYMENT_TYPE_LABEL,
  GRAPH_API,
} from './lib/social-post-utils.mjs';

// Re-export the channel-agnostic helpers so existing importers (e.g. the FB
// scheduler test) can keep importing them directly from this module.
export {
  selectUnpostedJobs,
  buildJobUrl,
} from './lib/social-post-utils.mjs';

// ── Constants ───────────────────────────────────────────────

// Graph API base: one shared literal in social-post-utils.mjs (see its note).
const GRAPH_BASE = GRAPH_API;

// FB requires scheduled_publish_time ≥ 10 minutes in the future.
const MIN_LEAD_SECONDS = 600;

// Hard FB limit on /feed `message` field. We aim much lower (~280 char).
const FB_MESSAGE_HARD_LIMIT = 5000;
const FACEBOOK_JOB_IMAGE_WIDTH = 1080;
const FACEBOOK_JOB_IMAGE_HEIGHT = 1350;
const FACEBOOK_JOB_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const FACEBOOK_JOB_IMAGE_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Posted-jobs ledger trim cap.
const POSTED_TRIM_LIMIT = 1000;

// Volume → minute-of-hour list mapping.
// `1` is a smoke-test volume: schedules a single post on the next :05.
const VOLUME_MINUTES = {
  1: [5],
  24: [5],
  72: [5, 25, 45],
  144: [5, 15, 25, 35, 45, 55],
};

// Keep enough Graph API work in flight to avoid the serial scheduler
// consuming the whole workflow budget, without turning a daily batch into a
// rate-limit burst. The ledger write remains synchronous after each success,
// so partial progress is still durable if a later request fails.
export const FB_SCHEDULE_CONCURRENCY = 4;

// employmentType → user-facing label now lives in ./lib/social-post-utils.mjs
// (EMPLOYMENT_TYPE_LABEL) and is imported above — was duplicated verbatim in the
// Reddit/Telegram templates too (project rule §6: extract, don't copy-paste).

// Canton ISO 2-letter code → full name (used for the fallback hashtag
// when a job has no `sector` field). Italian/local form preferred so
// the hashtag matches how Italian speakers search. Sourced from
// ./lib/social-post-utils.mjs (shared with the events poster, §6) —
// `sanitizeHashtagWord` strips spaces/diacritics so the prose-form map
// there produces the identical spaceless hashtag this used to hardcode.
// Coarse role-keyword whitelist for hashtag extraction. First match in the
// title (case-insensitive, word-boundary) wins.
const ROLE_KEYWORDS = [
  'Sviluppatore', 'Programmatore', 'Developer', 'Engineer', 'Ingegnere',
  'Manager', 'Direttore', 'Responsabile', 'Tecnico', 'Operaio',
  'Impiegato', 'Magazziniere', 'Autista', 'Cuoco', 'Cameriere',
  'Infermiere', 'Medico', 'Educatore', 'Insegnante', 'Architetto',
  'Contabile', 'Consulente', 'Venditore', 'Commesso', 'Receptionist',
  'Designer', 'Analyst', 'Analista', 'Project', 'Product',
  'Data', 'Marketing', 'Sales', 'HR', 'Logistica',
  'Elettricista', 'Idraulico', 'Falegname', 'Muratore', 'Saldatore',
  'Meccanico', 'Operatore', 'Assistente',
];

// ── Path helpers ────────────────────────────────────────────

function defaultRepoRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

function jobsPath(repoRoot) {
  // Prefer public/data (what the deploy publishes), fall back to data/ (the
  // agent worktree only has the latter for tests).
  const pub = resolve(repoRoot, 'public', 'data', 'jobs.json');
  if (existsSync(pub)) return pub;
  return resolve(repoRoot, 'data', 'jobs.json');
}

function postedPath(repoRoot) {
  return resolve(repoRoot, 'data', 'fb-posted-jobs.json');
}

function placeIdsPath(repoRoot) {
  return resolve(repoRoot, 'data', 'fb-place-ids.json');
}

// ── Sanitization helpers ────────────────────────────────────
// Generic sanitizers (stripHtml, stripLeadingSectionLabel, stripDiacritics)
// live in ./lib/social-post-utils.mjs. FB-specific helpers stay below.

function sanitizeHashtagWord(s) {
  if (!s) return '';
  // Drop diacritics, keep only [A-Za-z0-9], no spaces inside tag.
  return stripDiacritics(s).replace(/[^A-Za-z0-9]/g, '');
}

// ── Pure utilities (exported for tests) ─────────────────────

/**
 * Pick `volume` future timestamps spread across the next 24 h on the
 * fixed minute slots for that volume. Skips occupied minute-timestamps.
 *
 * @param {number} volume — 24 | 72 | 144
 * @param {Iterable<number>} occupied — unix-seconds already scheduled
 * @param {Date|number} now — reference clock (Date or unix-seconds)
 * @returns {number[]} unix-seconds, sorted ascending
 */
export function pickNextSlots(volume, occupied, now) {
  // Unknown volume → fall back to the 24/day plan (1 post per hour at :05).
  const effectiveVolume = VOLUME_MINUTES[volume] ? volume : 24;
  const minutes = VOLUME_MINUTES[effectiveVolume];
  const nowMs = now instanceof Date ? now.getTime() : now * 1000;
  const minStartMs = nowMs + MIN_LEAD_SECONDS * 1000;

  const occupiedSet = new Set();
  for (const t of occupied || []) occupiedSet.add(Number(t));

  const slots = [];
  // Walk forward from current hour; first valid hour is the one whose
  // minute slot is ≥ minStartMs. Cap walk at 36 hours to avoid runaway
  // when minute slots are all near the end of the hour.
  const baseHour = new Date(nowMs);
  baseHour.setUTCSeconds(0, 0);
  baseHour.setUTCMinutes(0);

  for (let hourOffset = 0; hourOffset < 36 && slots.length < effectiveVolume; hourOffset++) {
    for (const minute of minutes) {
      if (slots.length >= effectiveVolume) break;
      const slotMs = baseHour.getTime() + (hourOffset * 60 + minute) * 60_000;
      if (slotMs < minStartMs) continue;
      const slotSec = Math.floor(slotMs / 1000);
      if (occupiedSet.has(slotSec)) continue;
      slots.push(slotSec);
    }
  }
  return slots;
}

/**
 * Build the FB caption for a single job. ≤ 5000 chars (FB limit).
 *
 * Format:
 *   💼 [TITLE] · [COMPANY]
 *   📍 [CITY]  💰 CHF [SALARY]  📋 [employmentType]
 *
 *   [body, ≤ ~140 chars, sentence-truncated]
 *
 *   #tag1 #tag2 ...
 */
export function buildJobCaption(job, { socialCopy } = {}) {
  // Never publish a missing or source-language Italian title. The scheduler
  // filters those offers before allocating slots.
  const title = getItalianJobTitle(job);
  if (!title) throw new Error('Facebook job posts require a translated Italian title');
  const company = (job?.hiringOrganization?.name || job?.company || '').trim();
  const city = (job?.jobLocation?.address?.addressLocality
    || job?.location
    || '').trim();

  // Header line 1 — title · company
  const headerTitle = company
    ? `💼 ${title} · ${company}`
    : `💼 ${title}`;

  // Header line 2 — city, salary, employment type (only present chunks).
  const chunks = [];
  if (city) chunks.push(`📍 ${city}`);
  const salary = formatSalary(job);
  if (salary) chunks.push(`💰 ${salary}`);
  const empLabel = EMPLOYMENT_TYPE_LABEL[job?.employmentType];
  if (empLabel) chunks.push(`📋 ${empLabel}`);
  const headerMeta = chunks.join('  ');

  // Body
  // Keep source-language application descriptions out of Italian audience
  // posts when the Italian localization is unavailable.
  const rawBody = job?.descriptionByLocale?.it || '';
  const body = truncateBody(stripLeadingSectionLabel(stripHtml(rawBody)), 140);

  // Hashtags
  const hashtags = buildJobHashtags(job);

  const generatedCopy = isGeneratedSocialCopyMode(socialCopy?.copyMode) ? socialCopy : null;
  const parts = generatedCopy ? [generatedCopy.hook, '', headerTitle] : [headerTitle];
  if (headerMeta) parts.push(headerMeta);
  if (body) parts.push('', body);
  if (generatedCopy) parts.push('', '👉 ' + generatedCopy.cta);
  if (hashtags) parts.push('', hashtags);

  let out = parts.join('\n');
  if (out.length > FB_MESSAGE_HARD_LIMIT) {
    // Defensive: should never happen with a 140-char body and 5 short tags,
    // but if a description has surprise content, hard-cap.
    out = out.slice(0, FB_MESSAGE_HARD_LIMIT);
  }
  return out;
}

function formatSalary(job) {
  const min = job?.baseSalary?.value?.minValue ?? job?.salaryMin;
  const max = job?.baseSalary?.value?.maxValue ?? job?.salaryMax;
  const currency = job?.baseSalary?.currency || 'CHF';
  if (!min && !max) return '';
  if (min && max && min !== max) {
    return `${currency} ${formatNum(min)}–${formatNum(max)}`;
  }
  const v = min || max;
  return `${currency} ${formatNum(v)}`;
}

function formatNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  // Thousand separator with apostrophe (Swiss style).
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/**
 * Up to 5 hashtags. Always ends with #frontalieri #lavoroticino. Adds
 * #[Role] (if a role keyword matches the title), #[City] (first word of
 * location), #[Sector] (or #Ticino fallback). Sanitizes diacritics + spaces.
 */
export function buildJobHashtags(job) {
  const tags = [];

  // Role
  const title = getItalianJobTitle(job);
  for (const kw of ROLE_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(title)) {
      const sanitized = sanitizeHashtagWord(kw);
      // Capitalize first letter for nicer display.
      const formatted = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
      if (formatted) tags.push(`#${formatted}`);
      break;
    }
  }

  // City
  const cityRaw = (job?.jobLocation?.address?.addressLocality
    || job?.location
    || '').trim();
  if (cityRaw) {
    const firstWord = cityRaw.split(/[\s,]+/)[0] || '';
    const cityTag = sanitizeHashtagWord(firstWord);
    if (cityTag) tags.push(`#${cityTag}`);
  }

  // Sector (fallback to canton, then Ticino).
  // Many production jobs are in non-Ticino cantons (ZH, AG, GR, …). The
  // hard-coded `#Ticino` fallback was misleading for, e.g., a Pfungen-ZH
  // posting. Now we prefer sector → canton (full name) → Ticino default.
  const sectorRaw = (job?.sector || '').trim();
  let sectorTag = sectorRaw ? sanitizeHashtagWord(sectorRaw) : '';
  if (!sectorTag) {
    const cantonName = CANTON_NAME_BY_CODE[job?.canton] || '';
    sectorTag = cantonName ? sanitizeHashtagWord(cantonName) : 'Ticino';
  }
  if (sectorTag) tags.push(`#${sectorTag}`);

  // Always-on
  tags.push('#frontalieri');
  tags.push('#lavoroticino');

  // Dedupe (case-insensitive) and cap at 5.
  const seen = new Set();
  const deduped = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(t);
    if (deduped.length >= 5) break;
  }
  return deduped.join(' ');
}

// ── Posted-jobs ledger I/O ──────────────────────────────────

/**
 * Read `data/fb-posted-jobs.json`. Returns `{schemaVersion:1, posted:[]}`
 * when the file is missing; malformed, schema-invalid, or unreadable ledgers
 * throw so callers cannot lose deduplication state and republish old content.
 * Fixed-path wrapper around the generic `loadLedger`.
 */
export function loadPosted(repoRoot) {
  return loadLedger(postedPath(repoRoot));
}

/**
 * Load FB Place ID map from `data/fb-place-ids.json`. Returns `{}` on
 * missing file or malformed JSON — never throws. Shape:
 *   { schemaVersion, places: { "Lugano": { id, name }, ... } }
 * Returned shape: flat `{ "Lugano": "106534719384213", ... }` for fast lookup.
 */
export function loadPlaceIds(repoRoot) {
  const file = placeIdsPath(repoRoot);
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const places = parsed?.places && typeof parsed.places === 'object' ? parsed.places : null;
    if (!places) return {};
    const out = {};
    for (const [name, value] of Object.entries(places)) {
      if (value && typeof value.id === 'string') out[name] = value.id;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve a job's `location` field to a FB Place ID.
 * Tries exact match first, then strips a trailing parenthesized canton
 * suffix (e.g. "Aesch (ZH)" → "Aesch"). Returns null when no match.
 * Pure: takes the flat lookup map produced by `loadPlaceIds`.
 */
// French/English/Italian aliases for Swiss municipalities whose canonical
// name in the BFS list is the German/native form. Crawler `location`
// fields often arrive in alternate languages (e.g. job boards from the
// Romandy serve "Geneva" / "Genève", not the BFS entry "Genève" exactly).
const SWISS_CITY_ALIASES = {
  Geneva: 'Genève',
  Genf: 'Genève',
  Berne: 'Bern',
  Berna: 'Bern',
  Basle: 'Basel',
  Bâle: 'Basel',
  Basilea: 'Basel',
  Lucerne: 'Luzern',
  Lucerna: 'Luzern',
  Zurich: 'Zürich',
  Zurigo: 'Zürich',
  Zuerich: 'Zürich',
  Coira: 'Chur',
  Coire: 'Chur',
  Sankt: 'St. Gallen', // sometimes "Sankt Gallen"
  'Sankt Gallen': 'St. Gallen',
  'Saint-Gall': 'St. Gallen',
  'San Gallo': 'St. Gallen',
  Sion: 'Sion',
  Sitten: 'Sion',
  Bienne: 'Biel/Bienne',
  Biel: 'Biel/Bienne',
  Lozanna: 'Lausanne',
  Losanna: 'Lausanne',
  Friburgo: 'Fribourg',
  Freiburg: 'Fribourg',
  Soletta: 'Solothurn',
  Sciaffusa: 'Schaffhausen',
  Turgovia: 'Frauenfeld', // canton TG capital — proxy
};

export function lookupPlaceId(location, placeIds) {
  if (!location || !placeIds) return null;
  const tryLookup = (name) => {
    if (!name) return null;
    if (placeIds[name]) return placeIds[name];
    const alias = SWISS_CITY_ALIASES[name];
    if (alias && placeIds[alias]) return placeIds[alias];
    return null;
  };
  // 1. Direct match.
  let hit = tryLookup(location);
  if (hit) return hit;
  // 2. Strip trailing " (XX)" canton suffix → "Aesch (BL)" → "Aesch".
  const noParens = location.replace(/\s*\([^)]*\)\s*$/, '').trim();
  hit = tryLookup(noParens);
  if (hit) return hit;
  // 3. Strip trailing ", <region>" (Italian + English suffixes commonly
  //    leaked by job boards: "Geneva, Switzerland", "Lugano, Ticino",
  //    "Bern, Schweiz", "Basel, Switzerland").
  const noTail = location.split(',')[0].trim();
  hit = tryLookup(noTail);
  if (hit) return hit;
  // 4. Strip trailing "/<alt-name>" forms ("Biel/Bienne" → "Biel"). The
  //    Biel/Bienne entry is the canonical BFS form, so we try BOTH the
  //    pre-slash and the post-slash token, with alias fallback.
  for (const part of location.split('/')) {
    hit = tryLookup(part.trim());
    if (hit) return hit;
  }
  // 5. Pick the FIRST plausible city-shaped token from a composite
  //    location like "EMEA · CHE · Stabio · VF Campus VF1": split on
  //    `·`, `-`, ` ` (space) and try each up to length 30. Prevents
  //    burning thousands of tokens when the location is junk.
  const tokens = location.split(/[·\-\s]+/).map((t) => t.trim()).filter((t) => t.length >= 3 && t.length <= 30);
  for (const t of tokens) {
    hit = tryLookup(t);
    if (hit) return hit;
  }
  return null;
}

/**
 * Append entries to the ledger and write it back. Trims to last
 * POSTED_TRIM_LIMIT entries. Each entry: {id, url, ts, fbPostId}.
 * Fixed-path wrapper around the generic `appendLedger`.
 */
export function appendPosted(repoRoot, entries) {
  appendLedger(postedPath(repoRoot), entries, POSTED_TRIM_LIMIT);
}

function savePosted(repoRoot, posted) {
  if (!Array.isArray(posted)) throw new Error('Facebook posted ledger rows must be an array');
  const file = postedPath(repoRoot);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: 1,
      posted: posted.slice(-POSTED_TRIM_LIMIT),
    }, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// ── Pre-flight: occupied scheduled-posts ────────────────────

async function fetchScheduledPosts({ pageId, token, fetchImpl, log }) {
  // Meta limits each page to 100 rows. Recovery needs every accepted post,
  // including entries past the first page when a 144-post batch was queued.
  // Photo attachments hold Facebook media; the tracked URL remains in message.
  const endpoint = new URL(`${GRAPH_BASE}/${pageId}/scheduled_posts`);
  endpoint.searchParams.set('fields', 'id,scheduled_publish_time,attachments,message');
  endpoint.searchParams.set('limit', '100');
  endpoint.searchParams.set('access_token', token);
  const expectedPath = endpoint.pathname;
  const seenPages = new Set();
  const posts = [];
  const occupied = new Set();
  let nextUrl = endpoint;
  let pageCount = 0;
  try {
    while (nextUrl) {
      if (pageCount >= 100) throw new Error('scheduled_posts pagination exceeded 100 pages');
      if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'graph.facebook.com'
        || nextUrl.pathname !== expectedPath || nextUrl.username || nextUrl.password) {
        throw new Error('scheduled_posts pagination returned an unexpected URL');
      }
      nextUrl.searchParams.set('access_token', token);
      const requestUrl = nextUrl.toString();
      if (seenPages.has(requestUrl)) throw new Error('scheduled_posts pagination repeated a page');
      seenPages.add(requestUrl);

      const res = await fetchImpl(requestUrl);
      const data = await res.json();
      if (!res.ok) {
        log('⚠️', `pre-flight scheduled_posts page ${pageCount + 1} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
        return { ok: false, posts, occupied };
      }
      const list = Array.isArray(data?.data) ? data.data : [];
      posts.push(...list);
      for (const item of list) {
        const ts = Number(item?.scheduled_publish_time);
        if (Number.isFinite(ts) && ts > 0) occupied.add(ts);
      }
      pageCount += 1;
      const next = data?.paging?.next;
      if (!next) {
        nextUrl = null;
      } else {
        nextUrl = new URL(next);
      }
    }
    log('ℹ️', `pre-flight: ${posts.length} scheduled post(s) across ${pageCount} page(s); ${occupied.size} scheduled_publish_time slots occupied`);
    return { ok: true, posts, occupied };
  } catch (err) {
    log('⚠️', `pre-flight scheduled_posts failed on page ${pageCount + 1}: ${err.message}`);
    return { ok: false, posts, occupied };
  }
}

function unwrapFacebookLink(value) {
  let candidate = String(value || '');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (url.hostname === 'l.facebook.com' && url.pathname === '/l.php') {
      candidate = url.searchParams.get('u') || '';
      continue;
    }
    return url;
  }
  return null;
}

function scheduledFacebookJobLink(post) {
  const attachments = Array.isArray(post?.attachments?.data) ? post.attachments.data : [];
  const captionLinks = String(post?.message || '').match(/https?:\/\/[^\s<>"']+/giu) || [];
  const linkCandidates = [
    ...attachments.map((attachment) => attachment?.target?.url || attachment?.url),
    ...captionLinks.map((candidate) => candidate.replace(/[),.;!?]+$/u, '')),
  ];
  for (const candidate of linkCandidates) {
    const link = unwrapFacebookLink(candidate);
    if (!link || link.origin !== SOCIAL_REDIRECT_ORIGIN) continue;
    const routeMatch = /^\/social\/r\/([a-f0-9]{20})\/$/u.exec(link.pathname);
    if (!routeMatch || link.searchParams.size !== 5) continue;
    const target = link.searchParams.get('to') || '';
    const source = link.searchParams.get('utm_source') || '';
    const medium = link.searchParams.get('utm_medium') || '';
    const campaign = link.searchParams.get('utm_campaign') || '';
    const content = link.searchParams.get('utm_content') || '';
    if (link.searchParams.getAll('to').length !== 1
      || link.searchParams.getAll('utm_source').length !== 1
      || link.searchParams.getAll('utm_medium').length !== 1
      || link.searchParams.getAll('utm_campaign').length !== 1
      || link.searchParams.getAll('utm_content').length !== 1
      || source !== 'facebook' || medium !== 'social' || campaign !== FACEBOOK_CAMPAIGN_JOB
      || socialRedirectKey({ target, source, medium, campaign, content }) !== routeMatch[1]) continue;

    const marker = content.indexOf('--cp');
    const jobId = marker >= 0 ? content.slice(0, marker) : content;
    if (!target || target.length > 3072 || !target.startsWith('/') || target.startsWith('//')
      || /[\\\u0000-\u001f\u007f]/u.test(target)) continue;
    if (!jobId || jobId.length > 256 || /[\u0000-\u001f\u007f]/u.test(jobId)
      || (marker >= 0 && !/^--cp[a-f0-9]{16}-/u.test(content.slice(marker)))
      || !target.startsWith('/cerca-lavoro-') || !target.endsWith('/')) continue;
    let destination;
    try {
      destination = new URL(target, SOCIAL_REDIRECT_ORIGIN);
    } catch {
      continue;
    }
    if (destination.origin !== SOCIAL_REDIRECT_ORIGIN || destination.username || destination.password
      || [...destination.searchParams.keys()].some((key) => key.toLowerCase().startsWith('utm_'))) continue;
    return { jobId, url: destination.toString() };
  }
  return null;
}

function recoverScheduledJobLedgerRows(posts, existingRows, now) {
  const knownPostIds = new Set(existingRows.map((row) => String(row?.fbPostId || '')).filter(Boolean));
  const knownJobIds = new Set(existingRows.map((row) => String(row?.id || '')).filter(Boolean));
  const nowIso = new Date(now).toISOString();
  const recovered = [];
  for (const post of posts) {
    const postId = String(post?.id || '').trim();
    const scheduledAt = Number(post?.scheduled_publish_time);
    const scheduledAtMs = scheduledAt < 10_000_000_000 ? scheduledAt * 1000 : scheduledAt;
    if (!postId || knownPostIds.has(postId) || !Number.isFinite(scheduledAtMs) || scheduledAtMs <= 0) continue;
    const tracked = scheduledFacebookJobLink(post);
    if (!tracked || knownJobIds.has(tracked.jobId)) continue;
    recovered.push({
      id: tracked.jobId,
      url: tracked.url,
      ts: nowIso,
      fbPostId: postId,
      scheduledFor: new Date(scheduledAtMs).toISOString(),
    });
    knownPostIds.add(postId);
    knownJobIds.add(tracked.jobId);
  }
  return recovered;
}

// ── jobs.json loader ────────────────────────────────────────

function loadJobs(repoRoot, log) {
  const file = jobsPath(repoRoot);
  try {
    if (!existsSync(file)) {
      log('⚠️', `jobs.json not found at ${file}`);
      return [];
    }
    const parsed = readJsonFile(file);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log('⚠️', `failed to read jobs.json: ${err.message}`);
    return [];
  }
}

// ── FB Graph OG rescrape (shared by the jobs + events schedulers) ──
//
function expectedJobOgImagePath(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segments.at(-1);
    return slug ? `/og/jobs/${slug}.webp` : null;
  } catch {
    return null;
  }
}

// Force-rescrape OG metadata for a URL, then verify the scrape actually
// resolved the expected image (GET without scrape=true, check og_object.image)
// before considering the card ready. Optional strict checks let the jobs
// scheduler reject generic or archived offer previews while event posts retain
// their existing best-effort behavior.
export async function rescrapeOgAndVerify(fetchImpl, url, token, warn = () => {}, options = {}) {
  const scrapeUrl = `${GRAPH_BASE}/?id=${encodeURIComponent(url)}&scrape=true&access_token=${encodeURIComponent(token)}`;
  const checkFields = encodeURIComponent('og_object{image,title}');
  const checkUrl = `${GRAPH_BASE}/?id=${encodeURIComponent(url)}&fields=${checkFields}&access_token=${encodeURIComponent(token)}`;
  const backoffMs = [0, 1500, 3000];
  const fallbackTitlePattern = /offerta\s+non\s+(?:verificata|trovata|disponibile)|job\s+not\s+found|position\s+not\s+verified|offre\s+(?:introuvable|non\s+v[ée]rifi[ée]e)|stelle\s+nicht\s+gefunden/i;
  for (let i = 0; i < backoffMs.length; i += 1) {
    if (backoffMs[i]) await new Promise((r) => setTimeout(r, backoffMs[i]));
    try {
      const scrapeResponse = await fetchImpl(scrapeUrl, { method: 'POST' });
      if (!scrapeResponse.ok) continue;
      const scrapeData = typeof scrapeResponse.clone === 'function'
        ? await scrapeResponse.clone().json().catch(() => null)
        : null;
      if (scrapeData?.error) continue;
      const res = await fetchImpl(checkUrl);
      if (!res.ok) continue;
      const data = await res.json();
      const image = data?.og_object?.image;
      const images = Array.isArray(image) ? image : image ? [image] : [];
      const matchingImageUrl = images
        .map((candidate) => typeof candidate === 'string' ? candidate : candidate?.url)
        .find((imageUrl) => {
          if (!imageUrl) return false;
          try {
            const parsedImageUrl = new URL(imageUrl);
            if (options.requiredImagePath && parsedImageUrl.pathname !== options.requiredImagePath) return false;
            if (options.requiredImageVersion
              && parsedImageUrl.searchParams.get('v') !== options.requiredImageVersion) return false;
            if (options.requireTrustedImageHost
              && !isTrustedFacebookJobImageUrl(imageUrl, options.requiredImagePath, options.requiredImageVersion)) return false;
            return true;
          } catch {
            return false;
          }
        });
      const hasExpectedImage = options.requiredImagePath ? Boolean(matchingImageUrl) : images.length > 0;
      const title = String(data?.og_object?.title || '');
      const isFallbackOffer = options.rejectFallbackTitle && fallbackTitlePattern.test(title);
      if (images.length > 0 && hasExpectedImage && !isFallbackOffer) {
        return options.returnImageUrl ? matchingImageUrl : true;
      }
    } catch {
      /* transient — retried by the loop, best-effort overall */
    }
  }
  warn('⚠️', `OG rescrape unverified for ${url}`);
  return false;
}

function isTrustedFacebookJobImageUrl(value, requiredImagePath, requiredImageVersion = JOB_OG_IMAGE_VERSION) {
  try {
    const imageUrl = new URL(value);
    return imageUrl.protocol === 'https:'
      && imageUrl.hostname === 'cdn.frontaliereticino.ch'
      && imageUrl.pathname === requiredImagePath
      && imageUrl.searchParams.get('v') === requiredImageVersion;
  } catch {
    return false;
  }
}

function buildFacebookJobPhotoMessage(message, link) {
  const linkLine = `🔗 Scopri l’offerta: ${link}`;
  const availableBodyLength = Math.max(0, FB_MESSAGE_HARD_LIMIT - linkLine.length - 2);
  const body = String(message || '').slice(0, availableBodyLength).trimEnd();
  return body ? `${body}\n\n${linkLine}` : linkLine;
}

async function facebookJobImageAsJpeg(fetchImpl, imageUrl, requiredImagePath) {
  if (!isTrustedFacebookJobImageUrl(imageUrl, requiredImagePath)) {
    throw new Error('Facebook job image URL did not match the verified Italian offer image');
  }
  const response = await fetchImpl(imageUrl);
  if (!response.ok) throw new Error(`job image fetch returned HTTP ${response.status}`);
  const contentType = String(response.headers?.get?.('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType && contentType !== 'image/webp') {
    throw new Error(`job image has unsupported content type ${contentType}`);
  }
  const source = Buffer.from(await response.arrayBuffer());
  if (source.length === 0 || source.length > FACEBOOK_JOB_IMAGE_MAX_BYTES) {
    throw new Error(`job image size is invalid (${source.length} bytes)`);
  }

  const sharpModule = await import('sharp');
  const sharp = sharpModule.default;
  const metadata = await sharp(source, { failOn: 'error' }).metadata();
  if (metadata.format !== 'webp'
    || metadata.width !== FACEBOOK_JOB_IMAGE_WIDTH
    || metadata.height !== FACEBOOK_JOB_IMAGE_HEIGHT) {
    throw new Error('job image is not the expected 1080×1350 WebP card');
  }
  const jpeg = await sharp(source, { failOn: 'error' }).jpeg({ quality: 90 }).toBuffer();
  if (jpeg.length === 0 || jpeg.length > FACEBOOK_JOB_IMAGE_MAX_UPLOAD_BYTES) {
    throw new Error(`converted Facebook job image size is invalid (${jpeg.length} bytes)`);
  }
  return jpeg;
}

async function uploadUnpublishedFacebookPhoto({ fetchImpl, pageId, token, imageUrl, requiredImagePath }) {
  const jpeg = await facebookJobImageAsJpeg(fetchImpl, imageUrl, requiredImagePath);
  const form = new FormData();
  form.append('source', new Blob([jpeg], { type: 'image/jpeg' }), 'offerta-lavoro.jpg');
  form.append('published', 'false');
  form.append('access_token', token);
  const response = await fetchImpl(`${GRAPH_BASE}/${pageId}/photos`, { method: 'POST', body: form });
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* handled as a failed photo upload below */
  }
  if (!response.ok || !data?.id) {
    throw new Error(`Facebook photo upload failed (HTTP ${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return String(data.id);
}

async function deleteUnpublishedFacebookPhoto(fetchImpl, photoId, token, warn) {
  const url = new URL(`${GRAPH_BASE}/${encodeURIComponent(photoId)}`);
  url.searchParams.set('access_token', token);
  try {
    const response = await fetchImpl(url.toString(), { method: 'DELETE' });
    if (!response.ok) warn(`⚠️ could not remove unpublished Facebook photo ${photoId} (HTTP ${response.status})`);
  } catch (error) {
    warn(`⚠️ could not remove unpublished Facebook photo ${photoId}: ${error.message}`);
  }
}

// ── Main entry ──────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Date} [opts.now]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(options: object) => Promise<string>} [opts.uploadFacebookPhotoImpl]
 * @param {string} [opts.repoRoot]
 * @param {(...a: unknown[]) => void} [opts.log]
 * @param {(...a: unknown[]) => void} [opts.warn]
 * @param {(options: object) => Promise<object|null>} [opts.selectSocialCopyForPublishImpl]
 * @param {(copy: object) => Promise<boolean>} [opts.releaseSocialCopyAssignmentImpl]
 * @param {{ reserveBatch: Function, markPublished: Function, release: Function }} [opts.socialPublishReservations]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const uploadFacebookPhotoImpl = opts.uploadFacebookPhotoImpl || uploadUnpublishedFacebookPhoto;
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;
  const socialCopyPack = opts.socialCopyPack || loadSocialCopyPack({
    onWarning: (message) => warn('⚠️', message),
  });
  const selectSocialCopy = opts.selectSocialCopyForPublishImpl || selectSocialCopyForPublish;
  const releaseSocialCopy = opts.releaseSocialCopyAssignmentImpl || undefined;
  const socialPublishReservations = opts.socialPublishReservations || {
    reserveBatch: reserveSocialPublishBatch,
    markPublished: markSocialPublishReservationPublished,
    release: releaseSocialPublishReservation,
    refresh: refreshSocialPublishReservation,
  };

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const volumeRaw = Number(env.FB_JOB_VOLUME || 24);
  const volume = VOLUME_MINUTES[volumeRaw] ? volumeRaw : 24;
  const pageId = env.FB_PAGE_ID;
  const token = env.FB_PAGE_ACCESS_TOKEN;
  const reconcileOnly = env.FB_JOB_RECONCILE_ONLY === '1' || env.FB_JOB_RECONCILE_ONLY === 'true';

  log('🗓️', `FB jobs daily scheduler — volume=${volume}, dry=${dryRun}`);

  // 1. Load jobs + ledger
  const jobs = reconcileOnly ? [] : loadJobs(repoRoot, log);
  const ledger = loadPosted(repoRoot);
  const scheduledQueue = !dryRun && pageId && token && typeof fetchImpl === 'function'
    && (reconcileOnly || jobs.length > 0)
    ? await fetchScheduledPosts({ pageId, token, fetchImpl, log })
    : { ok: false, posts: [], occupied: new Set() };
  const recoveredRows = recoverScheduledJobLedgerRows(scheduledQueue.posts, ledger.posted, now);
  if (recoveredRows.length > 0) {
    appendPosted(repoRoot, recoveredRows);
    ledger.posted = loadPosted(repoRoot).posted;
    log('ℹ️', `recovered ${recoveredRows.length} accepted Facebook job post(s) into the ledger`);
  }
  const reconciliation = dryRun || reconcileOnly
    ? { checked: 0, reconciled: 0, pending: 0, uncertain: 0 }
    : await reconcileFacebookScheduledPosts({
      rows: ledger.posted,
      pageId,
      token,
      fetchImpl,
      now,
      markPublished: socialPublishReservations.markPublished,
      refreshReservation: socialPublishReservations.refresh,
      saveRows: (rows) => savePosted(repoRoot, rows),
      log,
      warn,
    });
  if (reconcileOnly) {
    const queueUncertain = scheduledQueue.ok ? 0 : 1;
    const uncertain = reconciliation.uncertain + queueUncertain;
    if (queueUncertain) warn('⚠️ Facebook scheduled-post recovery could not read the current Meta queue');
    log('ℹ️', `Facebook job ledger recovery finished; recovered ${recoveredRows.length} scheduled post(s)`);
    return { ok: uncertain === 0, scheduled: 0, recovered: recoveredRows.length, uncertain, dryRun, payloads: [] };
  }
  if (jobs.length === 0) {
    log('ℹ️', 'no jobs available, exiting');
    return { ok: reconciliation.uncertain === 0, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads: [] };
  }
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // 2. Pick top-N never-posted jobs with a verified Italian title. Offers
  // without a usable Italian localization stay unpublished until ready.
  const italianJobs = jobs.filter((job) => Boolean(getItalianJobTitle(job)));
  const missingItalianTitles = jobs.length - italianJobs.length;
  if (missingItalianTitles > 0) {
    log('⚠️', `excluding ${missingItalianTitles} offer(s) from Facebook: Italian title is missing or untranslated`);
  }
  const candidates = selectUnpostedJobs(italianJobs, postedSet, volume);
  if (candidates.length === 0) {
    log('ℹ️', 'no unposted jobs eligible, exiting');
    return { ok: reconciliation.uncertain === 0, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads: [] };
  }
  log('ℹ️', `selected ${candidates.length}/${volume} candidate jobs`);

  // 3. Pre-flight: figure out which slots are occupied
  const occupied = scheduledQueue.occupied;

  // 4. Pick slots
  const slots = pickNextSlots(volume, occupied, now);
  const usable = Math.min(candidates.length, slots.length);
  if (usable === 0) {
    log('ℹ️', 'no usable slot/candidate pair, exiting');
    return { ok: reconciliation.uncertain === 0, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads: [] };
  }

  // 5. Build payloads (with FB Place ID lookup per job's location)
  const placeIds = loadPlaceIds(repoRoot);
  let placedCount = 0;
  const unmappedCities = new Map(); // city → count
  const payloads = [];
  const copyReservations = new Map();
  const releaseReservation = async (id, reason) => {
    const released = await releaseUnpublishedSocialCopyAssignmentBestEffort(copyReservations.get(id), {
      releaseBalancedImpl: releaseSocialCopy,
      reason,
      onFailure: (err) => warn('⚠️', `could not release social-copy reservation for ${id}: ${err.message}`),
    });
    if (released) copyReservations.delete(id);
    return released;
  };
  const releaseAllReservations = async (reason) => {
    for (const id of [...copyReservations.keys()]) await releaseReservation(id, reason);
  };
  for (let i = 0; i < usable; i++) {
    const job = candidates[i];
    const url = buildJobUrl(job);
    if (!url) {
      log('⚠️', `skipping job ${job.id} — no slug`);
      continue;
    }
    try {
      const socialCopy = await selectSocialCopy({
        pack: socialCopyPack,
        channel: 'facebook',
        kind: 'job',
        assignmentKey: job.id,
        dryRun,
      });
      copyReservations.set(job.id, socialCopy);
      const message = buildJobCaption(job, { socialCopy });
      const placeId = lookupPlaceId(job.location, placeIds);
      if (placeId) {
        placedCount += 1;
      } else if (job.location) {
        unmappedCities.set(job.location, (unmappedCities.get(job.location) || 0) + 1);
      }
      payloads.push({
        jobId: job.id,
        url,
        message,
        placeId,
        copyFields: socialCopyLedgerFields(socialCopy),
        scheduled_publish_time: slots[i],
      });
    } catch (err) {
      await releaseReservation(job.id, 'Facebook job payload failed before delivery attempt');
      await releaseAllReservations('Facebook job payload batch failed before delivery attempt');
      throw err;
    }
  }
  log('📍', `place tag resolved for ${placedCount}/${payloads.length} payloads`);
  if (unmappedCities.size > 0) {
    // Log top unmapped locations so we can extend lookupPlaceId aliases
    // or add them to data/fb-place-ids.json over time.
    const top = [...unmappedCities.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([c, n]) => `${c}(${n})`)
      .join(', ');
    log('🔍', `unmapped cities (top 10): ${top}`);
  }

  // 6. Dry-run vs real POST
  if (dryRun) {
    log('🏃', `DRY_RUN=1 — would schedule ${payloads.length} posts`);
    for (const p of payloads) {
      const placeTag = p.placeId ? ` [place=${p.placeId}]` : '';
      log('  •', `${new Date(p.scheduled_publish_time * 1000).toISOString()} → immagine verticale + link ${p.url}${placeTag}`);
    }
    return { ok: reconciliation.uncertain === 0, scheduled: 0, uncertain: reconciliation.uncertain, dryRun: true, payloads };
  }

  if (!pageId || !token) {
    warn('⚠️', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing — skipping');
    await releaseAllReservations('Facebook credentials missing');
    return { ok: false, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads };
  }
  if (typeof fetchImpl !== 'function') {
    warn('⚠️', 'no fetch impl available — skipping');
    await releaseAllReservations('Facebook fetch implementation missing');
    return { ok: false, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads };
  }

  const publishReservationKeys = new Map(payloads.map((p) => [
    p.jobId,
    socialPublishReservationKey('facebook', 'job', p.jobId),
  ]));
  let reservationBatch;
  try {
    reservationBatch = await socialPublishReservations.reserveBatch({
      db: opts.socialPublishDb,
      platform: 'facebook',
      accountId: pageId,
      repoRoot,
      now,
      reservations: payloads.map((p) => {
        const link = facebookUrl(
          p.url,
          FACEBOOK_CAMPAIGN_JOB,
          socialCopyTrackingContent(p.jobId, p.copyFields),
        );
        return {
          key: publishReservationKeys.get(p.jobId),
          publishAt: new Date(p.scheduled_publish_time * 1000),
          reserveNextDay: true,
          // Match exact-post reconciliation, which hashes message/link fields;
          // the tracked offer URL is already part of this message.
          nativeContentFingerprint: socialPublishContentFingerprint('facebook', {
            message: buildFacebookJobPhotoMessage(p.message, link),
          }),
        };
      }),
    });
  } catch (error) {
    const fatal = new Error(`Facebook shared publication gate failed: ${error.message}`, { cause: error });
    fatal.code = 'SOCIAL_PUBLISH_RESERVATION_REQUIRED';
    throw fatal;
  }
  const allowedKeys = new Set(reservationBatch.filter((result) => result.allowed).map((result) => result.key));
  const deliveryPayloads = payloads.filter((p) => allowedKeys.has(publishReservationKeys.get(p.jobId)));
  const releasePublishReservation = async (p, reason) => {
    try {
      await socialPublishReservations.release({
        db: opts.socialPublishDb,
        platform: 'facebook',
        accountId: pageId,
        key: publishReservationKeys.get(p.jobId),
        publishAt: new Date(p.scheduled_publish_time * 1000),
      });
    } catch (error) {
      warn('⚠️', `Facebook reservation remains held for ${p.jobId} after ${reason}: ${error.message}`);
    }
  };
  for (const p of payloads) {
    if (allowedKeys.has(publishReservationKeys.get(p.jobId))) continue;
    const reason = reservationBatch.find((result) => result.key === publishReservationKeys.get(p.jobId))?.reason || 'daily-cap';
    warn('🛑', `Facebook Page publication held for ${p.jobId}: ${reason}`);
    await releaseReservation(p.jobId, `Facebook Page shared publication gate: ${reason}`);
  }
  if (deliveryPayloads.length === 0) {
    log('🛑', 'Facebook Page shared daily publication cap is exhausted; no posts sent');
    return { ok: reconciliation.uncertain === 0, scheduled: 0, uncertain: reconciliation.uncertain, dryRun, payloads: [] };
  }

  // 7. POST one per slot. Append to ledger after each success so a partial
  //    failure still records what got through. Run bounded batches: each
  //    payload still waits for its own OG rescrape/verification before the
  //    /feed POST, but unrelated jobs no longer serialize their Graph calls.
  // Transient FB error codes that get one retry after 2s:
  //   1  — generic "Please reduce data" (often FB's OG scraper timed out)
  //   2  — temporary service issue
  //   4  — application request limit reached (rate-limit, brief)
  //   17 — user request limit reached
  const TRANSIENT_FB_ERROR_CODES = new Set([1, 2, 4, 17]);
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  let uncertain = reconciliation.uncertain;

  // Each payload is a separate promise in Promise.all below. Returning false
  // here skips only this payload; later payloads and batches still run.
  const scheduleOne = async (p) => {
    let accepted = false;
    let deliveryUncertain = false;
    let unpublishedPhotoId = null;
    const discardUnpublishedPhoto = async () => {
      if (!unpublishedPhotoId) return;
      const photoId = unpublishedPhotoId;
      unpublishedPhotoId = null;
      await deleteUnpublishedFacebookPhoto(fetchImpl, photoId, token, warn);
    };
    try {
    // See the articles scheduler: tag before the rescrape, keep `p.url` bare
    // because it is the ledger's dedup key.
    const link = facebookUrl(
      p.url,
      FACEBOOK_CAMPAIGN_JOB,
      socialCopyTrackingContent(p.jobId, p.copyFields),
    );
    const postMessage = buildFacebookJobPhotoMessage(p.message, link);
    const requiredImagePath = expectedJobOgImagePath(p.url);
    if (!requiredImagePath) {
      warn('⚠️', `skipping ${p.jobId} — invalid job URL for OG image verification`);
      await releaseReservation(p.jobId, 'Facebook job URL failed OG image preflight');
      await releasePublishReservation(p, 'URL preflight failure');
      return false;
    }
    const imageUrl = await rescrapeOgAndVerify(fetchImpl, link, token, warn, {
      requiredImagePath,
      requiredImageVersion: JOB_OG_IMAGE_VERSION,
      rejectFallbackTitle: true,
      requireTrustedImageHost: true,
      returnImageUrl: true,
    });
    if (!imageUrl) {
      warn('⚠️', `skipping ${p.jobId} — Facebook did not resolve a verified job image`);
      await releaseReservation(p.jobId, 'Facebook job image did not pass OG verification');
      await releasePublishReservation(p, 'image preflight failure');
      return false;
    }
    unpublishedPhotoId = await uploadFacebookPhotoImpl({
      fetchImpl,
      pageId,
      token,
      imageUrl,
      requiredImagePath,
    });
    if (!unpublishedPhotoId) throw new Error('Facebook photo upload returned no media ID');
    const apiUrl = `${GRAPH_BASE}/${pageId}/feed`;
    const buildBody = () => {
      const b = new URLSearchParams({
        message: postMessage,
        published: 'false',
        scheduled_publish_time: String(p.scheduled_publish_time),
        unpublished_content_type: 'SCHEDULED',
        access_token: token,
      });
      b.append('attached_media[0]', JSON.stringify({ media_fbid: unpublishedPhotoId }));
      if (p.placeId) b.append('place', p.placeId);
      return b;
    };

    let data = null;
    let res = null;
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      res = null;
      data = null;
      try {
        res = await fetchImpl(apiUrl, { method: 'POST', body: buildBody() });
        data = await res.json();
      } catch (err) {
        deliveryUncertain = !res || res.ok === true || isAmbiguousSocialPublishResponse(res);
        warn('⚠️', `POST failed for ${p.jobId} (attempt ${attempt}): ${err.message}`);
        data = null;
      }
      // A 2xx without an ID is ambiguous: Meta may have accepted the scheduled
      // post. Keep its unpublished photo and reservation so reconciliation can
      // resolve it without deleting media that the accepted post may use.
      if (isAmbiguousSocialPublishResponse(res) || (res?.ok && !data?.id)) deliveryUncertain = true;
      if (res?.ok && data?.id) break;
      const code = data?.error?.code;
      if (!deliveryUncertain && attempt < 2 && TRANSIENT_FB_ERROR_CODES.has(code)) {
        warn('⏳', `FB transient error ${code} for ${p.jobId}, retrying in 2s`);
        await sleepMs(2000);
        continue;
      }
      break;
    }

    if (res?.ok && data?.id) {
      accepted = true;
      unpublishedPhotoId = null;
      copyReservations.delete(p.jobId);
      appendPosted(repoRoot, [{
        id: p.jobId,
        url: p.url,
        ts: new Date().toISOString(),
        fbPostId: data.id,
        scheduledFor: new Date(p.scheduled_publish_time * 1000).toISOString(),
        ...p.copyFields,
      }]);
      log('✅', `${p.jobId} → ${data.id} scheduled for ${new Date(p.scheduled_publish_time * 1000).toISOString()}; reservation held until Meta confirms publication`);
      return true;
    } else {
      warn('⚠️', `FB API error for ${p.jobId}: ${JSON.stringify(data).slice(0, 300)}`);
      if (!deliveryUncertain && res && !res.ok) {
        await discardUnpublishedPhoto();
        await releaseReservation(p.jobId, 'Facebook explicitly rejected the scheduled job post');
        await releasePublishReservation(p, 'explicit API rejection');
      }
      if (deliveryUncertain) uncertain += 1;
      return false;
    }
    } catch (err) {
      warn('⚠️', `FB scheduler failed for ${p.jobId}: ${err.message}`);
      if (!accepted && !deliveryUncertain) {
        await discardUnpublishedPhoto();
        await releaseReservation(p.jobId, 'Facebook job failed before delivery attempt');
        await releasePublishReservation(p, 'failure before delivery');
      }
      if (deliveryUncertain) uncertain += 1;
      return false;
    }
  };

  let scheduled = 0;
  for (let start = 0; start < deliveryPayloads.length; start += FB_SCHEDULE_CONCURRENCY) {
    const batch = deliveryPayloads.slice(start, start + FB_SCHEDULE_CONCURRENCY);
    const results = await Promise.all(batch.map(scheduleOne));
    scheduled += results.filter(Boolean).length;
  }

  log('🏁', `scheduled ${scheduled}/${deliveryPayloads.length} posts; cap held ${payloads.length - deliveryPayloads.length}`);
  return { ok: scheduled > 0 && uncertain === 0, scheduled, uncertain, dryRun, payloads: deliveryPayloads };
}

// ── CLI ─────────────────────────────────────────────────────

const isDirectInvocation = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isDirectInvocation) {
  run().then(
    (result) => process.exit(result?.uncertain > 0 ? 1 : 0),
    (err) => {
      console.error('⚠️ scheduler crashed:', err?.message || err);
      process.exit(err?.code === 'SOCIAL_PUBLISH_RESERVATION_REQUIRED' ? 1 : 0); // quota gate fails closed; other legacy errors remain soft
    },
  );
}
