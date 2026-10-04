// Shared GA4/Google service-account auth + HTTP retry helpers.
// Canonical source for logic previously copy-pasted across
// analytics-report.mjs, setup-ga4-user-dimensions.mjs, user-value-report.mjs
// (AGENTS.md #6 — literal duplication extracted to prevent drift).
import { settledWindow } from './analytics-settled-window.mjs';

export const DEFAULT_GA4_PROPERTY_ID = 'properties/524485296';
export const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchRetry(url, options = {}, retries = 2, timeoutMs = 0) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const fetchOptions = { ...options };
      if (timeoutMs > 0) {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }
      const res = await fetch(url, fetchOptions);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
        const delay = res.status === 429 ? 10000 * attempt : 2000 * attempt;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt <= retries) {
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

// Diagnostics default to stderr so callers that emit JSON/CSV on stdout stay
// machine-readable. Callers with their own gated logger (e.g.
// analytics-report.mjs's --json-aware log()) can still inject theirs.
export async function getServiceAccountToken(scopes, { logInfo = console.error, logError = console.error } = {}) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const authOptions = { scopes };
    // CI normally exposes a path, while the Remote Config loader exposes the
    // same credential as JSON. Keep both routes in the canonical helper so a
    // fallback cannot appear configured locally and disappear in Actions.
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      authOptions.credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    const auth = new GoogleAuth(authOptions);
    const client = await auth.getClient();
    // Log SA email for diagnostics (not a secret — it's a public GCP identifier)
    if (client.email) logInfo(`ℹ️  Using service account: ${client.email}`);
    const { token } = await client.getAccessToken();
    return token;
  } catch (e) {
    logError(`⚠️  Service account auth failed: ${e.message}`);
    return null;
  }
}

export function ga4DateRange(windowDays, lagDays = 2, now = new Date()) {
  const { start, end } = settledWindow({
    days: Math.max(1, Number(windowDays) || 1),
    lagDays,
    now,
  });
  return {
    startDate: start,
    endDate: end,
  };
}

/** One injectable GA4 Data API request for monitor fallbacks. */
export async function runGa4Report({
  token,
  body,
  propertyId,
  fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('no service-account token');
  const raw = propertyId || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;
  const res = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.error) throw new Error(`GA4: ${JSON.stringify(data.error).slice(0, 300)}`);
  return data;
}

/** Massimo di righe per singola richiesta runReport della GA4 Data API. */
export const GA4_RUNREPORT_MAX_PAGE_SIZE = 250_000;
/** Tetto dichiarato di righe lette da un report paginato: oltre, `capped`. */
export const GA4_RUNREPORT_DEFAULT_MAX_ROWS = 1_000_000;

function mergeGa4Metadata(list) {
  const present = list.filter(Boolean);
  if (!present.length) return {};
  const merged = { ...present[0] };
  if (present.some((m) => m.dataLossFromOtherRow)) merged.dataLossFromOtherRow = true;
  if (present.some((m) => m.subjectToThresholding)) merged.subjectToThresholding = true;
  const reasons = present.flatMap((m) => m.dataTruncationReasons || []);
  if (reasons.length) merged.dataTruncationReasons = reasons;
  const restrictions = present.flatMap((m) => m.schemaRestrictionResponse?.activeMetricRestrictions || []);
  if (restrictions.length) {
    merged.schemaRestrictionResponse = { ...(merged.schemaRestrictionResponse || {}), activeMetricRestrictions: restrictions };
  }
  const sampling = present.flatMap((m) => m.samplingMetadatas || []);
  if (sampling.length) merged.samplingMetadatas = sampling;
  return merged;
}

function dimensionNames(body) {
  return (Array.isArray(body?.dimensions) ? body.dimensions : [])
    .map((dimension) => typeof dimension === 'string' ? dimension : dimension?.name)
    .filter(Boolean);
}

function dimensionOrderBys(names) {
  return names.map((dimensionName) => ({ dimension: { dimensionName }, desc: false }));
}

function rowDimensionKey(row, dimensionCount) {
  if (dimensionCount === 0 || !Array.isArray(row?.dimensionValues) || row.dimensionValues.length < dimensionCount) return null;
  return JSON.stringify(row.dimensionValues.slice(0, dimensionCount).map((dimension) => dimension?.value ?? ''));
}

