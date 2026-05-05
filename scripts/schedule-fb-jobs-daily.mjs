#!/usr/bin/env node
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
 *   FB_JOB_VOLUME=1|24|72|144  — daily post count, default 144 (one every 10 min).
 *   DRY_RUN=1                — log payloads, no API call.
 *
 * Soft-fail: every error path logs and `process.exit(0)`. The workflow's
 * commit step is gated on the data file mutating, so a no-op run leaves
 * git untouched.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants ───────────────────────────────────────────────

const SITE_URL = 'https://frontaliereticino.ch';
const JOB_BOARD_PREFIX_IT = '/cerca-lavoro-ticino/';
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// FB requires scheduled_publish_time ≥ 10 minutes in the future.
const MIN_LEAD_SECONDS = 600;

// Hard FB limit on /feed `message` field. We aim much lower (~280 char).
const FB_MESSAGE_HARD_LIMIT = 5000;

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

// employmentType → user-facing label
const EMPLOYMENT_TYPE_LABEL = {
  FULL_TIME: 'Tempo pieno',
  PART_TIME: 'Part-time',
  CONTRACTOR: 'Contratto',
  TEMPORARY: 'Temporaneo',
};

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
  // Match scripts/submit-google-indexing-jobs.js: prefer public/data, fall
  // back to data/ (the agent worktree only has the latter for tests).
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

function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')   // tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripDiacritics(s) {
  if (!s) return '';
  // Strip U+0300–U+036F (Combining Diacritical Marks) after NFD decomposition.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

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
 * Filter never-posted jobs from `jobs`, sort by recency descending, take
 * top `limit`. Mirrors the selection rule of submit-google-indexing-jobs.
 *
 * @param {Array<object>} jobs
 * @param {Set<string>} postedSet — set of jobIds already posted
 * @param {number} limit
 */
export function selectUnpostedJobs(jobs, postedSet, limit) {
  if (!Array.isArray(jobs)) return [];
  const list = jobs.filter((j) => j && j.id && !postedSet.has(j.id));
  list.sort((a, b) => recencyTs(b) - recencyTs(a));
  return list.slice(0, Math.max(0, limit | 0));
}

