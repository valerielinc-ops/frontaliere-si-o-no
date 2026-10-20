#!/usr/bin/env node
/**
 * release-translation-holds.mjs — rilascia i job di agenzia trattenuti fuori
 * dalla pubblicazione (soglia di ammissione, decisione del proprietario
 * 2026-10-03) i cui titoli translate-pending ha appena tradotto.
 *
 * Il rilascio toglie `translationHoldSince` e fissa `translationHoldReleasedAt`
 * nello slice: l'ammissione diventa definitiva nello stesso commit che porta la
 * traduzione (un URL appena pubblicato non può più tornare indietro) e gli
 * alert trattano il job come nuovo da adesso. Senza questo passo il job verrebbe
 * comunque pubblicato al deploy successivo — l'assemblatore valuta il titolo
 * al momento della lettura — e reso definitivo dalla prossima scrittura del
 * suo crawler; qui si chiude quella finestra.
 *
 * Stampa anche il conteggio dei job ancora in attesa: è la misura della
 * capacità di traduzione contro l'afflusso delle agenzie.
 *
 * Usage: node scripts/release-translation-holds.mjs [--dry-run]
 * Env:   RELEASE_TRANSLATION_HOLDS_DIR — directory degli slice (default
 *        data/jobs/by-crawler; i test la puntano a una copia temporanea).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  TRANSLATION_HOLD_CRAWLER_KEYS,
  formatTranslationHoldSummary,
  releaseTranslatedHolds,
  summarizeTranslationHold,
} from './lib/translation-publication-hold.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');

/**
 * @param {{ dir?: string, dryRun?: boolean, now?: string, log?: (line: string) => void }} [opts]
 * @returns {{ released: number, slicesChanged: number, summary: ReturnType<typeof summarizeTranslationHold> }}
 */
export function releaseTranslationHolds({
  dir = process.env.RELEASE_TRANSLATION_HOLDS_DIR || DEFAULT_DIR,
  dryRun = false,
  now = new Date().toISOString(),
  log = (line) => console.log(line),
} = {}) {
  let released = 0;
  let slicesChanged = 0;
  const stillHeld = [];
  for (const key of TRANSLATION_HOLD_CRAWLER_KEYS) {
    const slicePath = path.join(dir, `${key}.json`);
    if (!fs.existsSync(slicePath)) continue;
    let slice;
    try {
      slice = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    } catch (error) {
      log(`⚠️  ${key}: slice illeggibile, salto (${error.message})`);
      continue;
    }
    const jobs = Array.isArray(slice?.jobs) ? slice.jobs : [];
    const count = releaseTranslatedHolds(jobs, { now });
    stillHeld.push(...jobs);
    if (count === 0) continue;
    released += count;
    slicesChanged++;
    log(`  ▶️  ${key}: ${count} job rilasciati (titoli tradotti)`);
    // Same envelope, same assembledAt: this is not a new crawl.
    if (!dryRun) writeJson(slicePath, slice);
  }
  const summary = summarizeTranslationHold(stillHeld);
  log(`✅ Soglia di ammissione: ${released} job rilasciati in ${slicesChanged} slice${dryRun ? ' (dry run, nessuna scrittura)' : ''}`);
  log(formatTranslationHoldSummary(summary));
  return { released, slicesChanged, summary };
}

if (isInvokedDirectly(import.meta.url)) {
  const result = releaseTranslationHolds({ dryRun: process.argv.includes('--dry-run') });
  // Same two numbers in the run summary, so the capacity series is readable
  // without opening the log: released this run vs still waiting.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `agency-admission: released ${result.released}, still held ${result.summary.held}`
          + `${result.summary.oldestHeldDays === null ? '' : ` (oldest ${result.summary.oldestHeldDays}d)`}\n`,
      );
    } catch { /* the summary is observability only */ }
  }
}
