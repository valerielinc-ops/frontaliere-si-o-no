#!/usr/bin/env node
/**
 * Collect road events (chiusure, cantieri, traffico, trasporto pubblico) per
 * canton into data/road-events.json + public/data/road-events.json.
 *
 * Producer of the mobility dataset of the per-canton article sections (plan
 * P9c): the site collects, the articles repo reads the published JSON over
 * HTTP (generator/scripts/refresh-road-events.mjs there). Parsers and the
 * source registry live in scripts/lib/road-events.mjs.
 *
 * Sources:
 *   - ASTRA DATEX II traffic situations (opentransportdata.swiss), with the
 *     dedicated OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN (Remote Config, loaded
 *     by scripts/load-rc-env.mjs). No token → the source is reported as
 *     `skipped` and the cantonal feeds still publish. Every call reserves a
 *     unit of the shared `opentransportdata/traffic-situations` quota first
 *     (functions/src/trafficProviderMesh.js: 5/min, six-month ceiling).
 *   - Cantonal mobility / police feeds (ROAD_EVENT_FEEDS).
 *
 * A source that fails this run keeps its events from the previous file for up
 * to CARRY_FORWARD_HOURS after ITS OWN last success (`sources[].lastSuccessAt`),
 * so one unreachable feed does not blank a canton — and a feed that stays down
 * is not kept alive indefinitely by the other sources rewriting the file.
 * Nothing is written when every source failed or the payload fails the gate.
 *
 * Usage:
 *   node scripts/collect-road-events.mjs
 *   node scripts/collect-road-events.mjs --check     # collect + validate, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  DATEX_SITUATIONS_URL,
  DATEX_SOAP_ACTION,
  ROAD_EVENTS_SCHEMA_VERSION,
  ROAD_EVENTS_USER_AGENT,
  ROAD_EVENT_FEEDS,
  buildCantonGazetteer,
  buildCantonGroupMap,
  carryForwardFailedSources,
  datexPullRequestBody,
  dedupeRoadEvents,
  feedItemsToEvents,
  parseDatexSituations,
  parseFeedItems,
  validateRoadEventsPayload,
} from './lib/road-events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATHS = [
  path.join(REPO_ROOT, 'data', 'road-events.json'),
  path.join(REPO_ROOT, 'public', 'data', 'road-events.json'),
];
const CHECK_ONLY = process.argv.includes('--check');
const CARRY_FORWARD_HOURS = 24;
const FEED_TIMEOUT_MS = 20_000;
const DATEX_TIMEOUT_MS = 90_000;

const log = (msg) => console.log(`[collect-road-events] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[collect-road-events] ${msg}`);
  process.exit(1);
};

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

async function fetchText(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function reserveDatexRequest() {
  // Imported lazily: firebase-admin is only needed when a token is configured.
  const { reserveTrafficProviderRequest } = await import('../functions/src/trafficProviderMesh.js');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reservation = await reserveTrafficProviderRequest('opentransportdata', 'traffic-situations');
    if (reservation?.allowed) return reservation;
    const wait = Number(reservation?.retryAfterMs);
    if (reservation?.reason !== 'rate-limit' || !Number.isFinite(wait) || wait <= 0) return reservation;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.ceil(wait), 60_000)));
  }
  return { allowed: false, reason: 'rate-limit' };
}

async function collectDatex({ now, gazetteer, toGroup }) {
  const token = process.env.OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN;
  if (!token) return { id: 'astra-datex2', status: 'skipped', reason: 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN not set', events: [] };
  const reservation = await reserveDatexRequest();
  if (!reservation?.allowed) {
    return { id: 'astra-datex2', status: 'skipped', reason: `quota guard: ${reservation?.reason ?? 'blocked'}`, events: [] };
  }
  const xml = await fetchText(
    DATEX_SITUATIONS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: DATEX_SOAP_ACTION,
        'User-Agent': ROAD_EVENTS_USER_AGENT,
      },
      body: datexPullRequestBody(),
    },
    DATEX_TIMEOUT_MS,
  );
  const { events, stats } = parseDatexSituations(xml, { gazetteer, toGroup, now });
  if (stats.situations === 0) throw new Error('response carries zero situations');
  const active = stats.situations - stats.expired;
  const coverage = active > 0 ? ((stats.kept / active) * 100).toFixed(1) : '0.0';
  log(
    `astra-datex2: ${stats.situations} situations, ${stats.expired} outside the window, ` +
      `${stats.kept} located (${coverage}% canton coverage), ${stats.unresolved} dropped (no single canton)`,
  );
  return { id: 'astra-datex2', status: 'ok', count: events.length, coverage: Number(coverage), events };
}

async function collectFeed(feed, now) {
  const xml = await fetchText(feed.url, { headers: { 'User-Agent': ROAD_EVENTS_USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } }, FEED_TIMEOUT_MS);
  const items = parseFeedItems(xml);
  if (items.length === 0) throw new Error('feed carries zero items');
  const events = feedItemsToEvents(feed, items, { now });
  return { id: feed.id, status: 'ok', count: events.length, events };
}

function previousPayload() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATHS[0], 'utf8'));
  } catch {
    return null;
  }
}

const now = new Date();
const gazetteer = buildCantonGazetteer({
  municipalities: readJson('data/canton-municipalities.json'),
  localities: readJson('data/swiss-locality-postal-codes.json'),
});
const cantonUrlSlugs = readJson('data/canton-url-slugs.json');
const toGroup = buildCantonGroupMap(cantonUrlSlugs);
const knownCantons = new Set(Object.keys(cantonUrlSlugs.cantons ?? {}));

const results = [];
try {
  results.push(await collectDatex({ now, gazetteer, toGroup }));
} catch (err) {
  results.push({ id: 'astra-datex2', status: 'error', reason: err.message, events: [] });
}
for (const feed of ROAD_EVENT_FEEDS) {
  try {
    results.push(await collectFeed(feed, now));
  } catch (err) {
    results.push({ id: feed.id, status: 'error', reason: err.message, events: [] });
  }
}

const ok = results.filter((r) => r.status === 'ok');
if (ok.length === 0) {
  fail(`every source failed or was skipped — ${results.map((r) => `${r.id}: ${r.reason}`).join('; ')}`);
}

// Each source records its own last success; a failing source is carried
// forward from the previous file only while that timestamp is recent.
const events = [
  ...results.flatMap((r) => r.events),
  ...carryForwardFailedSources(results, previousPayload(), { now, maxHours: CARRY_FORWARD_HOURS }),
];

const payload = {
  schemaVersion: ROAD_EVENTS_SCHEMA_VERSION,
  generatedAt: now.toISOString(),
  sources: results.map(({ events: _events, ...rest }) => rest),
  events: dedupeRoadEvents(events),
};

const errors = validateRoadEventsPayload(payload, { knownCantons });
if (errors.length) fail(`payload failed the gate:\n  ${errors.slice(0, 20).join('\n  ')}`);
if (payload.events.length === 0) fail('zero events across every source — refusing to publish an empty dataset');

for (const r of results) {
  const extra = r.carriedForward ? `, ${r.carriedForward} carried forward` : '';
  log(`${r.id}: ${r.status}${r.count !== undefined ? ` (${r.count})` : ''}${r.reason ? ` — ${r.reason}` : ''}${extra}`);
}
const perCanton = {};
for (const e of payload.events) perCanton[e.canton] = (perCanton[e.canton] ?? 0) + 1;
log(`${payload.events.length} events in ${Object.keys(perCanton).length} cantons: ${JSON.stringify(perCanton)}`);

if (CHECK_ONLY) {
  log('--check: wrote nothing');
  process.exit(0);
}
for (const out of OUT_PATHS) writeJsonAtomic(out, payload);
log(`wrote ${OUT_PATHS.map((p) => path.relative(REPO_ROOT, p)).join(' + ')}`);
// firebase-admin keeps the event loop alive after a reservation.
process.exit(0);
