import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  observeCheckRuns,
  latestCompletedByName,
  formatObservationMarkdown,
  formatObservationLogLine,
  ADVISORY_CHECK_NAMES,
  BLOCKING_CONCLUSIONS,
  OBSERVATION_MARKER,
} from '../scripts/ci/lib/checkRunObservation.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

/**
 * Copertura di `checkRunObservation.mjs` (issue #5552): l'auto-merge decide su
 * UN solo check-run nominato, quindi osservare l'insieme è l'unico modo di
 * sapere quanti gate sono ornamentali. Questo test fissa la classificazione su
 * liste sintetiche — l'unico modo di coprire esiti (`timed_out`,
 * `action_required`, `stale`) che sulla finestra reale non si sono mai
 * presentati, e di pinnare il caso `cancelled`, che è quello che un'euristica
 * naive sbaglia.
 */
const ROOT = resolve(import.meta.dirname, '..');

/** Un check-run sintetico completato. */
const run = (name: string, conclusion: string, completed_at = '2026-08-11T10:00:00Z') => ({
  name,
  status: 'completed',
  conclusion,
  completed_at,
});

describe('observeCheckRuns — classificazione dell’insieme (#5552)', () => {
  // La lista mista richiesta dalla issue: success, failure, cancelled, skipped,
  // neutral, e un advisory in denylist.
  const MIXED = [
    run(VITEST_CHECK_NAME, 'success'),
    run('contract', 'failure'),
    run('typecheck (tsc --noEmit)', 'cancelled'),
    run('detect', 'skipped'),
    run('lighthouse', 'neutral'),
    { name: 'deploy', status: 'in_progress', conclusion: null, completed_at: null },
  ];

  it('elenca come «avrebbe bloccato» solo i verdetti negativi non-advisory', () => {
    const obs = observeCheckRuns(MIXED);
    expect(obs.wouldBlock.map((c) => c.name)).toEqual(['contract']);
    expect(obs.counts.wouldBlock).toBe(1);
  });

  it('NON considera bloccante un check `cancelled` (non è un check fallito)', () => {
    const obs = observeCheckRuns(MIXED);
    // Il caso critico: `gh pr checks` mostra `cancelled` nella colonna `fail`, e
    // `contract` rigira a ogni edit della PR description, quindi le
    // cancellazioni sono frequenti (misurate 26 su 60 PR, contro 2 failure
    // reali). Un run cancellato non ha prodotto alcun verdetto sul codice.
    expect(obs.wouldBlock.map((c) => c.name)).not.toContain('typecheck (tsc --noEmit)');
    expect(obs.cancelled.map((c) => c.name)).toEqual(['typecheck (tsc --noEmit)']);
    expect(obs.counts.cancelled).toBe(1);
  });

  it('un check SOLO cancellato non produce alcun blocco', () => {
    const obs = observeCheckRuns([run(VITEST_CHECK_NAME, 'success'), run('contract', 'cancelled')]);
    expect(obs.wouldBlock).toEqual([]);
    expect(obs.counts.cancelled).toBe(1);
  });

  it('`skipped` e `neutral` non bloccano', () => {
    const obs = observeCheckRuns(MIXED);
    const names = obs.wouldBlock.map((c) => c.name);
    expect(names).not.toContain('detect');
    expect(names).not.toContain('lighthouse');
  });

  it('gli advisory in denylist sono esclusi PER NOME e riportati con la motivazione', () => {
    const obs = observeCheckRuns(MIXED);
    expect(obs.advisorySeen.every((a) => a.reason.trim().length > 0)).toBe(true);
  });

  it('riporta i check ancora in volo come `pending`, non come bloccanti', () => {
    const obs = observeCheckRuns(MIXED);
    expect(obs.pending).toEqual(['deploy']);
    expect(obs.wouldBlock.map((c) => c.name)).not.toContain('deploy');
  });

  it('copre tutti i verdetti negativi, anche quelli mai osservati in produzione', () => {
    const obs = observeCheckRuns(
      BLOCKING_CONCLUSIONS.map((c, i) => run(`gate-${c}`, c, `2026-08-11T10:0${i}:00Z`)),
    );
    expect(obs.wouldBlock.map((c) => c.name).sort()).toEqual(
      BLOCKING_CONCLUSIONS.map((c) => `gate-${c}`).sort(),
    );
  });

  it('riporta la conclusion del check che oggi gatta davvero', () => {
    expect(observeCheckRuns(MIXED).gating).toEqual({ name: VITEST_CHECK_NAME, conclusion: 'success' });
    expect(observeCheckRuns([run('contract', 'failure')]).gating).toBeNull();
  });

  it('input non validi non lanciano', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => observeCheckRuns(bad as any)).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(observeCheckRuns(bad as any).wouldBlock).toEqual([]);
    }
    expect(observeCheckRuns([null, { status: 'completed' }, run('', 'failure')] as never).wouldBlock).toEqual([]);
  });
});

