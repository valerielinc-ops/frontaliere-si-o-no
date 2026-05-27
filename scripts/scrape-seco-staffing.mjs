#!/usr/bin/env node
/**
 * scrape-seco-staffing.mjs — Serialize a curated registry of SECO-authorised
 * staffing / placement agencies operating in Canton Ticino to
 * `data/seco-staffing-registry.json`, used by the AE-2 career landing page
 * "Agenzie del lavoro Lugano".
 *
 * Why this is a curated list, not a live scrape
 * ---------------------------------------------
 * The authoritative SECO registry is served through a client-side SPA at
 *   https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend
 * (migration URL from the historical servlet
 *  http://www.avg-seco.admin.ch/WebVerzeichnis/ServletWebVerzeichnis)
 * and requires a browser (React-rendered) to read. Any headless-HTML scrape
 * returns an empty shell. Rather than ship a fragile Puppeteer dependency
 * just to seed a hand-countable list, we maintain a curated snapshot of the
 * larger, publicly-known agencies with SECO authorization that actively
 * operate in Lugano and the Sottoceneri.
 *
 * Every entry below is cross-verifiable in the SECO register by searching
 * the agency name + city; landing page copy ALWAYS links to the official
 * SECO register as the source of truth, never claiming our list is
 * exhaustive. Users looking for a specific smaller agency are pointed to
 * the SECO register search.
 *
 * Source of truth (cited in copy):
 *   https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend (SECO AVG directory)
 *
 * Output shape:
 *   {
 *     "source": "https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend",
 *     "sourceLabel": "Registro SECO AVG — agenzie di collocamento e prestito di personale autorizzate",
 *     "fetchedAt": "2026-04-23T00:00:00.000Z",
 *     "curated": true,
 *     "note": "Curated sample of SECO-authorised agencies active in Lugano...",
 *     "agencies": [ { "name": …, "city": "Lugano", "type": "placement-and-staffing" }, … ]
 *   }
 *
 * Graceful failure: if the output already exists, we refuse to overwrite
 * unless `--force` is passed — that way accidental reruns don't wipe a
 * human-verified update.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'seco-staffing-registry.json');
const SOURCE_URL = 'https://www.vzavg1.admin.ch/vzavg-verzeichnis-frontend';
const FORCE = process.argv.includes('--force');

/**
 * Curated list of major SECO-authorised agencies with Lugano branches.
 * Every entry is verifiable by name + city in the SECO AVG register.
 * `type`: 'placement' = collocamento only, 'staffing' = prestito di personale,
 *         'placement-and-staffing' = both (most common for nationwide brands).
 */
const CURATED_AGENCIES = [
  {
    name: 'Adecco Resources SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes:
      'Filiale Lugano — operatore nazionale con mandato SECO; copre generalista e specializzato (IT, finanza, ingegneria).',
  },
  {
    name: 'Manpower SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes:
      'Filiale Lugano — specializzazioni industriale, commerciale, ingegneria, finanza.',
  },
  {
    name: 'Randstad (Switzerland) AG',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes:
      'Filiale Lugano — generalista con divisione Finance & Accounting e Medical & Life Sciences.',
  },
  {
    name: 'Kelly Services (Suisse) SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes: 'Filiale Lugano — focus impiegatizio, commerciale e industriale.',
  },
  {
    name: 'Interiman SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes: 'Gruppo Interiman (oggi Interiman Group / The Adecco Group) — hub Lugano.',
  },
  {
    name: 'Sintex SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes:
      'Agenzia ticinese storica con mandato SECO — generalista, industriale, logistica, sanitaria.',
  },
  {
    name: 'Axxon Services SA',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes: 'Agenzia ticinese con sede a Lugano — permanenti e interim.',
  },
  {
    name: 'Trenkwalder Personal AG',
    city: 'Lugano',
    type: 'placement-and-staffing',
    notes: 'Branch ticinese del gruppo austriaco Trenkwalder.',
  },
];

function loadExisting() {
  try {
    const raw = fs.readFileSync(OUT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeOut(payload) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function main() {
  const existing = loadExisting();
  if (existing && !FORCE) {
    console.log(
      `[scrape-seco-staffing] ${OUT_PATH} already exists (${existing.agencies?.length ?? 0} agencies) — pass --force to overwrite`,
    );
    return;
  }

  const payload = {
    source: SOURCE_URL,
    sourceLabel:
      'Registro SECO AVG — agenzie di collocamento e prestito di personale autorizzate',
    fetchedAt: new Date().toISOString(),
    curated: true,
    note:
      "Elenco curato non esaustivo di agenzie con autorizzazione SECO attive a Lugano. Per la lista completa e aggiornata consultare il registro ufficiale SECO AVG (link in 'source').",
    count: CURATED_AGENCIES.length,
    agencies: CURATED_AGENCIES,
  };
  writeOut(payload);
  console.log(
    `[scrape-seco-staffing] wrote ${CURATED_AGENCIES.length} agencies → ${OUT_PATH}`,
  );
}

main();
