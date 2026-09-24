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
 * Ora conta il conteggio ovunque sulla riga, e i due gemelli sono confrontati
 * ESEGUENDO il bash estratto dallo YAML sulle stesse righe del JS.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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

const HISTORICAL_ZERO_CLAIM_LINES = [
  'Created/updated: 0 item; nessun bucket creato.',
  'Created/updated: 0 issue — nessun item nuovo aggiunto',
  'Created: 0 issue (solo live-verification batchata)',
  'Created/updated: 0 elementi, niente da persistere',
  '- Created: 0',
  'created/updated: 0 item; nessun bucket creato.',
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

  it('`bucket: #N` vale quanto `bucket #N`, come nel gemello bash', () => {
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

  it('lo YAML compone la grammatica del claim in UNA variabile condivisa', () => {
    // La grammatica sta in `claim_head` e viene riusata sia per estrarre le
    // righe di claim sia per leggerne il conteggio: una sola sorgente dentro il
    // bash, allineata al gemello JS.
    expect(yml).toMatch(/claim_head='\^\[\[:space:\]\]\*\(-\[\[:space:\]\]\+\|\\\*\[\[:space:\]\]\+\)\?Created\(\/updated\)\?:'/);
    expect(yml).toMatch(/grep -Ei "\$claim_head"/);
    // Case-insensitive su entrambi gli usi (finding L478).
    expect(yml).toMatch(/grep -Eqi "\$\{claim_head\}\[\[:space:\]\]\*0\(\[\^0-9\.\]\|\\\$\)"/);
    expect(yml).toMatch(/if ! claim_line_is_zero "\$claim_line"; then/);
    expect(yml).toMatch(/grep -Eio 'bucket\[\[:space:\]\]\*:\?\[\[:space:\]\]\*#\[0-9\]\+'/);
  });

  it('le formule legacy sono ammesse SOLO senza righe di claim (finding L484)', () => {
    // Il fallback non deve piu' essere cercato nell'intero corpo quando esiste
    // un claim: nello YAML e' racchiuso in un gruppo con `-z "$claim_lines"`.
    expect(yml).toMatch(/\[ -z "\$claim_lines" \][\s\S]{0,120}zero outstanding items\|backfill skipped/);
  });

  it('il fallback bucket invariato richiede che ogni claim line sia esclusivamente zero', () => {
    expect(yml).toMatch(/unchanged_bucket_zero=false[\s\S]{0,500}unchanged_bucket_zero=true[\s\S]{0,700}grep -Eq/);
    expect(yml).toContain('nessun[[:space:]]+item[[:space:]]+per[[:space:]]+questa[[:space:]]+PR');
    expect(yml).toContain('non[[:space:]]+modificat[oa]');
  });

  // Il blocco `claim_head` + `claim_line_is_zero()` estratto dallo step ed
  // ESEGUITO: una regex pinnata non dice se i due lati classificano uguale.
  function bashZeroFlags(lines: string[]): boolean[] {
    const indent = '          ';
    const start = yml.indexOf(`${indent}claim_head='`);
    const fn = yml.indexOf(`${indent}claim_line_is_zero() {`, start);
    const end = yml.indexOf(`\n${indent}}\n`, fn);
    expect(start).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(fn);
    const block = yml.slice(start, end + indent.length + 3).replace(new RegExp(`^${indent}`, 'gm'), '');
    const script = `${block}\nwhile IFS= read -r l; do if claim_line_is_zero "$l"; then echo 1; else echo 0; fi; done\n`;
    const out = execFileSync('bash', ['-c', script], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
    return out.trim().split('\n').map((flag) => flag === '1');
  }

  it('bash e JS classificano uguale le stesse righe di claim', () => {
    const zero = [...NUMERIC_ZERO_AFTER_BUCKET_LINES, ...HISTORICAL_ZERO_CLAIM_LINES];
    const lines = [...zero, ...NON_ZERO_CLAIM_LINES];
    const expected = lines.map((line) => isZeroClaimLine(line));
    expect(bashZeroFlags(lines)).toEqual(expected);
    // E non per caso: le due famiglie restano separate su entrambi i lati.
    expect(expected).toEqual([...zero.map(() => true), ...NON_ZERO_CLAIM_LINES.map(() => false)]);
  });
});
