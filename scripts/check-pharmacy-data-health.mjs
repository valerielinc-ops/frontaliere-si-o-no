/**
 * check-pharmacy-data-health.mjs — Dashboard interna sulla qualità del dato
 * della verticale farmacie (#6753, item "dashboard interna" di #6400).
 *
 * Misura le quattro dimensioni che `docs/pharmacy-data-policy.md` dichiara ma
 * che finora nessuno osservava:
 *   1. COPERTURA   — quanti dei 26 cantoni svizzeri hanno una fonte registrata
 *                    in `data/pharmacy-sources-registry.json`, con quale
 *                    `status`, e quali di quelli `active` hanno davvero un
 *                    dataset pubblicato (anagrafica e/o turni).
 *   2. FRESCHEZZA  — età di `_fetchedAt` di ogni dataset contro il suo SLA:
 *                    l'anagrafica è a bassa volatilità (SLA mensile, policy →
 *                    "SLA di aggiornamento"), i turni contro il
 *                    `fetchFrequency` ISO-8601 dichiarato nel registry.
 *   3. ERRORI FETCH— `_errors[]` che l'importer lascia nel dataset: oggi
 *                    `scripts/import-pharmacies-ticino.mjs` li scrive e
 *                    nessuno li rilegge mai.
 *   4. CONFLITTI   — id/slug duplicati, stessa farmacia emessa da due regioni
 *                    diverse, e (quando i turni esisteranno) turni `conflicting`
 *                    o `verified` già scaduti oltre `endsAt` — la condizione
 *                    che la policy vieta esplicitamente di pubblicare.
 *
 * NON pubblica nulla e non tocca pagine: è un osservatore interno. I dataset
 * dei turni non esistono ancora (pipeline #6750): la loro assenza è uno stato
 * ATTESO, riportato come tale e non come problema — altrimenti il monitor
 * nascerebbe rosso e verrebbe ignorato.
 *
 * Exit code: 0 se sano, 1 se degradato. Il report machine-readable finisce in
 * `data/pharmacy-data-health-report.json` per il workflow che apre l'issue.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Tunables ────────────────────────────────────────────────────────
/**
 * SLA anagrafica: `docs/pharmacy-data-policy.md` → "SLA di aggiornamento" la
 * dichiara "settimanale/mensile (fonte a bassa volatilità)". Prendiamo l'estremo
 * lasco (mensile) più margine, così il monitor non paga per un import che gira
 * a cadenza settimanale saltando una settimana.
 */
export const DEFAULT_ANAGRAFICA_MAX_AGE_HOURS = 35 * 24;
/**
 * Per i turni lo SLA è il `fetchFrequency` del registry, moltiplicato per questa
 * tolleranza: un solo fetch saltato è rumore, due consecutivi sono un guasto.
 */
export const DUTIES_SLA_TOLERANCE = 2;

// ── Pure logic (unit-tested; NO IO) ─────────────────────────────────

/**
 * Parser minimo di durata ISO-8601 per i valori che `fetchFrequency` ammette
 * nel registry (`P1D`, `P7D`, `PT6H`, `P1M`…). Mesi/anni sono approssimati
 * (30/365 giorni): serve una soglia di staleness, non un calendario.
 * @param {unknown} value
 * @returns {number|null} millisecondi, o null se non parsabile
 */
export function parseIsoDurationMs(value) {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, w, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const total =
    y * 365 * 86400e3 + mo * 30 * 86400e3 + w * 7 * 86400e3 + d * 86400e3 + h * 3600e3 + mi * 60e3 + s * 1000;
  return total > 0 ? total : null;
}

/**
 * Copertura nazionale: stato per cantone registrato + confronto col totale dei
 * cantoni svizzeri noti.
 * @param {{sources?: Record<string, any>}} registry
 * @param {Record<string, any>} datasets   anagrafica per chiave-cantone
 * @param {Record<string, any>} duties     turni per chiave-cantone
 * @param {number} knownCantonCount
 */
