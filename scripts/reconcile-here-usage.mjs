#!/usr/bin/env node
/**
 * Reconcile the HERE transaction budget counter with HERE's *real* billed usage.
 *
 * Why this exists
 * ---------------
 * `functions/src/trafficSchedulerCore.js` keeps a per-month counter in Firestore
 * (`meta/hereTransactionBudget`) and skips routing runs once the month would
 * exceed HERE_MONTHLY_BUDGET. That counter is an *estimate of attempts* started
 * from 0 — it does NOT know about:
 *   - transactions spent before the guard was deployed (mid-month rollout),
 *   - HERE-side retries / billing nuances the client never sees.
 *
 * The HERE Cost Management **Usage API** exposes the real billed figure:
 *   GET https://usage.bam.api.here.com/v2/usage/realms/{realmId}
 *        ?startDate=<month-start>&endDate=<now>
 * returning per-service rows with valueDriver="Transactions" and
 * usageValue / billableValue.
 *
 * This job reads that real month-to-date value and *seeds* the Firestore counter
 * with max(realBilled, liveCount) — conservative: we never lower the counter
 * below what we have already counted live, and we never ignore real spend the
 * live counter missed. The pre-run guard then gates on the reconciled truth.
 *
 * Usage API auth is OAuth 2.0 (NOT the routing apikey): an OAuth1.0a-signed
 * client_credentials request to https://account.api.here.com/oauth2/token using
 * the HERE access key id + secret, then a bearer token on the Usage call.
 *
 * Modes
 * -----
 *   Live  (default):  reads the Usage API. Requires env:
 *                       HERE_OAUTH_KEY_ID, HERE_OAUTH_KEY_SECRET, HERE_REALM_ID
 *   Manual --set <N>: seeds the counter to N immediately, no API call. Use the
 *                     month-to-date figure from the HERE Usage Dashboard when
 *                     OAuth credentials are not yet provisioned.
 *
 * Common flags:
 *   --dry-run          compute + print, do not write Firestore
 *   --budget <N>       override HERE_MONTHLY_BUDGET for the alert threshold
 *   --alert            open a GitHub issue if reconciled usage exceeds the budget
 *
 * Firestore auth: GOOGLE_APPLICATION_CREDENTIALS (same as collect-traffic.mjs).
 */

import crypto from 'node:crypto';

const HERE_TOKEN_URL = 'https://account.api.here.com/oauth2/token';
const HERE_USAGE_HOST = 'https://usage.bam.api.here.com';
// HERE meters routing under these service names; match case-insensitively and
// by substring so "Time Aware Routing", "Routing", "Routing v8" all count.
const ROUTING_SERVICE_MATCHERS = ['routing', 'time aware'];

// ─── arg parsing ───────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dryRun: false, alert: false, set: null, budget: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--alert') args.alert = true;
    else if (a === '--set') args.set = Number(argv[++i]);
    else if (a === '--budget') args.budget = Number(argv[++i]);
  }
  return args;
}

// ─── month helpers (Europe/Rome — matches the guard) ───────────
export function currentMonthKey(now = new Date()) {
  return now
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
    .slice(0, 7);
}

