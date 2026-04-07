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
 *
 * Env vars (for --test/--send):
 *   RESEND_API_KEY, NEWSLETTER_SECRET, GEMINI_API_KEY or GH_MODELS_PAT,
 *   NEWSLETTER_EXPERIMENTAL_MODE=false, NEWSLETTER_ENABLE_SEND=true
 */

import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNewsletter, FEATURED_TOOLS, nlNormLocale, directUrl } from '../services/newsletter-template.mjs';
import { matchJobsForSubscriber, validateJobUrls, buildBriefingPrompt, buildSubjectPrompt, FALLBACK_SUBJECT, getFallbackBriefing, loadDashboardMetrics } from '../services/newsletter-content.mjs';

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

async function generateAIBriefing(ctx) {
  if (!callLLM) return null;
  try {
    const { system, user } = buildBriefingPrompt(ctx);
    const result = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.7, maxTokens: 500 });
    // Clean up: ensure it has <p> tags
    const cleaned = result.trim();
    if (!cleaned.startsWith('<p>')) return `<p>${cleaned.replace(/\n\n/g, '</p><p>')}</p>`;
    return cleaned;
  } catch (e) {
    console.warn('\u26a0\ufe0f AI briefing failed:', e.message?.slice(0, 200));
    return null;
  }
}

