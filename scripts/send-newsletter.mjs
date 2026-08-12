#!/usr/bin/env node

/**
 * send-newsletter.mjs — v2 (AI-powered personalized newsletter)
 *
 * Each subscriber receives a unique email with:
 *  - AI-generated personalized briefing (via Gemini/multi-model chain)
 *  - Smart job matching (filtered by location/sector interests)
 *  - AI-generated subject line
 *  - Exchange rate card
 *  - Featured tool
 *  - Weekly fact
 *
 * All links are direct URLs (https://frontaliereticino.ch/...)
 * Autologin via Firebase generateSignInWithEmailLink() on each internal link.
 *
 * Usage:
 *   node scripts/send-newsletter.mjs --preview     # Output HTML to stdout
 *   node scripts/send-newsletter.mjs --dry-run --target-email email@example.com # Assemble only, no send
 *   node scripts/send-newsletter.mjs --test        # Send to admin email (with AI)
 *   node scripts/send-newsletter.mjs --send        # Send to all subscribers
 *   node scripts/send-newsletter.mjs --no-ai       # Skip AI generation (use fallbacks)
 *   node scripts/send-newsletter.mjs --digest-only # Only send to type='weekly_digest' subscribers
 *
 * Env vars (for --test/--send):
 *   RESEND_API_KEY, NEWSLETTER_SECRET, GEMINI_API_KEY or GH_MODELS_PAT,
 *   NEWSLETTER_EXPERIMENTAL_MODE=false, NEWSLETTER_ENABLE_SEND=true
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNewsletter, FEATURED_TOOLS, getFeaturedTools, nlNormLocale, directUrl } from '../services/newsletter-template.mjs';
import { matchJobsForSubscriber, validateJobUrls, buildBriefingPrompt, buildBriefingBatchPrompt, buildSubjectPrompt, FALLBACK_SUBJECT, getFallbackBriefing, loadDashboardMetrics, isCompanyHubSlug } from '../services/newsletter-content.mjs';
import { selectFeaturedArticleId } from '../services/newsletter-article-rotation.mjs';
import { describeSegment, inferInterest, selectArticleCandidates, CONTENT_STRATEGIES, INTERESTS } from '../services/newsletter-segments.mjs';
import { getSeasonalUtilityContent } from '../services/newsletter-seasonal.mjs';
import { getVariantFallback, listVariantIds, DEFAULT_EPSILON } from '../services/newsletter-subject-variants.mjs';
import { assignSubjectVariant } from '../services/newsletter-subject-assign.mjs';
import { pickWinner, resolveWinnersByProvider } from '../services/newsletter-ab-stats.mjs';
import { loadCampaignVariantTotals, previousCampaignIds } from './lib/newsletter-ab-data.mjs';
import { createResumeWriter, fetchAlreadySent as fetchCampaignAlreadySent, resumeChunkState } from './lib/campaignResumeLog.mjs';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';
import { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS } from '../functions/src/lib/emailExperimentPostHog.js';
import { refreshEngagementScore } from '../functions/src/lib/engagementScore.js';
import { prioritizeSubscribers } from '../services/newsletter-priority.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES } from '../services/emailSuppression.mjs';
import { makeUnsubscribeUrl, makeResubscribeUrl, makeOneClickUnsubscribeUrl, generateAutologinCode, makePreferencesUrl, makeAuthenticatedUrl, shouldWrapAuthenticatedHref } from '../services/newsletterUrls.mjs';
import { auditEmailLinksStatic } from './lib/email-link-audit.mjs';
import { filterFixtureJobs } from './lib/fixture-data-filter.mjs';
import { isOwnerEmail, isCanaryJob } from './lib/canaryAd.mjs';
import { getCascadeDailyCapacity, finiteDailyLimit, PROVIDERS as EMAIL_PROVIDERS } from './lib/email-cascade.mjs';
import { normalizeEmailAddress } from './lib/parseEmailField.mjs';
import { subscriberFromFirestoreRow } from './lib/subscriberFromFirestoreRow.mjs';
import { JOB_BOARD_SECTION_RX, JOB_BOARD_SECTION_PREFIX_SOURCE } from './lib/jobBoardSections.mjs';
import { computeScheduledSendAt, resolveEffectivePreferredHour, computeGlobalPreferredHour, perUserSendTimeEnabled, logScheduleDistribution } from './lib/send-schedule.mjs';
// localePathPrefix aliased to the `localePrefix` name this script has always
// used for its locale-aware URL construction (tests/newsletter-locale-urls.test.ts
// guards its presence here) — the implementation is the canonical shared helper.
import { localePathPrefix as localePrefix, loadBlogMeta, localizeArticle, loadArticlePerformanceWinners } from './lib/articleContent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.resolve(ROOT, 'docs', 'newsletter-qa');
const BASE_URL = 'https://frontaliereticino.ch';
const ADMIN_EMAIL = process.env.NEWSLETTER_ADMIN_EMAIL || 'valerielinc@gmail.com';
const DEFAULT_FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || DEFAULT_FROM_EMAIL;
const EXPERIMENTAL_MODE = process.env.NEWSLETTER_EXPERIMENTAL_MODE !== 'false';
const SEND_ENABLED = process.env.NEWSLETTER_ENABLE_SEND === 'true';
const AI_CONCURRENCY = 5; // Max parallel AI calls
// How many cohort briefings to request in a single AI call (same locale only,
// see buildBriefingBatchPrompt). Keeps total request volume comfortably under
// the tightest top-of-chain free-tier daily cap (Gemini flash: 1500/day) even
// on high-subscriber days, so most batches succeed on the first model instead
// of cascading through the whole chain toward the bottom-of-array tiers
// (omniroute/claude-cli — see NEWSLETTER_AI_CHAIN comment below for their
// current tier-0/last-resort status).
// Kept at 3 (not higher) so the batch's combined maxTokens request stays
// comfortably under smaller free-tier models' per-request output caps —
// a bigger batch cuts request volume further but risks silent truncation
// on the weaker links in the chain.
const AI_BRIEFING_BATCH_SIZE = 3;

// ── Email provider selection ──
// cascade = multi-provider free tier cascade (default)
// mailgun/mailjet/mailtrap/cloudflare/resend = force a specific cascade provider
// resend forced-mode (2026-07-16) now routes through sendEmailCascade like every
// other single-provider mode, instead of its own raw-fetch /emails/batch path —
// that legacy path bypassed the cascade's dynamic-cap/cooldown/quota-sync
// machinery entirely (sibling-pattern sweep, same class of bug as the direct
// Resend bypasses fixed elsewhere in this task).
// maileroo is intentionally excluded from force-select (#3135 item 1): the
// manual override let an operator bypass the cascade's quota/rotation to
// push all mail through a single provider on demand. Maileroo still runs as
// an automatic cascade rotation tier (see PROVIDERS in lib/email-cascade.mjs)
// — that role is separate and DKIM/DMARC-aligned as of #3154.
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'cascade';
const SINGLE_PROVIDERS = ['mailgun', 'mailjet', 'mailtrap', 'cloudflare', 'resend'];
const IS_SINGLE_PROVIDER = SINGLE_PROVIDERS.includes(EMAIL_PROVIDER);
// The per-run cap tracks the FULL cascade capacity — the sum of every configured
// provider's daily limit (getCascadeDailyCapacity, single source of truth in
// email-cascade.mjs, PROVIDERS array). Adding/removing a provider or changing a
// limit auto-updates this cap — see PROVIDERS in email-cascade.mjs for current
// per-provider numbers instead of a second hardcoded total here that would drift.
// resend-only legacy mode stays at resend's own dailyLimit (also derived, not hardcoded).
// The weekly campaign (campaignId=weekly_{monday}) resumes across daily cron runs and must clear
// the full active list (~2.5k) before Monday's campaign-ID rollover strands the unsent tail.
// On healthy days the old 350 cap was the binding limit: 2026-05-26 and 05-27 both hit 350 with
// mailjet delivering 149-200 and thousands still pending. Deriving from providers lets each day
// clear up to the real ceiling instead of an unused-capacity static number.
// CAVEAT: on days a provider is down (mailjet "fetch failed" on 05-28..30; 05-29 delivered only
// 98/350) provider reliability — not this cap — is the binding constraint, and the cap is moot.
const DAILY_SEND_LIMIT = EMAIL_PROVIDER === 'resend'
  ? finiteDailyLimit(EMAIL_PROVIDERS.find(p => p.id === 'resend'))
  : getCascadeDailyCapacity();

/**
 * Run async tasks with bounded concurrency.
 * @param {Array} items
 * @param {(item: any) => Promise<any>} fn
 * @param {number} concurrency
 * @returns {Promise<any[]>}
 */
async function pMap(items, fn, concurrency = AI_CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Compute a stable hash for a set of matched job slugs to identify cohorts.
 */
function jobSetHash(matchedJobs) {
  const slugs = matchedJobs.map(j => j.url || j.title).sort().join('|');
  return createHash('sha256').update(slugs).digest('hex').slice(0, 16);
}

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return String(process.argv[index + 1] || '').trim();
}

function normalizeEmail(raw) {
  // Strip any "Name <addr>" display wrapper so To:/unsubscribe/doc-lookups
  // always get the bare lowercased address (see parseEmailField).
  return normalizeEmailAddress(raw);
}

function hashEmail(email) {
  return Buffer.from(normalizeEmail(email)).toString('hex').slice(0, 24);
}

function slugifyHeaderValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'frontaliere-ticino';
}

// ─── Firebase Admin ─────────────────────────────────────────

let db;
let adminSdk;

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  adminSdk = a;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
}

// ─── AI Model Chain ─────────────────────────────────────────

let callLLM;
let initScoreStore;
let flushScores;

async function initAI() {
  try {
    const ai = await import('./lib/ai-models.mjs');
    callLLM = ai.callLLM;
    initScoreStore = ai.initScoreStore;
    flushScores = ai.flushScores;
    console.log('\u2705 AI model chain loaded');
  } catch (e) {
    console.warn('\u26a0\ufe0f AI models unavailable:', e.message);
    callLLM = null;
  }
}

// Focused AI chain for newsletter: top-scoring models across multiple providers.
// Avoids the 115+ model shotgun that causes cascading 429s and slow fallbacks.
// ~150 cohort briefings + 4 subjects = ~155 calls — well within free tier limits.
// Models are still sorted by score at runtime, so the best performer leads.
// IMPORTANT: keep these strings in sync with the canonical IDs in scripts/lib/ai-models.mjs
// (AI_MODELS.*). When Google renames a model on the Gemini API, fix it there first.
const NEWSLETTER_AI_CHAIN = [
  'gemini-2.5-flash',           // Google — 1500 req/day free, fast
  'gemini-2.0-flash',           // Google — 1500 req/day free, reliable
  'gpt-4.1-nano',               // GitHub Models — proven workhorse in past sends
  'gemini-2.5-flash-lite',      // Google — 3000 req/day free, lightweight
  'gemma-4-31b-it',             // Google — 14,400 req/day free
  'gemma-4-26b-a4b-it',         // Google — 14,400 req/day free (Gemma 4 MoE — exact API id)
  'mistral/mistral-small-latest', // Mistral — 1B tokens/month free
  'gemini-2.5-pro',             // Google — 500 req/day free, highest quality fallback
  // Self-hosted local AI gateway (OmniRoute), same AI_MODELS.OMNIROUTE_AUTO
  // used by create-article.mjs's DEFAULT_CHAIN. Since 2026-07-29
  // (AI_COMPETING_TIERS default in ai-models.mjs) this is tier-0 BY DEFAULT —
  // it competes on real score against every free-tier cloud model above, it
  // is NOT pinned below them anymore. Bottom-of-array position here is
  // deliberate ramp-up (starts at score 0, same as DEFAULT_CHAIN — see
  // _lastResortTier/AI_COMPETING_TIERS doc comment in ai-models.mjs), not a
  // rank guarantee. Skipped entirely unless OMNIROUTE_ENABLED is set (see
  // "Setup OmniRoute" step in send-newsletter.yml) — inert no-op otherwise,
  // so it's safe to always list.
  'omniroute/auto',
  // Same AI_MODELS.CLAUDE_CLI_HAIKU used by create-article.mjs's
  // DEFAULT_CHAIN. Routed through the local `claude` CLI using
  // CLAUDE_CODE_OAUTH_TOKEN (Max-plan subscription, $0 marginal cost), never
  // ANTHROPIC_API_KEY. Since 2026-07-29 (AI_COMPETING_TIERS default) also
  // tier-0 BY DEFAULT — same ramp-up rationale as omniroute/auto above,
  // additionally capped at CLAUDE_CLI_MAX_CALLS_PER_RUN calls/run (default
  // 25) since this quota is shared with pr-review-loop.yml/issue-fix.yml.
  // Set AI_COMPETING_TIERS='' to restore the old pinned-last-resort behavior
  // for both tiers. Inert unless
  // ENABLE_HAIKU_ARTICLE_FALLBACK + CLAUDE_CODE_OAUTH_TOKEN are both set (see
  // "Setup Claude CLI Haiku fallback" step in send-newsletter.yml). Uses the
  // CLI's 'haiku' alias (not a dated snapshot id) so it tracks whatever
  // Anthropic ships as current Haiku — keep this string identical to
  // AI_MODELS.CLAUDE_CLI_HAIKU in scripts/lib/ai-models.mjs.
  'claude-cli/haiku',
];

async function generateAIBriefing(ctx) {
  if (!callLLM) return null;
  try {
    const { system, user } = buildBriefingPrompt(ctx);
    const result = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.7, maxTokens: 800, chain: NEWSLETTER_AI_CHAIN });
    let html = sanitizeAIBriefingHtml(result);
    return html;
  } catch (e) {
    console.warn('\u26a0\ufe0f AI briefing failed:', e.message?.slice(0, 200));
    return null;
  }
}

/**
 * Split a batch AI response on "===BRIEFING <id>===" markers into a
 * Map<id, rawHtml>. Missing/unmatched ids simply aren't in the returned map \u2014
 * the caller treats that exactly like a single-item AI failure (null \u2192
 * template fallback), so a partially-truncated batch degrades gracefully
 * instead of losing the whole batch.
 */
function parseBriefingBatchResponse(raw) {
  const map = new Map();
  const text = String(raw || '');
  // Tolerant of minor formatting drift models are prone to (extra/missing
  // spaces around the marker, e.g. "== BRIEFING 0 ==" instead of the exact
  // "===BRIEFING 0===" requested) — a strict marker match would silently
  // drop an otherwise-good item to the template fallback over whitespace.
  const marker = /={2,}\s*BRIEFING\s+(\S+?)\s*={2,}/g;
  const matches = [...text.matchAll(marker)];
  for (let i = 0; i < matches.length; i++) {
    const id = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).trim();
    if (content) map.set(id, content);
  }
  return map;
}

/**
 * Generate up to AI_BRIEFING_BATCH_SIZE cohort briefings in a single AI call.
 * All items MUST share the same locale (see buildBriefingBatchPrompt). Falls
 * back to an empty map (\u2192 every item gets the template fallback downstream)
 * on total failure; individual items that fail the same quality gate as the
 * single-call path (sanitizeAIBriefingHtml) are dropped the same way too.
 */
