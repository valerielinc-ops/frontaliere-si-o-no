#!/usr/bin/env node
/**
 * publish-pharmacy-duty-cantons.mjs — i turni farmacia gia' importati dal sito,
 * per gruppo cantonale, in un artefatto pubblico piccolo:
 * `public/data/pharmacy-duty-cantons.json` (P9f del programma «sezioni
 * articoli per cantone»).
 *
 * PERCHE'
 *
 * I turni vivono in `data/pharmacy-duties-{ticino,geneva,swiss-cantons}.json`
 * (sync-pharmacies-border.yml), che non arrivano sul CDN: il corpus non puo'
 * leggerli (il confine fra i repo e' HTTP). L'aggregatore dei servizi del
 * corpus (`generator/scripts/refresh-canton-services-data.mjs`) ha bisogno di
 * sapere per quale cantone esistono turni ufficiali e quali sono i prossimi.
 * Questo script NON rifa' l'importazione e non decide niente di nuovo: copia
 * i turni gia' validati dagli importatori, con le stesse regole di rilascio.
 *
 * Regole (fail-closed come il sito):
 *  - si pubblica un cantone solo se il suo rilascio e' `fresh` (TI:
 *    `_release.state`; GE e snapshot svizzeri: `_state === 'fresh'` e
 *    `_releaseReady !== false`); altrimenti il cantone c'e', con lo stato, e
 *    senza turni;
 *  - solo turni `verified` che si sovrappongono alla finestra
 *    [importazione, importazione + 7 giorni] (vedi `importClock`); il
 *    consumatore confronta `endsAt` con l'ora di lettura (un turno `verified`
 *    alle 02:00 puo' essere finito alle 20:00);
 *  - un turno senza farmacia risolta nel catalogo resta fuori (contato in
 *    `unresolvedDuties`): niente nomi stimati.
 *
 * Uso:
 *   node scripts/publish-pharmacy-duty-cantons.mjs           # scrive
 *   node scripts/publish-pharmacy-duty-cantons.mjs --check   # valida, non scrive
 *   node scripts/publish-pharmacy-duty-cantons.mjs --now=2026-10-05T08:00:00Z
 *
 * Env (test): PHARMACY_DUTY_CANTONS_DATA_DIR (cartella dei JSON sorgente),
 * PHARMACY_DUTY_CANTONS_OUT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.PHARMACY_DUTY_CANTONS_DATA_DIR || path.join(ROOT, 'data');
const OUT_PATH = process.env.PHARMACY_DUTY_CANTONS_OUT || path.join(ROOT, 'public', 'data', 'pharmacy-duty-cantons.json');

export const SCHEMA_VERSION = 1;
export const WINDOW_DAYS = 7;
/** Codice cantone del sito → gruppo URL delle sezioni cantonali (BS/BL → BASILEA, AI/AR → APPENZELLO). */
export const CANTON_GROUP = { TI: 'TI', GE: 'GE', JU: 'JU', ZH: 'ZH', SO: 'SO', BS: 'BASILEA', BL: 'BASILEA', AI: 'APPENZELLO', AR: 'APPENZELLO' };