async function generateAISubject(ctx) {
  if (!callLLM) return null;
  try {
    const { system, user } = buildSubjectPrompt(ctx);
    const result = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.8, maxTokens: 80 });
    const raw = result.trim().replace(/^["']|["']$/g, '');
    // Hard cap at 50 chars to prevent truncation in email clients
    const subject = raw.length > 50 ? raw.slice(0, 47) + '...' : raw;
    return subject || null;
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

async function getOrCreateCustomToken(email) {
  try {
    const admin = await import('firebase-admin');
    const a = admin.default || admin;
    const normalizedEmail = email.toLowerCase();
    let uid;
    try {
      const userRecord = await a.auth().getUserByEmail(normalizedEmail);
      uid = userRecord.uid;
    } catch {
      const newUser = await a.auth().createUser({ email: normalizedEmail, emailVerified: true });
      uid = newUser.uid;
    }
    return await a.auth().createCustomToken(uid);
  } catch (error) {
    console.warn(`\u26a0\ufe0f Custom token failed for ${email}:`, error?.message || error);
    return null;
  }
}

function makeAuthenticatedUrl(targetUrl, email, customToken) {
  const url = new URL(targetUrl, BASE_URL);
  url.searchParams.set('newsletter_email', email.toLowerCase());
  url.searchParams.set('newsletter_autologin', '1');
  url.searchParams.set('newsletter_source', 'weekly');
  url.searchParams.set('subscriber_key', hashEmail(email));
  if (customToken) url.searchParams.set('authToken', customToken);
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

  // Generate ONE custom token per subscriber (reused for all links)
  const customToken = await getOrCreateCustomToken(email);

  const replacements = new Map();
  const uniqueHrefs = [...new Set(hrefMatches.map((m) => m[1]).filter(shouldWrapNewsletterHref))];
  for (const href of uniqueHrefs) {
    const wrapped = makeAuthenticatedUrl(href, email, customToken);
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

/**
 * Resolve an article ID to its localized Italian slug from routerBlogData.ts.
 * Falls back to the article ID itself if the slug map can't be read.
 */
function getItalianBlogSlug(articleId) {
  try {
    const rdPath = new URL('../services/routerBlogData.ts', import.meta.url);
    const raw = fs.readFileSync(rdPath, 'utf8');
    const regex = new RegExp(`'${articleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{\\s*it:\\s*'([^']*)'`);
    const match = raw.match(regex);
    return match ? match[1] : articleId;
  } catch {
    return articleId;
  }
}

/**
 * Load Italian blog metadata for a given article ID.
 * Returns { title, excerpt } or null if not found.
 */
function loadBlogMeta(articleId) {
  try {
    const metaPath = new URL('../services/locales/blog-meta-it.ts', import.meta.url);
    const raw = fs.readFileSync(metaPath, 'utf8');
    const titleKey = `blog.article.${articleId}.title`;
    const excerptKey = `blog.article.${articleId}.excerpt`;
    const titleMatch = raw.match(new RegExp(`'${titleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*'([^']*)'`));
    const excerptMatch = raw.match(new RegExp(`'${excerptKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*'([^']*)'`));
    if (!titleMatch) return null;
    return {
      title: titleMatch[1],
      excerpt: excerptMatch ? excerptMatch[1] : '',
    };
  } catch (e) {
    console.warn('\u26a0\ufe0f Blog meta load failed:', e.message);
    return null;
  }
}

/**
 * Pick the best featured article for the newsletter.
 * Uses Firestore article_views (most viewed this week), falls back to hardcoded default.
 */
async function pickFeaturedArticle() {
  const DEFAULT_ARTICLE = {
    title: 'I 10 migliori comuni per frontalieri',
    excerpt: 'Classifica dei comuni italiani di frontiera: affitti, IRPEF comunale, distanza dal confine.',
    url: `/articoli-frontaliere/${getItalianBlogSlug('comuni-migliori-frontalieri')}`,
    badge: '🔥 Più letto',
  };

  if (!db) return DEFAULT_ARTICLE;

  try {
    const topArticles = await fetchTopArticles();
    if (topArticles.length === 0) return DEFAULT_ARTICLE;

    // Prefer articles viewed in the last 7 days, sorted by views
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentTop = topArticles
      .filter((a) => a.lastViewed && a.lastViewed > weekAgo)
      .sort((a, b) => b.views - a.views);

    const best = recentTop[0] || topArticles[0];
    const meta = loadBlogMeta(best.id);
    if (!meta) {
      console.warn(`\u26a0\ufe0f No blog meta for top article "${best.id}", using default`);
      return DEFAULT_ARTICLE;
    }

    console.log(`\ud83d\udcf0 Featured article: "${best.id}" (${best.views} views)`);
    return {
      title: meta.title,
      excerpt: meta.excerpt,
      url: `/articoli-frontaliere/${getItalianBlogSlug(best.id)}`,
      badge: '\ud83d\udd25 Più letto',
    };
  } catch (e) {
    console.warn('\u26a0\ufe0f Featured article pick failed:', e.message);
    return DEFAULT_ARTICLE;
  }
}

function getWeeklyFact() {
  const EPOCH = new Date('2025-01-06').getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekIndex = Math.floor((Date.now() - EPOCH) / WEEK_MS) % 52;
  const FACTS = [
    { text: 'In Svizzera, il salario mediano \u00e8 di circa 6.665 CHF al mese (2022).', source: 'UST' },
    { text: 'Oltre 78.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' },
    { text: 'La franchigia per i nuovi frontalieri dal 2024 \u00e8 di \u20ac10.000.', source: 'Nuovo Accordo Fiscale' },
    { text: 'Il tasso di disoccupazione in Ticino \u00e8 circa il 2.3%.', source: 'SECO' },
    { text: "L'AVS (1\u00b0 pilastro) copre circa il 40% del reddito pre-pensionamento.", source: 'BSV' },
    { text: 'Il 3\u00b0 pilastro 3a permette di dedurre fino a 7.258 CHF (2026) dalle tasse.', source: 'Admin.ch' },
  ];
  return FACTS[weekIndex % FACTS.length];
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

  return { jobs, jobStats };
}

/**
 * Scan final HTML for job URLs and replace broken ones (slug not in validSlugs)
 * with the generic job board URL. Prevents 404s in sent newsletters.
 */
function sanitizeJobUrls(html, validSlugs) {
  if (!validSlugs || validSlugs.size === 0) return html;

  return html.replace(
    /href="([^"]*\/cerca-lavoro-ticino\/([^/"?#]+)\/?[^"]*)"/g,
    (fullMatch, fullUrl, slug) => {
      // Strip query params and trailing slash from slug for comparison
      const cleanSlug = slug.replace(/\/$/, '');
      if (validSlugs.has(cleanSlug)) return fullMatch;

      console.warn(`⚠️  Broken job URL removed from newsletter: ${cleanSlug}`);
      return `href="${fullUrl.split('/cerca-lavoro-ticino/')[0]}/cerca-lavoro-ticino/"`;
    },
  );
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
      const row = d.data();
      const email = normalizeEmail(row.email);
      if (!email) return;
      const status = (row.status || '').toLowerCase();
      if (EXCLUDED_STATUSES.has(status)) return;
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
      });
    });
  } catch (e) {
    console.warn('\u26a0\ufe0f Subscriber fetch failed:', e.message);
  }

  // user_profiles collection removed — all subscriber data is in newsletter_subscribers

  return [...subscribers.values()];
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
    'List-ID': `Frontaliere Weekly <weekly.frontaliereticino.ch>`,
    'Feedback-ID': `${campaignKey}:frontaliere-weekly:frontaliere-ticino`,
    'X-Entity-Ref-ID': `${campaignKey}-${emailKey}`,
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
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
  } catch (e) {
    console.warn('\u26a0\ufe0f Delivery persist failed:', e?.message);
  }
}