export function evaluateCoverage(registry, datasets, duties, knownCantonCount) {
  const sources = registry && typeof registry.sources === 'object' && registry.sources ? registry.sources : {};
  const byStatus = {};
  const entries = [];
  for (const [key, entry] of Object.entries(sources)) {
    const status = typeof entry?.status === 'string' ? entry.status : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const anagrafica = datasets?.[key] ?? null;
    const pharmacies = Array.isArray(anagrafica?.pharmacies) ? anagrafica.pharmacies : [];
    const dutyDoc = duties?.[key] ?? null;
    const dutyList = Array.isArray(dutyDoc?.duties) ? dutyDoc.duties : [];
    entries.push({
      key,
      canton: entry?.canton ?? key,
      status,
      sourceType: entry?.sourceType ?? null,
      hasAnagrafica: Boolean(anagrafica),
      pharmacyCount: pharmacies.length,
      cityCount: new Set(pharmacies.map((p) => p?.city).filter(Boolean)).size,
      // `_sourceRegions` è `OFCT_REGIONS.map(r => r.url)` in
      // `scripts/import-pharmacies-ticino.mjs`: le regioni CONFIGURATE, non quelle
      // che hanno risposto. Il nome dice quello che il dato è; le regioni fallite si
      // leggono da `_errors[]`, che è la dimensione "errori fetch" qui sotto.
      regionsConfigured: Array.isArray(anagrafica?._sourceRegions) ? anagrafica._sourceRegions.length : 0,
      hasDuties: Boolean(dutyDoc),
      dutyCount: dutyList.length,
    });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return {
    knownCantonCount,
    cantonsInRegistry: entries.length,
    cantonsWithAnagrafica: entries.filter((e) => e.hasAnagrafica).length,
    cantonsWithDuties: entries.filter((e) => e.hasDuties).length,
    byStatus,
    entries,
  };
}

/**
 * Freschezza di ogni dataset presente, contro il proprio SLA.
 * @returns {{entries: Array<{key:string, kind:string, fetchedAt:string|null, ageHours:number|null, maxAgeHours:number|null, stale:boolean, reason:string|null}>}}
 */
export function evaluateFreshness(registry, datasets, duties, nowMs, anagraficaMaxAgeHours = DEFAULT_ANAGRAFICA_MAX_AGE_HOURS) {
  const sources = registry?.sources ?? {};
  const entries = [];

  const push = (key, kind, doc, maxAgeHours) => {
    if (!doc) return;
    const raw = typeof doc._fetchedAt === 'string' ? doc._fetchedAt : null;
    const parsed = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(parsed)) {
      entries.push({ key, kind, fetchedAt: raw, ageHours: null, maxAgeHours, stale: true, reason: '`_fetchedAt` mancante o non parsabile' });
      return;
    }
    const ageHours = (nowMs - parsed) / 3600e3;
    const stale = maxAgeHours !== null && ageHours > maxAgeHours;
    entries.push({
      key,
      kind,
      fetchedAt: raw,
      ageHours: Math.round(ageHours * 10) / 10,
      maxAgeHours,
      stale,
      reason: stale ? `età ${Math.round(ageHours / 24)}g oltre lo SLA di ${Math.round(maxAgeHours / 24)}g` : null,
    });
  };

  for (const key of Object.keys(datasets ?? {})) push(key, 'anagrafica', datasets[key], anagraficaMaxAgeHours);
  for (const key of Object.keys(duties ?? {})) {
    const slaMs = parseIsoDurationMs(sources?.[key]?.fetchFrequency);
    push(key, 'turni', duties[key], slaMs === null ? null : (slaMs * DUTIES_SLA_TOLERANCE) / 3600e3);
  }
  return { entries };
}

/**
 * `_errors[]` che gli importer lasciano nei dataset e che nessuno rilegge.
 */
export function collectFetchErrors(datasets, duties) {
  const out = [];
  const scan = (bag, kind) => {
    for (const [key, doc] of Object.entries(bag ?? {})) {
      const errors = Array.isArray(doc?._errors) ? doc._errors : [];
      if (errors.length) out.push({ key, kind, count: errors.length, errors: errors.slice(0, 10) });
    }
  };
  scan(datasets, 'anagrafica');
  scan(duties, 'turni');
  return out;
}

/**
 * Normalizza un campo testuale prima di usarlo come chiave di identità.
 * `scripts/lib/pharmacy-ticino-parser.mjs` emette `address`/`name` come testo
 * grezzo della cella HTML: senza collassare spazi e diacritici, "Via  Nassa 5"
 * e "Via Nassa 5" (o "Lugano"/"Lugàno") sfuggirebbero al rilevamento — cioè
 * proprio il caso per cui questo controllo esiste.
 */
