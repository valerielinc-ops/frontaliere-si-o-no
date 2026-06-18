#!/usr/bin/env node
/**
 * email-cascade.mjs — Multi-provider email sending with daily quota tracking.
 *
 * Cascade order: Mailgun → Resend → Mailjet → Mailtrap → Maileroo → Cloudflare
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
 *   MAILTRAP_API_TOKEN       — Mailtrap API token (4000/mo, 150/day free tier)
 *   MAILEROO_API_KEY         — Maileroo sending key (3000/mo free tier)
 *   RESEND_API_KEY           — Resend API key (fallback only)
 *   CF_API_TOKEN             — Cloudflare token used by default for Email Service:
 *                                it already carries Email Sending: Edit + Analytics
 *                                Read (verified live). 3000/mo included on the
 *                                existing Workers Paid plan (no extra $), then
 *                                $0.35/1000. Override with CLOUDFLARE_EMAIL_API_TOKEN
 *                                if a dedicated, narrower-scoped token is preferred.
 *   CF_ACCOUNT_ID            — Cloudflare account id (shared with the CDN/Workers config)
 *   CF_ZONE_ID               — optional; zone id for the sending domain. Auto-resolved
 *                                from CF_EMAIL_DOMAIN (default frontaliereticino.ch)
 *                                when unset. Used only for analytics (zone-scoped).
 */

// ── Provider daily quotas ────────────────────────────────────

