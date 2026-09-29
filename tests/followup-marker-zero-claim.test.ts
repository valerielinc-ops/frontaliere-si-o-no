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
 *
 * Il numero pero' veniva cercato solo IN TESTA alla riga (`Created: 0`). Dal
 * 2026-09-19 lo zero scritto DOPO il bucket ha reso rosse altre run su marker
 * giusti: «nessun bucket giornaliero; 0 item.» (35458632823, 35465487702,
 * 35473751920) e il template canonico di FOLLOWUP.md con N=0 (35947247334).
 * Ora conta il conteggio ovunque sulla riga. La copia bash dello step di
 * verifica non esiste piu': lo YAML invoca questo stesso predicato
 * (`--verify-persistence`), quindi la parita' e' per costruzione.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isZeroClaimLine,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
} from '../scripts/ci/collect-followup-batch.mjs';

// Righe di claim REALI a zero item con lo zero in cifre DOPO il bucket.
const NUMERIC_ZERO_AFTER_BUCKET_LINES = [
  // run 35458632823 / 35465487702 / 35473751920, PR #9039 #9045 #9053
  '- Created/updated: nessun bucket giornaliero; 0 item.',
  // run 35947247334, PR #9518: il template canonico di FOLLOWUP.md con N=0
  'Created/updated: daily bucket #9609 `follow-up(daily:2026-09-24)` con 0 item da questa PR.',
];

// Righe che promettono (o possono promettere) persistenza: restano claim da
// provare. La prosa senza cifre non e' uno zero (vincolo di #9660).
const NON_ZERO_CLAIM_LINES = [
  'Created/updated: daily bucket #42 `follow-up(daily:2026-09-09)` con 1 item',
  'Created/updated: daily bucket #9609 `follow-up(daily:2026-09-24)` con 10 item:',
  '- Created: daily bucket #42 con 1 item',
  'Created/updated: 2 item nel bucket #9102.',
  'Created/updated: 3 item; bucket non nominato.',
  'Created: 0.5 item',
  'Created/updated: daily bucket #9609 con 2 item; bucket #9610 con 0 item',
  'Created/updated: daily bucket #9609 `follow-up(daily:2026-09-24)`',
  'Created/updated: nessun item per questa PR.',
  'Created/updated: nessun nuovo item nel bucket giornaliero.',
  'Created/updated: nessun item per questa PR; 2 item; bucket giornaliero #9508 non modificato da questa PR.',
];

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

  it('lo zero in cifre DOPO il bucket e un claim a zero (run 35458632823, 35947247334)', () => {
    for (const line of NUMERIC_ZERO_AFTER_BUCKET_LINES) {
      expect(isZeroClaimLine(line), line).toBe(true);
      const body = `## Post-merge follow-up triage\n\n${line}\n\nSkipped: 2 item (stato letterale \`per scelta\`)\n`;
      expect(triageMarkerPersistenceExpectation(body), line).toEqual({ buckets: [], requiresBucket: false });
      expect(verifyTriageMarkerPersistence(body, 9518, () => {
        throw new Error('un claim a zero non deve leggere nessun bucket');
      }), line).toBe(true);
    }
  });

  it('il marker reale di PR #9039: intestazione zero + riga di claim a zero', () => {
    const body = [
      '## Post-merge follow-up triage: zero outstanding items.',
      '',
      '- Daily key: 2026-09-19 (Europe/Zurich)',
      '- Created/updated: nessun bucket giornaliero; 0 item.',
      '- Dropped: 3 item — tutte le domande della review più recente sono marcate “deferred, non funnel-critical”.',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(body)).toEqual({ buckets: [], requiresBucket: false });
  });

  it('un conteggio diverso da zero sulla stessa riga vince sullo zero', () => {
    for (const line of NON_ZERO_CLAIM_LINES) {
      expect(isZeroClaimLine(line), line).toBe(false);
    }
    const body = '## Post-merge follow-up triage\n\n'
      + 'Created/updated: daily bucket #9609 con 2 item; bucket #9610 con 0 item\n';
    expect(triageMarkerPersistenceExpectation(body)).toEqual({ buckets: [9609, 9610], requiresBucket: true });
  });

  it('`bucket: #N` vale quanto `bucket #N`', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 1 item nel bucket: #9102\n';
    expect(triageMarkerPersistenceExpectation(body)).toEqual({ buckets: [9102], requiresBucket: true });
  });

  it('un "10" non viene letto come zero', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 10 item; bucket non nominato.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('con piu righe di claim, basta una non-zero per pretendere il bucket', () => {
    const body = '## Post-merge follow-up triage\n\nCreated: 0 issue\nCreated/updated: 2 item\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('accetta il marker reale di #9286 con bucket invariato come zero', () => {
    const body = [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: nessun item per questa PR; bucket giornaliero #9508 non modificato da questa PR.',
    ].join('\n');
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation).toEqual({ buckets: [], requiresBucket: false });
    expect(verifyTriageMarkerPersistence(body, 9435, () => {
      throw new Error('un bucket invariato non va letto');
    })).toBe(true);
  });

  it('non allarga il fallback: item senza prova di bucket resta fail-closed', () => {
    for (const body of [
      '## Post-merge follow-up triage\n\nCreated/updated: nessun item per questa PR.',
      '## Post-merge follow-up triage\n\nCreated/updated: nessun item per questa PR; bucket giornaliero #9508 aggiornato da questa PR.',
    ]) {
      expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
      expect(verifyTriageMarkerPersistence(body, 9435, () => null)).not.toBe(true);
    }
  });

  it('non lascia che una riga invariata nasconda un claim positivo', () => {
    const body = [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: nessun item per questa PR; bucket giornaliero #9508 non modificato da questa PR.',
      'Created/updated: 2 item; bucket #9510.',
    ].join('\n');
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation.requiresBucket).toBe(true);
    expect(expectation.buckets).toEqual([9510]);
  });

  it('rifiuta contraddizioni nello stesso claim invariato', () => {
    for (const line of [
      'Created/updated: nessun item per questa PR; bucket giornaliero #9508 aggiornato da questa PR.',
      'Created/updated: nessun item per questa PR; 2 item; bucket giornaliero #9508 non modificato da questa PR.',
      'Created/updated: nessun item per questa PR; bucket #9508 non modificato da questa PR; bucket #9510 aggiornato.',
    ]) {
      const body = `## Post-merge follow-up triage\n\n${line}\n`;
      expect(triageMarkerPersistenceExpectation(body).requiresBucket, line).toBe(true);
    }
  });
});

