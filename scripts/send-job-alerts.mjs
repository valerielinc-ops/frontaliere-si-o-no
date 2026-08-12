#!/usr/bin/env node
/**
 * FRO-333: Send Job Alert emails to subscribed users.
 *
 * Reads active job alerts from Firestore, matches them against jobs
 * added/updated in the last 24h, and sends email notifications via the
 * multi-provider email cascade (Mailgun → Resend → Mailjet → Mailtrap → Cloudflare).
 *
 * Retry mechanism: When all providers exhaust their daily quota and emails
 * fail, they are written to the Firestore `job_alert_retry_queue` collection.
 * On the next run (daily at 07:00 UTC), retries are processed FIRST to get
 * priority on fresh provider quota. Max 2 retries per email (3 total attempts).
 *
 * Environment variables:
 *   RESEND_API_KEY            — Resend API key
 *   GOOGLE_APPLICATION_CREDENTIALS — Firebase service account for Firestore
 *
 * Usage:
 *   node scripts/send-job-alerts.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peelDanglingClauseTail } from '../build-plugins/shared/clauseTail.mjs';
import { normalizeContract } from '../services/newsletter-content.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';
import { renderRecommendedBlock } from '../services/newsletter/recommendedBlock.mjs';
import { buildAlertProfile, scoreJobForAlert, partitionByGeoPreference, freshnessBoost } from '../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause } from './lib/job-alert-zero-match-diagnosis.mjs';
import { createCantonResolvers, AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';
import { isOwnerEmail, isCanaryJob } from './lib/canaryAd.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';
import { isAddressSuppressed, isJobAlertExcluded } from '../services/emailSuppression.mjs';
import { detectJobTitleLocaleDetails } from './lib/job-locale-utils.mjs';
import {
  normalizeSentMap,
  filterUnsentJobs,
  mergeSentJobs,
  DEDUP_WINDOW_MS,
} from './lib/alert-sent-jobs.mjs';
import { derivePersonalizationPatch } from './lib/subscriber-personalization.mjs';
import { extractSlugFromSourcePage } from './backfill-newsletter-job-context.mjs';
import { runWithConcurrency, checkPageBodyLive } from './lib/live-link-check.mjs';
import { computeScheduledSendAt, resolveEffectivePreferredHour, perUserSendTimeEnabled, logScheduleDistribution } from './lib/send-schedule.mjs';
import { resolveEffectiveJobAlertTier, JOB_ALERT_ENGAGEMENT_TIERS } from './lib/jobAlertEngagementTier.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';
import { makePreferencesUrl, generateAutologinCode, makeAuthenticatedUrl as makeAuthenticatedUrlShared } from '../services/newsletterUrls.mjs';
import { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl } from './lib/job-alert-unsub-urls.mjs';
import { isImmediateCompanyAlert } from './lib/company-alert-routing.mjs';
// localePathPrefix aliased to the local name this script has always used for
// its locale-aware URL construction — the implementation is the canonical
// shared helper (also used by send-newsletter.mjs, send-saved-jobs-digest.mjs).
import { localePathPrefix } from './lib/articleContent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';
// Brand logos were offloaded to the CDN (#1705) — the origin `/images/brands`
// path now 404s, and email clients strip JS so there is no onerror fallback,
// leaving the icon blank. Canonical CDN host (mirrors blogImageCdn CDN_BLOG_BASE).
const IMAGE_CDN_BASE = 'https://cdn.frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');
// Candidate-pool gate: jobs whose crawledAt (or postedDate fallback) falls
// inside this window. NOTE: crawledAt refreshes on every re-crawl, so this is
// an "inventory still listed as of the last day" gate, NOT a "new jobs" gate —
// genuine novelty is keyed on firstSeenAt (freshnessBoost + the NEW badge),
// and per-user novelty is enforced by the sentJobIds dedup (alert-sent-jobs.mjs).
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
// Max job cards rendered in one alert email. Also the honest basis for the
// subject/hero counts and for the sentJobIds rotation (only what the user
// actually SAW is marked as sent).
const MAX_JOB_CARDS = 10;
const MAX_RETRY_COUNT = 2; // Max 2 retries (original + 2 = 3 total attempts)
const RETRY_COLLECTION = 'job_alert_retry_queue';
// Engagement-tier send priority: daily openers first, weekly last. Used both
// to decide which alerts get their (network-cost) content built when the
// shared cascade can't cover everyone today (see capacity check below), and
// to re-sort the finished batch so a mid-send cap-out still favors the
// most-engaged recipients.
const ENGAGEMENT_SEND_PRIORITY = {
  [JOB_ALERT_ENGAGEMENT_TIERS.DAILY]: 0,
  [JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY]: 1,
  [JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]: 2,
};
// Reserve a slice of today's remaining cascade quota so send-time errors
// (soft-throttle, a provider tripping mid-run) don't push otherwise-fitting
// alerts into tomorrow's retry queue.
const QUOTA_BUFFER_RATIO = 0.1;

// Owner ask 2026-07-18: surface how many alerts matched literally zero jobs
// this run (as opposed to "had matches, all already sent" — a healthy case),
// so a persistently high rate flags a matching-quality problem (narrow user
// search, a missing keyword/synonym, or a genuine sector/geo inventory gap)
// rather than staying invisible. Starting value — tune after a few runs of
// real data once the `📉 Zero-match:` log line below establishes a baseline.
const ZERO_MATCH_ISSUE_THRESHOLD_RATIO = 0.2;

// Testing allowlist: set to a Set of emails for admin-only testing,
// or null to enable for all users.
// Can also be set at runtime via TARGET_EMAIL env var (single email) — useful
// for workflow_dispatch test sends without code changes.
const TARGET_EMAIL_RAW = (process.env.TARGET_EMAIL || '').trim().toLowerCase();
const ALLOWED_EMAILS = TARGET_EMAIL_RAW ? new Set([TARGET_EMAIL_RAW]) : null;
if (TARGET_EMAIL_RAW) {
  console.log(`🎯 TARGET_EMAIL set — limiting send to: ${TARGET_EMAIL_RAW}`);
}

// The one-click unsubscribe endpoint (RFC 8058) and its two HMAC link builders
// now live in scripts/lib/job-alert-unsub-urls.mjs — imported above and shared
// with scripts/send-company-alerts.mjs.

// makePreferencesUrl (and its per-locale slug table) lives in
// services/newsletterUrls.mjs — shared with send-newsletter.mjs and the
// welcome-email Cloud Function so the HMAC token scheme can't drift
// (AGENTS.md #6). localePathPrefix lives in ./lib/articleContent.mjs
// (shared with send-newsletter.mjs / send-saved-jobs-digest.mjs).

// Canton-aware job-board section resolver (mirrors
// migrate-all-known-job-slugs-canton-aware.mjs). Every canton has its own
// board section (cerca-lavoro-vaud, jobs-in-aargau, …); the generic
// Switzerland-wide allJobsUrl CTA (no single canton to resolve) uses the
// AGGREGATE_KEY section instead.
const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

// ── Pre-send live-link preflight (issue #3172) ──────────────────────
// data/jobs.json is a periodic crawl snapshot; a job listed as "recent" at
// crawl-time can be pulled/expired by an employer, or its per-locale SSG page
// may not have deployed yet, before this script actually sends the alert.
//
// This CANNOT reuse the plain HEAD-check from check-journalist-article-links.mjs
// (scripts/lib/live-link-check.mjs checkLink): that check is blind to our own
// job pages — the site's soft-404 policy (AGENTS.md "Static SEO Pages": no
// real 404s, always a bridge) means an expired job's URL keeps returning 200
// forever, rendering the "Questa offerta di lavoro non è più attiva"
// soft-landing page instead (build-plugins/jobsSeoPagesPlugin.ts
// buildSoftLandingHtml). So a HEAD/status check alone is a no-op here — it
// was passing 200 for exactly the expired jobs it was meant to catch.
// checkPageBodyLive (scripts/lib/live-link-check.mjs, shared with
// check-journalist-article-links.mjs) is the real liveness signal: GET + look
// for the `window.__EXPIRED_JOB_DATA__` marker buildSoftLandingHtml alone
// seeds.
const JOB_LIVE_CHECK_CONCURRENCY = 5;
// Fail-open guard: check-journalist-article-links.mjs is a monitoring/report
// tool (a failed check just marks one outlink broken in a report — never
// empties anything), so it has no analogous "distrust the batch" step. Here
// the check GATES what gets emailed, so a transient blip on OUR OWN outbound
// fetch (e.g. GH Actions runner network hiccup) that makes every URL look
// dead must not silently zero out a whole alert. Below this live-fraction, on
// a large-enough sample, treat the batch as untrustworthy and send unfiltered
// instead of empty.
const JOB_LIVE_CHECK_FAIL_OPEN_MIN_SAMPLE = 4;
const JOB_LIVE_CHECK_FAIL_OPEN_LIVE_RATIO = 0.34;

// The exact frontaliereticino.ch job-page URL that will be embedded in the
// alert email for this locale (mirrors the `rawJobUrl` built inside
// buildAlertEmail, minus the alert-specific utm query string — irrelevant to
// liveness and would otherwise fragment the cache key per alertId).
function jobPageUrl(job, locale) {
  const cantonCode = resolveJobCanton({ canton: job.canton, location: job.location });
  const jobBoardPath = resolveCantonSection(locale, cantonCode);
  const localizedJobBoardPath = `${localePathPrefix(locale)}/${jobBoardPath}`;
  const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug || '';
  return slug ? `${BASE_URL}${localizedJobBoardPath}/${slug}` : null;
}

// Delegates to the shared checkPageBodyLive (scripts/lib/live-link-check.mjs)
// — kept as its own export/name here since it's the job-alerts-specific
// liveness check callers and tests reach for. Exported for tests.
export const checkJobPageLive = checkPageBodyLive;

/**
 * Filters `jobs` down to those whose live page resolves OK AND is not the
 * expired-job soft-landing bridge, checking each distinct URL at most once
 * per run via `cache` (shared across alerts/locales so overlapping job pools
 * aren't re-checked). Jobs with no resolvable slug fall back to the site root
 * in the email (always live) and are never filtered. Exported for tests.
 */
async function filterLiveJobs(jobs, locale, cache) {
  const withUrls = jobs.map((job) => ({ job, url: jobPageUrl(job, locale) }));
  // Dedupe by URL both across calls (via the shared `cache`) AND within this
  // single call (two jobs — e.g. two locale variants — can resolve to the
  // same page); otherwise a duplicate URL in the same batch would be
  // checked once per occurrence before either result lands in `cache`.
  const uniqueToCheck = [...new Set(withUrls.map(({ url }) => url).filter((url) => url && !cache.has(url)))];
  if (uniqueToCheck.length > 0) {
    await runWithConcurrency(uniqueToCheck, JOB_LIVE_CHECK_CONCURRENCY, async (url) => {
      cache.set(url, await checkJobPageLive(url));
    });
  }
  const results = withUrls.map(({ job, url }) => ({ job, live: !url || cache.get(url) !== false }));
  const checked = results.length;
  const liveCount = results.filter((r) => r.live).length;
  if (checked >= JOB_LIVE_CHECK_FAIL_OPEN_MIN_SAMPLE && liveCount / checked < JOB_LIVE_CHECK_FAIL_OPEN_LIVE_RATIO) {
    console.warn(`   ⚠️  Live-link check: only ${liveCount}/${checked} job page(s) resolved live — suspected transient network issue, failing open (sending unfiltered) rather than emptying the alert`);
    return jobs;
  }
  const deadCount = checked - liveCount;
  if (deadCount > 0) {
    console.log(`   🔗 Live-link check: ${deadCount}/${checked} job(s) filtered out (dead link — pulled/expired or not yet deployed)`);
  }
  return results.filter((r) => r.live).map((r) => r.job);
}

// Brand logo lookup. Builds slug→filename map from public/images/brands/ at
// startup (~72 logos). Used to render company logos in job cards instead of
// the initial-letter placeholder. Falls back to initial when no logo matches.
const BRAND_LOGOS_DIR = path.join(ROOT, 'public', 'images', 'brands');
const BRAND_LOGO_BY_SLUG = (() => {
  try {
    const files = fs.readdirSync(BRAND_LOGOS_DIR);
    const map = new Map();
    for (const filename of files) {
      const m = filename.match(/^(.+)\.(png|jpg|jpeg|svg|webp)$/i);
      if (m) map.set(m[1].toLowerCase(), filename);
    }
    return map;
  } catch {
    return new Map();
  }
})();

