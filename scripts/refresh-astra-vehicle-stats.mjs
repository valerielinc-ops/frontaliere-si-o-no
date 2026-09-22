#!/usr/bin/env node
/**
 * Refresh the ASTRA/FEDRO vehicle observatory.
 *
 * The worker is intentionally server-side.  ASTRA exposes the IVZ files as
 * large attachments without browser CORS; BEST is currently about 2 GB.  A
 * HEAD fingerprint prevents the monthly files from being downloaded on every
 * daily run.  The parsed, compact result is written to Firestore and consumed
 * read-only by the statistics dashboard.
 */

import admin from "firebase-admin";
import { appendFileSync } from "node:fs";
import {
  ASTRA_ENDPOINTS,
  SWISS_CANTON_CODES,
  aggregateWeeklyXlsx,
  createTsvAccumulator,
  parseDelimitedLine,
} from "./lib/astra-vehicle-stats-parser.mjs";

const FIRESTORE_COLLECTION = "config";
const FIRESTORE_DOC = "astra_vehicle_stats";
const FETCH_TIMEOUT_MS = 45 * 60 * 1000;
const HISTORY_LIMITS = Object.freeze({ weekly: 26, monthly: 24 });
const ARTICLE_OUTBOX_LIMIT = 100;

function logInfo(message) {
  console.error(`ℹ️  ${message}`);
}
function logOk(message) {
  console.error(`✅ ${message}`);
}
function logErr(message) {
  console.error(`❌ ${message}`);
}

function emitOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.error(`OUT  ${key}=${value}`);
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const REQUEST_HEADERS = Object.freeze({
  Accept: "text/plain,application/octet-stream,*/*;q=0.8",
  "Accept-Encoding": "identity",
  "User-Agent": "frontaliereticino.ch ASTRA vehicle observatory",
});

function comparableMetadata(metadata) {
  return {
    etag: metadata?.etag || "",
    lastModified: metadata?.lastModified || "",
    contentLength: Number(metadata?.contentLength || 0),
  };
}

function sameMetadata(left, right) {
  const a = comparableMetadata(left);
  const b = comparableMetadata(right);
  return Boolean(
    (a.etag && b.etag && a.etag === b.etag) ||
      (a.lastModified &&
        b.lastModified &&
        a.lastModified === b.lastModified &&
        a.contentLength > 0 &&
        a.contentLength === b.contentLength),
  );
}

async function fetchMetadata(url) {
  const response = await fetch(url, {
    method: "HEAD",
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`ASTRA HEAD ${response.status} for ${url}`);
  return {
    url,
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
    contentLength: Number(response.headers.get("content-length") || 0),
    checkedAt: new Date().toISOString(),
  };
}

function assertContentLength(bytesRead, metadata, url) {
  if (metadata.contentLength > 0 && bytesRead !== metadata.contentLength) {
    throw new Error(
      `ASTRA download troncato per ${url}: ricevuti ${bytesRead} byte, attesi ${metadata.contentLength}`,
    );
  }
}

async function fetchTsvAggregate(url, metadata, dataset) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ASTRA GET ${response.status} for ${url}`);
  if (!response.body) throw new Error(`ASTRA response senza body per ${url}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let bytesRead = 0;
  let headers = null;
  let accumulator = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const row = parseDelimitedLine(line);
    if (!headers) {
      headers = row;
      accumulator = createTsvAccumulator(headers, { dataset });
      return;
    }
    accumulator.addRow(row);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }
  carry += decoder.decode();
  consumeLine(carry);
  assertContentLength(bytesRead, metadata, url);

  if (!accumulator) throw new Error(`ASTRA ${dataset}: header mancante`);
  const result = accumulator.finish();
  if (result.sourceRows === 0)
    throw new Error(`ASTRA ${dataset}: nessuna riga dati`);
  return result;
}

async function fetchWeeklyAggregate(url, metadata) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ASTRA GET ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  assertContentLength(buffer.length, metadata, url);
  return aggregateWeeklyXlsx(buffer);
}

