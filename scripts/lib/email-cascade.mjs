#!/usr/bin/env node
/**
 * email-cascade.mjs — Multi-provider email sending with daily quota tracking.
 *
 * Cascade order: Mailgun → Mailjet → Resend (fallback)
 * Each provider has a daily quota. When one is exhausted, the next takes over.
 * Tracking (persistDelivery) is provider-agnostic — callers handle Firestore writes.
 *
 * All providers support custom sending domains with DKIM on their free tier,
 * with no forced branding on emails.
 *
 * Usage:
 *   import { sendEmailCascade, getProviderStats } from './lib/email-cascade.mjs';
 *   const { sent, failed } = await sendEmailCascade(emails);
 *
 * Email format (same as Resend):
 *   { from, to: [string], subject, html, headers?, tags?: [{name, value}] }
 *
 * Environment variables (from Firebase Remote Config via load-rc-env.mjs):
 *   MAILJET_API_KEY          — Mailjet API key (public)
 *   MAILJET_SECRET_KEY       — Mailjet API secret
 *   MAILGUN_API_KEY          — Mailgun API key (EU region)
 *   MAILGUN_DOMAIN           — Mailgun sending domain
 *   UNOSEND_API_KEY          — Unosend API key (6000/mo free tier)
 *   RESEND_API_KEY           — Resend API key (fallback only)
 */

// ── Provider daily quotas ────────────────────────────────────

const PROVIDERS = [
  { id: 'mailgun',  dailyLimit: 100, monthlyLimit: 3000  },
  // mailjet: disabled until account is activated (401 Unauthorized). Re-enable when unblocked.
  // { id: 'mailjet',  dailyLimit: 200, monthlyLimit: 6000  },
  { id: 'unosend',  dailyLimit: 200, monthlyLimit: 6000  },
  { id: 'resend',   dailyLimit: 100, monthlyLimit: 3000  },
];

// In-memory daily counters (reset on new UTC day)
const _counters = {};
let _counterDate = '';
let _quotasSynced = false;

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getCounter(providerId) {
  const today = getTodayUTC();
  if (_counterDate !== today) {
    _counterDate = today;
    for (const p of PROVIDERS) _counters[p.id] = 0;
    _quotasSynced = false;
  }
  return _counters[providerId] || 0;
}

function incrementCounter(providerId, count) {
  getCounter(providerId); // ensure initialized
  _counters[providerId] = (_counters[providerId] || 0) + count;
}

function remainingQuota(providerId) {
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!provider) return 0;
  return Math.max(0, provider.dailyLimit - getCounter(providerId));
}

// ── Real quota sync via provider APIs ────────────────────────

async function fetchMailgunDailyUsage() {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || 'frontaliereticino.ch';
  if (!apiKey) return 0;
  try {
    const res = await fetch(
      `https://api.eu.mailgun.net/v3/${domain}/stats/total?event=accepted&duration=1d`,
      { headers: { Authorization: 'Basic ' + Buffer.from('api:' + apiKey).toString('base64') } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data.stats?.[0]?.accepted?.outgoing || 0;
  } catch { return 0; }
}

async function fetchMailjetDailyUsage() {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  if (!apiKey || !secretKey) return 0;
  try {
    const today = getTodayUTC();
    const auth = Buffer.from(apiKey + ':' + secretKey).toString('base64');
    const res = await fetch(
      `https://api.mailjet.com/v3/REST/statcounters?CounterSource=APIKey&CounterTiming=Message&CounterResolution=Day&FromTS=${today}T00:00:00Z&ToTS=${today}T23:59:59Z`,
      { headers: { Authorization: 'Basic ' + auth } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    let total = 0;
    for (const row of data.Data || []) {
      total += (row.MessageSentCount || 0) + (row.MessageQueuedCount || 0);
    }
    return total;
  } catch { return 0; }
}

async function fetchUnosendDailyUsage() {
  const apiKey = process.env.UNOSEND_API_KEY;
  if (!apiKey) return 0;
  try {
    const today = getTodayUTC();
    const res = await fetch('https://api.unosend.co/v1/emails?limit=100', {
      headers: { Authorization: 'Bearer ' + apiKey }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return (data.data || []).filter(e => e.sent_at?.startsWith(today)).length;
  } catch { return 0; }
}

async function fetchResendDailyUsage() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return 0;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      headers: { Authorization: 'Bearer ' + apiKey }
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const today = getTodayUTC();
    return (data.data || []).filter(e => e.created_at?.startsWith(today)).length;
  } catch { return 0; }
}

/**
 * Sync in-memory counters with real provider usage for today.
 * Called once per cascade run. Falls back to 0 on API errors (safe: may overshoot quota slightly).
 */
async function syncQuotasFromAPIs() {
  if (_quotasSynced && _counterDate === getTodayUTC()) return;

  console.log('📊 Syncing quotas from provider APIs...');
  const [mailgun, mailjet, unosend, resend] = await Promise.all([
    fetchMailgunDailyUsage(),
    fetchMailjetDailyUsage(),
    fetchUnosendDailyUsage(),
    fetchResendDailyUsage(),
  ]);

  _counterDate = getTodayUTC();
  _counters.mailgun = mailgun;
  _counters.mailjet = mailjet;
  _counters.unosend = unosend;
  _counters.resend = resend;
  _quotasSynced = true;

  console.log(`   Usage today: mailgun=${mailgun}/100, mailjet=${mailjet}/200, unosend=${unosend}/200, resend=${resend}/100`);
}

// ── Provider availability check ──────────────────────────────

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'mailjet':    return !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY);
    case 'mailgun':    return !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
    case 'unosend':    return !!process.env.UNOSEND_API_KEY;
    case 'resend':     return !!process.env.RESEND_API_KEY;
    default: return false;
  }
}

// ── Mailjet API (v3.1) ──────────────────────────────────────
// Docs: https://dev.mailjet.com/email/guides/send-api-v31/

async function sendViaMailjet(email) {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  const fromParsed = parseEmailAddress(email.from);

  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: fromParsed.email, Name: fromParsed.name || undefined },
        To: (Array.isArray(email.to) ? email.to : [email.to]).map(addr => ({ Email: addr })),
        Subject: email.subject,
        HTMLPart: email.html,
        TextPart: email.text || undefined,
        CustomID: email.tags?.[0]?.value || undefined,
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mailjet ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  const msg = data?.Messages?.[0];
  if (msg?.Status === 'error') {
    throw new Error(`Mailjet error: ${JSON.stringify(msg.Errors).slice(0, 200)}`);
  }
  return { messageId: String(msg?.To?.[0]?.MessageID || `mj-${Date.now()}`), provider: 'mailjet' };
}

