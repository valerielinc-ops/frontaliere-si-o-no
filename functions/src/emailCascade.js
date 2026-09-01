/**
 * emailCascade.js — Multi-provider email sending with daily quota tracking.
 *
 * Canonical copy (moved here 2026-07-16 so Cloud Functions can call the
 * cascade directly — functions/ has no bundler, so functions/src/*.js can
 * only import from within functions/, never from scripts/lib/*, per
 * docs/AGENTS-HISTORY.md's no-bundler shared-module pattern). The original
 * scripts/lib/email-cascade.mjs is now a thin re-export shim pointing here —
 * edit THIS file; the shim never needs touching again.
 *
 * Cascade order: Mailgun → Mailjet → Mailtrap → Maileroo → Cloudflare → Resend
 * (reordered 2026-07-16 — see PROVIDERS[resend] below for why resend moved last).
 * Maileroo's plan bumped to 100000/mo 2026-07-20 (owner request) — with the
 * three free tiny-cap providers ahead of it (~650/day combined) it now absorbs
 * effectively all newsletter + job-alert volume before cloudflare/resend are
 * ever touched; see PROVIDERS[maileroo] below.
 * Each provider has a daily quota. When one is exhausted, the next takes over.
 * Tracking (persistDelivery) is provider-agnostic — callers handle Firestore writes.
 *
 * All providers support custom sending domains with DKIM on their free tier,
 * with no forced branding on emails.
 *
 * Usage (scripts/):
 *   import { sendEmailCascade, getProviderStats } from './lib/email-cascade.mjs';
 * Usage (functions/src/*.js):
 *   import { sendEmailCascade } from './emailCascade.js';
 *   const { sent, failed } = await sendEmailCascade(emails);
 *
 * Email format (same as Resend):
 *   { from, to: [string], subject, html, headers?, tags?: [{name, value}], replyTo?: string, attachments?: [{filename, content}], scheduledAt?: string }
 *
 * scheduledAt (optional) — ISO 8601 UTC timestamp (e.g. "2026-07-12T08:00:00.000Z")
 *   requesting a provider-side delayed send. Only resend/mailgun/maileroo support
 *   it (see providerSupportsScheduledSend() / PROVIDERS[*].scheduledSend below);
 *   the other three providers (mailjet, mailtrap, cloudflare) have no
 *   scheduled-send API and always send immediately regardless of this field.
 *   Falls back to an immediate send (no error) when: scheduledAt is
 *   missing/unparsable; in the past or under a 2-minute anti-race margin; past
 *   the resolved provider's max lookahead window; or the provider has no
 *   scheduled-send support. Every sent item in sendEmailCascade's `sent` array
 *   carries `scheduledFor`: the resolved ISO timestamp when the send was
 *   actually scheduled provider-side, else null.
 *
 * Environment variables (from Firebase Remote Config via load-rc-env.mjs):
 *   MAILJET_API_KEY          — Mailjet API key (public)
 *   MAILJET_SECRET_KEY       — Mailjet API secret
 *   MAILGUN_API_KEY          — Mailgun API key (EU region)
 *   MAILGUN_DOMAIN           — Mailgun sending domain
 *   MAILTRAP_API_TOKEN       — Mailtrap API token (4000/mo, 150/day free tier).
 *                                Dynamically paced against real billing-cycle
 *                                usage (computeMailtrapDynamicDailyLimit), same
 *                                shape as resend/maileroo — see PROVIDERS[mailtrap].
 *   MAILEROO_API_KEY         — Maileroo sending key (100000/mo paid plan since
 *                                2026-07-20, owner request). Primary bulk workhorse
 *                                of the cascade now — dynamically capped to pace
 *                                the 100k/mo budget, see PROVIDERS[maileroo] below.
 *   MAILEROO_ACCOUNT_API_KEY — Maileroo Account API key (dashboard "Applications"
 *                                section — a DIFFERENT credential from the sending
 *                                key above). Powers real month-to-date usage via
 *                                statistics/summary for the dynamic pace; optional
 *                                — falls back to a conservative static pace when
 *                                unset (verified live 2026-07-20: the sending key
 *                                itself gets 401 against this endpoint).
 *   RESEND_API_KEY           — Resend API key (free plan: 100/day, 3000/mo).
 *                                Last in cascade order since 2026-07-16 — now the
 *                                overflow valve once maileroo's much larger budget
 *                                is spent. The dynamic cap paces the monthly quota
 *                                without ever exceeding 100/day; see PROVIDERS below.
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

// scheduledSend.maxLookaheadMs is the single source of truth for how far in
// the future a per-message `scheduledAt` may be scheduled with each provider
// (verified against live docs 2026-07-11). Maileroo's real ceiling is
// undocumented — clamped conservatively rather than risk a silent-drop by
// the provider past its real limit. Mailgun's ceiling is confirmed exact
// (see below).
const DAY_MS = 24 * 60 * 60 * 1000;

const PROVIDERS = [
  { id: 'mailgun',  dailyLimit: 100, monthlyLimit: 3000,
    // o:deliverytime, RFC 2822 with an explicit +0000 offset (NOT toUTCString(),
    // which emits "GMT"). Lookahead clamped to 3 days — confirmed EXACT via a
    // live API probe on 2026-07-16 (scripts/probe-mailgun-scheduled.mjs): a
    // real +7d send to this account/domain was rejected with "scheduled
    // delivery time must not be farther than 72h0m0s from now". Not a guess.
    scheduledSend: { param: 'o:deliverytime', maxLookaheadMs: 3 * DAY_MS } },
  { id: 'mailjet',  dailyLimit: 200, monthlyLimit: 6000  },
  // mailtrap: REMOVED FROM THE CASCADE 2026-07-29 (owner decision). Its send
  // stream is suspended: the API accepts the message, returns a message_id, and
  // delivers nothing — so every send through it was silently lost while being
  // counted as a success. Worse, Mailtrap then posts a `suspension` webhook per
  // message, which mapMailtrapEvent() used to translate into a per-SUBSCRIBER
  // suppression (see newsletterMailtrapWebhookCore.js): over 1700 subscribers,
  // more than a fifth of the base, were burned that way without a single real
  // bounce or complaint.
  // Restore this entry only once Mailtrap's stream is verified sending again
  // AND a live test send is confirmed received.
  //
  // Like resend/maileroo, its effective daily cap was read from
  // `_dynamicDailyLimits.mailtrap` — computeMailtrapDynamicDailyLimit() paced
  // against the REAL billing-cycle boundaries Mailtrap's own API returns.
  // `dailyLimit: 150` was only the pre-sync/unverifiable-usage fallback.
  // { id: 'mailtrap', dailyLimit: 150, monthlyLimit: 4000  },
  // maileroo: paid plan bumped 3000/mo → 100000/mo 2026-07-20 (owner activated
  // it explicitly to become the primary channel for newsletter + job-alert
  // volume). DKIM selector mta._domainkey.frontaliereticino.ch is published and
  // Maileroo signs DMARC-aligned. Verified 2026-06-30 with a live test send to
  // Gmail (X-Maileroo-Ref-Id 411800c3...): dkim=pass
  // header.i=@frontaliereticino.ch s=mta, spf=pass smtp.mailfrom=@frontaliereticino.ch
  // (return-path on our domain, 85.204.106.x authorized via include:_spf.maileroo.com),
  // dmarc=pass at p=reject (dis=NONE), delivered to inbox. Placed before cloudflare so
  // the three free tiny-cap providers are exhausted first at zero extra cost,
  // then maileroo's much larger paid budget absorbs the rest of the day's volume.
  //
  // Like resend (see PROVIDERS[resend] below), its effective daily cap is read
  // from `_dynamicDailyLimits.maileroo` — recomputed on every
  // syncQuotasFromAPIs() run by computeMailerooDynamicDailyLimit() as
  // (100000 − calendar-month-to-date usage) ÷ days left in the month. Maileroo
  // has no documented billing-cycle anchor day (unlike Resend's 6th-of-month),
  // so the calendar month is used directly. `dailyLimit: 3333` below
  // (100000/30, same monthlyLimit/30 convention as every other static-limit
  // provider here) is only the pre-sync/unverifiable-usage fallback — see
  // MAILEROO_CYCLE_FALLBACK_DAILY.
  { id: 'maileroo', dailyLimit: 3333, monthlyLimit: 100000,
    // scheduled_at in the JSON body, RFC 3339 (ISO 8601 is valid RFC 3339).
    // Lookahead undocumented by the provider — clamped to 3 days, same
    // conservative floor as Mailgun's default-plan cap.
    scheduledSend: { param: 'scheduled_at', maxLookaheadMs: 3 * DAY_MS } },
  // Cloudflare Email Service: reverted to the free-tier threshold 2026-07-06
  // (owner request) — dailyLimit=100, monthlyLimit=3000, superseding the
  // 2026-07-03 paid-overage bump (dailyLimit 1000/monthlyLimit 30000). Root
  // cause for the revert: cloudflare's burst-rate throttle (429 code=10004)
  // fires well below any of these daily caps (hit at ~200 sends on 2026-07-06),
  // so raising the daily cap bought no real extra headroom — it only masked
  // the fact that resend now covers the bulk volume instead.
  { id: 'cloudflare', dailyLimit: 100, monthlyLimit: 3000 },
  // Resend returned to the free plan on 2026-08-31: 100/day and 3000/month.
  // It stays last so the other providers absorb bulk volume first. The
  // effective limit is recomputed by computeResendDynamicDailyLimit() to pace
  // the monthly quota, but is always clamped to this hard 100/day ceiling.
  { id: 'resend',   dailyLimit: 100, monthlyLimit: 3000,
    // scheduled_at in the JSON body, ISO 8601 UTC. 30-day lookahead (verified docs).
    scheduledSend: { param: 'scheduled_at', maxLookaheadMs: 30 * DAY_MS } },
];

// In-memory daily counters (reset on new UTC day)
const _counters = {};
// Real successful-send counts, tracked separately from `_counters` — the latter
// also gets force-incremented to full quota when a provider is detected as
// rate-limited/exhausted (see incrementCounter call in sendSingle's catch
// branch), so it reflects "quota consumed" not "emails actually delivered".
// Conflating the two made the provider summary table (logProviderSummary)
// show e.g. "Sent: 100" for a provider that failed on its very first attempt
// and delivered zero emails this run (2026-07-07 incident).
const _realSentCounts = {};
let _counterDate = '';
let _quotasSynced = false;
// Per-run override of a provider's static dailyLimit, keyed by provider id.
// resend, maileroo, and mailtrap use this (see computeResendDynamicDailyLimit /
// computeMailerooDynamicDailyLimit / computeMailtrapDynamicDailyLimit) —
// every other provider's static PROVIDERS[].dailyLimit stays the
// pre-sync/no-key fallback.
const _dynamicDailyLimits = {};

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getCounter(providerId) {
  const today = getTodayUTC();
  if (_counterDate !== today) {
    _counterDate = today;
    for (const p of PROVIDERS) { _counters[p.id] = 0; _realSentCounts[p.id] = 0; }
    _quotasSynced = false;
  }
  return _counters[providerId] || 0;
}

function incrementCounter(providerId, count) {
  getCounter(providerId); // ensure initialized
  _counters[providerId] = Math.max(0, (_counters[providerId] || 0) + count);
}

function recordRealSent(providerId) {
  getCounter(providerId); // ensure initialized (shares the day-rollover check)
  _realSentCounts[providerId] = (_realSentCounts[providerId] || 0) + 1;
}

function remainingQuota(providerId) {
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!provider) return 0;
  // dailyLimit can be Infinity (pre-sync fallback, no key configured, or a
  // provider with no self-imposed floor); once a provider with an Infinity
  // limit gets its counter force-bumped to Infinity too (rate-limited branch
  // in sendSingle), Infinity - Infinity is NaN, and `NaN <= 0` is false —
  // that would defeat the exhaustion guard and let a genuinely rate-limited
  // provider get hammered again this run.
  const effectiveLimit = _dynamicDailyLimits[providerId] ?? provider.dailyLimit;
  const remaining = effectiveLimit - getCounter(providerId);
  return Number.isNaN(remaining) ? 0 : Math.max(0, remaining);
}

// ── Real quota sync via provider APIs ────────────────────────

// Bounds every quota-check fetch below — all run concurrently inside
// syncQuotasFromAPIs()'s Promise.all, on a cold start, under the 30s Cloud
// Run timeout of interactive callers like newsletterSendConfirmation. An
// unbounded fetch stalling past that ceiling produces a raw platform 504
// (bypasses the app's cors:true wrapper entirely, so no CORS header — not a
// clean error response). Same convention as PROVIDER_TIMEOUT_MS in
// chatbotInference.js/geminiGenerate.js.
const QUOTA_FETCH_TIMEOUT_MS = 8000;

async function fetchMailgunDailyUsage() {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || 'frontaliereticino.ch';
  if (!apiKey) return 0;
  try {
    const res = await fetch(
      `https://api.eu.mailgun.net/v3/${domain}/stats/total?event=accepted&duration=1d`,
      {
        headers: { Authorization: 'Basic ' + Buffer.from('api:' + apiKey).toString('base64') },
        signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    // duration=1d without an explicit start/end aligns buckets to UTC calendar
    // days, so a rolling 24h window that straddles midnight UTC returns TWO
    // entries in `stats[]` (yesterday's partial day + today's). Reading only
    // stats[0] silently picked the older bucket and under-reported usage —
    // sum every bucket in the window instead.
    return (data.stats || []).reduce((sum, s) => sum + (s.accepted?.outgoing || 0), 0);
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
      { headers: { Authorization: 'Basic ' + auth }, signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS) }
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

// Shared account-id lookup for both fetchMailtrapDailyUsage and
// fetchMailtrapCycleUsage below (Mailtrap's API is account-scoped, not
// domain-scoped like the other providers).
async function fetchMailtrapAccountId(token) {
  const accRes = await fetch('https://mailtrap.io/api/accounts', {
    headers: { 'Api-Token': token },
    signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
  });
  if (!accRes.ok) return null;
  const accounts = await accRes.json();
  return accounts[0]?.id ?? null;
}

export async function fetchMailtrapDailyUsage() {
  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) return 0;
  try {
    const accountId = await fetchMailtrapAccountId(token);
    if (!accountId) return 0;

    // Fetch today's stats
    const today = getTodayUTC();
    const statsRes = await fetch(
      `https://mailtrap.io/api/accounts/${accountId}/stats?start_date=${today}&end_date=${today}`,
      { headers: { 'Api-Token': token }, signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS) },
    );
    if (!statsRes.ok) return 0;
    const stats = await statsRes.json();
    // The daily quota (150/day) is consumed at SEND time, but delivery_count
    // tracks confirmed *deliveries*, which arrive asynchronously and lag the
    // sends heavily (observed: delivery_count=1 after 31 real sends). Gating on
    // it under-counts → over-send → 403 burst. sent_count was meant to reflect
    // accepted sends in real time as a Math.max() safety net — VERIFIED LIVE
    // 2026-07-20 that this account's /stats response never actually contains a
    // sent_count key at all (30 days checked, always absent), so `sent` below
    // is always 0 and this safety net was silently defeated: delivery_count
    // stayed at 0 every day this week despite the account having 1220 real
    // sends this billing cycle (confirmed via /billing/usage, see
    // fetchMailtrapCycleUsage). This function's daily figure is therefore
    // still just a best-effort, likely-zero signal — the REAL safety net is
    // now computeMailtrapDynamicDailyLimit's billing-cycle pacer below, same
    // fix shape as Resend/Maileroo.
    const sent = Number(stats.sent_count) || 0;
    const resolved = (Number(stats.delivery_count) || 0) + (Number(stats.bounce_count) || 0);
    return Math.max(sent, resolved);
  } catch { return 0; }
}

// Mailtrap's /billing/usage endpoint (undocumented in the original
// integration, discovered 2026-07-20 while auditing all providers' real-usage
// calculations) exposes the ACTUAL account-wide sent count for the current
// billing cycle, plus the cycle's exact start/end — unlike Resend/Maileroo,
// no anchor-day guessing needed, the API gives the real boundaries directly.
// GET https://mailtrap.io/api/accounts/{id}/billing/usage →
//   { billing: { cycle_start, cycle_end },
//     sending: { usage: { sent_messages_count: { current, limit } } }, ... }
// (also carries `testing` and `marketing` plan usage, not used here — this
// cascade only ever sends via the `sending` plan/API).
export async function fetchMailtrapCycleUsage() {
  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) return { count: 0, verified: false };
  try {
    const accountId = await fetchMailtrapAccountId(token);
    if (!accountId) return { count: 0, verified: false };
    const res = await fetch(`https://mailtrap.io/api/accounts/${accountId}/billing/usage`, {
      headers: { 'Api-Token': token },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { count: 0, verified: false };
    const data = await res.json().catch(() => null);
    const usage = data?.sending?.usage?.sent_messages_count;
    const cycleStartRaw = data?.billing?.cycle_start;
    const cycleEndRaw = data?.billing?.cycle_end;
    if (!usage || typeof usage.current !== 'number' || !cycleStartRaw || !cycleEndRaw) {
      return { count: 0, verified: false };
    }
    const cycleStart = new Date(cycleStartRaw);
    const cycleEnd = new Date(cycleEndRaw);
    if (Number.isNaN(cycleStart.getTime()) || Number.isNaN(cycleEnd.getTime())) {
      return { count: 0, verified: false };
    }
    return { count: usage.current, apiLimit: usage.limit, cycleStart, cycleEnd, verified: true };
  } catch { return { count: 0, verified: false }; }
}

// Pre-2026-07-20 self-imposed floor (the existing static dailyLimit). Used
// only when cycle usage is unverifiable — never Infinity, since an
// unverifiable usage lookup must fail safe, not open.
const MAILTRAP_CYCLE_FALLBACK_DAILY = 150;

/**
 * Dynamic per-day Mailtrap send budget, same shape as
 * computeResendDynamicDailyLimit / computeMailerooDynamicDailyLimit:
 * (4000 − cycle-to-date usage) ÷ days left in Mailtrap's own billing cycle
 * (read directly from the API, not guessed). Falls back to the conservative
 * MAILTRAP_CYCLE_FALLBACK_DAILY floor when usage can't be verified.
 */