function recencyTs(job) {
  const candidates = [job?.firstSeenAt, job?.crawledAt, job?.postedDate];
  for (const c of candidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
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
export function buildJobCaption(job) {
  const title = (job?.title || '').trim();
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
  const rawBody = job?.descriptionByLocale?.it || job?.description || '';
  const body = truncateBody(stripHtml(rawBody), 140);

  // Hashtags
  const hashtags = buildJobHashtags(job);

  const parts = [headerTitle];
  if (headerMeta) parts.push(headerMeta);
  if (body) parts.push('', body);
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

function truncateBody(text, maxLen) {
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
    return window.slice(0, lastSpace).trim() + '…';
  }
  return window.trim() + '…';
}

/**
 * Up to 5 hashtags. Always ends with #frontalieri #lavoroticino. Adds
 * #[Role] (if a role keyword matches the title), #[City] (first word of
 * location), #[Sector] (or #Ticino fallback). Sanitizes diacritics + spaces.
 */
export function buildJobHashtags(job) {
  const tags = [];

  // Role
  const title = job?.title || '';
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

  // Sector (fallback Ticino)
  const sectorRaw = (job?.sector || '').trim();
  const sectorTag = sectorRaw ? sanitizeHashtagWord(sectorRaw) : 'Ticino';
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

/**
 * Build the URL pointed at by the FB post. IT locale only, since the FB
 * Page is Italian-language. Slug source order: slugByLocale.it → slug.
 */
export function buildJobUrl(job) {
  const slug = job?.slugByLocale?.it || job?.slug;
  if (!slug) return null;
  return `${SITE_URL}${JOB_BOARD_PREFIX_IT}${slug}/`;
}

// ── Posted-jobs ledger I/O ──────────────────────────────────

/**
 * Read `data/fb-posted-jobs.json`. Returns `{schemaVersion:1, posted:[]}`
 * on missing file, malformed JSON, or shape mismatch — never throws.
 */
export function loadPosted(repoRoot) {
  const file = postedPath(repoRoot);
  try {
    if (!existsSync(file)) return { schemaVersion: 1, posted: [] };
    const raw = readFileSync(file, 'utf-8');
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
export function lookupPlaceId(location, placeIds) {
  if (!location || !placeIds) return null;
  const direct = placeIds[location];
  if (direct) return direct;
  // Strip trailing " (XX)" canton suffix
  const stripped = location.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== location && placeIds[stripped]) return placeIds[stripped];
  // Strip trailing "/<alt-name>" forms (e.g., "Biel/Bienne" -> "Biel")
  const slashStripped = location.split('/')[0].trim();
  if (slashStripped !== location && placeIds[slashStripped]) return placeIds[slashStripped];
  return null;
}

/**
 * Append entries to the ledger and write it back. Trims to last
 * POSTED_TRIM_LIMIT entries. Each entry: {id, url, ts, fbPostId}.
 */
export function appendPosted(repoRoot, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const file = postedPath(repoRoot);
  const current = loadPosted(repoRoot);
  const merged = current.posted.concat(entries);
  const trimmed = merged.slice(Math.max(0, merged.length - POSTED_TRIM_LIMIT));
  const out = { schemaVersion: 1, posted: trimmed };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

// ── Pre-flight: occupied scheduled-posts ────────────────────

async function fetchScheduledPostMinutes({ pageId, token, fetchImpl, log }) {
  const url = `${GRAPH_BASE}/${pageId}/scheduled_posts?fields=scheduled_publish_time&limit=200&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetchImpl(url);
    const data = await res.json();
    if (!res.ok) {
      log('⚠️', `pre-flight scheduled_posts → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return new Set();
    }
    const list = Array.isArray(data?.data) ? data.data : [];
    const occupied = new Set();
    for (const item of list) {
      const ts = Number(item?.scheduled_publish_time);
      if (Number.isFinite(ts) && ts > 0) occupied.add(ts);
    }
    log('ℹ️', `pre-flight: ${occupied.size} scheduled_publish_time slots already occupied`);
    return occupied;
  } catch (err) {
    log('⚠️', `pre-flight scheduled_posts failed: ${err.message}`);
    return new Set();
  }
}

// ── jobs.json loader ────────────────────────────────────────

function loadJobs(repoRoot, log) {
  const file = jobsPath(repoRoot);
  try {
    if (!existsSync(file)) {
      log('⚠️', `jobs.json not found at ${file}`);
      return [];
    }
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log('⚠️', `failed to read jobs.json: ${err.message}`);
    return [];
  }
}

// ── Main entry ──────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Date} [opts.now]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.repoRoot]
 * @param {(...a: unknown[]) => void} [opts.log]
 * @param {(...a: unknown[]) => void} [opts.warn]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;

  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const volumeRaw = Number(env.FB_JOB_VOLUME || 144);
  const volume = VOLUME_MINUTES[volumeRaw] ? volumeRaw : 144;
  const pageId = env.FB_PAGE_ID;
  const token = env.FB_PAGE_ACCESS_TOKEN;

  log('🗓️', `FB jobs daily scheduler — volume=${volume}, dry=${dryRun}`);

  // 1. Load jobs + ledger
  const jobs = loadJobs(repoRoot, log);
  if (jobs.length === 0) {
    log('ℹ️', 'no jobs available, exiting');
    return { ok: true, scheduled: 0, dryRun, payloads: [] };
  }
  const ledger = loadPosted(repoRoot);
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // 2. Pick top-N never-posted jobs
  const candidates = selectUnpostedJobs(jobs, postedSet, volume);
  if (candidates.length === 0) {
    log('ℹ️', 'no unposted jobs eligible, exiting');
    return { ok: true, scheduled: 0, dryRun, payloads: [] };
  }
  log('ℹ️', `selected ${candidates.length}/${volume} candidate jobs`);

  // 3. Pre-flight: figure out which slots are occupied
  let occupied = new Set();
  if (!dryRun && pageId && token && typeof fetchImpl === 'function') {
    occupied = await fetchScheduledPostMinutes({ pageId, token, fetchImpl, log });
  }

  // 4. Pick slots
  const slots = pickNextSlots(volume, occupied, now);
  const usable = Math.min(candidates.length, slots.length);
  if (usable === 0) {
    log('ℹ️', 'no usable slot/candidate pair, exiting');
    return { ok: true, scheduled: 0, dryRun, payloads: [] };
  }

  // 5. Build payloads (with FB Place ID lookup per job's location)
  const placeIds = loadPlaceIds(repoRoot);
  let placedCount = 0;
  const payloads = [];
  for (let i = 0; i < usable; i++) {
    const job = candidates[i];
    const url = buildJobUrl(job);
    if (!url) {
      log('⚠️', `skipping job ${job.id} — no slug`);
      continue;
    }
    const message = buildJobCaption(job);
    const placeId = lookupPlaceId(job.location, placeIds);
    if (placeId) placedCount += 1;
    payloads.push({
      jobId: job.id,
      url,
      message,
      placeId,
      scheduled_publish_time: slots[i],
    });
  }
  log('📍', `place tag resolved for ${placedCount}/${payloads.length} payloads`);

  // 6. Dry-run vs real POST
  if (dryRun) {
    log('🏃', `DRY_RUN=1 — would schedule ${payloads.length} posts`);
    for (const p of payloads) {
      const placeTag = p.placeId ? ` [place=${p.placeId}]` : '';
      log('  •', `${new Date(p.scheduled_publish_time * 1000).toISOString()} → ${p.url}${placeTag}`);
    }
    return { ok: true, scheduled: 0, dryRun: true, payloads };
  }

  if (!pageId || !token) {
    warn('⚠️', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN missing — skipping');
    return { ok: false, scheduled: 0, dryRun, payloads };
  }
  if (typeof fetchImpl !== 'function') {
    warn('⚠️', 'no fetch impl available — skipping');
    return { ok: false, scheduled: 0, dryRun, payloads };
  }

  // 7. POST one per slot. Append to ledger after each success so a partial
  //    failure still records what got through.
  let scheduled = 0;
  for (const p of payloads) {
    try {
      const apiUrl = `${GRAPH_BASE}/${pageId}/feed`;
      const body = new URLSearchParams({
        message: p.message,
        link: p.url,
        published: 'false',
        scheduled_publish_time: String(p.scheduled_publish_time),
        access_token: token,
      });
      if (p.placeId) body.append('place', p.placeId);
      const res = await fetchImpl(apiUrl, { method: 'POST', body });
      const data = await res.json();
      if (res.ok && data?.id) {
        scheduled += 1;
        appendPosted(repoRoot, [{
          id: p.jobId,
          url: p.url,
          ts: new Date().toISOString(),
          fbPostId: data.id,
          scheduledFor: new Date(p.scheduled_publish_time * 1000).toISOString(),
        }]);
        log('✅', `${p.jobId} → ${data.id} @ ${new Date(p.scheduled_publish_time * 1000).toISOString()}`);
      } else {
        warn('⚠️', `FB API error for ${p.jobId}: ${JSON.stringify(data).slice(0, 300)}`);
      }
    } catch (err) {
      warn('⚠️', `POST failed for ${p.jobId}: ${err.message}`);
    }
  }

  log('🏁', `scheduled ${scheduled}/${payloads.length} posts`);
  return { ok: scheduled > 0, scheduled, dryRun, payloads };
}

// ── CLI ─────────────────────────────────────────────────────

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  run().then(
    () => process.exit(0),
    (err) => {
      console.error('⚠️ scheduler crashed:', err?.message || err);
      process.exit(0); // soft-fail
    },
  );
}