async function loadDataset(key, url, previousSource, previousData) {
  const metadata = await fetchMetadata(url);
  if (previousData && sameMetadata(metadata, previousSource)) {
    logInfo(
      `${key}: file invariato (${metadata.lastModified || metadata.etag || "fingerprint assente"}), riuso aggregato Firestore.`,
    );
    return {
      data: previousData,
      source: {
        ...previousSource,
        ...metadata,
        reusedAt: new Date().toISOString(),
      },
      changed: false,
    };
  }

  logInfo(
    `${key}: scarico e aggrego ${metadata.contentLength ? `${(metadata.contentLength / 1024 / 1024).toFixed(1)} MB` : "file senza size"}…`,
  );
  const data =
    key === "weekly"
      ? await fetchWeeklyAggregate(url, metadata)
      : await fetchTsvAggregate(url, metadata, key);
  return {
    data,
    source: {
      ...metadata,
      fetchedAt: new Date().toISOString(),
      sourceRows: data.sourceRows,
      dataAsOf: data.dataAsOf || null,
      period: data.period || null,
    },
    changed: true,
  };
}

function emptyMetrics() {
  return {
    total: 0,
    electric: 0,
    plugInHybrid: 0,
    hybrid: 0,
    petrol: 0,
    diesel: 0,
    gas: 0,
    other: 0,
    averageCo2: null,
    fuelMix: [
      "electric",
      "plugInHybrid",
      "hybrid",
      "petrol",
      "diesel",
      "gas",
      "other",
    ].map((key) => ({ key, count: 0, share: 0 })),
  };
}

function metricsFor(dataset, canton) {
  return dataset?.byCanton?.[canton] || emptyMetrics();
}

function monthToken(value) {
  const text = String(value || "");
  let match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}`;
  match = text.match(/(\d{4})[./-](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}` : null;
}

function buildWeeklySnapshot(data, source) {
  const period =
    data.period || `unknown-${source.lastModified || source.fetchedAt}`;
  return {
    period,
    provisional: true,
    dataAsOf: data.dataAsOf || source.lastModified || null,
    national: data.national,
    byCanton: Object.fromEntries(
      SWISS_CANTON_CODES.map((code) => [code, metricsFor(data, code)]),
    ),
    sourceRows: data.sourceRows,
  };
}

function buildMonthlySnapshot(stock, registrations, imports, sources) {
  const period =
    monthToken(stock.dataAsOf) ||
    monthToken(registrations.dataAsOf) ||
    monthToken(imports.dataAsOf) ||
    `unknown-${sources.best.lastModified || sources.neuzu.lastModified || ""}`;
  return {
    period,
    dataAsOf:
      stock.dataAsOf || registrations.dataAsOf || imports.dataAsOf || null,
    national: {
      stock: stock.national,
      newRegistrations: registrations.national,
      usedImports: imports.national,
    },
    byCanton: SWISS_CANTON_CODES.map((code) => ({
      code,
      stock: metricsFor(stock, code),
      newRegistrations: metricsFor(registrations, code),
      usedImports: metricsFor(imports, code),
    })),
    sourceRows: {
      stock: stock.sourceRows,
      newRegistrations: registrations.sourceRows,
      usedImports: imports.sourceRows,
    },
  };
}

function buildWeeklyHistoryPoint(snapshot) {
  return {
    period: snapshot.period,
    provisional: snapshot.provisional,
    nationalTotal: snapshot.national.total,
    ticinoTotal: snapshot.byCanton.TI?.total || 0,
    ticinoElectric: snapshot.byCanton.TI?.electric || 0,
    dataAsOf: snapshot.dataAsOf,
  };
}

function buildMonthlyHistoryPoint(snapshot) {
  return {
    period: snapshot.period,
    nationalStock: snapshot.national.stock.total,
    ticinoStock:
      snapshot.byCanton.find((row) => row.code === "TI")?.stock.total || 0,
    ticinoNewRegistrations:
      snapshot.byCanton.find((row) => row.code === "TI")?.newRegistrations
        .total || 0,
    ticinoUsedImports:
      snapshot.byCanton.find((row) => row.code === "TI")?.usedImports.total ||
      0,
    ticinoElectric:
      snapshot.byCanton.find((row) => row.code === "TI")?.stock.electric || 0,
    dataAsOf: snapshot.dataAsOf,
  };
}

function mergeHistory(previous, current, limit) {
  const entries = [
    ...(Array.isArray(previous) ? previous : []),
    ...(current ? [current] : []),
  ];
  const unique = new Map();
  for (const entry of entries) {
    if (entry?.period) unique.set(String(entry.period), entry);
  }
  return [...unique.values()]
    .sort((a, b) => String(a.period).localeCompare(String(b.period)))
    .slice(-limit);
}

