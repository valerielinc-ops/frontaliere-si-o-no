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
 *   node scripts/send-newsletter.mjs --test        # Send to admin email (with AI)
 *   node scripts/send-newsletter.mjs --send        # Send to all subscribers
 *   node scripts/send-newsletter.mjs --no-ai       # Skip AI generation (use fallbacks)
 *   node scripts/send-newsletter.mjs --digest-only # Only send to type='weekly_digest' subscribers
 *
 * Env vars (for --test/--send):
 *   RESEND_API_KEY, NEWSLETTER_SECRET, GEMINI_API_KEY or GH_MODELS_PAT,
 *   NEWSLETTER_EXPERIMENTAL_MODE=false, NEWSLETTER_ENABLE_SEND=true
 */

import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNewsletter, FEATURED_TOOLS, getFeaturedTools, nlNormLocale, directUrl } from '../services/newsletter-template.mjs';
import { matchJobsForSubscriber, validateJobUrls, buildBriefingPrompt, buildSubjectPrompt, FALLBACK_SUBJECT, getFallbackBriefing, loadDashboardMetrics, companyPageUrl } from '../services/newsletter-content.mjs';
import { selectFeaturedArticleId } from '../services/newsletter-article-rotation.mjs';
import { calculateEngagementScore, refreshEngagementScore } from '../functions/src/lib/engagementScore.js';
import { prioritizeSubscribers } from '../services/newsletter-priority.mjs';
import { filterFixtureJobs } from './lib/fixture-data-filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.resolve(ROOT, 'docs', 'newsletter-qa');
const BASE_URL = 'https://frontaliereticino.ch';
const ADMIN_EMAIL = 'luigisag@gmail.com';
const RESEND_ENDPOINT = 'https://api.resend.com/emails/batch';
const DEFAULT_FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || DEFAULT_FROM_EMAIL;
const BATCH_SIZE = 50;
const EXPERIMENTAL_MODE = process.env.NEWSLETTER_EXPERIMENTAL_MODE !== 'false';
const SEND_ENABLED = process.env.NEWSLETTER_ENABLE_SEND === 'true';
const AI_CONCURRENCY = 5; // Max parallel AI calls

// ── Email provider selection ──
// cascade = multi-provider free tier cascade (default)
// mailgun/mailjet/mailtrap = force a specific cascade provider
// resend = Resend only (legacy fallback)
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'cascade';
const SINGLE_PROVIDERS = ['mailgun', 'mailjet', 'mailtrap'];
const IS_SINGLE_PROVIDER = SINGLE_PROVIDERS.includes(EMAIL_PROVIDER);
// cascade/single = 350/day total (mailjet+unosend disabled), resend = 100
const DAILY_SEND_LIMIT = EMAIL_PROVIDER === 'resend' ? 100 : 350;

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
  return String(raw || '').trim().toLowerCase();
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
    a.initializeApp({ credential: a.credential.applicationDefault() });
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
const NEWSLETTER_AI_CHAIN = [
  'gemini-2.5-flash',           // Google — 1500 req/day free, fast
  'gemini-2.0-flash',           // Google — 1500 req/day free, reliable
  'gpt-4.1-nano',               // GitHub Models — proven workhorse in past sends
  'gemini-2.5-flash-lite',      // Google — 3000 req/day free, lightweight
  'gemma-4-31b-it',             // Google — 14,400 req/day free
  'gemma-4-26b-it',             // Google — 14,400 req/day free
  'mistral/mistral-small-latest', // Mistral — 1B tokens/month free
  'gemini-2.5-pro',             // Google — 500 req/day free, highest quality fallback
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
    // Company page slug is derived from company display name (mirrors build plugin logic)
    const companySlug = j.company ? slugifyCompanyName(j.company) : '';
    const companyUrl = companyPageUrl(companySlug, locale);

    let foundTitle = false;

    // For each name: strip any existing <a> wrapping (AI may have used wrong URLs),
    // then strip <strong>, then inject correct link.
    if (j.title) {
      const titleEsc = j.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`<a[^>]*>\\s*(${titleEsc})\\s*</a>`, 'gi'), '$1');
      html = html.replace(new RegExp(`<strong>(${titleEsc})</strong>`, 'gi'), '$1');
      if (jobUrl && appearsInText(html, titleEsc)) {
        html = replaceOutsideTags(html, titleEsc, 'i', (m) => `<a href="${jobUrl}" style="${linkStyle}">${m}</a>`);
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
          html = replaceOutsideTags(html, nameEsc, 'i', (m) => `<a href="${companyUrl}" style="${linkStyle}">${m}</a>`);
          companyLinked = true;
        }
      }
    }

    // Collect snippet for fallback paragraph if title wasn't found in AI text
    if (!foundTitle && jobUrl && j.title) {
      const titleLink = `<a href="${jobUrl}" style="${linkStyle}">${j.title}</a>`;
      const companyPart = j.company && companyUrl
        ? ` ${i18n.at} <a href="${companyUrl}" style="${linkStyle}">${j.company}</a>`
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
      return `<a href="${absUrl}" style="${linkStyle}">${match}</a>`;
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
    // Ensure subject is a complete sentence — never truncate with ellipsis
    if (raw.length > 55) {
      // Too long — ask AI failed to respect limit, use as-is up to 55
      // Find last natural break point (space, comma, colon) before 55
      const cutoff = raw.lastIndexOf(' ', 55);
      return cutoff > 30 ? raw.slice(0, cutoff) : raw.slice(0, 55);
    }
    return raw;
  } catch (e) {
    console.warn('\u26a0\ufe0f AI subject failed:', e.message?.slice(0, 200));
    return null;
  }
}