describe('i due finding della review', () => {
  it('L478 — la grammatica del claim e case-insensitive su entrambi i lati', () => {
    const body = '## Post-merge follow-up triage\n\ncreated/updated: 0 item; nessun bucket creato.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(false);
  });

  it('L484 — una prosa con la formula legacy non scavalca un claim NON zero', () => {
    // Il buco: `zero outstanding items` cercato in tutto il corpo anche con un
    // claim positivo. Il marker prometteva 2 item e il gate lo dava per vuoto.
    const body = [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: 2 item; bucket non nominato.',
      '',
      'Nota: la run precedente aveva zero outstanding items.',
    ].join('\n');
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation.requiresBucket).toBe(true);
    expect(verifyTriageMarkerPersistence(body, 8928, () => null)).toBe(false);
  });

  it('la formula legacy resta valida quando NON c e alcuna riga di claim', () => {
    const body = '## Post-merge follow-up triage: zero outstanding items.\n\nNessun candidato.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(false);
  });

  it('un conteggio non intero non e uno zero', () => {
    const body = '## Post-merge follow-up triage\n\nCreated: 0.5 item\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('righe di claim miste zero/non-zero restano fail-closed', () => {
    const body = '## Post-merge follow-up triage\n\nCreated: 0 issue\nCreated/updated: 2 item\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('piu bucket dichiarati e uno illeggibile: esito non positivo', () => {
    const body = '## Post-merge follow-up triage\n\nCreated/updated: 2 item nei bucket #9102 e bucket #9182.\n';
    const expectation = triageMarkerPersistenceExpectation(body);
    expect(expectation.buckets).toEqual([9102, 9182]);
    // Uno leggibile e valido, l'altro illeggibile -> null (retry), mai true.
    const readIssue = (n: number) => (n === 9102
      ? { number: 9102, title: 'follow-up(daily:2026-09-18): 1 items — x/y', body: '### FU-2026-09-18-001\n- Sources: PR #8928\n' }
      : null);
    expect(verifyTriageMarkerPersistence(body, 8928, readIssue)).not.toBe(true);
  });
});