async function computeMailtrapDynamicDailyLimit(nowMs = Date.now()) {
  const provider = PROVIDERS.find(p => p.id === 'mailtrap');
  // mailtrap is no longer in PROVIDERS (see the commented-out entry). Nothing
  // calls this today, but it is still exported, and dereferencing the missing
  // provider below is exactly the throw that would have failed every send when
  // it was still wired into syncQuotasFromAPIs. Guard rather than leave the
  // same landmine for whoever re-enables the provider.
  if (!provider) return MAILTRAP_CYCLE_FALLBACK_DAILY;
  const { count, apiLimit, cycleStart, cycleEnd, verified } = await fetchMailtrapCycleUsage();
  if (!verified) {
    console.warn(`⚠️  [mailtrap] billing-cycle usage unverifiable — falling back to conservative ${MAILTRAP_CYCLE_FALLBACK_DAILY}/day floor`);
    return MAILTRAP_CYCLE_FALLBACK_DAILY;
  }
  if (apiLimit && apiLimit !== provider.monthlyLimit) {
    console.warn(`⚠️  [mailtrap] live plan limit (${apiLimit}) differs from configured monthlyLimit (${provider.monthlyLimit}) — update PROVIDERS`);
  }
  // Use the live apiLimit when available, not the possibly-stale static
  // config — a plan downgrade would otherwise pace against a higher number
  // than the account actually has (review finding, PR #4583).
  const cap = apiLimit || provider.monthlyLimit;
  const daysRemaining = Math.max(1, Math.ceil((cycleEnd.getTime() - nowMs) / DAY_MS));
  const remainingBudget = Math.max(0, cap - count);
  const dynamicLimit = Math.floor(remainingBudget / daysRemaining);
  console.log(`   [mailtrap] cycle ${cycleStart.toISOString().slice(0, 10)}→${cycleEnd.toISOString().slice(0, 10)}: used=${count}/${cap}, daysRemaining=${daysRemaining}, dynamic dailyLimit=${dynamicLimit}`);
  return dynamicLimit;
}