// ── Mailgun API (v3) ─────────────────────────────────────────
// Docs: https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/

async function sendViaMailgun(email) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const auth = Buffer.from(`api:${apiKey}`).toString('base64');

  // Use FormData (multipart/form-data) instead of URLSearchParams —
  // Mailgun recommends multipart for large HTML emails, and URLSearchParams
  // URL-encodes the body which can cause partial click-tracking link rewriting.
  const form = new FormData();
  form.append('from', email.from);
  const toAddrs = Array.isArray(email.to) ? email.to : [email.to];
  for (const addr of toAddrs) form.append('to', addr);
  form.append('subject', email.subject);
  form.append('html', email.html);
  if (email.text) form.append('text', email.text);
  // Explicitly enable tracking (open pixel + link rewriting)
  form.append('o:tracking', 'yes');
  form.append('o:tracking-clicks', 'yes');
  form.append('o:tracking-opens', 'yes');
  if (email.tags?.length) {
    for (const tag of email.tags) form.append('o:tag', tag.value);
  }
  // Forward custom email headers (List-Unsubscribe, etc.)
  if (email.headers && typeof email.headers === 'object') {
    for (const [key, value] of Object.entries(email.headers)) {
      form.append(`h:${key}`, value);
    }
  }

  const res = await fetch(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mailgun ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return { messageId: data?.id || `mg-${Date.now()}`, provider: 'mailgun' };
}

// ── Unosend API (v1) ─────────────────────────────────────────
// Docs: https://docs.unosend.co/api-reference/emails