async function sendEmailBatch(emails, apiKey) {
  if (!emails.length) return 0;
  const batches = [];
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    batches.push(emails.slice(i, i + BATCH_SIZE));
  }

  let totalSent = 0;
  for (const batch of batches) {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(batch.map((e) => e.payload)),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`\u274c Resend batch error: ${res.status} ${err.slice(0, 300)}`);
    } else {
      const data = await res.json().catch(() => ({}));
      totalSent += batch.length;
      console.log(`\u2705 Sent batch: ${batch.length} emails`);
      // Persist deliveries
      await Promise.all(batch.map(async (item, i) => {
        const msgId = data?.data?.[i]?.id || null;
        await persistDelivery(item.recipient, msgId, item.meta);
      }));
    }
  }
  return totalSent;
}

// ─── Issue number (real campaign count) ─────────────────────

async function getNextIssueNumber() {
  if (!db) return null;
  try {
    const metaRef = db.collection('newsletter_subscribers').doc('_meta_');
    const doc = await metaRef.get();
    const current = doc.exists ? (doc.data().issue_number || 0) : 0;
    const next = current + 1;
    await metaRef.set({ issue_number: next }, { merge: true });
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
function enforceQaGate() {
  if (process.env.NEWSLETTER_SKIP_QA_GATE === 'true') {
    console.warn('\u26a0\ufe0f  QA gate skipped (NEWSLETTER_SKIP_QA_GATE=true) — proceed with caution.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const reportPath = path.join(QA_DIR, `${today}-report.json`);

  if (!fs.existsSync(reportPath)) {
    console.error('\u274c  QA gate: no QA report found for today (' + today + ').');
    console.error('   Run first: node scripts/newsletter-qa.mjs');
    console.error('   Then retry: node scripts/send-newsletter.mjs --send');
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    console.error('\u274c  QA gate: could not read QA report at ' + reportPath);
    process.exit(1);
  }

  if (!report.passed) {
    console.error('\u274c  QA gate: today\'s QA report has FAILED checks.');
    console.error('   Fix the issues and re-run: node scripts/newsletter-qa.mjs');
    process.exit(1);
  }

  const age = Date.now() - new Date(report.generatedAt).getTime();
  const ageHours = (age / (1000 * 60 * 60)).toFixed(1);
  console.log(`\u2705 QA gate passed — report from ${ageHours}h ago (${report.checksPassed}/${report.checksTotal} checks OK).`);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--send') ? 'send'
    : args.includes('--test') ? 'test'
    : 'preview';
  const noAI = args.includes('--no-ai');
  const targetEmail = readArgValue('--target-email');
  const subjectOverride = readArgValue('--subject');

  console.log(`\ud83d\udce7 Newsletter v2 | mode: ${mode} | AI: ${!noAI}`);

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
    // If previousRate is missing from Firestore, derive from history (7 days ago)
    if (exchangeRate && !exchangeRate.previousRate && history.length >= 7) {
      const weekAgoEntry = history[Math.max(0, history.length - 8)];
      exchangeRate.previousRate = weekAgoEntry?.rate || exchangeRate.rate;
    } else if (exchangeRate && !exchangeRate.previousRate) {
      exchangeRate.previousRate = exchangeRate.rate * 0.997; // ~0.3% fallback
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
  const weeklyFact = getWeeklyFact();
  const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % FEATURED_TOOLS.length;
  const featuredTool = FEATURED_TOOLS[toolIndex];
  const campaignId = `weekly_${new Date().toISOString().split('T')[0]}`;
  const featuredArticle = await pickFeaturedArticle();
  const issueNumber = await getNextIssueNumber();
  if (issueNumber) console.log(`📰 Issue #${issueNumber}`);

  // ── Preview mode ──
  if (mode === 'preview') {
    const locale = 'it';
    const previewJobs = validateJobUrls(
      matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 4),
      jobs,
    );
    const briefing = noAI
      ? getFallbackBriefing(locale, exchangeRate)
      : (await generateAIBriefing({
          subscriber: { locale, preferences: { jobs: true, taxUpdates: true } },
          exchangeRate, exchangeInsight, matchedJobs: previewJobs, weeklyFact, featuredTool,
        })) || getFallbackBriefing(locale, exchangeRate);

    const featuredArticle = db ? await pickFeaturedArticle() : {
      title: 'I 10 migliori comuni per frontalieri',
      excerpt: 'Classifica dei comuni italiani di frontiera: affitti, IRPEF comunale, distanza dal confine.',
      url: `/articoli-frontaliere/${getItalianBlogSlug('comuni-migliori-frontalieri')}`,
      badge: '🔥 Più letto',
    };
    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs: previewJobs,
      totalJobs: jobs.length,
      article: featuredArticle,
      featuredTool,
      weeklyFact,
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
    if (subscribers.length === 0) {
      console.warn('\u26a0\ufe0f No subscribers found. Aborting.');
      return;
    }
  }

  // ── Build personalized emails ──
  const emails = [];
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

  for (const subscriber of subscribers) {
    const locale = nlNormLocale(subscriber.locale);

    // Smart job matching with URL validation
    const matchedJobs = validateJobUrls(
      matchJobsForSubscriber(subscriber, jobs, 4),
      jobs,
    );

    // AI briefing
    let briefing;
    if (noAI) {
      briefing = getFallbackBriefing(locale, exchangeRate);
      aiFallbackCount++;
    } else {
      briefing = await generateAIBriefing({
        subscriber, exchangeRate, exchangeInsight, matchedJobs, weeklyFact, featuredTool,
      });
      if (briefing) {
        aiSuccessCount++;
      } else {
        briefing = getFallbackBriefing(locale, exchangeRate);
        aiFallbackCount++;
      }
    }

    // AI subject
    let subject;
    if (subjectOverride) {
      subject = subjectOverride;
    } else if (noAI) {
      subject = FALLBACK_SUBJECT[locale] || FALLBACK_SUBJECT.it;
    } else {
      subject = await generateAISubject({
        subscriber, exchangeRate, matchedJobs,
        briefingSummary: briefing?.replace(/<[^>]+>/g, '').slice(0, 100) || '',
      });
      if (!subject) subject = FALLBACK_SUBJECT[locale] || FALLBACK_SUBJECT.it;
    }

    // Build HTML
    const html = buildNewsletter({
      aiBriefing: briefing,
      exchangeRate,
      matchedJobs,
      totalJobs: jobs.length,
      article: featuredArticle,
      featuredTool,
      weeklyFact,
      metrics: loadDashboardMetrics(),
      locale,
      issueNumber,
      unsubscribeUrl: makeUnsubscribeUrl(subscriber.email),
      resubscribeUrl: makeResubscribeUrl(subscriber.email),
    });

    // Personalize with autologin links
    const personalizedHtml = await personalizeHtmlForRecipient(subscriber.email, html);

    // Validate all job URLs in final HTML — remove broken links
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
          { name: 'version', value: 'v2-ai' },
        ],
      },
    });

    console.log(`  \u2713 ${subscriber.email} (${locale}) | jobs: ${matchedJobs.length} | AI: ${briefing !== getFallbackBriefing(locale, exchangeRate) ? 'yes' : 'fallback'}`);
  }

  console.log(`\n\ud83e\udde0 AI stats: ${aiSuccessCount} AI briefings, ${aiFallbackCount} fallbacks`);

  // ── Send ──
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('\u274c RESEND_API_KEY required');
    process.exit(1);
  }

  const totalSent = await sendEmailBatch(emails, apiKey);
  console.log(`\u2705 Newsletter sent: ${totalSent}/${subscribers.length}`);

  const sampleSubject = emails[0]?.payload?.subject || 'N/A';
  await logSend(totalSent, sampleSubject, totalSent > 0 ? 'sent' : 'failed');

  if (flushScores) await flushScores();
}

main().catch((e) => { console.error('\u274c Fatal:', e); process.exit(1); });