const PROVIDERS = [
  { id: 'mailgun',  dailyLimit: 100, monthlyLimit: 3000  },
  { id: 'resend',   dailyLimit: 100, monthlyLimit: 3000  },
  { id: 'mailjet',  dailyLimit: 200, monthlyLimit: 6000  },
  { id: 'mailtrap', dailyLimit: 150, monthlyLimit: 4000  },
  { id: 'maileroo', dailyLimit: 100, monthlyLimit: 3000  },
  // Cloudflare Email Service: limit is MONTHLY (3000/mo included on Workers Paid),
  // there is no documented per-day cap. dailyLimit is the 3000/30 ≈ 100/day spread
  // so the in-memory guard keeps a single day from burning a disproportionate
  // share of the monthly allowance. Placed last: it draws on the paid-plan quota,
  // so prefer the purely-free providers first.
  { id: 'cloudflare', dailyLimit: 100, monthlyLimit: 3000 },
  // unosend: disabled — re-enable when needed.
  // { id: 'unosend',  dailyLimit: 200, monthlyLimit: 6000  },
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

export async function fetchMailtrapDailyUsage() {
  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) return 0;
  try {
    // Get account ID first
    const accRes = await fetch('https://mailtrap.io/api/accounts', {
      headers: { 'Api-Token': token },
    });
    if (!accRes.ok) return 0;
    const accounts = await accRes.json();
    const accountId = accounts[0]?.id;
    if (!accountId) return 0;

    // Fetch today's stats
    const today = getTodayUTC();
    const statsRes = await fetch(
      `https://mailtrap.io/api/accounts/${accountId}/stats?start_date=${today}&end_date=${today}`,
      { headers: { 'Api-Token': token } },
    );
    if (!statsRes.ok) return 0;
    const stats = await statsRes.json();
    // The daily quota (150/day) is consumed at SEND time, but delivery_count
    // tracks confirmed *deliveries*, which arrive asynchronously and lag the
    // sends heavily (observed: delivery_count=1 after 31 real sends). Gating on
    // it under-counts → over-send → 403 burst. sent_count reflects accepted
    // sends in real time; take the larger of it and the resolved
    // delivered+bounced total so a lagging/missing field can never under-count.
    const sent = Number(stats.sent_count) || 0;
    const resolved = (Number(stats.delivery_count) || 0) + (Number(stats.bounce_count) || 0);
    return Math.max(sent, resolved);
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

async function fetchMailerooDailyUsage() {
  // Maileroo's v2 API exposes no public usage/statistics endpoint (only
  // send + scheduled-email management). Daily cap is therefore enforced by the
  // in-memory counter alone — starting from 0 each run is safe (may overshoot
  // the daily quota slightly across separate runs on the same day, same as the
  // fallback behaviour of every other provider on API error).
  return 0;
}

// ── Cloudflare Email Service shared config ───────────────────
// One token covers the whole integration: the existing default CF_API_TOKEN in
// Remote Config already carries Email Sending: Edit + Analytics Read (verified
// live), so no dedicated token is required. CLOUDFLARE_EMAIL_API_TOKEN /
// CF_EMAIL_API_TOKEN remain as optional overrides for a narrower-scoped token.
const CLOUDFLARE_EMAIL_DOMAIN = process.env.CF_EMAIL_DOMAIN || 'frontaliereticino.ch';
let _cfZoneIdCache;

function cloudflareToken() {
  return process.env.CLOUDFLARE_EMAIL_API_TOKEN || process.env.CF_EMAIL_API_TOKEN || process.env.CF_API_TOKEN;
}
function cloudflareAccountId() {
  return process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
}

/**
 * Resolve the zone id for the sending domain (the emailSendingAdaptiveGroups
 * analytics dataset is ZONE-scoped, not account-scoped). Prefers CF_ZONE_ID,
 * else looks it up by domain once and caches it. Returns null if unresolvable
 * (token missing Zone Read, domain not on the account, network error).
 */
async function resolveCloudflareZoneId() {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  if (_cfZoneIdCache !== undefined) return _cfZoneIdCache;
  const token = cloudflareToken();
  if (!token) { _cfZoneIdCache = null; return null; }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(CLOUDFLARE_EMAIL_DOMAIN)}&status=active`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { _cfZoneIdCache = null; return null; }
    const data = await res.json().catch(() => null);
    _cfZoneIdCache = data?.result?.[0]?.id || null;
    return _cfZoneIdCache;
  } catch { _cfZoneIdCache = null; return null; }
}

/**
 * Low-level query against the Cloudflare Email Service GraphQL Analytics API
 * (dataset emailSendingAdaptiveGroups, ZONE-scoped). Returns the raw `groups`
 * array for [startDate, endDate] (inclusive, ISO yyyy-mm-dd), optionally grouped
 * by the given dimensions, or null when the endpoint is unreachable /
 * unauthorized / unconfigured so callers can tell "0 events" apart from
 * "couldn't verify". Requires the token to carry the Analytics Read scope.
 * Docs: https://developers.cloudflare.com/email-service/observability/metrics-analytics/
 */
async function queryCloudflareEmailGroups(startDate, endDate, dimensions = []) {
  const token = cloudflareToken();
  const zoneId = await resolveCloudflareZoneId();
  if (!token || !zoneId) return null;
  const dimFields = dimensions.length ? ` dimensions{${dimensions.join(' ')}}` : '';
  const query = `query($zone:String!,$start:Date!,$end:Date!){viewer{zones(filter:{zoneTag:$zone}){emailSendingAdaptiveGroups(filter:{date_geq:$start,date_leq:$end},limit:10000){count${dimFields}}}}}`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { zone: zoneId, start: startDate, end: endDate } }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.errors?.length) return null;
    return data?.data?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups || [];
  } catch { return null; }
}

/**
 * Total count of send events in [startDate, endDate], or null if unverifiable.
 */
export async function fetchCloudflareUsage(startDate, endDate) {
  const groups = await queryCloudflareEmailGroups(startDate, endDate);
  if (groups === null) return null;
  return groups.reduce((sum, g) => sum + (Number(g.count) || 0), 0);
}

/**
 * Delivery-event observation for Cloudflare Email Service. Unlike the cascade's
 * other providers, Cloudflare exposes NO outbound webhook and does NOT track
 * opens/clicks (it is a delivery-only relay) — engagement events simply do not
 * exist there. The only observable signal is delivery STATUS (sent / delivered /
 * failed / rejected / bounced + auth results), and it is PULL-only via this
 * Analytics dataset. Returns { total, byStatus: { <status>: count } } for
 * [startDate, endDate], or null if unverifiable.
 */
export async function fetchCloudflareDeliveryStats(startDate, endDate) {
  const groups = await queryCloudflareEmailGroups(startDate, endDate, ['status']);
  if (groups === null) return null;
  const byStatus = {};
  let total = 0;
  for (const g of groups) {
    const n = Number(g.count) || 0;
    total += n;
    const status = g.dimensions?.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + n;
  }
  return { total, byStatus };
}

/**
 * Cloudflare's quota is MONTHLY, and emailSendingAdaptiveGroups aggregates one
 * row per send EVENT (queued/delivered/bounced), so a per-day count would
 * over-count actual sends and prematurely retire the provider (the dangerous
 * under-send direction). Daily gating is therefore left to the in-memory counter
 * alone — same safe fallback as Maileroo. Real consumption is surfaced against
 * the monthly cap by check-email-quotas.mjs via fetchCloudflareUsage().
 */
async function fetchCloudflareDailyUsage() {
  return 0;
}

/**
 * Sync in-memory counters with real provider usage for today.
 * Called once per cascade run. Falls back to 0 on API errors (safe: may overshoot quota slightly).
 */
async function syncQuotasFromAPIs() {
  if (_quotasSynced && _counterDate === getTodayUTC()) return;

  console.log('📊 Syncing quotas from provider APIs...');
  const [mailgun, mailjet, mailtrap, unosend, resend, maileroo, cloudflare] = await Promise.all([
    fetchMailgunDailyUsage(),
    fetchMailjetDailyUsage(),
    fetchMailtrapDailyUsage(),
    fetchUnosendDailyUsage(),
    fetchResendDailyUsage(),
    fetchMailerooDailyUsage(),
    fetchCloudflareDailyUsage(),
  ]);

  _counterDate = getTodayUTC();
  _counters.mailgun = mailgun;
  _counters.mailjet = mailjet;
  _counters.mailtrap = mailtrap;
  _counters.unosend = unosend;
  _counters.resend = resend;
  _counters.maileroo = maileroo;
  _counters.cloudflare = cloudflare;
  _quotasSynced = true;

  console.log(`   Usage today: mailgun=${mailgun}/100, mailjet=${mailjet}/200, mailtrap=${mailtrap}/150, unosend=${unosend}/200, resend=${resend}/100, maileroo=${maileroo}/100, cloudflare=${cloudflare}/100`);
}

// ── Provider availability check ──────────────────────────────

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'mailjet':    return !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY);
    case 'mailgun':    return !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
    case 'mailtrap':   return !!process.env.MAILTRAP_API_TOKEN;
    case 'maileroo':   return !!process.env.MAILEROO_API_KEY;
    case 'unosend':    return !!process.env.UNOSEND_API_KEY;
    case 'resend':     return !!process.env.RESEND_API_KEY;
    case 'cloudflare': return !!(cloudflareToken() && cloudflareAccountId());
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
        CustomID: campaignIdTag(email),
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

// ── Mailtrap Send API ────────────────────────────────────────
// Docs: https://api-docs.mailtrap.io/docs/mailtrap-api-docs/

async function sendViaMailtrap(email) {
  const token = process.env.MAILTRAP_API_TOKEN;
  const fromParsed = parseEmailAddress(email.from);

  const body = {
    from: { email: fromParsed.email, name: fromParsed.name || undefined },
    to: (Array.isArray(email.to) ? email.to : [email.to]).map(addr => ({ email: addr })),
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;
  if (email.tags?.length) body.category = campaignIdTag(email);
  if (email.headers && typeof email.headers === 'object') body.headers = email.headers;

  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mailtrap ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return { messageId: data?.message_ids?.[0] || `mailtrap-${Date.now()}`, provider: 'mailtrap' };
}

// ── Maileroo API (v2) ────────────────────────────────────────
// Docs: https://maileroo.com/docs/email-api/send-basic-email/
// Auth: X-Api-Key header. Free tier 3000/mo with custom DKIM domain.

async function sendViaMaileroo(email) {
  const apiKey = process.env.MAILEROO_API_KEY;
  const fromParsed = parseEmailAddress(email.from);

  const body = {
    from: { address: fromParsed.email, display_name: fromParsed.name || undefined },
    to: (Array.isArray(email.to) ? email.to : [email.to]).map(addr => ({ address: addr })),
    subject: email.subject,
    html: email.html,
    // Enable open + click tracking (parity with Mailgun/Resend).
    tracking: true,
  };
  if (email.text) body.plain = email.text;
  // Maileroo tags are an object map; cascade tags are [{name, value}].
  if (email.tags?.length) {
    body.tags = {};
    for (const tag of email.tags) {
      if (tag?.name) body.tags[tag.name] = String(tag.value ?? '');
    }
  }
  // Forward custom email headers (List-Unsubscribe, Feedback-ID, etc.).
  if (email.headers && typeof email.headers === 'object') body.headers = email.headers;

  const res = await fetch('https://smtp.maileroo.com/api/v2/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Maileroo ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data?.success === false) {
    throw new Error(`Maileroo error: ${String(data.message || 'unknown').slice(0, 200)}`);
  }
  return { messageId: data?.data?.reference_id || `maileroo-${Date.now()}`, provider: 'maileroo' };
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

// ── Cloudflare Email Service REST API ─────────────────────────
// Docs: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
// Auth: Bearer token (Email Sending: Edit) — the default CF_API_TOKEN already has
// it. `from` and `to` MUST be plain RFC822 strings ("Name <email>" or bare
// "email"); `to` may be a string or an array of such strings. The `{ email, name }`
// object form is REJECTED with 400 `invalid_request_schema` (code 10001) — verified
// live 2026-06-16, the cause of every newsletter send failing once a display-name
// sender was used. Free outbound requires the Workers Paid plan; 3000/mo are
// included before per-email pricing kicks in. Response is the standard client/v4
// envelope: { success, errors, result: { message_id, delivered, queued, permanent_bounces } }.

// Normalize a recipient/sender into the RFC822 string the CF API expects, whether
// it arrives as a plain string or a { email, name } object.
function cloudflareAddress(addr) {
  const parsed = parseEmailAddress(addr);
  return parsed.name ? `${parsed.name} <${parsed.email}>` : parsed.email;
}

async function sendViaCloudflare(email) {
  const accountId = cloudflareAccountId();
  const token = cloudflareToken();

  const body = {
    from: cloudflareAddress(email.from),
    to: (Array.isArray(email.to) ? email.to : [email.to]).map(cloudflareAddress),
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;
  // Forward custom email headers (List-Unsubscribe, Feedback-ID, etc.).
  if (email.headers && typeof email.headers === 'object') body.headers = email.headers;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    // 429 (code 10004 throttled) and quota-exceeded bodies are caught by
    // isRateLimitedError → provider retired for the rest of the run.
    const err = await res.text().catch(() => '');
    // Surface the CF error code/message as discrete fields. The raw JSON body
    // gets truncated in CI logs right after `"code":` (GitHub secret masking),
    // so parse it and log the numeric code + human message explicitly.
    let cfCode = '?';
    let cfMsg = '';
    try {
      const parsed = JSON.parse(err);
      const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
      if (first) {
        cfCode = first.code ?? '?';
        cfMsg = first.message ?? '';
      }
    } catch {}
    console.warn(`   ⚠️  [cf-send] HTTP ${res.status} code=${cfCode} message="${String(cfMsg).slice(0, 160)}"`);
    throw new Error(`Cloudflare ${res.status} code=${cfCode}: ${String(cfMsg || err).slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data?.success === false) {
    throw new Error(`Cloudflare error: ${JSON.stringify(data.errors || []).slice(0, 200)}`);
  }
  // Standard client/v4 envelope; result groups recipients into
  // delivered / queued / permanent_bounces and carries a top-level message_id.
  // An accepted send returns success:true + result.message_id even when both
  // delivered and queued are still empty (delivery is async), so the message_id
  // — not the per-recipient arrays — is the success signal.
  const result = data?.result || data;
  const accepted = [].concat(result?.delivered || [], result?.queued || []);
  const bounced = result?.permanent_bounces || [];
  const messageId = result?.message_id || result?.id || accepted[0]?.id || accepted[0]?.message_id;
  if (!messageId && bounced.length > 0) {
    throw new Error(`Cloudflare permanent_bounce: ${JSON.stringify(bounced).slice(0, 200)}`);
  }
  return { messageId: String(messageId || `cf-${Date.now()}`), provider: 'cloudflare' };
}

// ── Provider dispatch ────────────────────────────────────────

const SEND_FNS = {
  mailgun: sendViaMailgun,
  mailjet: sendViaMailjet,
  mailtrap: sendViaMailtrap,
  maileroo: sendViaMaileroo,
  unosend: sendViaUnosend,
  resend: sendViaResend,
  cloudflare: sendViaCloudflare,
};

/**
 * Send a single email via the first available provider with remaining quota.
 * @param {Object} email - Email payload
 * @param {string} [forceProvider] - If set, only use this specific provider
 * @returns {{ messageId: string, provider: string }}
 */
/**
 * Detect a hard rate-limit / quota-reached signal in a provider error message.
 * Covers HTTP 429 and 403 burst/quota throttles (e.g. Mailtrap free Send API
 * returns `403 {"errors":["Your account has reached the limit"]}` when hammered).
 * When matched, the provider is marked exhausted for the rest of the run so the
 * cascade stops re-trying it (the root cause of the 258-in-5s 403 burst).
 *
 * The "reached" branch requires limit/quota context — bare "reached" is too
 * broad (e.g. a generic 403 carrying "host could not be reached") and would
 * wrongly retire a healthy provider; in forced-provider mode that fails the
 * whole run.
 */
function isRateLimitedError(msg) {
  if (!msg) return false;
  if (msg.includes('429')) return true;
  if (msg.includes('403') &&
      /reached[^"]{0,40}(limit|quota|cap|messages)|rate.?limit|too many|quota|limit of/i.test(msg)) {
    return true;
  }
  return false;
}

async function sendSingle(email, forceProvider, finalizeForProvider) {
  const errors = [];
  const providers = forceProvider
    ? PROVIDERS.filter(p => p.id === forceProvider)
    : PROVIDERS;

  for (const provider of providers) {
    if (!isProviderConfigured(provider.id)) continue;
    if (remainingQuota(provider.id) <= 0) continue;

    try {
      // Optional hook: let the caller finalize the payload for the provider that
      // is actually about to send (e.g. swap the subject to that provider's A/B
      // winner). Must never throw — on error we send the payload unchanged.
      if (typeof finalizeForProvider === 'function') {
        try { finalizeForProvider(email, provider.id); } catch { /* send as-is */ }
      }
      const result = await SEND_FNS[provider.id](email);
      incrementCounter(provider.id, 1);
      return result;
    } catch (err) {
      errors.push(`[${provider.id}] ${err.message}`);
      if (isRateLimitedError(err.message)) {
        incrementCounter(provider.id, remainingQuota(provider.id));
        console.warn(`⚠️  ${provider.id} rate-limited/exhausted — skipping for rest of run`);
      }
    }
  }

  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

/**
 * Send a single email with per-provider throttling.
 * Waits until at least `delayMs` has elapsed since the last send to the same provider,
 * then delegates to the provider loop in sendSingle.
 */
async function sendSingleThrottled(email, forceProvider, lastSendMap, delayMs, finalizeForProvider) {
  // Determine which provider will be tried first (the one with remaining quota)
  const providers = forceProvider
    ? PROVIDERS.filter(p => p.id === forceProvider)
    : PROVIDERS;
  const nextProvider = providers.find(p => isProviderConfigured(p.id) && remainingQuota(p.id) > 0);

  if (nextProvider) {
    // Reserve a delay-spaced slot SYNCHRONOUSLY (read + write lastSendMap with no
    // await in between) so concurrent sends to the same provider each get a
    // distinct slot instead of all reading the same timestamp, waiting the same
    // delta, and firing as a burst. The reservation advances the clock up-front,
    // so spacing holds even when the send FAILS — the failure mode behind the
    // "258 Mailtrap 403s in 5s" incident, now concurrency-safe for any future
    // concurrency>1 caller (was latent at the default concurrency=1).
    const now = Date.now();
    const slot = Math.max(now, lastSendMap[nextProvider.id] || 0);
    lastSendMap[nextProvider.id] = slot + delayMs;
    const wait = slot - now;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // Slot already reserved above (advances even on throw), so no post-hoc clock
  // bump is needed — the worker's try/catch handles a thrown send.
  const result = await sendSingle(email, forceProvider, finalizeForProvider);
  // If a different provider ended up sending, reserve its slot too.
  if (result?.provider && result.provider !== nextProvider?.id) {
    const now = Date.now();
    lastSendMap[result.provider] = Math.max(now, lastSendMap[result.provider] || 0) + delayMs;
  }
  return result;
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
 * @param {number} [opts.concurrency=1] - Max parallel sends (default 1 to avoid rate limits)
 * @param {number} [opts.delayMs=1000] - Delay in ms between sends to the same provider
 * @param {string} [opts.forceProvider] - Force a specific provider (skip cascade)
 * @param {Function} [opts.onSent] - Called after each successful send: (item, result) => void
 * @param {Function} [opts.finalizeForProvider] - Called just before sending, once
 *   the provider is chosen: (payload, providerId) => void. May mutate the payload
 *   (e.g. swap the subject for that provider). Must not throw.
 * @returns {{ sent: Array, failed: Array }}
 */
export async function sendEmailCascade(emails, opts = {}) {
  const { concurrency = 1, delayMs = 1000, forceProvider, onSent, finalizeForProvider } = opts;
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
  console.log(`   Throttle: concurrency=${concurrency}, delay=${delayMs}ms between sends`);

  // Per-provider last-send timestamps for throttling
  const _lastSend = {};

  // Process sequentially (concurrency=1) with per-provider delay
  let idx = 0;
  const worker = async () => {
    while (idx < emails.length) {
      const i = idx++;
      const item = emails[i];
      try {
        const result = await sendSingleThrottled(item.payload, forceProvider, _lastSend, delayMs, finalizeForProvider);
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

/**
 * The campaign id to stamp on providers that carry a single opaque tracking
 * token (Mailjet `CustomID`, Mailtrap `category`). Looks the tag up BY NAME
 * (`campaign_id`) rather than by position: the newsletter pipeline builds the
 * `tags` array with `campaign_id` first, but that order is incidental, and a
 * positional `tags[0]` silently stamps the wrong token if the order ever
 * changes — breaking the A/B report's `events where campaign_id == weekly_*`
 * match for Mailjet opens (those open events echo back this CustomID). Falls
 * back to the first tag for non-newsletter callers that pass a single tag.
 * @param {{ tags?: Array<{name?: string, value?: string}> }} email
 * @returns {string|undefined}
 */
function campaignIdTag(email) {
  const tags = email?.tags;
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const named = tags.find((t) => t?.name === 'campaign_id');
  return (named ?? tags[0])?.value || undefined;
}

/**
 * Total theoretical daily send capacity across the whole cascade —
 * the sum of every provider's daily limit (currently mailgun 100 + resend 100
 * + mailjet 200 + mailtrap 150 + maileroo 100 + cloudflare 100 = 750). Single
 * source of truth so callers (e.g. the newsletter per-run cap) stay in sync when
 * providers change.
 */
export function getCascadeDailyCapacity() {
  return PROVIDERS.reduce((sum, p) => sum + p.dailyLimit, 0);
}

export { PROVIDERS, remainingQuota, isProviderConfigured, syncQuotasFromAPIs, isRateLimitedError, campaignIdTag };