// Resend's REST API has no date-range filter, no total-count field, and no
// separate usage/billing/analytics endpoint (verified against live Resend
// docs 2026-07-16) — the only way to get real usage, for a single day OR a
// full billing cycle, is to page through /emails (newest-first) until an
// entry older than the boundary appears. Shared by fetchResendDailyUsage
// (today) and fetchResendCycleUsage (billing-cycle-to-date) so both stay in
// sync instead of duplicating the same pagination logic.
//
// truncated:true means the page cap was hit before reaching `sinceMs` — the
// returned count is a LOWER BOUND only, never safe to send against as-is.
//
// Wall-clock ceiling for the whole loop, on top of maxPages — maxPages alone
// (up to ~2900 for the cycle-usage caller) still lets a slow-but-not-failing
// per-page fetch blow well past the 30s Cloud Run timeout of interactive
// callers. Both fetchResendDailyUsage and fetchResendCycleUsage run this
// loop concurrently (separate Promise.all branches in syncQuotasFromAPIs),
// so this bounds each independently, not additively. Hitting the deadline
// mid-loop degrades the same safe way as hitting maxPages: truncated:true,
// lower-bound count.
const RESEND_PAGING_DEADLINE_MS = 12000;

async function fetchResendEntriesSince(sinceMs, maxPages) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { count: 0, truncated: false };
  const deadline = Date.now() + RESEND_PAGING_DEADLINE_MS;
  try {
    let count = 0;
    let after;
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() >= deadline) return { count, truncated: true };
      const url = new URL('https://api.resend.com/emails');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { count, truncated: true };
      const data = await res.json();
      const entries = data.data || [];
      if (entries.length === 0) return { count, truncated: false };
      let hitOlder = false;
      for (const e of entries) {
        const t = e.created_at ? new Date(e.created_at).getTime() : NaN;
        if (Number.isFinite(t) && t >= sinceMs) {
          count++;
        } else {
          hitOlder = true;
          break;
        }
      }
      if (hitOlder || !data.has_more) return { count, truncated: false };
      after = entries[entries.length - 1]?.id;
      if (!after) return { count, truncated: false };
    }
    return { count, truncated: true };
  } catch { return { count: 0, truncated: true }; }
}

async function fetchResendDailyUsage() {
  if (!process.env.RESEND_API_KEY) return 0;
  const todayStartMs = new Date(getTodayUTC() + 'T00:00:00.000Z').getTime();
  // Keep the established paging ceiling even though the free-plan daily cap
  // is now 100. The early exit at today's boundary makes the normal request
  // count small, while the higher safety ceiling still avoids undercounting
  // usage if account history and plan state temporarily disagree.
  const { count, truncated } = await fetchResendEntriesSince(todayStartMs, 60);
  if (truncated) {
    console.warn('⚠️  [resend] today-usage paging truncated at 60 pages — real count may be higher than reported');
  }
  return count;
}

