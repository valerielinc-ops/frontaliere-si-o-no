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
 *   5. PERIMETRO    — le quattro giurisdizioni CH-TI/IT-CO/IT-VA/IT-VB, con
 *                    record, freschezza, record fuori area, collisioni e
 *                    provenance dei campi secondari.
 *
 * NON pubblica nulla e non tocca pagine: è un osservatore interno. I dataset
 * dei turni arrivano da `data/pharmacy-duties-<canton>.json`; un dataset
 * mancante per una fonte `active` o oltre lo SLA è un problema osservabile.
 *
 * Exit code: 0 se sano, 1 se degradato. Il report machine-readable finisce in
 * `data/pharmacy-data-health-report.json` per il workflow che apre l'issue.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBorderSnapshot, validateBorderSources } from './check-pharmacy-border-data.mjs';

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

/**
 * The border directory has four policy jurisdictions but its source registry
 * is intentionally separate from the older canton-wide registry above. Keep
 * that boundary explicit here so a healthy Ticino duty feed cannot hide a
 * stale or truncated Italian snapshot.
 */
export const BORDER_SLA_TOLERANCE = 2;
const BORDER_JURISDICTIONS = Object.freeze([
  { key: 'CH-TI', sourceKey: 'ticino-complete', country: 'CH', canton: 'Ticino' },
  { key: 'IT-CO', sourceKey: 'italy-border', country: 'IT', province: 'CO' },
  { key: 'IT-VA', sourceKey: 'italy-border', country: 'IT', province: 'VA' },
  { key: 'IT-VB', sourceKey: 'italy-border', country: 'IT', province: 'VB' },
]);
const SECONDARY_FIELDS = Object.freeze([
  ['phone', (pharmacy) => typeof pharmacy?.phone === 'string' && pharmacy.phone.trim() !== ''],
  ['website', (pharmacy) => typeof pharmacy?.website === 'string' && pharmacy.website.trim() !== ''],
  ['coordinates', (pharmacy) => Number.isFinite(pharmacy?.latitude) || Number.isFinite(pharmacy?.longitude)],
  ['openingHours', (pharmacy) => Array.isArray(pharmacy?.openingHours) && pharmacy.openingHours.length > 0],
  ['services', (pharmacy) => Array.isArray(pharmacy?.services) && pharmacy.services.length > 0],
]);
const BORDER_ITALY_PROVINCES = new Set(['CO', 'VA', 'VB']);
const OFFICIAL_RECORD_FIELD_ALLOWLIST = Object.freeze({
  // OFCT/Ticino snapshots historically carry official phone numbers and a
  // subset of coordinates without fieldSources; every other optional value
  // must retain field-level provenance.
  'ticino-complete': new Set(['phone', 'coordinates']),
  // The Ministry catalogue publishes the coordinates in the primary record;
  // unlike phone/website/opening-hours enrichments, they do not need an
  // additional fieldSources entry when the record-level official source and
  // verified availability agree.
  'italy-border': new Set(['coordinates']),
});
const OFFICIAL_RECORD_SOURCE_HOSTS = Object.freeze({
  'ticino-complete': new Set(['www.ofct.ch', 'www4.ti.ch']),
  'italy-border': new Set(['www.dati.salute.gov.it']),
});

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

function pharmacyRecords(doc) {
  return Array.isArray(doc?.pharmacies) ? doc.pharmacies : [];
}

function normalizedBorderDoc(doc) {
  return {
    ...(doc && typeof doc === 'object' ? doc : {}),
    pharmacies: pharmacyRecords(doc),
  };
}

function borderSourceRegistry(registry) {
  return registry && typeof registry.sources === 'object' && registry.sources ? registry.sources : {};
}