describe('latestCompletedByName — verdetto stantio (caso reale PR #5511)', () => {
  it('per ogni nome vince l’ultimo COMPLETATO, non un elemento arbitrario', () => {
    // Riproduce la HEAD reale di PR #5511: due check-run vitest sullo stesso
    // SHA, `failure` alle 10:27 e `success` alle 10:32 (un re-run). Prendere il
    // primo per ordine API riporterebbe un rosso che il verdetto finale smentisce
    // — è lo stesso bug #2394 già pagato sul solo vitest.
    const runs = [
      run(VITEST_CHECK_NAME, 'failure', '2026-08-10T10:27:23Z'),
      run(VITEST_CHECK_NAME, 'success', '2026-08-10T10:32:41Z'),
    ];
    expect(latestCompletedByName(runs)).toEqual([
      { name: VITEST_CHECK_NAME, conclusion: 'success', completed_at: '2026-08-10T10:32:41Z' },
    ]);
    expect(observeCheckRuns(runs).wouldBlock).toEqual([]);
    // …e invariante all'ordine in cui l'API li restituisce.
    expect(observeCheckRuns([...runs].reverse()).wouldBlock).toEqual([]);
  });

  it('un `success` VECCHIO non maschera un `failure` più recente', () => {
    const runs = [
      run('contract', 'success', '2026-08-10T10:00:00Z'),
      run('contract', 'failure', '2026-08-10T11:00:00Z'),
    ];
    expect(observeCheckRuns(runs).wouldBlock.map((c) => c.name)).toEqual(['contract']);
  });

  it('scarta i run non completati e i `completed_at` non parsabili', () => {
    expect(
      latestCompletedByName([
        { name: 'a', status: 'queued', conclusion: null, completed_at: null },
        { name: 'b', status: 'completed', conclusion: 'success', completed_at: 'non-una-data' },
      ] as never),
    ).toEqual([]);
  });
});