export function monthBounds(monthKey) {
  // monthKey = 'YYYY-MM'. Returns ISO start (UTC) and end (UTC now).
  // start = UTC instant of 00:00:00 Europe/Rome on the 1st of the month,
  // matching currentMonthKey() which also uses Europe/Rome. This ensures
  // startDate ≤ endDate even in the ~1-2h window where Rome's calendar is
  // ahead of UTC at the month turn (e.g. 00:30 Rome = 22:30 UTC prev day).
  const [y, m] = monthKey.split('-').map(Number);
  const nominalUtcMidnight = new Date(Date.UTC(y, m - 1, 1));
  // "sv" Intl format → "YYYY-MM-DD HH:MM:SS" in Rome TZ (safe for Date parsing).
  const romeClock = new Intl.DateTimeFormat('sv', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(nominalUtcMidnight).replace(' ', 'T');
  // Treating romeClock as UTC gives: nominalUtcMidnight + romeOffset.
  // Subtracting romeOffset yields the UTC instant of Rome midnight.
  const romeOffsetMs = new Date(romeClock + 'Z').getTime() - nominalUtcMidnight.getTime();
  const start = new Date(nominalUtcMidnight.getTime() - romeOffsetMs).toISOString().slice(0, 19);
  const end = new Date().toISOString().slice(0, 19);
  return { start, end };
}

// ─── HERE OAuth 1.0a-signed token request ──────────────────────
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Builds the OAuth 1.0a Authorization header for the HERE token endpoint.
 * Pure (nonce/timestamp injected) so it is unit-testable.
 */
export function buildHereOAuthHeader({ url, method, bodyParams, keyId, keySecret, nonce, timestamp }) {
  const oauthParams = {
    oauth_consumer_key: keyId,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp),
    oauth_version: '1.0',
  };
  // Signature base string includes oauth_* AND the form body params, sorted.
  const allParams = { ...oauthParams, ...bodyParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(keySecret)}&`; // empty token secret
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header =
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(', ');
  return header;
}

async function getHereAccessToken({ keyId, keySecret }) {
  const bodyParams = { grant_type: 'client_credentials' };
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const authHeader = buildHereOAuthHeader({
    url: HERE_TOKEN_URL,
    method: 'POST',
    bodyParams,
    keyId,
    keySecret,
    nonce,
    timestamp,
  });
  const res = await fetch(HERE_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bodyParams).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HERE OAuth token HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('HERE OAuth: no access_token in response');
  return data.access_token;
}

// ─── Usage API ─────────────────────────────────────────────────
/**
 * Sums "Transactions" usage across routing services from a Usage API payload.
 * Pure — unit-testable. Prefers billableValue (what HERE charges) and falls
 * back to usageValue.
 *
 * The live v2 Usage API returns rows under `items` (verified against
 * org899238099: `{total, limit, items:[{name, valueDriver, billableValue,…}]}`).
 * `usage` / bare-array shapes are also accepted for forward/back-compat.
 */
export function sumRoutingTransactions(usagePayload) {
  const rows = Array.isArray(usagePayload?.items)
    ? usagePayload.items
    : Array.isArray(usagePayload?.usage)
      ? usagePayload.usage
      : Array.isArray(usagePayload)
        ? usagePayload
        : [];
  let total = 0;
  const breakdown = [];
  for (const row of rows) {
    const name = String(row?.name ?? '').toLowerCase();
    const driver = String(row?.valueDriver ?? '').toLowerCase();
    if (driver && !driver.includes('transaction')) continue;
    const isRouting = ROUTING_SERVICE_MATCHERS.some((m) => name.includes(m));
    if (!isRouting) continue;
    const value = Number(row?.billableValue ?? row?.usageValue ?? 0);
    if (Number.isFinite(value) && value > 0) {
      total += value;
      breakdown.push({ name: row.name, value });
    }
  }
  return { total: Math.round(total), breakdown };
}

async function fetchHereMonthToDateUsage({ token, realmId, monthKey }) {
  const { start, end } = monthBounds(monthKey);
  const url = `${HERE_USAGE_HOST}/v2/usage/realms/${encodeURIComponent(realmId)}?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HERE Usage API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Firestore seed ────────────────────────────────────────────
// firebase-admin is imported lazily so the pure helpers above (and their unit
// tests) load without the dependency / without needing Firestore credentials.
async function ensureAdminApp() {
  const { default: admin } = await import('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin;
}

async function seedCounter({ monthKey, realBilled, source, dryRun }) {
  const adm = await ensureAdminApp();
  const db = adm.firestore();
  const ref = db.collection('meta').doc('hereTransactionBudget');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const liveCount = data.month === monthKey ? Number(data.count || 0) : 0;
    // Conservative merge: never drop below what we already counted live.
    const reconciled = Math.max(realBilled, liveCount);
    if (!dryRun) {
      tx.set(
        ref,
        {
          month: monthKey,
          count: reconciled,
          reconciledBilled: realBilled,
          reconciledAt: adm.firestore.Timestamp.now(),
          source,
        },
        { merge: true },
      );
    }
    return { liveCount, reconciled };
  });
}