// ─── Unsubscribe / Auth URLs ────────────────────────────────

function makeUnsubscribeUrl(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return `${BASE_URL}/?action=unsubscribe&email=${encodeURIComponent(email)}`;
  const token = createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
  return `${BASE_URL}/?action=unsubscribe&email=${encodeURIComponent(email)}&token=${token}`;
}

function makeResubscribeUrl(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return `${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(email)}`;
  const token = createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
  return `${BASE_URL}/?action=resubscribe&email=${encodeURIComponent(email)}&token=${token}`;
}

function makePreferencesUrl(email, locale = 'it') {
  const secret = process.env.NEWSLETTER_SECRET;
  const slug = PREFERENCES_SLUG[locale] || PREFERENCES_SLUG.it;
  const prefix = localePathPrefix(locale);
  const base = `${BASE_URL}${prefix}/${slug}?email=${encodeURIComponent(email.toLowerCase())}`;
  if (!secret) return base;
  const token = createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
  return `${base}&token=${token}`;
}

// Generate a deterministic HMAC-based autologin code for a subscriber.
// Unlike Firebase custom tokens (which expire in 1 hour), this code never
// expires — the client exchanges it for a fresh token via Cloud Function.
function generateAutologinCode(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update('autologin:' + email.toLowerCase().trim())
    .digest('hex');
}

function makeAuthenticatedUrl(targetUrl, email, autologinCode) {
  const url = new URL(targetUrl, BASE_URL);
  // Short param names keep total URL < 1000 chars — Mailgun silently
  // skips click-tracking for href values ≥ 1000 characters.
  url.searchParams.set('ne', email.toLowerCase());
  // 'ac' = autologin code (64-char HMAC hex, never expires)
  if (autologinCode) url.searchParams.set('ac', autologinCode);
  // GA4 "Email" channel: utm_medium matching "newsletter" is sufficient
  url.searchParams.set('utm_medium', 'newsletter');
  return url.toString();
}

function shouldWrapNewsletterHref(rawHref) {
  if (!rawHref) return false;
  if (rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('#')) return false;
  let url;
  try { url = new URL(rawHref, BASE_URL); } catch { return false; }
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'frontaliereticino.ch') return false;
  if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/icons/')) return false;
  return true;
}

