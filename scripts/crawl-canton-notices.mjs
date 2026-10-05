#!/usr/bin/env node
/**
 * crawl-canton-notices.mjs — avvisi ufficiali cantonali (D11/P9g).
 *
 * Legge le fonti istituzionali LENTE del registro `data/canton-notice-sources.json`
 * (amministrazioni fiscali, casse AVS e pensioni, uffici mobilita'/cantieri,
 * sanita', migrazione, comunicati di Cantoni e Comuni) e scrive
 * `data/canton-notices.json` + `public/data/canton-notices.json` (stesso
 * contenuto; il secondo arriva sul CDN con il deploy e lo legge il corpus con
 * `generator/scripts/refresh-canton-notices.mjs`).
 *
 * Solo metadati: canton, category, title, url, publishedAt, source,
 * observedAt. Nessun testo degli articoli.
 *
 * Cortesia verso le fonti:
 *  - user agent dichiarato (`FrontaliereTicinoBot`), mai camuffato (D10);
 *  - robots.txt riletto a ogni giro per host: Disallow per noi o per `*`,
 *    divieto esplicito agli agenti AI di input del profilo o
 *    `Content-Signal: ai-input=no` → la fonte salta e le sue voci escono;
 *  - una richiesta per fonte (niente paginazione), una sola volta per URL;
 *  - richieste allo stesso SERVER in serie (host raggruppati per indirizzo IP:
 *    decine di Comuni stanno sullo stesso hosting), distanziate da
 *    max(crawlDelaySeconds del profilo, Crawl-delay di robots, 1 s);
 *  - `maxRequestsPerRun` del profilo e' per fonte (sz.ch: il WAF chiude dopo
 *    una raffica): il crawler fa sempre UNA richiesta di pagina per fonte e, su
 *    quelle fonti, nessun nuovo tentativo dopo un errore. robots.txt e' a parte:
 *    RFC 9309 lo richiede ed e' una sola lettura per host.
 *  - 4xx non si ritenta mai (un 403 e' «fonte chiusa per ora», non rumore).
 *
 * Soglie (`THRESHOLDS` in scripts/lib/canton-notices-dataset.mjs): se il giro
 * legge meno del 60% delle fonti, scende sotto il pavimento di avvisi o di
 * cantoni, o perde piu' di meta' degli avvisi del giro precedente, NON scrive
 * ed esce 1. Una fonte che fallisce tiene le voci dell'ultimo giro buono.
 *
 * Uso:
 *   node scripts/crawl-canton-notices.mjs            # giro completo, scrive
 *   node scripts/crawl-canton-notices.mjs --check    # giro completo, non scrive
 *   node scripts/crawl-canton-notices.mjs --only=<key>[,<key>]  # solo quelle fonti (implica --check)
 *
 * Env (test): CANTON_NOTICES_REGISTRY, CANTON_NOTICES_OUT, CANTON_NOTICES_PUBLIC_OUT.
 */

import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  parseBeNewsApi,
  parseFeed,
  parseHtmlLinks,
  parseJsonEntities,
  parseZhNewsJson,
} from './lib/canton-notices-parse.mjs';
import { classifyNotice } from './lib/canton-notices-classify.mjs';
import { aiInputBlock, isAllowed, robotsFromResponse } from './lib/robots-policy.mjs';
import { RETRYABLE_STATUS, isTransientFetchError, parseRetryAfterMs } from './lib/transient-fetch.mjs';
import {
  SCHEMA_VERSION,
  checkThresholds,
  mergeNotices,
  noticeId,
  summarize,
  validateNotices,
  validateRegistry,
} from './lib/canton-notices-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = process.env.CANTON_NOTICES_REGISTRY || path.join(ROOT, 'data', 'canton-notice-sources.json');
const OUT_PATH = process.env.CANTON_NOTICES_OUT || path.join(ROOT, 'data', 'canton-notices.json');
const PUBLIC_OUT_PATH = process.env.CANTON_NOTICES_PUBLIC_OUT || path.join(ROOT, 'public', 'data', 'canton-notices.json');

