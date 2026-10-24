#!/usr/bin/env node
/**
 * GA4 key events — the repo is the source of truth for which events mark a
 * session as valuable.
 *
 * Until 2026-10-24 the property had a single key event, `purchase`, which the
 * site never emits: every GA4 "key event rate", "session key event rate" and
 * Search Console/GA4 conversion view read zero. The list below names the
 * events that represent value on this site (application hand-off to the
 * employer, completed salary simulation, job-alert subscription, newsletter
 * subscription, login) and how GA4 must count them.
 *
 * Contract of the script:
 *  - dry-run by default: prints the plan (what exists, what would be created,
 *    what is waiting for data) and changes nothing;
 *  - `--apply` creates ONLY the missing key events whose event name has
 *    `eventCount > 0` in the last 28 settled days of the GA4 Data API — a key
 *    event on a name GA4 has never received is a typo nobody would notice;
 *  - it never deletes or edits a key event (an existing `countingMethod` that
 *    differs from the spec is reported, not changed).
 *
 * Usage:
 *   node scripts/ga4-key-events.mjs            # plan only
 *   node scripts/ga4-key-events.mjs --apply    # create the missing, observed ones
 *   node scripts/ga4-key-events.mjs --json     # machine-readable plan
 *
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
 * (the service account needs the Editor role on the GA4 property for --apply).
 * Documented in docs/analytics/ga4-misura-affidabile.md.
 */

import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  runGa4Report,
} from './lib/ga4-service-account.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

export const GA4_EDIT_SCOPE = 'https://www.googleapis.com/auth/analytics.edit';
export const KEY_EVENT_LOOKBACK_DAYS = 28;

/**
 * Desired key events. `reason` is the value the event stands for; `counting`
 * is GA4's countingMethod. ONCE_PER_SESSION is used where one visitor
 * legitimately fires the event many times in a row (recalculating a salary)
 * and the value is "this session used the calculator", not the click count.
 */
export const KEY_EVENT_SPECS = Object.freeze([
  {
    eventName: 'job_apply_handoff',
    counting: 'ONCE_PER_EVENT',
    reason: 'candidatura: redirect verso il sito/ATS del datore di lavoro (services/analytics.ts trackJobApplyHandoff)',
  },
  {
    eventName: 'simulation_complete',
    counting: 'ONCE_PER_SESSION',
    reason: 'uso del calcolatore: simulazione stipendio completata (services/analytics.ts trackCalculation)',
  },
  {
    eventName: 'job_alert_created',
    counting: 'ONCE_PER_EVENT',
    reason: 'iscrizione agli avvisi di lavoro (services/analytics.ts trackJobAlertCreated)',
  },
  {
    eventName: 'newsletter_subscribe',
    counting: 'ONCE_PER_EVENT',
    reason: 'iscrizione newsletter: solo action=subscribe del generico `newsletter` (services/analytics.ts trackNewsletter)',
  },
  {
    eventName: 'login',
    counting: 'ONCE_PER_SESSION',
    reason: 'login riuscito (evento GA4 raccomandato, emesso su auth_success del gate annunci)',
  },
]);

/**
 * Names deliberately NOT marked, with the reason. Kept in code so a later
 * reader does not "fix" the omission without reading why.
 */
export const KEY_EVENT_EXCLUSIONS = Object.freeze({
  generate_lead: 'porta `value` = stipendio lordo in CHF: come key event GA4 lo sommerebbe come valore di conversione; il valore è già coperto da simulation_complete',
  job_apply: 'click su «candidati» prima del gate: precede job_apply_handoff nello stesso percorso, marcarlo conterebbe due volte la stessa candidatura',
  newsletter: 'evento multi-azione (subscribe/confirm/error/subscribe_attempt): sostituito da newsletter_subscribe',
  job_auth_funnel: 'evento multi-step (gate_view è il 92%): sostituito da login',
  google_jobs_apply: 'non è un evento ma una sorgente di traffico (utm_source=google_jobs_apply): si misura come sessionSource nel report valore landing',
  purchase: 'key event preesistente, mai emesso dal sito: lasciato com’è (lo script non cancella)',
});

function normalizeProperty(raw) {
  const value = String(raw || DEFAULT_GA4_PROPERTY_ID);
  return value.startsWith('properties/') ? value : `properties/${value}`;
}