function previousPeriod(previous, section) {
  return previous?.[section]?.latest?.period || null;
}

function articleOutboxKey(cadence, period, section) {
  return `${cadence}/${period}/${section}`;
}

function articleOutboxUrl(cadence, period, section) {
  return `stats-astra://${cadence}/${encodeURIComponent(period)}/${section}`;
}

/**
 * Keep article dispatch separate from the current data snapshot. The refresh
 * must be allowed to fail after Firestore has been updated without losing the
 * one-shot signal for the next run.
 */
function buildArticleOutbox(previous, weeklyLatest, monthlyLatest, generatedAt) {
  const entries = new Map();
  for (const entry of Array.isArray(previous?.articleOutbox)
    ? previous.articleOutbox
    : []) {
    if (!entry?.key || !entry?.url) continue;
    if (entry.status !== "pending" && entry.status !== "dispatched") continue;
    entries.set(String(entry.key), { ...entry });
  }

  const enqueue = (cadence, period, section, previousValue) => {
    if (!previousValue || !period || previousValue === period) return;
    const key = articleOutboxKey(cadence, period, section);
    if (entries.has(key)) return;
    entries.set(key, {
      key,
      cadence,
      period,
      section,
      url: articleOutboxUrl(cadence, period, section),
      status: "pending",
      createdAt: generatedAt,
    });
  };

  enqueue(
    "weekly",
    weeklyLatest.period,
    "frontaliere",
    previousPeriod(previous, "weekly"),
  );
  const previousMonth = previousPeriod(previous, "monthly");
  enqueue("monthly", monthlyLatest.period, "svizzera", previousMonth);
  enqueue("monthly", monthlyLatest.period, "frontaliere", previousMonth);

  const sorted = [...entries.values()]
    .sort((a, b) => {
      const byDate = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      return byDate || String(a.key).localeCompare(String(b.key));
    });
  const pending = sorted.filter((entry) => entry.status === "pending");
  const delivered = sorted.filter((entry) => entry.status === "dispatched");
  const deliveredSlots = Math.max(0, ARTICLE_OUTBOX_LIMIT - pending.length);
  return [
    ...(deliveredSlots > 0 ? delivered.slice(-deliveredSlots) : []),
    ...pending,
  ].sort((a, b) => {
    const byDate = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    return byDate || String(a.key).localeCompare(String(b.key));
  });
}

