/**
 * needs-human-prepass-sparse-closure — il checkout sparse del job `prepass`
 * copre la CHIUSURA TRANSITIVA degli import del pre-pass?
 *
 * ## Il difetto che chiude, misurato
 *
 * `needs-human-sweep.yml` fa un checkout sparse per non materializzare `public/`
 * e `data/`. Il job `prepass` dichiarava il solo file di entry
 * (`/scripts/ci/needs-human-prepass.mjs`). Ma quel file importa
 * `followup-drainer.mjs` (per `NON_RETRYABLE`) e
 * `close-recovered-failure-issues.mjs` (per `FIX_OUTCOME_RE`), che a loro volta
 * tirano `scripts/ci/lib/` e `scripts/lib/`: tutto FUORI dall'albero checkato.
 *
 * Gli import ESM sono STATICI — il grafo dei moduli si risolve prima che
 * `main()` esegua una sola riga — quindi non e' un ramo che fallisce ogni
 * tanto:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '.../scripts/ci/followup-drainer.mjs' imported from
 *     '.../scripts/ci/needs-human-prepass.mjs'
 *
 * a OGNI invocazione — cron giornaliero, cron del lunedi' e `workflow_dispatch`.
 * Misurato: rotto dal 2026-08-27 (commit 48f38e2d476) al 2026-09-04, otto
 * giorni in cui la meta' «zero-Claude» che fa tutto il drenaggio non e' mai
 * partita. Nel frattempo `needs-human` e' risalito a 52 issue sul sito, contro
 * 24 sul corpus dove lo stesso job gira (requeue=7 decompose=1 keep=13 al
 * giorno). L'unica prova era un job rosso in un workflow che nessuno guarda.
 *
 * Il corpus ha incontrato lo stesso difetto il 2026-08-25 e ha scritto questa
 * guardia (`generator/tests/needs-human-prepass-sparse-closure.test.mjs`); il
 * workflow e' `adapted` nel `loop-sync-manifest`, quindi la guardia non e'
 * scesa da sola e il sito si e' rotto due giorni dopo per la stessa causa.
 *
 * ## Perche' serviva un test NUOVO
 *
 * `needs-human-prepass.test.ts` importa lo stesso modulo e resta VERDE: gira su
 * un checkout completo, dove `scripts/lib/` c'e'. Nessun test che *importa* il
 * pre-pass puo' vedere questo difetto — la condizione che lo produce e'
 * l'assenza di file, non una logica sbagliata. Va confrontata la DICHIARAZIONE
 * nel workflow con la chiusura calcolata dal sorgente, che e' cio' che fa
 * questo file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/needs-human-sweep.yml';
const ENTRY = 'scripts/ci/needs-human-prepass.mjs';

/** Ogni specificatore relativo `from '...'`, import ed export riesportante. */
const REL_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'";]*from\s*['"](\.[^'"]+)['"]/g;

/**
 * La chiusura transitiva degli import RELATIVI a partire da `entry`, in path
 * relativi alla radice del repo. I builtin (`node:*`) e i pacchetti non
 * compaiono: non stanno nell'albero e non c'entrano con la sparsita'.
 */
function importClosure(entry: string): { files: string[]; missing: string[] } {
  const seen = new Set<string>();
  const missing: string[] = [];
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src: string;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    } catch {
      missing.push(rel);
      continue;
    }
    for (const m of src.matchAll(REL_IMPORT_RE)) {
      stack.push(path.normalize(path.join(path.dirname(rel), m[1])));
    }
  }
  return { files: [...seen].sort(), missing };
}

/**
 * Le righe del blocco `sparse-checkout: |` del job indicato.
 *
 * Parsing a righe e non con un parser YAML di proposito: e' l'unico consumatore
 * e una dipendenza in piu' su un gate che gira a ogni PR sarebbe il costo
 * sbagliato da pagare.
 */
function sparsePatternsFor(workflowText: string, jobName: string): string[] {
  const jm = new RegExp(`\\n {2}${jobName}:\\n`).exec(workflowText);
  expect(jm, `job \`${jobName}\` non trovato in ${WORKFLOW}`).toBeTruthy();
  // dal job in poi, fino al prossimo job di pari indentazione (2 spazi)
  const after = workflowText.slice(jm!.index + jm![0].length);
  const end = /\n {2}[a-z0-9_-]+:\n/.exec(after);
  const jobBody = end ? after.slice(0, end.index) : after;

  const sm = /sparse-checkout:\s*\|\s*\n([\s\S]*?)(?=\n\s*[a-z-]+:)/.exec(jobBody);
  expect(sm, `blocco \`sparse-checkout: |\` non trovato nel job \`${jobName}\``).toBeTruthy();
  return sm![1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

describe('needs-human-sweep.yml — chiusura sparse del job prepass', () => {
  it('il job `prepass` checkouta tutto cio' + "'" + ' che il pre-pass importa', () => {
    const wf = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf-8');
    const patterns = sparsePatternsFor(wf, 'prepass');
    const { files, missing } = importClosure(ENTRY);

    expect(missing, 'la chiusura degli import nomina file che non esistono nel repo').toEqual([]);

    // Ogni file della chiusura deve essere coperto da un pattern: la sua
    // cartella (`/scripts/lib/`) oppure il file stesso.
    const uncovered = files.filter(
      (f) => !patterns.some((p) => p === `/${f}` || (p.endsWith('/') && `/${f}`.startsWith(p))),
    );

    expect(
      uncovered,
      'Questi file sono importati (anche in modo TRANSITIVO) dal pre-pass ma non\n'
        + `sono nel checkout sparse del job \`prepass\` in ${WORKFLOW}.\n`
        + 'Gli import ESM sono statici: il modulo non risolve e lo step muore con\n'
        + 'ERR_MODULE_NOT_FOUND a OGNI run, prima che main() esegua una riga.\n'
        + `Pattern dichiarati: ${JSON.stringify(patterns)}`,
    ).toEqual([]);
  });

  it('la chiusura contiene davvero i file fuori da /scripts/ci/ che hanno causato il difetto', () => {
    // Guardia sulla GUARDIA: se un domani il pre-pass smettesse di importare il
    // drainer, il test sopra resterebbe verde in modo vacuo (chiusura piccola,
    // tutto coperto) e non direbbe piu' niente. Questo lo ancora al caso reale.
    const { files } = importClosure(ENTRY);
    expect(files, 'il pre-pass non passa piu\' per followup-drainer.mjs: se e\' voluto aggiorna questo test')
      .toContain('scripts/ci/followup-drainer.mjs');
    expect(files, 'la chiusura non esce piu\' da scripts/ci/: se e\' voluto aggiorna questo test')
      .toContain('scripts/lib/classify-issue.mjs');
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('il parser del blocco sparse non legge righe di un altro job', () => {
    // `sweep` ha un suo `sparse-checkout` con `/*` e le negazioni: se il parser
    // sconfinasse, `prepass` sembrerebbe coprire tutto e il test sopra non
    // fallirebbe mai.
    const wf = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf-8');
    const prepass = sparsePatternsFor(wf, 'prepass');
    expect(prepass, 'il parser ha sconfinato nel job sweep').not.toContain('/*');
    expect(prepass.some((p) => p.startsWith('!')), 'pattern di negazione inattesi nel job prepass').toBe(false);
    expect(sparsePatternsFor(wf, 'sweep'), 'il job `sweep` dovrebbe dichiarare `/*`').toContain('/*');
  });
});