/**
 * Legge un runReport GA4 per intero, pagina dopo pagina con `offset`, fino a
 * `rowCount` (o fino al tetto `maxRows`). Un limit fisso senza offset rende
 * troncata, e quindi «fonte assente» per i consumer prudenti, qualunque
 * popolazione superi una pagina (issue 11423: 138.894 pagePath contro
 * limit 100000). `fetchPage(body)` restituisce il JSON della risposta.
 *
 * `complete` e' falso se manca una coda (pagina corta prima di rowCount,
 * tetto raggiunto, rowCount cambiato fra le pagine, pagina piena senza
 * rowCount, o chiavi di dimensione duplicate fra le pagine): i segnali di
 * campionamento/soglia restano nel `metadata` unito e li valuta il chiamante.
 *
 * @param {{ body: object, fetchPage: (body: object) => Promise<any>, pageSize?: number, maxRows?: number }} input
 */
export async function paginateGa4Report({
  body,
  fetchPage,
  pageSize = 100_000,
  maxRows = GA4_RUNREPORT_DEFAULT_MAX_ROWS,
} = {}) {
  const size = Math.max(1, Math.min(Number(pageSize) || 1, GA4_RUNREPORT_MAX_PAGE_SIZE));
  const rows = [];
  const metadatas = [];
  const names = dimensionNames(body);
  const pageBody = { ...(body || {}) };
  // Offset pagination is only stable when the complete dimension key is the
  // sort key. This deliberately replaces metric/top-N ordering for reports
  // whose full population is being paged; top-N callers do not use this helper.
  if (names.length) pageBody.orderBys = dimensionOrderBys(names);
  const seenDimensionKeys = new Set();
  let duplicateRows = false;
  let rowCount = null;
  let rowCountChanged = false;
  let lastPageFull = false;
  let pages = 0;
  while (rows.length < maxRows) {
    const limit = Math.min(size, maxRows - rows.length);
    const data = (await fetchPage({ ...pageBody, offset: rows.length, limit })) || {};
    pages += 1;
    metadatas.push(data.metadata);
    const reported = data.rowCount == null ? null : Number(data.rowCount);
    if (pages > 1 && reported !== rowCount) rowCountChanged = true;
    rowCount = reported;
    const batch = Array.isArray(data.rows) ? data.rows : [];
    // Niente spread: una pagina da 250000 righe supera il limite di argomenti.
    for (const row of batch) {
      const key = rowDimensionKey(row, names.length);
      if (key !== null) {
        if (seenDimensionKeys.has(key)) duplicateRows = true;
        seenDimensionKeys.add(key);
      }
      rows.push(row);
    }
    lastPageFull = batch.length >= limit;
    if (!lastPageFull) break;
    if (rowCount !== null && rows.length >= rowCount) break;
  }
  const capped = rows.length >= maxRows && (rowCount === null ? lastPageFull : rowCount > rows.length);
  const complete = !rowCountChanged && !duplicateRows && !capped && (rowCount === null
    ? !lastPageFull
    : Number.isSafeInteger(rowCount) && rowCount === rows.length);
  return {
    rows,
    rowCount,
    metadata: mergeGa4Metadata(metadatas),
    pages,
    rowCountChanged,
    duplicateRows,
    capped,
    complete,
  };
}

/**
 * `runGa4Report` letto per intero con `paginateGa4Report`. Restituisce la
 * forma di una risposta runReport (`rows`, `rowCount`, `metadata`) piu'
 * `complete`/`pages`: un chiamante che misura una popolazione intera deve
 * controllare `complete === false`, non solo `rowCount > rows.length`.
 */
export async function runGa4ReportPaged({
  token,
  body,
  propertyId,
  fetchImpl = fetch,
  pageSize = body?.limit ?? 100_000,
  maxRows = GA4_RUNREPORT_DEFAULT_MAX_ROWS,
} = {}) {
  const report = await paginateGa4Report({
    body,
    pageSize,
    maxRows,
    fetchPage: (page) => runGa4Report({ token, body: page, propertyId, fetchImpl }),
  });
  return {
    rows: report.rows,
    rowCount: report.rowCount,
    metadata: report.metadata,
    complete: report.complete,
    pages: report.pages,
    duplicateRows: report.duplicateRows,
  };
}

function exactEventFilter(eventName) {
  return {
    filter: {
      fieldName: 'eventName',
      stringFilter: { value: eventName, matchType: 'EXACT' },
    },
  };
}

/** RE2 per `hostName` (GA4 `FULL_REGEXP`): l'apex e i suoi sottodomini. */
export const PRODUCTION_HOST_REGEXP = '^(.+\\.)?frontaliereticino\\.ch$';