// This account's Resend quota cycle is anchored on the 6th of each month,
// not the calendar month.
const RESEND_CYCLE_ANCHOR_DAY = 6;

// Pure — handles year/month rollover for the day-6-anchored billing cycle.
function resendCycleBounds(nowMs) {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const beforeAnchor = d < RESEND_CYCLE_ANCHOR_DAY;
  const startY = beforeAnchor && m === 0 ? y - 1 : y;
  const startM = beforeAnchor ? (m === 0 ? 11 : m - 1) : m;
  const cycleStart = new Date(Date.UTC(startY, startM, RESEND_CYCLE_ANCHOR_DAY));
  const cycleEnd = new Date(Date.UTC(startY, startM + 1, RESEND_CYCLE_ANCHOR_DAY));
  return { cycleStart, cycleEnd };
}

/**
 * Billing-cycle-to-date Resend send count (cycle anchored on the 6th of each
 * month). truncated:true means the count is a lower bound only — see
 * fetchResendEntriesSince.
 */
export async function fetchResendCycleUsage(nowMs = Date.now()) {
  const provider = PROVIDERS.find(p => p.id === 'resend');
  const { cycleStart, cycleEnd } = resendCycleBounds(nowMs);
  // Safety ceiling only — real paging cost scales with actual cycle-to-date
  // volume via the early-exit at the cycle-start boundary, not this number.
  const maxPages = Math.max(60, Math.ceil((provider.monthlyLimit * 2) / 100));
  const { count, truncated } = await fetchResendEntriesSince(cycleStart.getTime(), maxPages);
  return { count, truncated, cycleStart, cycleEnd };
}

/**
 * Dynamic per-day Resend send budget for the free plan. It paces the 3000/mo
 * quota across the days left in the account cycle and clamps the result to the
 * provider's hard 100/day ceiling. If cycle usage cannot be verified, the
 * same 100/day ceiling is the safe fallback.
 */
async function computeResendDynamicDailyLimit(nowMs = Date.now()) {
  const provider = PROVIDERS.find(p => p.id === 'resend');
  const { count, truncated, cycleStart, cycleEnd } = await fetchResendCycleUsage(nowMs);
  if (truncated) {
    console.warn(`⚠️  [resend] quota-cycle usage unverifiable — falling back to the ${provider.dailyLimit}/day free-plan ceiling`);
    return provider.dailyLimit;
  }
  const daysRemaining = Math.max(1, Math.ceil((cycleEnd.getTime() - nowMs) / DAY_MS));
  const remainingBudget = Math.max(0, provider.monthlyLimit - count);
  const dynamicLimit = Math.min(provider.dailyLimit, Math.floor(remainingBudget / daysRemaining));
  console.log(`   [resend] cycle ${cycleStart.toISOString().slice(0, 10)}→${cycleEnd.toISOString().slice(0, 10)}: used=${count}/${provider.monthlyLimit}, daysRemaining=${daysRemaining}, dynamic dailyLimit=${dynamicLimit}`);
  return dynamicLimit;
}

// ── Maileroo Account API (statistics) ────────────────────────
// Docs: https://maileroo.com/docs/api-reference/statistics/summary
// GET https://api.maileroo.com/v1/statistics/summary — aggregates the
// CURRENT CALENDAR MONTH only (no date-range params, no billing-cycle anchor
// day like Resend's). Docs list the required scope as `statistics.read`
// under a distinct "Account API" section, separate from the sending-key auth
// used by sendViaMaileroo — unconfirmed whether MAILEROO_API_KEY (a Domain
// Sending Key) carries that scope. Tried with the same X-Api-Key header as
// the send endpoint (the only credential this integration has); a 401/403
// here just means the key lacks the scope and callers fall back to the
// conservative static floor below — never a hard failure either way.
//
// The response has no raw "sent"/"accepted" counter, only terminal
// delivery-outcome fields (`delivered`, `bounced`, `opens`, `clicks`,
// `suppressions`) — delivered+bounced is used as the usage proxy (both
// consume plan quota), which under-counts sends still in flight/queued.
// Acceptable here because this is a PACING signal, not the hard quota
// enforcement: Maileroo's own API rejection (caught by isRateLimitedError
// in sendSingle) is still the real backstop if this proxy under-counts.
export async function fetchMailerooCycleUsage(nowMs = Date.now()) {
  // Verified live 2026-07-20: this Account API endpoint rejects the X-Api-Key
  // header the send endpoint uses (401 "Please provide a valid API key in the
  // Authorization header") — it wants `Authorization: Bearer <key>` instead.
  // Also verified our sending key (MAILEROO_API_KEY, a per-domain Sending Key)
  // is NOT valid here even with the correct header shape (401 "invalid or
  // revoked") — the Account API needs its own key, generated under
  // Maileroo's "Applications" dashboard section, not provisioned yet.
  // MAILEROO_ACCOUNT_API_KEY is tried first when set; MAILEROO_API_KEY is
  // tried as a fallback in case a future account/key setup grants it the
  // statistics.read scope directly. Either way a 401 degrades safely below.
  const apiKey = process.env.MAILEROO_ACCOUNT_API_KEY || process.env.MAILEROO_API_KEY;
  if (!apiKey) return { count: 0, verified: false };
  try {
    const res = await fetch('https://api.maileroo.com/v1/statistics/summary', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { count: 0, verified: false };
    const data = await res.json().catch(() => null);
    const agg = data?.data?.aggregate;
    if (!agg || typeof agg !== 'object') return { count: 0, verified: false };
    const count = (Number(agg.delivered) || 0) + (Number(agg.bounced) || 0);
    return { count, verified: true };
  } catch { return { count: 0, verified: false }; }
}

// Pre-2026-07-20 self-imposed floor (100000/30, months-average). Used only
// when calendar-month usage is unverifiable (no statistics.read scope on
// this key / network error) — never Infinity, since an unverifiable usage
// lookup must fail safe, not open.
const MAILEROO_CYCLE_FALLBACK_DAILY = 3333;

/**
 * Dynamic per-day Maileroo send budget that paces the 100k/mo quota, mirroring
 * computeResendDynamicDailyLimit but against a plain calendar month (Maileroo
 * documents no billing-cycle anchor day): (100000 − month-to-date usage) ÷
 * days left in the current UTC month. Falls back to the conservative
 * MAILEROO_CYCLE_FALLBACK_DAILY floor when usage can't be verified.
 */
async function computeMailerooDynamicDailyLimit(nowMs = Date.now()) {
  const provider = PROVIDERS.find(p => p.id === 'maileroo');
  const { count, verified } = await fetchMailerooCycleUsage(nowMs);
  if (!verified) {
    console.warn(`⚠️  [maileroo] calendar-month usage unverifiable (no statistics.read scope on this key, or API error) — falling back to conservative ${MAILEROO_CYCLE_FALLBACK_DAILY}/day floor`);
    return MAILEROO_CYCLE_FALLBACK_DAILY;
  }
  const now = new Date(nowMs);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysRemaining = Math.max(1, Math.ceil((monthEnd.getTime() - nowMs) / DAY_MS));
  const remainingBudget = Math.max(0, provider.monthlyLimit - count);
  const dynamicLimit = Math.floor(remainingBudget / daysRemaining);
  console.log(`   [maileroo] month-to-date: used≈${count}/${provider.monthlyLimit} (delivered+bounced proxy), daysRemaining=${daysRemaining}, dynamic dailyLimit=${dynamicLimit}`);
  return dynamicLimit;
}

async function fetchMailerooDailyUsage() {
  // No true "today only" figure is exposed (statistics/summary aggregates the
  // whole calendar month) — the in-memory counter alone gates TODAY's sends,
  // same limitation as before 2026-07-20 (may overshoot slightly across
  // separate runs on the same day, same as the fallback behaviour of every
  // other provider on API error). What changed: the daily LIMIT it's gated
  // against is no longer a flat monthlyLimit/30 guess — see
  // computeMailerooDynamicDailyLimit / _dynamicDailyLimits.maileroo below,
  // which prices in real month-to-date consumption when the key's scope
  // allows it.
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
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS) },
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
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
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
  // Only providers actually in PROVIDERS are synced. mailtrap was removed from
  // the cascade (see the PROVIDERS entry) and syncing it here used to throw:
  // computeMailtrapDynamicDailyLimit() looks the provider up in PROVIDERS and
  // dereferences `.monthlyLimit`, which is undefined once the entry is gone.
  // That throw propagated out of syncQuotasFromAPIs — which sendEmailCascade
  // awaits — so it would have failed EVERY send, not just mailtrap's. It stayed
  // invisible in tests because the dereference only happens when the provider
  // API returns a plan limit, which the mocks never did; it surfaced only when
  // run against real credentials.
  const [mailgun, mailjet, resend, maileroo, cloudflare, resendDynamicLimit, mailerooDynamicLimit] = await Promise.all([
    fetchMailgunDailyUsage(),
    fetchMailjetDailyUsage(),
    fetchResendDailyUsage(),
    fetchMailerooDailyUsage(),
    fetchCloudflareDailyUsage(),
    computeResendDynamicDailyLimit(),
    computeMailerooDynamicDailyLimit(),
  ]);

  _counterDate = getTodayUTC();
  _counters.mailgun = mailgun;
  _counters.mailjet = mailjet;
  _counters.resend = resend;
  _counters.maileroo = maileroo;
  _counters.cloudflare = cloudflare;
  _dynamicDailyLimits.resend = resendDynamicLimit;
  _dynamicDailyLimits.maileroo = mailerooDynamicLimit;
  _quotasSynced = true;

  // Optional-chained on purpose: a provider removed from PROVIDERS must degrade
  // to an unknown limit in a log line, never throw inside the send path.
  const limit = id => _dynamicDailyLimits[id] ?? PROVIDERS.find(p => p.id === id)?.dailyLimit ?? '—';
  const usage = PROVIDERS.map(p => `${p.id}=${_counters[p.id] ?? 0}/${limit(p.id)}`).join(', ');
  console.log(`   Usage today: ${usage}`);
}