function borderAge(doc, source, nowMs) {
  const fetchedAt = typeof doc?._fetchedAt === 'string' ? doc._fetchedAt : null;
  const parsed = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const frequencyMs = parseIsoDurationMs(source?.fetchFrequency);
  const maxAgeHours = frequencyMs === null ? null : (frequencyMs * BORDER_SLA_TOLERANCE) / 3600e3;
  if (!Number.isFinite(parsed)) {
    return { fetchedAt, ageHours: null, maxAgeHours, stale: true, reason: '`_fetchedAt` mancante o non parsabile' };
  }
  if (frequencyMs === null) {
    return { fetchedAt, ageHours: (nowMs - parsed) / 3600e3, maxAgeHours, stale: true, reason: '`fetchFrequency` mancante o non parsabile' };
  }
  const ageHours = (nowMs - parsed) / 3600e3;
  if (ageHours < 0) {
    return { fetchedAt, ageHours: Math.round(ageHours * 10) / 10, maxAgeHours, stale: true, reason: '`_fetchedAt` nel futuro rispetto al controllo' };
  }
  const stale = ageHours > maxAgeHours;
  return {
    fetchedAt,
    ageHours: Math.round(ageHours * 10) / 10,
    maxAgeHours,
    stale,
    reason: stale ? `età ${Math.round(ageHours / 24)}g oltre lo SLA di ${Math.round(maxAgeHours / 24)}g` : null,
  };
}

function officialRecordFieldAllowed(sourceKey, field, pharmacy) {
  if (!OFFICIAL_RECORD_FIELD_ALLOWLIST[sourceKey]?.has(field)) return false;
  if (pharmacy?.sourceType !== 'official' || pharmacy?.dataAvailability?.[field] !== 'verified') return false;
  try {
    const hostname = new URL(pharmacy.sourceUrl).hostname.toLowerCase();
    return OFFICIAL_RECORD_SOURCE_HOSTS[sourceKey]?.has(hostname) === true;
  } catch {
    return false;
  }
}

/** Cross-dataset identity collisions: a record must not appear twice under a different jurisdiction. */
export function detectBorderIdentityCollisions(records) {
  const seen = new Map();
  const collisions = [];
  const add = (field, value, subject) => {
    const normalized = normalizeIdentityField(value);
    if (!normalized) return;
    const bucket = `${field}:${normalized}`;
    const previous = seen.get(bucket);
    if (previous) {
      collisions.push({ field, value: normalized, previous, subject });
    } else {
      seen.set(bucket, subject);
    }
  };
  for (const { jurisdiction, pharmacy } of records) {
    const label = `${jurisdiction}:${pharmacy?.id || pharmacy?.name || '?'}`;
    add('id', pharmacy?.id, label);
    add('slug', pharmacy?.slug, label);
    const identity = [pharmacy?.name, pharmacy?.postalCode, pharmacy?.address].map(normalizeIdentityField);
    if (identity.every(Boolean)) add('identity', identity.join('|'), label);
  }
  return collisions;
}

/** Secondary values are facts only when their field-level source is complete. */
export function detectMissingSecondaryProvenance(records) {
  const missing = [];
  for (const { jurisdiction, sourceKey, pharmacy } of records) {
    for (const [field, present] of SECONDARY_FIELDS) {
      if (!present(pharmacy)) continue;
      const source = pharmacy?.fieldSources?.[field];
      if (pharmacy?.dataAvailability?.[field] !== 'verified') {
        missing.push({ jurisdiction, pharmacyId: pharmacy?.id || null, field });
        continue;
      }
      // Only this explicit, source-host-bound allowlist can use record-level
      // provenance. Enriched values and official fields outside the allowlist
      // must have a complete fieldSources entry.
      if (!source && officialRecordFieldAllowed(sourceKey, field, pharmacy)) continue;
      const validUrl = typeof source?.url === 'string' && source.url.trim() !== '';
      const validCheckedAt = Number.isFinite(Date.parse(source?.checkedAt));
      const validType = typeof source?.sourceType === 'string' && source.sourceType.trim() !== '';
      const validLicense = source?.sourceType !== 'directory' || /ODbL/i.test(source?.license || '');
      if (!validUrl || !validCheckedAt || !validType || !validLicense) {
        missing.push({ jurisdiction, pharmacyId: pharmacy?.id || null, field });
      }
    }
  }
  return missing;
}

