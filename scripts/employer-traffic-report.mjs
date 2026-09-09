#!/usr/bin/env node
/**
 * Employer traffic report for the publisher surface.
 *
 * This report is a click-proxy report, not a candidature report. PostHog and
 * GA4 are alternative sources and are never added together. The payload says
 * which source was used, which window was queried, and how pagination covered
 * every returned group.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baseCompanySlug, canonicalCompanyProfileSlug, rawCompanySlug } from '../build-plugins/shared/companyProfileSlug.mjs';

export const REPORT_SCHEMA_VERSION = 2;
export const REPORT_PAGE_SIZE = 1_000;
export const DELIVERY_UNAVAILABLE = 'non disponibile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveBuildSha() {
  const configured = process.env.GITHUB_SHA || process.env.BUILD_SHA || process.env.SITE_BUILD_SHA;
  if (configured) return configured;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

const BUILD_SHA = resolveBuildSha();

const argv = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeWindow({ days = null, from = null, to = new Date().toISOString() } = {}) {
  const toIsoValue = toIso(to);
  const fromIso = from
    ? toIso(from)
    : days != null
      ? toIso(new Date(Date.parse(toIsoValue) - Number(days) * 86_400_000))
    : '1970-01-01T00:00:00.000Z';
  if (!fromIso || !toIsoValue || Date.parse(fromIso) >= Date.parse(toIsoValue)) throw new Error('invalid report window');
  return {
    from: fromIso,
    to: toIsoValue,
    kind: days == null && !from ? 'cumulative' : days != null ? `days:${days}` : 'explicit',
    timezone: 'UTC',
    inclusive: '[from,to)',
  };
}

function loadCompanies() {
  const out = new Map();
  const file = path.join(__dirname, '..', 'data', 'crawler-companies-auto.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.companies) ? raw.companies : Object.values(raw || {});
    for (const company of list) {
      if (!company || typeof company !== 'object') continue;
      const key = normalize(company.key || company.companyKey || company.name);
      if (!key) continue;
      const name = String(company.name || company.key || key);
      const historicalAliases = [
        ...(Array.isArray(company.previousSlugs) ? company.previousSlugs : []),
        ...(Array.isArray(company.aliases) ? company.aliases : []),
        ...Object.values(company.previousSlugsByLocale || {}).flatMap((values) => Array.isArray(values) ? values : []),
      ];
      const aliases = new Set([
        key,
        normalize(name),
        normalize(baseCompanySlug(name, key)),
        normalize(rawCompanySlug(name)),
        normalize(canonicalCompanyProfileSlug(name, key)),
        ...historicalAliases.map(normalize),
      ].filter(Boolean));
      const previous = out.get(key) || { key, name, careersUrl: '', aliases: new Set() };
      previous.name = previous.name || name;
      previous.careersUrl = previous.careersUrl || company.careersUrl || company.website || '';
      for (const alias of aliases) previous.aliases.add(alias);
      out.set(key, previous);
    }
  } catch { /* registry optional; unknown groups stay residual */ }
  return out;
}

function identityIndex(companies) {
  const aliasToKeys = new Map();
  for (const [key, company] of companies || []) {
    const aliases = company?.aliases instanceof Set
      ? company.aliases
      : new Set([key, company?.name].map(normalize).filter(Boolean));
    for (const alias of aliases) {
      if (!aliasToKeys.has(alias)) aliasToKeys.set(alias, new Set());
      aliasToKeys.get(alias).add(key);
    }
  }
  return aliasToKeys;
}

function resolveCompany(value, aliasToKeys) {
  const alias = normalize(value);
  const keys = aliasToKeys.get(alias);
  if (!keys) return { key: null, reason: 'unknown_company_alias' };
  if (keys.size !== 1) return { key: null, reason: 'ambiguous_company_alias' };
  return { key: [...keys][0], reason: null };
}

function postHogAuth() {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');
  return { apiKey, projectId, host };
}