// ─── main ──────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const monthKey = currentMonthKey();
  const budget = args.budget ?? Number(process.env.HERE_MONTHLY_BUDGET || 4500);

  let realBilled;
  let source;
  let breakdown = [];

  if (args.set != null && Number.isFinite(args.set)) {
    realBilled = Math.round(args.set);
    source = 'manual';
    console.log(`📝 Manual seed: ${realBilled} transactions for ${monthKey}`);
  } else {
    const keyId = process.env.HERE_OAUTH_KEY_ID;
    const keySecret = process.env.HERE_OAUTH_KEY_SECRET;
    const realmId = process.env.HERE_REALM_ID;
    if (!keyId || !keySecret || !realmId) {
      console.error(
        '❌ Live mode needs HERE_OAUTH_KEY_ID, HERE_OAUTH_KEY_SECRET, HERE_REALM_ID.\n' +
          '   Provision an OAuth access key in the HERE platform (Access Manager) and the realm/org id,\n' +
          '   or run with --set <N> using the month-to-date figure from the Usage Dashboard.',
      );
      process.exit(2);
    }
    const token = await getHereAccessToken({ keyId, keySecret });
    const payload = await fetchHereMonthToDateUsage({ token, realmId, monthKey });
    const summed = sumRoutingTransactions(payload);
    realBilled = summed.total;
    breakdown = summed.breakdown;
    source = 'here-usage-api';
    console.log(`📊 HERE Usage API: ${realBilled} routing transactions billed for ${monthKey}`);
    for (const b of breakdown) console.log(`     - ${b.name}: ${b.value}`);
  }

  const { liveCount, reconciled } = await seedCounter({ monthKey, realBilled, source, dryRun: args.dryRun });
  console.log(
    `${args.dryRun ? '🔎 [dry-run] ' : '✅ '}Counter for ${monthKey}: live=${liveCount}, realBilled=${realBilled} ` +
      `→ reconciled=${reconciled}/${budget}`,
  );

  const remaining = budget - reconciled;
  if (remaining <= 0) {
    console.warn(`🛑 Budget exhausted for ${monthKey}: ${reconciled}/${budget}. HERE runs will be skipped until reset.`);
  } else {
    console.log(`💳 Remaining this month: ${remaining} transactions (~${Math.floor(remaining / 50)} runs).`);
  }

  if (args.alert && reconciled > budget && process.env.GH_TOKEN) {
    try {
      const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
      await createGithubIssue({
        // Stable title prefix → dedupes onto one canonical issue per month.
        title: `HERE usage over free-tier budget (${monthKey})`,
        description:
          `Reconciled HERE usage for ${monthKey} is **${reconciled}/${budget}** ` +
          `(real billed ${realBilled}). Routing runs are being skipped to avoid charges.`,
        priority: 1,
        labels: ['revenue'],
        workflow: 'Reconcile HERE Usage Budget',
        signals: {
          cosa: `budget mensile HERE (${monthKey}) superato — routing runs sospesi`,
          metrica: { osservato: reconciled, atteso: budget },
          comando: 'node scripts/reconcile-here-usage.mjs --dry-run',
          evidenza: [`source=${source}`, `realBilled=${realBilled}`],
        },
      });
    } catch (e) {
      console.warn(`⚠️ alert issue failed: ${e.message}`);
    }
  }
}

// Only run when invoked directly (allow importing pure helpers in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ reconcile-here-usage failed: ${err.message}`);
    process.exit(1);
  });
}
