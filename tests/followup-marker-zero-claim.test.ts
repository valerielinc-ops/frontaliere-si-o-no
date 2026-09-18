/**
 * followup-marker-zero-claim.test.ts — un claim di persistenza a ZERO non deve
 * dipendere dalle parole con cui è scritto.
 *
 * Il 2026-09-18 la prima run di `post-merge-followup.yml` con il gate riparato
 * (run 35391820039: `collection_ok=true`, `batch_count=4`, `verified_prs=4`) è
 * comunque finita rossa con `persistence_ok=false` su tre PR su quattro. I
 * marker erano CORRETTI: il triage aveva trovato candidati, li aveva tutti
 * scartati (`Dropped`/`Skipped`) e aveva scritto
 * «Created/updated: 0 item; nessun bucket creato.» — un esito legittimo che il
 * contratto non aveva mai nominato, e che la lista di formule ammesse nel gate
 * non conteneva. Il prompt prescrive `zero outstanding items` solo per il caso
 * «zero candidate», non per «candidati tutti scartati».
 *
 * Era la TERZA volta che quella lista veniva superata dalla variante
 * successiva, quindi qui il discriminante diventa strutturale: sulla riga di
 * claim conta il numero, non la prosa. Il verso fail-closed resta: un claim
 * non-zero senza bucket nominato deve continuare a far fallire il gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
} from '../scripts/ci/collect-followup-batch.mjs';

// Il marker reale che ha reso rossa la run 35391820039 (PR #8928).
const REAL_MARKER = `## Post-merge follow-up triage

Created/updated: 0 item; nessun bucket creato.

Dropped: 1 item
- "Domain-specific independent exports remain unmeasurable" — reason: non-funnel.

Skipped: 1 item
- "Direct writes to main remain disabled" — stato letterale \`per scelta\`.`;

describe('claim di persistenza a zero', () => {
  it('accetta il marker reale che aveva reso rossa la run 35391820039', () => {
    const expectation = triageMarkerPersistenceExpectation(REAL_MARKER);
    expect(expectation.requiresBucket).toBe(false);
    expect(expectation.buckets).toEqual([]);
    // Nessuna lettura di issue necessaria: non c'è nulla da provare.
    expect(verifyTriageMarkerPersistence(REAL_MARKER, 8928, undefined)).toBe(true);
  });

  it('accetta le varianti storiche senza elencarle', () => {
    for (const line of [
      'Created/updated: 0 item; nessun bucket creato.',
      'Created/updated: 0 issue — nessun item nuovo aggiunto',
      'Created: 0 issue (solo live-verification batchata)',
      'Created/updated: 0 elementi, niente da persistere',
      '- Created: 0',
    ]) {
      const body = `## Post-merge follow-up triage\n\n${line}\n`;
      expect(triageMarkerPersistenceExpectation(body).requiresBucket, line).toBe(false);
    }
  });

  it('resta fail-closed: un claim NON zero senza bucket fallisce', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 3 item; bucket non nominato.\n';
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation.requiresBucket).toBe(true);
    expect(expectation.buckets).toEqual([]);
    expect(verifyTriageMarkerPersistence(body, 8928, () => null)).toBe(false);
  });

  it('un claim non-zero che nomina un bucket va ancora verificato sul bucket', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 2 item nel bucket #9102.\n';
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation.requiresBucket).toBe(true);
    expect(expectation.buckets).toEqual([9102]);
  });

  it('un "10" non viene letto come zero', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 10 item; bucket non nominato.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('con piu righe di claim, basta una non-zero per pretendere il bucket', () => {
    const body = '## Post-merge follow-up triage\n\nCreated: 0 issue\nCreated/updated: 2 item\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });
});

describe('il gemello bash dello YAML resta allineato', () => {
  // Regola #6 di AGENTS.md: un valore condiviso ha UNA sorgente, e quando i due
  // lati non possono importarsi il legame va coperto da un test. Qui il gate
  // vive due volte — JS nel collector, bash nel verifier — e la copia bash è
  // quella che decide il merge.
  const yml = readFileSync(
    resolve(__dirname, '../.github/workflows/post-merge-followup.yml'),
    'utf8',
  );

  it('lo YAML non elenca piu le formule superate', () => {
    expect(yml).not.toMatch(/nessun item nuovo aggiunto/);
    expect(yml).not.toMatch(/solo live-verification batchata/);
  });

  it('lo YAML legge il conteggio sulla riga di claim', () => {
    expect(yml).toMatch(/zero_claim=true/);
    expect(yml).toMatch(/Created\(\/updated\)\?:\[\[:space:\]\]\*0/);
    // E tiene ancora le due forme d'intestazione, che non hanno un conteggio.
    expect(yml).toMatch(/zero outstanding items\|backfill skipped/);
  });
});
