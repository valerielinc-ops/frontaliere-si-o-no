/**
 * canton-notices-dataset.mjs — registro delle fonti e dataset
 * `canton-notices.json` (avvisi ufficiali cantonali, D11/P9g). Solo funzioni
 * pure: la rete sta in `scripts/crawl-canton-notices.mjs`.
 *
 * ## Da dove vengono le fonti
 *
 * Il profilo editoriale dei 24 gruppi cantonali vive nel repo del corpus
 * (`generator/data/canton-sections.json`, PR #2179) e non si importa: il
 * confine fra i due repo e' HTTP. `selectNoticeSources()` ne deriva le fonti
 * LENTE che alimentano gli hub — le fonti dati di categoria fisco / pensioni /
 * mobilita / servizi, quelle istituzionali delle categorie eventi/carburanti, e
 * le fonti news `istituzionale` che dichiarano almeno un tema avvisi — e
 * `scripts/build-canton-notice-sources.mjs` le scrive nel registro committato
 * `data/canton-notice-sources.json`, conservando la curatela per URL.
 *
 * La policy robots D10 e' gia' applicata dal profilo (una fonte vietata agli
 * agenti AI sta in `ownerDecisionPending` e non arriva qui) e viene
 * ricontrollata dal crawler a ogni giro.
 *
 * ## Cosa NON contiene il dataset
 *
 * Testo degli articoli, teaser, immagini: niente. Una voce e' titolo + link +
 * data + fonte, cioe' un indice che rimanda alla pagina ufficiale.
 */

import { createHash } from 'node:crypto';
import { NOTICE_CATEGORIES } from './canton-notices-classify.mjs';

export const SCHEMA_VERSION = 1;
export const SOURCES_SCHEMA_VERSION = 1;

/** Categorie le cui fonti dati sono avvisi per natura. */
const NOTICE_DATA_CATEGORIES = ['fisco', 'pensioni', 'mobilita', 'servizi'];
/** Per eventi/carburanti solo le fonti istituzionali: il resto e' dato numerico o agenda, ha la sua pipeline. */
const INSTITUTIONAL_KINDS = new Set(['istituzionale', 'fisco', 'previdenza']);
export const SUPPORTED_PARSERS = new Set(['rss', 'atom', 'html-links', 'json-entities', 'json-api']);
/** Adattatori dei `json-api` noti: host → forma della risposta. */
export const JSON_API_SHAPES = { 'www.zh.ch': 'zh-news-json', 'www.api.news.apps.be.ch': 'be-news-xml' };
/** Quirk del profilo che il crawler usa davvero; gli altri restano nel profilo. */
const CRAWL_QUIRKS = ['crawlDelaySeconds', 'maxRequestsPerRun', 'emptyPubDate', 'datesInList', 'charset', 'http1Only'];

// ── Soglie ───────────────────────────────────────────────────────────────────

export const THRESHOLDS = Object.freeze({
  /** Quota minima di fonti lette con successo (fonti bloccate da robots escluse dal conteggio). */
  minOkRatio: 0.6,
  /** Avvisi minimi nel dataset: misurati 2026-10-05 ~1.500 su 177 fonti attive. */
  minNotices: 400,
  /** Gruppi cantonali con almeno un avviso: misurati 24/24. */
  minCantons: 18,
  /** Un giro non puo' perdere piu' di meta' degli avvisi del giro precedente. */
  maxShrinkRatio: 0.5,
  /** Fallimenti consecutivi oltre i quali una fonte e' `failing` nel report. */
  failingAfter: 4,
});

/** Avvisi per fonte e eta' massima. */
export const PER_SOURCE_CAP = 25;
export const MAX_AGE_DAYS = 365;

// ── Registro ─────────────────────────────────────────────────────────────────

const shortHash = (s, n = 8) => createHash('sha1').update(s).digest('hex').slice(0, n);