// ── Provider availability check ──────────────────────────────

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'mailjet':    return !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY);
    case 'mailgun':    return !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
    case 'mailtrap':   return !!process.env.MAILTRAP_API_TOKEN;
    case 'maileroo':   return !!process.env.MAILEROO_API_KEY;
    case 'resend':     return !!process.env.RESEND_API_KEY;
    case 'cloudflare': return !!(cloudflareToken() && cloudflareAccountId());
    default: return false;
  }
}

// ── Scheduled-send (per-message) ─────────────────────────────
// Feature #3798: an email payload may carry an optional `scheduledAt` (ISO
// 8601 UTC string) requesting a provider-side delayed send. Only providers
// with a `scheduledSend` capability entry in PROVIDERS support it.

/**
 * Whether the given provider supports provider-side scheduled send at all
 * (regardless of whether a particular message's scheduledAt is usable).
 * @param {string} providerId
 * @returns {boolean}
 */
export function providerSupportsScheduledSend(providerId) {
  return !!PROVIDERS.find(p => p.id === providerId)?.scheduledSend;
}

// Anti-race margin: a scheduledAt this close to "now" (or in the past) is
// sent immediately instead — avoids handing a provider a timestamp that may
// already have elapsed by the time the HTTP request lands.
const SCHEDULE_MIN_LEAD_MS = 2 * 60 * 1000;

// Tracks which providers already got a "clamped to immediate" warning this
// process, so a large batch that all exceeds the same provider's lookahead
// logs it ONCE instead of once per email.
const _scheduleClampWarned = new Set();

/**
 * Resolve the Date to actually schedule `email.scheduledAt` for with `provider`,
 * or null when the send should go out immediately instead. Immediate-send
 * (null) cases: scheduledAt absent/unparsable; in the past or under the
 * SCHEDULE_MIN_LEAD_MS anti-race margin; beyond the provider's max lookahead
 * (logged once via console.warn, not per-email); or provider has no
 * scheduledSend support at all.
 * @param {{ scheduledAt?: string }} email
 * @param {{ id: string, scheduledSend?: { param: string, maxLookaheadMs: number } }} provider
 * @returns {Date|null}
 */
function resolveScheduledAt(email, provider) {
  const cap = provider?.scheduledSend;
  if (!cap) return null;
  const raw = email?.scheduledAt;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;

  const now = Date.now();
  if (d.getTime() < now + SCHEDULE_MIN_LEAD_MS) return null;

  if (d.getTime() - now > cap.maxLookaheadMs) {
    if (!_scheduleClampWarned.has(provider.id)) {
      _scheduleClampWarned.add(provider.id);
      const maxDays = Math.round(cap.maxLookaheadMs / DAY_MS);
      console.warn(`⚠️  [${provider.id}] scheduledAt beyond the ${maxDays}-day max lookahead — clamped to immediate send (this warning is logged once per provider per run)`);
    }
    return null;
  }

  return d;
}

/**
 * Format a Date as the RFC 2822 timestamp Mailgun's `o:deliverytime` expects,
 * with an EXPLICIT "+0000" offset. Deliberately NOT `date.toUTCString()`,
 * which emits the literal string "GMT" instead of a numeric offset — Mailgun's
 * docs example uses "+0000" and the numeric form is what's verified to parse.
 * @param {Date} date
 * @returns {string} e.g. "Sun, 12 Jul 2026 08:05:00 +0000"
 */