/** Records that violate the policy perimeter, kept as data not just a count. */
export function findBorderOutOfScopeRecords(records) {
  return records
    .filter(({ pharmacy }) => {
      if (pharmacy?.country === 'CH') return pharmacy.canton !== 'Ticino';
      if (pharmacy?.country === 'IT') return !BORDER_ITALY_PROVINCES.has(pharmacy.province);
      return true;
    })
    .map(({ jurisdiction, pharmacy }) => ({ jurisdiction, pharmacyId: pharmacy?.id || null, name: pharmacy?.name || null, country: pharmacy?.country || null, province: pharmacy?.province || null }));
}

/** A record can be in scope globally but still be in the wrong source snapshot. */
export function findBorderSourceMismatches(records) {
  return records
    .filter(({ sourceKey, pharmacy }) => {
      if (sourceKey === 'ticino-complete') return pharmacy?.country !== 'CH' || pharmacy?.canton !== 'Ticino';
      if (sourceKey === 'italy-border') return pharmacy?.country !== 'IT' || !BORDER_ITALY_PROVINCES.has(pharmacy?.province);
      return true;
    })
    .map(({ jurisdiction, sourceKey, pharmacy }) => ({ jurisdiction, sourceKey, pharmacyId: pharmacy?.id || null, name: pharmacy?.name || null, country: pharmacy?.country || null, canton: pharmacy?.canton || null, province: pharmacy?.province || null }));
}

/**
 * Health view for the four jurisdictions in docs/pharmacy-data-policy.md.
 * `sources`, `ticino`, `italy` and `duties` may be null: malformed/missing
 * snapshots must become a degraded report, not make the observer disappear.
 */