/**
 * `dimensionFilter` GA4: l'evento richiesto, solo dall'host di produzione, e
 * (se dati) solo per i messaggi elencati.
 *
 * Sta in questo helper, e non in app-error-recency.mjs che lo riesporta,
 * perche' lo usa `fetchGa4ErrorEntries` qui sotto: questo file e' elencato uno
 * per uno negli sparse-checkout dei workflow dei loop, e un import da qui verso
 * un modulo di funzionalita' li rompe tutti con ERR_MODULE_NOT_FOUND. La
 * dipendenza va dal modulo di funzionalita' all'helper, mai al contrario
 * (osservatore: tests/ga4-service-account-sparse-closure.test.ts).
 *
 * @param {string} eventName
 * @param {{ messages?: string[] }} [opts]
 */
export function productionAppErrorFilter(eventName, { messages } = {}) {
  const expressions = [
    exactEventFilter(eventName),
    { filter: { fieldName: 'hostName', stringFilter: { value: PRODUCTION_HOST_REGEXP, matchType: 'FULL_REGEXP' } } },
  ];
  if (Array.isArray(messages) && messages.length) {
    expressions.push({
      filter: {
        fieldName: 'customEvent:error_message',
        inListFilter: { values: messages, caseSensitive: true },
      },
    });
  }
  return { andGroup: { expressions } };
}

/**
 * Error events mirror Analytics.trackAppError(): app_error is preferred and
 * exception is the standard-event fallback. Empty `app_error` is not treated
 * as a healthy zero until the standard mirror has also been checked.
 */
export async function fetchGa4ErrorEntries({
  token,
  startDate,
  endDate,
  limit = 30,
  fetchImpl = fetch,
} = {}) {
  const base = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'customEvent:error_type' },
      { name: 'customEvent:error_message' },
      { name: 'pagePath' },
    ],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit,
  };
  let lastError;
  for (const eventName of ['app_error', 'exception']) {
    try {
      const data = await runGa4Report({
        token,
        fetchImpl,
        // Production host only — same rule as `errorHealth.appErrors` in
        // analytics-report.mjs: the property also receives dev-server events.
        body: { ...base, dimensionFilter: productionAppErrorFilter(eventName) },
      });
      const rows = (data.rows || []).map((row) => ({
        type: row.dimensionValues?.[0]?.value || eventName,
        message: row.dimensionValues?.[1]?.value || '',
        sampleUrl: row.dimensionValues?.[2]?.value || '',
        count: Number(row.metricValues?.[0]?.value || 0),
        sessions: Number(row.metricValues?.[1]?.value || 0),
        sampleExceptionList: [],
      }));
      if (rows.length) return rows;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

export async function fetchGa4SearchTerms({
  token,
  startDate,
  endDate,
  limit = 1000,
  fetchImpl = fetch,
} = {}) {
  const data = await runGa4Report({
    token,
    fetchImpl,
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'searchTerm' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: exactEventFilter('search'),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit,
    },
  });
  return (data.rows || [])
    .map((row) => ({
      term: row.dimensionValues?.[0]?.value || '',
      count: Number(row.metricValues?.[0]?.value || 0),
      users: Number(row.metricValues?.[1]?.value || 0),
    }))
    .filter((row) => row.term && row.term !== '(not set)');
}

/**
 * Return page-level web-vitals observations. `metric_value` is recorded by
 * services/webVitals.ts in thousandths for CLS and milliseconds otherwise.
 * The caller computes its own p75/threshold, preserving the monitor's unit.
 */
export async function fetchGa4WebVitals({
  token,
  startDate,
  endDate,
  pageSize = 100000,
  maxRows = GA4_RUNREPORT_DEFAULT_MAX_ROWS,
  paths,
  fetchImpl = fetch,
} = {}) {
  // Paginato: con un limit fisso e senza offset una finestra oltre una pagina
  // risultava `truncated` e i consumer (revenue-monitor, cwv-monitor-check)
  // scartavano la fonte (stessa classe della issue 11423).
  const report = await paginateGa4Report({
    pageSize,
    maxRows,
    fetchPage: (body) => runGa4Report({ token, fetchImpl, body }),
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'pagePath' },
        { name: 'customEvent:metric_name' },
        { name: 'customEvent:metric_value' },
        // GA4's built-in deviceCategory is queryable without registering the
        // app's device_type event parameter as a custom dimension.
        { name: 'deviceCategory' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: paths?.length ? { andGroup: { expressions: [
        exactEventFilter('web_vitals'),
        { filter: { fieldName: 'pagePath', inListFilter: { values: paths } } },
      ] } } : exactEventFilter('web_vitals'),
    },
  });
  const reportRows = report.rows;
  const metadata = report.metadata;
  const totalCount = reportRows.reduce((sum, row) => sum + rowEventCount(row), 0);
  const otherCount = reportRows
    .filter((row) => row.dimensionValues?.some((dimension) => dimension?.value === '(other)'))
    .reduce((sum, row) => sum + rowEventCount(row), 0);
  const observations = reportRows.flatMap((row) => {
    const path = row.dimensionValues?.[0]?.value || '';
    const metric = row.dimensionValues?.[1]?.value || '';
    const rawValue = Number(row.dimensionValues?.[2]?.value);
    const device = String(row.dimensionValues?.[3]?.value || '').toLowerCase();
    const count = rowEventCount(row);
    if (!path || !metric || !Number.isFinite(rawValue) || count <= 0) return [];
    return [{
      path,
      metric,
      value: metric === 'CLS' ? rawValue / 1000 : rawValue,
      device,
      count,
    }];
  });
  Object.defineProperty(observations, 'coverage', {
    value: {
      totalCount,
      returnedRows: reportRows.length,
      timeZone: metadata.timeZone || null,
      dataLossFromOtherRow: Boolean(metadata.dataLossFromOtherRow),
      samplingMetadatas: metadata.samplingMetadatas || [],
      dataTruncationReasons: metadata.dataTruncationReasons || [],
      subjectToThresholding: Boolean(metadata.subjectToThresholding),
      distributionIncomplete: Boolean(metadata.dataLossFromOtherRow
        || metadata.samplingMetadatas?.length || metadata.dataTruncationReasons?.length
        || metadata.subjectToThresholding),
      totalRows: report.rowCount,
      pages: report.pages,
      truncated: !report.complete,
      otherCount,
      otherFraction: totalCount ? otherCount / totalCount : 0,
    },
    enumerable: false,
  });
  return observations;
}