function toRfc2822Utc(date) {
  const dayName = RFC2822_DAY_NAMES[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const monthName = RFC2822_MONTH_NAMES[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${dayName}, ${day} ${monthName} ${year} ${hh}:${mm}:${ss} +0000`;
}

const RFC2822_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC2822_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Transport-level ambiguity guard ──────────────────────────
// fetch() throwing (network drop, DNS failure, or an AbortSignal firing
// mid-request) means we never got an HTTP response at all — unlike the
// provider replying with an explicit 4xx/5xx, which tells us definitively
// "not delivered, safe to cascade to the next provider". A transport failure
// could just as easily mean the provider fully received and queued the
// message but the ack never made it back (timeout/5xx-after-accept, #4911):
// sendSingle below must NOT fall back to another provider in that case, or a
// message that already went out gets sent again. Every sendVia* fetch() call
// below goes through this wrapper so that ambiguity is tagged, not lost.
async function fetchOrTagAmbiguous(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    const wrapped = new Error(`no response received (network/timeout) — delivery status unknown: ${err.message}`);
    wrapped.ambiguousDelivery = true;
    throw wrapped;
  }
}

// ── Mailjet API (v3.1) ──────────────────────────────────────
// Docs: https://dev.mailjet.com/email/guides/send-api-v31/

async function sendViaMailjet(email, _scheduledAt, signal) {
  // Mailjet Send API v3.1 has no scheduled-send parameter — _scheduledAt is
  // accepted for signature parity with the other 5 send fns but unused.
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  const fromParsed = parseEmailAddress(email.from);

  const res = await fetchOrTagAmbiguous('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    signal,
    body: JSON.stringify({
      Messages: [{
        From: { Email: fromParsed.email, Name: fromParsed.name || undefined },
        To: (Array.isArray(email.to) ? email.to : [email.to]).map(addr => ({ Email: addr })),
        Subject: email.subject,
        HTMLPart: email.html,
        TextPart: email.text || undefined,
        CustomID: campaignIdTag(email),
        // Forward custom email headers (List-Unsubscribe, etc.) — parity with
        // the other 5 providers, all of which already forward email.headers.
        Headers: (email.headers && typeof email.headers === 'object') ? email.headers : undefined,
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

async function sendViaMailgun(email, scheduledAt, signal) {
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
  // Opens (pixel) stay on for engagement scoring. Click tracking rewrites
  // links through Mailgun's tracking domain; callers may opt out per-message
  // with `tracking: false` (e.g. win-back CTAs that must point directly to
  // our canonical https origin). Mailgun is the FIRST provider in the cascade,
  // so this gate is what actually honors `tracking: false` on the primary path.
  form.append('o:tracking', 'yes');
  form.append('o:tracking-clicks', email.tracking !== false ? 'yes' : 'no');
  form.append('o:tracking-opens', 'yes');
  if (email.tags?.length) {
    // Mailgun's API caps `o:tag` at 3 per message (docs, not the Help
    // Center's unrelated 10-tag figure); anything past the 3rd is silently
    // dropped server-side. `v:campaign_id` below carries campaign attribution
    // separately, so this cap only affects the filter/analytics tags.
    for (const tag of email.tags.slice(0, 3)) form.append('o:tag', tag.value);
    // `o:tag` is a flat list of VALUES — the name is lost in transit, so the
    // webhook could only guess which of ["welcome_job","lifecycle","en"] was
    // the campaign. It guessed by looking for a `campaign:` prefix that this
    // sender never produced, so every Mailgun event fell through to the raw
    // message id instead (measured 2026-08-20, same defect class as Maileroo's
    // array tags). A custom variable keeps the NAME, so the webhook can read it
    // back by key: see extractCampaignId in newsletterMailgunWebhookCore.js.
    const campaignId = campaignIdTag(email);
    if (campaignId) form.append('v:campaign_id', campaignId);
  }
  // Forward custom email headers (List-Unsubscribe, etc.)
  if (email.headers && typeof email.headers === 'object') {
    for (const [key, value] of Object.entries(email.headers)) {
      form.append(`h:${key}`, value);
    }
  }
  // Per-message scheduled send (feature #3798). RFC 2822 with an explicit
  // "+0000" offset — see toRfc2822Utc(). Omitted entirely (no key at all)
  // when resolveScheduledAt found no usable scheduledAt, so an unscheduled
  // send's form body is byte-identical to before this feature.
  if (scheduledAt) form.append('o:deliverytime', toRfc2822Utc(scheduledAt));

  const res = await fetchOrTagAmbiguous(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form,
    signal,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mailgun ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  return { messageId: data?.id || `mg-${Date.now()}`, provider: 'mailgun' };
}

// ── Mailtrap Send API ────────────────────────────────────────
// Docs: https://api-docs.mailtrap.io/docs/mailtrap-api-docs/

async function sendViaMailtrap(email, _scheduledAt, signal) {
  // Mailtrap's transactional Send API has no scheduled-send parameter —
  // _scheduledAt is accepted for signature parity but unused.
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

  const res = await fetchOrTagAmbiguous('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
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

async function sendViaMaileroo(email, scheduledAt, signal) {
  const apiKey = process.env.MAILEROO_API_KEY;
  const fromParsed = parseEmailAddress(email.from);

  const body = {
    from: { address: fromParsed.email, display_name: fromParsed.name || undefined },
    to: (Array.isArray(email.to) ? email.to : [email.to]).map(addr => ({ address: addr })),
    subject: email.subject,
    html: email.html,
    // Opens (pixel) stay on for engagement scoring. Click tracking rewrites
    // links through Maileroo's tracking domain; callers may opt out per-message
    // with `tracking: false` (e.g. win-back CTAs that must point directly to
    // our canonical https origin). Mirrors Mailgun's o:tracking-clicks behaviour.
    tracking: email.tracking !== false,
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
  // Per-message scheduled send (feature #3798), RFC 3339 (ISO 8601 is valid
  // RFC 3339). Omitted entirely when resolveScheduledAt found no usable
  // scheduledAt, so an unscheduled send's body is byte-identical to before.
  if (scheduledAt) body.scheduled_at = scheduledAt.toISOString();

  const res = await fetchOrTagAmbiguous('https://smtp.maileroo.com/api/v2/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
    signal,
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

async function sendViaResend(email, scheduledAt, signal) {
  const apiKey = process.env.RESEND_API_KEY;
  const body = {
    from: email.from,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text || undefined,
    headers: email.headers || undefined,
    tags: email.tags || undefined,
    reply_to: email.replyTo || undefined,
    // Base64-encoded attachment content, Resend's native shape — cascade-wide
    // attachment support isn't built (only Resend needs it today), so callers
    // sending `email.attachments` MUST pass `opts.forceProvider: 'resend'` to
    // sendEmailCascade — every other sendVia* fn silently ignores this field,
    // which would ship an attachment-less email on fallback.
    attachments: email.attachments || undefined,
    // Opens (pixel) stay on for engagement scoring. Click tracking rewrites
    // links through Resend's tracking domain; callers may opt out per-message
    // with `tracking: false` (e.g. win-back CTAs that must point directly to
    // our canonical https origin). Mirrors Mailgun's o:tracking-clicks behaviour.
    click_tracking: email.tracking !== false,
    open_tracking: true,
  };
  // Per-message scheduled send (feature #3798), ISO 8601 UTC. Omitted
  // entirely (no key at all, not even `undefined`) when resolveScheduledAt
  // found no usable scheduledAt, so an unscheduled send's body is
  // byte-identical to before this feature.
  if (scheduledAt) body.scheduled_at = scheduledAt.toISOString();

  const res = await fetchOrTagAmbiguous('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
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

async function sendViaCloudflare(email, _scheduledAt, signal) {
  // Cloudflare Email Service has no scheduled-send parameter — _scheduledAt is
  // accepted for signature parity but unused.
  const accountId = cloudflareAccountId();
  const token = cloudflareToken();

  const body = {
    from: cloudflareAddress(email.from),
    to: (Array.isArray(email.to) ? email.to : [email.to]).map(cloudflareAddress),
    subject: email.subject,
    html: email.html,
  };
  if (email.text) body.text = email.text;
  // Forward custom email headers, MINUS Feedback-ID: the Cloudflare Email
  // Sending REST API rejects a `Feedback-ID` header with code 10202
  // (email.invalid) and fails the whole send. Every other header we set
  // (List-Unsubscribe family, List-ID, X-Entity-Ref-ID, X-Campaign-Id,
  // X-Auto-Response-Suppress) is accepted — verified live 2026-06-18 — so strip
  // only Feedback-ID and keep the deliverability headers.
  if (email.headers && typeof email.headers === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(email.headers).filter(([k]) => k.toLowerCase() !== 'feedback-id'),
    );
    if (Object.keys(filtered).length > 0) body.headers = filtered;
  }

  const res = await fetchOrTagAmbiguous(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!res.ok) {
    // code=10004 (email.sending.error.throttled) is a short burst-window
    // rate limit, distinct from quota-exceeded — caught by
    // isSoftThrottleError → provider cools down briefly instead of being
    // retired for the rest of the run. Other 429/403 bodies still go
    // through isRateLimitedError → hard exhaustion.
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
  resend: sendViaResend,
  cloudflare: sendViaCloudflare,
};

/**
 * Send a single email via the first available provider with remaining quota.
 * @param {Object} email - Email payload (may carry an optional `scheduledAt`)
 * @param {string} [forceProvider] - If set, only use this specific provider
 * @returns {{ messageId: string, provider: string, scheduledFor: string|null }}
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
  if (isSoftThrottleError(msg)) return false;
  if (msg.includes('429')) return true;
  if (msg.includes('403') &&
      /reached[^"]{0,40}(limit|quota|cap|messages)|rate.?limit|too many|quota|limit of/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Detect a transient burst-window throttle (Cloudflare code 10004,
 * "email.sending.error.throttled") as opposed to real quota exhaustion.
 * Cloudflare can return this well before its documented daily/monthly cap
 * is reached, and it clears after a short cooldown — treating it like
 * isRateLimitedError permanently benches a provider that still has quota
 * to spare (root cause of the 2026-07-04 mass-failure: cloudflare hit
 * this at send #100/1000 and every other provider was already at its
 * daily cap, so the rest of the run had nothing left to fall back to).
 */
function isSoftThrottleError(msg) {
  return !!msg && /code=10004\b|email\.sending\.error\.throttled/i.test(msg);
}

/**
 * Explicit HTTP rejections that are safe to retry more slowly. Transport-level
 * failures are deliberately excluded: fetchOrTagAmbiguous marks those as
 * ambiguousDelivery because the provider may already have accepted the email.
 * Cloudflare code=10004 keeps its established 30s cooldown instead of being
 * retried inside the same run.
 */
function isAdaptiveThrottleRetry(error) {
  if (!error || error.ambiguousDelivery || isSoftThrottleError(error.message)) return false;
  // Provider errors have the stable "Provider STATUS: body" shape. Anchor the
  // status there so a number in the response body (for example a 500-message
  // quota described by an HTTP 403) cannot accidentally look retryable.
  return /^[A-Za-z][A-Za-z0-9_-]* (?:408|425|429|5\d\d)\b/.test(String(error.message || ''));
}

function createAdaptiveThrottleController(config, initialDelayMs, lastSendMap) {
  if (!config) return null;
  const stepMs = Number(config.stepMs);
  const maxDelayMs = Number(config.maxDelayMs);
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0
      || !Number.isFinite(stepMs) || stepMs <= 0
      || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('invalid adaptiveThrottle configuration');
  }

  const providerState = new Map();
  const stateFor = (providerId) => {
    if (!providerState.has(providerId)) {
      providerState.set(providerId, { delayMs: initialDelayMs, escalations: 0 });
    }
    return providerState.get(providerId);
  };

  return {
    delayFor(providerId) {
      return stateFor(providerId).delayMs;
    },
    async retryAfter(providerId, error) {
      if (!isAdaptiveThrottleRetry(error)) return false;
      const state = stateFor(providerId);
      const nextDelayMs = Math.min(maxDelayMs, state.delayMs + stepMs);
      if (nextDelayMs === state.delayMs) return false;

      const previousDelayMs = state.delayMs;
      state.delayMs = nextDelayMs;
      state.escalations += 1;
      const now = Date.now();
      const retryAt = Math.max(lastSendMap[providerId] || 0, now + nextDelayMs);
      lastSendMap[providerId] = retryAt + nextDelayMs;
      console.warn(
        `⏱️  ${providerId} adaptive throttle ${previousDelayMs}→${nextDelayMs}ms after: ${String(error.message || error).slice(0, 120)}`,
      );
      const waitMs = retryAt - now;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return true;
    },
    snapshot() {
      return {
        initialDelayMs,
        maxDelayMs,
        stepMs,
        providers: Object.fromEntries(providerState),
      };
    },
  };
}

// Short cooldown for soft-throttled providers (mirrors the AI-model
// provider cooldown in ai-models.mjs) — provider skipped for a bit,
// quota counter left untouched so it resumes once the burst window clears.
// Deliberately NOT retried-with-wait even when it's the sole remaining
// provider with quota left (2026-07-07 review): waiting out the cooldown
// and re-hitting the same endpoint is exactly the hammering behaviour this
// cooldown was introduced to stop, and CF's REST error body carries no
// Retry-After we could honor instead of guessing — see
// tests/email-cascade-burst.test.ts "cools down cloudflare after a code=10004
// soft throttle" for the invariant this preserves (skip immediately, no
// retry within the same run).
const PROVIDER_COOLDOWN_MS = 30_000;
const _providerCooldownUntil = {};

function cooldownProvider(providerId) {
  _providerCooldownUntil[providerId] = Date.now() + PROVIDER_COOLDOWN_MS;
  console.warn(`🧊 ${providerId} cooled down for ${PROVIDER_COOLDOWN_MS / 1000}s (throttled, quota untouched)`);
}

function isProviderCoolingDown(providerId) {
  return (_providerCooldownUntil[providerId] || 0) > Date.now();
}

async function sendSingle(email, forceProvider, finalizeForProvider, signal, adaptiveThrottle) {
  const errors = [];
  const providers = forceProvider
    ? PROVIDERS.filter(p => p.id === forceProvider)
    : PROVIDERS;

  for (const provider of providers) {
    if (!isProviderConfigured(provider.id)) { errors.push(`[${provider.id}] not configured`); continue; }
    if (remainingQuota(provider.id) <= 0) { errors.push(`[${provider.id}] quota exhausted (${getCounter(provider.id)}/${provider.dailyLimit})`); continue; }
    if (isProviderCoolingDown(provider.id)) {
      const waitMs = (_providerCooldownUntil[provider.id] || 0) - Date.now();
      errors.push(`[${provider.id}] cooling down${waitMs > 0 ? ` (${Math.ceil(waitMs / 1000)}s left)` : ''}`);
      continue;
    }

    // Reserve one quota slot synchronously, before the first await in the send
    // attempt. Without this reservation, concurrent workers can all observe
    // the same final slot and overshoot a hard daily cap (101/100 was reproduced
    // with concurrency=3). A definite rejection releases the slot; an ambiguous
    // delivery keeps it consumed because the provider may have accepted it.
    while (true) {
      incrementCounter(provider.id, 1);
      try {
        // Optional hook: let the caller finalize the payload for the provider that
        // is actually about to send (e.g. swap the subject to that provider's A/B
        // winner). Must never throw — on error we send the payload unchanged.
        if (typeof finalizeForProvider === 'function') {
          try { finalizeForProvider(email, provider.id); } catch { /* send as-is */ }
        }
        // Resolved against the provider actually being tried (not the caller's
        // preferred/first provider) — matters when the cascade falls back to a
        // different provider with a different scheduledSend capability/lookahead.
        const resolved = resolveScheduledAt(email, provider);
        const result = await SEND_FNS[provider.id](email, resolved, signal);
        recordRealSent(provider.id);
        return { ...result, scheduledFor: resolved ? resolved.toISOString() : null };
      } catch (err) {
        if (!err.ambiguousDelivery) incrementCounter(provider.id, -1);
        errors.push(`[${provider.id}] ${err.message}`);
        if (err.ambiguousDelivery) {
          // The provider may have already accepted/delivered this message —
          // falling back to another provider here risks a second delivery
          // (#4911). Stop the cascade for this email instead of guessing.
          const ambiguousErr = new Error(`ambiguous delivery at [${provider.id}], not retried elsewhere: ${errors.join(' | ')}`);
          ambiguousErr.ambiguousDelivery = true;
          throw ambiguousErr;
        }
        if (adaptiveThrottle && await adaptiveThrottle.retryAfter(provider.id, err)) {
          continue;
        }
        if (isSoftThrottleError(err.message)) {
          cooldownProvider(provider.id);
        } else if (isRateLimitedError(err.message)) {
          incrementCounter(provider.id, remainingQuota(provider.id));
          console.warn(`⚠️  ${provider.id} rate-limited/exhausted — skipping for rest of run: ${err.message.slice(0, 150)}`);
        }
        break;
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
async function sendSingleThrottled(email, forceProvider, lastSendMap, delayMs, finalizeForProvider, signal, adaptiveThrottle) {
  // Determine which provider will be tried first (the one with remaining quota)
  const providers = forceProvider
    ? PROVIDERS.filter(p => p.id === forceProvider)
    : PROVIDERS;
  const nextProvider = providers.find(p =>
    isProviderConfigured(p.id) && remainingQuota(p.id) > 0 && !isProviderCoolingDown(p.id));

  if (nextProvider) {
    // Reserve a delay-spaced slot SYNCHRONOUSLY (read + write lastSendMap with no
    // await in between) so concurrent sends to the same provider each get a
    // distinct slot instead of all reading the same timestamp, waiting the same
    // delta, and firing as a burst. The reservation advances the clock up-front,
    // so spacing holds even when the send FAILS — the failure mode behind the
    // "258 Mailtrap 403s in 5s" incident, now concurrency-safe for any future
    // concurrency>1 caller (was latent at the default concurrency=1).
    const now = Date.now();
    const providerDelayMs = adaptiveThrottle?.delayFor(nextProvider.id) ?? delayMs;
    const slot = Math.max(now, lastSendMap[nextProvider.id] || 0);
    lastSendMap[nextProvider.id] = slot + providerDelayMs;
    const wait = slot - now;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // Slot already reserved above (advances even on throw), so no post-hoc clock
  // bump is needed — the worker's try/catch handles a thrown send.
  const result = await sendSingle(email, forceProvider, finalizeForProvider, signal, adaptiveThrottle);
  // If a different provider ended up sending, reserve its slot too.
  if (result?.provider && result.provider !== nextProvider?.id) {
    const now = Date.now();
    const providerDelayMs = adaptiveThrottle?.delayFor(result.provider) ?? delayMs;
    lastSendMap[result.provider] = Math.max(now, lastSendMap[result.provider] || 0) + providerDelayMs;
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
 * @param {{stepMs:number,maxDelayMs:number}} [opts.adaptiveThrottle] - Opt-in
 *   additive backoff for explicit 408/425/429/5xx responses. Starts at delayMs,
 *   retries the rejected message and never exceeds maxDelayMs.
 * @param {string} [opts.forceProvider] - Force a specific provider (skip cascade)
 * @param {Function} [opts.onSent] - Called after each successful send: (item, result) => void
 * @param {Function} [opts.finalizeForProvider] - Called just before sending, once
 *   the provider is chosen: (payload, providerId) => void. May mutate the payload
 *   (e.g. swap the subject for that provider). Must not throw.
 * @param {AbortSignal} [opts.signal] - Forwarded to every provider's fetch()
 *   call so a caller with its own hang budget (e.g. a post-deploy live-check
 *   script) can bound the whole send. Omitted by default (no change for
 *   existing callers) — the cascade itself has no built-in timeout.
 * @returns {{ sent: Array, failed: Array, adaptiveThrottle?: Object }}
 */
export async function sendEmailCascade(emails, opts = {}) {
  const { concurrency = 1, delayMs = 1000, adaptiveThrottle: adaptiveConfig, forceProvider, onSent, finalizeForProvider, signal } = opts;
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
  console.log(`   Throttle: concurrency=${concurrency}, delay=${delayMs}ms between sends${adaptiveConfig ? `, adaptive max=${adaptiveConfig.maxDelayMs}ms step=${adaptiveConfig.stepMs}ms` : ''}`);

  // Per-provider last-send timestamps for throttling
  const _lastSend = {};
  const adaptiveThrottle = createAdaptiveThrottleController(adaptiveConfig, delayMs, _lastSend);

  // Process sequentially (concurrency=1) with per-provider delay
  let idx = 0;
  const worker = async () => {
    while (idx < emails.length) {
      const i = idx++;
      const item = emails[i];
      try {
        const result = await sendSingleThrottled(item.payload, forceProvider, _lastSend, delayMs, finalizeForProvider, signal, adaptiveThrottle);
        sent.push({ ...item, ...result });
        if (onSent) await onSent(item, result);
      } catch (err) {
        // ambiguousDelivery (#4911): the message may have already gone out
        // via a provider that then failed on the response — surfaced here
        // instead of silently deducing failure, so callers can distinguish
        // "never sent" from "unknown, do not resend blindly".
        failed.push({ ...item, error: err.message, ambiguousDelivery: !!err.ambiguousDelivery });
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
  // Per-message scheduled-send breakdown (feature #3798): how many of the
  // successful sends were actually deferred provider-side vs sent immediately.
  const scheduledCount = sent.filter(s => s.scheduledFor).length;
  const immediateCount = sent.length - scheduledCount;
  console.log(`   Scheduling: scheduled=${scheduledCount}, immediate=${immediateCount}`);

  return adaptiveThrottle
    ? { sent, failed, adaptiveThrottle: adaptiveThrottle.snapshot() }
    : { sent, failed };
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
    sent: _realSentCounts[p.id] || 0,
    // Quota marked used-up without a matching real send — happens when a
    // provider is detected as rate-limited/exhausted (its quota jumps to the
    // daily cap in one step so the cascade stops retrying it) rather than
    // consumed one real send at a time. Non-zero here means "Sent" alone
    // undercounts why Remaining is low.
    benched: Math.max(0, getCounter(p.id) - (_realSentCounts[p.id] || 0)),
    remaining: remainingQuota(p.id),
  }));
}

/**
 * Print a summary table of provider usage.
 */
export function logProviderSummary() {
  console.log('\n📊 Email Provider Summary:');
  console.log('   Provider     | Configured | Sent | Benched | Remaining | Daily Limit');
  console.log('   -------------|------------|------|---------|-----------|-----------');
  for (const stat of getProviderStats()) {
    const cfg = stat.configured ? '✅' : '❌';
    console.log(`   ${stat.id.padEnd(12)} | ${cfg.padEnd(10)} | ${String(stat.sent).padEnd(4)} | ${String(stat.benched).padEnd(7)} | ${String(stat.remaining).padEnd(9)} | ${stat.dailyLimit}`);
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
 * A provider's dailyLimit can be Infinity (resend, no self-imposed floor).
 * Any caller doing per-run send pacing ("send N today, rest tomorrow") needs
 * a FINITE number to compare against — Infinity silently disables that
 * pacing. Single source of truth for the finite-substitution so it can't
 * drift between call sites (getCascadeDailyCapacity below, and
 * send-newsletter.mjs's single-provider DAILY_SEND_LIMIT branch).
 */
export function finiteDailyLimit(provider) {
  return Number.isFinite(provider.dailyLimit) ? provider.dailyLimit : Math.floor((provider.monthlyLimit || 0) / 30);
}

/**
 * Total theoretical daily send capacity across the whole cascade — the sum of
 * every provider's daily limit (see PROVIDERS above). Single source of truth
 * so callers (e.g. the newsletter per-run cap) stay in sync when providers
 * change, instead of a second hardcoded total drifting from the array.
 */
export function getCascadeDailyCapacity() {
  return PROVIDERS.reduce((sum, p) => sum + finiteDailyLimit(p), 0);
}

/**
 * Real remaining send capacity across every CONFIGURED provider right now —
 * unlike getCascadeDailyCapacity() (static theoretical total), this reflects
 * today's actual usage so far. Backed by the same syncQuotasFromAPIs() that
 * sendEmailCascade() awaits internally (memoized per UTC day), so calling
 * this before a send run costs no extra provider API calls. Lets a caller
 * size a batch of work (e.g. how many alert emails to build) to what can
 * ACTUALLY still go out today, including quota already consumed earlier the
 * same day by other cascade users (retry queue, newsletter, ad-blast — the
 * daily counters are shared across all of them).
 */
export async function getAvailableCascadeQuota() {
  await syncQuotasFromAPIs();
  return PROVIDERS
    .filter(p => isProviderConfigured(p.id))
    .reduce((sum, p) => sum + remainingQuota(p.id), 0);
}

export { PROVIDERS, remainingQuota, isProviderConfigured, syncQuotasFromAPIs, isRateLimitedError, campaignIdTag, fetchResendDailyUsage, resolveScheduledAt, toRfc2822Utc, resendCycleBounds, computeResendDynamicDailyLimit, computeMailerooDynamicDailyLimit, computeMailtrapDynamicDailyLimit };