export const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
export const ROBOTS_TOKEN = 'frontaliereticinobot';
const FETCH_TIMEOUT_MS = 25_000;
const BACKEND_CONCURRENCY = 6;
const MIN_DELAY_S = 1;
const MAX_DELAY_S = 30;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ACCEPT = {
  rss: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  atom: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  'json-api': 'application/json, application/xml;q=0.9, */*;q=0.8',
  // Niente `application/json` qui: sg.ch (IIS) chiude lo stream HTTP/2 con
  // l'Accept lungo che lo include, e risponde 200 con questo.
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

const log = (msg) => console.log(`[crawl-canton-notices] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decodifica col charset dichiarato (header, dichiarazione XML, meta): statistique.ge.ch e' ISO-8859-1. */
export function decodeBody(buf, contentType = '') {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  const declared =
    /charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(contentType)?.[1] ||
    /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(head)?.[1] ||
    'utf-8';
  try {
    return new TextDecoder(declared.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function httpGet(url, { accept, fetchImpl = fetch, retry = true }) {
  let lastErr = null;
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'follow', signal: ctl.signal });
      const buf = new Uint8Array(await res.arrayBuffer());
      clearTimeout(timer);
      // Stessa classe di «ritentabile» di tutti i crawler (transient-fetch.mjs),
      // con un tetto piu' stretto sull'attesa: e' un giro di 175 fonti.
      if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
        await sleep(parseRetryAfterMs(res.headers.get('retry-after'), { capMs: 60_000 }) ?? 5000);
        continue;
      }
      if (buf.byteLength > MAX_BODY_BYTES) return { status: res.status, error: `risposta oltre ${MAX_BODY_BYTES} byte` };
      return { status: res.status, finalUrl: res.url || url, body: decodeBody(buf, res.headers.get('content-type') ?? '') };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (!isTransientFetchError(err)) break;
      if (attempt < attempts - 1) await sleep(3000);
    }
  }
  return { status: null, error: lastErr?.cause?.code || lastErr?.message || 'errore di rete' };
}

function parseFor(src, body, pageUrl, now) {
  const opts = { pageUrl, now };
  switch (src.parser) {
    case 'rss':
    case 'atom':
      return parseFeed(body, { ...opts, emptyPubDate: src.quirks?.emptyPubDate === true });
    case 'html-links':
      return parseHtmlLinks(body, {
        ...opts,
        linkPattern: src.linkPattern,
        linkHosts: src.linkHosts ?? [],
        dropParams: src.dropParams ?? [],
        datesInList: src.quirks?.datesInList !== false,
      });
    case 'json-entities':
      return parseJsonEntities(body, opts);
    case 'json-api':
      return src.apiShape === 'zh-news-json' ? parseZhNewsJson(body, opts) : parseBeNewsApi(body, opts);
    default:
      return { items: [], warnings: [], error: `parser ${src.parser}` };
  }
}

/**
 * Esegue un giro su `sources` (sottoinsieme del registro).
 * @returns {Promise<Map<string, object>>} key → esito
 */
/**
 * Raggruppa gli host per indirizzo IP: molti Comuni e Cantoni della Svizzera
 * centrale (nw.ch, ow.ch, ur.ch, stadtluzern.ch, hergiswil.ch …) stanno sullo
 * stesso server del fornitore CMS, che chiude la connessione a chi lo
 * interroga in parallelo da piu' «siti». La cortesia va misurata sul server,
 * non sul nome: un gruppo = una coda seriale.
 */
async function groupByBackend(hosts, lookup) {
  const groups = new Map();
  await Promise.all(
    hosts.map(async (h) => {
      let key = `host:${h}`;
      try {
        const { address } = await lookup(h);
        if (address) key = `ip:${address}`;
      } catch {
        /* DNS non risolto: resta un gruppo a se', l'errore emergera' dal fetch */
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }),
  );
  return [...groups.values()].map((list) => list.sort());
}

export async function crawlSources(registry, sources, { fetchImpl = fetch, now = Date.now(), delayScale = 1, lookup = (h) => dns.lookup(h) } = {}) {
  const byHost = new Map();
  for (const s of sources) {
    const h = new URL(s.url).host;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(s);
  }
  const results = new Map();
  const bodyCache = new Map();
  const backends = await groupByBackend([...byHost.keys()], lookup);
  let cursor = 0;

  async function runBackend(hostList) {
    let last = 0;
    // Ogni richiesta verso lo stesso server (robots.txt compreso) aspetta il
    // ritardo dalla precedente.
    const pace = async (delayS) => {
      const wait = last + delayS * 1000 * delayScale - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    };
    for (const host of hostList) await runHost(byHost.get(host), pace);
  }

  async function runHost(list, pace) {
    const origin = new URL(list[0].url).origin;
    await pace(Math.max(MIN_DELAY_S, ...list.map((x) => Math.min(x.quirks?.crawlDelaySeconds ?? 0, MAX_DELAY_S))));
    const robotsRes = await httpGet(`${origin}/robots.txt`, { accept: 'text/plain,*/*;q=0.8', fetchImpl });
    const robots = robotsRes.status == null ? robotsFromResponse(503, '') : robotsFromResponse(robotsRes.status, robotsRes.body);
    for (const src of list) {
      const verdict = isAllowed(robots.parsed, ROBOTS_TOKEN, src.url);
      const delayS = Math.min(Math.max(MIN_DELAY_S, src.quirks?.crawlDelaySeconds ?? 0, verdict.crawlDelay ?? 0), MAX_DELAY_S);
      if (robots.state === 'unreachable') {
        results.set(src.key, { status: 'robots-unreachable', error: `robots.txt non raggiungibile (${robotsRes.status ?? robotsRes.error})` });
        continue;
      }
      if (!verdict.allowed) {
        results.set(src.key, { status: 'robots-blocked', robotsRule: verdict.rule });
        continue;
      }
      const aiRule = aiInputBlock(robots.parsed, registry.aiInputAgents ?? [], src.url);
      if (aiRule) {
        results.set(src.key, { status: 'ai-input-blocked', robotsRule: aiRule });
        continue;
      }
      let res = bodyCache.get(src.url);
      if (!res) {
        await pace(delayS);
        res = await httpGet(src.url, { accept: ACCEPT[src.parser] ?? ACCEPT.html, fetchImpl, retry: src.quirks?.maxRequestsPerRun == null });
        bodyCache.set(src.url, res);
      }
      if (res.status == null) {
        results.set(src.key, { status: 'network-error', error: res.error });
        continue;
      }
      if (res.status < 200 || res.status >= 300 || res.body == null) {
        results.set(src.key, { status: 'http-error', httpStatus: res.status, error: res.error ?? `HTTP ${res.status}` });
        continue;
      }
      const parsed = parseFor(src, res.body, res.finalUrl, now);
      if (parsed.error) {
        results.set(src.key, { status: 'parse-error', httpStatus: res.status, error: parsed.warnings.join('; ') || parsed.error });
        continue;
      }
      let unclassified = 0;
      const notices = [];
      for (const it of parsed.items) {
        const category = classifyNotice(it, src);
        if (!category) {
          unclassified++;
          continue;
        }
        notices.push({
          id: noticeId(src.canton, it.url),
          canton: src.canton,
          category,
          title: it.title,
          url: it.url,
          publishedAt: it.publishedAt ?? null,
          source: src.key,
          language: src.language ?? null,
        });
      }
      results.set(src.key, { status: 'ok', httpStatus: res.status, items: parsed.items.length, unclassified, notices });
    }
  }

  async function worker() {
    while (cursor < backends.length) {
      const group = backends[cursor++];
      try {
        await runBackend(group);
      } catch (err) {
        for (const h of group) for (const s of byHost.get(h)) if (!results.has(s.key)) results.set(s.key, { status: 'network-error', error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BACKEND_CONCURRENCY, backends.length) }, worker));
  return results;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function stepSummary(summary, fails) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    '## Avvisi ufficiali cantonali',
    '',
    `Fonti lette ${summary.ok}/${summary.attempted} (${(summary.okRatio * 100).toFixed(0)}%) · avvisi ${summary.notices} (${summary.dated} datati) · cantoni ${summary.cantons}/24`,
    '',
    `Stato fonti: ${Object.entries(summary.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    '',
    summary.failing.length ? `Fonti \`failing\`: ${summary.failing.join(', ')}` : 'Nessuna fonte `failing`.',
    summary.patternMiss.length ? `Fonti con lista vuota dopo un giro pieno (pagina cambiata?): ${summary.patternMiss.join(', ')}` : '',
    fails.length ? `\n**Soglie non rispettate, nessuna scrittura:**\n${fails.map((f) => `- ${f}`).join('\n')}` : '',
  ];
  fs.appendFileSync(file, `${lines.filter((l) => l !== null).join('\n')}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? null;
  const checkOnly = argv.includes('--check') || !!only;

  const registry = readJson(REGISTRY_PATH);
  if (!registry) throw new Error(`registro non leggibile: ${REGISTRY_PATH}`);
  const regErrors = validateRegistry(registry);
  if (regErrors.length) {
    for (const e of regErrors) console.error(`::error::[crawl-canton-notices] registro: ${e}`);
    process.exit(1);
  }
  const sources = only ? registry.sources.filter((s) => only.includes(s.key)) : registry.sources;
  if (only && sources.length !== only.length) throw new Error(`--only: chiavi sconosciute ${only.filter((k) => !registry.sources.some((s) => s.key === k)).join(', ')}`);

  const now = Date.now();
  log(`${sources.length} fonti su ${new Set(sources.map((s) => new URL(s.url).host)).size} host`);
  const results = await crawlSources(registry, sources, { now });

  if (only) {
    for (const s of sources) {
      const r = results.get(s.key);
      log(`${s.key}: ${r.status} items=${r.items ?? 0} notices=${r.notices?.length ?? 0} ${r.error ?? r.robotsRule ?? ''}`);
      for (const n of r.notices ?? []) log(`   ${n.publishedAt ?? '----------'} [${n.category}] ${n.title}`);
    }
    return;
  }

  const previous = readJson(OUT_PATH);
  const { notices, health } = mergeNotices({ registry, results, previous, now });
  const summary = summarize(registry, notices, health);
  const fails = [...checkThresholds(summary, { previous }), ...validateNotices(notices, registry.cantons).slice(0, 20)];
  log(`fonti ok ${summary.ok}/${summary.attempted} · avvisi ${summary.notices} (${summary.dated} datati) · cantoni ${summary.cantons}`);
  log(`stato fonti: ${JSON.stringify(summary.byStatus)} · categorie: ${JSON.stringify(summary.byCategory)}`);
  for (const k of summary.failing) console.log(`::warning::[crawl-canton-notices] fonte failing: ${k} (${health[k].lastError ?? health[k].status})`);
  for (const k of summary.patternMiss) console.log(`::warning::[crawl-canton-notices] lista vuota dopo un giro pieno: ${k}`);
  stepSummary(summary, fails);
  if (fails.length) {
    for (const f of fails) console.error(`::error::[crawl-canton-notices] ${f}`);
    process.exit(1);
  }
  if (checkOnly) {
    log('--check: nessuna scrittura');
    return;
  }

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    sourcesRegistry: { schemaVersion: registry.schemaVersion, curatedAt: registry.curatedAt, derivedFrom: registry.derivedFrom },
    categories: ['fisco', 'pensioni', 'mobilita', 'servizi', 'eventi', 'carburanti'],
    totalNotices: notices.length,
    sources: Object.fromEntries(
      registry.sources.map((s) => [s.key, { canton: s.canton, publisher: s.publisher, url: s.url, kind: s.kind, language: s.language }]),
    ),
    notices: notices.map((n) => ({ ...n })),
    health: { generatedAt: new Date(now).toISOString(), summary, sources: health },
  };
  writeJsonAtomic(OUT_PATH, doc);
  writeJsonAtomic(PUBLIC_OUT_PATH, doc);
  log(`scritti ${path.relative(ROOT, OUT_PATH)} e ${path.relative(ROOT, PUBLIC_OUT_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::[crawl-canton-notices] ${err.stack || err.message}`);
    process.exit(1);
  });
}