async function generateAIBriefingsBatch(items) {
  if (!callLLM || items.length === 0) return new Map();
  try {
    const { system, user } = buildBriefingBatchPrompt(items);
    const result = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.7, maxTokens: 800 * items.length + 200, chain: NEWSLETTER_AI_CHAIN });
    const parsed = parseBriefingBatchResponse(result);
    const out = new Map();
    for (const item of items) {
      const block = parsed.get(item.id);
      if (!block) continue;
      const html = sanitizeAIBriefingHtml(block);
      if (html) out.set(item.id, html);
    }
    return out;
  } catch (e) {
    console.warn('\u26a0\ufe0f AI briefing batch failed:', e.message?.slice(0, 200));
    return new Map();
  }
}

/**
 * Post-process AI briefing: ensure job titles and company names are linked
 * with the correct URLs. The AI is unreliable at copying exact URLs, so we
 * do a deterministic find-and-replace after generation.
 */
const JOB_FALLBACK_I18N = {
  it: {
    introSingle: (s) => `Se cerchi qualcosa di concreto, dai un'occhiata a ${s}.`,
    introMulti: (list, last) => `Se cerchi qualcosa di concreto, questa settimana ci sono ${list}, e ${last}.`,
    at: 'presso',
    in: 'a',
  },
  en: {
    introSingle: (s) => `Looking for something concrete? Check out ${s}.`,
    introMulti: (list, last) => `Looking for something concrete? This week there's ${list}, and ${last}.`,
    at: 'at',
    in: 'in',
  },
  de: {
    introSingle: (s) => `Auf der Suche nach etwas Konkretem? Schau dir ${s} an.`,
    introMulti: (list, last) => `Auf der Suche nach etwas Konkretem? Diese Woche gibt es ${list} und ${last}.`,
    at: 'bei',
    in: 'in',
  },
  fr: {
    introSingle: (s) => `Vous cherchez quelque chose de concret\u00a0? Jetez un œil à ${s}.`,
    introMulti: (list, last) => `Vous cherchez quelque chose de concret\u00a0? Cette semaine il y a ${list} et ${last}.`,
    at: 'chez',
    in: 'à',
  },
};

/** Mirror the build plugin's canonicalCompanySlug logic (slugify company name, not companyKey) */
function slugifyCompanyName(name) {
  return String(name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * Replace `nameEsc` in HTML text nodes only — skips matches inside tag attributes.
 * Uses the alternation trick: (<tag>) | (pattern). Tags pass through unchanged;
 * replaceFn is called only for text-node matches.
 * When flags lacks 'g', only the first text-node occurrence is replaced.
 */
function replaceOutsideTags(html, nameEsc, flags, replaceFn) {
  const wantsAll = flags.includes('g');
  const combinedFlags = wantsAll ? flags : flags + 'g'; // need g for alternation to scan all tags
  const re = new RegExp(`(<[^>]+>)|(${nameEsc})`, combinedFlags);
  let replaced = false;
  return html.replace(re, (_, tag, text) => {
    if (tag !== undefined) return tag;
    if (!wantsAll && replaced) return text;
    replaced = true;
    return replaceFn(text);
  });
}

/** Returns true if nameEsc appears in text content (outside HTML tags). */
function appearsInText(html, nameEsc) {
  const re = new RegExp(`(<[^>]+>)|(${nameEsc})`, 'gi');
  let found = false;
  html.replace(re, (_, tag, text) => { if (text !== undefined) found = true; });
  return found;
}

function injectJobAndCompanyLinks(html, jobs, locale = 'it') {
  if (!jobs || jobs.length === 0) return html;
  const linkStyle = 'color:#2563eb;text-decoration:underline;';
  const i18n = JOB_FALLBACK_I18N[locale] || JOB_FALLBACK_I18N.it;

  // Build linked job snippets for the fallback paragraph
  const linkedSnippets = [];

  for (const j of jobs.slice(0, 3)) {
    const jobUrl = j.url ? `${BASE_URL}${j.url.startsWith('/') ? j.url : '/' + j.url}` : '';
    // Reuse the upstream-validated hub URL from matchJobsForSubscriber (gated on
    // the emitted-hub allow-set, #2530) rather than re-deriving an UNGATED slug
    // here — a company present only on expired jobs has no emitted hub and would
    // 404. Absent companyUrl → omit the company link (safe).
    const companyUrl = j.companyUrl || '';

    let foundTitle = false;

    // For each name: strip any existing <a> wrapping (AI may have used wrong URLs),
    // then strip <strong>, then inject correct link.
    if (j.title) {
      const titleEsc = j.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`<a[^>]*>\\s*(${titleEsc})\\s*</a>`, 'gi'), '$1');
      html = html.replace(new RegExp(`<strong>(${titleEsc})</strong>`, 'gi'), '$1');
      if (jobUrl && appearsInText(html, titleEsc)) {
        html = replaceOutsideTags(html, titleEsc, 'i', (m) => `<a target="_blank" rel="noopener noreferrer" href="${jobUrl}" style="${linkStyle}">${m}</a>`);
        foundTitle = true;
      }
    }

    if (j.company) {
      // Build candidate names: full name + short name (before any parenthesis/dash/comma)
      const shortCompany = j.company.replace(/[\s(/-].*$/, '').trim();
      const companyNames = [...new Set([j.company, shortCompany].filter(Boolean))];
      let companyLinked = false;
      for (const name of companyNames) {
        if (companyLinked) break;
        const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp(`<a[^>]*>\\s*(${nameEsc})\\s*</a>`, 'gi'), '$1');
        html = html.replace(new RegExp(`<strong>(${nameEsc})</strong>`, 'gi'), '$1');
        if (companyUrl && appearsInText(html, nameEsc)) {
          html = replaceOutsideTags(html, nameEsc, 'i', (m) => `<a target="_blank" rel="noopener noreferrer" href="${companyUrl}" style="${linkStyle}">${m}</a>`);
          companyLinked = true;
        }
      }
    }

    // Collect snippet for fallback paragraph if title wasn't found in AI text
    if (!foundTitle && jobUrl && j.title) {
      const titleLink = `<a target="_blank" rel="noopener noreferrer" href="${jobUrl}" style="${linkStyle}">${j.title}</a>`;
      const companyPart = j.company && companyUrl
        ? ` ${i18n.at} <a target="_blank" rel="noopener noreferrer" href="${companyUrl}" style="${linkStyle}">${j.company}</a>`
        : j.company ? ` ${i18n.at} ${j.company}` : '';
      const locationPart = j.location ? ` ${i18n.in} ${j.location}` : '';
      linkedSnippets.push(`${titleLink}${companyPart}${locationPart}`);
    }
  }

  // If AI didn't mention any jobs, prepend a paragraph with job links
  if (linkedSnippets.length > 0) {
    const jobIntro = linkedSnippets.length === 1
      ? i18n.introSingle(linkedSnippets[0])
      : i18n.introMulti(linkedSnippets.slice(0, -1).join(', '), linkedSnippets[linkedSnippets.length - 1]);
    html = `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">${jobIntro}</p>` + html;
  }

  return html;
}

/**
 * Inject hyperlinks for well-known tools/features mentioned in the AI briefing.
 * The AI reliably names these but rarely links them; we do it deterministically.
 */
const TOOL_LINK_PATTERNS = [
  // Order matters: longer/more-specific patterns first
  { pattern: /Confronto LAMal/gi,       url: '/compara-servizi/confronta-casse-malati' },
  { pattern: /Calcola(?:tore)? stipendio/gi, url: '/calcolatore' },
  { pattern: /3[°ºo]\s*pilastro\s*3a/gi, url: '/fisco/terzo-pilastro-3a' },
  { pattern: /3[°ºo]\s*pilastro/gi,     url: '/fisco/terzo-pilastro-3a' },
  { pattern: /cambio valuta/gi,          url: '/compara-servizi/cambio-franco-euro' },
  { pattern: /tasso di cambio/gi,        url: '/compara-servizi/cambio-franco-euro' },
  { pattern: /LAMal/g,                   url: '/compara-servizi/confronta-casse-malati' },
];

function injectToolLinks(html, locale = 'it') {
  if (!html) return html;
  const linkStyle = 'color:#2563eb;text-decoration:underline;';
  for (const { pattern, url } of TOOL_LINK_PATTERNS) {
    // Skip if already linked (text is inside an existing <a> tag)
    // Simple heuristic: replace only the first occurrence not already inside <a>
    html = html.replace(pattern, (match, offset) => {
      // Check if this match is already inside an anchor
      const before = html.slice(0, offset);
      const openAnchors = (before.match(/<a[\s>]/gi) || []).length;
      const closeAnchors = (before.match(/<\/a>/gi) || []).length;
      if (openAnchors > closeAnchors) return match; // inside an existing <a>
      const absUrl = `${BASE_URL}${url}`;
      return `<a target="_blank" rel="noopener noreferrer" href="${absUrl}" style="${linkStyle}">${match}</a>`;
    });
  }
  return html;
}

/**
 * Sanitize AI-generated briefing HTML:
 * 1. Wrap bare text in <p> tags, close unclosed <p>
 * 2. Detect truncated text → trim to last complete sentence (rebuilt as clean <p> blocks)
 * 3. Final tag balance: remove orphan closing tags, close orphan opens
 * 4. Quality gate: minimum 50 words
 */