async function sendViaUnosend(email) {
  const apiKey = process.env.UNOSEND_API_KEY;
  const fromParsed = parseEmailAddress(email.from);

  const body = {
    from: fromParsed.name ? `${fromParsed.name} <${fromParsed.email}>` : fromParsed.email,
    to: Array.isArray(email.to) ? email.to : [email.to],
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;
  if (email.tags?.length) body.tags = email.tags;
  if (email.headers && typeof email.headers === 'object') body.headers = email.headers;

  const res = await fetch('https://api.unosend.co/v1/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Unosend ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return { messageId: data?.id || `unosend-${Date.now()}`, provider: 'unosend' };
}

// ── Resend API (fallback) ────────────────────────────────────
// Same as existing implementation but single-email

async function sendViaResend(email) {
  const apiKey = process.env.RESEND_API_KEY;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text || undefined,
      headers: email.headers || undefined,
      tags: email.tags || undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return { messageId: data?.id || `resend-${Date.now()}`, provider: 'resend' };
}

// ── Provider dispatch ────────────────────────────────────────

const SEND_FNS = {
  mailgun: sendViaMailgun,
  mailjet: sendViaMailjet,
  unosend: sendViaUnosend,
  resend: sendViaResend,
};

/**
 * Send a single email via the first available provider with remaining quota.
 * @param {Object} email - Email payload
 * @param {string} [forceProvider] - If set, only use this specific provider
 * @returns {{ messageId: string, provider: string }}
 */
async function sendSingle(email, forceProvider) {
  const errors = [];
  const providers = forceProvider
    ? PROVIDERS.filter(p => p.id === forceProvider)
    : PROVIDERS;

  for (const provider of providers) {
    if (!isProviderConfigured(provider.id)) continue;
    if (remainingQuota(provider.id) <= 0) continue;

    try {
      const result = await SEND_FNS[provider.id](email);
      incrementCounter(provider.id, 1);
      return result;
    } catch (err) {
      errors.push(`[${provider.id}] ${err.message}`);
      if (err.message.includes('429')) {
        incrementCounter(provider.id, remainingQuota(provider.id));
        console.warn(`⚠️  ${provider.id} rate-limited — skipping for today`);
      }
    }
  }

  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// ── Batch cascade ────────────────────────────────────────────

/**
 * Send multiple emails through the cascade. Each email item must have:
 *   - payload: { from, to, subject, html, ... }
 *   - recipient: { email, ... } (for tracking)
 *   - meta: { campaignId, ... } (for tracking)
 *
 * @param {Array} emails - Array of { payload, recipient, meta }
 * @param {Object} [opts]
 * @param {number} [opts.concurrency=3] - Max parallel sends
 * @param {string} [opts.forceProvider] - Force a specific provider (skip cascade)
 * @param {Function} [opts.onSent] - Called after each successful send: (item, result) => void
 * @returns {{ sent: Array, failed: Array }}
 */
export async function sendEmailCascade(emails, opts = {}) {
  const { concurrency = 3, forceProvider, onSent } = opts;
  const sent = [];
  const failed = [];

  // Sync counters with real provider usage before sending
  await syncQuotasFromAPIs();

  // Log available providers
  const available = PROVIDERS.filter(p => isProviderConfigured(p.id));
  if (available.length === 0) {
    console.error('❌ No email providers configured. Set at least one API key.');
    return { sent: [], failed: emails };
  }

  const totalQuota = available.reduce((sum, p) => sum + remainingQuota(p.id), 0);
  console.log(`📧 Email cascade: ${emails.length} to send, ${totalQuota} daily quota remaining`);
  console.log(`   Providers: ${available.map(p => `${p.id}(${remainingQuota(p.id)})`).join(' → ')}`);

  // Process with concurrency control
  let idx = 0;
  const worker = async () => {
    while (idx < emails.length) {
      const i = idx++;
      const item = emails[i];
      try {
        const result = await sendSingle(item.payload, forceProvider);
        sent.push({ ...item, ...result });
        if (onSent) await onSent(item, result);
      } catch (err) {
        failed.push({ ...item, error: err.message });
        console.warn(`❌ [${i + 1}/${emails.length}] ${item.recipient?.email}: ${err.message.slice(0, 100)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, () => worker()));

  // Print summary
  const providerBreakdown = {};
  for (const s of sent) {
    providerBreakdown[s.provider] = (providerBreakdown[s.provider] || 0) + 1;
  }
  console.log(`✅ Sent: ${sent.length}, Failed: ${failed.length}`);
  if (Object.keys(providerBreakdown).length > 0) {
    console.log(`   Breakdown: ${Object.entries(providerBreakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  return { sent, failed };
}

// ── Stats ────────────────────────────────────────────────────

/**
 * Get current provider stats (for logging/monitoring).
 */
export function getProviderStats() {
  return PROVIDERS.map(p => ({
    id: p.id,
    configured: isProviderConfigured(p.id),
    dailyLimit: p.dailyLimit,
    sent: getCounter(p.id),
    remaining: remainingQuota(p.id),
  }));
}

/**
 * Print a summary table of provider usage.
 */
export function logProviderSummary() {
  console.log('\n📊 Email Provider Summary:');
  console.log('   Provider     | Configured | Sent | Remaining | Daily Limit');
  console.log('   -------------|------------|------|-----------|-----------');
  for (const stat of getProviderStats()) {
    const cfg = stat.configured ? '✅' : '❌';
    console.log(`   ${stat.id.padEnd(12)} | ${cfg.padEnd(10)} | ${String(stat.sent).padEnd(4)} | ${String(stat.remaining).padEnd(9)} | ${stat.dailyLimit}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Parse "Name <email@example.com>" format into { email, name }.
 */
function parseEmailAddress(from) {
  if (typeof from === 'object') return from;
  const match = String(from).match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { email: match[2].trim(), name: match[1].trim() };
  return { email: String(from).trim() };
}

export { PROVIDERS, remainingQuota, isProviderConfigured, syncQuotasFromAPIs };