async function postHogQuery(query) {
  const { apiKey, projectId, host } = postHogAuth();
  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!response.ok) throw new Error(`posthog ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()).results || [];
}

function hogqlDate(iso) {
  return String(iso).replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

const POSTHOG_COMPANY_EXPRESSION = "splitByChar('_', coalesce(toString(properties.item_id), ''))[1]";

function postHogCursorValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function postHogBaseQuery(window, cursorCompany = null) {
  const cursorFilter = cursorCompany == null
    ? ''
    : " AND " + POSTHOG_COMPANY_EXPRESSION + " > '" + postHogCursorValue(cursorCompany) + "'";
  return `
    SELECT ${POSTHOG_COMPANY_EXPRESSION} AS company,
           count(DISTINCT person_id) AS persons,
           count(DISTINCT properties.$session_id) AS sessions,
           count() AS clicks
    FROM events
    WHERE event = 'select_content'
      AND properties.content_type IN ('job_board_apply','job_board_apply_header_logo','job_board_apply_header_title')
      AND coalesce(toString(properties.item_id), '') != ''
      AND timestamp >= toDateTime('${hogqlDate(window.from)}')
      AND timestamp < toDateTime('${hogqlDate(window.to)}')${cursorFilter}
    GROUP BY company
    ORDER BY company
  `.trim();
}

function proxyFor(persons, sessions) {
  const p = numberOr(persons);
  const s = numberOr(sessions);
  return s > 0 ? Math.min(p, s) : p;
}

function buildCoverage({ source, observed, attributed, residuals, pageSize, totalRows, rowsReturned, pages, queryHash, snapshotId, window }) {
  const residualTotal = Object.values(residuals).reduce((sum, value) => sum + value, 0);
  return {
    source,
    observed,
    attributed,
    residuals,
    residualTotal,
    invariant: observed === attributed + residualTotal,
    technicalDuplicatesRemoved: 0,
    limits: {
      groups: {
        limit: pageSize,
        pageSize,
        totalBeforeCut: totalRows,
        returned: rowsReturned,
        pages,
        truncated: rowsReturned < totalRows,
      },
    },
    provenance: {
      queryHash,
      snapshotId,
      buildSha: BUILD_SHA,
      window,
    },
  };
}

/**
 * Pure PostHog result normalizer. Company labels are joined through the
 * explicit registry aliases; a label that cannot be resolved is residual.
 */
export function aggregatePostHogRows(rows, companies = new Map()) {
  const aliasToKeys = identityIndex(companies);
  const employers = new Map();
  const residuals = Object.create(null);
  let observed = 0;
  let attributed = 0;
  for (const row of rows || []) {
    const companyLabel = Array.isArray(row) ? row[0] : row.company;
    const persons = numberOr(Array.isArray(row) ? row[1] : row.persons);
    const sessions = numberOr(Array.isArray(row) ? row[2] : row.sessions);
    const clicks = numberOr(Array.isArray(row) ? row[3] : row.clicks);
    const sourceObserved = Math.max(0, numberOr(Array.isArray(row) ? row[4] : row.observed, clicks));
    observed += sourceObserved;
    const resolved = resolveCompany(companyLabel, aliasToKeys);
    if (!resolved.key) {
      residuals[resolved.reason] = (residuals[resolved.reason] || 0) + sourceObserved;
      continue;
    }
    attributed += sourceObserved;
    const current = employers.get(resolved.key) || {
      key: resolved.key,
      displayFromData: companyLabel,
      persons: 0,
      sessions: 0,
      clicks: 0,
      applyClicks: 0,
      applyClickProxy: 0,
      sponsored: 0,
      observed: 0,
    };
    current.persons += persons;
    current.sessions += sessions;
    current.clicks += clicks;
    current.applyClicks += clicks;
    current.applyClickProxy = proxyFor(current.persons, current.sessions);
    current.observed += sourceObserved;
    employers.set(resolved.key, current);
  }
  return {
    employers: [...employers.values()].map((row) => ({ ...row, candidates: row.applyClickProxy })),
    observed,
    attributed,
    residuals,
  };
}

function postHogCompanyFromRow(row) {
  const company = Array.isArray(row) ? row[0] : row?.company;
  return company == null ? null : String(company);
}

async function fromPostHog(window, companies) {
  const baseQuery = postHogBaseQuery(window);
  const queryHash = crypto.createHash('sha256').update(baseQuery).digest('hex');
  const countRows = await postHogQuery(`SELECT count() AS total FROM (${baseQuery})`);
  const totalRows = Math.max(0, Math.trunc(numberOr(countRows?.[0]?.[0] ?? countRows?.[0]?.total)));
  const rawRows = [];
  let pages = 0;
  let cursorCompany = null;
  while (true) {
    const page = await postHogQuery(postHogBaseQuery(window, cursorCompany) + ' LIMIT ' + REPORT_PAGE_SIZE);
    rawRows.push(...page);
    pages += 1;
    if (!page.length) break;
    const nextCursor = postHogCompanyFromRow(page.at(-1));
    if (!nextCursor) throw new Error('posthog page missing company cursor');
    if (cursorCompany !== null && nextCursor <= cursorCompany) {
      throw new Error('posthog company cursor did not advance');
    }
    cursorCompany = nextCursor;
    if (page.length < REPORT_PAGE_SIZE) break;
    if (totalRows > 0 && rawRows.length >= totalRows) break;
  }
  const aggregated = aggregatePostHogRows(rawRows, companies);
  return {
    ...aggregated,
    coverage: buildCoverage({
      source: 'posthog',
      observed: aggregated.observed,
      attributed: aggregated.attributed,
      residuals: aggregated.residuals,
      pageSize: REPORT_PAGE_SIZE,
      totalRows,
      rowsReturned: rawRows.length,
      pages,
      queryHash,
      snapshotId: crypto.createHash('sha256').update(`${queryHash}:${window.from}:${window.to}`).digest('hex'),
      window,
    }),
  };
}

async function postHogSourceFrom() {
  const rows = await postHogQuery('SELECT min(timestamp) AS source_from FROM events');
  return toIso(rows?.[0]?.[0] ?? rows?.[0]?.source_from);
}

function ga4Date(iso) {
  const date = new Date(Date.parse(iso) - 86_400_000);
  return date.toISOString().slice(0, 10);
}

function ga4Request(window, offset) {
  return {
    dateRanges: [{ startDate: window.from.slice(0, 10), endDate: ga4Date(window.to) }],
    dimensions: [{ name: 'customEvent:employer_key' }, { name: 'customEvent:is_sponsored' }],
    metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'job_apply' } } },
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit: REPORT_PAGE_SIZE,
    offset: String(offset),
  };
}

/** Pure GA4 rows → free click proxy, with sponsored traffic kept separate. */
export function aggregateGa4Rows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const dimensions = row.dimensionValues || [];
    const metrics = row.metricValues || [];
    const key = String(dimensions[0]?.value || '');
    const sponsored = dimensions[1]?.value === 'sponsored';
    const users = numberOr(metrics[0]?.value);
    const sessions = numberOr(metrics[1]?.value);
    const clicks = numberOr(metrics[2]?.value);
    const e = byKey.get(key) || { key, persons: 0, sessions: 0, clicks: 0, applyClicks: 0, sponsored: 0, observed: 0 };
    if (sponsored) {
      e.sponsored += users;
    } else {
      e.persons += users;
      e.sessions += sessions;
      e.clicks += clicks;
      e.applyClicks += clicks;
      e.observed += clicks;
    }
    byKey.set(key, e);
  }
  return [...byKey.values()].map((entry) => ({
    ...entry,
    applyClickProxy: proxyFor(entry.persons, entry.sessions),
    candidates: proxyFor(entry.persons, entry.sessions),
  }));
}

export function resolveGa4Employers(rows, companies) {
  const aliasToKeys = identityIndex(companies);
  const employers = new Map();
  const residuals = Object.create(null);
  let observed = 0;
  let attributed = 0;
  for (const row of rows || []) {
    const sourceObserved = Math.max(0, numberOr(row.observed, row.clicks));
    observed += sourceObserved;
    const resolved = resolveCompany(row.key, aliasToKeys);
    if (!resolved.key) {
      residuals[resolved.reason] = (residuals[resolved.reason] || 0) + sourceObserved;
      continue;
    }
    attributed += sourceObserved;
    const current = employers.get(resolved.key) || {
      key: resolved.key,
      displayFromData: row.key,
      persons: 0,
      sessions: 0,
      clicks: 0,
      applyClicks: 0,
      applyClickProxy: 0,
      sponsored: 0,
      observed: 0,
    };
    current.persons += numberOr(row.persons);
    current.sessions += numberOr(row.sessions);
    current.clicks += numberOr(row.clicks);
    current.applyClicks += numberOr(row.applyClicks || row.clicks);
    current.sponsored += numberOr(row.sponsored);
    current.observed += sourceObserved;
    current.applyClickProxy = proxyFor(current.persons, current.sessions);
    employers.set(resolved.key, current);
  }
  return {
    employers: [...employers.values()].map((row) => ({ ...row, candidates: row.applyClickProxy })),
    observed,
    attributed,
    residuals,
  };
}

async function fromGa4(window) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const temporaryPath = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(temporaryPath, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = temporaryPath;
  }
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error('no GA4_PROPERTY_ID');
  const property = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const { token } = await (await auth.getClient()).getAccessToken();
  const rows = [];
  let rowCount = 0;
  let offset = 0;
  let pages = 0;
  while (offset === 0 || offset < rowCount) {
    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ga4Request(window, offset)),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(`GA4: ${JSON.stringify(payload.error || {}).slice(0, 200)}`);
    rowCount = numberOr(payload.rowCount, payload.rows?.length || 0);
    rows.push(...(payload.rows || []));
    pages += 1;
    offset += REPORT_PAGE_SIZE;
    if ((payload.rows || []).length < REPORT_PAGE_SIZE) break;
  }
  const aggregated = resolveGa4Employers(aggregateGa4Rows(rows), loadCompanies());
  return {
    employers: aggregated.employers,
    coverage: buildCoverage({
      source: 'ga4',
      observed: aggregated.observed,
      attributed: aggregated.attributed,
      residuals: aggregated.residuals,
      pageSize: REPORT_PAGE_SIZE,
      totalRows: rowCount,
      rowsReturned: rows.length,
      pages,
      queryHash: null,
      snapshotId: null,
      window,
    }),
  };
}

function reportPayload({ source, window, data, rows, min, days }) {
  const filtered = rows
    .filter((entry) => numberOr(entry.applyClickProxy) >= min)
    .sort((a, b) => b.applyClickProxy - a.applyClickProxy || a.key.localeCompare(b.key));
  const totals = filtered.reduce((total, entry) => ({
    applyClickProxy: total.applyClickProxy + numberOr(entry.applyClickProxy),
    applyClicks: total.applyClicks + numberOr(entry.applyClicks || entry.clicks),
    persons: total.persons + numberOr(entry.persons),
    sessions: total.sessions + numberOr(entry.sessions),
    clicks: total.clicks + numberOr(entry.clicks),
    sponsored: total.sponsored + numberOr(entry.sponsored),
  }), { applyClickProxy: 0, applyClicks: 0, persons: 0, sessions: 0, clicks: 0, sponsored: 0 });
  const companies = loadCompanies();
  const employers = filtered.map((entry) => {
    const meta = companies.get(entry.key) || {};
    return {
      ...entry,
      name: entry.displayFromData || meta.name || entry.key,
      careersUrl: meta.careersUrl || '',
      applications: null,
      applicationsStatus: 'source_unavailable',
      forwardedAt: null,
      delivery: DELIVERY_UNAVAILABLE,
    };
  });
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    buildSha: BUILD_SHA,
    source,
    days: days == null ? null : Number(days),
    window,
    metric: {
      name: 'apply_click_proxy',
      definition: 'min(distinct_persons, distinct_sessions), fallback to persons when sessions is unavailable',
      status: 'proxy_not_application',
    },
    applications: { value: null, status: 'source_unavailable', proof: 'not queried by this report' },
    forwardedAt: null,
    delivery: DELIVERY_UNAVAILABLE,
    sourceSeparation: {
      selected: source,
      ga4EmployerCrawledTraffic: { included: false, summed: false, reason: 'alternative source, never added to the selected source' },
    },
    coverage: data.coverage,
    limits: data.coverage.limits,
    totals: {
      ...totals,
      candidates: totals.applyClickProxy,
      candidatesMeaning: 'legacy compatibility alias for applyClickProxy; not an application count',
      personsToSessionsRatio: totals.sessions > 0 ? Number((totals.persons / totals.sessions).toFixed(3)) : 0,
    },
    employers,
  };
}

async function run() {
  const source = arg('--source', 'posthog');
  if (!['posthog', 'ga4'].includes(source)) throw new Error('--source must be posthog or ga4');
  const days = arg('--days', null);
  if (days != null && (!Number.isFinite(Number(days)) || Number(days) <= 0)) throw new Error('--days must be a positive number');
  const explicitFrom = arg('--from', null);
  const to = arg('--to', new Date().toISOString());
  let window = makeWindow({ days, from: explicitFrom, to });
  if (source === 'posthog' && days == null && !explicitFrom) {
    const sourceFrom = await postHogSourceFrom();
    if (sourceFrom) window = { ...makeWindow({ from: sourceFrom, to }), kind: 'cumulative' };
  }
  const companies = loadCompanies();
  const data = source === 'ga4' ? await fromGa4(window) : await fromPostHog(window, companies);
  const payload = reportPayload({ source, window, data, rows: data.employers, min: numberOr(arg('--min', '1'), 1), days });
  const ratio = payload.totals.personsToSessionsRatio;
  console.log(`\nEmployer apply-click proxy — source ${source}, ${window.from} → ${window.to}`);
  console.log(`   ${payload.employers.length} aziende · ${payload.totals.applyClickProxy} proxy · ${payload.totals.applyClicks} click`);
  console.log(`   persone distinte: ${payload.totals.persons} · sessioni distinte: ${payload.totals.sessions}${ratio ? ` · rapporto P/S: ${ratio.toFixed(2)}` : ''}`);
  console.log(`   coverage: observed ${payload.coverage.observed} · attributed ${payload.coverage.attributed} · residual ${payload.coverage.residualTotal}`);
  if (payload.employers.length) {
    console.log('  #  PROXY  PERS  SESS  CLICK  AZIENDA');
    payload.employers.forEach((entry, index) => console.log(`${String(index + 1).padStart(3)}  ${String(entry.applyClickProxy).padStart(5)}  ${String(entry.persons).padStart(4)}  ${String(entry.sessions).padStart(4)}  ${String(entry.clicks).padStart(5)}  ${entry.name}${entry.careersUrl ? `  ${entry.careersUrl}` : ''}`));
  } else console.log('  (nessun dato per questa sorgente/finestra)');
  const jsonPath = arg('--json', '');
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    console.log(`\nJSON → ${jsonPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => { console.error(error.message || error); process.exit(1); });
}