// #7483 item 2, port del corpus FU-2026-09-24-009 (nanakokyobashi-rgb/frontaliere-articles#1785):
// uno zero si attesta solo con una riga di esito, fuori da codice recintato e
// citazioni. Prima bastava la formula in QUALUNQUE punto del corpo, e un
// marker che la citava in prosa o in un esempio risultava «provato vuoto»: la
// PR usciva dal batch per sempre senza che il suo triage fosse persistito.
describe('le attestazioni di zero valgono solo come riga di esito (FU-009)', () => {
  it('la formula in prosa, senza riga di claim, non prova lo zero', () => {
    const body = [
      '## Post-merge follow-up triage',
      '',
      'Nota: il template prevede zero outstanding items solo se non ci sono candidati.',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
    expect(verifyTriageMarkerPersistence(body, 8928, () => null)).not.toBe(true);
  });

  it('la formula backfill skipped in prosa non prova lo zero', () => {
    const body = '## Post-merge follow-up triage\n\nLa run di ieri era backfill skipped per errore.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('un claim a zero o un\'intestazione dentro un blocco recintato non e\' l\'esito', () => {
    for (const example of [
      'Created/updated: 0 item; nessun bucket creato.',
      '## Post-merge follow-up triage: zero outstanding items.',
      'Created/updated: nessun item per questa PR; bucket giornaliero #9508 non modificato da questa PR.',
    ]) {
      const body = `## Post-merge follow-up triage\n\nEsempio del formato:\n\`\`\`md\n${example}\n\`\`\`\n`;
      expect(triageMarkerPersistenceExpectation(body).requiresBucket, example).toBe(true);
    }
  });

  it('una citazione `>` dell\'intestazione vuota non e\' l\'esito', () => {
    const body = '## Post-merge follow-up triage\n\n> ## Post-merge follow-up triage: zero outstanding items.\n';
    expect(triageMarkerPersistenceExpectation(body).requiresBucket).toBe(true);
  });

  it('restano validi: intestazioni H2, prefisso nudo ripetuto, riga storica «Zero outstanding items.»', () => {
    for (const body of [
      '## Post-merge follow-up triage: zero outstanding items.',
      '## Post-merge follow-up triage (backfill skipped): PR not eligible (not merged or different author)',
      // il modello ripete il prefisso nudo prima dello zero (corpus #1570)
      '## Post-merge follow-up triage\n\n## Post-merge follow-up triage: zero outstanding items.',
      // forma storica del marker reale di #3027: intestazione nuda, poi la riga di esito
      '## Post-merge follow-up triage\n\nDropped: 2 item\n- "x" — reason: non-funnel\n\nZero outstanding items. ',
    ]) {
      expect(triageMarkerPersistenceExpectation(body), body).toEqual({ buckets: [], requiresBucket: false });
    }
  });

  it('un claim a zero fuori dal recinto resta valido anche se un esempio recintato lo ripete', () => {
    const body = [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: 0 item; nessun bucket creato.',
      '',
      '```md',
      'Created/updated: 0 item',
      '```',
    ].join('\n');
    expect(triageMarkerPersistenceExpectation(body)).toEqual({ buckets: [], requiresBucket: false });
  });
});

describe('lo YAML invoca il predicato unico', () => {
  // Regola #6 di AGENTS.md: un valore condiviso ha UNA sorgente. La copia bash
  // dello step di verifica non conosceva la prova del gate per gli item demoti
  // e restava rossa su triage completi (run 36212700029, 36202115664): ora lo
  // step invoca il collector, e questo test difende l'unicita' del predicato.
  const yml = readFileSync(
    resolve(__dirname, '../.github/workflows/post-merge-followup.yml'),
    'utf8',
  );

  it('lo YAML non elenca piu le formule superate', () => {
    expect(yml).not.toMatch(/nessun item nuovo aggiunto/);
    expect(yml).not.toMatch(/solo live-verification batchata/);
  });

  it('lo step di verifica chiama --verify-persistence e non riscrive il predicato', () => {
    expect(yml).toMatch(/node scripts\/ci\/collect-followup-batch\.mjs --verify-persistence "\$csv"/);
    for (const reimplementation of [
      /bucket_persisted_for_pr/,
      /claim_line_is_zero/,
      /claim_head=/,
      /zero_claim=/,
      /bucket_refs=/,
      /unchanged_bucket_zero=/,
    ]) {
      expect(yml, String(reimplementation)).not.toMatch(reimplementation);
    }
    // I due repository in cui puo' vivere un bucket devono raggiungere lo script.
    expect(yml).toContain('FOLLOWUP_SITE_REPO: valerielinc-ops/frontaliere-si-o-no');
    expect(yml).toContain('FOLLOWUP_CORPUS_REPO: nanakokyobashi-rgb/frontaliere-articles');
  });
});