function rowEventCount(row) {
  const count = Number(row.metricValues?.[0]?.value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export const GA4_SIGNIFICANT_OTHER_FRACTION = 0.05;

export function hasSignificantOtherBucket(observations) {
  return (observations?.coverage?.otherFraction || 0) >= GA4_SIGNIFICANT_OTHER_FRACTION;
}

export function weightedQuantile(observations, quantile) {
  const ordered = observations.slice().sort((a, b) => a.value - b.value);
  const total = ordered.reduce((sum, item) => sum + item.count, 0);
  if (!total) return null;
  const target = total * quantile;
  let cumulative = 0;
  for (const item of ordered) {
    cumulative += item.count;
    if (cumulative >= target) return item.value;
  }
  return ordered.at(-1).value;
}

/**
 * One day's `pagePath` × `pageTitle` × `screenPageViews` report, the exact
 * shape scripts/lib/daily-top-content.mjs#rankCandidates expects.
 *
 * Shared by every GA4-ranked social poster (LinkedIn member, Instagram,
 * TikTok) — project rule: a helper duplicated literally in ≥2 files MUST
 * live in ONE shared module. Originally lived only in
 * post-to-linkedin-member.mjs.
 *
 * @param {string} day 'YYYY-MM-DD'
 * @param {{ propertyId?: string }} [opts]
 * @returns {Promise<Array<{path:string, title:string, views:number}>|null>} null on any failure
 */
export async function fetchGa4PageReport(day, { propertyId } = {}) {
  const token = await getServiceAccountToken(['https://www.googleapis.com/auth/analytics.readonly']);
  if (!token) return null;

  const raw = propertyId || process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID;
  const property = raw.startsWith('properties/') ? raw : `properties/${raw}`;

  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: day, endDate: day }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10000,
      }),
    },
  );
  if (!res?.ok) {
    console.warn(`⚠️  GA4 runReport failed (${res?.status}) — nothing to post`);
    return null;
  }
  const data = await res.json();
  if (data.error) {
    console.warn(`⚠️  GA4 error: ${JSON.stringify(data.error).slice(0, 200)}`);
    return null;
  }
  return (data.rows || []).map((r) => ({
    path: r.dimensionValues?.[0]?.value || '',
    title: r.dimensionValues?.[1]?.value || '',
    views: parseInt(r.metricValues?.[0]?.value || '0', 10),
  }));
}