// Brand aliases: when crawlers emit different legal-entity names for the same
// parent brand (e.g. "Coop Genossenschaft" vs "Coop Ticino"), map them to the
// bundled logo slug. Add new entries lower-cased on the LEFT, slug on the RIGHT.
const BRAND_ALIASES = new Map([
  ['coop-genossenschaft', 'coop-ticino'],
  ['coop-svizzera', 'coop-ticino'],
  ['eoc', 'eoc-ente-ospedaliero-cantonale'],
  ['eoc-ospedaliero-cantonale', 'eoc-ente-ospedaliero-cantonale'],
  ['tether-operations', 'tether'],
  ['tether-io', 'tether'],
  ['amministrazione-cantonale-ticino', 'amministrazione-cantonale-ti'],
  ['banca-cler-ag', 'banca-cler'],
  ['banca-sempione-sa', 'banca-sempione'],
  ['bps-suisse-sa', 'bps-suisse'],
  ['avaloq-group-ag', 'avaloq'],
  ['alpiq-holding', 'alpiq'],
  ['agie-charmilles-management', 'agie-charmilles'],
  ['gf-machining-solutions', 'agie-charmilles'],
  ['boggi-milano-sa', 'boggi-milano'],
]);

// Strip common legal suffixes so "Banca Cler AG" matches "banca-cler.png".
const LEGAL_SUFFIX_RE = /[- ](?:sa|sagl|s-a|ag|gmbh|s-r-l|srl|spa|s-p-a|holding|group|international|svizzera|suisse|ticino)(?:[- ](?:sa|sagl|ag|gmbh|holding|group))?$/;

// First PARSEABLE date among candidates → epoch ms (0 if none). Local twin of
// build-plugins/shared/firstParsableDate.ts (runtime .mjs, cannot import .ts):
// stops a malformed postedDate from shadowing crawledAt in the freshness window.
function firstParsableMs(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const ts = new Date(v).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function trySlug(slug) {
  if (!slug) return null;
  const aliased = BRAND_ALIASES.get(slug) || slug;
  const filename = BRAND_LOGO_BY_SLUG.get(aliased);
  return filename ? `${IMAGE_CDN_BASE}/images/brands/${filename}` : null;
}

function brandLogoUrl(companyName, companyKey) {
  if (!companyName && !companyKey) return null;
  // 1. Crawler-provided companyKey (already normalized, most reliable).
  if (companyKey) {
    const hit = trySlug(String(companyKey).toLowerCase());
    if (hit) return hit;
  }
  // 2. Slugified display name.
  const baseSlug = String(companyName || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!baseSlug) return null;
  const direct = trySlug(baseSlug);
  if (direct) return direct;
  // 3. Strip a single legal-suffix tier ("Banca Cler AG" → "banca-cler").
  const stripped = baseSlug.replace(LEGAL_SUFFIX_RE, '');
  if (stripped !== baseSlug) {
    const hit = trySlug(stripped);
    if (hit) return hit;
  }
  return null;
}

function resolveAvatarSrc(job) {
  // Bundled, high-quality brand logo only. No Google-favicon tier: it serves a
  // grey globe for domains it can't resolve (and the wrong logo for aggregator
  // hosts), both of which look broken in an inbox. A null result renders the
  // coloured initial-letter avatar instead.
  const bundled = brandLogoUrl(job.company, job.companyKey);
  if (bundled) return { src: bundled, kind: 'bundled' };
  return null;
}

// Format a job salary (annual / monthly / hourly) into a compact, locale-aware label.
// Returns null if the job has no salary data — caller should not render the chip.
function formatSalary(job, locale = 'it') {
  const min = Number(job.salaryMin) || 0;
  const max = Number(job.salaryMax) || 0;
  if (!min && !max) return null;
  const currency = String(job.currency || job.baseSalary?.currency || 'CHF').toUpperCase();
  const unit = String(job.baseSalary?.value?.unitText || 'YEAR').toUpperCase();
  const periodSuffix = {
    it: { YEAR: '/anno', MONTH: '/mese', WEEK: '/settimana', HOUR: '/ora', DAY: '/giorno' },
    en: { YEAR: '/year', MONTH: '/month', WEEK: '/week', HOUR: '/hour', DAY: '/day' },
    de: { YEAR: '/Jahr', MONTH: '/Monat', WEEK: '/Woche', HOUR: '/Std.', DAY: '/Tag' },
    fr: { YEAR: '/an', MONTH: '/mois', WEEK: '/semaine', HOUR: '/heure', DAY: '/jour' },
  };
  const suffix = (periodSuffix[locale] || periodSuffix.it)[unit] || '';
  const compact = (n) => {
    if (!n) return '';
    if (n >= 1000) {
      const k = n / 1000;
      // Render as 49.5K (one decimal if the half-step matters) or 75K (integer).
      return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')) + 'K';
    }
    return String(n);
  };
  const range = min && max && min !== max
    ? `${compact(min)}\u2013${compact(max)}` // en-dash separator
    : compact(min || max);
  return `${currency} ${range}${suffix}`;
}

// ── i18n strings for email template ─────────────────────────
const EMAIL_STRINGS = {
  it: {
    subjectNew: (n) => `\ud83d\udd14 ${n} nuov${n === 1 ? 'a offerta' : 'e offerte'}`,
    subjectFor: 'per',
    subjectDefault: 'le tue offerte',
    preheader: (n, label) => `${n} nuove offerte: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} nuov${n === 1 ? 'a offerta' : 'e offerte'} per te`,
    filters: 'Filtri',
    sectionLabel: '\ud83d\udcbc Lavoro',
    sectionTitle: 'Le offerte che fanno per te',
    sectionDesc: 'Selezionate in base ai tuoi filtri, aggiornate ogni giorno.',
    viewAll: 'Vedi tutte le offerte \u2192',
    closer: 'Conosci qualcuno che cerca lavoro in Ticino? Inoltra questa email.',
    closerSign: 'Alla prossima. \u2615',
    manageAlerts: 'Gestisci le tue alert',
    unsubThis: (filters) => `Non vuoi pi\u00f9 ricevere alert per <strong>${filters}</strong>?`,
    unsubThisLink: 'Disiscriviti da questa alert',
    unsubAll: 'Disiscriviti da tutte le alert',
    unsubJoke: '\u2014 giuro che non piangeremo. (Forse un po\'.)',
    newBadge: '\u2728 NUOVA',
    fallbackTitle: 'Offerta di lavoro',
    allOffers: 'tutte le offerte',
    at: 'presso',
    more: 'altre offerte',
    intendedFor: (email, filter) => `Questa email \u00e8 stata inviata a ${email} in base al tuo alert: <strong>${filter}</strong>.`,
    textFilters: 'Filtri',
    textViewAllLine: 'Vedi tutte le offerte:',
    textManageLine: 'Gestisci le tue alert:',
    textUnsubThisLine: 'Disiscriviti da questa alert:',
    textUnsubAllLine: 'Disiscriviti da tutte le alert:',
  },
  en: {
    subjectNew: (n) => `\ud83d\udd14 ${n} new job${n === 1 ? '' : 's'}`,
    subjectFor: 'for',
    subjectDefault: 'your alerts',
    preheader: (n, label) => `${n} new jobs: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} new job${n === 1 ? '' : 's'} for you`,
    filters: 'Filters',
    sectionLabel: '\ud83d\udcbc Jobs',
    sectionTitle: 'Jobs that match your criteria',
    sectionDesc: 'Selected based on your filters, updated every day.',
    viewAll: 'View all jobs \u2192',
    closer: 'Know someone looking for a job in Ticino? Forward this email.',
    closerSign: 'See you next time. \u2615',
    manageAlerts: 'Manage your alerts',
    unsubThis: (filters) => `Don't want alerts for <strong>${filters}</strong> anymore?`,
    unsubThisLink: 'Unsubscribe from this alert',
    unsubAll: 'Unsubscribe from all alerts',
    unsubJoke: '\u2014 we promise we won\'t cry. (Maybe a little.)',
    newBadge: '\u2728 NEW',
    fallbackTitle: 'Job offer',
    allOffers: 'all offers',
    at: 'at',
    more: 'more',
    intendedFor: (email, filter) => `This email was sent to ${email} based on your alert: <strong>${filter}</strong>.`,
    textFilters: 'Filters',
    textViewAllLine: 'View all matching jobs:',
    textManageLine: 'Manage alerts:',
    textUnsubThisLine: 'Unsubscribe this alert:',
    textUnsubAllLine: 'Unsubscribe all:',
  },
  de: {
    subjectNew: (n) => `\ud83d\udd14 ${n} neue Stelle${n === 1 ? '' : 'n'}`,
    subjectFor: 'f\u00fcr',
    subjectDefault: 'Ihre Alerts',
    preheader: (n, label) => `${n} neue Stellen: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} neue Stelle${n === 1 ? '' : 'n'} f\u00fcr Sie`,
    filters: 'Filter',
    sectionLabel: '\ud83d\udcbc Stellen',
    sectionTitle: 'Passende Stellenangebote',
    sectionDesc: 'Ausgew\u00e4hlt nach Ihren Filtern, t\u00e4glich aktualisiert.',
    viewAll: 'Alle Stellen ansehen \u2192',
    closer: 'Kennen Sie jemanden, der im Tessin arbeiten m\u00f6chte? Leiten Sie diese E-Mail weiter.',
    closerSign: 'Bis zum n\u00e4chsten Mal. \u2615',
    manageAlerts: 'Alerts verwalten',
    unsubThis: (filters) => `Keine Alerts mehr f\u00fcr <strong>${filters}</strong>?`,
    unsubThisLink: 'Von diesem Alert abmelden',
    unsubAll: 'Von allen Alerts abmelden',
    unsubJoke: '\u2014 wir weinen bestimmt nicht. (Vielleicht ein bisschen.)',
    newBadge: '\u2728 NEU',
    fallbackTitle: 'Stellenangebot',
    allOffers: 'alle Angebote',
    at: 'bei',
    more: 'weitere',
    intendedFor: (email, filter) => `Diese E-Mail wurde an ${email} basierend auf deinem Alert gesendet: <strong>${filter}</strong>.`,
    textFilters: 'Filter',
    textViewAllLine: 'Alle Stellen ansehen:',
    textManageLine: 'Alerts verwalten:',
    textUnsubThisLine: 'Von diesem Alert abmelden:',
    textUnsubAllLine: 'Von allen Alerts abmelden:',
  },
  fr: {
    subjectNew: (n) => `\ud83d\udd14 ${n} nouvelle${n === 1 ? '' : 's'} offre${n === 1 ? '' : 's'}`,
    subjectFor: 'pour',
    subjectDefault: 'vos alertes',
    preheader: (n, label) => `${n} nouvelles offres: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} nouvelle${n === 1 ? '' : 's'} offre${n === 1 ? '' : 's'} pour vous`,
    filters: 'Filtres',
    sectionLabel: '\ud83d\udcbc Emploi',
    sectionTitle: 'Les offres qui vous correspondent',
    sectionDesc: 'S\u00e9lectionn\u00e9es selon vos filtres, mises \u00e0 jour chaque jour.',
    viewAll: 'Voir toutes les offres \u2192',
    closer: 'Vous connaissez quelqu\'un qui cherche un emploi au Tessin? Transf\u00e9rez cet email.',
    closerSign: '\u00c0 bient\u00f4t. \u2615',
    manageAlerts: 'G\u00e9rer vos alertes',
    unsubThis: (filters) => `Vous ne souhaitez plus recevoir d\'alertes pour <strong>${filters}</strong>?`,
    unsubThisLink: 'Se d\u00e9sabonner de cette alerte',
    unsubAll: 'Se d\u00e9sabonner de toutes les alertes',
    unsubJoke: '\u2014 promis, on ne pleurera pas. (Peut-\u00eatre un peu.)',
    newBadge: '\u2728 NOUVELLE',
    fallbackTitle: 'Offre d\'emploi',
    allOffers: 'toutes les offres',
    at: 'chez',
    more: 'autres',
    intendedFor: (email, filter) => `Cet e-mail a \u00e9t\u00e9 envoy\u00e9 \u00e0 ${email} en fonction de votre alerte\u00a0: <strong>${filter}</strong>.`,
    textFilters: 'Filtres',
    textViewAllLine: 'Voir toutes les offres\u00a0:',
    textManageLine: 'G\u00e9rer vos alertes\u00a0:',
    textUnsubThisLine: 'Se d\u00e9sabonner de cette alerte\u00a0:',
    textUnsubAllLine: 'Se d\u00e9sabonner de toutes les alertes\u00a0:',
  },
};

function getStrings(locale) {
  return EMAIL_STRINGS[locale] || EMAIL_STRINGS.it;
}

// makeAlertUnsubscribeUrl / makeAllAlertsUnsubscribeUrl moved to
// scripts/lib/job-alert-unsub-urls.mjs (#5012 phase 2) when the CompanyAlert
// immediate sender needed the same links. Keeping a copy here would have put
// the HMAC derivation in two files while its verifier lives in a third
// (functions/src/jobAlertUnsubscribe.js) — Non-Negotiable #6, and the exact
// drift class #5151 was spent extracting.

// generateAutologinCode lives in services/newsletterUrls.mjs (shared with
// send-newsletter.mjs and the win-back/sunset runner, AGENTS.md #6).

// makeAuthenticatedUrl is the shared builder in services/newsletterUrls.mjs
// (canonical under functions/src/lib/) — same autologin scheme as the weekly
// newsletter and the welcome email. Job alerts keep their own defaults:
// utm_medium 'email' (analytics convention is medium=channel,
// source=identifier) and preserve a utm_medium already set by utmBase.
const makeAuthenticatedUrl = (targetUrl, email, autologinCode, utmMedium = 'email') =>
  makeAuthenticatedUrlShared(targetUrl, email, {
    autologinCode,
    utmMedium,
    preserveExistingUtmMedium: true,
  });

// ── Firebase Admin SDK (lazy init) ───────────────────────────

let _db = null;

// Test seam: inject a fake Firestore so the maileroo-meta writer can be unit-tested
// without real credentials. No-op in production (only tests call it).
export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}