const readJson = (name) => {
  const p = path.join(DATA_DIR, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

function shapeDuties(duties, nameOf, { now, windowEnd }) {
  const out = [];
  let unresolved = 0;
  for (const d of duties ?? []) {
    if (d?.status !== 'verified') continue;
    const start = Date.parse(d.startsAt);
    const end = Date.parse(d.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= now || start >= windowEnd) continue;
    const ph = nameOf(d);
    if (!ph?.name) {
      unresolved++;
      continue;
    }
    out.push({
      pharmacy: ph.name,
      city: ph.city ?? null,
      coverageName: d.coverageName ?? null,
      dutyType: d.dutyType ?? null,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      sourceUrl: d.sourceUrl ?? null,
    });
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.pharmacy.localeCompare(b.pharmacy));
  return { duties: out, unresolved };
}

/**
 * @param {{ ticino?: object, ticinoCatalogue?: object, geneva?: object, genevaCatalogue?: object, swiss?: object }} inputs
 */
export function buildPharmacyDutyCantons(inputs, { now = Date.now() } = {}) {
  const windowEnd = now + WINDOW_DAYS * 86_400_000;
  const cantons = {};
  const put = (code, entry) => {
    const group = CANTON_GROUP[code];
    if (!group) return;
    if (cantons[group]) {
      // BS e BL (o AI e AR) nello stesso gruppo: si sommano i turni.
      cantons[group].duties.push(...entry.duties);
      cantons[group].unresolvedDuties += entry.unresolvedDuties;
      cantons[group].members.push(code);
      return;
    }
    cantons[group] = { members: [code], ...entry };
  };

  if (inputs.ticino) {
    const t = inputs.ticino;
    const state = t._release?.state ?? 'unknown';
    const byId = new Map((inputs.ticinoCatalogue?.pharmacies ?? []).map((p) => [p.id, p]));
    const shaped = state === 'fresh' ? shapeDuties(t.duties, (d) => byId.get(d.pharmacyId), { now, windowEnd }) : { duties: [], unresolved: 0 };
    put('TI', {
      state,
      fetchedAt: t._fetchedAt ?? null,
      sourceUrl: t._source ?? null,
      sourceType: 'official',
      duties: shaped.duties,
      unresolvedDuties: shaped.unresolved,
    });
  }
  if (inputs.geneva) {
    const g = inputs.geneva;
    const publishable = g._state === 'fresh' && g._releaseReady !== false;
    const byId = new Map((inputs.genevaCatalogue?.pharmacies ?? []).map((p) => [p.id, p]));
    const shaped = publishable ? shapeDuties(g.duties, (d) => byId.get(d.pharmacyId), { now, windowEnd }) : { duties: [], unresolved: 0 };
    put('GE', {
      state: g._state ?? 'unknown',
      fetchedAt: g._fetchedAt ?? null,
      sourceUrl: g._source ?? null,
      sourceType: 'association',
      duties: shaped.duties,
      unresolvedDuties: shaped.unresolved,
    });
  }
  for (const [code, snap] of Object.entries(inputs.swiss?.snapshots ?? {})) {
    const publishable = snap._state === 'fresh' && snap._releaseReady !== false;
    const byId = new Map((snap.pharmacies ?? []).map((p) => [p.id, p]));
    const shaped = publishable
      ? shapeDuties(snap.duties, (d) => (d.pharmacyName ? { name: d.pharmacyName, city: byId.get(d.pharmacyId)?.city } : byId.get(d.pharmacyId)), { now, windowEnd })
      : { duties: [], unresolved: 0 };
    put(code, {
      state: snap._state ?? 'unknown',
      fetchedAt: snap._fetchedAt ?? null,
      sourceUrl: snap._source ?? null,
      sourceType: snap.duties?.[0]?.sourceType ?? null,
      duties: shaped.duties,
      unresolvedDuties: shaped.unresolved,
    });
  }
  for (const c of Object.values(cantons)) c.duties.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    windowDays: WINDOW_DAYS,
    dutyHubPath: '/farmacie-di-turno/',
    cantons,
  };
}

/** @returns {string[]} violazioni */
export function validatePharmacyDutyCantons(doc) {
  const errors = [];
  if (doc?.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion');
  const entries = Object.entries(doc?.cantons ?? {});
  if (!entries.length) errors.push('nessun cantone');
  const withDuties = entries.filter(([, c]) => c.duties.length > 0).length;
  if (withDuties === 0) errors.push('nessun cantone con turni nella finestra: rilasci tutti non pubblicabili?');
  for (const [g, c] of entries) {
    if (!Array.isArray(c.members) || !c.members.length) errors.push(`${g}: members`);
    for (const d of c.duties) {
      if (!d.pharmacy || !/^\d{4}-\d\d-\d\dT/.test(d.startsAt) || !/^\d{4}-\d\d-\d\dT/.test(d.endsAt) || d.endsAt <= d.startsAt) {
        errors.push(`${g}: turno non valido ${JSON.stringify(d).slice(0, 120)}`);
        break;
      }
    }
  }
  return errors;
}

/**
 * L'«adesso» del riassunto e' l'ultima importazione, non l'orologio: il
 * workflow delle farmacie gira ogni 15 minuti e apre una PR solo se i dati
 * cambiano. Con l'orologio il file cambierebbe a ogni giro (generatedAt, e la
 * finestra che scorre) e produrrebbe una PR ogni quarto d'ora a dati fermi.
 */
export function importClock(inputs) {
  const stamps = [inputs.ticino?._fetchedAt, inputs.geneva?._fetchedAt, ...Object.values(inputs.swiss?.snapshots ?? {}).map((s) => s._fetchedAt)]
    .map((s) => Date.parse(s ?? ''))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

function main() {
  const inputs = {
    ticino: readJson('pharmacy-duties-ticino.json'),
    ticinoCatalogue: readJson('pharmacies-ticino.json'),
    geneva: readJson('pharmacy-duties-geneva.json'),
    genevaCatalogue: readJson('pharmacy-duties-geneva-catalogue.json'),
    swiss: readJson('pharmacy-duties-swiss-cantons.json'),
  };
  const nowArg = process.argv.find((a) => a.startsWith('--now='))?.slice(6);
  const now = nowArg ? Date.parse(nowArg) : importClock(inputs);
  if (!Number.isFinite(now)) throw new Error(nowArg ? `--now non valido: ${nowArg}` : 'nessuna data di importazione nei file dei turni');
  const doc = buildPharmacyDutyCantons(inputs, { now });
  const errors = validatePharmacyDutyCantons(doc);
  const line = Object.entries(doc.cantons).map(([g, c]) => `${g}:${c.state}/${c.duties.length}`).join(' ');
  console.log(`[publish-pharmacy-duty-cantons] ${line}`);
  if (errors.length) {
    for (const e of errors) console.error(`::error::[publish-pharmacy-duty-cantons] ${e}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) return;
  writeJsonAtomic(OUT_PATH, doc);
  console.log(`[publish-pharmacy-duty-cantons] scritto ${path.relative(ROOT, OUT_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