export function sourceKey(canton, url) {
  const host = new URL(url).hostname.replace(/^www\./, '').split('.').slice(0, -1).join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return `${canton.toLowerCase()}-${host || 'src'}-${shortHash(`${canton}|${url}`, 6)}`;
}

/**
 * Dal profilo `canton-sections.json` alle fonti candidate per gli avvisi.
 * @returns {{ candidates: object[], skipped: object[] }}
 */
export function selectNoticeSources(profile) {
  const candidates = [];
  const skipped = [];
  for (const c of profile.cantons ?? []) {
    const push = (s, origin, fixedCategory, categories) => {
      const base = {
        canton: c.code,
        origin,
        fixedCategory,
        categories,
        url: s.url,
        parser: s.parser,
        language: s.language,
        publisher: s.publisher,
        kind: s.kind,
        quirks: Object.fromEntries(Object.entries(s.quirks ?? {}).filter(([k]) => CRAWL_QUIRKS.includes(k))),
      };
      if (!SUPPORTED_PARSERS.has(s.parser)) {
        skipped.push({ ...base, reason: `parser '${s.parser}' non e' una lista di avvisi (dato numerico o sitemap): resta alla pipeline della categoria` });
        return;
      }
      if (s.parser === 'json-api' && !JSON_API_SHAPES[new URL(s.url).hostname]) {
        skipped.push({ ...base, reason: 'json-api senza adattatore dedicato' });
        return;
      }
      candidates.push(base);
    };
    for (const [cat, list] of Object.entries(c.categoryDataSources ?? {})) {
      for (const s of list) {
        if (NOTICE_DATA_CATEGORIES.includes(cat) || INSTITUTIONAL_KINDS.has(s.kind)) push(s, 'category', cat, [cat]);
      }
    }
    for (const s of c.newsSources ?? []) {
      if (s.kind !== 'istituzionale') continue;
      const cats = (s.topics ?? []).filter((t) => NOTICE_CATEGORIES.includes(t));
      if (cats.length) push(s, 'news', null, cats);
    }
  }
  return { candidates, skipped };
}

/**
 * Unisce i candidati alla curatela esistente (per canton+URL). Una fonte
 * `html-links` senza `linkPattern` curato non viene attivata: finisce in
 * `excluded` con il motivo, finche' qualcuno non verifica la pagina.
 */
export function buildRegistry(profile, { previous = null, profileRef = {}, today = new Date().toISOString().slice(0, 10) } = {}) {
  const { candidates, skipped } = selectNoticeSources(profile);
  const curated = new Map();
  for (const s of previous?.sources ?? []) curated.set(`${s.canton}|${s.url}`, { active: true, entry: s });
  for (const s of previous?.excluded ?? []) if (s.curated) curated.set(`${s.canton}|${s.url}`, { active: false, entry: s });

  const sources = [];
  const excluded = skipped.map((s) => ({ canton: s.canton, url: s.url, parser: s.parser, categories: s.categories, reason: s.reason }));
  for (const cand of candidates) {
    const prev = curated.get(`${cand.canton}|${cand.url}`);
    if (prev && !prev.active) {
      excluded.push({ canton: cand.canton, url: cand.url, parser: cand.parser, categories: cand.categories, reason: prev.entry.reason, curated: true });
      continue;
    }
    const entry = { key: sourceKey(cand.canton, cand.url), ...cand };
    if (cand.parser === 'json-api') entry.apiShape = JSON_API_SHAPES[new URL(cand.url).hostname];
    if (cand.parser === 'html-links') {
      const p = prev?.entry;
      if (!p?.linkPattern) {
        excluded.push({ canton: cand.canton, url: cand.url, parser: cand.parser, categories: cand.categories, reason: 'html-links senza linkPattern curato: verificare la pagina e aggiungerlo' });
        continue;
      }
      entry.linkPattern = p.linkPattern;
      if (p.linkHosts?.length) entry.linkHosts = p.linkHosts;
      if (p.dropParams?.length) entry.dropParams = p.dropParams;
    }
    sources.push(entry);
  }
  const cantons = (profile.cantons ?? []).map((c) => c.code);
  return {
    _comment:
      'Registro delle fonti istituzionali LENTE per il dataset canton-notices.json (D11/P9g). Derivato da ' +
      'generator/data/canton-sections.json del corpus con scripts/build-canton-notice-sources.mjs, che conserva ' +
      'la curatela (linkPattern, esclusioni motivate) per canton+URL. Non modificare a mano le voci derivate: ' +
      'correggi il profilo nel corpus o la curatela qui e rigenera.',
    schemaVersion: SOURCES_SCHEMA_VERSION,
    derivedFrom: { repo: 'nanakokyobashi-rgb/frontaliere-articles', path: 'generator/data/canton-sections.json', ...profileRef },
    curatedAt: today,
    aiInputAgents: profile.aiInputAgents ?? [],
    cantons,
    sources,
    excluded,
  };
}