async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (cred.project_id) {
      // Service account JSON (CI/CD)
      initializeApp({ credential: cert(cred) });
    } else {
      // ADC / user credentials (local dev)
      const { applicationDefault } = await import('firebase-admin/app');
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

// ── Load jobs from data/jobs.json ────────────────────────────

// Static floor for the 4 cities the subscriber-preference flags hardcode
// (jobAlertMatching.mjs preferenceCities). Without it, a subscriber whose
// home city has zero live jobs in today's crawl snapshot would fail to
// resolve to "ti" via the dataset-derived cityToCanton index below and fall
// through to CH-wide, even though same-canton jobs from nearby TI cities
// exist (review nit on PR #3146, issue #3155). Exported for direct unit
// testing — see tests/job-alert-geo-preference-pipeline.test.ts.
export const STATIC_CITY_CANTON_FLOOR = {
  lugano: 'ti', bellinzona: 'ti', mendrisio: 'ti', chiasso: 'ti',
};

// Returns the recent-job match pool AND a lightweight slug/id → geography index
// over the FULL dataset. The index lets us recover the location of the job a
// one-tap subscriber engaged with (`sourceJobSlug`) even when that job is older
// than the 24h match window — folded into the matcher as a soft location signal
// so same-area jobs rank to the top of a location-less alert.
function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) return { recent: [], locationIndex: new Map(), cityToCanton: new Map() };
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  if (!Array.isArray(jobs)) return { recent: [], locationIndex: new Map(), cityToCanton: new Map() };

  const cutoff = Date.now() - MATCH_WINDOW_MS;
  const recent = [];
  const locationIndex = new Map();
  // City → canton index over the FULL dataset, so the graduated geo preference
  // (#2993) can resolve a subscriber's preferred city (e.g. "bellinzona") to its
  // canton ("ti") and treat every TI job as in-area — not just exact-city hits.
  // Seeded with STATIC_CITY_CANTON_FLOOR; dataset entries below never override
  // these (`!has` guard) since all four are unambiguously Ticino.
  const cityToCanton = new Map(Object.entries(STATIC_CITY_CANTON_FLOOR));
  for (const j of jobs) {
    const geo = [j.location || j.addressLocality || '', j.canton || ''].filter(Boolean);
    const company = j.company || '';
    if (geo.length > 0 || company) {
      const meta = { geo, company };
      for (const key of [j.slug, ...Object.values(j.slugByLocale || {}), j.id]) {
        if (key) locationIndex.set(String(key).toLowerCase(), meta);
      }
    }
    const canton = String(j.canton || '').toLowerCase();
    if (canton) {
      for (const city of [j.location, j.addressLocality]) {
        const c = String(city || '').toLowerCase().trim();
        if (c && !cityToCanton.has(c)) cityToCanton.set(c, canton);
      }
    }
    // needsRetranslation is NOT checked here: this pool is shared across every
    // subscriber alert regardless of locale, and the flag only means
    // translations FROM the job's source locale are stale — it never means
    // the source locale's own title/description is bad. Blanket-excluding
    // here wrongly dropped a job from EVERY alert (including ones in its own
    // source language) whenever any other locale's translation was pending.
    // The locale-aware exemption is applied per-alert below, where the
    // recipient's locale is actually known (#4715).
    if (firstParsableMs(j.crawledAt, j.postedDate) >= cutoff) recent.push(j);
  }
  return { recent, locationIndex, cityToCanton };
}

// Resolve the geography of the job a one-tap alert was created from, via its
// stored slug / pinned id. Returns lowercased location + canton tokens ('' set
// filtered out by the caller).
function sourceJobLocationsFor(alert, locationIndex) {
  if (!locationIndex || locationIndex.size === 0) return [];
  const keys = [
    alert.sourceJobSlug,
    alert.specificJobId,
    ...(Array.isArray(alert.specificJobIds) ? alert.specificJobIds : []),
  ];
  for (const k of keys) {
    if (!k) continue;
    const meta = locationIndex.get(String(k).toLowerCase());
    if (meta?.geo?.length) return meta.geo;
  }
  return [];
}

// Resolve the job a subscriber CLICKED in a previous alert/newsletter email,
// from the ESP-recorded `last_clicked_url`, into its geography + employer. A
// click is the strongest intent signal we hold (the user picked that job out of
// the inbox) — fed at the highest weight into personalization + matching (#3025).
// The webhooks already persist `last_clicked_url`; we just consume it here,
// where the jobs index is available (functions have no job data).
function clickedJobMeta(lastClickedUrl, locationIndex) {
  if (!lastClickedUrl || !locationIndex || locationIndex.size === 0) {
    return { locations: [], company: '' };
  }
  // Reuse the canonical job-board-URL → slug parser (returns '' for non-job
  // URLs like preferences/unsubscribe links, so those are ignored).
  const slug = extractSlugFromSourcePage(lastClickedUrl);
  if (!slug) return { locations: [], company: '' };
  const meta = locationIndex.get(slug.toLowerCase());
  if (!meta) return { locations: [], company: '' };
  return { locations: meta.geo || [], company: meta.company || '' };
}

// Extract soft browsing signals from the personalization subdoc
// (newsletter_subscribers/{email}/private/personalization). `filterUsage.location`
// keys + viewed-job cities are the precise location data issue #2993 asks us to
// use; `searches[].query` + viewed-job categories add intent tokens.
function behaviorSignals(personalization) {
  if (!personalization || typeof personalization !== 'object') {
    return { behaviorLocations: [], behaviorTokens: [], filterLocations: [] };
  }
  const viewedJobs = Array.isArray(personalization.viewedJobs) ? personalization.viewedJobs : [];
  const searches = Array.isArray(personalization.searches) ? personalization.searches : [];
  const filterLoc = personalization.filterUsage?.location;
  // Locations the user EXPLICITLY filtered by on-site — the strongest browsing
  // geo signal. Kept separate from the merged soft set so the graduated geo
  // preference (#2993) can rely on it without the noise of passive viewed-job
  // cities (a single curiosity click on a far-away role).
  const filterLocations = filterLoc && typeof filterLoc === 'object' ? Object.keys(filterLoc) : [];
  const behaviorLocations = [
    ...filterLocations,
    ...viewedJobs.map((v) => v?.location).filter(Boolean),
  ];
  const behaviorTokens = [
    ...searches.map((s) => s?.query).filter(Boolean),
    ...viewedJobs.map((v) => v?.category).filter(Boolean),
  ];
  return { behaviorLocations, behaviorTokens, filterLocations };
}

// ── Matching logic ───────────────────────────────────────────
// The relevance heuristic lives in services/jobAlertMatching.mjs
// (buildAlertProfile + scoreJobForAlert) so it is pure + unit-testable and
// shares the keyword tokenizer with the newsletter funnel. The matching loop
// in main() builds a per-alert profile (alert config + source-job intent +
// newsletter_subscribers profile) and scores every recent job against it.

// ── Email template ───────────────────────────────────────────

// Mirrors the confidence bar used by the upstream needsRetranslation gate
// (scripts/lib/dedicated-crawler-common.mjs, ~line 1395/1415: detectJobTitleLocaleDetails
// + minConfidence 0.55) so the two layers stay consistent.
const HEADLINE_LOCALE_MIN_CONFIDENCE = 0.55;

// Second, independent line of defense against a wrong-language headline
// (live bug, 2026-07-27: an 'it' subscriber's subject + lead card was built
// from an untranslated German title, even though a correctly-localized job
// sat lower in the same ranked list). The upstream `needsRetranslation` flag
// is supposed to fully exclude untranslated-title jobs before they ever reach
// `matchedJobs`, but by construction it can't catch every case (new
// employers, new source languages, code-switched titles under its confidence
// threshold). So rather than trust `shownJobs[0]` blindly, walk the
// rank-ordered list and headline the FIRST job whose title reliably reads as
// `locale` — a bad title can never become the thing a subscriber sees first,
// regardless of whether the upstream flag caught it.
//
// Pure + unit-testable (kept next to buildAlertEmail per this file's stated
// design goal — see the "Matching logic" comment above).
function selectHeadlineIndex(shownJobs, locale) {
  for (let i = 0; i < shownJobs.length; i++) {
    const job = shownJobs[i];
    const title = job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || '';
    const detected = detectJobTitleLocaleDetails(title, locale);
    const reliablyInLocale = detected.lang === locale || detected.confidence < HEADLINE_LOCALE_MIN_CONFIDENCE;
    if (reliablyInLocale) return i;
  }
  // Edge case: none pass (e.g. a single-job alert whose only job is
  // untranslated) — never break the "an alert always sends something"
  // guarantee, and never produce an empty subject. Fall back to today's
  // behavior: the top-ranked job leads regardless.
  return 0;
}

