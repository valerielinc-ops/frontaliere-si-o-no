/**
 * La catena transitiva importata da `prospect-promote.mjs` non ha side-effect a
 * load-time (#7292, item 1).
 *
 * Il rilievo: dal 2026-09-04 lo stage 6 del prospector importa
 * `scripts/ci/followup-drainer.mjs` per `canPushWorkflows()`, e il drainer si
 * porta dietro `claude-rate-limit.mjs`, `close-recovered-failure-issues.mjs`,
 * `lib/run-budget.mjs` e il resto della loro chiusura. L'argomento di sicurezza
 * scritto allora copriva SOLO il drainer — «ha un guard di entrypoint sul suo
 * `main()`» — non i moduli che porta con sé. Sotto questo entrypoint `argv` è
 * `--max=/--min-days=/--open-pr` e l'env è quello del job del prospector: un
 * `process.exit`/`throw` a load-time in uno qualunque di quei moduli ucciderebbe
 * la promozione dei crawler PRIMA dello scaffolding, cioè in silenzio e nel
 * punto del funnel che alimenta nuovi annunci indicizzabili.
 *
 * Oggi la proprietà vale — verificata modulo per modulo il 2026-09-05 — ma non
 * la teneva niente: bastava che un modulo della catena aggiungesse un
 * `readFileSync` di un file assente, o che qualcuno importasse un nuovo CLI, e
 * il guasto sarebbe comparso in produzione. Questo è l'osservatore.
 *
 * Perché è scritto sulla CHIUSURA calcolata e non su una lista fissa: la
 * regressione arriva quasi sempre da un modulo NUOVO nella catena, che una
 * lista scritta a mano non conoscerebbe. Il walker la ricalcola a ogni run, e
 * il primo test verifica che stia davvero guardando qualcosa (una chiusura
 * vuota renderebbe verdi anche i due successivi).
 *
 * L'entrypoint stesso è ESCLUSO di proposito: `prospect-promote.mjs` non ha un
 * guard e non deve averlo — quando è lui l'entrypoint, eseguire è il suo
 * lavoro.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'scripts/prospect-promote.mjs';

/** Chiusura transitiva degli import relativi, a partire dall'entrypoint. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src: string;
    try {
      src = readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const here = path.dirname(path.join(ROOT, rel));
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      stack.push(path.relative(ROOT, path.resolve(here, m[1])));
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}

const CLOSURE = importClosure(ENTRY);

// L'argv e l'env sotto cui il prospector importa quella catena: è la
// combinazione che l'argomento di sicurezza del 2026-09-04 non aveva coperto.
const PROSPECTOR_ARGV = ['--max=5', '--min-days=1', '--open-pr'];

describe('prospect-promote — nessun side-effect a load-time nella catena importata (#7292)', () => {
  it('la chiusura contiene davvero la catena del drainer', () => {
    // Se il walker smettesse di risolvere gli import, i test qui sotto
    // passerebbero su un insieme vuoto senza provare niente.
    expect(CLOSURE).toContain('scripts/ci/followup-drainer.mjs');
    expect(CLOSURE).toContain('scripts/ci/claude-rate-limit.mjs');
    expect(CLOSURE).toContain('scripts/ci/close-recovered-failure-issues.mjs');
    expect(CLOSURE).toContain('scripts/ci/lib/run-budget.mjs');
    expect(CLOSURE).not.toContain(ENTRY);
  });

  it('importare ogni modulo della catena sotto argv/env del prospector non esce né lancia', () => {
    // Un solo processo figlio invece di uno per modulo: se un import muore, il
    // marker mancante dice QUALE, che è l'informazione che serve in rosso.
    // Il driver vive in un file vero, chiamato come l'entrypoint di
    // produzione: così `process.argv[1]` ha la stessa FORMA che ha nel job del
    // prospector — un path che finisce con `prospect-promote.mjs` e non con il
    // nome di nessun modulo della catena.
    const dir = mkdtempSync(path.join(tmpdir(), 'prospect-promote-import-'));
    const driver = path.join(dir, 'prospect-promote.mjs');
    writeFileSync(
      driver,
      `const mods = ${JSON.stringify(CLOSURE)};\n`
        + `for (const m of mods) {\n`
        + `  await import(${JSON.stringify(ROOT)} + '/' + m);\n`
        + `  process.stdout.write('LOADED ' + m + '\\n');\n`
        + `}\n`,
    );

    const res = spawnSync(process.execPath, [driver, ...PROSPECTOR_ARGV], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    const loaded = res.stdout.split('\n').filter((l) => l.startsWith('LOADED '));
    if (res.status !== 0) {
      throw new Error(
        `import fallito al modulo #${loaded.length + 1} (${CLOSURE[loaded.length] ?? '?'}, o un modulo della sua catena): `
          + `side-effect a load-time (exit ${res.status}, segnale ${res.signal}).\n${res.stderr}`,
      );
    }

    expect(loaded).toHaveLength(CLOSURE.length);
    // Silenzio oltre i marker: il prospector logga il proprio esito su stdout, e
    // un banner a load-time di un modulo CI ne sporcherebbe l'audit trail.
    expect(res.stdout.trimEnd().split('\n')).toEqual(loaded);
    expect(res.stderr).toBe('');
  }, 30_000);
});