/** Contratto statico del registro. @returns {string[]} violazioni */
export function validateRegistry(reg) {
  const errors = [];
  if (reg?.schemaVersion !== SOURCES_SCHEMA_VERSION) errors.push(`schemaVersion ${reg?.schemaVersion} != ${SOURCES_SCHEMA_VERSION}`);
  const cantons = new Set(reg?.cantons ?? []);
  if (cantons.size !== 24) errors.push(`attesi 24 gruppi cantonali, trovati ${cantons.size}`);
  if (!Array.isArray(reg?.aiInputAgents) || !reg.aiInputAgents.includes('ClaudeBot')) errors.push('aiInputAgents assente o senza ClaudeBot');
  const keys = new Set();
  const pairs = new Set();
  for (const s of reg?.sources ?? []) {
    const where = s.key ?? s.url;
    if (keys.has(s.key)) errors.push(`${where}: key duplicata`);
    keys.add(s.key);
    if (pairs.has(`${s.canton}|${s.url}`)) errors.push(`${where}: canton+URL duplicati`);
    pairs.add(`${s.canton}|${s.url}`);
    if (!cantons.has(s.canton)) errors.push(`${where}: canton sconosciuto ${s.canton}`);
    try {
      if (new URL(s.url).protocol !== 'https:') errors.push(`${where}: URL non https`);
    } catch {
      errors.push(`${where}: URL non valido`);
    }
    if (!SUPPORTED_PARSERS.has(s.parser)) errors.push(`${where}: parser ${s.parser} non supportato`);
    if (!Array.isArray(s.categories) || !s.categories.length || s.categories.some((c) => !NOTICE_CATEGORIES.includes(c))) {
      errors.push(`${where}: categories non valide`);
    }
    if (s.fixedCategory != null && !s.categories.includes(s.fixedCategory)) errors.push(`${where}: fixedCategory fuori da categories`);
    if (s.origin === 'category' && !s.fixedCategory) errors.push(`${where}: fonte di categoria senza fixedCategory`);
    if (s.parser === 'html-links') {
      if (!s.linkPattern) errors.push(`${where}: html-links senza linkPattern`);
      else {
        try {
          new RegExp(s.linkPattern);
          if (!s.linkPattern.startsWith('^/')) errors.push(`${where}: linkPattern deve ancorarsi al path (^/)`);
        } catch (err) {
          errors.push(`${where}: linkPattern non compila: ${err.message}`);
        }
      }
    }
    if (s.parser === 'json-api' && !Object.values(JSON_API_SHAPES).includes(s.apiShape)) errors.push(`${where}: apiShape mancante`);
  }
  for (const e of reg?.excluded ?? []) if (!e.reason) errors.push(`${e.url}: esclusa senza motivo`);
  return errors;
}

// ── Dataset ──────────────────────────────────────────────────────────────────

export const noticeId = (canton, url) => shortHash(`${canton}|${url}`, 16);