function buildAlertEmail(alert, matchedJobs, autologinEnabled = true) {
  const locale = nlNormLocale(alert.locale);
  const s = getStrings(locale);
  const jobBoardPath = resolveCantonSection(locale, AGGREGATE_KEY);
  const localizedJobBoardPath = `${localePathPrefix(locale)}/${jobBoardPath}`;
  const autologinCode = autologinEnabled ? generateAutologinCode(alert.email) : null;
  // fallbackUnsigned: true reproduces this script's pre-consolidation behavior
  // (an unsigned link instead of a dropped one when NEWSLETTER_SECRET is
  // unset) — line ~830 below string-concatenates this value unguarded, so it
  // must never be null. email.toLowerCase().trim() reproduces the old local
  // implementation's exact query-param + token normalization (alert.email is
  // a raw Firestore field, not pre-normalized like send-newsletter.mjs's
  // subscriber.email).
  const preferencesUrl = makePreferencesUrl(alert.email.toLowerCase().trim(), locale, { fallbackUnsigned: true });

  const keyword = alert.keywords?.join(', ') || '';
  const locationLabel = alert.locations?.length > 0 ? alert.locations.join(', ') : '';
  const subjectLabel = keyword || locationLabel || s.subjectDefault;

  // Honest counts (live report: "186 nuove offerte per te" on an email showing
  // 10 cards). Every count the email states — subject "(+N more)", hero,
  // preheader — is based on the jobs actually RENDERED in this email, not the
  // full match-pool size: the pool is a rolling crawledAt window that re-admits
  // the whole re-crawled inventory daily, so its size says nothing about
  // novelty. What makes the rendered jobs "new for you" is the sentJobIds
  // dedup (never emailed to this alert before) + the freshness-first ranking.
  const shownJobs = matchedJobs.slice(0, MAX_JOB_CARDS);

  // Headline-language backstop (see selectHeadlineIndex): swap the first
  // reliably-`locale` job into the lead position (index 0) so it becomes both
  // the subject and the visually-first card. This only exchanges two
  // positions — the rest of shownJobs keeps its original rank order, and the
  // displaced job is NOT dropped, just no longer leads (its salary/location/
  // company data is still valid; only its fitness as a headline was in doubt).
  const headlineIdx = selectHeadlineIndex(shownJobs, locale);
  if (headlineIdx > 0) {
    [shownJobs[0], shownJobs[headlineIdx]] = [shownJobs[headlineIdx], shownJobs[0]];
  }

  // Subject: lead with the most relevant job (LinkedIn-style personalization).
  // Format: "🔔 {title} at {company}" or "🔔 {title} at {company} (+N more)"
  // Capped at 78 characters total. Empty matches fall back to the legacy generic subject.
  const SUBJECT_MAX = 78;
  // Truncate at the last word boundary before max chars and strip dangling punctuation.
  // This avoids ugly mid-word ellipses like "Revisori dei conti, esperti tecnici…".
  const truncateAtWord = (str, max) => {
    if (str.length <= max) return str;
    const slot = str.slice(0, max - 1); // reserve 1 char for the ellipsis
    const lastSpace = slot.lastIndexOf(' ');
    // If a sensible word boundary exists past 50% of the slot, cut there;
    // otherwise hard-cut to avoid producing a 2-character title.
    let cut = lastSpace > Math.floor(max * 0.5) ? slot.slice(0, lastSpace) : slot;
    // Balance brackets: if the cut left an unmatched "(" / "[" \u2014 e.g. truncating
    // inside a "(100%)" or "(m/w/d)" suffix produced "\u2026 Portafogli (100%" \u2014 drop
    // the dangling fragment so the subject never emits an unbalanced "(100%\u2026".
    const opens = (cut.match(/[([]/g) || []).length;
    const closes = (cut.match(/[)\]]/g) || []).length;
    if (opens > closes) {
      const lastOpen = Math.max(cut.lastIndexOf('('), cut.lastIndexOf('['));
      if (lastOpen > Math.floor(max * 0.4)) cut = cut.slice(0, lastOpen);
    }
    // Drop trailing punctuation AND any dangling function word — the shared
    // peel, so an alert subject never ends on "… esperti tecnici per".
    cut = peelDanglingClauseTail(cut);
    return cut + '\u2026';
  };
  // Strip filler prefixes the crawler / AI translator sometimes prepends to job
  // titles ("Posizione aperta:", "Open position:", "Job opening:", "Open role:")
  // and uppercase the first character so cards never display "addetti..." or
  // "Posizione aperta: consulente..." — both seen live in the latest test send.
  const cleanTitle = (raw) => {
    let t = String(raw || '').trim();
    t = t.replace(/^(?:posizione\s+aperta|posto\s+vacante|annuncio\s+aperto|open\s+(?:position|role|job|posting)|job\s+opening|stellenausschreibung|offene\s+stelle|poste\s+ouvert|offre\s+ouverte)\s*:?\s*/i, '');
    if (t && /[a-zà-ÿ]/i.test(t[0])) {
      t = t.charAt(0).toLocaleUpperCase(locale === 'it' ? 'it-CH' : locale) + t.slice(1);
    }
    return t || raw;
  };
  // Strip Swiss workload (Pensum) and gender markers from a title for the SUBJECT
  // line ONLY — "(100%)", "(80-100%)", "(m/w/d)", "(w/m)" carry no value in a
  // space-constrained subject and used to overflow it and get truncated mid-token
  // into a dangling "(100%…" (reported live). Job CARDS keep these (more room; the
  // workload % is genuinely useful there).
  const stripTitleNoise = (raw) => {
    const original = String(raw || '').trim();
    let t = original
      // Workload: (100%), (80 %), (80-100%), (ca. 60–100 %).
      .replace(/\s*\(\s*(?:ca\.?\s*)?\d{1,3}\s*(?:[–—-]\s*\d{1,3}\s*)?%\s*\)/gi, '')
      // Gender markers: (m/w/d) (w/m) (f/h) (h/f) (m/f/d) (m/w/x) — slash/dash sep.
      .replace(/\s*\(\s*[mwfdhx](?:\s*[/\-]\s*[mwfdhx])+\s*\)/gi, '')
      // Collapse leftover double spaces and any dangling trailing separator.
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[-–—|·,]\s*$/, '')
      .trim();
    return t || original;
  };
  let subject;
  if (matchedJobs.length === 0) {
    subject = `${s.subjectNew(matchedJobs.length)} ${s.subjectFor}: ${subjectLabel}`;
  } else {
    const topJob = shownJobs[0];
    const topTitle = stripTitleNoise(cleanTitle(topJob.titleByLocale?.[locale] || topJob.titleByLocale?.it || topJob.title || s.fallbackTitle));
    const topCompany = (topJob.company || '').trim();
    const extra = shownJobs.length - 1;
    const bell = '\ud83d\udd14';
    const suffix = extra > 0 ? ` (+${extra} ${s.more})` : '';
    // Build: "🔔 {title} at {company}{suffix}"
    const atPart = topCompany ? ` ${s.at} ${topCompany}` : '';
    let candidate = `${bell} ${topTitle}${atPart}${suffix}`;
    if (candidate.length > SUBJECT_MAX) {
      // Step 1: drop the company — preserves the full title (the most informative
      // part) when the company name is too long. "🔔 Assistente di studio medico
      // (+57 altre offerte)" is far better than "🔔 Assistente di… presso EOC –
      // Ente Ospedaliero Cantonale (+57 altre offerte)".
      const noCompany = `${bell} ${topTitle}${suffix}`;
      if (noCompany.length <= SUBJECT_MAX) {
        candidate = noCompany;
      } else {
        // Step 2: title alone still too long — truncate it at a word boundary.
        // Need ≥10 chars of usable title; otherwise fall through to a hard cap.
        const fixed = `${bell} ${suffix}`;
        const room = SUBJECT_MAX - fixed.length;
        if (room >= 10) {
          const truncatedTitle = truncateAtWord(topTitle, room);
          candidate = `${bell} ${truncatedTitle}${suffix}`;
        } else {
          candidate = truncateAtWord(noCompany, SUBJECT_MAX);
        }
      }
      // Final defensive cap (handles edge cases where suffix itself is huge).
      if (candidate.length > SUBJECT_MAX) {
        candidate = truncateAtWord(candidate, SUBJECT_MAX);
      }
    }
    subject = candidate;
  }

  // Brand colors (aligned with newsletter-template.mjs)
  const BRAND_ORANGE = '#f97316';
  const BRAND_DARK = '#0f172a';
  const DARK_CARD = '#1e293b';
  const LIGHT_BG = '#f1f5f9';
  const WHITE = '#ffffff';
  const MUTED = '#64748b';
  const CARD_BG = '#f8fafc';

  const utmBase = `utm_source=job_alert&utm_medium=email&utm_campaign=alert_${alert.id}`;
  const unsubscribeUrl = makeAlertUnsubscribeUrl(alert.id, alert.email);
  const unsubAllUrl = makeAllAlertsUnsubscribeUrl(alert.email);

  // Build locale-aware URLs with autologin
  const wrapUrl = (rawUrl) => makeAuthenticatedUrl(rawUrl, alert.email, autologinCode);
  // "Manage alerts" points to the user's preferences page (which has alert controls),
  // NOT the job board landing — the job board has no alert-management UI.
  const manageUrl = wrapUrl(`${preferencesUrl}&${utmBase}`);
  const allJobsUrl = wrapUrl(`${BASE_URL}${localizedJobBoardPath}/?${utmBase}`);

  const tagChip = (label, palette = 'orange') => {
    const bg = palette === 'green' ? 'rgba(34,197,94,0.2)' : palette === 'blue' ? 'rgba(59,130,246,0.18)' : 'rgba(249,115,22,0.15)';
    const color = palette === 'green' ? '#86efac' : palette === 'blue' ? '#93c5fd' : '#fdba74';
    return `<span style="font-size:10px;background:${bg};color:${color};padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${label}</span>`;
  };

  const jobCards = shownJobs.map((job) => {
    const title = cleanTitle(job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || s.fallbackTitle);
    const company = job.company || '';
    const rawLocation = job.location || job.addressLocality || '';
    const location = rawLocation.replace(/^[-\u2013\u2014\s]+/, '').trim();
    const jobUrl = jobPageUrl(job, locale);
    const rawJobUrl = jobUrl ? `${jobUrl}?${utmBase}` : BASE_URL;
    const url = wrapUrl(rawJobUrl);
    const initial = (company || '?')[0].toUpperCase();
    const avatar = resolveAvatarSrc(job);
    const logoSrc = avatar?.src || null;
    // Bundled logos render contained on white.
    const logoStyle = 'display:block;width:44px;height:44px;border-radius:10px;background:#ffffff;object-fit:contain;padding:4px;box-sizing:border-box;';
    const tags = [];
    // "NEW" badge for jobs first seen within 48 hours.
    const firstSeen = job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : 0;
    const isNew = firstSeen > 0 && (Date.now() - firstSeen) < 48 * 60 * 60 * 1000;
    if (isNew) tags.push(tagChip(s.newBadge, 'green'));
    // Salary chip — only when the job has structured salary data (most don't).
    const salaryLabel = formatSalary(job, locale);
    if (salaryLabel) tags.push(tagChip(escHtml(salaryLabel), 'blue'));
    if (job.contract) tags.push(tagChip(escHtml(normalizeContract(job.contract, locale))));
    if (location) tags.push(tagChip(escHtml(location)));

    // Avatar: real brand logo when we have one bundled, initial-letter fallback otherwise.
    // Email clients block remote images by default — the colored fallback box shows
    // until the user clicks "show images". The img has explicit width/height so the
    // fallback alt text doesn't reflow the card.
    const avatarHtml = logoSrc
      ? `<img src="${logoSrc}" alt="${escHtml(company)}" width="44" height="44" style="${logoStyle}">`
      : `<div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,${BRAND_DARK},#334155);text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${initial}</div>`;

    return `
        <tr><td style="padding:0 0 10px;">
          <a target="_blank" rel="noopener noreferrer" href="${url}" style="text-decoration:none;display:block;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK_CARD};border-radius:12px;">
              <tr>
                <td width="58" style="padding:16px 0 16px 18px;vertical-align:middle;">
                  ${avatarHtml}
                </td>
                <td style="padding:16px 18px 16px 14px;vertical-align:middle;">
                  <div style="font-size:14px;font-weight:700;color:#f1f5f9;margin:0;overflow:hidden;text-overflow:ellipsis;">${escHtml(title)}</div>
                  <div style="font-size:12px;color:#94a3b8;margin-top:2px;">${escHtml(company)}${location ? ' \u00b7 ' + escHtml(location) : ''}</div>
                  ${tags.length > 0 ? `<div style="margin-top:4px;">${tags.join(' ')}</div>` : ''}
                </td>
              </tr>
            </table>
          </a>
        </td></tr>`;
  }).join('');

  const filterParts = [];
  // CompanyAlert (#5012 phase 2): the followed employer IS the filter, and it
  // must be named FIRST. A company-pinned alert has no keywords, no locations
  // and no sectors, so this block used to fall through to `s.allOffers` \u2014 the
  // email told a user who had followed one employer that its filter was
  // "tutte le offerte". Read from the shown jobs (correctly-cased display
  // name) with the persisted slug as the fallback.
  if (alert.specificCompanyKey) {
    const pinnedCompanyName = String(shownJobs[0]?.company || '').trim()
      || String(alert.specificCompanyKey).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    filterParts.push(pinnedCompanyName);
  }
  if (keyword) filterParts.push(keyword);
  if (alert.locations?.length > 0) filterParts.push(alert.locations.join(', '));
  if (alert.sectors?.length > 0) filterParts.push(alert.sectors.join(', '));
  const filterLabel = filterParts.length > 0 ? filterParts.join(' \u00b7 ') : s.allOffers;
  const filterSummary = escHtml(filterLabel);

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Job Alert \u2014 Frontaliere Ticino</title>
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    @media only screen and (max-width:620px){
      .outer-table{width:100%!important;}
      .section-pad{padding-left:16px!important;padding-right:16px!important;}
    }
  </style>