function pendingArticleUrls(outbox, cadence, section) {
  return outbox
    .filter(
      (entry) =>
        entry.status === "pending" &&
        entry.cadence === cadence &&
        entry.section === section,
    )
    .map((entry) => entry.url)
    .join(" ");
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || "frontaliere-ticino",
    });
  }
  const db = admin.firestore();
  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
  const previousSnap = await ref.get();
  const previous = previousSnap.exists ? previousSnap.data() : null;
  const now = new Date().toISOString();

  const definitions = [
    ["stnr", ASTRA_ENDPOINTS.stnr],
    ["weekly", ASTRA_ENDPOINTS.weekly],
    ["neuzu", ASTRA_ENDPOINTS.neuzu],
    ["best", ASTRA_ENDPOINTS.best],
    ["gebr", ASTRA_ENDPOINTS.gebr],
  ];
  const loaded = {};
  for (const [key, url] of definitions) {
    loaded[key] = await loadDataset(
      key,
      url,
      previous?.sources?.[key],
      previous?.datasets?.[key],
    );
  }

  const weeklyLatest = buildWeeklySnapshot(
    loaded.weekly.data,
    loaded.weekly.source,
  );
  const monthlyLatest = buildMonthlySnapshot(
    loaded.best.data,
    loaded.neuzu.data,
    loaded.gebr.data,
    {
      best: loaded.best.source,
      neuzu: loaded.neuzu.source,
      gebr: loaded.gebr.source,
    },
  );
  const articleOutbox = buildArticleOutbox(
    previous,
    weeklyLatest,
    monthlyLatest,
    now,
  );
  const daily = {
    dataAsOf:
      loaded.stnr.data.dataAsOf || loaded.stnr.source.lastModified || null,
    national: loaded.stnr.data.national,
    sourceRows: loaded.stnr.data.sourceRows,
    signal: loaded.stnr.changed,
  };

  const payload = {
    schemaVersion: 1,
    generatedAt: now,
    lastUpdated: now,
    daily,
    weekly: {
      latest: weeklyLatest,
      history: mergeHistory(
        previous?.weekly?.history,
        buildWeeklyHistoryPoint(weeklyLatest),
        HISTORY_LIMITS.weekly,
      ),
    },
    monthly: {
      latest: monthlyLatest,
      history: mergeHistory(
        previous?.monthly?.history,
        buildMonthlyHistoryPoint(monthlyLatest),
        HISTORY_LIMITS.monthly,
      ),
    },
    articleOutbox,
    sources: Object.fromEntries(
      definitions.map(([key]) => [key, loaded[key].source]),
    ),
    technical: {
      status: "catalogued",
      datasets: [
        {
          key: "eDatenblatt",
          cadence: "monthly",
          access: "paid-or-restricted",
          public: false,
          use: "approfondimenti tecnici ed emissioni per articoli futuri",
        },
        {
          key: "TAS",
          cadence: "monthly",
          access: "paid-or-restricted",
          public: false,
          use: "schede veicolo e type approval; nessun lookup pubblico di targhe o proprietari",
        },
      ],
      note: "Le fonti tecniche ASTRA richiedono accesso separato: non vengono esposte né simulate nella dashboard pubblica.",
      checkedAt: now,
    },
    localDetail: {
      status: "canton-level",
      note: "La dashboard usa BEST aggregato per cantone. Il file comunale elettrico non è stato trovato nel catalogo pubblico corrente; il modello è pronto per aggiungerlo senza cambiare il contratto client.",
      checkedAt: now,
    },
    source: {
      provider: "ASTRA/FEDRO — IVZ open data",
      overviewUrl: ASTRA_ENDPOINTS.overview,
      attribution:
        "Bundesamt für Strassen ASTRA / Office fédéral des routes OFROU",
      frequencies: {
        daily: "STNR",
        weekly: "NEUZU_W",
        biweeklyOrMonthly: "NEUZU",
        monthly: "BEST + GEBR",
      },
    },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(
    {
      ...payload,
      // Keep the raw compact datasets server-side so an unchanged source can be
      // reused without downloading it again on the next cron tick.
      datasets: Object.fromEntries(
        definitions.map(([key]) => [key, loaded[key].data]),
      ),
    },
    { merge: false },
  );

  const oldWeek = previousPeriod(previous, "weekly");
  const oldMonth = previousPeriod(previous, "monthly");
  const newWeek =
    oldWeek && oldWeek !== weeklyLatest.period ? weeklyLatest.period : "";
  const newMonth =
    oldMonth && oldMonth !== monthlyLatest.period ? monthlyLatest.period : "";

  logOk(
    `Scritto Firestore ${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}: settimana=${weeklyLatest.period}, mese=${monthlyLatest.period}`,
  );
  emitOutput("firestore_written", "true");
  emitOutput("latest_week", weeklyLatest.period);
  emitOutput("latest_month", monthlyLatest.period);
  emitOutput("new_week", newWeek);
  emitOutput("new_month", newMonth);
  emitOutput(
    "pending_week",
    pendingArticleUrls(articleOutbox, "weekly", "frontaliere"),
  );
  emitOutput(
    "pending_month_ch",
    pendingArticleUrls(articleOutbox, "monthly", "svizzera"),
  );
  emitOutput(
    "pending_month_ti",
    pendingArticleUrls(articleOutbox, "monthly", "frontaliere"),
  );
  emitOutput("daily_changed", daily.signal ? "true" : "false");
  emitOutput("daily_total", String(daily.national.total));
  emitOutput("daily_electric", String(daily.national.electric));
  emitOutput("daily_diesel", String(daily.national.diesel));
  emitOutput(
    "daily_average_co2",
    daily.national.averageCo2 === null ? "" : String(daily.national.averageCo2),
  );
  emitOutput(
    "ticino_stock",
    String(
      monthlyLatest.byCanton.find((row) => row.code === "TI")?.stock.total || 0,
    ),
  );
  emitOutput("ticino_weekly", String(weeklyLatest.byCanton.TI?.total || 0));
}

main().catch((error) => {
  logErr(
    `refresh-astra-vehicle-stats fallito: ${error?.stack || error?.message || error}`,
  );
  process.exit(1);
});