describe('denylist advisory — corta e nominata, non un’euristica', () => {
  it('non contiene nessuno dei quattro check sostanziali', () => {
    for (const name of [VITEST_CHECK_NAME, 'typecheck (tsc --noEmit)', 'contract', 'detect']) {
      expect(Object.keys(ADVISORY_CHECK_NAMES)).not.toContain(name);
    }
  });

  it('ogni voce motiva se stessa per nome', () => {
    const entries = Object.entries(ADVISORY_CHECK_NAMES);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(10); // "corta": un'esplosione qui è drift verso l'euristica
    for (const [name, reason] of entries) {
      expect(name.length, `advisory con nome vuoto`).toBeGreaterThan(0);
      expect(reason.length, `advisory \`${name}\` senza motivazione`).toBeGreaterThan(20);
      // La motivazione nomina il workflow che produce il check-run, così la
      // denylist resta verificabile invece di essere un elenco di fiducia.
      expect(reason, `advisory \`${name}\` non nomina il workflow`).toMatch(/\.yml/);
    }
  });

  it('ogni advisory è il `name` di un job realmente definito nei workflow del repo', () => {
    // Guard anti-drift: una voce che non corrisponde a nessun job è una
    // denylist che silenzia un check inesistente — e lascia passare quello vero
    // se il job viene rinominato.
    for (const [name, reason] of Object.entries(ADVISORY_CHECK_NAMES)) {
      const files = reason.match(/[\w.-]+\.yml/g) ?? [];
      expect(files.length, `advisory \`${name}\`: nessun workflow nominato`).toBeGreaterThan(0);
      const found = files.some((f) => {
        let src: string;
        try {
          src = readFileSync(resolve(ROOT, '.github/workflows', f), 'utf-8');
        } catch {
          return false;
        }
        // job id `  <name>:` oppure un `name:` di job uguale al check-run name.
        return (
          new RegExp(`^ {2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm').test(src) ||
          new RegExp(`^\\s{4}name:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm').test(src) ||
          false
        );
      });
      expect(found, `advisory \`${name}\` non corrisponde a nessun job in ${files.join('/')}`).toBe(true);
    }
  });
});

describe('rendering dell’osservazione', () => {
  const OBS = observeCheckRuns([
    run(VITEST_CHECK_NAME, 'success'),
    run('contract', 'failure'),
    run('typecheck (tsc --noEmit)', 'cancelled'),
    run('sweep', 'failure'),
  ]);

  it('il markdown porta il marker in testa (dedup/upsert e aggregazione)', () => {
    const md = formatObservationMarkdown(OBS, { pr: 1234, head: 'abcdef1234567890' });
    expect(md.startsWith(OBSERVATION_MARKER)).toBe(true);
    expect(md).toContain('1234');
    expect(md).toContain('abcdef12');
  });

  it('nomina i bloccanti e dichiara esplicitamente il cancellato come non-fallito', () => {
    const md = formatObservationMarkdown(OBS);
    expect(md).toContain('`contract`');
    expect(md).toMatch(/avrebbe BLOCCATO/);
    expect(md).toMatch(/cancellato, non fallito/);
    expect(md).toMatch(/advisory/i);
  });

  it('dice a chiare lettere che non blocca nulla — è un osservatore, non un gate', () => {
    expect(formatObservationMarkdown(OBS)).toMatch(/NON blocca/i);
  });

  it('il caso comune (nessun bloccante) produce un verdetto positivo esplicito', () => {
    const md = formatObservationMarkdown(observeCheckRuns([run(VITEST_CHECK_NAME, 'success')]));
    expect(md).toMatch(/nessun check aggiuntivo avrebbe bloccato/i);
    expect(md).not.toMatch(/avrebbe(ro)? BLOCCATO/);
  });

  it('la riga di log è a campo singolo e greppabile', () => {
    const line = formatObservationLogLine(OBS, { pr: 1234, head: 'abcdef1234567890' });
    expect(line).toContain('CHECK-SET-OBSERVATION');
    expect(line).toContain('wouldBlock=1');
    expect(line).toContain('cancelled=1');
    expect(line).toContain('blockers=contract=failure');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('auto-merge-eval: l’osservazione non è un gate', () => {
  const SRC = readFileSync(resolve(ROOT, 'scripts/ci/auto-merge-eval.mjs'), 'utf-8');

  it('invoca l’osservazione dopo che il gate vitest è passato', () => {
    const iGate = SRC.indexOf("console.log('Gate vitest: success ✔')");
    const iObs = SRC.indexOf('emitCheckSetObservation(allCheckRuns');
    expect(iGate).toBeGreaterThan(-1);
    expect(iObs).toBeGreaterThan(iGate);
  });

  it('il corpo di emitCheckSetObservation non può cambiare l’esito del merge', () => {
    // L'invariante centrale della PR: osservare non deve mai bloccare. Un
    // `process.exit`/`fail()` dentro l'osservatore trasformerebbe in silenzio
    // una misura in un cancello — cioè esattamente la decisione che il
    // proprietario si è riservato dopo una settimana.
    const start = SRC.indexOf('function emitCheckSetObservation');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
    expect(body).not.toMatch(/process\.exit/);
    expect(body).not.toMatch(/\bfail\s*\(/);
    expect(body).not.toMatch(/\bthrow\b/);
  });

  it('riusa i check-run già letti dal gate — nessuna chiamata API in più', () => {
    expect((SRC.match(/check-runs\?per_page=100/g) || []).length).toBe(1);
  });
});