</head>
<body>
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${s.preheader(shownJobs.length, subjectLabel)}&nbsp;\u200c\u200c\u200c\u200c</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">

        <!-- Top bar -->
        <tr><td style="background:${BRAND_DARK};padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;">
                <span style="color:${BRAND_ORANGE};">\u25cf</span> Frontaliere Ticino
              </td>
              <td align="right" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">
                <a target="_blank" rel="noopener noreferrer" href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:none;">${s.manageAlerts}</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero -->
        <tr><td style="background:${BRAND_DARK};padding:20px 28px 28px;" class="section-pad">
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin:0;">${s.heroTitle(shownJobs.length)}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:6px;">${s.filters}: ${filterSummary}</div>
        </td></tr>

        <!-- Section header -->
        <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">${s.sectionLabel}</div>
          <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">${s.sectionTitle}</div>
          <div style="font-size:13px;color:${MUTED};margin:4px 0 0;">${s.sectionDesc}</div>
        </td></tr>

        <!-- Job cards -->
        <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${jobCards}
            <tr><td style="text-align:center;padding-top:14px;">
              <a target="_blank" rel="noopener noreferrer" href="${allJobsUrl}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">${s.viewAll}</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Recommended (revenue) block — config-driven affiliate/sponsor slot
             (#4450/#4449 "every email carries a revenue block"). Job-alert
             recipients are jobs-interested by definition. Renders only when a
             partner/sponsor is active (never an empty box). -->
        ${renderRecommendedBlock({ locale, interest: 'jobs', acquisitionSource: alert.acquisitionSource || alert.source || null, campaign: 'jobalert' })}

        <!-- Closer (aligned with newsletter) -->
        <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;">
          <div style="background:${CARD_BG};border-radius:12px;padding:18px 20px;text-align:center;">
            <div style="font-size:14px;color:#334155;line-height:1.5;margin:0 0 8px;">${s.closer}</div>
            <div style="font-size:12px;color:${BRAND_ORANGE};font-weight:700;">${s.closerSign}</div>
          </div>
        </td></tr>

        <!-- Footer (dark, aligned with newsletter) -->
        <tr><td style="background:${BRAND_DARK};padding:28px;text-align:center;">
          <div style="font-size:11px;color:${MUTED};margin:0 0 14px;line-height:1.5;">
            ${s.intendedFor(escHtml(alert.email), filterSummary)}
          </div>
          <div style="margin-bottom:12px;">
            <a target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/profile.php?id=61588174947294" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcd8</a>
            <a target="_blank" rel="noopener noreferrer" href="https://www.linkedin.com/company/frontaliere-ticino" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcbc</a>
            <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83c\udf10</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            <a target="_blank" rel="noopener noreferrer" href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:underline;font-weight:600;">${s.manageAlerts}</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            ${s.unsubThis(filterLabel)} <a target="_blank" rel="noopener noreferrer" href="${unsubscribeUrl}" style="color:${BRAND_ORANGE};text-decoration:underline;">${s.unsubThisLink}</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            <a target="_blank" rel="noopener noreferrer" href="${unsubAllUrl}" style="color:#94a3b8;text-decoration:underline;">${s.unsubAll}</a> ${s.unsubJoke}
          </div>
          <div style="font-size:12px;color:#475569;margin-top:12px;">\u00a9 ${new Date().getFullYear()} Frontaliere Ticino \u00b7 0% spam, 100% frontaliere</div>
          <div style="font-size:11px;color:#475569;margin-top:6px;">${escHtml(dataControllerFooterLine(locale))}</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ── Plaintext alternative (multipart/alternative) ──────────
  // Built from the same data source as the HTML — never regex-stripped.
  const heroLine = s.heroTitle(shownJobs.length).replace(/\ud83d\udd14\s*/, '\u{1F514} ');
  const textJobs = shownJobs.map((job) => {
    const title = cleanTitle(job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || s.fallbackTitle);
    const company = job.company || '';
    const rawLocation = (job.location || job.addressLocality || '').replace(/^[-\u2013\u2014\s]+/, '').trim();
    const jobUrl = jobPageUrl(job, locale);
    const rawJobUrl = jobUrl ? `${jobUrl}?${utmBase}` : BASE_URL;
    const url = wrapUrl(rawJobUrl);
    const meta = [company, rawLocation].filter(Boolean).join(' \u00b7 ');
    return `${title}\n${meta}\n${url}`;
  }).join('\n---\n');

  const text = [
    heroLine,
    '',
    `${s.textFilters}: ${filterLabel}`,
    '',
    textJobs,
    '',
    `${s.textViewAllLine} ${allJobsUrl}`,
    '',
    `${s.textManageLine} ${manageUrl}`,
    `${s.textUnsubThisLine} ${unsubscribeUrl}`,
    `${s.textUnsubAllLine} ${unsubAllUrl}`,
    '',
    `\u00a9 ${new Date().getFullYear()} Frontaliere Ticino`,
    dataControllerFooterLine(locale),
  ].join('\n');

  return { subject, html, text, unsubscribeUrl };
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Send via email cascade (multi-provider) ──────────────────

// Maileroo's open/click webhooks carry only message_reference_id (no recipient,
// no tags). Persist an authoritative lookup record keyed by that id so the webhook
// can attribute opens/clicks to the job-alert subscriber. Stored under
// newsletter_subscribers/_meta_/maileroo_refs (shared lookup family, distinguished
// by is_job_alert) — same path as the newsletter persistDelivery writer. See
// functions/src/newsletterMailerooWebhookCore.js. The webhook uses meta.email
// directly as the job_alert_subscribers/{email} doc id, and every other writer
// keys that collection by lowercased/trimmed email — so normalize here to avoid
// attributing engagement to an orphan doc for mixed-case addresses.
// Used by both the first-send (sendBatch) and retry (processRetryQueue) paths.
export async function mailerooMetaOnSent(item, sendResult) {
  if (sendResult?.provider !== 'maileroo' || !sendResult?.messageId) return;
  const email = item.recipient?.email?.toLowerCase().trim();
  if (!email) return;
  try {
    const db = await getFirestoreAdmin();
    await db.collection('newsletter_subscribers').doc('_meta_')
      .collection('maileroo_refs').doc(String(sendResult.messageId)).set({
      email,
      is_job_alert: true,
      updated_at: new Date(),
    }, { merge: true });
  } catch (e) {
    console.warn('⚠️ Maileroo meta persist failed:', e?.message);
  }
}

// Job-alert delivery record (#3798 report accuracy): mirrors send-newsletter.mjs's
// persistDelivery, but keyed by alertId instead of campaignId — writes under
// job_alert_subscribers/{email}/campaign_deliveries/{buildDeliveryDocId(alertId,
// email)} so scripts/report-send-hour-impact.mjs's collectionGroup('campaign_deliveries')
// query (previously job-alert-blind — job alerts only wrote alert_deliveries, a
// differently-named/shaped subcollection) sees per-user send-time outcomes for
// job alerts too. Used by both the first-send (sendBatch) and retry
// (processRetryQueue) paths, same as mailerooMetaOnSent above.
async function persistJobAlertDelivery(item, sendResult) {
  const email = item.recipient?.email?.toLowerCase().trim();
  const alertId = item.meta?.alertId;
  if (!email || !alertId) return;
  try {
    const db = await getFirestoreAdmin();
    const deliveryDocId = buildDeliveryDocId(alertId, email);
    await db.collection('job_alert_subscribers').doc(email)
      .collection('campaign_deliveries').doc(deliveryDocId).set({
      email,
      campaign_id: alertId,
      message_id: sendResult?.messageId || null,
      provider: sendResult?.provider || null,
      // Per-user send-time (#3798): scheduledFor is the cascade's authoritative
      // outcome (null when provider didn't honor/support scheduling), not just
      // what was requested. sendTimeSource carries WHY it was requested
      // (personal/global) — absent entirely for retries, which never resolve one.
      scheduled_for: sendResult?.scheduledFor ?? null,
      send_time_source: item.meta?.sendTimeSource ?? null,
      is_operator_verification: !!item.meta?.isOperatorVerification,
      sent_at: new Date(),
    }, { merge: true });
  } catch (e) {
    console.warn('⚠️ Job-alert delivery persist failed:', e?.message);
  }
}

// sendEmailCascade accepts a single onSent callback — compose both post-send
// side effects here so both call sites (sendBatch, processRetryQueue) wire the
// same behavior via one named reference.
async function onSentComposed(item, sendResult) {
  await mailerooMetaOnSent(item, sendResult);
  await persistJobAlertDelivery(item, sendResult);
}

async function sendBatch(emails) {
  // Use cascade for bulk sending
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');

  const cascadeEmails = emails.map(e => {
    // Gmail FBL: Feedback-ID category:identifier:sender-name
    const feedbackHeader = { 'Feedback-ID': `job-alert:${e.alertId}:frontaliere-ticino` };
    // RFC 8058: List-Unsubscribe + List-Unsubscribe-Post for one-click unsubscribe
    const unsubHeaders = e.unsubscribeUrl ? {
      'List-Unsubscribe': `<${e.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : {};
    return {
      payload: {
        from: FROM_EMAIL,
        to: [e.to],
        subject: e.subject,
        html: e.html,
        text: e.text,
        tags: [
          { name: 'type', value: 'job-alert' },
          { name: 'alert_id', value: e.alertId },
        ],
        headers: { ...feedbackHeader, ...unsubHeaders },
        // Per-user send-time (#3798) — resolved per-recipient in main() above
        // and carried through on the pre-send item; omitted entirely (not
        // just null) when absent, matching email-cascade.mjs's own contract
        // for "no scheduling requested".
        ...(e.scheduledAt ? { scheduledAt: e.scheduledAt } : {}),
      },
      recipient: { email: e.to },
      meta: {
        type: 'job-alert',
        alertId: e.alertId,
        sendTimeSource: e.sendTimeSource || null,
        // is_operator_verification (#3798 report accuracy): ALLOWED_EMAILS set means
        // an operator verification run (parallel send-newsletter.mjs's mode==='test')
        // targeting specific recipient(s), not real subscriber traffic — flagged so
        // report-send-hour-impact.mjs can exclude it.
        isOperatorVerification: !!ALLOWED_EMAILS,
      },
    };
  });

  const result = await sendEmailCascade(cascadeEmails, {
    concurrency: 3,
    onSent: onSentComposed,
  });
  logProviderSummary();

  // Per-user send-time observability (#3798 follow-up): the cascade returns
  // the authoritative scheduledFor per item (sent[i] === { ...cascadeEmail,
  // ...result }, see sendEmailCascade in email-cascade.mjs) — a provider may
  // not honor the requested scheduledAt, so this is what actually happened,
  // not just what was requested. Capture it here, keyed by recipient email, so
  // the post-send Firestore writes in main() can persist it (last_scheduled_for
  // / last_send_time_source) instead of silently discarding it.
  const scheduleOutcomes = new Map();
  for (const item of result.sent) {
    const email = (item.recipient?.email || '').toLowerCase();
    if (!email) continue;
    scheduleOutcomes.set(email, {
      scheduledFor: item.scheduledFor ?? null,
      sendTimeSource: item.meta?.sendTimeSource ?? item.sendTimeSource ?? null,
    });
  }

  return {
    sent: result.sent.length,
    failed: result.failed.length,
    failedItems: result.failed,
    scheduleOutcomes,
  };
}

// ── Retry queue: enqueue failed emails ──────────────────────

async function enqueueFailedEmails(db, failedItems) {
  if (failedItems.length === 0) return;
  const { FieldValue } = await import('firebase-admin/firestore');

  // Pre-filter so the slice length is a safe upper bound on ops-per-batch, then
  // chunk the writes past the Firestore 500-op batch cap (a mass-failure run can
  // exceed it; a single commit() would throw and enqueue nothing for retry).
  const toEnqueue = failedItems.filter((item) => item.recipient?.email);
  const enqueued = toEnqueue.length;

  if (enqueued > 0) {
    await commitInChunks(db, toEnqueue, (batch, item) => {
      const docRef = db.collection(RETRY_COLLECTION).doc();
      batch.set(docRef, {
        alertId: item.meta?.alertId || '',
        email: item.recipient.email,
        subject: item.payload?.subject || '',
        html: item.payload?.html || '',
        createdAt: FieldValue.serverTimestamp(),
        retryCount: 0,
        error: (item.error || '').slice(0, 500),
      });
    });
    console.log(`   🔄 Enqueued ${enqueued} failed emails for retry (max ${MAX_RETRY_COUNT} retries)`);
  }
}

// ── Retry queue: process pending retries ────────────────────

async function processRetryQueue(db) {
  const snap = await db.collection(RETRY_COLLECTION).get();
  if (snap.empty) {
    console.log('   🔄 Retry queue: empty — nothing to retry');
    return;
  }

  console.log(`   🔄 Retry queue: ${snap.size} pending email(s) to retry`);
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const { FieldValue } = await import('firebase-admin/firestore');

  const retryEmails = [];
  const retryDocs = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const retryCount = data.retryCount || 0;

    if (retryCount >= MAX_RETRY_COUNT) {
      // Max retries exhausted — give up
      console.warn(`   ⚠️  Giving up on email to ${data.email} (alert ${data.alertId}) after ${retryCount} retries`);
      await doc.ref.delete();
      continue;
    }

    // Per-user send-time (#3798): deliberately NO scheduledAt here. A retry
    // means the first attempt already missed today's daily quota window — the
    // recipient is already late, so send it the moment fresh quota is
    // available rather than deferring it further to their preferred hour.
    retryEmails.push({
      payload: {
        from: FROM_EMAIL,
        to: [data.email],
        subject: data.subject,
        html: data.html,
        tags: [{ name: 'type', value: 'job-alert-retry' }],
      },
      recipient: { email: data.email },
      meta: { type: 'job-alert-retry', alertId: data.alertId },
    });
    retryDocs.push({ ref: doc.ref, data });
  }

  if (retryEmails.length === 0) {
    console.log('   🔄 Retry queue: all entries expired (max retries reached)');
    return;
  }

  console.log(`   🔄 Retrying ${retryEmails.length} email(s)...`);
  // Pass the same onSent so retried emails also write a maileroo_message_meta
  // record — otherwise their open/click webhooks fall back to `skipped` (the exact
  // attribution bug fixed for the first-send path in #1135).
  const result = await sendEmailCascade(retryEmails, {
    concurrency: 3,
    onSent: onSentComposed,
  });
  logProviderSummary();

  // Build a set of successfully sent recipient emails for lookup
  const sentEmails = new Set(result.sent.map(s => s.recipient?.email));

  let successCount = 0;
  let reEnqueueCount = 0;

  for (const { ref, data } of retryDocs) {
    if (sentEmails.has(data.email)) {
      // Successfully retried — remove from queue
      await ref.delete();
      successCount++;
      console.log(`   ✅ Retry succeeded: ${data.email} (alert ${data.alertId})`);
    } else {
      // Still failed — increment retryCount
      const newCount = (data.retryCount || 0) + 1;
      if (newCount >= MAX_RETRY_COUNT) {
        console.warn(`   ⚠️  Giving up on email to ${data.email} (alert ${data.alertId}) after ${newCount} retries`);
        await ref.delete();
      } else {
        await ref.update({
          retryCount: newCount,
          lastRetryAt: FieldValue.serverTimestamp(),
          lastError: result.failed.find(f => f.recipient?.email === data.email)?.error?.slice(0, 500) || 'unknown',
        });
        reEnqueueCount++;
        console.log(`   🔄 Retry failed for ${data.email} — attempt ${newCount}/${MAX_RETRY_COUNT}, will retry tomorrow`);
      }
    }
  }

  console.log(`   🔄 Retry summary: ${successCount} succeeded, ${reEnqueueCount} will retry tomorrow`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('🔔 Job Alert Matching — Starting...');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // FRO-353: Check feature flag from Firebase Remote Config
  // The flag is loaded by load-rc-env.mjs into process.env
  const featureEnabled = process.env.ENABLE_JOB_ALERTS === 'true';
  if (!featureEnabled) {
    console.log('   ⚠️  ENABLE_JOB_ALERTS is not true — skipping (feature flag off).');
    return;
  }

  // 0. Process retry queue FIRST — retries get priority on fresh daily quota
  const db = await getFirestoreAdmin();
  if (!DRY_RUN) {
    await processRetryQueue(db);
  } else {
    console.log('   🔵 DRY RUN — skipping retry queue processing');
  }

  // Per-user send-time (#3798): read the site-wide fallback hour written by
  // send-newsletter.mjs onto newsletter_subscribers/_meta_ once per run — a
  // single get(), not a per-recipient read. null when that doc doesn't exist
  // yet or the newsletter run never computed a global hour (too few qualified
  // users — see MIN_GLOBAL_SAMPLE_USERS in scripts/lib/send-schedule.mjs).
  let globalPreferredHour = null;
  try {
    const metaSnap = await db.collection('newsletter_subscribers').doc('_meta_').get();
    const hourUtc = metaSnap.exists ? metaSnap.data()?.global_preferred_send_hour_utc : null;
    globalPreferredHour = Number.isInteger(hourUtc) ? hourUtc : null;
  } catch (e) {
    console.warn(`   ⚠️  Global preferred send hour read failed: ${e?.message || e}`);
  }

  // 1. Load recent jobs (+ full-dataset geo index for source-job resolution)
  const { recent: recentJobs, locationIndex, cityToCanton } = loadJobs();
  console.log(`   Recent jobs (last 24h): ${recentJobs.length}`);
  // Diagnostic (#3020): confirm the full-dataset geo index is non-trivially
  // populated. Source-geo recovery for one-tap alerts (sourceJobLocationsFor)
  // is a soft no-op when this index is empty — so a size of 0 here means the
  // slug/slugByLocale/canton/location fields are absent from data/jobs.json and
  // the one-tap precision boost never materializes. Expected: ≫ 0.
  console.log(`   Geo index entries (slug/id → location): ${locationIndex.size}`);
  if (recentJobs.length === 0) {
    console.log('   No recent jobs — skipping.');
    return;
  }

  // 2. Load active alerts from Firestore.
  // Fast path: when TARGET_EMAIL is set, query that user's subcollection directly
  // (collection scope, no composite/single-field index required). This unblocks
  // workflow_dispatch test sends even if the collection-group index is missing.
  // Normal path: collectionGroup across job_alert_subscribers/*/alerts/* — needs
  // the composite index (active ASC, frequency ASC) declared in firestore.indexes.json.
  let alertDocs;
  if (TARGET_EMAIL_RAW) {
    const subRef = db.collection('job_alert_subscribers').doc(TARGET_EMAIL_RAW).collection('alerts');
    const snap = await subRef.where('active', '==', true).get();
    alertDocs = snap.docs;
    console.log(`   📍 Direct subcollection query for ${TARGET_EMAIL_RAW}: ${alertDocs.length} active alert(s)`);
  } else {
    const alertsSnap = await db.collectionGroup('alerts').where('active', '==', true).get();
    alertDocs = alertsSnap.docs.filter((doc) => {
      // Defensive: collectionGroup returns ALL `alerts` subcollections in the project.
      // Restrict to docs whose grandparent collection is job_alert_subscribers.
      const grandparent = doc.ref.parent.parent?.parent?.id;
      return grandparent === 'job_alert_subscribers';
    });
  }
  let alerts = alertDocs.map((doc) => {
    const data = doc.data();
    const parentEmail = doc.ref.parent.parent?.id || data.email;
    // `ref` is preserved so the post-send batch can update lastMatchedAt without
    // having to rebuild the path.
    return { id: doc.id, ref: doc.ref, ...data, email: data.email || parentEmail };
  });

  // Issue #4298 follow-up fix: `paused` is a dedicated flag, orthogonal to
  // `active` (which stays SOLELY the soft-delete flag — see
  // functions/src/newsletterSubscriptionManagement.js). A paused alert must
  // never send; skip it here before any downstream matching/logging.
  const beforePauseFilter = alerts.length;
  alerts = alerts.filter((a) => a.paused !== true);
  if (alerts.length !== beforePauseFilter) {
    console.log(`   ⏸️  Paused alerts skipped: ${beforePauseFilter - alerts.length}`);
  }

  // CompanyAlert on the IMMEDIATE cadence belongs to scripts/send-company-alerts.mjs
  // (#5012 phase 2), which is event-driven on new jobs. This is the negation of
  // that runner's claim predicate — one shared function
  // (scripts/lib/company-alert-routing.mjs), applied on both sides, so the two
  // senders stay disjoint AND total. Without it the subscriber would receive the
  // same job twice: once immediately, once in tomorrow's digest.
  const beforeImmediateFilter = alerts.length;
  alerts = alerts.filter((a) => !isImmediateCompanyAlert(a));
  if (alerts.length !== beforeImmediateFilter) {
    console.log(`   🏢 Immediate CompanyAlerts skipped (owned by send-company-alerts.mjs): ${beforeImmediateFilter - alerts.length}`);
  }

  // Filter to allowed emails during testing phase
  if (ALLOWED_EMAILS) {
    const before = alerts.length;
    alerts = alerts.filter((a) => ALLOWED_EMAILS.has(String(a.email || '').toLowerCase()));
    if (before !== alerts.length) {
      console.log(`   ⚠️  Allowlist active: ${before} alerts → ${alerts.length} (admin-only testing)`);
    }
  }
  console.log(`   Active alerts: ${alerts.length}`);
  if (alerts.length === 0) {
    console.log('   No active alerts — skipping.');
    return;
  }

  // 2b. Newsletter cooldown: skip users who received a newsletter in the last 36 hours
  // SKIP_NEWSLETTER_COOLDOWN=1 bypasses this check (for manual test sends)
  const NEWSLETTER_COOLDOWN_MS = process.env.SKIP_NEWSLETTER_COOLDOWN === '1' ? 0 : 36 * 60 * 60 * 1000;
  const now = Date.now();
  const alertEmails = [...new Set(alerts.map((a) => a.email.toLowerCase()))];
  const newsletterCooldownSet = new Set();
  const autologinDisabledSet = new Set();
  // Address-level hard signals (hard bounce / spam complaint / provider
  // suppression list). The webhook cores write these to EITHER channel's doc;
  // unlike a per-alert unsubscribe (active:false) they mean the mailbox is dead
  // or hostile, so we must stop sending it job alerts too. Mirrors the newsletter
  // sender's EXCLUDED_STATUSES — previously the alert sender honored NEITHER.
  const suppressedEmails = new Set();
  // Subscriber profiles keyed by lowercased email. Captured here (reusing the
  // newsletter_subscribers read this loop already performs — zero extra reads)
  // so the matcher can fold the newsletter profile (job_company, job_category,
  // sector_interest, location_interest, preferences, …) into relevance scoring.
  const subscriberProfiles = new Map();
  // job_alert_subscribers/{email} raw doc data, keyed by lowercased email
  // (#3798 — this channel's OWN preferred_send_hour_utc/sample_count, read
  // for resolveEffectivePreferredHour; falls back to subscriberProfiles'
  // newsletter-channel data when this doc has no signal of its own yet).
  const jobAlertProfiles = new Map();
  // Browsing-personalization signals (filter usage + viewed-job cities/searches)
  // keyed by lowercased email. These live in a SUBCOLLECTION the matcher never
  // read before (newsletter_subscribers/{email}/private/personalization), which
  // is why precise location data was "missing" from alerts (issue #2993).
  const behaviorProfiles = new Map();
  // Raw personalization subdoc + whether the parent doc exists, kept so the
  // post-send enrichment step (section 6 below) can consolidate every signal
  // back into the flat profile fields (no-clobber).
  const personalizationRaw = new Map();
  const subscriberDocExists = new Set();
  // Last job-link the subscriber CLICKED in an email (ESP-recorded
  // `last_clicked_url`), keyed by email. The strongest intent signal we hold —
  // resolved to job geo/employer and fed at top weight into matching +
  // personalization (#3025). Prefer the alert-channel click over the newsletter.
  const lastClickedUrlByEmail = new Map();
  // Batched via db.getAll() instead of 3 sequential .get() awaits per email —
  // same reads, same billed count, but one round-trip per chunk instead of
  // 3×alertEmails.length serial round-trips (was the dominant Firestore read
  // spike in the daily send-job-alerts run: ~12-21k LOOKUP reads over 2-3h).
  const LOOKUP_CHUNK_SIZE = 200; // emails per db.getAll() call (3 refs/email → ≤600 refs/call)
  for (let i = 0; i < alertEmails.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = alertEmails.slice(i, i + LOOKUP_CHUNK_SIZE);
    try {
      // refs built INSIDE the try: `.doc(email)` throws synchronously on a
      // malformed id (e.g. an email containing `/`), and this loop has no
      // caller-level catch of its own — an escaped throw here propagates to
      // the top-level `main().catch()`, aborting the WHOLE script (every
      // remaining chunk + the downstream matching/send step), not just this
      // chunk's email(s).
      const refs = chunk.flatMap((email) => [
        db.collection('newsletter_subscribers').doc(email),
        // A bounce/complaint reported on the alert channel lands on the
        // job_alert_subscribers doc, not newsletter_subscribers — check both.
        // isJobAlertExcluded also covers this channel's OWN inactivity-sunset
        // 'inactive' state (scripts/lib/jobAlertSunset.mjs, issue #2852 item 1) —
        // soft and reversible, unlike the hard cross-channel signals above.
        db.collection('job_alert_subscribers').doc(email),
        // Personalization subdoc (browsing-derived location + intent). Read here
        // so the matcher can fold it into ranking; absent for users who never
        // browsed while identified — the matcher tolerates an empty profile.
        db.collection('newsletter_subscribers').doc(email).collection('private').doc('personalization'),
      ]);
      const snaps = await db.getAll(...refs);
      chunk.forEach((email, idx) => {
        const [subDoc, alertSubDoc, personDoc] = snaps.slice(idx * 3, idx * 3 + 3);

        if (subDoc.exists) {
          subscriberDocExists.add(email.toLowerCase());
          const data = subDoc.data() || {};
          subscriberProfiles.set(email.toLowerCase(), data);
          if (data.last_clicked_url) lastClickedUrlByEmail.set(email.toLowerCase(), data.last_clicked_url);
          if (isAddressSuppressed(data.status)) suppressedEmails.add(email.toLowerCase());
          const lastSentAt = data.last_sent_at;
          if (lastSentAt) {
            const ts = typeof lastSentAt.toMillis === 'function' ? lastSentAt.toMillis() : new Date(lastSentAt).getTime();
            if (now - ts < NEWSLETTER_COOLDOWN_MS) {
              newsletterCooldownSet.add(email.toLowerCase());
            }
          }
          if (data.autologin_enabled === false) {
            autologinDisabledSet.add(email.toLowerCase());
          }
        }

        if (alertSubDoc.exists) {
          const alertData = alertSubDoc.data() || {};
          jobAlertProfiles.set(email.toLowerCase(), alertData);
          if (isJobAlertExcluded(alertData.status)) suppressedEmails.add(email.toLowerCase());
          // Alert-channel click is the most relevant — overrides the newsletter one.
          if (alertData.last_clicked_url) lastClickedUrlByEmail.set(email.toLowerCase(), alertData.last_clicked_url);
        }

        if (personDoc.exists) {
          const personData = personDoc.data() || {};
          behaviorProfiles.set(email.toLowerCase(), behaviorSignals(personData));
          personalizationRaw.set(email.toLowerCase(), personData);
        }
      });
    } catch (err) {
      // Fail-open (don't drop valid recipients on a transient read blip) but
      // stay observable — a silent catch previously hid Firestore read failures.
      // Granularity is per-chunk now (was per-email): a getAll() failure is a
      // single RPC-level error, not per-document, so isolating further would
      // need per-email getAll calls — defeating the batching this fixes.
      console.warn(`   ⚠️  batched subscriber lookup failed for ${chunk.length} email(s) starting at ${chunk[0]}: ${err?.message || err}`);
    }
  }
  if (suppressedEmails.size > 0) {
    const before = alerts.length;
    alerts = alerts.filter((a) => !suppressedEmails.has(a.email.toLowerCase()));
    console.log(`   🚫 Hard-suppressed (bounced/complained/provider list): ${before - alerts.length} alert(s) skipped`);
  }
  if (autologinDisabledSet.size > 0) {
    console.log(`   🔒 Autologin opt-out: ${autologinDisabledSet.size} subscriber(s) will receive email without autologin token`);
  }
  if (newsletterCooldownSet.size > 0) {
    const before = alerts.length;
    alerts = alerts.filter((a) => !newsletterCooldownSet.has(a.email.toLowerCase()));
    console.log(`   📬 Newsletter cooldown (36h): ${before - alerts.length} alerts deferred (newsletter sent recently)`);
  }

  // 2c. Resolve each alert's effective cadence tier, then gate on it.
  // Engine-managed by default — recency of last_open_at/last_click_at on the
  // root job_alert_subscribers/{email} doc (scripts/lib/jobAlertEngagementTier.mjs,
  // owner design 2026-07-16) — unless the alert carries a sticky manual
  // `frequencyOverride`, in which case the pinned frequency wins verbatim.
  // `effectiveTier` is stamped onto each alert so the post-send batch below
  // can persist it for observability (last_engagement_tier).
  const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  // Coincidentally the same magnitude as NEWSLETTER_COOLDOWN_MS above and
  // send-newsletter.mjs's JOB_ALERT_COOLDOWN_MS, but a distinct guard: those
  // two are cross-channel send dedup, this is the per-alert engagement tier.
  // The gate is 36h but cron runs once/day → effective cadence is every other
  // day (~48h). Tier and constant are named accordingly (OPEN_EVERY_OTHER_DAY).
  const ENGAGEMENT_TIER_EVERY_OTHER_DAY_INTERVAL_MS = 36 * 60 * 60 * 1000;
  alerts = alerts.filter((alert) => {
    const emailKey = alert.email.toLowerCase();
    const verdict = resolveEffectiveJobAlertTier(alert, jobAlertProfiles.get(emailKey) || null, now);
    alert.effectiveTier = verdict.tier;

    if (!alert.lastMatchedAt) return true; // never sent — no interval to respect
    const lastSent = typeof alert.lastMatchedAt.toMillis === 'function'
      ? alert.lastMatchedAt.toMillis()
      : new Date(alert.lastMatchedAt).getTime();

    if (verdict.tier === JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY) {
      return now - lastSent >= WEEKLY_INTERVAL_MS;
    }
    if (verdict.tier === JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY) {
      return now - lastSent >= ENGAGEMENT_TIER_EVERY_OTHER_DAY_INTERVAL_MS;
    }
    return true; // daily tier — no interval gate, same as legacy daily behavior
  });

  // 2d. Pre-generation capacity check: the loop below does real work per
  // alert (job scoring, live-link HEAD checks over the network, HTML
  // building) — doing that for alerts the shared cascade cannot possibly
  // send today just means it fails at send time and lands in tomorrow's
  // retry queue, so the same work happens twice. Size the work to what's
  // ACTUALLY left in the cascade today (after the retries already sent
  // above), reserve a buffer for send-time errors, and only build content
  // for that many alerts — most-engaged tier first, same priority the
  // post-send sort below re-applies as a safety net. Alerts left over are
  // simply untouched (no lastMatchedAt bump), so they're picked up again on
  // tomorrow's run rather than lost.
  const { getAvailableCascadeQuota } = await import('./lib/email-cascade.mjs');
  const availableQuota = await getAvailableCascadeQuota();
  alerts.sort((a, b) => (ENGAGEMENT_SEND_PRIORITY[a.effectiveTier] ?? 2) - (ENGAGEMENT_SEND_PRIORITY[b.effectiveTier] ?? 2));
  const quotaBuffer = Math.ceil(availableQuota * QUOTA_BUFFER_RATIO);
  const sendableCapacity = Math.max(0, availableQuota - quotaBuffer);
  if (alerts.length > sendableCapacity) {
    console.log(`   📉 Capacity check: ${availableQuota} cascade quota left today (buffer ${quotaBuffer}) → building ${sendableCapacity}/${alerts.length} alerts by engagement tier; ${alerts.length - sendableCapacity} deferred to next run`);
    alerts = alerts.slice(0, sendableCapacity);
  } else {
    console.log(`   📉 Capacity check: ${availableQuota} cascade quota left today (buffer ${quotaBuffer}) — all ${alerts.length} alerts fit`);
  }

  // 3. Match alerts to jobs
  const emailsToSend = [];
  let totalMatches = 0;
  let zeroMatchCount = 0;
  const zeroMatchByCause = {};
  // Shared across every alert/locale below so the same job's page is never
  // HEAD-checked twice in one run (#3172).
  const jobLiveCheckCache = new Map();

  for (const alert of alerts) {
    // Enrich the alert with the subscriber's newsletter profile, browsing
    // personalization (filter usage + viewed-job geography) and the geography of
    // the job it was created from, then score every recent job against it.
    const behavior = behaviorProfiles.get(alert.email.toLowerCase()) || {};
    // The job the subscriber last clicked in an email — fold its geography into
    // the soft location boost (strongest intent; #3025).
    const clicked = clickedJobMeta(lastClickedUrlByEmail.get(alert.email.toLowerCase()), locationIndex);
    const sourceJobLocations = sourceJobLocationsFor(alert, locationIndex);
    const extras = {
      behaviorLocations: [...(behavior.behaviorLocations || []), ...clicked.locations],
      behaviorTokens: behavior.behaviorTokens || [],
      sourceJobLocations,
      // High-confidence geo signals for the graduated geo preference (#2993):
      // explicit on-site filters + clicked/source job geography. Passive
      // viewed-job cities are deliberately excluded (see buildAlertProfile).
      strongLocations: [
        ...(behavior.filterLocations || []),
        ...clicked.locations,
        ...sourceJobLocations,
      ],
      cityToCanton,
    };
    const profile = buildAlertProfile(
      alert,
      subscriberProfiles.get(alert.email.toLowerCase()) || null,
      extras,
    );
    // Canary gate: broadcast-restricted ads only ever match the OWNER's alerts,
    // so a test listing can't reach real alert subscribers.
    const canaryEligible = isOwnerEmail(alert.email) ? recentJobs : recentJobs.filter((j) => !isCanaryJob(j));
    // needsRetranslation only means translations FROM the job's source locale
    // are stale — exclude a job from THIS alert only when its own source
    // locale differs from the recipient's locale (#4715).
    const alertLocale = nlNormLocale(alert.locale);
    const eligibleJobs = canaryEligible.filter(
      (j) => !(j.needsRetranslation === true && alertLocale !== (j.sourceLang || 'it')),
    );
    // Relevance score + graduated freshness boost: a job first seen within
    // 24h/48h gets +2/+1 on top of its relevance so GENUINELY new listings win
    // near-ties against the re-crawled backlog (the pool re-admits the whole
    // inventory daily — see MATCH_WINDOW_MS). The boost never resurrects a
    // 0-score job: relevance still decides IF a job surfaces, freshness only
    // decides how high.
    const sorted = eligibleJobs
      .map((job) => {
        const relevance = scoreJobForAlert(job, profile, nlNormLocale(alert.locale));
        return { job, score: relevance > 0 ? relevance + freshnessBoost(job, now) : 0 };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => {
        // Primary: higher score first.
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        // Tiebreak: more recently first-seen jobs first. Without this, location-only
        // alerts (where every match has score=2) yielded an arbitrary insertion order
        // and stale jobs leaked into the subject line.
        const aTime = a.job.firstSeenAt ? new Date(a.job.firstSeenAt).getTime() : 0;
        const bTime = b.job.firstSeenAt ? new Date(b.job.firstSeenAt).getTime() : 0;
        return bTime - aTime;
      });

    // Per-company cap: at most 2 jobs per company in the surfaced list. Without
    // this, recency-sorted location-only alerts produce 9/10 cards from the same
    // employer (e.g. all EOC) — visually monotone. Overflow jobs are kept in
    // `remainder` and appended after the cap is exhausted, so the user still
    // sees the count when they have enough variety.
    const PER_COMPANY_CAP = 2;
    const perCompany = new Map();
    const surfaced = [];
    const remainder = [];
    for (const m of sorted) {
      const key = String(m.job.company || '\u2205').toLowerCase();
      const count = perCompany.get(key) || 0;
      if (count < PER_COMPANY_CAP) {
        surfaced.push(m.job);
        perCompany.set(key, count + 1);
      } else {
        remainder.push(m.job);
      }
    }
    const rankedAll = surfaced.concat(remainder).map((job) => job);

    // Graduated geo preference (#2993): for a keyword-only alert with no explicit
    // location/canton scope, prefer jobs in the subscriber's area (resolved from
    // their home city + explicit on-site filters + clicked/source job) so a
    // Ticino nurse stops receiving Basel/Zürich roles — while still falling back
    // to out-of-area matches when too few local ones exist (never starves a
    // sparse alert). No-op when the alert already scopes geography itself.
    const ranked = partitionByGeoPreference(rankedAll, profile);

    if (ranked.length === 0) {
      const cause = classifyZeroMatchCause(profile);
      zeroMatchCount++;
      zeroMatchByCause[cause] = (zeroMatchByCause[cause] || 0) + 1;
      console.log(`   ⏭️ Alert ${alert.id}: 0 matches (${cause}) → skip`);
      continue;
    }

    // De-dup: drop jobs already emailed to THIS alert within the dedup window.
    // Without this a re-crawled job (its crawledAt refreshes, so it re-enters the
    // 24h pool) headlines the alert every single day — the "I keep getting the
    // same jobs" report (#2993). When nothing new remains we skip the send
    // entirely rather than re-mail stale offers.
    const sentMap = normalizeSentMap(alert.sentJobIds);
    const matched = filterUnsentJobs(ranked, sentMap, now, DEDUP_WINDOW_MS);
    if (matched.length === 0) {
      console.log(`   ⏭️  Alert ${alert.id}: ${ranked.length} matches, all already sent → skip`);
      continue;
    }

    // Preflight (#3172): drop any job whose live page 404s/times out before
    // it gets baked into the email — data/jobs.json is a crawl snapshot and
    // can lag the job actually being pulled/expired, or the deploy of its
    // per-locale SSG page.
    const liveMatched = await filterLiveJobs(matched, nlNormLocale(alert.locale), jobLiveCheckCache);
    if (liveMatched.length === 0) {
      console.log(`   ⏭️  Alert ${alert.id}: ${matched.length} matches, all failed the live-link check → skip`);
      continue;
    }

    totalMatches += liveMatched.length;
    const autologinEnabled = !autologinDisabledSet.has(alert.email.toLowerCase());
    const { subject, html, text, unsubscribeUrl } = buildAlertEmail(alert, liveMatched, autologinEnabled);

    // Mark the jobs actually shown (the rendered cards) as sent so they rotate
    // out next run. buildAlertEmail renders up to MAX_JOB_CARDS cards.
    // References, not copies — cheap to carry to the post-send persistence step.
    const sentJobs = liveMatched.slice(0, MAX_JOB_CARDS);

    // Per-user send-time (#3798): this channel's own preferred hour first
    // (job_alert_subscribers/{email}), falling back to the subscriber's
    // newsletter-channel hour, then the site-wide global hour. Both doc
    // lookups were already loaded above (zero extra reads) — see
    // jobAlertProfiles/subscriberProfiles.
    let scheduledAt = null;
    let sendTimeSource = null;
    // TARGET_EMAIL/ALLOWED_EMAILS set means this is an operator verification
    // run against specific recipient(s) (parallel to send-newsletter.mjs's
    // --test --target-email) — it must arrive immediately so the operator can
    // confirm the send works, not get deferred to the preferred hour.
    if (!ALLOWED_EMAILS && perUserSendTimeEnabled()) {
      const emailKey = alert.email.toLowerCase();
      const resolved = resolveEffectivePreferredHour({
        subscriberDoc: jobAlertProfiles.get(emailKey) || null,
        fallbackDoc: subscriberProfiles.get(emailKey) || null,
        globalHour: globalPreferredHour,
      });
      if (resolved.hourUtc !== null) {
        scheduledAt = computeScheduledSendAt({ preferredHourUtc: resolved.hourUtc, email: alert.email });
        sendTimeSource = resolved.source;
      }
    }

    emailsToSend.push({
      to: alert.email,
      subject,
      html,
      text,
      alertId: alert.id,
      ref: alert.ref,
      effectiveTier: alert.effectiveTier,
      matchCount: matched.length,
      sentMap,
      sentJobs,
      unsubscribeUrl,
      scheduledAt,
      sendTimeSource,
    });

    console.log(`   📬 Alert ${alert.id}: ${matched.length} matches → ${alert.email}`);
  }

  // Most-engaged-first send order: if the shared cascade daily cap is hit
  // mid-run, the recipients who already got their email should be the ones
  // most likely to open/click (daily-tier clickers), not whoever happened
  // to be queued first. Array.prototype.sort is stable in Node, so within a
  // tier the existing order (alert enumeration order) is preserved.
  // (ENGAGEMENT_SEND_PRIORITY is declared near the top of the file — also
  // used by the pre-generation capacity check above.)
  emailsToSend.sort((a, b) => (ENGAGEMENT_SEND_PRIORITY[a.effectiveTier] ?? 2) - (ENGAGEMENT_SEND_PRIORITY[b.effectiveTier] ?? 2));

  console.log(`\n   Total: ${emailsToSend.length} emails, ${totalMatches} job matches`);

  if (alerts.length > 0) {
    const zeroMatchRate = zeroMatchCount / alerts.length;
    console.log(`   📉 Zero-match: ${zeroMatchCount}/${alerts.length} alerts (${(zeroMatchRate * 100).toFixed(1)}%) — by cause: ${JSON.stringify(zeroMatchByCause)}`);
    // Skip during --dry-run / TARGET_EMAIL test sends: the denominator there
    // is tiny and non-representative, so the rate is meaningless noise, not
    // a real quality signal.
    if (!DRY_RUN && !ALLOWED_EMAILS && zeroMatchRate > ZERO_MATCH_ISSUE_THRESHOLD_RATIO) {
      // Best-effort diagnostic report: this call sits BEFORE sendBatch, so any
      // exception here (e.g. a future github-issue-creator.mjs change that adds
      // a non-guarded internal path) must never abort main() and skip sending
      // job-alert emails to every subscriber. Same convention as
      // scripts/reconcile-here-usage.mjs's alert-issue try-catch.
      try {
        const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
        const causeLines = Object.entries(zeroMatchByCause)
          .sort((a, b) => b[1] - a[1])
          .map(([cause, count]) => `- \`${cause}\`: ${count}`)
          .join('\n');
        await createGithubIssue({
          title: '[Monitor] Job-alert zero-match rate above threshold',
          description: [
            `${zeroMatchCount}/${alerts.length} job alerts (${(zeroMatchRate * 100).toFixed(1)}%) matched **zero** jobs this run `
              + `(threshold: ${(ZERO_MATCH_ISSUE_THRESHOLD_RATIO * 100).toFixed(0)}%).`,
            '',
            'Breakdown by cause (see scripts/lib/job-alert-zero-match-diagnosis.mjs):',
            causeLines,
            '',
            '- `keyword-narrow` / `keyword-and-geo-narrow`: the alert\'s explicit keywords matched nothing — check for a synonym/taxonomy gap in the matcher.',
            '- `geo-narrow`: the alert\'s location/canton filter matched nothing — may be a genuine inventory gap in that area, or the filter is too narrow.',
            '- `pinned-job-or-company-gone`: the alert is pinned to a specific job/company that\'s no longer active.',
            '- `no-hard-filters`: no hard filter set at all, yet still zero matches — investigate first, since a fully open alert should almost always find something (possible eligible-jobs-pool or soft-token-extraction bug).',
            '',
            'No subscriber PII in this report (aggregate counts/causes only).',
          ].join('\n'),
          priority: 3,
          labels: ['automation', 'bug'],
          workflow: 'send-job-alerts',
        });
      } catch (err) {
        console.warn(`   ⚠️ zero-match issue report failed (non-fatal, continuing to send): ${err.message}`);
      }
    }
  }

  if (emailsToSend.length === 0) {
    console.log('   No matches — no emails to send.');
    return;
  }

  // 4. Send emails
  let failedEmailSet = new Set();
  // Per-user send-time observability (#3798 follow-up): populated by sendBatch
  // from the cascade's authoritative per-recipient outcome; read below when
  // mirroring last_sent_at onto job_alert_subscribers/{email}. Stays empty on
  // DRY_RUN (nothing sent) — the batch.set below already guards on sentEmails.
  let scheduleOutcomes = new Map();
  if (DRY_RUN) {
    console.log('   🔵 DRY RUN — not sending emails');
    logScheduleDistribution(emailsToSend, { indent: '   ' });
  } else {
    const result = await sendBatch(emailsToSend);
    console.log(`   ✅ Sent ${result.sent} emails`);
    failedEmailSet = new Set(
      result.failedItems.map((item) => (item.recipient?.email || '').toLowerCase()).filter(Boolean),
    );
    scheduleOutcomes = result.scheduleOutcomes || new Map();

    // 4b. Enqueue failed emails for retry on the next run
    if (result.failed > 0) {
      console.log(`   ❌ ${result.failed} email(s) failed — enqueuing for retry`);
      await enqueueFailedEmails(db, result.failedItems);
    }
  }

  // 5. Update Firestore: lastMatchedAt + matchCount on the alert subdoc
  if (!DRY_RUN) {
    const { FieldValue } = await import('firebase-admin/firestore');
    // email.ref points at job_alert_subscribers/{email}/alerts/{alertId} and was
    // captured during the load step above. Pre-filter then chunk past the
    // Firestore 500-op batch cap (emailsToSend can exceed it at scale; a single
    // commit() would throw and skip every lastMatchedAt/matchCount update).
    const toUpdate = emailsToSend.filter((email) => email.ref);
    await commitInChunks(db, toUpdate, (batch, email) => {
      batch.update(email.ref, {
        lastMatchedAt: FieldValue.serverTimestamp(),
        matchCount: FieldValue.increment(email.matchCount),
        // Persist the merged sent-job map (pruned to the dedup window + capped)
        // so the next run excludes these jobs and surfaces fresh ones.
        sentJobIds: mergeSentJobs(email.sentMap, email.sentJobs, now, DEDUP_WINDOW_MS),
      });
    });
    console.log('   📊 Firestore updated');

    // 5b. Mirror last_sent_at onto job_alert_subscribers/{email} (root doc),
    // the same field/shape newsletter_subscribers/{email}.last_sent_at already
    // carries. This is what lets send-newsletter.mjs apply a symmetric 36h
    // cooldown (see NEWSLETTER_COOLDOWN_MS above) — until this write existed,
    // the newsletter had no way to know a job alert had just gone out.
    const sentEmails = [...new Set(
      emailsToSend
        .map((email) => email.to.toLowerCase())
        .filter((email) => !failedEmailSet.has(email)),
    )];
    // Adaptive-frequency observability: when a subscriber has >1 alert whose
    // effective tiers differ (e.g. one pinned daily, one engine-managed
    // weekly), surface the highest-cadence tier reached this run.
    const TIER_PRIORITY = { daily: 0, 'every-other-day': 1, weekly: 2 };
    const effectiveTierByEmail = new Map();
    for (const email of emailsToSend) {
      const key = email.to.toLowerCase();
      const existing = effectiveTierByEmail.get(key);
      if (!existing || TIER_PRIORITY[email.effectiveTier] < TIER_PRIORITY[existing]) {
        effectiveTierByEmail.set(key, email.effectiveTier);
      }
    }
    if (sentEmails.length > 0) {
      await commitInChunks(db, sentEmails, (batch, email) => {
        // Per-user send-time observability (#3798 follow-up): mirror what the
        // cascade actually decided for this recipient (scheduleOutcomes, built
        // in sendBatch from the cascade's authoritative per-item result) — null
        // when scheduling wasn't requested/resolved for this send, not just
        // when the map lookup misses.
        const outcome = scheduleOutcomes.get(email) || null;
        batch.set(db.collection('job_alert_subscribers').doc(email), {
          last_sent_at: FieldValue.serverTimestamp(),
          last_scheduled_for: outcome?.scheduledFor ?? null,
          last_send_time_source: outcome?.sendTimeSource ?? null,
          last_engagement_tier: effectiveTierByEmail.get(email) ?? null,
        }, { merge: true });
      });
      console.log(`   📬 last_sent_at recorded for ${sentEmails.length} job-alert recipient(s)`);
    }

    // 6. Personalization enrichment (no-clobber). Consolidate every signal we
    // just read — browsing subdoc (filter usage, viewed-job cities/categories,
    // searches) + the user's own alerts (locations, cantons, sectors, keywords)
    // — into the flat newsletter_subscribers profile fields the matcher,
    // newsletter and employer-blast funnels read. Only MISSING fields are
    // filled, so an explicit user value is never overwritten. Runs every day,
    // progressively enriching profiles that previously had empty location/sector
    // targeting (the "personalization fields missing" half of #2993).
    const alertsByEmail = new Map();
    for (const alert of alerts) {
      const key = String(alert.email || '').toLowerCase();
      if (!key) continue;
      if (!alertsByEmail.has(key)) alertsByEmail.set(key, []);
      alertsByEmail.get(key).push(alert);
    }
    const enrichTargets = [];
    for (const key of alertsByEmail.keys()) {
      // Only enrich an existing subscriber doc — never create an orphan record.
      if (!subscriberDocExists.has(key)) continue;
      const patch = derivePersonalizationPatch({
        subscriber: subscriberProfiles.get(key) || null,
        personalization: personalizationRaw.get(key) || null,
        alerts: alertsByEmail.get(key),
        // Strongest signal: the job this subscriber last clicked in an email.
        clicked: clickedJobMeta(lastClickedUrlByEmail.get(key), locationIndex),
      });
      if (patch) enrichTargets.push({ key, patch });
    }
    if (enrichTargets.length > 0) {
      await commitInChunks(db, enrichTargets, (batch, { key, patch }) => {
        batch.set(db.collection('newsletter_subscribers').doc(key), {
          ...patch,
          personalization_enriched_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      console.log(`   🧬 Personalization enriched: ${enrichTargets.length} subscriber profile(s)`);
    }
  }

  console.log('\n🔔 Job Alert Matching — Done.');
}

// Only run main() when executed directly (not when imported by tests).
const isEntryPoint = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { buildAlertEmail, filterLiveJobs, jobPageUrl };