async function personalizeHtmlForRecipient(email, html) {
  const hrefMatches = [...html.matchAll(/href="([^"]+)"/g)];
  if (!hrefMatches.length) return html;

  // Generate ONE HMAC autologin code per subscriber (reused for all links, never expires)
  const autologinCode = generateAutologinCode(email);

  const replacements = new Map();
  const uniqueHrefs = [...new Set(hrefMatches.map((m) => m[1]).filter(shouldWrapNewsletterHref))];
  for (const href of uniqueHrefs) {
    const wrapped = makeAuthenticatedUrl(href, email, autologinCode);
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
    const wrapped = makeAuthenticatedUrl(href, email, autologinCode);
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

async function fetchTopArticles() {
  try {
    const snap = await db.collection('article_views').orderBy('views', 'desc').limit(10).get();
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

// Capture group for a single-quoted string literal that allows escaped chars
// (e.g. `'L\'incertezza...'`). The previous `'([^']*)'` truncated at the
// first `\'` so excerpts containing apostrophes were cut to their first
// character.
const QUOTED_RE_SRC = `'((?:\\\\.|[^'\\\\])*)'`;

function unescapeJsString(s) {
  return s.replace(/\\(.)/g, (_m, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/**
 * Resolve an article ID to its localized slug from routerBlogData.ts.
 * Falls back to the article ID itself if the slug map can't be read.
 */
function getBlogSlug(articleId, locale = 'it') {
  try {
    const rdPath = new URL('../services/routerBlogData.ts', import.meta.url);
    const raw = fs.readFileSync(rdPath, 'utf8');
    const escaped = articleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Try requested locale first, fall back to Italian
    for (const lang of [locale, 'it']) {
      const regex = new RegExp(`'${escaped}':\\s*\\{[^}]*?${lang}:\\s*${QUOTED_RE_SRC}`);
      const match = raw.match(regex);
      if (match) return unescapeJsString(match[1]);
    }
    return articleId;
  } catch {
    return articleId;
  }
}

/**
 * Load localized blog metadata for a given article ID.
 * Returns { title, excerpt } or null if not found.
 * Falls back to Italian if the requested locale file doesn't exist or lacks the article.
 */
function loadBlogMeta(articleId, locale = 'it') {
  for (const lang of [locale, 'it']) {
    try {
      const metaPath = new URL(`../services/locales/blog-meta-${lang}.ts`, import.meta.url);
      const raw = fs.readFileSync(metaPath, 'utf8');
      const titleKey = `blog.article.${articleId}.title`;
      const excerptKey = `blog.article.${articleId}.excerpt`;
      const titleMatch = raw.match(new RegExp(`'${titleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*${QUOTED_RE_SRC}`));
      const excerptMatch = raw.match(new RegExp(`'${excerptKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*${QUOTED_RE_SRC}`));
      if (titleMatch) {
        return {
          title: unescapeJsString(titleMatch[1]),
          excerpt: excerptMatch ? unescapeJsString(excerptMatch[1]) : '',
        };
      }
    } catch {
      // Try next locale
    }
  }
  console.warn(`\u26a0\ufe0f Blog meta not found for "${articleId}" in ${locale}/it`);
  return null;
}

/** Blog section URL path per locale (matches router.ts SLUG_TABLES) */
const BLOG_SECTION_PATH = { it: 'articoli-frontaliere', en: 'cross-border-articles', de: 'grenzgaenger-artikel', fr: 'articles-frontalier' };

/** Newsletter preferences slug per locale (matches router.ts SLUG_TABLES) */
const PREFERENCES_SLUG = {
  it: 'preferenze-newsletter',
  en: 'newsletter-preferences',
  de: 'newsletter-einstellungen',
  fr: 'preferences-newsletter',
};

/** Build the locale URL prefix — empty for IT (canonical), `/{lang}` otherwise. */
function localePathPrefix(locale) {
  return locale === 'it' ? '' : `/${locale}`;
}

const DEFAULT_ARTICLE_ID = 'comuni-migliori-frontalieri';

/**
 * Build a localized article object for a given article ID and locale.
 */
function localizeArticle(articleId, locale) {
  const blogPath = BLOG_SECTION_PATH[locale] || BLOG_SECTION_PATH.it;
  const slug = getBlogSlug(articleId, locale);
  const meta = loadBlogMeta(articleId, locale);
  if (!meta) return null;
  const prefix = localePathPrefix(locale);
  return {
    title: meta.title,
    excerpt: meta.excerpt,
    url: `${prefix}/${blogPath}/${slug}/`,
    badge: true,
  };
}

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
  const MAX_HISTORY = 12; // exclude last 12 articles → ~3 months of variety with weekly sends
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
const MAX_FEATURED_JOBS_HISTORY = 8; // 2 weeks \u00d7 4 cards = 8 slots

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
      const hasMeta = (id) => !!loadBlogMeta(id, 'it');
      const pick = selectFeaturedArticleId(topArticles, recentlyFeatured, hasMeta);
      if (pick.id) {
        bestId = pick.id;
        const best = topArticles.find((a) => a.id === pick.id);
        const rotated = pick.reason === 'fresh' ? '' : ' (rotation exhausted, reusing)';
        console.log(`\ud83d\udcf0 Featured article: "${pick.id}" (${best?.views ?? '?'} views)${rotated}`);
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

  // Match all locale variants of the job board path
  const boardSegment = '(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)';
  const re = new RegExp(`href="([^"]*\\/${boardSegment}\\/([^/"?#]+)\\/?[^"]*)"`, 'g');

  return html.replace(re, (fullMatch, fullUrl, board, slug) => {
    // Strip query params and trailing slash from slug for comparison
    const cleanSlug = slug.replace(/\/$/, '');
    // Company pages (azienda-*) are valid — don't strip them
    if (cleanSlug.startsWith('azienda-')) return fullMatch;
    if (validSlugs.has(cleanSlug)) return fullMatch;

    console.warn(`⚠️  Broken job URL removed from newsletter: ${cleanSlug}`);
    const prefix = fullUrl.split(`/${board}/`)[0];
    return `href="${prefix}/${board}/"`;
  });
}

// ─── Subscriber fetching ────────────────────────────────────

const EXCLUDED_STATUSES = new Set(['unsubscribed', 'bounced', 'complained', 'suppressed']);

async function fetchSubscribers() {
  const subscribers = new Map();

  try {
    // Fetch ALL subscribers (including pending) — clicking a link auto-confirms them.
    // Exclude only those who explicitly opted out or have delivery issues.
    const snap = await db.collection('newsletter_subscribers').get();
    snap.docs.forEach((d) => {
      if (d.id === '_meta_') return;
      const row = d.data();
      const email = normalizeEmail(row.email);
      if (!email) return;
      const status = (row.status || '').toLowerCase();
      if (EXCLUDED_STATUSES.has(status)) return;
      // Belt-and-suspenders: also exclude if unsubscribedAt is set (frontend handler bug backfill)
      if (row.unsubscribedAt || row.unsubscribed_at) return;
      // Recompute engagement on-the-fly from raw counters — Firestore engagement_score
      // is partially stale (FRO-17 bug fixed in webhooks; pre-existing rows lag).
      const fresh = calculateEngagementScore(row);
      subscribers.set(email, {
        email,
        locale: (row.preferred_locale || row.locale || 'it').split(/[-_]/)[0] || 'it',
        sourceChannel: row.source_channel || row.source || 'newsletter_page',
        locationInterest: row.location_interest || null,
        sectorInterest: row.sector_interest || null,
        job_slug: row.job_slug || null,
        job_company: row.job_company || null,
        source: row.source || null,
        preferences: row.preferences || {},
        type: row.type || null,
        // Default true: only skip autologin if user explicitly opted out
        autologinEnabled: row.autologin_enabled !== false,
        createdAt: row.createdAt?.toDate?.() || (row.created_at ? new Date(row.created_at) : null),
        // Engagement metadata used for prioritized send order
        sendCount: Number(row.send_count || row.sendCount) || 0,
        engagementScore: fresh.score,
        engagementLevel: fresh.level,
      });
    });
  } catch (e) {
    console.warn('\u26a0\ufe0f Subscriber fetch failed:', e.message);
  }

  // user_profiles collection removed — all subscriber data is in newsletter_subscribers

  return prioritizeSubscribers([...subscribers.values()]);
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
    'List-Unsubscribe': `<${makeUnsubscribeUrl(email)}>, <${makeMailtoUnsubscribe(email)}>`,
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
 * Fetch emails already sent for this campaign from Firestore.
 * Reads the _meta_ campaign log to find sent recipients.
 */
async function fetchAlreadySent(campaignId) {
  if (!db) return new Set();
  try {
    const metaRef = db.collection('newsletter_subscribers').doc('_meta_');
    const snap = await metaRef.collection('campaign_sends').doc(campaignId).get();
    if (!snap.exists) return new Set();
    const data = snap.data();
    return new Set(data.sentEmails || []);
  } catch (e) {
    console.warn('\u26a0\ufe0f Campaign resume fetch failed:', e?.message);
    return new Set();
  }
}

/**
 * Persist the list of sent emails for this campaign (append, not replace).
 */
async function persistCampaignSends(campaignId, newlySentEmails) {
  if (!db || !newlySentEmails.length) return;
  const FieldValue = adminSdk?.firestore?.FieldValue;
  try {
    const metaRef = db.collection('newsletter_subscribers').doc('_meta_');
    const docRef = metaRef.collection('campaign_sends').doc(campaignId);
    await docRef.set({
      sentEmails: FieldValue ? FieldValue.arrayUnion(...newlySentEmails) : newlySentEmails,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
  } catch (e) {
    console.warn('\u26a0\ufe0f Campaign send tracking failed:', e?.message);
  }
}

// ─── Resend API ─────────────────────────────────────────────

async function persistDelivery(recipient, messageId, meta) {
  if (!db) return;
  const FieldValue = adminSdk?.firestore?.FieldValue;
  try {
    const email = normalizeEmail(recipient.email);
    const subRef = db.collection('newsletter_subscribers').doc(email);
    const deliveryDocId = `${meta.campaignId}__${email}`.replace(/[^a-z0-9@._-]+/gi, '-');
    // Store delivery as a subcollection under the subscriber doc
    await subRef.collection('campaign_deliveries').doc(deliveryDocId).set({
      campaign_id: meta.campaignId,
      message_id: messageId || null,
      locale: recipient.locale || 'it',
      source_channel: recipient.sourceChannel || null,
      location_interest: recipient.locationInterest || null,
      sector_interest: recipient.sectorInterest || null,
      sent_at: new Date(),
    }, { merge: true });
    // Update subscriber-level counters
    await subRef.set({
      last_sent_at: new Date(),
      send_count: FieldValue ? FieldValue.increment(1) : 1,
      updated_at: new Date(),
    }, { merge: true });
    // Refresh engagement score after counter changes (FRO-17). Belt-and-suspenders
    // alongside the ESP webhook recompute, so the persisted score stays fresh
    // even if a webhook delivery is lost.
    if (FieldValue) {
      await refreshEngagementScore(subRef, FieldValue);
    }
  } catch (e) {
    console.warn('\u26a0\ufe0f Delivery persist failed:', e?.message);
  }
}

async function sendEmailBatchResend(emails, apiKey) {
  if (!emails.length) return { sent: [], failed: [] };
  const batches = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    batches.push(emails.slice(i, i + BATCH_SIZE));
  }

  const sent = [];
  const failed = [];

  for (const batch of batches) {
    let res;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(batch.map((e) => e.payload)),
      });
    } catch (netErr) {
      console.error(`\u274c Network error: ${netErr.message}`);
      failed.push(...batch);
      continue;
    }

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`\u274c Resend batch error: ${res.status} ${err.slice(0, 300)}`);
      // On 429 (rate limit), stop sending — remaining emails go to failed
      if (res.status === 429) {
        console.warn('\u26a0\ufe0f  Rate limited — stopping. Remaining emails will be retried next run.');
        failed.push(...batch);
        // Also add all subsequent batches to failed
        const currentIdx = batches.indexOf(batch);
        for (let j = currentIdx + 1; j < batches.length; j++) failed.push(...batches[j]);
        break;
      }
      failed.push(...batch);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    const results = data?.data || [];

    // Match each email with its Resend response to know exactly which succeeded
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const result = results[i];
      const msgId = result?.id || null;

      if (msgId) {
        sent.push(item);
        await persistDelivery(item.recipient, msgId, item.meta);
      } else {
        // Resend returned no ID for this email — treat as failed
        failed.push(item);
      }
    }

    console.log(`\u2705 Batch: ${batch.length} sent (${sent.length} confirmed so far)`);
  }

  return { sent, failed };
}


async function sendEmailBatch(emails, apiKey) {
  // Single provider mode: force a specific provider via cascade
  if (IS_SINGLE_PROVIDER) {
    console.log(`📧 Sending via ${EMAIL_PROVIDER} only (${emails.length} emails)`);
    const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
    const result = await sendEmailCascade(emails, {
      concurrency: 1,
      delayMs: 1000,
      forceProvider: EMAIL_PROVIDER,
      onSent: async (item, res) => {
        await persistDelivery(item.recipient, res.messageId, { ...item.meta, provider: res.provider });
      },
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
      onSent: async (item, res) => {
        await persistDelivery(item.recipient, res.messageId, { ...item.meta, provider: res.provider });
      },
    });
    logProviderSummary();
    return result;
  }
  // Resend (legacy fallback)
  if (!apiKey) {
    console.error('❌ No email provider configured (need API keys in Remote Config)');
    return { sent: [], failed: emails };
  }
  console.log(`📧 Sending via Resend (${emails.length} emails)`);
  return sendEmailBatchResend(emails, apiKey);
}

// ─── Issue number (real campaign count) ─────────────────────

async function getNextIssueNumber() {
  if (!db) return null;
  try {
    const data = await readMetaDoc();
    const current = data.issue_number || 0;
    const next = current + 1;
    await writeMetaDoc({ issue_number: next });
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

  // Job links (at least one job board link, any locale)
  const jobBoardRe = /(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)/;
  if (!jobBoardRe.test(sampleHtml)) fail('job_links', 'No job links found in HTML');
  else pass('job_links');

  // No raw template variables
  if (/\{\{[^}]+\}\}/.test(sampleHtml)) fail('no_template_vars', 'Unresolved {{template}} variables');
  else pass('no_template_vars');

  // Unsubscribe URL with action param
  if (!sampleHtml.includes('action=unsubscribe')) fail('unsubscribe_url', 'Missing ?action=unsubscribe URL');
  else pass('unsubscribe_url');

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
    : args.includes('--test') ? 'test'
    : 'preview';
  const noAI = args.includes('--no-ai');
  const digestOnly = args.includes('--digest-only');
  const targetEmail = readArgValue('--target-email');
  const subjectOverride = readArgValue('--subject');

  console.log(`\ud83d\udce7 Newsletter v2 | mode: ${mode} | AI: ${!noAI} | digestOnly: ${digestOnly}`);

  const wouldSend = mode === 'send' || mode === 'test';
  if (wouldSend && (EXPERIMENTAL_MODE || !SEND_ENABLED)) {
    console.error('\ud83d\uded1 Invio bloccato: NEWSLETTER_EXPERIMENTAL_MODE o NEWSLETTER_ENABLE_SEND non configurati.');
    process.exit(1);
  }

  // QA gate: production send requires a passing QA report from today
  if (mode === 'send') {
    enforceQaGate();
  }

  // Init Firebase (required for test/send)
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
  const issueNumber = isResume ? null : await getNextIssueNumber();
  if (issueNumber) console.log(`📰 Issue #${issueNumber}`);
  if (isResume) console.log(`🔄 Resuming campaign ${campaignId} (${alreadySentForCampaign.size} already sent)`);

  // ── Preview mode ──
  if (mode === 'preview') {
    const locale = 'it';
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

    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs: previewJobs,
      totalJobs: jobs.length,
      article: featuredArticle(locale),
      featuredTool: previewFeaturedTool,
      weeklyFact: getWeeklyFact(locale),
      metrics: loadDashboardMetrics(),
      locale,
      issueNumber,
      unsubscribeUrl: `${BASE_URL}/?action=unsubscribe&email=preview@example.com`,
      resubscribeUrl: `${BASE_URL}/?action=resubscribe&email=preview@example.com`,
    });
    process.stdout.write(html);
    if (flushScores) await flushScores();
    return;
  }

  // ── Fetch subscribers ──
  let subscribers;
  if (mode === 'test') {
    subscribers = [{
      email: targetEmail || ADMIN_EMAIL,
      locale: 'it',
      sourceChannel: 'newsletter_page',
      locationInterest: null,
      sectorInterest: null,
      preferences: { jobs: true, taxUpdates: true },
    }];
    console.log(`\ud83d\udce8 Test mode: ${subscribers[0].email}`);
  } else {
    subscribers = await fetchSubscribers();
    console.log(`\ud83d\udce8 Send mode: ${subscribers.length} active subscribers`);

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
  const subscriberData = subscribers.map((subscriber) => {
    const locale = nlNormLocale(subscriber.locale);
    const subscriberAlerts = allJobAlerts.get((subscriber.email || '').toLowerCase()) || [];
    const rawMatched = matchJobsForSubscriber(subscriber, jobs, 4, locale, recentlyFeaturedJobs);
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

  // ── Phase 2: Generate 1 AI briefing per cohort (parallel) ──
  console.log('🧠 Phase 2: AI briefings (1 per cohort, parallel)...');
  const cohortEntries = [...cohorts.entries()];
  const briefingResults = noAI
    ? cohortEntries.map(([key, c]) => [key, getFallbackBriefing(c.locale, exchangeRate)])
    : await pMap(cohortEntries, async ([key, cohort]) => {
        const briefing = await generateAIBriefing({
          subscriber: cohort.subscriber,
          exchangeRate, exchangeInsight,
          matchedJobs: cohort.matchedJobs,
          weeklyFact: getWeeklyFact(cohort.locale),
          featuredTool: getFeaturedToolForLocale(cohort.locale),
        });
        return [key, briefing];
      }, AI_CONCURRENCY);

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

  // ── Phase 3: Generate 1 AI subject per locale ──
  console.log('✏️  Phase 3: AI subjects (1 per locale)...');
  const locales = [...new Set(subscriberData.map(d => d.locale))];
  const subjectMap = new Map();

  if (subjectOverride) {
    for (const loc of locales) subjectMap.set(loc, subjectOverride);
  } else if (noAI) {
    for (const loc of locales) subjectMap.set(loc, FALLBACK_SUBJECT[loc] || FALLBACK_SUBJECT.it);
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

    await pMap(locales, async (loc) => {
      const rep = localeRepresentatives.get(loc);
      const briefingText = rep?.briefing?.replace(/<[^>]+>/g, '').slice(0, 100) || '';
      const subject = await generateAISubject({
        subscriber: rep?.subscriber || { locale: loc },
        exchangeRate,
        matchedJobs: rep?.matchedJobs || [],
        briefingSummary: briefingText,
      });
      subjectMap.set(loc, subject || FALLBACK_SUBJECT[loc] || FALLBACK_SUBJECT.it);
    }, locales.length); // All locale subjects in parallel (max 4)
  }
  console.log(`  ✓ ${subjectMap.size} subjects: ${[...subjectMap.entries()].map(([l, s]) => `${l}="${s}"`).join(', ')}`);

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

  for (const { subscriber, locale, matchedJobs, cohortKey } of subscriberData) {
    const briefing = briefingMap.get(cohortKey);
    const subject = subjectMap.get(locale);

    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs,
      totalJobs: jobs.length,
      article: featuredArticle(locale),
      featuredTool: getFeaturedToolForLocale(locale),
      weeklyFact: getWeeklyFact(locale),
      metrics,
      locale,
      issueNumber,
      unsubscribeUrl: makeUnsubscribeUrl(subscriber.email),
      resubscribeUrl: makeResubscribeUrl(subscriber.email),
      preferencesUrl: makePreferencesUrl(subscriber.email, locale),
    });

    // Personalize links with pre-generated HMAC autologin code (never expires)
    const autologinCode = codeMap.get(subscriber.email);
    const personalizedHtml = personalizeHtmlWithToken(subscriber.email, html, autologinCode);
    const sanitizedHtml = sanitizeJobUrls(personalizedHtml, validJobSlugs);

    emails.push({
      recipient: subscriber,
      meta: { campaignId },
      payload: {
        from: FROM_EMAIL,
        to: [subscriber.email],
        subject,
        html: sanitizedHtml,
        headers: buildEmailHeaders(subscriber.email, campaignId),
        tags: [
          { name: 'campaign_id', value: campaignId },
          { name: 'subscriber_locale', value: locale },
          { name: 'source_channel', value: subscriber.sourceChannel || 'newsletter_page' },
          { name: 'version', value: 'v2-ai-cohort' },
        ],
      },
    });
  }

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

  // ── Send ──
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('\u274c RESEND_API_KEY required');
    process.exit(1);
  }

  const { sent, failed } = await sendEmailBatch(cappedEmails, apiKey);

  // ── Track only confirmed-sent emails for resume ──
  const sentEmailList = sent.map(e => normalizeEmail(e.recipient.email));
  await persistCampaignSends(campaignId, sentEmailList);

  const totalForCampaign = alreadySent.size + sent.length;
  const totalSubscribers = emails.length;
  console.log(`\u2705 Newsletter: ${sent.length} sent, ${failed.length} failed today | ${totalForCampaign}/${totalSubscribers} total for campaign`);
  if (failed.length > 0) {
    console.log(`\u26a0\ufe0f  ${failed.length} emails failed — they will be retried on the next run.`);
  }
  if (totalForCampaign < totalSubscribers) {
    console.log(`\u23f3 ${totalSubscribers - totalForCampaign} remaining — run again tomorrow to continue.`);
  }

  const sampleSubject = emails[0]?.payload?.subject || 'N/A';
  await logSend(sent.length, sampleSubject, sent.length > 0 ? 'sent' : 'failed');

  // Track featured article for rotation (avoid repeating same article next week)
  if (sent.length > 0 && featuredArticle.persistRotation) {
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