export function evaluateBorderHealth({ sources, ticino, italy, duties = null, nowMs = Date.now() }) {
  const sourceMap = borderSourceRegistry(sources);
  const docs = { 'ticino-complete': normalizedBorderDoc(ticino), 'italy-border': normalizedBorderDoc(italy) };
  const records = [
    ...pharmacyRecords(ticino).map((pharmacy) => ({ jurisdiction: 'CH-TI', sourceKey: 'ticino-complete', pharmacy })),
    ...pharmacyRecords(italy).map((pharmacy) => ({ jurisdiction: 'IT', sourceKey: 'italy-border', pharmacy })),
  ];
  const jurisdictions = BORDER_JURISDICTIONS.map((definition) => {
    const doc = docs[definition.sourceKey];
    const source = sourceMap[definition.sourceKey];
    const jurisdictionRecords = pharmacyRecords(doc).filter((pharmacy) => (
      definition.country === 'CH'
        ? pharmacy?.country === 'CH' && pharmacy?.canton === definition.canton
        : pharmacy?.country === 'IT' && pharmacy?.province === definition.province
    ));
    const age = borderAge(doc, source, nowMs);
    return {
      key: definition.key,
      sourceKey: definition.sourceKey,
      sourceStatus: source?.status || 'missing',
      recordCount: jurisdictionRecords.length,
      fetchedAt: age.fetchedAt,
      ageHours: age.ageHours,
      maxAgeHours: age.maxAgeHours,
      stale: age.stale,
      reason: age.reason,
      fetchErrorCount: Array.isArray(doc?._errors) ? doc._errors.length : 0,
    };
  });
  const validationInputs = {
    ticino: normalizedBorderDoc(ticino),
    italy: normalizedBorderDoc(italy),
    duties: duties && typeof duties === 'object' ? { ...duties, duties: Array.isArray(duties.duties) ? duties.duties : [] } : { duties: [] },
  };
  let validationErrors = [];
  try {
    validationErrors = [
      ...validateBorderSources(sources),
      ...validateBorderSnapshot(validationInputs),
    ];
  } catch (error) {
    validationErrors = [`border validation crashed: ${error?.message || error}`];
  }
  const fetchErrors = ['ticino-complete', 'italy-border'].flatMap((key) => (Array.isArray(docs[key]?._errors) && docs[key]._errors.length
      ? [{ key, count: docs[key]._errors.length, errors: docs[key]._errors.slice(0, 10) }]
      : []));
  return {
    jurisdictions,
    totalRecords: jurisdictions.reduce((sum, jurisdiction) => sum + jurisdiction.recordCount, 0),
    fetchErrors,
    outOfScopeRecords: findBorderOutOfScopeRecords(records),
    sourceMismatches: findBorderSourceMismatches(records),
    identityCollisions: detectBorderIdentityCollisions(records),
    missingSecondaryProvenance: detectMissingSecondaryProvenance(records),
    validationErrors,
  };
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
    // La chiave va valutata sui campi NORMALIZZATI, non su quelli grezzi: un
    // `address` fatto di soli spazi è truthy ma normalizza a stringa vuota, e
    // due farmacie realmente distinte dello stesso CAP collasserebbero su una
    // chiave degenere — un `duplicate-identity` che nessuna correzione al dato
    // può togliere, cioè il monitor rosso senza via d'uscita. Componente vuoto
    // dopo la normalizzazione → nessuna chiave di identità per quel record.
    // Verificato sullo snapshot completo di `data/pharmacies-ticino-complete.json`:
    // zero conflitti, il monitor nasce verde (test di regressione in
    // `tests/pharmacy-data-health.test.ts`).
    const identity = [p?.name, p?.postalCode, p?.address].map(normalizeIdentityField);
    if (identity.every(Boolean)) {
      dup('identity', identity.join('|'), `${label} (${p.sourceUrl ?? '?'})`);
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
export function buildReport({ registry, datasets = {}, duties = {}, knownCantonCount = 0, nowMs = Date.now(), anagraficaMaxAgeHours = DEFAULT_ANAGRAFICA_MAX_AGE_HOURS, border = null }) {
  const coverage = evaluateCoverage(registry, datasets, duties, knownCantonCount);
  const freshness = evaluateFreshness(registry, datasets, duties, nowMs, anagraficaMaxAgeHours);
  const borderHealth = border ? evaluateBorderHealth({ ...border, nowMs }) : null;
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
  // automatico è `sync-pharmacies-border.yml`; appena quello gira `_fetchedAt`
  // si aggiorna e il monitor si richiude da solo.
  for (const f of freshness.entries) {
    if (!f.stale) continue;
    const hint = f.kind === 'anagrafica' ? ' — verificare il workflow sync-pharmacies-border' : '';
    problems.push(`dataset ${f.kind} ${f.key} stale: ${f.reason}${hint}`);
  }
  for (const e of fetchErrors) problems.push(`${e.count} errore/i di fetch nel dataset ${e.kind} ${e.key}`);
  for (const c of conflicts) problems.push(`conflitto ${c.type} (${c.key}): ${c.detail}`);
  if (borderHealth) {
    const staleSources = new Set();
    for (const jurisdiction of borderHealth.jurisdictions) {
      if (jurisdiction.sourceStatus !== 'active') {
        problems.push(`perimetro ${jurisdiction.key}: fonte ${jurisdiction.sourceStatus}`);
      }
      if (jurisdiction.recordCount === 0) {
        problems.push(`perimetro ${jurisdiction.key}: nessun record verificato`);
      }
      if (jurisdiction.stale && !staleSources.has(jurisdiction.sourceKey)) {
        staleSources.add(jurisdiction.sourceKey);
        problems.push(`dataset perimetro ${jurisdiction.key} stale: ${jurisdiction.reason || 'freschezza non verificabile'} — verificare il workflow sync-pharmacies-border`);
      }
    }
    for (const error of borderHealth.fetchErrors) problems.push(`${error.count} errore/i di fetch nel dataset perimetro ${error.key}`);
    if (borderHealth.outOfScopeRecords.length) problems.push(`${borderHealth.outOfScopeRecords.length} record fuori perimetro nelle snapshot farmacie`);
    if (borderHealth.sourceMismatches.length) problems.push(`${borderHealth.sourceMismatches.length} record nella snapshot della fonte errata`);
    if (borderHealth.identityCollisions.length) problems.push(`${borderHealth.identityCollisions.length} collisioni di identità nelle snapshot farmacie`);
    if (borderHealth.missingSecondaryProvenance.length) problems.push(`${borderHealth.missingSecondaryProvenance.length} campi secondari senza provenienza completa`);
    for (const error of borderHealth.validationErrors) problems.push(`validazione perimetro: ${error}`);
  }

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    coverage,
    freshness,
    fetchErrors,
    conflicts,
    dutiesPipeline: coverage.cantonsWithDuties > 0
      ? { available: true }
      : { available: false, reason: 'dataset turni non disponibile per la fonte attiva' },
    ...(borderHealth ? { border: borderHealth } : {}),
    problems,
    healthy: problems.length === 0,
  };
  // La dashboard renderizzata viaggia DENTRO il report: il workflow la estrae
  // con `jq`, invece di ritagliarla dallo stdout con una regex sui separatori
  // `─` (U+2500) — che in locale `C` GNU sed lega all'ultimo byte del carattere
  // multibyte e non chiude mai il range.
  return { ...report, dashboard: formatReport(report) };
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
  if (report.border) {
    lines.push(`Perimetro operativo: ${report.border.jurisdictions.length} giurisdizioni · ${report.border.totalRecords} record`);
    for (const jurisdiction of report.border.jurisdictions) {
      const age = jurisdiction.ageHours === null ? '?' : `${Math.round(jurisdiction.ageHours / 24)}g`;
      lines.push(`  • ${jurisdiction.key} [${jurisdiction.sourceStatus}] — ${jurisdiction.recordCount} record · fetch ${age}${jurisdiction.stale ? ' ⚠️ STALE' : ''}`);
    }
    lines.push(`Errori fetch perimetro: ${report.border.fetchErrors.reduce((n, e) => n + e.count, 0)}`);
    lines.push(`Record fuori perimetro: ${report.border.outOfScopeRecords.length}`);
    lines.push(`Record nella snapshot della fonte errata: ${report.border.sourceMismatches.length}`);
    lines.push(`Collisioni identità perimetro: ${report.border.identityCollisions.length}`);
    lines.push(`Campi secondari senza provenienza: ${report.border.missingSecondaryProvenance.length}`);
  }
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
 * `data/pharmacy-duties-<key>.json`, con `<key>` la chiave del registry. Se
 * una fonte separa l'anagrafica dai turni, `anagraficaPath` nel registry indica
 * il snapshot canonico e la convenzione resta il fallback di compatibilità.
 */
export function loadDatasets(registry) {
  const datasets = {};
  const duties = {};
  for (const [key, entry] of Object.entries(registry?.sources ?? {})) {
    const configuredPath = typeof entry?.anagraficaPath === 'string' ? entry.anagraficaPath : null;
    const a = (configuredPath && readJson(configuredPath)) || readJson(`data/pharmacies-${key}.json`);
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
  const border = {
    sources: readJson('data/pharmacy-border-sources.json'),
    ticino: readJson('data/pharmacies-ticino-complete.json'),
    italy: readJson('data/pharmacies-italy-border.json'),
    duties: readJson('data/pharmacy-duties-ticino.json'),
  };

  const maxAgeEnv = Number(process.env.PHARMACY_ANAGRAFICA_MAX_AGE_HOURS);
  const report = buildReport({
    registry,
    datasets,
    duties,
    knownCantonCount,
    border,
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