function sanitizeAIBriefingHtml(raw) {
  if (!raw) return null;
  let html = raw.trim();

  // Strip markdown code fences if model wrapped output
  html = html.replace(/^```html?\s*/i, '').replace(/\s*```$/, '').trim();

  // Convert leaked markdown to HTML. AI models occasionally output **bold** or
  // *italic* despite the system prompt asking for HTML — without conversion the
  // raw asterisks render literally in the email (e.g. "**5'000 CHF**"). Run bold
  // before italic so the ** patterns are consumed first.
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  // Markdown links [text](url) → strip to plain text. injectJobAndCompanyLinks
  // re-adds correct hyperlinks; raw markdown links would render as literal text.
  html = html.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip ALL <a> tags from AI output (keep inner text).
  // injectJobAndCompanyLinks() re-adds links with correct, validated URLs.
  // AI models frequently generate malformed hrefs (nested URLs, broken quotes)
  // that corrupt the final HTML — e.g. <a href="url1"url2" style="...">
  html = html.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
  // Clean orphaned HTML attribute fragments left from malformed tags
  // e.g. -bellinzona/" style="color:#2563eb;text-decoration:underline;">
  html = html.replace(/[a-z0-9\-/]*"\s*style="[^"]*"\s*>/gi, '');
  // Remove bare URL fragments leaked into text from broken href attributes
  html = html.replace(/https?:\/\/[^\s<"]+/g, '');

  // If no <p> tags, wrap in <p>
  if (!html.includes('<p>') && !html.includes('<p ')) {
    html = '<p>' + html.replace(/\n\n+/g, '</p><p>') + '</p>';
  }

  // Close unclosed <p> tags (need well-formed blocks for trimming)
  const pOpen = (html.match(/<p[\s>]/gi) || []).length;
  const pClose = (html.match(/<\/p>/gi) || []).length;
  if (pOpen > pClose) {
    for (let i = 0; i < pOpen - pClose; i++) html += '</p>';
  }

  // Extract plain text for quality checks
  const fullPlainText = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // Detect truncated text: if overall text doesn't end with punctuation, trim
  // We trim from the HTML directly to preserve inline tags (links, bold, etc.)
  if (fullPlainText.length > 0 && !/[.!?\u00bb\u201d\u2019')]$/.test(fullPlainText)) {
    const lastSentenceEnd = fullPlainText.search(/[.!?][^.!?]*$/);
    if (lastSentenceEnd > 0) {
      // Check if truncation would drop any <a> links — if so, skip truncation
      // to preserve job hyperlinks which are the most valuable part of the briefing
      const droppedHtmlRegion = html.slice(html.length - (fullPlainText.length - lastSentenceEnd) * 2); // rough estimate
      if (/<a\s+href/i.test(html) && !/<a\s+href/i.test(html.slice(0, html.length / 2 | 0)) && /<a\s+href/i.test(html.slice(html.length / 2 | 0))) {
        // Links are concentrated in the second half — truncation would likely kill them
        // Just close any open tags and keep the full text
        console.warn('\u26a0\ufe0f AI briefing: skipping truncation to preserve job links');
        const openTags = [];
        const tagRe = /<\/?([a-z]+)[\s>]/gi;
        let m;
        while ((m = tagRe.exec(html))) {
          if (m[0].startsWith('</')) openTags.pop();
          else openTags.push(m[1]);
        }
        while (openTags.length) html += '</' + openTags.pop() + '>';
        if (!html.endsWith('</p>')) html += '</p>';
      } else {
      const keepPlain = fullPlainText.slice(0, lastSentenceEnd + 1);
      const droppedText = fullPlainText.slice(lastSentenceEnd + 1).trim();
      console.warn(`\u26a0\ufe0f AI briefing: trimmed truncated tail (kept ${keepPlain.length}/${fullPlainText.length} chars): dropped "${droppedText.slice(0, 80)}"`);
      // Walk the HTML character-by-character, mapping plain-text offset to HTML offset
      // so we can cut at the right place while preserving inline tags
      let plainIdx = 0;
      let htmlCutIdx = html.length;
      let inTag = false;
      for (let i = 0; i < html.length; i++) {
        if (html[i] === '<') { inTag = true; continue; }
        if (html[i] === '>') { inTag = false; continue; }
        if (!inTag) {
          if (plainIdx === lastSentenceEnd) {
            // Include this character (the sentence-ending punctuation)
            htmlCutIdx = i + 1;
            break;
          }
          plainIdx++;
        }
      }
      html = html.slice(0, htmlCutIdx);
      // Close any tags we may have cut through
      const openTags = [];
      const tagRe = /<\/?([a-z]+)[\s>]/gi;
      let m;
      while ((m = tagRe.exec(html))) {
        if (m[0].startsWith('</')) openTags.pop();
        else openTags.push(m[1]);
      }
      while (openTags.length) html += '</' + openTags.pop() + '>';
      // Ensure wrapped in <p> if the cut removed closing </p>
      if (!html.endsWith('</p>')) html += '</p>';
      } // end else (no links to preserve)
    } else {
      console.warn('\u26a0\ufe0f AI briefing: no complete sentence found \u2014 falling back');
      return null;
    }
  }

  // Final tag balance: remove orphan closing tags, close orphan opens
  const inlineTags = ['a', 'strong', 'em', 'b', 'i'];
  for (const tag of inlineTags) {
    const openRe = new RegExp('<' + tag + '[\\s>]', 'gi');
    const closeRe = new RegExp('</' + tag + '>', 'gi');
    const opens = (html.match(openRe) || []).length;
    const closes = (html.match(closeRe) || []).length;
    if (closes > opens) {
      // Remove excess closing tags from the end
      for (let i = 0; i < closes - opens; i++) {
        const lastIdx = html.lastIndexOf('</' + tag + '>');
        if (lastIdx >= 0) {
          html = html.slice(0, lastIdx) + html.slice(lastIdx + ('</' + tag + '>').length);
        }
      }
    } else if (opens > closes) {
      // Close unclosed tags before last </p>
      const lastP = html.lastIndexOf('</p>');
      const pos = lastP > 0 ? lastP : html.length;
      let closers = '';
      for (let i = 0; i < opens - closes; i++) closers += '</' + tag + '>';
      html = html.slice(0, pos) + closers + html.slice(pos);
    }
  }

  // Minimum quality: at least 50 words
  const wordCount = html.replace(/<[^>]+>/g, '').trim().split(/\s+/).length;
  if (wordCount < 50) {
    console.warn(`\u26a0\ufe0f AI briefing too short (${wordCount} words) \u2014 falling back`);
    return null;
  }

  return html;
}

async function generateAISubject(ctx) {
  if (!callLLM) return null;
  try {
    const { system, user } = buildSubjectPrompt(ctx);
    const result = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.8, maxTokens: 80, chain: NEWSLETTER_AI_CHAIN });
    const raw = result.trim().replace(/^["']|["']$/g, '');
    // Reject degenerate AI output (empty, too short, emoji-only) so the caller
    // can fall back to FALLBACK_SUBJECT. Without this guard a 1-char emoji
    // subject like "💼" sneaks past `subject || FALLBACK_SUBJECT[loc]` (truthy)
    // and trips the inlineQaCheck `length < 10` gate, aborting the entire send.
    // Require at least 10 chars AND a 3+ letter run to ensure real text.
    if (raw.length < 10 || !/[\p{L}]{3,}/u.test(raw)) return null;
    // Ensure subject is a complete sentence — never truncate. A word-boundary
    // cut still risks lopping off the sentence's final word (e.g. "...il ruolo
    // più" with "cliccato" chopped off) since it only checks for *a* space,
    // not whether the cut lands after a complete clause. Safer to discard an
    // over-limit AI subject and let the caller fall back to FALLBACK_SUBJECT
    // than to ship a grammatically broken one.
    if (raw.length > 55) return null;
    return raw;
  } catch (e) {
    console.warn('\u26a0\ufe0f AI subject failed:', e.message?.slice(0, 200));
    return null;
  }
}

// ─── Unsubscribe / Auth URLs ────────────────────────────────

// makeUnsubscribeUrl / makeResubscribeUrl / makePreferencesUrl live in
// services/newsletterUrls.mjs (shared with send-job-alerts.mjs and the
// sunset/win-back runner so the HMAC token scheme can't drift, AGENTS.md #6).

// makeAuthenticatedUrl / shouldWrapNewsletterHref / generateAutologinCode all
// live in services/newsletterUrls.mjs (canonical under functions/src/lib/), shared
// with the win-back/sunset runner and the welcome email so the autologin HMAC
// scheme and the wrapping rules can't drift. Deterministic, never-expiring; the
// client exchanges the code for a fresh token via Cloud Function.
const shouldWrapNewsletterHref = shouldWrapAuthenticatedHref;

async function personalizeHtmlForRecipient(email, html) {
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  if (!hrefMatches.length) return html;

  // Generate ONE HMAC autologin code per subscriber (reused for all links, never expires)
  const autologinCode = generateAutologinCode(email);

  const replacements = new Map();
  const uniqueHrefs = [...new Set(hrefMatches.map((m) => m[1]).filter(shouldWrapNewsletterHref))];
  for (const href of uniqueHrefs) {
    const wrapped = makeAuthenticatedUrl(href, email, { autologinCode });
    replacements.set(href, wrapped);
  }

  let personalized = html;
  for (const [original, wrapped] of replacements.entries()) {
    personalized = personalized.replaceAll(`href="${original}"`, `href="${wrapped}"`);
  }
  return personalized;
}

/**
 * Synchronous HTML personalization using a pre-generated autologin code.
 * Used by the optimized pipeline where codes are generated in bulk beforehand.
 */
function personalizeHtmlWithToken(email, html, autologinCode) {
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  if (!hrefMatches.length) return html;

  const replacements = new Map();
  const uniqueHrefs = [...new Set(hrefMatches.map((m) => m[1]).filter(shouldWrapNewsletterHref))];
  for (const href of uniqueHrefs) {
    const wrapped = makeAuthenticatedUrl(href, email, { autologinCode });
    replacements.set(href, wrapped);
  }

  let personalized = html;
  for (const [original, wrapped] of replacements.entries()) {
    personalized = personalized.replaceAll(`href="${original}"`, `href="${wrapped}"`);
  }
  return personalized;
}

// ─── Content fetchers ───────────────────────────────────────

const PROVIDERS = [
  { name: 'Wise', feePct: 0.0025, maxFeePct: 0.0033, fixedChf: 0 },
  { name: 'Cambiovalute.ch', feePct: 0.0031, maxFeePct: 0.0045, fixedChf: 0 },
  { name: 'Revolut', feePct: 0.0028, maxFeePct: 0.0038, fixedChf: 0 },
];

async function fetchExchangeRate() {
  try {
    const doc = await db.collection('config').doc('exchange_rate').get();
    if (!doc.exists) return null;
    const data = doc.data();
    const rawRate = Number(data.rate || 0.94);
    const normalize = (v) => (v > 0 && v < 0.8 ? 1 / v : v);
    const rate = normalize(rawRate);
    // previousRate may not be stored — will be enriched from history later
    const rawPrev = data.previousRate ? Number(data.previousRate) : null;
    const previousRate = rawPrev ? normalize(rawPrev) : null;
    return { rate, previousRate };
  } catch (e) {
    console.warn('\u26a0\ufe0f Exchange rate fetch failed:', e.message);
    return null;
  }
}

async function fetchExchangeHistory(days = 120) {
  // 1. Read from Firestore exchangeHistory (updated daily by cron job)
  if (db) {
    try {
      // Pick the best period based on requested days
      const period = days <= 35 ? '1m' : days <= 100 ? '3m' : days <= 200 ? '6m' : days <= 400 ? '1y' : '5y';
      const snap = await db.collection('exchangeHistory').doc(`chf-eur-${period}`).get();
      if (snap.exists) {
        const points = snap.data()?.points || [];
        if (points.length >= 5) {
          console.log(`📊 History from Firestore (${period}): ${points.length} points, last: ${points[points.length-1]?.date}`);
          return points;
        }
      }
    } catch (e) {
      console.warn('⚠️ Firestore history read failed:', e.message);
    }
  }

  // 2. Fallback: Frankfurter API (only if Firestore is empty/unavailable)
  console.log('⚠️ Falling back to Frankfurter API for history');
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const endpoints = [
    `https://api.frankfurter.dev/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
    `https://api.frankfurter.app/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const series = (Array.isArray(data) ? data : [])
        .map((entry) => ({ date: entry.date, rate: Number(entry.rate || 0) }))
        .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (series.length >= 20) return series;
    } catch { /* try next */ }
  }
  return [];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

function toWeekdayName(index) {
  return ['Domenica', 'Luned\u00ec', 'Marted\u00ec', 'Mercoled\u00ec', 'Gioved\u00ec', 'Venerd\u00ec', 'Sabato'][index] || 'N/D';
}

function computeExchangeInsight(series, fallbackRate, fallbackPrev) {
  if (!series.length) {
    return {
      headline: 'Dati storici limitati',
      summary: 'Confronto settimanale diretto disponibile.',
      currentMonthAvg: fallbackRate,
      previousMonthAvg: fallbackPrev,
      bestWeekday: 'N/D',
    };
  }
  const latest = series[series.length - 1].rate;
  const previous = series[Math.max(0, series.length - 8)]?.rate || latest;
  const weekPct = previous > 0 ? ((latest - previous) / previous) * 100 : 0;
  const trend = weekPct > 0.2 ? 'in rafforzamento' : weekPct < -0.2 ? 'in indebolimento' : 'stabile';
  const now = new Date();
  const curMonth = now.getMonth(), curYear = now.getFullYear();
  const prevDate = new Date(curYear, curMonth - 1, 1);
  const curRates = series.filter((d) => { const dt = new Date(d.date + 'T00:00:00'); return dt.getMonth() === curMonth && dt.getFullYear() === curYear; }).map((d) => d.rate);
  const prevRates = series.filter((d) => { const dt = new Date(d.date + 'T00:00:00'); return dt.getMonth() === prevDate.getMonth() && dt.getFullYear() === prevDate.getFullYear(); }).map((d) => d.rate);
  const curAvg = mean(curRates) || latest;
  const prevAvg = mean(prevRates) || previous;
  const weekdayBuckets = new Map();
  for (const p of series) {
    const d = new Date(p.date + 'T00:00:00').getDay();
    const arr = weekdayBuckets.get(d) || [];
    arr.push(p.rate);
    weekdayBuckets.set(d, arr);
  }
  let bestDay = 1, bestAvg = -Infinity;
  for (const [day, vals] of weekdayBuckets) {
    const avg = mean(vals);
    if (avg > bestAvg) { bestAvg = avg; bestDay = day; }
  }
  const mDelta = prevAvg > 0 ? ((curAvg - prevAvg) / prevAvg) * 100 : 0;
  const rec = mDelta >= 0.4 ? 'Scenario favorevole: valuta cambio graduale.'
    : mDelta <= -0.4 ? 'Scenario debole: considera cambio a tranche.'
    : 'Scenario neutro: mantieni strategia a tranche.';
  return {
    headline: `CHF/EUR ${trend} (${weekPct >= 0 ? '+' : ''}${weekPct.toFixed(2)}% settimanale)`,
    summary: rec,
    currentMonthAvg: curAvg,
    previousMonthAvg: prevAvg,
    bestWeekday: toWeekdayName(bestDay),
  };
}

// Candidate pool size must comfortably exceed MAX_HISTORY (26) so rotation
// never collapses to "every top-viewed article is in the exclude list".
const TOP_ARTICLES_LIMIT = 50;

async function fetchTopArticles() {
  try {
    const snap = await db.collection('article_views').orderBy('views', 'desc').limit(TOP_ARTICLES_LIMIT).get();
    if (snap.empty) return [];
    return snap.docs.map((d) => ({
      id: d.id,
      title: d.id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      url: `/articoli-frontaliere/${d.id}`,
      views: d.data().views || 0,
      lastViewed: d.data().lastViewed?.toDate?.() || null,
    }));
  } catch (e) {
    console.warn('\u26a0\ufe0f Top articles fetch failed:', e.message);
    return [];
  }
}

/**
 * Second-tier featured-article pool: most recently *published* articles,
 * regardless of views. Used by selectFeaturedArticleId when the views-based
 * pool is exhausted \u2014 promotes new content instead of looping on evergreens.
 *
 * Reads data/blog-articles/*.json (each file carries a `publishedAt` ISO
 * string) and returns at most {limit} article IDs sorted newest first.
 */
function fetchRecentlyPublishedArticleIds(limit = 30) {
  try {
    const dir = new URL('../data/blog-articles/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const articles = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(new URL(file, dir), 'utf8');
        const data = JSON.parse(raw);
        const ts = Date.parse(data.publishedAt || '');
        if (!Number.isNaN(ts)) {
          articles.push({ id: data.id || file.replace(/\.json$/, ''), ts });
        }
      } catch {
        // Skip unparseable file
      }
    }
    articles.sort((a, b) => b.ts - a.ts);
    return articles.slice(0, limit).map((a) => a.id);
  } catch (e) {
    console.warn('\u26a0\ufe0f Recently published articles scan failed:', e.message);
    return [];
  }
}

/**
 * Build a `getPublishedAt(id) => Date|null` lookup over `data/blog-articles/*.json`.
 *
 * Used by `selectFeaturedArticleId` to penalize "evergreen" articles (older
 * than 1 year). Legacy evergreens stored under `services/locales/blog-meta-*.ts`
 * have no JSON file \u2192 the getter returns `null`, which the selector treats as
 * "unknown publish date \u2192 evergreen" \u2192 de-prioritized.
 */
function buildPublishedAtLookup() {
  const map = new Map();
  try {
    const dir = new URL('../data/blog-articles/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(new URL(file, dir), 'utf8');
        const data = JSON.parse(raw);
        const ts = Date.parse(data.publishedAt || '');
        if (Number.isNaN(ts)) continue;
        const id = data.id || file.replace(/\.json$/, '');
        map.set(id, new Date(ts));
      } catch {
        // Skip unparseable file
      }
    }
  } catch {
    // Directory missing in test environments \u2014 return empty map; everything
    // resolves to null, which evergreen-checks treat as "old".
  }
  return (id) => map.get(id) || null;
}

// getBlogSlug / loadBlogMeta / localizeArticle / localePathPrefix /
// loadArticlePerformanceWinners live in ./lib/articleContent.mjs (shared with
// the dormant-tier win-back runner, scripts/newsletter-winback-campaign.mjs,
// so the slug/meta-file parsing logic can't drift between the two senders).

const DEFAULT_ARTICLE_ID = 'comuni-migliori-frontalieri';

/**
 * Pick the best featured article for the newsletter.
 * Returns a function (locale) => article object, so each subscriber gets localized content.
 * Uses Firestore article_views (most viewed this week), falls back to hardcoded default.
 */
// ─── _meta_ doc memoization ─────────────
// newsletter_subscribers/_meta_ is read by 5 functions per send-newsletter
// run. Only this process mutates it during a run, so an in-process cache
// with write-through stays consistent.
let _metaCache = null;
let _metaPromise = null;

function metaDocRef() {
  return db.collection('newsletter_subscribers').doc('_meta_');
}

async function readMetaDoc() {
  if (_metaCache !== null) return _metaCache;
  if (_metaPromise) return _metaPromise;
  _metaPromise = (async () => {
    try {
      const doc = await metaDocRef().get();
      _metaCache = doc.exists ? (doc.data() || {}) : {};
    } catch {
      _metaCache = {};
    }
    return _metaCache;
  })();
  return _metaPromise;
}

async function writeMetaDoc(updates) {
  await metaDocRef().set(updates, { merge: true });
  if (_metaCache === null) await readMetaDoc();
  Object.assign(_metaCache, updates);
}

async function fetchRecentlyFeaturedArticles() {
  if (!db) return [];
  const data = await readMetaDoc();
  return data.recently_featured_articles || [];
}

async function saveRecentlyFeaturedArticle(articleId) {
  if (!db) return;
  // 2026-05-19: bumped from 12 → 26 weeks (~6 months) after subscriber feedback
  // that featured articles felt familiar. The old window cycled every ~3 months,
  // long enough for evergreens to keep resurfacing.
  const MAX_HISTORY = 26;
  try {
    const history = await fetchRecentlyFeaturedArticles();
    const updated = [articleId, ...history.filter(id => id !== articleId)].slice(0, MAX_HISTORY);
    await writeMetaDoc({ recently_featured_articles: updated });
  } catch (e) {
    console.warn('\u26a0\ufe0f Save featured article history failed:', e.message);
  }
}

// \u2500\u2500\u2500 Job rotation (mirrors article rotation) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const RECENTLY_FEATURED_JOBS_KEY = 'recently_featured_jobs';
// Each weekly send flattens 4 cards across N subscribers into 100+ distinct
// slugs (personalization expands the set). Keeping the window large enough to
// cover ~3-4 weeks of distinct featured slugs prevents popular jobs from
// resurfacing every other send.
const MAX_FEATURED_JOBS_HISTORY = 100;

async function fetchRecentlyFeaturedJobs() {
  if (!db) return [];
  const data = await readMetaDoc();
  return data[RECENTLY_FEATURED_JOBS_KEY] || [];
}

async function saveRecentlyFeaturedJobs(slugs) {
  if (!db || !slugs.length) return;
  try {
    const existing = await fetchRecentlyFeaturedJobs();
    const updated = [...new Set([...slugs, ...existing])].slice(0, MAX_FEATURED_JOBS_HISTORY);
    await writeMetaDoc({ [RECENTLY_FEATURED_JOBS_KEY]: updated });
    console.log(`\u2705 Job rotation: saved ${updated.length} recently featured slugs`);
  } catch (e) {
    console.warn('\u26a0\ufe0f Save recently featured jobs failed:', e.message);
  }
}

// \u2500\u2500\u2500 Job alert matching \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Load all active job alerts, keyed by email.
 * Uses a collectionGroup query to avoid N+1 reads.
 * @returns {Promise<Map<string, object[]>>}
 */
async function fetchAllJobAlerts() {
  if (!db) return new Map();
  try {
    const snap = await db.collectionGroup('alerts').where('active', '==', true).get();
    const map = new Map();
    snap.forEach((doc) => {
      const data = doc.data();
      const email = (data.email || '').toLowerCase();
      if (!email) return;
      if (!map.has(email)) map.set(email, []);
      map.get(email).push(data);
    });
    console.log(`\ud83d\udd14 Job alerts loaded: ${map.size} subscribers with active alerts`);
    return map;
  } catch (e) {
    console.warn('\u26a0\ufe0f Load job alerts failed:', e.message);
    return new Map();
  }
}

/**
 * Returns true if the job matches any of the subscriber's active alerts.
 * Within each filter type: OR logic (any match is enough).
 * Across filter types: AND logic (all non-empty filters must match).
 */
function jobMatchesAlerts(job, alerts) {
  if (!alerts || alerts.length === 0) return false;
  const title = (job.title || '').toLowerCase();
  const company = (job.company || '').toLowerCase();
  const location = (job.location || '').toLowerCase();
  const contract = (job.rawContract || job.contract || '').toLowerCase();
  const sector = (job.sector || '').toLowerCase();

  return alerts.some((alert) => {
    if (!alert.active) return false;
    const kwOk = !alert.keywords?.length ||
      alert.keywords.some((k) => title.includes(k.toLowerCase()) || company.includes(k.toLowerCase()));
    const locOk = !alert.locations?.length ||
      alert.locations.some((l) => location.includes(l.toLowerCase()));
    const ctOk = !alert.contractTypes?.length ||
      alert.contractTypes.some((c) => contract.includes(c.toLowerCase()));
    const secOk = !alert.sectors?.length ||
      alert.sectors.some((s) => sector.includes(s.toLowerCase()) || title.includes(s.toLowerCase()));
    return kwOk && locOk && ctOk && secOk;
  });
}

async function pickFeaturedArticle() {
  let bestId = DEFAULT_ARTICLE_ID;

  if (db) {
    try {
      const [topArticles, recentlyFeatured] = await Promise.all([
        fetchTopArticles(),
        fetchRecentlyFeaturedArticles(),
      ]);
      const recentlyPublished = fetchRecentlyPublishedArticleIds();
      const getPublishedAt = buildPublishedAtLookup();
      const hasMeta = (id) => !!loadBlogMeta(id, 'it');
      const pick = selectFeaturedArticleId(
        topArticles,
        recentlyFeatured,
        hasMeta,
        Date.now(),
        recentlyPublished,
        getPublishedAt,
      );
      if (pick.id) {
        bestId = pick.id;
        const best = topArticles.find((a) => a.id === pick.id);
        const reasonLabel = {
          'fresh': '',
          'recent-publication': ' (recently published, promoting)',
          'fresh-evergreen': ' (no fresh-published alternative, reusing evergreen)',
          'rotation-exhausted': ' (rotation exhausted, reusing)',
        }[pick.reason] || '';
        console.log(`\ud83d\udcf0 Featured article: "${pick.id}" (${best?.views ?? '?'} views)${reasonLabel}`);
        if (recentlyFeatured.length > 0) {
          console.log(`   Recently featured (excluded): ${recentlyFeatured.join(', ')}`);
        }
      } else if (topArticles.length > 0) {
        console.warn(`\u26a0\ufe0f No blog meta for any top article (${topArticles.length} candidates), using default`);
      }
    } catch (e) {
      console.warn('\u26a0\ufe0f Featured article pick failed:', e.message);
    }
  }

  // Cache per locale to avoid re-reading files for each subscriber
  const cache = new Map();
  const getArticle = (locale) => {
    const lang = locale || 'it';
    if (cache.has(lang)) return cache.get(lang);
    const article = localizeArticle(bestId, lang) || localizeArticle(DEFAULT_ARTICLE_ID, lang);
    cache.set(lang, article);
    return article;
  };
  getArticle.articleId = bestId;
  getArticle.persistRotation = () => saveRecentlyFeaturedArticle(bestId);
  return getArticle;
}

// loadArticlePerformanceWinners lives in ./lib/articleContent.mjs (imported above).

/**
 * Resolve per-subscriber article content for the newsletter body:
 *   - hot/warm         → a single novelty pick matched to the subscriber's
 *     inferred interest (jobs / articles / utility), from real winners.
 *   - cool/cold/dormant → the single best-ranked winner from the flat
 *     (non-cluster-preferred) candidate list, same for dormant since the
 *     win-back sequence is a SEPARATE additional send
 *     (scripts/newsletter-winback-campaign.mjs), not a substitute for this
 *     regular weekly one.
 * The live template (services/newsletter-template.mjs, NOT the dead/unimported
 * scripts/newsletter-template.mjs) only renders a single `data.article`
 * object — there is no multi-article digest section — so every strategy
 * resolves to one article; `selectArticleCandidates`'s 'digest' mode still
 * differentiates cool/cold from hot/warm (flat vs cluster-preferred ranking),
 * we just take its top candidate instead of a multi-item list.
 * Falls back to the single globally-rotated `featuredArticleFn` whenever no
 * performance-ranked winner localizes for the subscriber's locale (missing
 * blog meta, etc.) — so the section is never left broken/empty.
 *
 * @param {Record<string, any>} subscriber
 * @param {string} locale
 * @param {(locale: string) => object|null} featuredArticleFn
 * @returns {{ segment: string, article: object|null }}
 */
function resolveArticleContent(subscriber, locale, featuredArticleFn) {
  const segmentInfo = describeSegment(subscriber);
  const winners = loadArticlePerformanceWinners();
  // Content strategy: dormant gets the same candidate ranking as cool/cold for
  // THIS regular send (segment id stays 'dormant' for tagging/reporting).
  const contentInfo = segmentInfo.strategy === CONTENT_STRATEGIES.WINBACK
    ? { strategy: CONTENT_STRATEGIES.DIGEST, interest: null }
    : segmentInfo;

  // (#4299) hot_utility/warm_utility subscribers get genuinely
  // time-of-year-relevant content (TFR calculator in Jan, Italian tax
  // return in spring, 3a pillar deadline in autumn, ...) FIRST — a real
  // seasonal pick beats the generic fiscale/pratico-clustered winner
  // article the ranking below would otherwise pick.
  if (contentInfo.interest === INTERESTS.UTILITY) {
    const seasonal = getSeasonalUtilityContent(new Date(), locale);
    if (seasonal) return { segment: segmentInfo.segmentId, article: seasonal };
  }

  const selection = selectArticleCandidates(contentInfo, winners);

  let article = null;
  if (selection.mode !== 'none') {
    for (const slug of selection.slugs) {
      const localized = localizeArticle(slug, locale);
      if (localized) { article = localized; break; }
    }
  }
  if (!article) article = featuredArticleFn(locale);

  return { segment: segmentInfo.segmentId, article };
}

/**
 * Build a synthetic subscriber whose engagement level + acquisition signals
 * resolve (via describeSegment) to the requested segment id — used ONLY by
 * `--preview --segment=<id>` so segment content assembly can be inspected
 * without a matching Firestore row. Not used by the real send path.
 *
 * @param {string} segmentId e.g. "hot_jobs", "warm_articles", "digest", "dormant"
 */
function synthesizeSubscriberForSegment(segmentId) {
  const base = {
    email: 'preview@example.com',
    sourceChannel: 'newsletter_page',
    locationInterest: null,
    sectorInterest: null,
    preferences: { jobs: true, taxUpdates: true },
  };
  if (segmentId === 'digest') return { ...base, engagementLevel: 'cool' };
  if (segmentId === 'dormant') return { ...base, engagementLevel: 'dormant' };
  const [level, interest] = segmentId.split('_');
  const INTEREST_SIGNALS = {
    jobs: { sourceComponent: 'JobBoard' },
    articles: { sourceRouteFamily: 'article_detail' },
    utility: { sourceComponent: 'TaxCalendar' },
    general: {},
  };
  return { ...base, engagementLevel: level || 'hot', ...(INTEREST_SIGNALS[interest] || {}) };
}

function getWeeklyFact(locale = 'it') {
  const EPOCH = new Date('2025-01-06').getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekIndex = Math.floor((Date.now() - EPOCH) / WEEK_MS) % 52;
  const FACTS = {
    it: [
      { text: 'In Svizzera, il salario mediano \u00e8 di circa 6.665 CHF al mese (2022).', source: 'UST' },
      { text: 'Oltre 78.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' },
      { text: 'La franchigia per i nuovi frontalieri dal 2024 \u00e8 di \u20ac10.000.', source: 'Nuovo Accordo Fiscale' },
      { text: 'Il tasso di disoccupazione in Ticino \u00e8 circa il 2.3%.', source: 'SECO' },
      { text: "L'AVS (1\u00b0 pilastro) copre circa il 40% del reddito pre-pensionamento.", source: 'BSV' },
      { text: 'Il 3\u00b0 pilastro 3a permette di dedurre fino a 7.258 CHF (2026) dalle tasse.', source: 'Admin.ch' },
    ],
    en: [
      { text: 'In Switzerland, the median salary is around CHF 6,665 per month (2022).', source: 'FSO' },
      { text: 'Over 78,000 cross-border workers commute to Canton Ticino.', source: 'USTAT' },
      { text: 'The tax allowance for new cross-border workers from 2024 is \u20ac10,000.', source: 'New Fiscal Agreement' },
      { text: 'The unemployment rate in Ticino is around 2.3%.', source: 'SECO' },
      { text: 'The AVS (1st pillar) covers about 40% of pre-retirement income.', source: 'BSV' },
      { text: 'Pillar 3a allows you to deduct up to CHF 7,258 (2026) from taxes.', source: 'Admin.ch' },
    ],
    de: [
      { text: 'In der Schweiz liegt der Medianlohn bei rund 6.665 CHF pro Monat (2022).', source: 'BFS' },
      { text: '\u00dcber 78.000 Grenzg\u00e4nger pendeln in den Kanton Tessin.', source: 'USTAT' },
      { text: 'Der Freibetrag f\u00fcr neue Grenzg\u00e4nger ab 2024 betr\u00e4gt \u20ac10.000.', source: 'Neues Steuerabkommen' },
      { text: 'Die Arbeitslosenquote im Tessin liegt bei etwa 2,3%.', source: 'SECO' },
      { text: 'Die AHV (1. S\u00e4ule) deckt rund 40% des Vorruhestandseinkommens.', source: 'BSV' },
      { text: 'S\u00e4ule 3a erm\u00f6glicht einen Steuerabzug von bis zu 7.258 CHF (2026).', source: 'Admin.ch' },
    ],
    fr: [
      { text: 'En Suisse, le salaire m\u00e9dian est d\u2019environ 6 665 CHF par mois (2022).', source: 'OFS' },
      { text: 'Plus de 78 000 frontaliers travaillent dans le canton du Tessin.', source: 'USTAT' },
      { text: 'L\u2019abattement fiscal pour les nouveaux frontaliers \u00e0 partir de 2024 est de \u20ac10 000.', source: 'Nouvel Accord Fiscal' },
      { text: 'Le taux de ch\u00f4mage au Tessin est d\u2019environ 2,3%.', source: 'SECO' },
      { text: 'L\u2019AVS (1er pilier) couvre environ 40% du revenu avant la retraite.', source: 'BSV' },
      { text: 'Le pilier 3a permet de d\u00e9duire jusqu\u2019\u00e0 7 258 CHF (2026) des imp\u00f4ts.', source: 'Admin.ch' },
    ],
  };
  const localeFacts = FACTS[locale] || FACTS.it;
  return localeFacts[weekIndex % localeFacts.length];
}

function loadLocalJobsData() {
  let jobs = [];
  let jobStats = {};

  // Primary: read assembled data/jobs.json
  try {
    jobs = JSON.parse(fs.readFileSync(new URL('../data/jobs.json', import.meta.url), 'utf8'));
  } catch {
    // Fallback: assemble from per-crawler slices (handles CI when assembly step failed)
    try {
      const slicesDir = new URL('../data/jobs/by-crawler/', import.meta.url);
      const sliceFiles = fs.readdirSync(slicesDir).filter((f) => f.endsWith('.json') && f !== '.gitkeep');
      for (const file of sliceFiles) {
        const slice = JSON.parse(fs.readFileSync(new URL(file, slicesDir), 'utf8'));
        if (Array.isArray(slice.jobs)) jobs.push(...slice.jobs);
      }
      if (jobs.length > 0) {
        console.warn(`⚠️  data/jobs.json missing — loaded ${jobs.length} jobs from ${sliceFiles.length} crawler slices`);
      }
    } catch (e2) {
      console.warn('⚠️  Local jobs load failed (both jobs.json and slices):', e2.message);
    }
  }

  try {
    jobStats = JSON.parse(fs.readFileSync(new URL('../data/jobs-stats.json', import.meta.url), 'utf8'));
  } catch {
    // stats are optional
  }

  // Drop test/dev fixture jobs so a local jobs.json fixture can never leak
  // a "Fixture Corp SA" link into a real subscriber send.
  jobs = filterFixtureJobs(jobs, 'send-newsletter');

  return { jobs, jobStats };
}

/**
 * Scan final HTML for job URLs and replace broken ones (slug not in validSlugs)
 * with the generic job board URL. Prevents 404s in sent newsletters.
 */
function sanitizeJobUrls(html, validSlugs) {
  if (!validSlugs || validSlugs.size === 0) return html;

  // Match every canton-aware job board section, any locale (not just TI —
  // see the matchJobsForSubscriber fix in newsletter-content.mjs). The
  // alternation MUST stay in its own non-capturing group before the
  // `-[a-z][a-z-]*` slug suffix — otherwise the suffix binds only to the
  // LAST alternative and every prefix but one silently stops matching.
  const boardSegment = `(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*`;
  const re = new RegExp(`href="([^"]*\\/(${boardSegment})\\/([^/"?#]+)\\/?[^"]*)"`, 'g');

  return html.replace(re, (fullMatch, fullUrl, board, slug) => {
    // Strip query params and trailing slash from slug for comparison
    const cleanSlug = slug.replace(/\/$/, '');
    // Company-hub pages (azienda-/company-/unternehmen-/entreprise-* per locale)
    // are valid — don't strip them (they aren't in the job validSlugs set).
    if (isCompanyHubSlug(cleanSlug)) return fullMatch;
    if (validSlugs.has(cleanSlug)) return fullMatch;

    console.warn(`⚠️  Broken job URL removed from newsletter: ${cleanSlug}`);
    const prefix = fullUrl.split(`/${board}/`)[0];
    return `href="${prefix}/${board}/"`;
  });
}

function buildJobContextIndex(jobs) {
  const index = new Map();
  const add = (slug, job) => {
    if (slug && !index.has(slug)) index.set(slug, job);
  };
  for (const job of jobs || []) {
    add(job.slug, job);
    for (const slug of Object.values(job.slugByLocale || {})) add(slug, job);
    for (const slug of job.previousSlugs || []) add(slug, job);
    for (const slugs of Object.values(job.previousSlugsByLocale || {})) {
      if (Array.isArray(slugs)) for (const slug of slugs) add(slug, job);
    }
  }
  return index;
}

function enrichSubscriberJobContext(subscriber, jobIndex) {
  // Resolve the source job from the saved slug, falling back to the slug the
  // backfill recovered (scripts/backfill-newsletter-job-context.mjs) for
  // subscribers whose original job_slug expired or was never captured.
  const savedSlug = subscriber?.job_slug || subscriber?.job_context_backfill_slug;
  const sourceJob = savedSlug ? jobIndex.get(savedSlug) : null;
  if (!sourceJob) return subscriber;
  return {
    ...subscriber,
    job_company: subscriber.job_company || sourceJob.company || null,
    job_location: subscriber.job_location || sourceJob.location || sourceJob.addressLocality || null,
    job_category: subscriber.job_category || sourceJob.category || sourceJob.sector || null,
    sourceJob,
  };
}

// ─── Subscriber fetching ────────────────────────────────────

// Shared source of truth (services/emailSuppression.mjs) so all senders agree.
const EXCLUDED_STATUSES = NEWSLETTER_EXCLUDED_STATUSES;

async function fetchTargetSubscriber(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const doc = await db.collection('newsletter_subscribers').doc(normalized).get();
  if (!doc.exists) return null;
  const row = doc.data();
  const status = (row.status || '').toLowerCase();
  if (EXCLUDED_STATUSES.has(status)) return null;
  if (row.unsubscribedAt || row.unsubscribed_at) return null;
  return subscriberFromFirestoreRow({ ...row, email: row.email || normalized });
}

async function fetchSubscribers() {
  const subscribers = new Map();
  // Raw rows feed the site-wide preferred-hour fallback (#3798) — the
  // projected subscriber objects still carry preferredSendHourUtc/
  // preferredSendSampleCount, but computeGlobalPreferredHour reads the
  // Firestore field names directly off the row, so keep the rows around too.
  const rawRows = [];

  try {
    // Fetch ALL subscribers (including pending) — clicking a link auto-confirms them.
    // Exclude only those who explicitly opted out or have delivery issues.
    const snap = await db.collection('newsletter_subscribers').get();
    snap.docs.forEach((d) => {
      if (d.id === '_meta_') return;
      const row = d.data();
      // Skip rows whose email field carries no address at all (empty or a
      // name-only string with no "@"); subscriberFromFirestoreRow is the
      // authoritative guard (it returns null for any unparseable address), this
      // just avoids the call on obviously-empty rows.
      if (!row.email || !/@/.test(String(row.email))) return;
      const status = (row.status || '').toLowerCase();
      if (EXCLUDED_STATUSES.has(status)) return;
      // Belt-and-suspenders: also exclude if unsubscribedAt is set (frontend handler bug backfill)
      if (row.unsubscribedAt || row.unsubscribed_at) return;
      rawRows.push(row);
      // Pass the RAW row.email so subscriberFromFirestoreRow can harvest a
      // "Name <addr>" display name; it strips the wrapper internally and
      // returns the bare address on subscriber.email.
      const subscriber = subscriberFromFirestoreRow(row);
      if (subscriber) subscribers.set(subscriber.email, subscriber);
    });
  } catch (e) {
    console.warn('\u26a0\ufe0f Subscriber fetch failed:', e.message);
  }

  // user_profiles collection removed — all subscriber data is in newsletter_subscribers

  const prioritized = prioritizeSubscribers([...subscribers.values()]);
  // Attach the site-wide preferred-hour aggregate as a property on the array
  // (same idiom as pickFeaturedArticle's getArticle.articleId/persistRotation)
  // so callers that only care about the subscriber list are unaffected.
  prioritized.globalPreferredHour = computeGlobalPreferredHour(rawRows);
  return prioritized;
}


// ─── Email headers ──────────────────────────────────────────

function makeMailtoUnsubscribe(email) {
  const local = (FROM_EMAIL.match(/<([^>]+)>/)?.[1] || FROM_EMAIL).trim();
  const to = local || 'newsletter@frontaliereticino.ch';
  const subject = encodeURIComponent('Unsubscribe Frontaliere Weekly');
  const body = encodeURIComponent(`Please unsubscribe ${email} from Frontaliere Weekly.`);
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

function buildEmailHeaders(email, campaign) {
  const campaignKey = slugifyHeaderValue(campaign);
  const emailKey = Buffer.from(String(email).toLowerCase()).toString('hex').slice(0, 24);
  return {
    'List-Unsubscribe': `<${makeOneClickUnsubscribeUrl(email)}>, <${makeMailtoUnsubscribe(email)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-ID': `Frontaliere Weekly <weekly.frontaliereticino.ch>`,
    'Feedback-ID': `${campaignKey}:frontaliere-weekly:frontaliere-ticino`,
    'X-Entity-Ref-ID': `${campaignKey}-${emailKey}`,
    'X-Campaign-Id': campaign,
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
}

// ─── Campaign Resume Tracking ───────────────────────────────

/**
 * The resume log — read, append, chunking — lives in
 * scripts/lib/campaignResumeLog.mjs, shared with the daily brief. Both channels
 * had grown their own copy of the same three lines, and both copies carried the
 * same two defects: one array in one 1 MiB document (this log accumulates a
 * whole week of daily resume runs), and marking only after the send loop, so a
 * crash partway through left the run unrecorded and the retry re-sent to
 * everyone already served. Fixed once, in one place (#5415 §3.6, AGENTS.md #6).
 *
 * `sentEmails` is the field name already written into live campaign documents
 * on this channel — the brief's is `emails`. Unifying the spelling would orphan
 * whatever campaign is in flight when this ships.
 */
const RESUME_LOG_FIELD = 'sentEmails';
const resumeLogOpts = (campaignId) => ({
  campaignId,
  field: RESUME_LOG_FIELD,
  extraFields: { lastRunAt: new Date(), updatedAt: new Date() },
});

async function fetchAlreadySent(campaignId) {
  if (!db) return new Set();
  try {
    const { sent } = await fetchCampaignAlreadySent(db, resumeLogOpts(campaignId));
    return sent;
  } catch (e) {
    console.warn('\u26a0\ufe0f Campaign resume fetch failed:', e?.message);
    return new Set();
  }
}

/** Chunk sizes for this campaign, so a rerun appends where the last run stopped. */
async function fetchResumeChunkSizes(campaignId) {
  if (!db) return [];
  try {
    const { chunkSizes } = await fetchCampaignAlreadySent(db, resumeLogOpts(campaignId));
    return chunkSizes;
  } catch {
    return [];
  }
}

// ─── Subject A/B auto-promotion ─────────────────────────────
// On by default (kill switch: NEWSLETTER_AB_AUTOPROMOTE=false). Safe: a no-op
// until a recent campaign has a statistically significant winner with enough
// sample (pickWinner gates), in which case the assignment biases toward it
// epsilon-greedily while still exploring the other arm.
const AB_AUTOPROMOTE = process.env.NEWSLETTER_AB_AUTOPROMOTE !== 'false';
const AB_PROMOTE_LOOKBACK = Math.max(1, Number(process.env.NEWSLETTER_AB_LOOKBACK || 2));

/**
 * Resolve auto-promotion winners for this campaign by pooling the previous
 * `AB_PROMOTE_LOOKBACK` campaigns. Returns a per-provider winner map plus a
 * global fallback: the send pipeline promotes `byProvider[p] ?? global` for the
 * provider that actually sends. Never throws → failure = no promotion.
 *
 * @returns {Promise<{byProvider:Record<string,string|null>, global:string|null}>}
 */
async function resolveWinnersForCampaign(database, campaignId) {
  if (!AB_AUTOPROMOTE || !database) return { byProvider: {}, global: null };
  try {
    const ids = previousCampaignIds(campaignId, AB_PROMOTE_LOOKBACK);
    const pooledCells = {};
    for (const cid of ids) {
      const { cells } = await loadCampaignVariantTotals(database, cid);
      for (const [provider, variants] of Object.entries(cells)) {
        pooledCells[provider] ??= {};
        for (const [v, c] of Object.entries(variants)) {
          pooledCells[provider][v] ??= { sends: 0, opens: 0 };
          pooledCells[provider][v].sends += c.sends;
          pooledCells[provider][v].opens += c.opens;
        }
      }
    }
    const { byProvider, global } = resolveWinnersByProvider(pooledCells);
    const perProvider = Object.entries(byProvider).filter(([, w]) => w).map(([p, w]) => `${p}:${w}`);
    if (global || perProvider.length) {
      console.log(`🏆 Auto-promote (ε=${DEFAULT_EPSILON}) from last ${ids.length} campaign(s): global=${global || 'none'}${perProvider.length ? `, per-provider=${perProvider.join(',')}` : ''}`);
    } else {
      console.log('⚖️  Auto-promote: even split (no significant winner yet)');
    }
    return { byProvider, global };
  } catch (e) {
    console.warn('⚠️ Auto-promote skipped:', e?.message);
    return { byProvider: {}, global: null };
  }
}

// ─── Resend API ─────────────────────────────────────────────

async function persistDelivery(recipient, messageId, meta) {
  if (!db) return;
  const FieldValue = adminSdk?.firestore?.FieldValue;
  try {
    const email = normalizeEmail(recipient.email);
    const locale = nlNormLocale(recipient.locale);
    const subRef = db.collection('newsletter_subscribers').doc(email);
    const deliveryDocId = buildDeliveryDocId(meta.campaignId, email);
    // Store delivery as a subcollection under the subscriber doc
    await subRef.collection('campaign_deliveries').doc(deliveryDocId).set({
      email,
      campaign_id: meta.campaignId,
      message_id: messageId || null,
      locale,
      source_channel: recipient.sourceChannel || null,
      location_interest: recipient.locationInterest || null,
      sector_interest: recipient.sectorInterest || null,
      // A/B subject test attribution — provider is authoritative here (every
      // cascade provider), variant/subject mirror the sent email so the
      // open-rate-by-provider×variant report has a self-contained send record.
      provider: meta.provider || null,
      variant: meta.variant || null,
      subject: meta.subject || null,
      // Content segment (#4299) — engagement level x inferred interest, e.g.
      // "hot_jobs" / "digest" / "dormant". Powers the per-segment
      // open/click/GA4-sessions report (scripts/newsletter-ab-report.mjs).
      segment: meta.segment || null,
      // Per-user send-time (#3798): scheduled_for is the cascade's
      // authoritative scheduledFor (null when the provider doesn't support
      // scheduling, or the run didn't request it) — NOT the requested
      // scheduledAt, so this reflects what actually happened. sent_at below
      // stays the moment the API call was made, unchanged.
      scheduled_for: meta.scheduledFor ?? null,
      send_time_source: meta.sendTimeSource ?? null,
      // Operator QA send (mode==='test', single --target-email) — not real
      // subscriber traffic; report-send-hour-impact.mjs excludes these.
      is_operator_verification: meta.isOperatorVerification ?? false,
      sent_at: new Date(),
    }, { merge: true });
    // Maileroo's open/click webhooks carry only message_reference_id (no recipient,
    // no tags). Persist an authoritative lookup keyed by that id so the webhook can
    // resolve the subscriber + real campaign for opens/clicks. Stored under
    // newsletter_subscribers/_meta_/maileroo_refs (same family as the rest of the
    // tracking) rather than a top-level collection. See
    // functions/src/newsletterMailerooWebhookCore.js.
    if (meta.provider === 'maileroo' && messageId) {
      await metaDocRef().collection('maileroo_refs').doc(String(messageId)).set({
        email,
        campaign_id: meta.campaignId,
        is_job_alert: false,
        updated_at: new Date(),
      }, { merge: true });
    }
    // Update subscriber-level counters
    const subUpdate = {
      last_sent_at: new Date(),
      send_count: FieldValue ? FieldValue.increment(1) : 1,
      updated_at: new Date(),
    };
    // Persist a freshly-resolved first name (display-name harvest / dataset
    // email guess) so future sends read it from firstName instead of
    // re-deriving. Only set when the doc had none (subscriberFromFirestoreRow
    // leaves firstNameToPersist null otherwise) → never clobbers a stored name.
    if (recipient.firstNameToPersist) subUpdate.firstName = recipient.firstNameToPersist;
    await subRef.set(subUpdate, { merge: true });
    // Refresh engagement score after counter changes (FRO-17). Belt-and-suspenders
    // alongside the ESP webhook recompute, so the persisted score stays fresh
    // even if a webhook delivery is lost.
    if (FieldValue) {
      await refreshEngagementScore(subRef, FieldValue);
    }
    // A/B exposure event (no-op unless POSTHOG_EMAIL_EXPERIMENT enabled). Ties to
    // the email_opened conversion in PostHog by distinct_id (email); carries the
    // variant + provider for the funnel breakdown. Skipped for operator QA
    // sends (#3798 sibling-pattern sweep) — same reason is_operator_verification
    // is excluded from the Firestore campaign_deliveries aggregates: a manual
    // test send/open isn't real subscriber behavior and would enter the
    // email_sent→email_opened funnel as a false exposure.
    if (!meta.isOperatorVerification) {
      await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.SENT, {
        email,
        variant: meta.variant,
        provider: meta.provider,
        campaignId: meta.campaignId,
        locale,
        segment: meta.segment,
      });
    }
  } catch (e) {
    console.warn('\u26a0\ufe0f Delivery persist failed:', e?.message);
  }
}

async function sendEmailBatch(emails, finalizeForProvider, onDelivered) {
  // After a per-provider subject swap, the final variant/subject live on the
  // payload (the source of truth for what was actually sent) — read them there
  // so the delivery record + PostHog event reflect the provider's variant.
  const persistSent = async (item, res) => {
    const variant = item.payload?.tags?.find((t) => t.name === 'variant')?.value || item.meta?.variant;
    const subject = item.payload?.subject || item.meta?.subject;
    // res.scheduledFor is the cascade's source of truth for what actually got
    // scheduled (#3798) — item.meta.sendTimeSource just carries WHY we asked
    // (personal/global), not whether the provider honored it.
    await persistDelivery(item.recipient, res.messageId, {
      ...item.meta,
      provider: res.provider,
      variant,
      subject,
      scheduledFor: res.scheduledFor ?? null,
    });
    // Resume marking happens HERE, per confirmed send, not after the loop: a
    // crash partway through a multi-thousand-email run used to leave the whole
    // run unrecorded (#5415 §3.6).
    if (onDelivered) await onDelivered(normalizeEmail(item.recipient.email));
  };
  // Single provider mode: force a specific provider via cascade
  if (IS_SINGLE_PROVIDER) {
    console.log(`📧 Sending via ${EMAIL_PROVIDER} only (${emails.length} emails)`);
    const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
    const result = await sendEmailCascade(emails, {
      concurrency: 1,
      delayMs: 1000,
      forceProvider: EMAIL_PROVIDER,
      finalizeForProvider,
      onSent: persistSent,
    });
    logProviderSummary();
    return result;
  }
  // Cascade: multi-provider free tier (default)
  if (EMAIL_PROVIDER === 'cascade') {
    console.log(`📧 Sending via email cascade (${emails.length} emails)`);
    const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
    const result = await sendEmailCascade(emails, {
      concurrency: 1,
      delayMs: 1000,
      finalizeForProvider,
      onSent: persistSent,
    });
    logProviderSummary();
    return result;
  }
  // Any EMAIL_PROVIDER value must be 'cascade' or one of SINGLE_PROVIDERS —
  // anything else is a config typo, not a legacy fallback (resend folded into
  // SINGLE_PROVIDERS 2026-07-16, see comment above SINGLE_PROVIDERS).
  throw new Error(`Unknown EMAIL_PROVIDER: "${EMAIL_PROVIDER}" (expected "cascade" or one of ${SINGLE_PROVIDERS.join(', ')})`);
}

// ─── Issue number (real campaign count) ─────────────────────

async function getNextIssueNumber({ persist = false } = {}) {
  if (!db) return null;
  try {
    const data = await readMetaDoc();
    const current = data.issue_number || 0;
    const next = current + 1;
    if (persist) await writeMetaDoc({ issue_number: next });
    return next;
  } catch (e) {
    console.warn('\u26a0\ufe0f Issue number fetch failed:', e.message);
    return null;
  }
}

// ─── Log to Firestore ───────────────────────────────────────

async function logSend(count, subject, status) {
  if (!db) return;
  try {
    // Store campaign log under newsletter_subscribers/_meta_/campaign_logs subcollection
    const metaRef = db.collection('newsletter_subscribers').doc('_meta_');
    await metaRef.collection('campaign_logs').add({
      sentAt: new Date(),
      recipientCount: count,
      subject,
      status,
      version: 'v2-ai',
    });
    // Also update _meta_ doc with last send info for quick reads
    await metaRef.set({
      last_sent_at: new Date(),
      last_recipient_count: count,
      last_subject: subject,
      last_status: status,
    }, { merge: true });
  } catch (e) {
    console.warn('\u26a0\ufe0f Log send failed:', e.message);
  }
}

// ─── QA Gate ────────────────────────────────────────────────

/**
 * Verify that a passing QA report was produced today (UTC) before
 * allowing a production send. Exits with code 1 if the gate fails.
 *
 * Skipped when NEWSLETTER_SKIP_QA_GATE=true (CI emergency override only).
 */
/**
 * Inline QA validation — runs essential checks on the first generated email
 * before sending any. No external report file required.
 * Returns true if all checks pass.
 */
function inlineQaCheck(sampleHtml, subject) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, passed: false, detail });
  const pass = (name) => checks.push({ name, passed: true });

  // Subject line
  if (!subject || subject.length < 10) fail('subject_present', `Subject too short: "${subject}"`);
  else if (subject.length > 60) fail('subject_length', `Subject > 60 chars (${subject.length}): "${subject}"`);
  else if (subject.endsWith('...') || subject.endsWith('…')) fail('subject_truncated', `Subject appears truncated: "${subject}"`);
  else pass('subject_ok');

  // HTML structure
  if (!sampleHtml || sampleHtml.length < 500) fail('html_present', 'HTML body too short');
  else pass('html_present');

  // Unsubscribe link
  if (!sampleHtml.includes('unsubscribe')) fail('unsubscribe_link', 'Missing unsubscribe link');
  else pass('unsubscribe_link');

  // Exchange rate card
  if (!sampleHtml.includes('CHF') && !sampleHtml.includes('EUR')) fail('exchange_rate', 'Missing exchange rate');
  else pass('exchange_rate');

  // Job links (at least one job board link, any locale, any canton)
  if (!JOB_BOARD_SECTION_RX.test(sampleHtml)) fail('job_links', 'No job links found in HTML');
  else pass('job_links');

  // No raw template variables
  if (/\{\{[^}]+\}\}/.test(sampleHtml)) fail('no_template_vars', 'Unresolved {{template}} variables');
  else pass('no_template_vars');

  // Unsubscribe / autologin link integrity.
  //
  // This used to be `sampleHtml.includes('action=unsubscribe')` — a substring
  // test that asserts the TEXT is there and nothing else. It cannot see whether
  // the URL resolves, whether the endpoint answers, or whether the click does
  // anything, and the #5672/#5673 unsubscribe defect lived for months behind it
  // (issue #5682). auditEmailLinksStatic runs the real checks on the same
  // already-personalized body: an `?action=` link with no `ac` (the shape
  // App.tsx rejects with "Link non valido"), an unsigned unsubscribe URL,
  // half-wrapped autologin, a relative href, a body with no unsubscribe link of
  // either shape. Static only — it must not add network latency in front of a
  // send; the live half runs post-send in scripts/lib/email-cascade.mjs.
  //
  // Only the codes that mean "the recipient cannot unsubscribe" ABORT the send
  // — this gate calls process.exit(1) and blocking the whole weekly campaign on
  // a cosmetic link defect would be a worse outcome than sending it. Everything
  // else the audit finds is logged here and reported again, in full, by the
  // post-send audit in scripts/lib/email-cascade.mjs, which cannot block
  // anything because the message has already gone out.
  const BLOCKING_LINK_CODES = new Set([
    'spa_action_without_ac',
    'unsubscribe_missing',
    'unsigned_link',
    'authenticated_without_ac',
    'html_missing',
  ]);
  const linkAudit = auditEmailLinksStatic(sampleHtml, { channel: 'newsletter-weekly' });
  const linkErrors = linkAudit.findings.filter((f) => f.severity === 'error');
  const blocking = linkErrors.filter((f) => BLOCKING_LINK_CODES.has(f.code));
  for (const f of linkErrors.filter((f) => !BLOCKING_LINK_CODES.has(f.code))) {
    console.warn(`⚠️ link audit ${f.code}: ${f.detail}${f.url ? ` — ${f.url}` : ''}`);
  }
  if (blocking.length) {
    for (const f of blocking) fail(`links_${f.code}`, `${f.detail}${f.url ? ` — ${f.url}` : ''}`);
  } else {
    pass('unsubscribe_url');
  }

  // ── HTML well-formedness checks (scoped to editorial section only) ──

  // Check for unclosed <p> tags in the editorial section
  const editorialMatch = sampleHtml.match(/Parliamoci chiaro\.<\/div>([\s\S]*?)<div[^>]*font-style:\s*italic/i);
  if (editorialMatch) {
    const editorial = editorialMatch[1];
    const epOpen = (editorial.match(/<p[\s>]/gi) || []).length;
    const epClose = (editorial.match(/<\/p>/gi) || []).length;
    if (epOpen !== epClose) fail('html_p_editorial', `Editorial: ${epOpen} <p> open vs ${epClose} </p> close`);
    else pass('html_p_editorial');

    // Check editorial has inline styles on <p> tags
    const unstyledP = (editorial.match(/<p>/gi) || []).length;
    if (unstyledP > 0) fail('editorial_p_styles', `${unstyledP} <p> tag(s) without inline styles in editorial`);
    else pass('editorial_p_styles');

    // Check editorial minimum word count (catches truncated AI output)
    const editorialText = editorial.replace(/<[^>]+>/g, '').trim();
    const editorialWords = editorialText.split(/\s+/).filter(w => w.length > 0).length;
    if (editorialWords < 40) fail('editorial_length', `Editorial too short: ${editorialWords} words (min 40)`);
    else pass('editorial_length');

    // Check for truncated sentences (text ending mid-word before signature)
    const lastSentence = editorialText.trim();
    if (lastSentence.length > 0 && !/[.!?»"')\u2019%]$/.test(lastSentence)) {
      fail('editorial_truncated', `Editorial appears truncated: "...${lastSentence.slice(-60)}"`);
    } else {
      pass('editorial_not_truncated');
    }
  }

  const failed = checks.filter(c => !c.passed);
  if (failed.length > 0) {
    console.error(`\u274c Inline QA failed (${failed.length}/${checks.length} checks):`);
    for (const f of failed) console.error(`  \u2717 ${f.name}: ${f.detail}`);
    return false;
  }
  console.log(`\u2705 Inline QA passed (${checks.length}/${checks.length} checks)`);
  return true;
}

function enforceQaGate() {
  if (process.env.NEWSLETTER_SKIP_QA_GATE === 'true') {
    console.warn('\u26a0\ufe0f  QA gate skipped (NEWSLETTER_SKIP_QA_GATE=true) — inline QA will run before send.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(QA_DIR, `${today}-report.json`);

  // If a file-based report exists, use it; otherwise fall through to inline QA (runs after email assembly)
  if (fs.existsSync(reportPath)) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch {
      console.warn('\u26a0\ufe0f  QA report unreadable — inline QA will run before send.');
      return;
    }
    if (!report.passed) {
      console.error('\u274c  QA gate: today\'s report has FAILED checks. Fix issues or set NEWSLETTER_SKIP_QA_GATE=true.');
      process.exit(1);
    }
    const ageHours = ((Date.now() - new Date(report.generatedAt).getTime()) / 3.6e6).toFixed(1);
    console.log(`\u2705 QA file gate passed — report from ${ageHours}h ago (${report.checksPassed}/${report.checksTotal} checks).`);
  } else {
    console.log('\u2139\ufe0f  No QA report for today — inline QA will validate before send.');
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--send') ? 'send'
    : args.includes('--dry-run') ? 'dry-run'
    : args.includes('--test') ? 'test'
    : 'preview';
  const noAI = args.includes('--no-ai');
  const digestOnly = args.includes('--digest-only');
  const targetEmail = readArgValue('--target-email');
  const subjectOverride = readArgValue('--subject');
  // --segment=<id> (preview mode only, #4299): synthesize a subscriber whose
  // engagement level / acquisition signals resolve to the requested segment
  // (e.g. hot_jobs, warm_articles, digest, dormant) so QA can inspect real
  // per-segment content assembly without needing a matching Firestore row.
  const segmentOverride = readArgValue('--segment');

  console.log(`\ud83d\udce7 Newsletter v2 | mode: ${mode} | AI: ${!noAI} | digestOnly: ${digestOnly}`);

  const wouldSend = mode === 'send' || mode === 'test';
  if (wouldSend && (EXPERIMENTAL_MODE || !SEND_ENABLED)) {
    console.error('\ud83d\uded1 Invio bloccato: NEWSLETTER_EXPERIMENTAL_MODE o NEWSLETTER_ENABLE_SEND non configurati.');
    process.exit(1);
  }

  if (mode === 'dry-run' && !targetEmail) {
    console.error('❌ --dry-run requires --target-email <email>');
    process.exit(1);
  }

  // QA gate: production send requires a passing QA report from today
  if (mode === 'send') {
    enforceQaGate();
  }

  // Init Firebase (required for test/send/dry-run)
  if (mode !== 'preview') await initFirebase();

  // Init AI (unless --no-ai)
  if (!noAI) await initAI();

  // ── Fetch shared content ──
  let exchangeRate = null;
  let exchangeInsight = null;
  if (db) {
    exchangeRate = await fetchExchangeRate();
    const history = await fetchExchangeHistory(120);
    // Always use history for the 7-day-ago rate — Firestore previousRate is just
    // the last hourly update, not the weekly comparison we need for the newsletter
    if (exchangeRate && history.length >= 2) {
      const weekAgoDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const weekAgoEntry = history.find(h => h.date === weekAgoDate)
        || history.filter(h => h.date <= weekAgoDate).pop()
        || history[0];
      exchangeRate.previousRate = weekAgoEntry?.rate || exchangeRate.rate;
      console.log(`📊 Rate: ${exchangeRate.rate.toFixed(4)} | 7d ago (${weekAgoEntry?.date || '?'}): ${exchangeRate.previousRate.toFixed(4)} | Δ ${(((exchangeRate.rate - exchangeRate.previousRate) / exchangeRate.previousRate) * 100).toFixed(2)}%`);
    } else if (exchangeRate && !exchangeRate.previousRate) {
      exchangeRate.previousRate = exchangeRate.rate; // no change if no history
    }
    exchangeInsight = computeExchangeInsight(
      history,
      exchangeRate?.rate || 0.9420,
      exchangeRate?.previousRate || 0.9385,
    );
  }
  // Fallback if Firestore unavailable or fetch failed
  if (!exchangeRate) {
    exchangeRate = { rate: 0.9420, previousRate: 0.9385 };
    if (!exchangeInsight) exchangeInsight = { headline: 'CHF/EUR stabile', summary: 'Fallback rate.', bestWeekday: 'N/D', currentMonthAvg: 0.9420, previousMonthAvg: 0.9385 };
  }

  const { jobs } = loadLocalJobsData();
  const jobContextIndex = buildJobContextIndex(jobs);

  // Load job rotation history and subscriber alerts (parallel, non-blocking)
  const [recentlyFeaturedJobs, allJobAlerts] = await Promise.all([
    fetchRecentlyFeaturedJobs(),
    fetchAllJobAlerts(),
  ]);
  if (recentlyFeaturedJobs.length) {
    console.log(`🔄 Job rotation: excluding ${recentlyFeaturedJobs.length} recently featured slugs`);
  }

  // Tool-of-the-week index: shared across all locales so every subscriber sees the
  // same featured tool, but the tool's title/description is rendered in their locale.
  const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % 4;
  const getFeaturedToolForLocale = (locale) => {
    const tools = getFeaturedTools(locale);
    return tools[toolIndex % tools.length];
  };
  // Campaign ID anchored to the week's Monday so multi-day sends share the same ID
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const campaignId = `weekly_${monday.toISOString().split('T')[0]}`;
  const alreadySentForCampaign = mode === 'send' ? await fetchAlreadySent(campaignId) : new Set();
  const isResume = alreadySentForCampaign.size > 0;
  const featuredArticle = await pickFeaturedArticle();
  const issueNumber = isResume ? null : await getNextIssueNumber({ persist: mode === 'send' });
  if (issueNumber) console.log(`📰 Issue #${issueNumber}`);
  if (isResume) console.log(`🔄 Resuming campaign ${campaignId} (${alreadySentForCampaign.size} already sent)`);

  // ── Preview mode ──
  if (mode === 'preview') {
    // --locale <it|en|de|fr> lets segment/content previews be inspected in any
    // supported locale (same idiom as newsletter-winback-campaign.mjs --preview
    // --locale); unknown values normalize to 'it' via nlNormLocale.
    const locale = nlNormLocale(readArgValue('--locale') || 'it');
    const previewFeaturedTool = getFeaturedToolForLocale(locale);
    const previewJobs = validateJobUrls(
      matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 4),
      jobs,
    );
    let briefing = noAI
      ? getFallbackBriefing(locale, exchangeRate)
      : (await generateAIBriefing({
          subscriber: { locale, preferences: { jobs: true, taxUpdates: true } },
          exchangeRate, exchangeInsight, matchedJobs: previewJobs, weeklyFact: getWeeklyFact(locale), featuredTool: previewFeaturedTool,
        })) || getFallbackBriefing(locale, exchangeRate);
    // Always inject job links — applies to both AI and fallback briefings
    briefing = injectJobAndCompanyLinks(briefing, previewJobs, locale);
    briefing = injectToolLinks(briefing, locale);

    const previewSubscriber = segmentOverride
      ? synthesizeSubscriberForSegment(segmentOverride)
      : { engagementLevel: 'hot' }; // legacy default profile when --segment is omitted
    const articleContent = resolveArticleContent(previewSubscriber, locale, featuredArticle);
    if (segmentOverride) console.error(`🎯 Preview segment: ${articleContent.segment}`);

    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs: previewJobs,
      totalJobs: jobs.length,
      article: articleContent.article,
      featuredTool: previewFeaturedTool,
      weeklyFact: getWeeklyFact(locale),
      metrics: loadDashboardMetrics(),
      locale,
      issueNumber,
      interest: inferInterest(previewSubscriber),
      recommendationCampaign: campaignId,
      unsubscribeUrl: `${BASE_URL}/?action=unsubscribe&email=preview@example.com`,
      resubscribeUrl: `${BASE_URL}/?action=resubscribe&email=preview@example.com`,
    });
    process.stdout.write(html);
    if (flushScores) await flushScores();
    return;
  }

  // ── Fetch subscribers ──
  let subscribers;
  // Per-user send-time (#3798): site-wide fallback hour, populated below only
  // for a real 'send' run (test/dry-run recipients are single-target and
  // don't need — nor compute — the site-wide aggregate).
  let globalPreferredHour = { hourUtc: null, sampleUsers: 0 };
  if (mode === 'test') {
    const targetSubscriber = targetEmail ? await fetchTargetSubscriber(targetEmail) : null;
    subscribers = targetSubscriber ? [targetSubscriber] : [{
      email: targetEmail || ADMIN_EMAIL,
      locale: 'it',
      sourceChannel: 'newsletter_page',
      locationInterest: null,
      sectorInterest: null,
      preferences: { jobs: true, taxUpdates: true },
    }];
    console.log(`\ud83d\udce8 Test mode: ${subscribers[0].email}${targetSubscriber ? ' (Firestore profile)' : ' (fallback profile)'}`);
  } else if (mode === 'dry-run') {
    const subscriber = await fetchTargetSubscriber(targetEmail);
    if (!subscriber) {
      console.error(`❌ Dry-run target not found or not eligible: ${targetEmail}`);
      process.exit(1);
    }
    subscribers = [subscriber];
    console.log(`🧪 Dry-run target: ${subscriber.email}`);
  } else {
    subscribers = await fetchSubscribers();
    console.log(`\ud83d\udce8 Send mode: ${subscribers.length} active subscribers`);

    // Per-user send-time (#3798): fetchSubscribers() (only reached in the real
    // 'send' branch) attached the site-wide preferred-hour aggregate computed
    // from every subscriber's raw preferred_send_hour_utc. Persist it on
    // newsletter_subscribers/_meta_ so send-job-alerts.mjs can read the same
    // global fallback for its own recipients -- real sends only, guarded
    // explicitly even though this branch is currently the only caller.
    globalPreferredHour = subscribers.globalPreferredHour || { hourUtc: null, sampleUsers: 0 };
    if (mode === 'send' && db) {
      try {
        await writeMetaDoc({
          global_preferred_send_hour_utc: globalPreferredHour.hourUtc,
          global_preferred_send_sample_users: globalPreferredHour.sampleUsers,
          global_preferred_send_updated_at: new Date(),
        });
        console.log(`\ud83d\udd50 Global preferred send hour: ${globalPreferredHour.hourUtc ?? 'n/a'} UTC (${globalPreferredHour.sampleUsers} qualified users)`);
      } catch (e) {
        console.warn('\u26a0\ufe0f  Global preferred send hour persist failed:', e?.message);
      }
    }

    // ── Job-alert cooldown (symmetric to the 36h newsletter cooldown in
    // send-job-alerts.mjs:NEWSLETTER_COOLDOWN_MS): skip subscribers who
    // received a job alert in the last 36h, so nobody gets two automated
    // emails within the same ~1.5-day window. Reads job_alert_subscribers/
    // {email}.last_sent_at, written by send-job-alerts.mjs after each send.
    // SKIP_JOB_ALERT_COOLDOWN=1 bypasses this (manual/test sends).
    const JOB_ALERT_COOLDOWN_MS = process.env.SKIP_JOB_ALERT_COOLDOWN === '1' ? 0 : 36 * 60 * 60 * 1000;
    if (JOB_ALERT_COOLDOWN_MS > 0 && db) {
      const nowMs = Date.now();
      const cooldownSet = new Set();
      const emails = [...new Set(subscribers.map((s) => normalizeEmail(s.email)).filter(Boolean))];
      const LOOKUP_CHUNK_SIZE = 200;
      for (let i = 0; i < emails.length; i += LOOKUP_CHUNK_SIZE) {
        const chunk = emails.slice(i, i + LOOKUP_CHUNK_SIZE);
        try {
          const refs = chunk.map((email) => db.collection('job_alert_subscribers').doc(email));
          const snaps = await db.getAll(...refs);
          snaps.forEach((snap, idx) => {
            if (!snap.exists) return;
            const lastSentAt = snap.data()?.last_sent_at;
            if (!lastSentAt) return;
            const ts = typeof lastSentAt.toMillis === 'function' ? lastSentAt.toMillis() : new Date(lastSentAt).getTime();
            if (nowMs - ts < JOB_ALERT_COOLDOWN_MS) cooldownSet.add(chunk[idx]);
          });
        } catch (e) {
          console.warn(`\u26a0\ufe0f  Job-alert cooldown lookup failed for ${chunk.length} email(s): ${e?.message || e}`);
        }
      }
      if (cooldownSet.size > 0) {
        const before = subscribers.length;
        subscribers = subscribers.filter((s) => !cooldownSet.has(normalizeEmail(s.email)));
        console.log(`\ud83d\udce8 Job-alert cooldown (36h): ${before - subscribers.length} subscriber(s) deferred (job alert sent recently)`);
      }
    }
    // ── Digest targeting ──
    // Design decision: By default, ALL subscribers receive the weekly Monday digest.
    // The subscriber `type` field (e.g., 'weekly_digest', 'general') is informational
    // and preserved for analytics/segmentation, but does NOT gate delivery.
    //
    // When --digest-only is passed, only subscribers with type='weekly_digest' receive
    // the email. This is intended for future use if we add separate campaign types
    // (e.g., breaking news, tax alerts) where only digest subscribers should get
    // the Monday automated email while other subscribers get targeted campaigns.
    //
    // Current behavior: all subscribers get the Monday digest (safest default).
    if (digestOnly) {
      const beforeCount = subscribers.length;
      subscribers = subscribers.filter(s => s.type === 'weekly_digest');
      console.log(`\ud83c\udfaf Digest-only filter: ${beforeCount} -> ${subscribers.length} subscribers (type='weekly_digest' only)`);
    }

    if (subscribers.length === 0) {
      console.warn('\u26a0\ufe0f No subscribers found. Aborting.');
      return;
    }
  }

  subscribers = subscribers.map((subscriber) => enrichSubscriberJobContext(subscriber, jobContextIndex));

  // ── Build personalized emails (optimized pipeline) ──
  let aiSuccessCount = 0;
  let aiFallbackCount = 0;

  // Build valid slug index for URL validation in final HTML
  const validJobSlugs = new Set();
  for (const j of jobs) {
    if (j.slug) validJobSlugs.add(j.slug);
    if (j.slugByLocale) {
      for (const s of Object.values(j.slugByLocale)) {
        if (s) validJobSlugs.add(s);
      }
    }
  }

  // ── Phase 1: Match jobs for all subscribers & build cohorts ──
  console.log('\n📋 Phase 1: Job matching & cohort grouping...');
  // Canary gate: broadcast-restricted ads never enter a non-owner's candidate
  // pool, so a test listing can't surface in real subscribers' newsletters (nor
  // displace a real job from the top-4). The owner still sees them.
  const jobsNoCanary = jobs.filter((j) => !isCanaryJob(j));
  const subscriberData = subscribers.map((subscriber) => {
    const locale = nlNormLocale(subscriber.locale);
    const subscriberAlerts = allJobAlerts.get((subscriber.email || '').toLowerCase()) || [];
    const eligibleJobs = isOwnerEmail(subscriber.email) ? jobs : jobsNoCanary;
    const rawMatched = matchJobsForSubscriber(subscriber, eligibleJobs, 4, locale, recentlyFeaturedJobs);
    const matchedJobs = validateJobUrls(rawMatched, jobs).map((job) => ({
      ...job,
      alertMatch: jobMatchesAlerts(job, subscriberAlerts),
    }));
    const cohortKey = `${locale}:${jobSetHash(matchedJobs)}`;
    return { subscriber, locale, matchedJobs, cohortKey };
  });

  // Group by cohort (same locale + same job set = same AI briefing)
  const cohorts = new Map();
  for (const entry of subscriberData) {
    if (!cohorts.has(entry.cohortKey)) {
      cohorts.set(entry.cohortKey, {
        locale: entry.locale,
        matchedJobs: entry.matchedJobs,
        subscriber: entry.subscriber, // representative subscriber for AI prompt
        members: [],
      });
    }
    cohorts.get(entry.cohortKey).members.push(entry);
  }
  console.log(`  ${subscribers.length} subscribers → ${cohorts.size} cohorts`);

  // ── Phase 2: Generate AI briefings, batched per locale (parallel) ──
  console.log(`🧠 Phase 2: AI briefings (batches of ≤${AI_BRIEFING_BATCH_SIZE} cohorts, same locale, parallel)...`);
  const cohortEntries = [...cohorts.entries()];
  let briefingResults;
  if (noAI) {
    briefingResults = cohortEntries.map(([key, c]) => [key, getFallbackBriefing(c.locale, exchangeRate)]);
  } else {
    // Never mix locales in one batch (see buildBriefingBatchPrompt) — group
    // by locale first, then chunk each locale's cohorts into fixed-size batches.
    const byLocale = new Map();
    for (const entry of cohortEntries) {
      const loc = entry[1].locale;
      if (!byLocale.has(loc)) byLocale.set(loc, []);
      byLocale.get(loc).push(entry);
    }
    const batches = [];
    for (const entries of byLocale.values()) {
      for (let i = 0; i < entries.length; i += AI_BRIEFING_BATCH_SIZE) {
        batches.push(entries.slice(i, i + AI_BRIEFING_BATCH_SIZE));
      }
    }
    const batchResults = await pMap(batches, async (batch) => {
      const items = batch.map(([, cohort], idx) => ({
        id: String(idx),
        ctx: {
          subscriber: cohort.subscriber,
          exchangeRate, exchangeInsight,
          matchedJobs: cohort.matchedJobs,
          weeklyFact: getWeeklyFact(cohort.locale),
          featuredTool: getFeaturedToolForLocale(cohort.locale),
        },
      }));
      const resultMap = await generateAIBriefingsBatch(items);
      return batch.map(([key], idx) => [key, resultMap.get(String(idx)) || null]);
    }, AI_CONCURRENCY);
    briefingResults = batchResults.flat();
  }

  const briefingMap = new Map();
  for (const [key, briefing] of briefingResults) {
    const cohort = cohorts.get(key);
    let finalBriefing;
    if (briefing) {
      finalBriefing = briefing;
      aiSuccessCount++;
    } else {
      finalBriefing = getFallbackBriefing(cohort.locale, exchangeRate);
      aiFallbackCount++;
    }
    // Always inject job links — applies to both AI and fallback briefings
    finalBriefing = injectJobAndCompanyLinks(finalBriefing, cohort.matchedJobs, cohort.locale);
    finalBriefing = injectToolLinks(finalBriefing, cohort.locale);
    briefingMap.set(key, finalBriefing);
  }
  console.log(`  ✓ ${aiSuccessCount} AI briefings, ${aiFallbackCount} fallbacks`);

  // ── Phase 3: Generate 1 AI subject per locale × A/B variant ──
  // Subject-line A/B test: one subject per (locale, variant) so each subscriber
  // gets the subject for their deterministically-assigned variant (Phase 5).
  // Still cohort-cheap: at most locales × variants AI calls (≤8), not per-sub.
  const variantIds = listVariantIds();
  const subjectKey = (loc, variant) => `${loc}::${variant}`;
  console.log(`✏️  Phase 3: AI subjects (${variantIds.length} variants/locale: ${variantIds.join(', ')})...`);
  const locales = [...new Set(subscriberData.map(d => d.locale))];
  const subjectMap = new Map();

  if (subjectOverride) {
    for (const loc of locales) for (const v of variantIds) subjectMap.set(subjectKey(loc, v), subjectOverride);
  } else if (noAI) {
    for (const loc of locales) for (const v of variantIds) subjectMap.set(subjectKey(loc, v), getVariantFallback(v, loc));
  } else {
    // Pick a representative cohort per locale (the one with most members)
    const localeRepresentatives = new Map();
    for (const [key, cohort] of cohorts) {
      const loc = cohort.locale;
      const existing = localeRepresentatives.get(loc);
      if (!existing || cohort.members.length > existing.members.length) {
        localeRepresentatives.set(loc, { ...cohort, briefing: briefingMap.get(key) });
      }
    }

    const localeVariantPairs = [];
    for (const loc of locales) for (const variant of variantIds) localeVariantPairs.push({ loc, variant });
    await pMap(localeVariantPairs, async ({ loc, variant }) => {
      const rep = localeRepresentatives.get(loc);
      const briefingText = rep?.briefing?.replace(/<[^>]+>/g, '').slice(0, 100) || '';
      const subject = await generateAISubject({
        subscriber: rep?.subscriber || { locale: loc },
        exchangeRate,
        matchedJobs: rep?.matchedJobs || [],
        briefingSummary: briefingText,
        variant,
      });
      subjectMap.set(subjectKey(loc, variant), subject || getVariantFallback(variant, loc));
    }, Math.min(localeVariantPairs.length, AI_CONCURRENCY)); // bounded parallel AI calls
  }
  console.log(`  ✓ ${subjectMap.size} subjects: ${[...subjectMap.entries()].map(([k, s]) => `${k}="${s}"`).join(', ')}`);

  // ── Phase 4: Generate autologin codes (deterministic HMAC, no async needed) ──
  console.log('🔑 Phase 4: Autologin codes (HMAC)...');
  const codeMap = new Map();
  let optedOutCount = 0;
  for (const subscriber of subscribers) {
    if (subscriber.autologinEnabled === false) {
      codeMap.set(subscriber.email, null);
      optedOutCount++;
    } else {
      codeMap.set(subscriber.email, generateAutologinCode(subscriber.email));
    }
  }
  console.log(`  ✓ ${codeMap.size} autologin codes processed (${optedOutCount} opted out)`);

  // ── Phase 5: Assemble emails (CPU-only, no async) ──
  console.log('📦 Phase 5: Assembling emails...');
  const metrics = loadDashboardMetrics();
  const emails = [];

  // Auto-promotion: bias the variant split toward the recent winner (on by
  // default; null/empty = even split until a significant winner exists). The
  // global winner is the assembly-time default; the per-provider winner is
  // applied at send time once the provider is known (finalizeForProvider below).
  const winners = await resolveWinnersForCampaign(db, campaignId);
  const promotedVariant = winners.global;

  // Per-user send-time (#3798): tally so the dry-run/preview table + the
  // post-send log can report immediate vs scheduled, broken down by source.
  const scheduleTally = { immediate: 0, personal: 0, global: 0 };

  for (const { subscriber, locale, matchedJobs, cohortKey } of subscriberData) {
    const briefing = briefingMap.get(cohortKey);
    // A/B test: deterministic per-subscriber variant (stable for this campaign),
    // epsilon-greedy when a winner is promoted. Fall back to the first variant's
    // subject, then the variant fallback, so a missing (locale,variant) entry
    // can never leave subject undefined.
    const variant = assignSubjectVariant(subscriber.email, campaignId, { promotedVariant, epsilon: DEFAULT_EPSILON });
    const subject = subjectMap.get(subjectKey(locale, variant))
      || subjectMap.get(subjectKey(locale, variantIds[0]))
      || getVariantFallback(variant, locale);

    // Segment content assembly (#4299): engagement level x inferred interest
    // picks the best-ranked article from real article-performance winners —
    // cluster-preferred for hot/warm, flat-ranked for cool/cold/dormant —
    // falling back to the globally-rotated featuredArticle when nothing
    // localizes.
    const articleContent = resolveArticleContent(subscriber, locale, featuredArticle);

    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs,
      totalJobs: jobs.length,
      article: articleContent.article,
      featuredTool: getFeaturedToolForLocale(locale),
      weeklyFact: getWeeklyFact(locale),
      metrics,
      locale,
      // High-confidence first name resolved in subscriberFromFirestoreRow
      // (stored firstName/name → harvested display name → dataset email guess),
      // or null → generic greeting. personalizeGreeting title-cases it.
      recipientName: subscriber.firstName,
      issueNumber,
      // Recommended (revenue) block (#4450): segment relevance + acquisition
      // tracking so the affiliate/sponsor link is attributed to the email
      // channel and the originating signup surface.
      interest: inferInterest(subscriber),
      acquisitionSource: subscriber.source || subscriber.sourceComponent || subscriber.sourceChannel || null,
      recommendationCampaign: campaignId,
      // makeUnsubscribeUrl points at the site root and is handled by the SPA,
      // which REJECTS it with "Link non valido" unless the URL carries the `ac`
      // autologin code. That code is normally injected a few lines below by
      // personalizeHtmlWithToken — but `codeMap` holds NULL for any subscriber
      // with autologinEnabled === false, and makeAuthenticatedUrl with a null
      // code adds `ne`/`utm_medium` and no `ac`. Those recipients were getting a
      // footer unsubscribe link that cannot work: the exact #5672 shape, on the
      // exact link the LPD art. 25/32 complaint was about. For them use the
      // one-click endpoint instead — it goes straight to the Cloud Function and
      // needs no autologin at all (functions/src/lib/newsletterUrls.js).
      // Reported by the post-send audit as `spa_action_without_ac` (#5682).
      unsubscribeUrl: codeMap.get(subscriber.email)
        ? makeUnsubscribeUrl(subscriber.email)
        : makeOneClickUnsubscribeUrl(subscriber.email),
      resubscribeUrl: makeResubscribeUrl(subscriber.email),
      // fallbackUnsigned: true reproduces this script's pre-consolidation
      // behavior (an unsigned link instead of a dropped one when
      // NEWSLETTER_SECRET is unset) — see functions/src/lib/newsletterUrls.js.
      // email.toLowerCase() reproduces the old local implementation's exact
      // query-param + token casing (subscriber.email is already lowercased
      // by subscriberFromFirestoreRow.mjs, so this is a no-op today, kept
      // explicit so behavior doesn't depend on that upstream invariant).
      preferencesUrl: makePreferencesUrl(subscriber.email.toLowerCase(), locale, { fallbackUnsigned: true }),
    });

    // Personalize links with pre-generated HMAC autologin code (never expires)
    const autologinCode = codeMap.get(subscriber.email);
    const personalizedHtml = personalizeHtmlWithToken(subscriber.email, html, autologinCode);
    const sanitizedHtml = sanitizeJobUrls(personalizedHtml, validJobSlugs);

    // Per-user send-time (#3798): resolve this subscriber's effective
    // preferred hour (personal → global → none) and turn it into a concrete
    // UTC instant for the cascade's `scheduledAt`. The cascade itself decides
    // whether the chosen provider actually supports scheduling and returns
    // the authoritative `scheduledFor` on the send result (see persistSent).
    let scheduledAt = null;
    let sendTimeSource = null;
    // --test (mode==='test') is an operator verification send to a single
    // --target-email — it must land immediately so the operator can confirm
    // it works, not get deferred to some subscriber's preferred hour. Only
    // 'send' resolves scheduling for the real cascade; 'dry-run' also runs
    // this block (never sent) purely so its report can print the distribution
    // that a real 'send' run would produce — see logScheduleDistribution below.
    if ((mode === 'send' || mode === 'dry-run') && perUserSendTimeEnabled()) {
      const resolved = resolveEffectivePreferredHour({
        subscriberDoc: subscriber,
        globalHour: globalPreferredHour.hourUtc,
      });
      if (resolved.hourUtc !== null) {
        scheduledAt = computeScheduledSendAt({ preferredHourUtc: resolved.hourUtc, email: subscriber.email });
        sendTimeSource = resolved.source;
      }
    }
    scheduleTally[sendTimeSource || 'immediate'] += 1;

    emails.push({
      recipient: subscriber,
      // is_operator_verification (#3798 report accuracy): mode==='test' sends go to a
      // single --target-email for manual QA, not real subscriber traffic — flagged so
      // report-send-hour-impact.mjs can exclude them instead of miscounting them as
      // "immediate/pre-feature" sends.
      meta: { campaignId, subject, variant, sendTimeSource, segment: articleContent.segment, isOperatorVerification: mode === 'test' },
      payload: {
        from: FROM_EMAIL,
        to: [subscriber.email],
        subject,
        html: sanitizedHtml,
        headers: buildEmailHeaders(subscriber.email, campaignId),
        ...(scheduledAt ? { scheduledAt } : {}),
        tags: [
          { name: 'campaign_id', value: campaignId },
          { name: 'subscriber_locale', value: locale },
          { name: 'source_channel', value: subscriber.sourceChannel || 'newsletter_page' },
          { name: 'version', value: 'v2-ai-cohort' },
          // A/B subject variant — read by the Resend webhook (tags.variant) and
          // recomputed deterministically by scripts/newsletter-ab-report.mjs.
          { name: 'variant', value: variant },
        ],
      },
    });
  }

  console.log(`📅 Per-user send-time: ${scheduleTally.personal + scheduleTally.global} scheduled (personal=${scheduleTally.personal}, global=${scheduleTally.global}), ${scheduleTally.immediate} immediate`);

  console.log(`\n🧠 AI stats: ${aiSuccessCount} cohort briefings (${cohorts.size} cohorts), ${aiFallbackCount} fallbacks, ${subjectMap.size} subjects`);
  console.log(`📊 Savings: ${subscribers.length * 2} AI calls → ${aiSuccessCount + aiFallbackCount + subjectMap.size} (${Math.round((1 - (aiSuccessCount + aiFallbackCount + subjectMap.size) / (subscribers.length * 2)) * 100)}% reduction)`);

  // ── Inline QA check on first email ──
  if (emails.length > 0) {
    const samplePayload = emails[0].payload;
    const qaOk = inlineQaCheck(samplePayload.html, samplePayload.subject);
    if (!qaOk) {
      console.error('\u274c Inline QA failed — aborting send. Fix the issues and retry.');
      process.exit(1);
    }
  }

  // ── Resume tracking: skip already-sent subscribers ──
  // alreadySentForCampaign was fetched earlier (before issue number logic)
  const alreadySent = alreadySentForCampaign;
  let pendingEmails = emails;
  if (alreadySent.size > 0) {
    pendingEmails = emails.filter(e => !alreadySent.has(normalizeEmail(e.recipient.email)));
    console.log(`📋 Resume: ${alreadySent.size} already sent, ${pendingEmails.length} remaining`);
  }

  // ── Daily cap: limit to DAILY_SEND_LIMIT for production sends ──
  let cappedEmails = pendingEmails;
  if (mode === 'send' && pendingEmails.length > DAILY_SEND_LIMIT) {
    cappedEmails = pendingEmails.slice(0, DAILY_SEND_LIMIT);
    console.log(`⏱️  Daily cap: sending ${cappedEmails.length}/${pendingEmails.length} (limit: ${DAILY_SEND_LIMIT}/day). Run again tomorrow for the rest.`);
  }

  if (cappedEmails.length === 0) {
    console.log('\u2705 All subscribers already received this campaign. Nothing to send.');
    if (flushScores) await flushScores();
    return;
  }

  if (mode === 'dry-run') {
    const first = cappedEmails[0];
    console.log('🧪 Dry-run complete: no email provider called, no campaign send persisted.');
    console.log(`  recipients: ${cappedEmails.length}`);
    console.log(`  to: ${first?.payload?.to?.join(', ') || 'n/a'}`);
    console.log(`  subject: ${first?.payload?.subject || 'n/a'}`);
    console.log(`  matched jobs: ${subscriberData[0]?.matchedJobs?.map((job) => job.slug || job.title).join(', ') || 'none'}`);
    logScheduleDistribution(cappedEmails, {
      getScheduledAt: (item) => item.payload?.scheduledAt,
      getSource: (item) => item.meta?.sendTimeSource,
    });
    if (flushScores) await flushScores();
    return;
  }

  // ── Send ──
  const apiKey = process.env.RESEND_API_KEY;
  if (EMAIL_PROVIDER === 'resend' && !apiKey) {
    console.error('\u274c RESEND_API_KEY required');
    process.exit(1);
  }

  // Per-provider auto-promotion: once the cascade picks the provider, swap the
  // subject to that provider's winning variant (epsilon-greedy). The body HTML is
  // variant-independent, so only the subject + the `variant` tag change. Reads
  // everything from the self-describing payload so it can run inside the generic
  // cascade. Never throws → on any issue the assembly-time (global) variant stays.
  const finalizeForProvider = (payload, provider) => {
    try {
      const email = payload?.to?.[0];
      if (!email) return;
      const promoted = winners.byProvider[provider] ?? winners.global;
      if (!promoted) return; // nothing significant for this provider → keep default
      const loc = payload.tags?.find((t) => t.name === 'subscriber_locale')?.value || 'it';
      const variant = assignSubjectVariant(email, campaignId, { promotedVariant: promoted, epsilon: DEFAULT_EPSILON });
      payload.subject = subjectMap.get(subjectKey(loc, variant))
        || subjectMap.get(subjectKey(loc, variantIds[0]))
        || getVariantFallback(variant, loc);
      const vtag = payload.tags?.find((t) => t.name === 'variant');
      if (vtag) vtag.value = variant;
      else payload.tags?.push({ name: 'variant', value: variant });
    } catch { /* leave payload unchanged */ }
  };

  // ── Track only confirmed-sent emails for resume, as they are confirmed ──
  // `db` is optional in this script (fixture runs have none) — without it there
  // is nothing to resume from and nothing to record.
  const resume = db
    ? createResumeWriter(db, resumeLogOpts(campaignId), resumeChunkState(await fetchResumeChunkSizes(campaignId)))
    : null;
  const { sent, failed } = await sendEmailBatch(cappedEmails, finalizeForProvider, resume ? (email) => resume.record(email) : null);
  if (resume) await resume.flush();

  const totalForCampaign = alreadySent.size + sent.length;
  const totalSubscribers = emails.length;
  console.log(`\u2705 Newsletter: ${sent.length} sent, ${failed.length} failed today | ${totalForCampaign}/${totalSubscribers} total for campaign`);

  // Per-user send-time (#3798): the cascade already logs scheduled vs
  // immediate (logProviderSummary/sendEmailCascade); add the by-source split
  // here, reading the authoritative res.scheduledFor the cascade returned
  // (sent[i] === { ...item, ...result }, so .scheduledFor and .meta are both
  // present directly on each entry).
  if (sent.length > 0) {
    const bySource = { personal: 0, global: 0 };
    let scheduledSentCount = 0;
    for (const item of sent) {
      if (!item.scheduledFor) continue;
      scheduledSentCount += 1;
      const source = item.meta?.sendTimeSource;
      if (source && bySource[source] !== undefined) bySource[source] += 1;
    }
    console.log(`\ud83d\udcc5 Send-time breakdown: ${sent.length - scheduledSentCount} immediate, ${scheduledSentCount} scheduled (personal=${bySource.personal}, global=${bySource.global})`);
  }
  if (failed.length > 0) {
    console.log(`\u26a0\ufe0f  ${failed.length} emails failed — they will be retried on the next run.`);
  }
  if (totalForCampaign < totalSubscribers) {
    console.log(`\u23f3 ${totalSubscribers - totalForCampaign} remaining — run again tomorrow to continue.`);
  }

  const sampleSubject = emails[0]?.payload?.subject || 'N/A';
  await logSend(sent.length, sampleSubject, sent.length > 0 ? 'sent' : 'failed');

  // Track featured article for rotation — only persist on real sends, not test/preview.
  // Pre-2026-05-19 every test send polluted the article history; today's test mode
  // could push 12 entries and overwrite the whole window before any real send.
  if (mode === 'send' && sent.length > 0 && featuredArticle.persistRotation) {
    await featuredArticle.persistRotation();
  }

  // Track featured jobs for rotation — only persist on real sends, not test/preview
  if (mode === 'send' && sent.length > 0) {
    const shownSlugs = [...new Set(
      subscriberData.flatMap((sd) => sd.matchedJobs.map((j) => j.slug).filter(Boolean))
    )];
    await saveRecentlyFeaturedJobs(shownSlugs);
  }

  if (flushScores) await flushScores();
}

// Only run main() when executed directly — allows import for tests / dry-run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\u274c Fatal:', e); process.exit(1); });
}