export function normalizeIdentityField(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Conflitti nell'anagrafica: identità duplicate e stessa farmacia emessa da due
 * regioni diverse (il caso reale quando due pagine di regione si sovrappongono).
 */
export function detectAnagraficaConflicts(key, doc) {
  const pharmacies = Array.isArray(doc?.pharmacies) ? doc.pharmacies : [];
  const conflicts = [];
  const seen = new Map();
  const dup = (field, value, subject) => {
    const bucket = `${field}:${value}`;
    if (seen.has(bucket)) {
      conflicts.push({ key, type: `duplicate-${field}`, detail: `${field} "${value}" su più record (${seen.get(bucket)} / ${subject})` });
    } else {
      seen.set(bucket, subject);
    }
  };
  for (const p of pharmacies) {
    const label = p?.name ?? '?';
    if (p?.id) dup('id', p.id, label);
    if (p?.slug) dup('slug', p.slug, label);
    if (p?.name && p?.postalCode && p?.address) {
      dup(
        'identity',
        `${normalizeIdentityField(p.name)}|${normalizeIdentityField(p.postalCode)}|${normalizeIdentityField(p.address)}`,
        `${label} (${p.sourceUrl ?? '?'})`,
      );
    }
  }
  return conflicts;
}

/**
 * Conflitti sui turni. `docs/pharmacy-data-policy.md` → "Disclaimer e
 * pubblicazione": un turno non va MAI mostrato attivo oltre `endsAt`, e uno
 * stato `conflicting` non va pubblicato come verificato.
 */
export function detectDutyConflicts(key, doc, nowMs) {
  const duties = Array.isArray(doc?.duties) ? doc.duties : [];
  const conflicts = [];
  for (const d of duties) {
    if (d?.status === 'conflicting') {
      conflicts.push({ key, type: 'duty-conflicting', detail: `turno ${d.id ?? '?'} (${d.coverageName ?? '?'}) in stato conflicting` });
    }
    const endsAt = typeof d?.endsAt === 'string' ? Date.parse(d.endsAt) : NaN;
    if (d?.status === 'verified' && Number.isFinite(endsAt) && endsAt < nowMs) {
      conflicts.push({ key, type: 'duty-expired-but-verified', detail: `turno ${d.id ?? '?'} è "verified" ma endsAt ${d.endsAt} è passato` });
    }
  }
  return conflicts;
}

/**
 * Assembla il report completo e la lista dei problemi che fanno uscire non-zero.
 */
export function buildReport({ registry, datasets = {}, duties = {}, knownCantonCount = 0, nowMs = Date.now(), anagraficaMaxAgeHours = DEFAULT_ANAGRAFICA_MAX_AGE_HOURS }) {
  const coverage = evaluateCoverage(registry, datasets, duties, knownCantonCount);
  const freshness = evaluateFreshness(registry, datasets, duties, nowMs, anagraficaMaxAgeHours);
  const fetchErrors = collectFetchErrors(datasets, duties);
  const conflicts = [
    ...Object.entries(datasets).flatMap(([key, doc]) => detectAnagraficaConflicts(key, doc)),
    ...Object.entries(duties).flatMap(([key, doc]) => detectDutyConflicts(key, doc, nowMs)),
  ];

  const problems = [];
  for (const e of coverage.entries) {
    if (e.status === 'blocked' || e.status === 'degraded') {
      problems.push(`fonte ${e.key} in stato "${e.status}" — nessun dato affidabile per quel cantone`);
    }
    // Una fonte `active` che non produce NIENTE è una promessa non mantenuta:
    // l'hub /farmacie/ la mostra come verificata mentre il dato non esiste.
    if (e.status === 'active' && !e.hasAnagrafica && !e.hasDuties) {
      problems.push(`fonte ${e.key} è "active" ma non esiste alcun dataset (né anagrafica né turni)`);
    }
  }
  // Un'anagrafica stale è una violazione REALE dello SLA dichiarato dalla policy,
  // non un falso allarme da sopprimere — ma il percorso di rientro va nominato,
  // altrimenti l'issue resta aperta senza dire cosa la chiude: oggi l'import è
  // one-shot e lo scheduler è #6752, e appena quello gira `_fetchedAt` si
  // aggiorna e il monitor si richiude da solo.
  for (const f of freshness.entries) {
    if (!f.stale) continue;
    const hint = f.kind === 'anagrafica' ? ' — l\'import è ancora one-shot, lo scheduler è #6752' : '';
    problems.push(`dataset ${f.kind} ${f.key} stale: ${f.reason}${hint}`);
  }
  for (const e of fetchErrors) problems.push(`${e.count} errore/i di fetch nel dataset ${e.kind} ${e.key}`);
  for (const c of conflicts) problems.push(`conflitto ${c.type} (${c.key}): ${c.detail}`);

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    coverage,
    freshness,
    fetchErrors,
    conflicts,
    dutiesPipeline: coverage.cantonsWithDuties > 0
      ? { available: true }
      : { available: false, reason: 'pipeline turni non ancora costruita (#6750): assenza attesa, non un guasto' },
    problems,
    healthy: problems.length === 0,
  };
  // La dashboard renderizzata viaggia DENTRO il report: il workflow la estrae
  // con `jq`, invece di ritagliarla dallo stdout con una regex sui separatori
  // `─` (U+2500) — che in locale `C` GNU sed lega all'ultimo byte del carattere
  // multibyte e non chiude mai il range.
  report.dashboard = formatReport(report);
  return report;
}