/** Event counts for the given names in the settled lookback window. */
export async function fetchObservedEventCounts({ token, propertyId, eventNames, runReport = runGa4Report, now = new Date() }) {
  const data = await runReport({
    token,
    propertyId,
    body: {
      dateRanges: [ga4DateRange(KEY_EVENT_LOOKBACK_DAYS, 1, now)],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...eventNames] } } },
      limit: eventNames.length + 10,
    },
  });
  const counts = Object.fromEntries(eventNames.map((name) => [name, 0]));
  for (const row of data.rows || []) {
    const name = row.dimensionValues?.[0]?.value;
    if (name in counts) counts[name] = Number(row.metricValues?.[0]?.value || 0);
  }
  return counts;
}

/** Pure planner: decide create / exists / mismatch / waiting for each spec. */
export function planKeyEvents({ specs = KEY_EVENT_SPECS, existing = [], observed = {} }) {
  const byName = new Map(existing.map((entry) => [entry.eventName, entry]));
  return specs.map((spec) => {
    const current = byName.get(spec.eventName);
    const eventCount = Number(observed[spec.eventName] || 0);
    if (current) {
      const action = current.countingMethod && current.countingMethod !== spec.counting ? 'counting_mismatch' : 'exists';
      return { ...spec, action, eventCount, currentCounting: current.countingMethod || null, resource: current.name };
    }
    return { ...spec, action: eventCount > 0 ? 'create' : 'waiting_for_data', eventCount };
  });
}

async function adminRequest({ token, url, method = 'GET', body, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`GA4 Admin ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}

export async function listKeyEvents({ token, propertyId, fetchImpl = fetch }) {
  const property = normalizeProperty(propertyId);
  const out = [];
  let pageToken = '';
  do {
    const url = `https://analyticsadmin.googleapis.com/v1beta/${property}/keyEvents?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await adminRequest({ token, url, fetchImpl });
    out.push(...(data.keyEvents || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function createKeyEvent({ token, propertyId, eventName, counting, fetchImpl = fetch }) {
  const property = normalizeProperty(propertyId);
  return adminRequest({
    token,
    url: `https://analyticsadmin.googleapis.com/v1beta/${property}/keyEvents`,
    method: 'POST',
    body: { eventName, countingMethod: counting },
    fetchImpl,
  });
}

export async function syncKeyEvents({ token, propertyId, apply = false, fetchImpl = fetch, runReport = runGa4Report, now = new Date() }) {
  const existing = await listKeyEvents({ token, propertyId, fetchImpl });
  const observed = await fetchObservedEventCounts({
    token, propertyId, eventNames: KEY_EVENT_SPECS.map((spec) => spec.eventName), runReport, now,
  });
  const plan = planKeyEvents({ existing, observed });
  if (apply) {
    for (const entry of plan) {
      if (entry.action !== 'create') continue;
      const created = await createKeyEvent({ token, propertyId, eventName: entry.eventName, counting: entry.counting, fetchImpl });
      entry.action = 'created';
      entry.resource = created.name || null;
    }
  }
  return { propertyId: normalizeProperty(propertyId), lookbackDays: KEY_EVENT_LOOKBACK_DAYS, apply, existing: existing.map((e) => e.eventName), plan };
}

function printPlan(result) {
  console.log(`GA4 key events — ${result.propertyId} (finestra ${result.lookbackDays} gg, ${result.apply ? 'APPLY' : 'dry-run'})`);
  console.log(`Esistenti: ${result.existing.join(', ') || '(nessuno)'}`);
  for (const entry of result.plan) {
    console.log(`- ${entry.action.padEnd(17)} ${entry.eventName.padEnd(22)} ${entry.counting.padEnd(16)} eventi28g=${entry.eventCount}`
      + (entry.currentCounting && entry.action === 'counting_mismatch' ? ` (su GA4: ${entry.currentCounting})` : ''));
  }
  console.log('Esclusi per scelta:');
  for (const [name, why] of Object.entries(KEY_EVENT_EXCLUSIONS)) console.log(`- ${name}: ${why}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const token = await getServiceAccountToken(apply ? [GA4_EDIT_SCOPE, GA4_READONLY_SCOPE] : [GA4_READONLY_SCOPE], { logInfo: () => {} });
  if (!token) throw new Error('GA4 service-account token unavailable (set GOOGLE_APPLICATION_CREDENTIALS)');
  const result = await syncKeyEvents({ token, propertyId: process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID, apply });
  if (args.has('--json')) console.log(JSON.stringify(result, null, 2));
  else printPlan(result);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error?.message || error}`);
    process.exitCode = 1;
  });
}