const DAY = 86_400_000;
const ageDays = (iso, now) => (now - (iso.length === 10 ? Date.parse(`${iso}T00:00:00Z`) : Date.parse(iso))) / DAY;

/**
 * Unisce l'esito di un giro con il dataset precedente.
 *
 * - fonte letta (`ok`): le voci correnti, piu' quelle datate viste nei giri
 *   precedenti e uscite dalla lista (le liste scorrono) entro `MAX_AGE_DAYS`;
 *   una voce senza data vale solo finche' la pagina la elenca;
 * - fonte non letta (errore di rete/HTTP/parse): restano le voci del giro
 *   precedente (last-known-good) e cresce `consecutiveFailures`;
 * - fonte bloccata da robots: le voci escono (la policy si rispetta anche
 *   all'indietro).
 *
 * `observedAt` e' la prima osservazione e non cambia nei giri successivi.
 */
export function mergeNotices({ registry, results, previous = null, now = Date.now() }) {
  const nowIso = new Date(now).toISOString();
  const prevBySource = new Map();
  for (const n of previous?.notices ?? []) {
    if (!prevBySource.has(n.source)) prevBySource.set(n.source, []);
    prevBySource.get(n.source).push(n);
  }
  const prevHealth = previous?.health?.sources ?? {};
  const notices = [];
  const health = {};
  // La stessa pagina ufficiale puo' arrivare da due fonti dello stesso cantone
  // (ar.ch: medienmitteilungen e news del dipartimento): vince la prima fonte
  // del registro, che elenca prima le fonti di categoria.
  const taken = new Set();

  for (const src of registry.sources) {
    const r = results.get(src.key) ?? { status: 'not-run' };
    const before = prevHealth[src.key] ?? {};
    const prevNotices = prevBySource.get(src.key) ?? [];
    const prevById = new Map(prevNotices.map((n) => [n.id, n]));
    let kept = [];
    const ok = r.status === 'ok';
    const blocked = r.status === 'robots-blocked' || r.status === 'ai-input-blocked';

    if (ok) {
      const seen = new Set();
      for (const it of r.notices) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        const old = prevById.get(it.id);
        kept.push({ ...it, observedAt: old?.observedAt ?? nowIso, publishedAt: it.publishedAt ?? old?.publishedAt ?? null });
      }
      for (const old of prevNotices) if (!seen.has(old.id) && old.publishedAt) kept.push(old);
    } else if (!blocked) {
      kept = prevNotices.slice();
    }
    kept = kept.filter((n) => !n.publishedAt || ageDays(n.publishedAt, now) <= MAX_AGE_DAYS);
    kept.sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')) || a.title.localeCompare(b.title));
    kept = kept.filter((n) => !taken.has(n.id)).slice(0, PER_SOURCE_CAP);
    for (const n of kept) taken.add(n.id);
    notices.push(...kept);

    const consecutiveFailures = ok ? 0 : blocked ? before.consecutiveFailures ?? 0 : (before.consecutiveFailures ?? 0) + 1;
    health[src.key] = {
      canton: src.canton,
      status: ok ? (r.items === 0 ? 'empty' : 'ok') : r.status,
      ...(r.httpStatus != null ? { httpStatus: r.httpStatus } : {}),
      items: r.items ?? 0,
      notices: kept.length,
      ...(r.unclassified ? { unclassified: r.unclassified } : {}),
      consecutiveFailures,
      lastOkAt: ok ? nowIso : before.lastOkAt ?? null,
      ...(r.error ? { lastError: String(r.error).slice(0, 300) } : {}),
      ...(r.robotsRule ? { robotsRule: r.robotsRule } : {}),
      ...(!ok && !blocked && consecutiveFailures >= THRESHOLDS.failingAfter ? { failing: true } : {}),
      ...(ok && r.items === 0 && (before.items ?? 0) > 0 ? { patternMiss: true } : {}),
    };
  }

  notices.sort(
    (a, b) =>
      a.canton.localeCompare(b.canton) ||
      a.category.localeCompare(b.category) ||
      String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')) ||
      a.id.localeCompare(b.id),
  );
  return { notices, health };
}