/** Dashboard leggibile — è anche il corpo che il workflow incolla nell'issue. */
export function formatReport(report) {
  const lines = [];
  const c = report.coverage;
  lines.push(`Copertura: ${c.cantonsInRegistry}/${c.knownCantonCount} cantoni con fonte registrata · ${c.cantonsWithAnagrafica} con anagrafica · ${c.cantonsWithDuties} con turni`);
  lines.push(`Stato fonti: ${Object.entries(c.byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || 'nessuna'}`);
  for (const e of c.entries) {
    lines.push(`  • ${e.key} [${e.status}] — ${e.pharmacyCount} farmacie in ${e.cityCount} città (${e.regionsConfigured} regioni configurate), turni: ${e.hasDuties ? e.dutyCount : 'assenti'}`);
  }
  for (const f of report.freshness.entries) {
    const age = f.ageHours === null ? '?' : `${Math.round(f.ageHours / 24)}g`;
    lines.push(`Freschezza ${f.kind}/${f.key}: ${age} (SLA ${f.maxAgeHours === null ? 'non dichiarato' : `${Math.round(f.maxAgeHours / 24)}g`})${f.stale ? ' ⚠️ STALE' : ''}`);
  }
  lines.push(`Errori di fetch: ${report.fetchErrors.reduce((n, e) => n + e.count, 0)}`);
  lines.push(`Conflitti: ${report.conflicts.length}`);
  if (!report.dutiesPipeline.available) lines.push(`Turni: ${report.dutiesPipeline.reason}`);
  return lines;
}

// ── IO ──────────────────────────────────────────────────────────────

function readJson(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * I dataset per-cantone seguono la convenzione `data/pharmacies-<key>.json` e
 * `data/pharmacy-duties-<key>.json`, con `<key>` la chiave del registry: così
 * un cantone nuovo entra nella dashboard senza toccare questo file.
 */
export function loadDatasets(registry) {
  const datasets = {};
  const duties = {};
  for (const key of Object.keys(registry?.sources ?? {})) {
    const a = readJson(`data/pharmacies-${key}.json`);
    if (a) datasets[key] = a;
    const d = readJson(`data/pharmacy-duties-${key}.json`);
    if (d) duties[key] = d;
  }
  return { datasets, duties };
}

/**
 * Denominatore della copertura: i 26 cantoni svizzeri, letti dalla stessa
 * sorgente di verità del router (`data/canton-url-slugs.json`, cfr.
 * `services/cantonList.ts`). Quel file COLLASSA le semi-cantoni in gruppi
 * (AI/AR → APPENZELLO, BL/BS → BASILEA) per l'emissione degli URL: contare le
 * chiavi darebbe 24. Riespandiamo i membri, perché la copertura si misura sui
 * cantoni reali — ognuno ha un proprio ordine dei farmacisti e una propria fonte.
 * @param {{cantons?: Record<string, unknown>, cantonGroups?: Record<string, {members?: readonly string[]}>}|null} slugs
 */
export function countSwissCantons(slugs) {
  const cantons = Object.keys(slugs?.cantons ?? {});
  const groups = slugs?.cantonGroups ?? {};
  return cantons.reduce((n, code) => n + (Array.isArray(groups[code]?.members) ? groups[code].members.length : 1), 0);
}

function main() {
  const registry = readJson('data/pharmacy-sources-registry.json');
  if (!registry) {
    console.error('[pharmacy-data-health] data/pharmacy-sources-registry.json mancante o illeggibile');
    process.exit(1);
  }
  const knownCantonCount = countSwissCantons(readJson('data/canton-url-slugs.json'));
  const { datasets, duties } = loadDatasets(registry);

  const maxAgeEnv = Number(process.env.PHARMACY_ANAGRAFICA_MAX_AGE_HOURS);
  const report = buildReport({
    registry,
    datasets,
    duties,
    knownCantonCount,
    nowMs: Date.now(),
    anagraficaMaxAgeHours: Number.isFinite(maxAgeEnv) && maxAgeEnv > 0 ? maxAgeEnv : DEFAULT_ANAGRAFICA_MAX_AGE_HOURS,
  });

  fs.writeFileSync(path.join(ROOT, 'data/pharmacy-data-health-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log('── Dashboard dati farmacie ──');
  for (const l of formatReport(report)) console.log(l);
  console.log('─────────────────────────────');
  if (report.healthy) {
    console.log('✅ SANO — nessun problema di copertura, freschezza, fetch o conflitti.');
    process.exit(0);
  }
  console.log(`❌ DEGRADATO — ${report.problems.length} problema/i:`);
  for (const p of report.problems) console.log(`  • ${p}`);
  process.exit(1);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) main();