export function summarize(registry, notices, health) {
  const byStatus = {};
  for (const h of Object.values(health)) byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
  const byCanton = {};
  const byCategory = {};
  for (const n of notices) {
    byCanton[n.canton] = (byCanton[n.canton] ?? 0) + 1;
    byCategory[n.category] = (byCategory[n.category] ?? 0) + 1;
  }
  const attempted = Object.values(health).filter((h) => !['robots-blocked', 'ai-input-blocked', 'not-run'].includes(h.status)).length;
  const okCount = Object.values(health).filter((h) => h.status === 'ok' || h.status === 'empty').length;
  return {
    sources: registry.sources.length,
    attempted,
    ok: okCount,
    okRatio: attempted ? Number((okCount / attempted).toFixed(3)) : 0,
    byStatus,
    failing: Object.entries(health).filter(([, h]) => h.failing).map(([k]) => k),
    patternMiss: Object.entries(health).filter(([, h]) => h.patternMiss).map(([k]) => k),
    notices: notices.length,
    dated: notices.filter((n) => n.publishedAt).length,
    cantons: Object.keys(byCanton).length,
    byCanton,
    byCategory,
  };
}

/** Soglie di validita' del giro. @returns {string[]} motivi per NON scrivere */
export function checkThresholds(summary, { previous = null, thresholds = THRESHOLDS } = {}) {
  const fails = [];
  if (summary.okRatio < thresholds.minOkRatio) fails.push(`fonti lette ${summary.ok}/${summary.attempted} (${summary.okRatio}) < ${thresholds.minOkRatio}`);
  if (summary.notices < thresholds.minNotices) fails.push(`avvisi ${summary.notices} < ${thresholds.minNotices}`);
  if (summary.cantons < thresholds.minCantons) fails.push(`gruppi cantonali con avvisi ${summary.cantons} < ${thresholds.minCantons}`);
  const prevCount = previous?.notices?.length ?? 0;
  if (prevCount && summary.notices < prevCount * thresholds.maxShrinkRatio) {
    fails.push(`avvisi ${summary.notices} < ${thresholds.maxShrinkRatio} x ${prevCount} del giro precedente`);
  }
  return fails;
}

/** Forma di ogni voce: il contratto che il corpus (refresh-canton-notices) ricontrolla. */
export function validateNotices(notices, cantons) {
  const errors = [];
  const ids = new Set();
  const cset = new Set(cantons);
  for (const n of notices) {
    const where = n.id ?? n.url;
    if (!/^[0-9a-f]{16}$/.test(n.id ?? '')) errors.push(`${where}: id non valido`);
    if (ids.has(n.id)) errors.push(`${where}: id duplicato`);
    ids.add(n.id);
    if (!cset.has(n.canton)) errors.push(`${where}: canton ${n.canton}`);
    if (!NOTICE_CATEGORIES.includes(n.category)) errors.push(`${where}: category ${n.category}`);
    if (typeof n.title !== 'string' || n.title.length < 8 || n.title.length > 240) errors.push(`${where}: title`);
    if (!/^https?:\/\//.test(n.url ?? '')) errors.push(`${where}: url`);
    if (n.publishedAt !== null && !/^\d{4}-\d\d-\d\d(T\d\d:\d\d:\d\d(\.\d+)?Z)?$/.test(String(n.publishedAt))) errors.push(`${where}: publishedAt ${n.publishedAt}`);
    if (!/^\d{4}-\d\d-\d\dT/.test(n.observedAt ?? '')) errors.push(`${where}: observedAt`);
    if (typeof n.source !== 'string' || !n.source) errors.push(`${where}: source`);
  }
  return errors;
}
